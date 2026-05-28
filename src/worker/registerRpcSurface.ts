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
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import {
  MoonrakerClient,
  MoonrakerHttpError,
  MoonrakerOutboundScopeError,
  type ConnectionStateSnapshot,
  type MoonrakerStatusSnapshot,
} from "./MoonrakerClient.js";

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
  moonrakerBaseUrl: string;
  moonrakerApiKeyRef?: string;
  auto_upload_artifacts?: boolean;
  allow_agent_initiated_print?: boolean;
}

export interface RpcSurfaceOptions {
  config: KlipperConfig;
  /**
   * MoonrakerClient or `null` when the worker started without
   * `moonrakerBaseUrl` configured. When `null`, every handler short-circuits
   * with a `prerequisite_missing` result rather than dereferencing the
   * client. See PLA-502/503 (permissive init, matches CAD pattern).
   */
  client: MoonrakerClient | null;
  /** Emit a status snapshot to the UI stream channel used by `usePluginStream`. */
  emitStreamSnapshot?: (snapshot: MoonrakerStatusSnapshot) => void;
  /** Emit a connection-state event to the UI stream channel. */
  emitStreamConnection?: (state: ConnectionStateSnapshot) => void;
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

/** Tool-shaped `prerequisite_missing` payload (matches the CAD plugin shape). */
function prerequisiteMissingToolResult(): ToolResult {
  return {
    data: {
      error: "prerequisite_missing",
      message: PREREQ_MISSING_MESSAGE,
    },
  };
}

/** Action-side prerequisite-missing — thrown so the host surfaces it as an error. */
function prerequisiteMissingError(): Error {
  const err = new Error(PREREQ_MISSING_MESSAGE);
  (err as Error & { code?: string }).code = "prerequisite_missing";
  return err;
}

export function registerRpcSurface(
  ctx: PluginContext,
  options: RpcSurfaceOptions,
): void {
  const { config, client } = options;
  const configured = client !== null && Boolean(config.moonrakerBaseUrl);
  const maxInflatedGcodeBytes =
    options.maxInflatedGcodeBytes ?? MAX_INFLATED_GCODE_BYTES;

  // ── ctx.data ────────────────────────────────────────────────────────────
  // Always register the data keys (the page slot expects them to exist even
  // when the worker came up without config). When the client is absent we
  // return safe defaults so the UI can render the needs-config placeholder.
  ctx.data.register("config", async () => {
    return {
      configured,
      moonrakerBaseUrl: configured ? config.moonrakerBaseUrl : null,
    };
  });

  // `usePluginData("status")` reads the cached snapshot. We do not block on
  // a fresh /printer/info call — the WS subscription keeps the snapshot warm
  // and the UI can call the `refresh` action to force a refetch.
  ctx.data.register("status", async () => {
    if (!client) {
      return {
        connection: { state: "idle", attempts: 0, configured: false },
        objects: null,
      };
    }
    return client.getStatusSnapshot();
  });

  ctx.data.register("connection", async () => {
    if (!client) return { state: "idle", attempts: 0, configured: false };
    return client.getConnectionState();
  });

  ctx.data.register("files", async (params: Record<string, unknown>) => {
    if (!client) return [];
    const root = typeof params.root === "string" ? params.root : "gcodes";
    return client.listFiles(root);
  });

  ctx.data.register("file_metadata", async (params: Record<string, unknown>) => {
    if (!client) throw prerequisiteMissingError();
    const filename = typeof params.filename === "string" ? params.filename : "";
    if (!filename) throw new Error("file_metadata requires `filename`");
    return client.getFileMetadata(filename);
  });

  // ── ctx.actions ─────────────────────────────────────────────────────────
  // Actions are UI-initiated mutations / fresh fetches. They reuse the same
  // MoonrakerClient instance — no duplicated transport. When config is
  // missing they throw `prerequisite_missing` so the host surfaces a
  // structured error to the caller.
  ctx.actions.register("refresh", async () => {
    if (!client) throw prerequisiteMissingError();
    const info = await client.getPrinterInfo();
    return { ok: true, info, snapshot: client.getStatusSnapshot() };
  });

  ctx.actions.register("pause_print", async () => {
    if (!client) throw prerequisiteMissingError();
    const result = await client.pausePrint();
    return { ok: true, result };
  });

  ctx.actions.register("resume_print", async () => {
    if (!client) throw prerequisiteMissingError();
    const result = await client.resumePrint();
    return { ok: true, result };
  });

  ctx.actions.register("cancel_print", async () => {
    if (!client) throw prerequisiteMissingError();
    const result = await client.cancelPrint();
    return { ok: true, result };
  });

  // UI-initiated print start. Intentionally NOT gated on
  // `allow_agent_initiated_print` — that flag covers agent tools; a user
  // tapping the Start button in the UI is its own consent signal.
  ctx.actions.register("start_print", async (params: Record<string, unknown>) => {
    if (!client) throw prerequisiteMissingError();
    const filename = typeof params.filename === "string" ? params.filename : "";
    if (!filename) throw new Error("start_print requires `filename`");
    const result = await client.startPrint(filename);
    return { ok: true, result };
  });

  ctx.actions.register("delete_file", async (params: Record<string, unknown>) => {
    if (!client) throw prerequisiteMissingError();
    const path = typeof params.path === "string" ? params.path : "";
    if (!path) throw new Error("delete_file requires `path`");
    const root = typeof params.root === "string" ? params.root : "gcodes";
    const result = await client.deleteFile(path, root);
    return { ok: true, item: result.item };
  });

  ctx.actions.register("retry_connection", async () => {
    if (!client) throw prerequisiteMissingError();
    await client.retryConnection();
    return { ok: true, connection: client.getConnectionState() };
  });

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
        "Return the latest Moonraker status snapshot (printer state, " +
        "temperatures, virtual_sdcard progress, display message).",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async (): Promise<ToolResult> => {
      if (!client) return prerequisiteMissingToolResult();
      try {
        const snapshot = client.getStatusSnapshot();
        return { data: snapshot };
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
              "the dispatching agent's identity (PLA-574); the plugin worker " +
              "never sees the bytes inline.",
          },
          path: {
            type: "string",
            description: "Optional virtual_sdcard subdirectory.",
          },
        },
        required: ["filename", "artifactId"],
        additionalProperties: false,
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      if (!client) return prerequisiteMissingToolResult();
      if (config.auto_upload_artifacts !== true) {
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
        // PLA-574: the host resolves the attachment under the dispatching
        // agent's identity. The worker never base64-decodes inline bytes.
        const artifact = await runCtx.artifacts.fetch(artifactId);
        // PLA-612: real prints only fit the 10 MB attachment store when
        // gzipped, but Moonraker needs the plain g-code. Transparently inflate
        // gzip-magic (0x1f 0x8b) artifacts; plain artifacts pass through
        // untouched. The bomb guard is enforced DURING inflation via
        // `maxOutputLength` so a malicious archive cannot balloon into memory.
        let bytes: Uint8Array = artifact.bytes;
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
          try {
            bytes = gunzipSync(bytes, { maxOutputLength: maxInflatedGcodeBytes });
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            // ERR_BUFFER_TOO_LARGE is thrown mid-inflation once the output
            // would cross the cap — the bomb guard fired. Any other error means
            // the artifact carried gzip magic but was not valid gzip.
            const bomb = code === "ERR_BUFFER_TOO_LARGE";
            ctx.logger.warn("klipper.upload_gcode.gunzip_failed", {
              filename,
              gzBytes: artifact.bytes.length,
              maxInflatedGcodeBytes,
              code,
              bomb,
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
            gzBytes: artifact.bytes.length,
            inflatedBytes: bytes.length,
          });
        }
        const result = await client.uploadGcode(filename, bytes, { path });
        return { data: result };
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
    async (params): Promise<ToolResult> => {
      if (!client) return prerequisiteMissingToolResult();
      if (config.allow_agent_initiated_print !== true) {
        return {
          error:
            `allow_agent_initiated_print is false; the ${CONFIG_GATE_AGENT_PRINT} ` +
            "config flag must be set to true before agents can initiate prints.",
        };
      }
      try {
        const { filename } = params as { filename: string };
        const result = await client.startPrint(filename);
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
  if (err instanceof MoonrakerHttpError) {
    return {
      error: `${toolName}: ${err.message}`,
      data: { status: err.status, body: err.body?.slice(0, 1024) },
    };
  }
  if (err instanceof MoonrakerOutboundScopeError) {
    return { error: `${toolName}: refused — ${err.message}` };
  }
  return {
    error: `${toolName}: ${err instanceof Error ? err.message : String(err)}`,
  };
}
