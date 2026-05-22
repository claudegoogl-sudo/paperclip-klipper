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
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import {
  MoonrakerClient,
  MoonrakerHttpError,
  MoonrakerOutboundScopeError,
  type ConnectionStateSnapshot,
  type MoonrakerStatusSnapshot,
} from "./MoonrakerClient.js";

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
  // opt-in config flag. Tool names are namespaced by manifest id, so the
  // SDK sees them as `platform.klipper.get_printer_status` etc.
  ctx.tools.register(
    "get_printer_status",
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
    "upload_gcode",
    {
      displayName: "Klipper Upload G-code",
      description:
        "Upload a G-code artifact to the printer's virtual_sdcard. Gated on " +
        "`auto_upload_artifacts`.",
      parametersSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          gcodeBase64: { type: "string" },
          path: { type: "string" },
        },
        required: ["filename", "gcodeBase64"],
        additionalProperties: false,
      },
    },
    async (params, _runCtx): Promise<ToolResult> => {
      if (!client) return prerequisiteMissingToolResult();
      if (config.auto_upload_artifacts !== true) {
        return {
          error:
            `auto_upload_artifacts is false; the ${CONFIG_GATE_AUTO_UPLOAD} ` +
            "config flag must be set to true before uploads are allowed.",
        };
      }
      try {
        const { filename, gcodeBase64, path } = params as {
          filename: string;
          gcodeBase64: string;
          path?: string;
        };
        const bytes = Uint8Array.from(Buffer.from(gcodeBase64, "base64"));
        const result = await client.uploadGcode(filename, bytes, { path });
        return { data: result };
      } catch (err) {
        return toolError(err, "upload_gcode");
      }
    },
  );

  ctx.tools.register(
    "start_print",
    {
      displayName: "Klipper Start Print",
      description:
        "Start a print of a previously uploaded G-code file. Gated on " +
        "`allow_agent_initiated_print`.",
      parametersSchema: {
        type: "object",
        properties: { filename: { type: "string" } },
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
