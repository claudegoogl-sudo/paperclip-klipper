import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  MoonrakerClient,
  type ConnectionStateSnapshot,
  type MoonrakerClientOptions,
  type MoonrakerStatusSnapshot,
} from "./worker/MoonrakerClient.js";
import type { FlashForgeClientOptions } from "./worker/transports/FlashForgeClient.js";
import {
  registerRpcSurface,
  type KlipperConfig,
} from "./worker/registerRpcSurface.js";
import { validateMoonrakerBaseUrl } from "./worker/validateMoonrakerBaseUrl.js";
import type { RpcSurfaceOptions } from "./worker/registerRpcSurface.js";
import {
  canonicalSecretRefIdentity,
  resolveSecretRef,
  type SecretRef,
} from "./worker/secretRef.js";
import {
  CREDENTIAL_PENDING_MESSAGE,
  FlashForgeClient,
} from "./worker/transports/FlashForgeClient.js";
import {
  describeFlashForgeConfigFailure,
  selectTransport,
  validateFlashForgeConfig,
} from "./worker/transports/validateTransportConfig.js";
import { CameraFeed } from "./worker/camera/CameraFeed.js";
import { validateCameraBaseUrl } from "./worker/camera/validateCameraConfig.js";
import type { PrinterTransport } from "./worker/transports/PrinterTransport.js";

/**
 * paperclip-klipper worker.
 *
 * This revision wires the real MoonrakerClient (REST + WS, reconnect, RPC
 * surface) onto the ctx surfaces declared by the manifest. The earlier
 * scaffold stayed stub-only; this revision replaces the stubs with the real
 * transport while keeping the same config gates on high-blast-radius tools.
 *
 * Notes carried from the plan:
 *   - The Moonraker API key resolves per call via `ctx.secrets.resolve` and is
 *     never cached on the client.
 *   - Outbound traffic is restricted to the configured `moonrakerBaseUrl` —
 *     `MoonrakerClient.scopedUrl()` is the enforcement point.
 *   - The WS reconnects with exponential backoff + jitter (1s → 30s cap,
 *     6 attempts before surfacing a `failed` state that requires manual retry).
 *   - WS owns its own subscription set (print_stats, extruder, heater_bed,
 *     display_status, virtual_sdcard); the dashboard widget reads the merged
 *     snapshot via the `status` data key.
 *   - Connection-state and status snapshots are pushed to the `klipper`
 *     stream channel so `usePluginStream("klipper")` in the UI updates live.
 *
 * Boot-time config semantics (host replay only — no setup-time reads):
 *   The host spawns plugin workers with an EMPTY bootstrap config; company
 *   config rows are delivered right after boot through the `configChanged`
 *   RPC. setup() therefore makes NO `ctx.config.get()` call at all: a
 *   worker→host call from setup runs in service scope with no company
 *   attached and NOTHING in flight, and the host's single-in-flight
 *   attribution permanently denies ("poisons") the method for the worker's
 *   lifetime — which used to make every in-dispatch `config.get` fail with
 *   InvocationScopeDeniedError and silently fail the opt-in gates closed.
 *   setup() boots permissive (tools/data/actions registered, returning
 *   `prerequisite_missing`) and the host's startup config replay — or a
 *   later operator config save — lands in `onConfigChanged`, which applies
 *   the config and starts the transport client. The opt-in tool gates keep
 *   re-reading config per dispatch (fail-closed); those reads run INSIDE a
 *   dispatch, where single-in-flight attribution attributes them correctly.
 *
 * Credential semantics (resolve lazily INSIDE the dispatch):
 *   `ctx.secrets.resolve` is called ONLY inside a tool dispatch. The
 *   host's `configChanged` push is NOT a reliable authorization context on
 *   this SDK generation: rows are delivered per company back-to-back and
 *   the plugin's apply runs async to the push, so an id-less resolve lands
 *   with 0 or 2+ invocations in flight — single-in-flight attribution
 *   finds no scope and the SDK gate denies it (observed live: EVERY
 *   apply-time resolve during the activation replay failed with
 *   InvocationScopeDeniedError, and a config re-save cannot fix it because
 *   the save push rides the same path). The one authorization path this
 *   worker class can rely on is in-dispatch single-in-flight attribution
 *   with the executeTool scope carrying companyId+runId.
 *
 *   Therefore: `applyConfig` stores validated config + refs only (zero
 *   worker→host calls) and converges ref-bearing transports DORMANT — no
 *   WS, no poll; status/health report "credential not resolved yet". The
 *   first tool dispatch that needs a credential resolves its ref
 *   (`ensureCredential`), caches the plaintext in memory keyed to the
 *   config fingerprint, injects it into the transport and starts it. The
 *   cache is invalidated on EVERY config application (a rotated secret
 *   lands at the next dispatch); the status poll and UI surfaces consume
 *   the client-held value only and never resolve; the plaintext is never
 *   logged. A resolve failure keeps the transport dormant (fail closed)
 *   and the tool refuses with a clear reason.
 */

/**
 * Stream channel the worker emits status + connection snapshots on.
 * Re-exported here so existing consumers can import it from this module;
 * defined in `./streamChannel.ts` so the UI bundle does not have to pull
 * in the worker entry to read the constant.
 */
export { STREAM_CHANNEL } from "./streamChannel.js";
import { STREAM_CHANNEL } from "./streamChannel.js";

export interface CreateKlipperWorkerOptions {
  /**
   * Open the WS connection at the end of setup. Defaults to true in
   * production; tests inject a mock server and pass `false` to control the
   * lifecycle (or pass `true` after pointing `webSocketFactory` at the mock).
   */
  autoStart?: boolean;
  /**
   * Override MoonrakerClient construction (test-only hook). Tests pass a
   * `webSocketFactory`, `setTimeoutFn`/`clearTimeoutFn`, and a deterministic
   * `random` so backoff is predictable.
   */
  clientOverrides?: Partial<MoonrakerClientOptions>;
  /** Override FlashForgeClient construction (test-only hook). */
  flashforgeClientOverrides?: Partial<FlashForgeClientOptions>;
}

/** Where a config snapshot or convergence came from — named in logs. */
export type KlipperConfigSource = "setup" | "configChanged" | "dispatch";

export interface KlipperWorker {
  /**
   * Camera feed for the printer page's camera section, or `null` when the
   * camera is not configured. Lifecycle is viewer-driven (open on first
   * board action, self-close on idle) — see worker/camera/CameraFeed.ts.
   */
  camera: CameraFeed | null;
  /**
   * Connection-identity fingerprint of the live camera feed (null when no
   * feed). Lets unchanged replays keep the feed instead of churning it.
   */
  cameraFingerprint: string | null;
  /**
   * Active printer transport (MoonrakerClient or FlashForgeClient), or
   * `null` when the worker is running without usable transport config (config
   * not yet replayed, absent, or rejected by validation). Tool / action /
   * data handlers gate on client presence and surface
   * `prerequisite_missing` (mirroring the CAD plugin pattern).
   */
  client: PrinterTransport | null;
  config: KlipperConfig;
  /**
   * `false` until the host config replay / operator save lands (setup
   * makes no config read at all — see the boot-semantics note at the top
   * of this file). Surfaced through `onHealth` so a worker that booted
   * unconfigured is distinguishable from one the operator configured with
   * no `moonrakerBaseUrl`.
   */
  configKnown: boolean;
  /**
   * Why the transport is not running yet ("credential not resolved yet —
   * the transport starts on the first tool dispatch that needs it"), or
   * `null` when nothing is pending. Surfaced by `onHealth` and the status
   * surfaces so the fail-closed idle state is observable, not silent.
   */
  getCredentialPendingReason(): string | null;
  /**
   * Apply a config snapshot (from the host `configChanged` replay or an
   * operator save) and converge the client + RPC surface onto it.
   *
   * Idempotent by connection identity: when the fingerprint
   * (baseUrl + allowedHosts + apiKeyRef) is unchanged the existing client is
   * kept and only the display config is refreshed, so the per-company replay
   * burst the host sends at every boot converges instead of churning
   * clients. A config whose baseUrl is absent or fails validation stops any
   * live client and degrades to permissive init (never crash the worker).
   *
   * @param rawConfig - Config snapshot; shape validated defensively.
   * @param source - Provenance tag for the log line.
   * @param autoStart - Open the WS when (re)building a client. Production
   *   passes `true`; tests pass `false` to control the lifecycle.
   */
  applyConfig(
    rawConfig: Partial<KlipperConfig>,
    source: KlipperConfigSource,
    autoStart?: boolean,
  ): Promise<void>;
}

/**
 * Connection-identity fingerprint. Only the fields that shape the physical
 * transport (where to connect, what may be connected to, which credential
 * ref to resolve) participate — the opt-in gate flags are re-read live per
 * dispatch and must NOT trigger a client rebuild.
 */
function connectionFingerprint(config: Partial<KlipperConfig>): string {
  return JSON.stringify([
    "moonraker",
    config.moonrakerBaseUrl ?? null,
    [...(config.moonrakerAllowedHosts ?? [])].sort(),
    // Canonical per-shape identity: legacy strings keep their raw value,
    // object binding refs canonicalize to secretId+version so key-order
    // differences in a replayed config stay the SAME connection.
    config.moonrakerApiKeyRef === undefined
      ? null
      : canonicalSecretRefIdentity(config.moonrakerApiKeyRef as SecretRef),
  ]);
}

/**
 * Connection-identity fingerprint for the flashforge transport. Derived from
 * the VALIDATED config so the applied default port is part of the identity
 * (`http://host` and `http://host:8898` are the same connection, not two).
 * Returns null when the config does not validate (no identity to keep).
 */
function flashforgeFingerprint(config: Partial<KlipperConfig>): string | null {
  const validated = validateFlashForgeConfig(config);
  if (!validated.ok) return null;
  return JSON.stringify([
    "flashforge",
    validated.config.baseUrl,
    validated.config.serialNumber,
    canonicalSecretRefIdentity(validated.config.checkCodeRef),
    [...(validated.config.allowedHosts ?? [])].sort(),
  ]);
}

/** Fingerprint of whatever transport `config` selects (kind-aware). */
function transportFingerprint(config: Partial<KlipperConfig>): string | null {
  const selection = selectTransport(config.transport);
  if (!selection.ok) return null;
  return selection.kind === "flashforge"
    ? flashforgeFingerprint(config)
    : connectionFingerprint(config);
}

export async function createKlipperWorker(
  ctx: PluginContext,
  options: CreateKlipperWorkerOptions = {},
): Promise<KlipperWorker> {
  // NO setup-time `ctx.config.get()` — not even a best-effort one wrapped in
  // try/catch. A worker→host call from setup runs with no dispatch in
  // flight, and the host's single-in-flight attribution permanently denies
  // the method ("idlessCallsSeenWithNoDispatch"): the first denied setup
  // read poisoned `config.get` for the worker's whole lifetime, so every
  // later in-dispatch gate re-read failed closed and uploads were refused
  // with a misleading "auto_upload_artifacts is false" even though the
  // persisted config was correct. Config reaches this worker exclusively
  // through `onConfigChanged` (the boot replay + operator saves) — the same
  // contract the host actually implements. Until it lands the worker stays
  // permissive: surface registered, tools return `prerequisite_missing`.
  const clientOverrides = options.clientOverrides ?? {};
  const flashforgeClientOverrides = options.flashforgeClientOverrides ?? {};

  // ── Credential resolution state (lazy in-dispatch resolution) ──────────
  // Resolved plaintext cache: held in memory only, keyed to the config
  // fingerprint that produced it, invalidated on EVERY config application.
  // Never logged, never persisted. The ONLY writer is `ensureCredential`
  // (dispatch scope).
  let credentialCache: { fingerprint: string; plaintext: string } | null = null;
  /**
   * Why the transport is not running yet, or `null` when nothing is
   * pending. Non-null = "a credential ref is configured but unresolved";
   * surfaced verbatim by the status data key, the status tool, and health.
   */
  let credentialPendingReason: string | null = null;
  /** Whether the CURRENT client's transport loop was started by the worker. */
  let transportStarted = false;

  // Stream emissions shared by both transports (identical callback shape).
  const transportStreamCallbacks = {
    onStatus: (snapshot: MoonrakerStatusSnapshot) => {
      try {
        ctx.streams.emit(STREAM_CHANNEL, { type: "status", snapshot });
      } catch (err) {
        ctx.logger.debug("klipper.stream.emit_failed", {
          channel: STREAM_CHANNEL,
          error: String(err instanceof Error ? err.message : err),
        });
      }
    },
    onConnectionState: (state: ConnectionStateSnapshot) => {
      try {
        ctx.streams.emit(STREAM_CHANNEL, { type: "connection", state });
      } catch (err) {
        ctx.logger.debug("klipper.stream.emit_failed", {
          channel: STREAM_CHANNEL,
          error: String(err instanceof Error ? err.message : err),
        });
      }
    },
  };

  // ── Status stream channel lifecycle ────────────────────────────────────
  // The printer page's `usePluginStream("klipper")` only receives events
  // while the host holds a pinned channel for STREAM_CHANNEL. The host pins
  // a channel ONLY from a `streams.open` sent inside a host-validated
  // dispatch (the SDK echoes the invocation id on every notification; the
  // pin value comes from the dispatch scope, never from this worker's
  // claim). So the channel opens where the transport loop starts — inside
  // `ensureCredential`, with the dispatching company's id — and closes when
  // the transport stops. Emissions keep the pre-existing path (transport
  // callbacks → `ctx.streams.emit`); the SDK resolves the channel's
  // companyId from the open call, and the host tenant-verifies each
  // out-of-dispatch emit against the pin. `streams.open`/`close` are
  // one-way notifications, not worker→host calls: they never hit the
  // id-less-call guards.
  //
  // `statusChannelCompanyId` mirrors the pin the host should be holding so
  // repeated dispatches from the same company do not re-send the
  // notification, and so a channel that was never opened is never closed
  // (an unpinned close would only earn a `streams.dropped` warn).
  let statusChannelCompanyId: string | null = null;

  const openStatusChannel = (companyId: string): void => {
    if (!companyId || statusChannelCompanyId === companyId) return;
    try {
      ctx.streams.open(STREAM_CHANNEL, companyId);
      statusChannelCompanyId = companyId;
      ctx.logger.debug("klipper.stream.channel_opened", {
        pluginId: "platform.klipper",
        channel: STREAM_CHANNEL,
        source: "dispatch",
      });
    } catch (err) {
      ctx.logger.debug("klipper.stream.open_failed", {
        channel: STREAM_CHANNEL,
        error: String(err instanceof Error ? err.message : err),
      });
    }
  };

  const closeStatusChannel = (): void => {
    if (statusChannelCompanyId === null) return;
    statusChannelCompanyId = null;
    try {
      ctx.streams.close(STREAM_CHANNEL);
      ctx.logger.debug("klipper.stream.channel_closed", {
        pluginId: "platform.klipper",
        channel: STREAM_CHANNEL,
      });
    } catch (err) {
      ctx.logger.debug("klipper.stream.close_failed", {
        channel: STREAM_CHANNEL,
        error: String(err instanceof Error ? err.message : err),
      });
    }
  };

  /**
   * Stop a transport and tear the status stream channel down with it: a
   * stopped printer pushes no status, and the UI subscription should see
   * the channel end instead of silently starving. Re-pinning happens at the
   * next in-dispatch start.
   */
  const stopClient = (client: { stop(): void } | null): void => {
    if (!client) return;
    client.stop();
    closeStatusChannel();
  };

  /**
   * Config-application invalidation for a credential-bearing transport.
   * A STARTED transport is stopped and dropped — no live connection may
   * outlive the credential resolution that authorized it. A dormant
   * never-started client is KEPT (with its credential cleared) so the
   * per-company boot replay burst converges without churning clients.
   */
  const invalidateTransportForApplication = (): void => {
    const client = handle.client;
    if (!client) return;
    if (transportStarted) {
      handle.client = null;
      stopClient(client);
    } else {
      client.applyCredential(null);
    }
    transportStarted = false;
  };

  const handle: KlipperWorker = {
    client: null,
    config: {} as KlipperConfig,
    configKnown: false,
    getCredentialPendingReason: () => credentialPendingReason,
    /**
     * Camera feed (single upstream MJPG connection, keep-latest buffer).
     * Managed INDEPENDENTLY of the printer transport: a camera config
     * problem degrades the camera section only and never takes the
     * transport down (and vice versa). `null` = camera not configured.
     */
    camera: null,
    cameraFingerprint: null,
    async applyConfig(nextConfig, source, autoStart = true) {
      // Defensive: a malformed replay must not crash the worker; treat it
      // like an absent config and degrade permissively.
      const config: Partial<KlipperConfig> =
        nextConfig && typeof nextConfig === "object" ? nextConfig : {};
      // Any config application ends the "booted unconfigured" state — this
      // is the only path config ever arrives by (no setup-time read).
      handle.configKnown = true;
      // EVERY config application invalidates the in-dispatch credential
      // cache: the resolved plaintext must never outlive the config that
      // produced it, and a rotated secret on an unchanged ref must be
      // picked up at the next dispatch. Until that dispatch the transport
      // runs dormant/degraded (fail-closed idle).
      credentialCache = null;

      // ── Camera feed (independent of transport selection) ─────────────
      // Validated like the transport config (http(s), no userinfo, host
      // allowlist defaulting to the FlashForge host) and additionally
      // scoped to /?action=stream. A camera config problem degrades ONLY
      // the camera section — the transport client is untouched.
      {
        const camRaw = config.flashforgeCameraBaseUrl;
        const camFingerprint = JSON.stringify([
          "camera",
          camRaw ?? null,
          [...(config.flashforgeCameraAllowedHosts ?? [])].sort(),
        ]);
        const prevCamFingerprint = handle.camera ? handle.cameraFingerprint : null;
        if (camRaw === undefined || camRaw === null || camRaw === "") {
          if (handle.camera) {
            handle.camera.dispose();
            handle.camera = null;
            handle.cameraFingerprint = null;
            ctx.logger.info("paperclip-klipper camera removed from config — camera section disabled", {
              pluginId: "platform.klipper",
              source,
            });
          }
        } else if (handle.camera && prevCamFingerprint === camFingerprint) {
          // Same camera identity — keep the feed (per-company replay burst).
        } else {
          const ffHost = (() => {
            try {
              return config.flashforgeBaseUrl ? new URL(config.flashforgeBaseUrl).host : null;
            } catch {
              return null;
            }
          })();
          const validated = validateCameraBaseUrl(camRaw, config.flashforgeCameraAllowedHosts, ffHost);
          if (!validated.ok) {
            if (handle.camera) {
              handle.camera.dispose();
              handle.camera = null;
              handle.cameraFingerprint = null;
            }
            ctx.logger.warn(
              "paperclip-klipper rejected flashforgeCameraBaseUrl — camera section disabled; the transport is unaffected",
              { pluginId: "platform.klipper", source, reason: validated.reason, host: validated.host },
            );
          } else {
            if (handle.camera) handle.camera.dispose();
            handle.camera = new CameraFeed({
              baseUrl: validated.url,
              logger: ctx.logger,
            });
            handle.cameraFingerprint = camFingerprint;
            ctx.logger.info("paperclip-klipper camera feed configured — opens on first board viewer", {
              pluginId: "platform.klipper",
              source,
              cameraHost: validated.host,
            });
          }
        }
      }
      // Fingerprint the PREVIOUS connection identity (kind-aware: a live
      // flashforge client must be compared with the flashforge fingerprint,
      // not the moonraker one) before overwriting the display config, so the
      // unchanged-replay no-op below compares old vs new rather than new vs
      // new.
      const prevFingerprint = handle.client
        ? transportFingerprint(handle.config)
        : null;
      handle.config = config as KlipperConfig;

      // ── Transport selection ─────────────────────────────────────────────
      // Absent/unset resolves to moonraker (legacy behavior). An UNKNOWN
      // value is rejected fail-closed: stop any live client, keep the worker
      // permissive-but-inert, and log a clear reason. Never a silent
      // fallthrough to moonraker.
      const selection = selectTransport(config.transport);
      if (!selection.ok) {
        if (handle.client) {
          const old = handle.client;
          handle.client = null;
          stopClient(old);
        }
        ctx.logger.warn(
          "paperclip-klipper rejected the transport config value — refusing to start any printer client; tool calls will return prerequisite_missing until this is fixed",
          { pluginId: "platform.klipper", source, reason: selection.reason },
        );
        registerRpcSurface(ctx, surfaceOptions(config as KlipperConfig));
        return;
      }

      // Stop any live client and degrade to the permissive surface. Shared
      // by the fail-closed paths below (missing/invalid config, unresolved
      // credential): no transport ever runs unscoped or uncredentialed.
      const stopAndDegrade = (): void => {
        if (handle.client) {
          const old = handle.client;
          handle.client = null;
          stopClient(old);
        }
        transportStarted = false;
        credentialPendingReason = null;
        registerRpcSurface(ctx, surfaceOptions(config as KlipperConfig));
      };

      if (selection.kind === "moonraker") {
      const rawBaseUrl = config.moonrakerBaseUrl;

      // NO apply-time `ctx.secrets.resolve` anywhere in this branch — see
      // the credential-semantics note at the top of this file. A
      // ref-bearing config converges to a DORMANT transport here;
      // `ensureCredential` resolves the ref lazily inside the first
      // dispatch that needs it (dispatch attribution authorizes the call).
      if (!rawBaseUrl) {
        // Config applied with no baseUrl: degrade to permissive init. Stop any
        // live client so a stale transport can never outlive its config.
        if (handle.client) {
          const old = handle.client;
          handle.client = null;
          stopClient(old);
          ctx.logger.warn(
            "paperclip-klipper config applied without moonrakerBaseUrl — stopped the Moonraker client; tool calls return prerequisite_missing until config is set",
            { pluginId: "platform.klipper", source },
          );
        } else {
          ctx.logger.warn(
            "paperclip-klipper config applied without moonrakerBaseUrl — tool calls will return prerequisite_missing until config is set",
            { pluginId: "platform.klipper", source },
          );
        }
        registerRpcSurface(ctx, surfaceOptions(config as KlipperConfig));
        return;
      }

      // Validate BEFORE the resolved `moonrakerApiKeyRef` credential ever
      // reaches a client wired to this value: WHATWG URL parse, reject
      // non-http(s) schemes, and enforce the (by default self-derived) host
      // allowlist. A value that fails validation must not crash the worker —
      // degrade to permissive init (and stop a live client whose config was
      // just replaced by an invalid one) and warn with the rejected *host*
      // only (never the full value, never any credential).
      const validated = validateMoonrakerBaseUrl(rawBaseUrl, config.moonrakerAllowedHosts);
      if (!validated.ok) {
        if (handle.client) {
          const old = handle.client;
          handle.client = null;
          stopClient(old);
        }
        ctx.logger.warn(
          "paperclip-klipper rejected moonrakerBaseUrl — refusing to start the Moonraker client until this is fixed; tool calls will return prerequisite_missing",
          { pluginId: "platform.klipper", source, reason: validated.reason, host: validated.host },
        );
        registerRpcSurface(ctx, surfaceOptions(config as KlipperConfig));
        return;
      }
      const baseUrl = validated.url.toString();

      const hasApiKeyRef =
        config.moonrakerApiKeyRef !== undefined && config.moonrakerApiKeyRef !== null;
      const fingerprint = connectionFingerprint(config);

      if (!hasApiKeyRef) {
        // Unauthenticated Moonraker (no ref configured): legacy convergence
        // semantics. An identical replay burst keeps the live client (no
        // churn); a new connection identity replaces it. No credential is
        // involved, so the transport starts immediately (autoStart) and
        // nothing is pending.
        if (handle.client && prevFingerprint === fingerprint) {
          handle.client.applyCredential(null);
          registerRpcSurface(ctx, surfaceOptions(config as KlipperConfig));
          ctx.logger.debug("klipper.config_replay_unchanged", { pluginId: "platform.klipper", source });
          return;
        }
        credentialPendingReason = null;
        if (handle.client) {
          const old = handle.client;
          handle.client = null;
          stopClient(old);
          transportStarted = false;
          ctx.logger.info("klipper.connection_replaced", {
            pluginId: "platform.klipper",
            source,
            moonrakerBaseUrl: baseUrl,
          });
        }
        const client = new MoonrakerClient({
          baseUrl,
          apiKey: null,
          http: ctx.http,
          logger: ctx.logger,
          ...transportStreamCallbacks,
          ...clientOverrides,
        });
        handle.client = client;
        registerRpcSurface(ctx, surfaceOptions(config as KlipperConfig));
        ctx.logger.info(
          source === "setup"
            ? "paperclip-klipper worker setup"
            : "paperclip-klipper config applied via host replay — Moonraker client started",
          {
            moonrakerBaseUrl: baseUrl,
            hasApiKeyRef: false,
            auto_upload_artifacts: config.auto_upload_artifacts === true,
            allow_agent_initiated_print: config.allow_agent_initiated_print === true,
          },
        );
        if (autoStart) {
          // Open the WS connection in the background. A missing printer is a
          // degraded state, not a setup failure; the reconnect loop drives retries.
          transportStarted = true;
          void client.start().catch((err) => {
            ctx.logger.warn("klipper.ws.initial_connect_failed", {
              error: String(err instanceof Error ? err.message : err),
            });
          });
        }
        return;
      }

      // Credential-bearing config: converge to a DORMANT transport. The
      // application already invalidated the resolution cache; a started
      // transport was stopped and dropped above, a dormant matching client
      // is reused (no churn across the boot replay burst). The WS opens
      // only after `ensureCredential` resolves the ref INSIDE a dispatch.
      invalidateTransportForApplication();
      credentialPendingReason = CREDENTIAL_PENDING_MESSAGE;
      if (!(handle.client && prevFingerprint === fingerprint)) {
        handle.client = new MoonrakerClient({
          baseUrl,
          apiKey: null,
          http: ctx.http,
          logger: ctx.logger,
          ...transportStreamCallbacks,
          ...clientOverrides,
        });
      }
      transportStarted = false;
      registerRpcSurface(ctx, surfaceOptions(config as KlipperConfig));
      ctx.logger.info(
        "paperclip-klipper config applied — Moonraker transport dormant until the first dispatch resolves the API key ref (fail-closed idle)",
        {
          moonrakerBaseUrl: baseUrl,
          clientReused: Boolean(handle.client && prevFingerprint === fingerprint),
          auto_upload_artifacts: config.auto_upload_artifacts === true,
          allow_agent_initiated_print: config.allow_agent_initiated_print === true,
        },
      );
      return;
      } // ── end moonraker branch ──────────────────────────────────────────

      // ── FlashForge transport (Creator 5 LAN-only HTTP API) ─────────────
      const ffValidated = validateFlashForgeConfig(config);
      if (!ffValidated.ok) {
        // Fail closed with a clear validation error at load: stop any live
        // client, surface every missing/invalid field, and keep the worker
        // permissive-but-inert. NEVER a silent fallthrough to moonraker.
        if (handle.client) {
          const old = handle.client;
          handle.client = null;
          stopClient(old);
        }
        ctx.logger.warn(
          "paperclip-klipper rejected the flashforge transport config — refusing to start the FlashForge client; tool calls will return prerequisite_missing until the config is completed",
          {
            pluginId: "platform.klipper",
            source,
            reason: ffValidated.reason,
            fields: ffValidated.fields,
            host: ffValidated.host,
            detail: describeFlashForgeConfigFailure(ffValidated),
          },
        );
        registerRpcSurface(ctx, surfaceOptions(config as KlipperConfig));
        return;
      }
      const ff = ffValidated.config;

      // NO apply-time `ctx.secrets.resolve` — see the credential-semantics
      // note at the top of this file. The check-code ref resolves lazily
      // INSIDE the first dispatch that needs it; here the transport simply
      // converges DORMANT (no /detail poll, status/health report the
      // pending reason until then).
      invalidateTransportForApplication();
      credentialPendingReason = CREDENTIAL_PENDING_MESSAGE;
      const fingerprint = flashforgeFingerprint(config);
      if (!(handle.client && prevFingerprint === fingerprint)) {
        const client = new FlashForgeClient({
          baseUrl: ff.baseUrl,
          serialNumber: ff.serialNumber,
          checkCode: null,
          http: ctx.http,
          logger: ctx.logger,
          ...transportStreamCallbacks,
          ...flashforgeClientOverrides,
        });
        handle.client = client;
      }
      transportStarted = false;
      registerRpcSurface(ctx, surfaceOptions(config as KlipperConfig));
      ctx.logger.info(
        "paperclip-klipper FlashForge transport config applied — dormant until the first dispatch resolves the check-code ref (fail-closed idle)",
        {
          transport: "flashforge",
          flashforgeBaseUrl: ff.baseUrl,
          clientReused: Boolean(handle.client && prevFingerprint === fingerprint),
          auto_upload_artifacts: config.auto_upload_artifacts === true,
          allow_agent_initiated_print: config.allow_agent_initiated_print === true,
        },
      );
      // No autoStart branch: the /detail poll loop starts when
      // `applyCredential()` receives the in-dispatch-resolved credential.
    },
  };

  // ── Lazy in-dispatch credential resolution ──────────────────────────────
  type FlashForgeValidated = Extract<
    ReturnType<typeof validateFlashForgeConfig>,
    { ok: true }
  >["config"];

  /**
   * Resolve the configured credential ref INSIDE a tool dispatch and bring
   * the transport up. Dispatch attribution (the executeTool scope carries
   * companyId+runId) is the one reliable authorization path for
   * `ctx.secrets.resolve` on this worker class — a resolve from config
   * apply, the status poll, WS reconnects, or UI surfaces is id-less
   * outside a dispatch and would be denied by single-in-flight
   * attribution.
   *
   * Cache semantics: the plaintext is held in memory keyed to the LIVE
   * config fingerprint and invalidated by every config application, so a
   * rotated secret lands at the next dispatch. Never logged, never
   * persisted. A resolve failure keeps the transport dormant (fail closed)
   * and returns a reason that names no credential material.
   */
  async function ensureCredential(
    liveConfig: Partial<KlipperConfig>,
    method: string,
    dispatchCompanyId = "",
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const selection = selectTransport(liveConfig.transport);
    if (!selection.ok) {
      return {
        ok: false,
        reason: `the transport config is invalid (${selection.reason}) — fix the plugin config and retry`,
      };
    }
    const fingerprint = transportFingerprint(liveConfig);
    if (fingerprint === null) {
      return {
        ok: false,
        reason: "the transport config is incomplete — fix the plugin config and retry",
      };
    }

    // Unauthenticated Moonraker (no ref configured): nothing to resolve.
    // The host runs ONE worker child per plugin, shared by every company,
    // so the live client here may be the LAST-APPLIED company's transport
    // (boot replay / operator save ordering), not the dispatching one.
    // Apply the credentialed path's own identity guard: validate the live
    // config, and rebuild the client from it whenever the live client's
    // connection identity differs — otherwise this dispatch would be
    // routed onto another company's printer.
    if (
      selection.kind === "moonraker" &&
      !(
        liveConfig.moonrakerApiKeyRef !== undefined &&
        liveConfig.moonrakerApiKeyRef !== null
      )
    ) {
      credentialPendingReason = null;
      if (!liveConfig.moonrakerBaseUrl) {
        return {
          ok: false,
          reason: "moonrakerBaseUrl is not set — fix the plugin config and retry",
        };
      }
      const validated = validateMoonrakerBaseUrl(
        liveConfig.moonrakerBaseUrl,
        liveConfig.moonrakerAllowedHosts,
      );
      if (!validated.ok) {
        return {
          ok: false,
          reason: `the moonraker transport config is invalid (${validated.reason}) — fix the plugin config and retry`,
        };
      }
      // Same `reusable` guard as the credentialed path below: keep the
      // live client only when its connection identity matches the
      // dispatching company's validated config.
      const reusable =
        handle.client !== null &&
        handle.client.kind === selection.kind &&
        transportFingerprint(handle.config) === fingerprint;
      if (!reusable) {
        if (handle.client) {
          const old = handle.client;
          handle.client = null;
          stopClient(old);
          ctx.logger.info("klipper.connection_replaced", {
            pluginId: "platform.klipper",
            source: "dispatch",
            moonrakerBaseUrl: validated.url.toString(),
          });
        }
        transportStarted = false;
        handle.client = new MoonrakerClient({
          baseUrl: validated.url.toString(),
          apiKey: null,
          http: ctx.http,
          logger: ctx.logger,
          ...transportStreamCallbacks,
          ...clientOverrides,
        });
        // Keep the apply-path invariant that `handle.config` describes the
        // client the worker currently holds. Without this, the next apply
        // of the previous company's row would misread the just-rebuilt
        // client as "unchanged" and keep the WRONG connection alive.
        handle.config = liveConfig as KlipperConfig;
        handle.configKnown = true;
        // Belt-and-suspenders for the credentialed fast path below: after
        // an unauth rebuild the transport holds NO resolved plaintext, so
        // any surviving cache entry is stale by construction (its
        // fingerprint can describe the config while the held client does
        // not). Drop it rather than let a later dispatch fast-path onto
        // the rebuilt unauthenticated client.
        credentialCache = null;
      }
      if (handle.client && !transportStarted) {
        transportStarted = true;
        // The transport loop starts inside this dispatch — pin the status
        // stream channel to the dispatching company so the transport's
        // out-of-dispatch status emits attribute to it from the first
        // snapshot on.
        openStatusChannel(dispatchCompanyId);
        void handle.client.start().catch((err) => {
          ctx.logger.warn("klipper.ws.initial_connect_failed", {
            error: String(err instanceof Error ? err.message : err),
          });
        });
      } else if (transportStarted) {
        // Already running from an earlier dispatch: re-point the pin when
        // the dispatching company changed (the SDK's channel→company map
        // feeds every later emit, and the host re-pins on a verified open).
        openStatusChannel(dispatchCompanyId);
      }
      return { ok: true };
    }

    // Connection identity of the HELD client vs the dispatching company's
    // validated live config. A thunk, not a snapshot: the fast path calls
    // it before the resolve, and the resolve path re-evaluates it after
    // the await (a concurrent dispatch continuation may replace the client
    // while the secret resolve is in flight).
    const identityMatches = (): boolean =>
      handle.client !== null &&
      handle.client.kind === selection.kind &&
      transportFingerprint(handle.config) === fingerprint;

    // Fast path: already resolved for THIS exact config AND the held
    // client still IS this company's transport. The identity re-check is
    // mandatory: the cache is keyed to the config fingerprint, not to the
    // client, and an interleaved dispatch from another company (e.g. the
    // unauth rebuild above) can replace the client WITHOUT touching the
    // cache — trusting it here would route this dispatch onto the other
    // company's printer. On any mismatch, fall through to the full
    // in-dispatch resolve below, which rebuilds from the validated live
    // config and syncs the config identity.
    if (
      credentialCache !== null &&
      credentialCache.fingerprint === fingerprint &&
      identityMatches()
    ) {
      credentialPendingReason = null;
      if (!transportStarted) {
        transportStarted = true;
        // Transport start inside this dispatch — pin the status stream
        // channel to the dispatching company (see the unauth branch note).
        openStatusChannel(dispatchCompanyId);
        // TS cannot narrow `handle.client` through the `identityMatches`
        // thunk, so this stays optional-chained (the fast-path condition
        // guarantees a client of the selected kind exists).
        if (handle.client?.kind === "moonraker") {
          void handle.client.start().catch((err) => {
            ctx.logger.warn("klipper.ws.initial_connect_failed", {
              error: String(err instanceof Error ? err.message : err),
            });
          });
        }
        // flashforge: the applyCredential(code) that cached the value
        // already (re)started the poll loop.
      } else {
        // Already running: re-point the pin when the dispatching company
        // changed (identical-connection-identity configs from two companies
        // reuse the held client; the status stream follows the dispatch).
        openStatusChannel(dispatchCompanyId);
      }
      return { ok: true };
    }

    // Resolve IN-DISPATCH. Every code path below this line runs with a
    // dispatch in flight — that is what makes the call authorized.
    let ref: SecretRef;
    let flashforgeConfig: FlashForgeValidated | null = null;
    let moonrakerBaseUrl: string | null = null;
    if (selection.kind === "flashforge") {
      const validated = validateFlashForgeConfig(liveConfig);
      if (!validated.ok) {
        return {
          ok: false,
          reason: `the flashforge transport config is invalid (${validated.reason}) — fix the plugin config and retry`,
        };
      }
      flashforgeConfig = validated.config;
      ref = validated.config.checkCodeRef;
    } else {
      if (!liveConfig.moonrakerBaseUrl) {
        return {
          ok: false,
          reason: "moonrakerBaseUrl is not set — fix the plugin config and retry",
        };
      }
      const validated = validateMoonrakerBaseUrl(
        liveConfig.moonrakerBaseUrl,
        liveConfig.moonrakerAllowedHosts,
      );
      if (!validated.ok) {
        return {
          ok: false,
          reason: `the moonraker transport config is invalid (${validated.reason}) — fix the plugin config and retry`,
        };
      }
      moonrakerBaseUrl = validated.url.toString();
      ref = liveConfig.moonrakerApiKeyRef as SecretRef;
    }

    let plaintext: string;
    try {
      plaintext = await resolveSecretRef(ctx.secrets, ref);
    } catch (err) {
      // Fail closed: the transport stays dormant; the reason carries no
      // credential material.
      const detail = err instanceof Error ? err.message : String(err);
      credentialPendingReason = `credential not resolved yet — the configured secret ref failed to resolve on dispatch (${detail})`;
      ctx.logger.warn("klipper.credential_dispatch_resolve_failed", {
        pluginId: "platform.klipper",
        transport: selection.kind,
        method,
        reason: detail,
      });
      return {
        ok: false,
        reason:
          "credential not resolved yet — the configured secret ref could not be resolved (see worker logs); fix the secret and retry the dispatch",
      };
    }
    credentialCache = { fingerprint, plaintext };

    // Converge the transport onto the LIVE config with the credential:
    // reuse the client only when its connection identity matches the live
    // config (re-evaluated AFTER the resolve await — the held client may
    // have been replaced while the resolve was in flight), otherwise
    // rebuild from the validated live config (the dispatching company's
    // config is authoritative at dispatch time).
    const reusable = identityMatches();
    if (!reusable) {
      if (handle.client) {
        const old = handle.client;
        handle.client = null;
        stopClient(old);
      }
      transportStarted = false;
      handle.client =
        selection.kind === "flashforge" && flashforgeConfig !== null
          ? new FlashForgeClient({
              baseUrl: flashforgeConfig.baseUrl,
              serialNumber: flashforgeConfig.serialNumber,
              checkCode: plaintext,
              http: ctx.http,
              logger: ctx.logger,
              ...transportStreamCallbacks,
              ...flashforgeClientOverrides,
            })
          : new MoonrakerClient({
              baseUrl: moonrakerBaseUrl as string,
              apiKey: plaintext,
              http: ctx.http,
              logger: ctx.logger,
              ...transportStreamCallbacks,
              ...clientOverrides,
            });
      // Same invariant as the apply path and the unauth branch above:
      // `handle.config` must describe the client the worker now holds,
      // or the next apply of the previous company's row treats this
      // rebuilt client as "unchanged" and routes on the WRONG connection.
      handle.config = liveConfig as KlipperConfig;
      handle.configKnown = true;
    } else {
      // `reusable` guarantees the client exists (TS cannot narrow through
      // the closure, so this stays optional-chained).
      handle.client?.applyCredential(plaintext);
    }
    const active = handle.client;
    credentialPendingReason = null;
    if (!transportStarted && active) {
      transportStarted = true;
      // Transport start inside this dispatch — pin the status stream
      // channel to the dispatching company so the transport's
      // out-of-dispatch status emits attribute to it from the first
      // snapshot on.
      openStatusChannel(dispatchCompanyId);
      if (!(selection.kind === "flashforge" && reusable)) {
        // flashforge: applyCredential(code) already (re)started the poll
        // loop; a second start() here would double-fire the first poll.
        void active.start().catch((err) => {
          ctx.logger.warn("klipper.transport.initial_connect_failed", {
            transport: selection.kind,
            error: String(err instanceof Error ? err.message : err),
          });
        });
      }
    } else if (active && transportStarted) {
      // Already running: re-point the pin when the dispatching company
      // changed (identical-connection-identity configs from two companies
      // reuse the held client; the status stream follows the dispatch).
      openStatusChannel(dispatchCompanyId);
    }
    ctx.logger.info("klipper.credential_resolved_in_dispatch", {
      pluginId: "platform.klipper",
      transport: selection.kind,
      method,
    });
    return { ok: true };
  }

  /**
   * Options for the RPC surface registration. Handlers read the CURRENT
   * client through the `getClient` thunk (an in-dispatch convergence can
   * replace the client object mid-flight) and the credential state through
   * `getDegradedReason`, so a registration never pins a stale snapshot.
   */
  function surfaceOptions(config: KlipperConfig): RpcSurfaceOptions {
    return {
      config,
      getClient: () => handle.client,
      getDegradedReason: () => credentialPendingReason,
      ensureCredential,
      camera: handle.camera,
    };
  }

  // Subscribe once per worker lifetime (NOT per config application) so the
  // per-company replay burst at boot cannot stack duplicate handlers.
  // Real event handlers (auto-upload on artifact-produced, etc.) land in 6.5.
  ctx.events.on("issue.created", async (event) => {
    ctx.logger.debug("event observed (stub)", {
      eventType: "issue.created",
      entityId: event.entityId,
      todo: "real handlers land in 6.5",
    });
  });

  // Config is UNKNOWN at boot (no setup read — see top-of-file note).
  // Register the permissive surface so tools/data/actions exist and return
  // `prerequisite_missing`; `onConfigChanged` applies the host replay.
  handle.configKnown = false;
  registerRpcSurface(ctx, surfaceOptions({} as KlipperConfig));
  ctx.logger.info(
    "paperclip-klipper booted without a config read (by design: setup makes no worker→host calls); connection stays down until the host config replay or an operator save lands",
    { pluginId: "platform.klipper" },
  );

  return handle;
}

/**
 * Live worker handle + ctx for the `configChanged` host RPC. The SDK routes
 * host→worker calls to the plugin definition's hooks WITHOUT a ctx argument,
 * so setup stashes both here (same pattern as the messenger worker).
 */
let activeWorker: KlipperWorker | null = null;
let activeCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    // Skip auto-start under Vitest so the scaffold tests don't try
    // to open a real WebSocket against a fake hostname. Tests that exercise
    // the WS path use `createKlipperWorker` directly with the mock server.
    const inVitest = process.env.VITEST === "true";
    activeCtx = ctx;
    activeWorker = await createKlipperWorker(ctx, { autoStart: !inVitest });
  },

  // Host replay path (authoritative on this host family): right after boot
  // the loader replays each configured company's row through this hook, and
  // every operator config save uses the same path. Without it the host would
  // restart the worker to apply config — re-running setup, hitting the same
  // service-scope denial, and never converging.
  async onConfigChanged(newConfig: Record<string, unknown>) {
    const worker = activeWorker;
    const ctx = activeCtx;
    if (!worker || !ctx) return;
    try {
      // A replay/save is an authoritative, company-resolved snapshot.
      await worker.applyConfig(
        (newConfig ?? {}) as Partial<KlipperConfig>,
        "configChanged",
        process.env.VITEST !== "true",
      );
    } catch (err) {
      // A failed apply must never error the RPC back to the host — the
      // worker stays alive and permissive; the replay is best-effort.
      ctx.logger.error("klipper.config_changed_apply_failed", {
        pluginId: "platform.klipper",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async onHealth() {
    // Boot observability: distinguish "booted, config replay pending"
    // from "operator configured no baseUrl" and from a live connection.
    const details: Record<string, unknown> = {
      configKnown: activeWorker?.configKnown ?? false,
      clientActive: Boolean(activeWorker?.client),
    };
    // Fail-closed idle: a ref-bearing transport that no dispatch has
    // credentialed yet reports degraded with the pending reason — never a
    // stale "ok", never a probe against a credential-less transport.
    const pending = activeWorker?.getCredentialPendingReason?.();
    if (pending) {
      return {
        status: "degraded" as const,
        message: `paperclip-klipper degraded: ${pending}`,
        details: { ...details, credentialPending: true },
      };
    }
    // Transports that can probe reachability on demand (FlashForge) are
    // health-checked FAIL-CLOSED: a fresh probe that cannot reach the
    // printer reports `degraded`, never a stale "ok" from the poll cache.
    // Moonraker keeps its historical liveness-only health report.
    const client = activeWorker?.client;
    if (client && typeof client.probeHealth === "function") {
      const report = await client.probeHealth();
      return {
        status: report.reachable ? ("ok" as const) : ("degraded" as const),
        message: report.reachable
          ? `paperclip-klipper worker is running — ${report.message}`
          : `paperclip-klipper degraded: ${report.message}`,
        details: { ...details, ...report.details },
      };
    }
    return {
      status: "ok" as const,
      message: "paperclip-klipper worker is running",
      details,
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
