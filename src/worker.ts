import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  MoonrakerClient,
  type ConnectionStateSnapshot,
  type MoonrakerClientOptions,
  type MoonrakerStatusSnapshot,
} from "./worker/MoonrakerClient.js";
import {
  registerRpcSurface,
  type KlipperConfig,
} from "./worker/registerRpcSurface.js";
import { validateMoonrakerBaseUrl } from "./worker/validateMoonrakerBaseUrl.js";

/**
 * paperclip-klipper worker.
 *
 * PLA-475 wires the real MoonrakerClient (REST + WS, reconnect, RPC surface)
 * onto the ctx surfaces declared by the manifest. Earlier scaffold from
 * PLA-474 stayed stub-only; this revision replaces the stubs with the real
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
}

export interface KlipperWorker {
  /**
   * MoonrakerClient instance, or `null` when the worker started without
   * `moonrakerBaseUrl` set. Tool / action / data handlers must gate on
   * client presence and surface `prerequisite_missing` (mirroring the CAD
   * plugin pattern — see PLA-502/503).
   */
  client: MoonrakerClient | null;
  config: KlipperConfig;
}

/**
 * Build the worker wiring without going through the SDK runWorker bootstrap.
 * Exposed for tests so they can drive the MoonrakerClient on a mock Moonraker
 * fixture and assert on the ctx.data / ctx.actions / ctx.tools surface.
 */
export async function createKlipperWorker(
  ctx: PluginContext,
  options: CreateKlipperWorkerOptions = {},
): Promise<KlipperWorker> {
  const rawConfig = await ctx.config.get();
  const config = rawConfig as Partial<KlipperConfig>;
  const rawBaseUrl = config.moonrakerBaseUrl;
  if (!rawBaseUrl) {
    // Permissive init (PLA-502/503): worker initializes without
    // `moonrakerBaseUrl` so the host sees a healthy worker, `plugin install`
    // exits 0, and the page slot mounts. Tool / action / data handlers gate
    // on config presence at call time and return `prerequisite_missing`.
    // Mirrors the CAD plugin pattern.
    ctx.logger.warn(
      "paperclip-klipper starting without moonrakerBaseUrl — tool calls will return prerequisite_missing until config is set",
      { pluginId: "platform.klipper" },
    );
    registerRpcSurface(ctx, { config: config as KlipperConfig, client: null });
    return { client: null, config: config as KlipperConfig };
  }

  // Validate BEFORE the resolved `moonrakerApiKeyRef` credential ever
  // reaches a client wired to this value: WHATWG URL parse, reject
  // non-http(s) schemes, and enforce the (by default self-derived) host
  // allowlist. A value that fails validation must not crash worker setup —
  // fall back to the same permissive-init branch as a missing config, and
  // warn with the rejected *host* only (never the full value, never any
  // credential).
  const validated = validateMoonrakerBaseUrl(rawBaseUrl, config.moonrakerAllowedHosts);
  if (!validated.ok) {
    ctx.logger.warn(
      "paperclip-klipper rejected moonrakerBaseUrl — refusing to start the Moonraker client until this is fixed; tool calls will return prerequisite_missing",
      { pluginId: "platform.klipper", reason: validated.reason, host: validated.host },
    );
    registerRpcSurface(ctx, { config: config as KlipperConfig, client: null });
    return { client: null, config: config as KlipperConfig };
  }
  const baseUrl = validated.url.toString();

  ctx.logger.info("paperclip-klipper worker setup", {
    moonrakerBaseUrl: baseUrl,
    hasApiKeyRef: Boolean(config.moonrakerApiKeyRef),
    auto_upload_artifacts: config.auto_upload_artifacts === true,
    allow_agent_initiated_print: config.allow_agent_initiated_print === true,
  });

  const baseOptions: MoonrakerClientOptions = {
    baseUrl,
    apiKeyRef: config.moonrakerApiKeyRef,
    http: ctx.http,
    secrets: ctx.secrets,
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
  };

  const client = new MoonrakerClient({ ...baseOptions, ...(options.clientOverrides ?? {}) });

  registerRpcSurface(ctx, { config: config as KlipperConfig, client });

  // Real event handlers (auto-upload on artifact-produced, etc.) land in 6.5.
  ctx.events.on("issue.created", async (event) => {
    ctx.logger.debug("event observed (stub)", {
      eventType: "issue.created",
      entityId: event.entityId,
      todo: "real handlers land in 6.5",
    });
  });

  if (options.autoStart !== false) {
    // Open the WS connection in the background. A missing printer is a
    // degraded state, not a setup failure; the reconnect loop drives retries.
    client.start().catch((err) => {
      ctx.logger.warn("klipper.ws.initial_connect_failed", {
        error: String(err instanceof Error ? err.message : err),
      });
    });
  }

  return { client, config: config as KlipperConfig };
}

const plugin = definePlugin({
  async setup(ctx) {
    // Skip auto-start under Vitest so the PLA-474 scaffold tests don't try
    // to open a real WebSocket against a fake hostname. Tests that exercise
    // the WS path use `createKlipperWorker` directly with the mock server.
    const inVitest = process.env.VITEST === "true";
    await createKlipperWorker(ctx, { autoStart: !inVitest });
  },

  async onHealth() {
    return { status: "ok", message: "paperclip-klipper worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
