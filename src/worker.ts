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
import {
  canonicalSecretRefIdentity,
  resolveSecretRef,
  type SecretRef,
} from "./worker/secretRef.js";
import { FlashForgeClient } from "./worker/transports/FlashForgeClient.js";
import {
  describeFlashForgeConfigFailure,
  selectTransport,
  validateFlashForgeConfig,
} from "./worker/transports/validateTransportConfig.js";
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
 * Credential semantics (resolve at config application only):
 *   For the same reason, `ctx.secrets.resolve` is NEVER called outside a
 *   config application. The status poll, WS reconnect loop, health probes,
 *   and UI data keys all run outside dispatches; a per-request/per-cycle
 *   resolve from any of them poisons the method the same way. Instead,
 *   `applyConfig` resolves the configured secret ref ONCE per config
 *   application — the `configChanged` RPC runs inside the host's scoped
 *   push, so that call is attributed and company-scoped — and hands the
 *   plaintext to the transport client, which holds it in memory only. The
 *   cache never outlives the config that produced it: every application
 *   (including unchanged-fingerprint replays) re-resolves and swaps the
 *   value in. A resolve failure is fail-closed: no client is built (or the
 *   live one is stopped), tools return `prerequisite_missing`, and the
 *   reason is logged without any credential material.
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

/** Where a config snapshot came from — named in logs for boot observability. */
export type KlipperConfigSource = "setup" | "configChanged";

export interface KlipperWorker {
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

  const handle: KlipperWorker = {
    client: null,
    config: {} as KlipperConfig,
    configKnown: false,
    async applyConfig(nextConfig, source, autoStart = true) {
      // Defensive: a malformed replay must not crash the worker; treat it
      // like an absent config and degrade permissively.
      const config: Partial<KlipperConfig> =
        nextConfig && typeof nextConfig === "object" ? nextConfig : {};
      // Any config application ends the "booted unconfigured" state — this
      // is the only path config ever arrives by (no setup-time read).
      handle.configKnown = true;
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
          old.stop();
        }
        ctx.logger.warn(
          "paperclip-klipper rejected the transport config value — refusing to start any printer client; tool calls will return prerequisite_missing until this is fixed",
          { pluginId: "platform.klipper", source, reason: selection.reason },
        );
        registerRpcSurface(ctx, { config: config as KlipperConfig, client: null });
        return;
      }

      // Stop any live client and degrade to the permissive surface. Shared
      // by the fail-closed paths below (missing/invalid config, unresolved
      // credential): no transport ever runs unscoped or uncredentialed.
      const stopAndDegrade = (): void => {
        if (handle.client) {
          const old = handle.client;
          handle.client = null;
          old.stop();
        }
        registerRpcSurface(ctx, { config: config as KlipperConfig, client: null });
      };

      if (selection.kind === "moonraker") {
      const rawBaseUrl = config.moonrakerBaseUrl;

      // ── Credential resolution (config-apply scope ONLY) ─────────────────
      // `ctx.secrets.resolve` is called here and nowhere else in the worker
      // lifecycle: applyConfig runs inside the host's scoped config push
      // (`configChanged` RPC), where worker→host calls carry the applying
      // company's context. A resolve from the status poll, WS reconnect,
      // UI data keys, or actions would be id-less with nothing in flight
      // and permanently poison the method (single-in-flight attribution —
      // see the boot-semantics note at the top of this file). The resolved
      // plaintext is handed to the client in memory and never logged.
      if (!rawBaseUrl) {
        // Config applied with no baseUrl: degrade to permissive init. Stop any
        // live client so a stale transport can never outlive its config.
        if (handle.client) {
          const old = handle.client;
          handle.client = null;
          old.stop();
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
        registerRpcSurface(ctx, { config: config as KlipperConfig, client: null });
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
          old.stop();
        }
        ctx.logger.warn(
          "paperclip-klipper rejected moonrakerBaseUrl — refusing to start the Moonraker client until this is fixed; tool calls will return prerequisite_missing",
          { pluginId: "platform.klipper", source, reason: validated.reason, host: validated.host },
        );
        registerRpcSurface(ctx, { config: config as KlipperConfig, client: null });
        return;
      }
      const baseUrl = validated.url.toString();

      let moonrakerApiKey: string | null = null;
      if (config.moonrakerApiKeyRef !== undefined && config.moonrakerApiKeyRef !== null) {
        try {
          moonrakerApiKey = await resolveSecretRef(ctx.secrets, config.moonrakerApiKeyRef);
        } catch (err) {
          // Fail closed: no transport runs without its credential, and a
          // live client whose secret just stopped resolving is stopped too.
          ctx.logger.warn(
            "paperclip-klipper could not resolve the Moonraker API key ref — refusing to run the transport without a credential (fail closed); fix the secret and save the config again",
            { pluginId: "platform.klipper", source, reason: err instanceof Error ? err.message : String(err) },
          );
          stopAndDegrade();
          return;
        }
      }

      const fingerprint = connectionFingerprint(config);
      if (handle.client && prevFingerprint === fingerprint) {
        // Same connection identity (per-company replay burst at boot, or an
        // operator save that only touched gate flags) — keep the live client,
        // but ALWAYS refresh the credential: every config application
        // re-resolves, so the cached value never outlives the config that
        // produced it (a rotated secret on an unchanged ref is picked up at
        // the next save/replay). Re-register so the `config` data key
        // reflects the latest snapshot; re-registration replaces by key.
        handle.client.applyCredential(moonrakerApiKey);
        registerRpcSurface(ctx, { config: config as KlipperConfig, client: handle.client });
        ctx.logger.debug("klipper.config_replay_unchanged", { pluginId: "platform.klipper", source });
        return;
      }

      if (handle.client) {
        const old = handle.client;
        handle.client = null;
        old.stop();
        ctx.logger.info("klipper.connection_replaced", {
          pluginId: "platform.klipper",
          source,
          moonrakerBaseUrl: baseUrl,
        });
      }

      const client = new MoonrakerClient({
        baseUrl,
        apiKey: moonrakerApiKey,
        http: ctx.http,
        logger: ctx.logger,
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
        ...clientOverrides,
      });
      handle.client = client;

      registerRpcSurface(ctx, { config: config as KlipperConfig, client });

      ctx.logger.info(
        source === "setup"
          ? "paperclip-klipper worker setup"
          : "paperclip-klipper config applied via host replay — Moonraker client started",
        {
          moonrakerBaseUrl: baseUrl,
          hasApiKeyRef: Boolean(config.moonrakerApiKeyRef),
          auto_upload_artifacts: config.auto_upload_artifacts === true,
          allow_agent_initiated_print: config.allow_agent_initiated_print === true,
        },
      );

      if (autoStart) {
        // Open the WS connection in the background. A missing printer is a
        // degraded state, not a setup failure; the reconnect loop drives retries.
        client.start().catch((err) => {
          ctx.logger.warn("klipper.ws.initial_connect_failed", {
            error: String(err instanceof Error ? err.message : err),
          });
        });
      }
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
          old.stop();
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
        registerRpcSurface(ctx, { config: config as KlipperConfig, client: null });
        return;
      }
      const ff = ffValidated.config;

      // ── Credential resolution (config-apply scope ONLY) ─────────────────
      // Resolve the check-code ref ONCE per config application. The
      // status poll previously resolved it per cycle — every ~10s, almost
      // always with no dispatch in flight — which permanently poisoned
      // `secrets.resolve` for the worker (single-in-flight attribution)
      // and took the transport down with `flashforge.poll.failed`. The
      // poll, health probes, and UI data keys now read the value resolved
      // HERE, inside the host's scoped push; the plaintext is held in the
      // client's memory only and never logged.
      let checkCode: string;
      try {
        checkCode = await resolveSecretRef(ctx.secrets, ff.checkCodeRef);
      } catch (err) {
        // Fail closed: no transport runs without its credential, and a
        // live client whose secret just stopped resolving is stopped too.
        ctx.logger.warn(
          "paperclip-klipper could not resolve the flashforge check-code ref — refusing to run the transport without a credential (fail closed); fix the secret and save the config again",
          { pluginId: "platform.klipper", source, reason: err instanceof Error ? err.message : String(err) },
        );
        stopAndDegrade();
        return;
      }

      const fingerprint = flashforgeFingerprint(config);
      if (handle.client && prevFingerprint === fingerprint) {
        // Same connection identity — keep the live client (replay burst),
        // still refreshing the credential (see the moonraker branch note:
        // the cache never outlives the config that produced it).
        handle.client.applyCredential(checkCode);
        registerRpcSurface(ctx, { config: config as KlipperConfig, client: handle.client });
        ctx.logger.debug("klipper.config_replay_unchanged", { pluginId: "platform.klipper", source });
        return;
      }

      if (handle.client) {
        const old = handle.client;
        handle.client = null;
        old.stop();
        ctx.logger.info("klipper.connection_replaced", {
          pluginId: "platform.klipper",
          source,
          transport: "flashforge",
          flashforgeBaseUrl: ff.baseUrl,
        });
      }

      const client = new FlashForgeClient({
        baseUrl: ff.baseUrl,
        serialNumber: ff.serialNumber,
        checkCode,
        http: ctx.http,
        logger: ctx.logger,
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
        ...flashforgeClientOverrides,
      });
      handle.client = client;

      registerRpcSurface(ctx, { config: config as KlipperConfig, client });

      ctx.logger.info(
        "paperclip-klipper FlashForge transport config applied — status poll client ready",
        {
          transport: "flashforge",
          flashforgeBaseUrl: ff.baseUrl,
          hasCheckCodeRef: Boolean(ff.checkCodeRef),
          auto_upload_artifacts: config.auto_upload_artifacts === true,
          allow_agent_initiated_print: config.allow_agent_initiated_print === true,
        },
      );

      if (autoStart) {
        // Open the /detail poll loop in the background. An unreachable
        // printer is a degraded state, not a setup failure; the poll loop
        // surfaces reconnecting/failed and health fails closed.
        client.start().catch((err) => {
          ctx.logger.warn("flashforge.poll.initial_connect_failed", {
            transport: "flashforge",
            error: String(err instanceof Error ? err.message : err),
          });
        });
      }
    },
  };

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
  registerRpcSurface(ctx, { config: {} as KlipperConfig, client: null });
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
