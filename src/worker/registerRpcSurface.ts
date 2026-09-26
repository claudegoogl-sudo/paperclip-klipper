/**
 * Single source of truth that maps MoonrakerClient operations onto the three
 * RPC surfaces a Paperclip plugin exposes — `ctx.data` (UI hooks read these),
 * `ctx.actions` (UI hooks call these), and `ctx.tools` (agent tools invoke
 * these). Both UI and tools route through the same MoonrakerClient instance,
 * which means there is exactly one transport layer for Moonraker calls.
 *
 * Tool gating:
 *   - `klipper.upload_gcode` requires `auto_upload_artifacts === true`.
 *   - `klipper.start_print` requires `allow_agent_initiated_print === true`.
 *
 * The data key `status` returns the latest WS-derived snapshot plus the
 * connection state so the dashboard widget can render a "disconnected"
 * banner without an extra round-trip.
 */
import { gunzipSync } from "node:zlib";
import type {
  PluginContext,
  PluginPerformActionContext,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { CameraFeed } from "./camera/CameraFeed.js";
import {
  MoonrakerHttpError,
  MoonrakerOutboundScopeError,
  type ConnectionStateSnapshot,
  type MoonrakerStatusSnapshot,
} from "./MoonrakerClient.js";
import {
  CREDENTIAL_PENDING_MESSAGE,
  FlashForgeApiError,
  FlashForgeCredentialPendingError,
  FlashForgeOutboundScopeError,
} from "./transports/FlashForgeClient.js";
import {
  selectTransport,
  validateFlashForgeConfig,
} from "./transports/validateTransportConfig.js";
import { validateMoonrakerBaseUrl } from "./validateMoonrakerBaseUrl.js";
import type { PrinterTransport } from "./transports/PrinterTransport.js";
import type { SecretRef } from "./secretRef.js";

/**
 * Upper bound on the *decompressed* g-code we will hand to Moonraker. Real
 * prints exceed the 10 MB issue-attachment store ceiling, so only the gzipped
 * artifact fits the store — the worker transparently inflates it here. This
 * cap is the gzip-bomb guard: it is enforced *during* inflation via
 * `gunzipSync(..., { maxOutputLength })`, which throws ERR_BUFFER_TOO_LARGE
 * before a malicious archive can balloon into memory. Do NOT replace this with
 * a post-inflation `bytes.length` check — that defeats the OOM protection.
 */
const MAX_INFLATED_GCODE_BYTES = 64 * 1024 * 1024; // 64 MB

export interface KlipperConfig {
  /**
   * Printer transport selection. Absent/undefined resolves to "moonraker"
   * (the legacy behavior, byte-for-byte). Any other value is rejected at
   * load by the worker (and by the manifest enum at the host layer).
   */
  transport?: "moonraker" | "flashforge";
  moonrakerBaseUrl: string;
  /**
   * Operator-configurable host allowlist for `moonrakerBaseUrl` (PLA safety
   * follow-up). When omitted or empty, defaults to the single host parsed
   * out of `moonrakerBaseUrl` itself — see `validateMoonrakerBaseUrl.ts`.
   */
  moonrakerAllowedHosts?: string[];
  /**
   * Secret ref for the Moonraker API key — legacy string shape or the
   * object binding ref ({ type: "secret_ref", secretId, version? }).
   * Resolved once per config application; the plaintext never reaches
   * this surface (handlers see the ref only).
   */
  moonrakerApiKeyRef?: SecretRef;
  /**
   * FlashForge transport (Creator 5 LAN-only HTTP API). All three keys are
   * required together when `transport: "flashforge"`; validation is
   * fail-closed (see ./transports/validateTransportConfig.ts).
   */
  flashforgeBaseUrl?: string;
  /** Optional host allowlist, mirroring moonrakerAllowedHosts. */
  flashforgeAllowedHosts?: string[];
  /** Printer serial number — the LAN-mode Device ID (identifier, not secret). */
  flashforgeSerialNumber?: string;
  /**
   * Secret reference for the per-printer check code credential — legacy
   * string shape or the object binding ref. Resolved once per config
   * application; the plaintext never reaches this surface (handlers see
   * the ref only).
   */
  flashforgeCheckCodeRef?: SecretRef;
  /**
   * Optional camera section upstream (the printer's MJPG-Streamer
   * endpoint). Validated like the transport config (http(s)-only, no
   * userinfo, host allowlist defaulting to the single FlashForge host) and
   * additionally scoped to exactly /?action=stream — see
   * ./camera/validateCameraConfig.ts. Absent = camera section renders
   * "not configured"; the transports run unchanged without it.
   */
  flashforgeCameraBaseUrl?: string;
  /** Optional host allowlist for flashforgeCameraBaseUrl. */
  flashforgeCameraAllowedHosts?: string[];
  auto_upload_artifacts?: boolean;
  allow_agent_initiated_print?: boolean;
}

/** Result of the worker's lazy in-dispatch credential resolution. */
export type CredentialResolution =
  | { ok: true }
  | { ok: false; reason: string };

export interface RpcSurfaceOptions {
  config: KlipperConfig;
  /**
   * Read the CURRENT printer transport. Handlers MUST NOT pin the client
   * at registration time: an in-dispatch credential resolution can
   * converge (replace) the client object while a dispatch is in flight,
   * and the stale object must never be used for the actual tool call.
   * `null` = the worker started without usable transport config; handlers
   * short-circuit with a `prerequisite_missing` result (permissive-init
   * pattern, matches the CAD plugin).
   */
  getClient: () => PrinterTransport | null;
  /**
   * Company that owns the held client (multi-company tenancy gate). The
   * data/action surface serves the client only to this company; `null`
   * (or absent) = no company scope, served to every caller.
   */
  getClientOwnerCompanyId?: () => string | null;
  /** Company whose applied config owns `config` + `camera` (same rule). */
  getConfigOwnerCompanyId?: () => string | null;
  /**
   * Why the transport is not running yet ("credential not resolved
   * yet"), or `null`. Merged into the status surfaces so the fail-closed
   * idle state is observable instead of a misleading gate error.
   */
  getDegradedReason?: () => string | null;
  /**
   * Resolve the configured credential ref lazily INSIDE a tool dispatch
   * (authorized by dispatch attribution), cache the plaintext in memory,
   * inject it into the transport and start it. Called by the tool
   * handlers that need a live transport; data keys / actions NEVER call
   * it (they run outside dispatches and must not fire worker→host calls).
   */
  ensureCredential?: (
    liveConfig: Partial<KlipperConfig>,
    method: string,
    /**
     * Company id of the CURRENT dispatch (from the handler's `runCtx`) —
     * the status stream channel is (re)pinned to this company while the
     * transport starts in-dispatch. The host re-derives the pin from the
     * echoed invocation scope, never from this value.
     */
    dispatchCompanyId?: string,
  ) => Promise<CredentialResolution>;
  /** Emit a status snapshot to the UI stream channel used by `usePluginStream`. */
  emitStreamSnapshot?: (snapshot: MoonrakerStatusSnapshot) => void;
  /** Emit a connection-state event to the UI stream channel. */
  emitStreamConnection?: (state: ConnectionStateSnapshot) => void;
  /**
   * Camera feed (single upstream MJPG connection + keep-latest buffer), or
   * `null` when the camera is not configured / failed validation. Camera
   * actions short-circuit with `prerequisite_missing` when null.
   */
  camera: CameraFeed | null;
  /**
   * Decompressed-g-code cap enforced during gunzip of gzip-magic artifacts in
   * `klipper.upload_gcode`. Defaults to {@link MAX_INFLATED_GCODE_BYTES}; tests
   * inject a tiny value to exercise the bomb-guard rejection without allocating
   * a real >64 MB payload.
   */
  maxInflatedGcodeBytes?: number;
}

const CONFIG_GATE_AUTO_UPLOAD = "auto_upload_artifacts";
const CONFIG_GATE_AGENT_PRINT = "allow_agent_initiated_print";

const PREREQ_MISSING_MESSAGE =
  "moonrakerBaseUrl not configured — set config via the host plugin settings UI.";

const FLASHFORGE_PREREQ_MISSING_MESSAGE =
  "FlashForge transport not configured — set flashforgeBaseUrl, " +
  "flashforgeSerialNumber and flashforgeCheckCodeRef via the host plugin settings UI.";

/** Tool-shaped `prerequisite_missing` payload (matches the CAD plugin shape). */
function prerequisiteMissingToolResult(message: string = PREREQ_MISSING_MESSAGE): ToolResult {
  return {
    data: {
      error: "prerequisite_missing",
      message,
    },
  };
}

/** Action-side prerequisite-missing — thrown so the host surfaces it as an error. */
function prerequisiteMissingError(message: string = PREREQ_MISSING_MESSAGE): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = "prerequisite_missing";
  return err;
}

/**
 * virtual_sdcard path-traversal hardening (defense-in-depth, OWASP
 * A01). `klipper.upload_gcode`'s `path` is forwarded verbatim into Moonraker's
 * multipart upload `path` form field, so a value like `../../config` could try
 * to escape the gcodes root. The manifest + worker schema `pattern` already
 * allowlists `path` at the host validation layer; this worker-side re-check
 * means a missed or bypassed host validation still cannot push a traversal
 * sequence onto the wire. We REJECT (never sanitize) — silently rewriting a
 * path hides caller intent and can still surprise.
 *
 * Allowlist: 1-4 '/'-separated segments, each starting alphanumeric and ≤64
 * chars drawn from `[A-Za-z0-9._-]`. That structurally excludes a leading '/',
 * '..'/'.' segments, backslashes and NUL. Keep the regex equivalent to the
 * `path` schema `pattern` in src/manifest.ts and the worker registration above
 * (the manifest↔worker contract test guards the two schema copies; this
 * constant mirrors them as the runtime backstop).
 */
const UPLOAD_PATH_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$/;

/**
 * Worker-side `filename` backstop — the runtime mirror of the `filename`
 * schema `pattern` in src/manifest.ts and the worker registration. `filename`
 * is interpolated raw into the hand-rolled multipart `Content-Disposition` of
 * BOTH transports, so a missed or bypassed host-side schema validation must
 * not be able to push a quote, CR/LF, or NUL onto the wire (the same
 * defense-in-depth reasoning that produced `uploadPathError` for `path`).
 *
 * The explicit denylist branches run before the allowlist so the caller gets a
 * precise reason for the injection-relevant characters.
 */
const UPLOAD_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gcode$/;

/**
 * Hard cap on the base64-encoded payload accepted by the `upload_gcode`
 * ACTION (the printer page file picker sends bytes inline). 16 MB of
 * base64 decodes to 12 MB of g-code — the same order the tool path's
 * 10 MB attachment ceiling allows through the artifact store, and far
 * below anything the gunzip bomb guard would inflate further. Enforced on
 * the ENCODED length before any decode, so an oversized pick fails fast
 * without allocating the decoded buffer.
 */
const MAX_UPLOAD_ACTION_BASE64_BYTES = 16 * 1024 * 1024;

/**
 * Return a human-readable reason the `filename` is unsafe, or `null` when it
 * is an acceptable gcode filename.
 */
export function uploadFilenameError(filename: string): string | null {
  if (filename.includes("\0")) return "contains a NUL byte";
  if (filename.includes('"')) return "contains a double quote";
  if (/\r|\n/.test(filename)) return "contains a CR/LF line break";
  if (!UPLOAD_FILENAME_PATTERN.test(filename)) {
    return (
      "is not a safe gcode filename (allowed: 1-128 characters of " +
      "[A-Za-z0-9._-], starting alphanumeric, ending in .gcode)"
    );
  }
  return null;
}

/**
 * Return a human-readable reason the `path` is unsafe, or `null` when it is an
 * acceptable relative subdirectory. The explicit denylist branches run before
 * the allowlist so the caller gets a precise reason for the common bad cases.
 */
export function uploadPathError(path: string): string | null {
  if (path.includes("\0")) return "contains a NUL byte";
  if (path.includes("\\")) return "contains a backslash";
  if (path.startsWith("/")) return "must be a relative subdirectory (no leading '/')";
  if (path.includes("..")) return "contains a '..' traversal sequence";
  if (!UPLOAD_PATH_PATTERN.test(path)) {
    return (
      "is not a safe virtual_sdcard subdirectory (allowed: 1-4 '/'-separated " +
      "segments of [A-Za-z0-9._-], each starting alphanumeric)"
    );
  }
  return null;
}

/**
 * Re-read config from INSIDE a dispatch (executeTool) so the opt-in gate flags
 * resolve the dispatching company's own config rather than whatever was pinned
 * at setup() time — a single worker interleaving dispatches for two tenants
 * must never authorize a high-blast-radius tool (upload_gcode / start_print)
 * off a config value captured for the wrong company (or captured before any
 * company was scoped at all). A use-time read failure is logged at `error` and
 * returns `{}`, which makes the `=== true` gates fail CLOSED (deny) — the
 * failure is a loud, denied signal, never a silently-swallowed permissive
 * short-circuit. The physical MoonrakerClient/WS transport is a legitimate
 * setup-time singleton and is intentionally not rebuilt per dispatch.
 */
async function readLiveConfig(
  ctx: PluginContext,
  method: string,
): Promise<Partial<KlipperConfig>> {
  try {
    return ((await ctx.config.get()) ?? {}) as Partial<KlipperConfig>;
  } catch (err) {
    ctx.logger.error("klipper.config_read_failed", {
      plugin: "platform.klipper",
      method,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}


/**
 * One shared in-dispatch transport resolution for every tool handler.
 *
 * Order matters: resolve the dispatching company's transport from the LIVE
 * config FIRST (`ensureCredential` builds/converges the client even when the
 * worker holds no client at all, e.g. after a bare worker restart without a
 * config replay), and only THEN read the current client. `prerequisite_missing`
 * is decided from the live config, never from the boot-time client slot.
 */
type DispatchTransport =
  | { kind: "ready"; client: PrinterTransport }
  | { kind: "refused"; reason: string };

/**
 * `prerequisite_missing` message when the LIVE dispatch config cannot build
 * a transport (missing or invalid fields), else `null`. Pure (no host call),
 * so it runs before the opt-in gates exactly where the old client null-guard
 * did. Consulted ONLY when the worker holds no client: a held client keeps
 * the existing gate → validate → resolve order, and `ensureCredential`
 * refuses a bad live config there.
 */
function liveConfigMissingMessage(liveConfig: Partial<KlipperConfig>): string | null {
  const selection = selectTransport(liveConfig.transport);
  if (!selection.ok) return PREREQ_MISSING_MESSAGE;
  if (selection.kind === "flashforge") {
    return validateFlashForgeConfig(liveConfig).ok ? null : FLASHFORGE_PREREQ_MISSING_MESSAGE;
  }
  return typeof liveConfig.moonrakerBaseUrl === "string" &&
    liveConfig.moonrakerBaseUrl !== "" &&
    validateMoonrakerBaseUrl(liveConfig.moonrakerBaseUrl, liveConfig.moonrakerAllowedHosts).ok
    ? null
    : PREREQ_MISSING_MESSAGE;
}

async function resolveDispatchTransport(
  options: RpcSurfaceOptions,
  liveConfig: Partial<KlipperConfig>,
  method: string,
  dispatchCompanyId: string,
): Promise<DispatchTransport> {
  if (options.ensureCredential) {
    const cred = await options.ensureCredential(liveConfig, method, dispatchCompanyId);
    if (!cred.ok) return { kind: "refused", reason: cred.reason };
  }
  const client = options.getClient();
  if (!client) {
    return { kind: "refused", reason: "the printer transport is not available for this dispatch" };
  }
  return { kind: "ready", client };
}

/**
 * Caller-kind gate for the mutating actions (security condition C4).
 *
 * The actions bridge authenticates board users AND agent API keys, and the
 * worker is the only place that can tell them apart: the host hands every
 * action handler a frozen context whose `actor.type` distinguishes a human
 * board session ("user") from an agent key ("agent"). Board callers keep
 * tap-to-consent (a human pressing the button IS the consent signal); an
 * agent caller must additionally pass the SAME live-config opt-in flag the
 * corresponding tool enforces — re-read inside this dispatch, failing
 * closed on read errors — so a company agent (including one acting under
 * prompt injection) can never reach print controls or storage mutations
 * that bypass the tool gates.
 */
async function assertAgentActionGate(
  ctx: PluginContext,
  actionName: string,
  context: PluginPerformActionContext | undefined,
  gate: { flag: string; requires: boolean; what: string },
): Promise<void> {
  if ((context?.actor?.type ?? "system") !== "agent") return;
  const liveConfig = await readLiveConfig(ctx, actionName);
  const value = liveConfig[gate.flag as keyof KlipperConfig];
  if (value !== true) {
    throw new Error(
      `${actionName}: ${gate.what} requires the ${gate.flag} config flag to be set to true ` +
        "before agents may perform it (board users are unaffected).",
    );
  }
  void gate.requires;
}

/**
 * Camera actions are board-only by design (security condition C1): frames
 * must never reach agent keys. The camera surfaces are actions (not the
 * SSE stream bridge) because this host generation drops worker stream
 * emissions made outside a dispatch — the actions bridge is the existing
 * authenticated, company-scoped surface whose callers the worker can
 * gate by actor type.
 */
function assertBoardActor(
  context: PluginPerformActionContext | undefined,
  actionName: string,
): void {
  if ((context?.actor?.type ?? "system") === "agent") {
    throw new Error(
      `${actionName}: the printer camera is restricted to board users — agent keys cannot access it.`,
    );
  }
}

interface UploadGcodeCoreDeps {
  ctx: PluginContext;
  client: PrinterTransport;
  filename: string;
  /** Raw g-code bytes (plain or gzip-magic — inflated by the bomb guard). */
  bytes: Uint8Array;
  path?: string;
  maxInflatedGcodeBytes: number;
  /** Log/event label so tool and action failures are distinguishable. */
  source: "tool" | "action";
}

/**
 * Shared upload pipeline for the klipper.upload_gcode TOOL and the
 * upload_gcode ACTION (security condition C5): filename + path backstops,
 * transparent gzip inflation with the bomb guard, then the transport
 * upload. "Same policy layer" is CODE IDENTITY — the action delegates to
 * this function rather than re-typing the gates.
 */
/**
 * Filename + path backstops shared verbatim by the klipper.upload_gcode TOOL
 * (which runs them BEFORE the in-dispatch credential resolve, so a malformed
 * call never spends a resolve) and by {@link uploadGcodeCore} (defense at the
 * point of upload for both caller paths). Returns the refusal ToolResult, or
 * `null` when both targets are safe.
 */
function validateUploadInputs(
  ctx: PluginContext,
  filename: string,
  path: string | undefined,
  source: "tool" | "action",
): ToolResult | null {
  {
    const reason = uploadFilenameError(filename);
    if (reason !== null) {
      ctx.logger.warn("klipper.upload_gcode.filename_rejected", { filename, reason, source });
      return { error: `upload_gcode: refused — filename ${reason}.` };
    }
  }
  if (typeof path === "string" && path.length > 0) {
    const reason = uploadPathError(path);
    if (reason !== null) {
      ctx.logger.warn("klipper.upload_gcode.path_rejected", { filename, path, reason, source });
      return { error: `upload_gcode: refused — path ${reason}.` };
    }
  }
  return null;
}

async function uploadGcodeCore(deps: UploadGcodeCoreDeps): Promise<ToolResult> {
  const { ctx, client, filename, path, maxInflatedGcodeBytes, source } = deps;
  let { bytes } = deps;
  {
    const early = validateUploadInputs(ctx, filename, path, source);
    if (early !== null) return early;
  }
  // Real prints only fit the 10 MB attachment store when gzipped, but the
  // printers need plain g-code. Transparently inflate gzip-magic
  // (0x1f 0x8b) artifacts; plain artifacts pass through untouched. The
  // bomb guard is enforced DURING inflation via `maxOutputLength` so a
  // malicious archive cannot balloon into memory.
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: maxInflatedGcodeBytes });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ERR_BUFFER_TOO_LARGE is thrown mid-inflation once the output would
      // cross the cap — the bomb guard fired. Any other error means the
      // artifact carried gzip magic but was not valid gzip.
      const bomb = code === "ERR_BUFFER_TOO_LARGE";
      ctx.logger.warn("klipper.upload_gcode.gunzip_failed", {
        filename,
        gzBytes: deps.bytes.length,
        maxInflatedGcodeBytes,
        code,
        bomb,
        source,
      });
      return {
        error: bomb
          ? `upload_gcode: refused — decompressed g-code exceeds the ` +
            `${maxInflatedGcodeBytes}-byte cap (possible gzip bomb).`
          : `upload_gcode: refused — artifact has gzip magic but could ` +
            `not be decompressed (${code ?? "unknown error"}).`,
      };
    }
    ctx.logger.info("klipper.upload_gcode.gunzip", {
      filename,
      gzBytes: deps.bytes.length,
      inflatedBytes: bytes.length,
      source,
    });
  }
  const result = await client.uploadGcode(filename, bytes, { path });
  return { data: result };
}

export function registerRpcSurface(
  ctx: PluginContext,
  options: RpcSurfaceOptions,
): void {
  const { config, camera } = options;
  const transportKind = config.transport === "flashforge" ? "flashforge" : "moonraker";
  // "Configured" means the transport config VALIDATES (same validators the
  // worker converges against) — a rejected value must report unconfigured,
  // not merely "a value is present".
  const configured =
    transportKind === "moonraker"
      ? config.moonrakerBaseUrl !== undefined &&
        config.moonrakerBaseUrl !== "" &&
        validateMoonrakerBaseUrl(config.moonrakerBaseUrl, config.moonrakerAllowedHosts).ok
      : validateFlashForgeConfig(config).ok;
  const prereqMessage =
    transportKind === "flashforge"
      ? FLASHFORGE_PREREQ_MISSING_MESSAGE
      : PREREQ_MISSING_MESSAGE;
  const maxInflatedGcodeBytes =
    options.maxInflatedGcodeBytes ?? MAX_INFLATED_GCODE_BYTES;

  // ── multi-company tenancy gate ─────────────────────────────────────────
  // The worker is shared by every company that configured the plugin
  // (multiCompanyConfig), but it holds ONE client + camera at a time. The
  // non-dispatch surfaces below must never serve another company's printer:
  // the invoking company comes from the host-authorized bridge scope (data:
  // `params.companyId`, injected by the SDK over caller params; actions:
  // `actionCtx.companyId`). A caller whose scope does not match the owner —
  // including an unscoped caller while an owner is set — gets the idle
  // shape (data) or `prerequisite_missing` (actions). Fail closed.
  const dataScope = (params: Record<string, unknown> | undefined): string | null =>
    typeof params?.companyId === "string" && params.companyId.length > 0
      ? params.companyId
      : null;
  const actionScope = (
    actionCtx: PluginPerformActionContext | undefined,
  ): string | null => actionCtx?.companyId ?? actionCtx?.actor?.companyId ?? null;
  const ownerAllows = (owner: string | null, scope: string | null): boolean =>
    owner === null || scope === owner;
  const clientFor = (scope: string | null): PrinterTransport | null => {
    const owner = options.getClientOwnerCompanyId?.() ?? null;
    if (!ownerAllows(owner, scope)) {
      ctx.logger.warn("klipper.tenancy.client_denied", {
        pluginId: "platform.klipper",
        scoped: scope !== null,
      });
      return null;
    }
    return options.getClient();
  };
  const configAllows = (scope: string | null): boolean =>
    ownerAllows(options.getConfigOwnerCompanyId?.() ?? null, scope);
  const cameraFor = (scope: string | null): CameraFeed | null =>
    camera && configAllows(scope) ? camera : null;

  // ── ctx.data ────────────────────────────────────────────────────────────
  // Always register the data keys (the page slot expects them to exist even
  // when the worker came up without config). When the client is absent we
  // return safe defaults so the UI can render the needs-config placeholder.
  ctx.data.register("config", async (params: Record<string, unknown>) => {
    if (!configAllows(dataScope(params))) {
      // Another company's config: report unconfigured, leak nothing.
      return { configured: false, moonrakerBaseUrl: null, cameraConfigured: false };
    }
    // Moonraker / unset transport: exactly the legacy two-field shape.
    // FlashForge: same base fields plus the transport identity so the UI
    // can name the configured printer host.
    const base = {
      configured,
      moonrakerBaseUrl:
        configured && transportKind === "moonraker" ? config.moonrakerBaseUrl : null,
      /** Camera section availability (validated flashforgeCameraBaseUrl). */
      cameraConfigured: camera !== null,
    };
    if (transportKind === "flashforge") {
      return {
        ...base,
        transport: "flashforge" as const,
        flashforgeBaseUrl: configured ? config.flashforgeBaseUrl ?? null : null,
      };
    }
    return base;
  });

  /**
   * Merge the worker-level "credential not resolved yet" signal into a
   * status snapshot. The fail-closed idle state must be OBSERVABLE — a
   * bare stale snapshot would read like a healthy-but-idle printer.
   */
  const withDegradedReason = (
    snapshot: MoonrakerStatusSnapshot,
  ): MoonrakerStatusSnapshot & { degraded?: boolean; degradedReason?: string } => {
    const reason = options.getDegradedReason?.() ?? null;
    return reason === null
      ? snapshot
      : { ...snapshot, degraded: true, degradedReason: reason };
  };

  // `usePluginData("status")` reads the cached snapshot. We do not block on
  // a fresh /printer/info call — the WS subscription / poll loop keeps the
  // snapshot warm and the UI can call the `refresh` action to force a
  // refetch. This surface NEVER resolves credentials (it runs outside
  // dispatches): before the first credentialed dispatch it reports the
  // degraded reason instead.
  ctx.data.register("status", async (params: Record<string, unknown>) => {
    const client = clientFor(dataScope(params));
    if (!client) {
      return {
        connection: { state: "idle", attempts: 0, configured: false },
        objects: null,
      };
    }
    return withDegradedReason(client.getStatusSnapshot());
  });

  ctx.data.register("connection", async (params: Record<string, unknown>) => {
    const client = clientFor(dataScope(params));
    if (!client) return { state: "idle", attempts: 0, configured: false };
    return client.getConnectionState();
  });

  ctx.data.register("files", async (params: Record<string, unknown>) => {
    const client = clientFor(dataScope(params));
    if (!client) return [];
    const root = typeof params.root === "string" ? params.root : "gcodes";
    return client.listFiles(root);
  });

  ctx.data.register("file_metadata", async (params: Record<string, unknown>) => {
    const client = clientFor(dataScope(params));
    if (!client) throw prerequisiteMissingError(prereqMessage);
    const filename = typeof params.filename === "string" ? params.filename : "";
    if (!filename) throw new Error("file_metadata requires `filename`");
    return client.getFileMetadata(filename);
  });

  // ── ctx.actions ─────────────────────────────────────────────────────────
  // Actions are UI-initiated mutations / fresh fetches. They reuse the same
  // MoonrakerClient instance — no duplicated transport. When config is
  // missing they throw `prerequisite_missing` so the host surfaces a
  // structured error to the caller.
  // NOTE: actions run OUTSIDE dispatches — they consume the client-held
  // credential only and NEVER resolve (the client throws its
  // "credential not resolved yet" error while the transport is dormant).
  ctx.actions.register("refresh", async (_params, actionCtx) => {
    const client = clientFor(actionScope(actionCtx));
    if (!client) throw prerequisiteMissingError(prereqMessage);
    const info = await client.getPrinterInfo();
    return { ok: true, info, snapshot: client.getStatusSnapshot() };
  });

  ctx.actions.register(
    "pause_print",
    async (_params, actionCtx) => {
      await assertAgentActionGate(ctx, "pause_print", actionCtx, {
        flag: CONFIG_GATE_AGENT_PRINT,
        requires: true,
        what: "pausing a print",
      });
      const client = clientFor(actionScope(actionCtx));
      if (!client) throw prerequisiteMissingError(prereqMessage);
      const result = await client.pausePrint();
      return { ok: true, result };
    },
  );

  ctx.actions.register(
    "resume_print",
    async (_params, actionCtx) => {
      await assertAgentActionGate(ctx, "resume_print", actionCtx, {
        flag: CONFIG_GATE_AGENT_PRINT,
        requires: true,
        what: "resuming a print",
      });
      const client = clientFor(actionScope(actionCtx));
      if (!client) throw prerequisiteMissingError(prereqMessage);
      const result = await client.resumePrint();
      return { ok: true, result };
    },
  );

  ctx.actions.register(
    "cancel_print",
    async (_params, actionCtx) => {
      await assertAgentActionGate(ctx, "cancel_print", actionCtx, {
        flag: CONFIG_GATE_AGENT_PRINT,
        requires: true,
        what: "cancelling a print",
      });
      const client = clientFor(actionScope(actionCtx));
      if (!client) throw prerequisiteMissingError(prereqMessage);
      const result = await client.cancelPrint();
      return { ok: true, result };
    },
  );

  // UI-initiated print start. A user tapping Start in the page is its own
  // consent signal (tap-to-consent, unchanged); an AGENT caller must pass
  // the same live `allow_agent_initiated_print` gate the tool enforces
  // (security condition C4 — agent keys can reach the actions bridge).
  ctx.actions.register(
    "start_print",
    async (params: Record<string, unknown>, actionCtx) => {
      await assertAgentActionGate(ctx, "start_print", actionCtx, {
        flag: CONFIG_GATE_AGENT_PRINT,
        requires: true,
        what: "starting a print",
      });
      const client = clientFor(actionScope(actionCtx));
      if (!client) throw prerequisiteMissingError(prereqMessage);
      const filename = typeof params.filename === "string" ? params.filename : "";
      if (!filename) throw new Error("start_print requires `filename`");
      const result = await client.startPrint(filename);
      return { ok: true, result };
    },
  );

  // Deleting files is a storage mutation — agents must pass the same
  // live `auto_upload_artifacts` opt-in that gates agent uploads (the
  // write-side flag for printer storage); board callers unaffected.
  ctx.actions.register(
    "delete_file",
    async (params: Record<string, unknown>, actionCtx) => {
      await assertAgentActionGate(ctx, "delete_file", actionCtx, {
        flag: CONFIG_GATE_AUTO_UPLOAD,
        requires: true,
        what: "deleting printer files",
      });
      const client = clientFor(actionScope(actionCtx));
      if (!client) throw prerequisiteMissingError(prereqMessage);
      const path = typeof params.path === "string" ? params.path : "";
      if (!path) throw new Error("delete_file requires `path`");
      const root = typeof params.root === "string" ? params.root : "gcodes";
      const result = await client.deleteFile(path, root);
      return { ok: true, item: result.item };
    },
  );

  ctx.actions.register("retry_connection", async (_params, actionCtx) => {
    const client = clientFor(actionScope(actionCtx));
    if (!client) throw prerequisiteMissingError(prereqMessage);
    await client.retryConnection();
    return { ok: true, connection: client.getConnectionState() };
  });

  // ── camera actions (board-only; security conditions C1/C4) ───────────
  // Pull-based delivery: the page opens the feed when the camera section
  // becomes visible, polls camera_next while it is shown, and the feed
  // closes itself after the idle timeout when nobody is watching. This
  // keeps ONE upstream connection to the printer's single-viewer camera,
  // never queues frames (keep-latest slot), and never serves frames to
  // agent keys.
  const cameraPrereqError = (): Error =>
    prerequisiteMissingError(
      "Camera not configured — set flashforgeCameraBaseUrl in the plugin settings to enable the printer page camera.",
    );

  ctx.actions.register(
    "camera_open",
    async (_params, actionCtx) => {
      assertBoardActor(actionCtx, "camera_open");
      const camera = cameraFor(actionScope(actionCtx));
      if (!camera) throw cameraPrereqError();
      const connection = camera.open();
      return { ok: true, connection };
    },
  );

  ctx.actions.register(
    "camera_next",
    async (_params, actionCtx) => {
      assertBoardActor(actionCtx, "camera_next");
      const camera = cameraFor(actionScope(actionCtx));
      if (!camera) throw cameraPrereqError();
      // Every poll refreshes the idle clock — this IS the viewer heartbeat.
      camera.touch();
      const snap = camera.snapshot();
      return {
        ok: true,
        state: snap.state,
        attempts: snap.attempts,
        lastError: snap.lastError ?? null,
        nextRetryInMs: snap.nextRetryInMs ?? null,
        frame: snap.frame
          ? {
              jpegBase64: Buffer.from(snap.frame.bytes).toString("base64"),
              capturedAt: snap.frame.capturedAt,
            }
          : null,
        staleMs: Number.isFinite(snap.staleMs) ? snap.staleMs : null,
      };
    },
  );

  ctx.actions.register("camera_close", async (_params, actionCtx) => {
    // Closing is safe for any actor — it only releases the printer's
    // camera slot; no frames are served by this action.
    const camera = cameraFor(actionScope(actionCtx));
    if (!camera) return { ok: true, connection: null };
    camera.close("page_closed");
    return { ok: true };
  });

  ctx.actions.register(
    "camera_retry",
    async (_params, actionCtx) => {
      assertBoardActor(actionCtx, "camera_retry");
      const camera = cameraFor(actionScope(actionCtx));
      if (!camera) throw cameraPrereqError();
      const connection = camera.retry();
      return { ok: true, connection };
    },
  );

  // ── upload_gcode ACTION (the printer page file picker; condition C5) ──
  // Delegates to the SAME uploadGcodeCore as the tool — filename/path
  // backstops, gunzip bomb guard, transport upload are code-identical.
  // Agents must additionally pass the live auto_upload_artifacts gate;
  // board users keep tap-to-consent.
  ctx.actions.register(
    "upload_gcode",
    async (params: Record<string, unknown>, actionCtx) => {
      await assertAgentActionGate(ctx, "upload_gcode", actionCtx, {
        flag: CONFIG_GATE_AUTO_UPLOAD,
        requires: true,
        what: "uploading g-code files",
      });
      // Actions run OUTSIDE dispatches: they use the current client and
      // NEVER resolve — a dormant transport surfaces its own
      // "credential not resolved yet" error to the page.
      const client = clientFor(actionScope(actionCtx));
      if (!client) throw prerequisiteMissingError(prereqMessage);
      const filename = typeof params.filename === "string" ? params.filename : "";
      const gcodeBase64 = typeof params.gcodeBase64 === "string" ? params.gcodeBase64 : "";
      const path = typeof params.path === "string" ? params.path : undefined;
      if (!filename) throw new Error("upload_gcode requires `filename`");
      if (!gcodeBase64) throw new Error("upload_gcode requires `gcodeBase64`");
      if (gcodeBase64.length > MAX_UPLOAD_ACTION_BASE64_BYTES) {
        throw new Error(
          `upload_gcode: refused — inline payload exceeds the ` +
            `${MAX_UPLOAD_ACTION_BASE64_BYTES}-byte base64 cap.`,
        );
      }
      if (!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(gcodeBase64) || gcodeBase64.length % 4 !== 0) {
        throw new Error("upload_gcode: refused — gcodeBase64 is not valid base64.");
      }
      const bytes = new Uint8Array(Buffer.from(gcodeBase64, "base64"));
      // Actions surface refusals by THROWING (the bridge propagates the
      // message and the page shows it verbatim) — unlike tools, whose
      // { error } ToolResults are for agent conversations.
      const result = await uploadGcodeCore({
        ctx,
        client,
        filename,
        bytes,
        path,
        maxInflatedGcodeBytes,
        source: "action",
      });
      if (result && typeof result === "object" && "error" in result && result.error) {
        throw new Error(result.error);
      }
      return result;
    },
  );

  // ── ctx.tools ───────────────────────────────────────────────────────────
  // Each tool maps to a MoonrakerClient call and gates on the relevant
  // opt-in config flag. The host does NOT auto-namespace tool names by
  // manifest id — the name passed to `ctx.tools.register(name, …)` must
  // equal `manifest.tools[].name` verbatim (e.g. `klipper.upload_gcode`).
  // `tests/contract/manifest-worker.test.ts` enforces this.
  ctx.tools.register(
    "klipper.get_printer_status",
    {
      displayName: "Klipper Get Printer Status",
      description:
        "Return the latest printer status snapshot (state, temperatures, " +
        "progress, active job) from the configured transport — Moonraker or " +
        "the FlashForge LAN-only HTTP API.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async (_params, runCtx): Promise<ToolResult> => {
      // Resolve the DISPATCHING company's transport (the worker is shared
      // by every company; the held client may be another company's idle
      // boot client, or absent after a bare restart). Read-only: the
      // resolution only starts the status/poll loop, never an upload,
      // print or delete call.
      const liveConfig = await readLiveConfig(ctx, "get_printer_status");
      const missing = options.getClient() === null ? liveConfigMissingMessage(liveConfig) : null;
      if (missing !== null) return prerequisiteMissingToolResult(missing);
      const t = await resolveDispatchTransport(
        options,
        liveConfig,
        "get_printer_status",
        runCtx.companyId,
      );
      if (t.kind === "refused") {
        // Soft failure: no throw. The held client is NOT this company's
        // verified transport, so its snapshot is never returned here
        // (that would expose another company's printer state).
        return {
          data: {
            objects: null,
            updatedAt: null,
            connection: { state: "idle", attempts: 0 },
            degraded: true,
            degradedReason: t.reason,
          },
        };
      }
      try {
        return { data: withDegradedReason(t.client.getStatusSnapshot()) };
      } catch (err) {
        return toolError(err, "get_printer_status");
      }
    },
  );

  ctx.tools.register(
    "klipper.upload_gcode",
    {
      displayName: "Klipper Upload G-code",
      description:
        "Upload a G-code artifact to the printer's virtual_sdcard. The worker " +
        "resolves `artifactId` via `runCtx.artifacts.fetch` and streams the " +
        "bytes straight to Moonraker — callers never base64-encode the " +
        "payload through tool arguments. Gated on `auto_upload_artifacts`.",
      parametersSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.gcode$",
          },
          artifactId: {
            type: "string",
            format: "uuid",
            description:
              "Paperclip attachment UUID to upload. Resolved server-side via " +
              "the dispatching agent's identity; the plugin worker " +
              "never sees the bytes inline.",
          },
          path: {
            type: "string",
            // Allowlist a relative virtual_sdcard subdirectory — 1-4
            // '/'-separated segments of [A-Za-z0-9._-], each starting
            // alphanumeric. Structurally rejects a leading '/', '..'/'.'
            // segments, backslashes and NUL so a caller cannot traverse out of
            // the gcodes root. The worker re-validates (defense-in-depth).
            pattern:
              "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$",
            description:
              "Optional virtual_sdcard subdirectory. Relative path of 1-4 " +
              "segments (no leading '/', no '..'); e.g. \"prints\" or " +
              "\"prints/today\".",
          },
        },
        required: ["filename", "artifactId"],
        additionalProperties: false,
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      // Re-read config live on every dispatch — never gate off the value
      // captured at setup(). Fails closed if the read errors. The client
      // null-guard runs AFTER the in-dispatch resolution below (a bare
      // restart leaves no client, but the live config can build one).
      const liveConfig = await readLiveConfig(ctx, "upload_gcode");
      const missing = options.getClient() === null ? liveConfigMissingMessage(liveConfig) : null;
      if (missing !== null) return prerequisiteMissingToolResult(missing);
      if (liveConfig.auto_upload_artifacts !== true) {
        return {
          error:
            `auto_upload_artifacts is false; the ${CONFIG_GATE_AUTO_UPLOAD} ` +
            "config flag must be set to true before uploads are allowed.",
        };
      }
      try {
        const { filename, artifactId, path } = params as {
          filename: string;
          artifactId: string;
          path?: string;
        };
        // C5 shared pipeline (with the upload_gcode ACTION) + F5 ordering:
        // local validation runs FIRST so a malformed call never spends a
        // resolve or starts the dormant transport.
        const earlyRefusal = validateUploadInputs(ctx, filename, path, "tool");
        if (earlyRefusal !== null) return earlyRefusal;
        // Lazy credential resolution — INSIDE the dispatch (dispatch
        // attribution authorizes `secrets.resolve`). The resolution also
        // STARTS the dormant transport, so the first upload brings the
        // printer online.
        const t = await resolveDispatchTransport(
          options,
          liveConfig,
          "upload_gcode",
          runCtx.companyId,
        );
        if (t.kind === "refused") return { error: `upload_gcode: refused — ${t.reason}` };
        // The resolution may have converged (replaced) the client object;
        // the actual upload uses the CURRENT one.
        const active = t.client;
        // The host resolves the attachment under the dispatching agent's
        // identity; the worker never receives inline bytes on this path.
        // `artifacts` is typed optional on the current SDK generation: hosts
        // older than the injection behavior dispatch tools WITHOUT the
        // client, and dereferencing it here would crash the handler with a
        // TypeError instead of a reportable tool refusal.
        if (!runCtx.artifacts) {
          return {
            error:
              "upload_gcode: refused — the host did not provide the artifacts client for this dispatch (host upgrade required for artifact uploads)",
          };
        }
        const artifact = await runCtx.artifacts.fetch(artifactId);
        return await uploadGcodeCore({
          ctx,
          client: active,
          filename,
          bytes: artifact.bytes,
          path,
          maxInflatedGcodeBytes,
          source: "tool",
        });
      } catch (err) {
        return toolError(err, "upload_gcode");
      }
    },
  );

  ctx.tools.register(
    "klipper.start_print",
    {
      displayName: "Klipper Start Print",
      description:
        "Start a print of a previously uploaded G-code file. Gated on " +
        "`allow_agent_initiated_print`.",
      parametersSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.gcode$",
            description: "G-code filename to print (must already be uploaded).",
          },
        },
        required: ["filename"],
        additionalProperties: false,
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      // Re-read config live on every dispatch — never gate off the value
      // captured at setup(). Fails closed if the read errors. The client
      // null-guard runs AFTER the in-dispatch resolution below (a bare
      // restart leaves no client, but the live config can build one).
      const liveConfig = await readLiveConfig(ctx, "start_print");
      const missing = options.getClient() === null ? liveConfigMissingMessage(liveConfig) : null;
      if (missing !== null) return prerequisiteMissingToolResult(missing);
      if (liveConfig.allow_agent_initiated_print !== true) {
        return {
          error:
            `allow_agent_initiated_print is false; the ${CONFIG_GATE_AGENT_PRINT} ` +
            "config flag must be set to true before agents can initiate prints.",
        };
      }
      try {
        const { filename } = params as { filename: string };
        // Symmetric filename backstop: start_print forwards the filename to
        // the printer API verbatim (query param / JSON body), so the same
        // worker-side re-check applies before any client call.
        {
          const reason = uploadFilenameError(filename);
          if (reason !== null) {
            ctx.logger.warn("klipper.start_print.filename_rejected", {
              filename,
              reason,
            });
            return { error: `start_print: refused — filename ${reason}.` };
          }
        }
        // Lazy credential resolution — INSIDE the dispatch (see
        // upload_gcode). Gate + validation run first; a refused dispatch
        // never spends a resolve.
        const t = await resolveDispatchTransport(
          options,
          liveConfig,
          "start_print",
          runCtx.companyId,
        );
        if (t.kind === "refused") return { error: `start_print: refused — ${t.reason}` };
        const active = t.client;
        const result = await active.startPrint(filename);
        return { data: { ok: true, result } };
      } catch (err) {
        return toolError(err, "start_print");
      }
    },
  );
}

/**
 * Map MoonrakerClient errors to a structured ToolResult. We intentionally do
 * not echo `MoonrakerHttpError.body` back to the agent unredacted — Moonraker
 * error bodies are short and unlikely to contain secrets, but we still cap
 * the body to a sane length so a misbehaving server cannot stuff the agent
 * context window.
 */
function toolError(err: unknown, toolName: string): ToolResult {
  if (err instanceof FlashForgeCredentialPendingError) {
    return {
      error: `${toolName}: refused — ${CREDENTIAL_PENDING_MESSAGE}`,
      data: { error: "credential_pending" },
    };
  }
  if (err instanceof MoonrakerHttpError) {
    return {
      error: `${toolName}: ${err.message}`,
      data: { status: err.status, body: err.body?.slice(0, 1024) },
    };
  }
  if (err instanceof MoonrakerOutboundScopeError) {
    return { error: `${toolName}: refused — ${err.message}` };
  }
  if (err instanceof FlashForgeApiError) {
    return {
      error: `${toolName}: ${err.message}`,
      data: {
        status: err.status,
        envelopeCode: err.envelopeCode,
      },
    };
  }
  if (err instanceof FlashForgeOutboundScopeError) {
    return { error: `${toolName}: refused — ${err.message}` };
  }
  return {
    error: `${toolName}: ${err instanceof Error ? err.message : String(err)}`,
  };
}
