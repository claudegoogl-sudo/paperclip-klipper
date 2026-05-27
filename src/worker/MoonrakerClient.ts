/**
 * MoonrakerClient — REST + WebSocket transport for Moonraker (Klipper API
 * server). PLA-475 / Workstream 6.3.
 *
 * Owns:
 *   - All REST calls listed in PLA-475 (upload, metadata, list, print start/
 *     pause/cancel, delete, printer info, object queries).
 *   - A persistent WebSocket to /websocket that subscribes to the printer
 *     objects the dashboard widget renders (print_stats, extruder, heater_bed,
 *     display_status, virtual_sdcard).
 *   - Exponential-backoff reconnect with jitter (1s → 30s cap, ≥6 attempts
 *     before surfacing a "failed" state that requires a manual retry).
 *   - A connection-state stream so the UI can render disconnected/reconnecting
 *     banners via `usePluginStream`.
 *
 * Secret handling rules carried from the plan brief and acceptance:
 *   - The Moonraker API key is resolved per call via `ctx.secrets.resolve`.
 *   - Plaintext is never logged, cached beyond a single request, written to
 *     state, or echoed into the connection-state stream.
 *   - Outbound traffic is restricted to the configured base URL — every URL
 *     this client builds is checked against the base host before fetching.
 */
import { randomBytes } from "node:crypto";
import type {
  PluginHttpClient,
  PluginSecretsClient,
  PluginLogger,
} from "@paperclipai/plugin-sdk";

/** Subset of Moonraker printer objects the dashboard widget cares about. */
export const DEFAULT_SUBSCRIBED_OBJECTS = {
  print_stats: null,
  extruder: null,
  heater_bed: null,
  display_status: null,
  virtual_sdcard: null,
} as const;

export type SubscribedObjectName = keyof typeof DEFAULT_SUBSCRIBED_OBJECTS;

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export interface ConnectionStateSnapshot {
  state: ConnectionState;
  /** Reconnect attempts made since the last successful connect. */
  attempts: number;
  /**
   * Redacted reason string when `state` is `reconnecting` or `failed`. The
   * client guarantees this string contains no API-key material.
   */
  lastError?: string;
  /** Next reconnect delay in ms when `state` is `reconnecting`. */
  nextRetryInMs?: number;
}

export interface MoonrakerStatusSnapshot {
  /** Last raw `notify_status_update` payload merged into a single object. */
  objects: Record<string, Record<string, unknown>>;
  /** ISO timestamp of the last update applied. */
  updatedAt: string | null;
  /** Connection state at the time of the snapshot. */
  connection: ConnectionStateSnapshot;
  /** Cached printer info from /printer/info, if it has been fetched. */
  printerInfo?: PrinterInfo;
}

export interface PrinterInfo {
  state?: string;
  state_message?: string;
  hostname?: string;
  klipper_path?: string;
  python_path?: string;
  software_version?: string;
  cpu_info?: string;
  [extra: string]: unknown;
}

export interface FileMetadata {
  filename: string;
  size?: number;
  modified?: number;
  estimated_time?: number;
  filament_total?: number;
  filament_weight_total?: number;
  /** Base64 PNG thumbnails when Moonraker returns inline metadata. */
  thumbnails?: Array<{
    width: number;
    height: number;
    size: number;
    relative_path?: string;
    /** Inline base64 (Moonraker can return either inline or a relative_path). */
    data?: string;
  }>;
  [extra: string]: unknown;
}

export interface FileListEntry {
  path: string;
  modified?: number;
  size?: number;
  permissions?: string;
}

/** Backoff configuration for the WS reconnect loop. */
export interface ReconnectOptions {
  /** Initial delay (ms) — first reconnect waits this long. Default 1000. */
  initialDelayMs?: number;
  /** Cap on delay (ms). Default 30_000. */
  maxDelayMs?: number;
  /** Multiplier per attempt before applying jitter. Default 2. */
  multiplier?: number;
  /**
   * Maximum number of consecutive failed reconnect attempts before the
   * client surfaces a `failed` state. Plan brief says ≥6. Default 6.
   */
  maxAttempts?: number;
  /**
   * Jitter factor in [0, 1]. Final delay is `base * (1 - jitter + 2*jitter*rand())`,
   * i.e. ±`jitter` of the base. Default 0.2.
   */
  jitter?: number;
}

/**
 * Minimal WebSocket interface so tests can inject a fake implementation when
 * the host's native `WebSocket` is not available. Mirrors the WHATWG shape
 * Node 22 exposes globally as `WebSocket`.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface MoonrakerClientOptions {
  /** Base URL (e.g. `http://printer.lan` or `http://printer.lan:7125`). */
  baseUrl: string;
  /** Secret ref for the Moonraker API key. Optional for unauthenticated. */
  apiKeyRef?: string;
  http: PluginHttpClient;
  secrets: PluginSecretsClient;
  logger: PluginLogger;
  reconnect?: ReconnectOptions;
  /** Objects to subscribe to on connect. Defaults to the dashboard set. */
  subscribedObjects?: Record<string, unknown>;
  /** Notified on every connection-state transition. */
  onConnectionState?: (snapshot: ConnectionStateSnapshot) => void;
  /** Notified on every status update merged into the snapshot. */
  onStatus?: (snapshot: MoonrakerStatusSnapshot) => void;
  /**
   * Inject a WebSocket factory. Tests use this to point at the mock server
   * URL and (optionally) substitute an alternate WS implementation. In
   * production this defaults to the global `WebSocket` if available.
   */
  webSocketFactory?: WebSocketFactory;
  /** Random source for jitter. Defaults to Math.random. Tests pin to 0.5. */
  random?: () => number;
  /** Override the setTimeout used for backoff. Tests can pass a fake clock. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  multiplier: 2,
  maxAttempts: 6,
  jitter: 0.2,
};

const REDACTED = "[redacted]";

/**
 * Strip an API key from a URL or string. Defensive — we never *intend* to log
 * a URL that carries `?token=`, but if a thrown WebSocket error message echoes
 * the URL back to us we want the redaction to apply before the log line ships.
 */
export function redactApiKey(input: string): string {
  if (!input) return input;
  return input
    .replace(/([?&])token=[^&\s]+/gi, `$1token=${REDACTED}`)
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`);
}

/**
 * Build a sanitized URL safe for logging — drops query strings entirely and
 * keeps only protocol + host + path. We never need query material for logs.
 */
function safeLogUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return redactApiKey(rawUrl);
  }
}

export class MoonrakerOutboundScopeError extends Error {
  constructor(actual: string, expected: string) {
    super(
      `outbound request to host ${actual} is not permitted; configured Moonraker host is ${expected}`,
    );
    this.name = "MoonrakerOutboundScopeError";
  }
}

export class MoonrakerHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    public readonly body?: string,
  ) {
    super(`Moonraker ${status} ${statusText} for ${safeLogUrl(url)}`);
    this.name = "MoonrakerHttpError";
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponseSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface JsonRpcResponseError {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcResponseSuccess | JsonRpcResponseError;

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/**
 * MoonrakerClient. Construct once per worker; call `start()` to open the WS,
 * `stop()` to tear it down. REST methods may be called regardless of WS state.
 */
export class MoonrakerClient {
  private readonly baseUrl: URL;
  private readonly wsUrl: URL;
  private readonly reconnect: Required<ReconnectOptions>;
  private readonly subscribedObjects: Record<string, unknown>;
  private readonly random: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly webSocketFactory: WebSocketFactory;

  private connection: ConnectionStateSnapshot = { state: "idle", attempts: 0 };
  private status: MoonrakerStatusSnapshot = {
    objects: {},
    updatedAt: null,
    connection: { state: "idle", attempts: 0 },
  };
  private ws: WebSocketLike | null = null;
  private wsRpcId = 0;
  private pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private reconnectHandle: unknown = null;
  private stopped = false;

  constructor(private readonly opts: MoonrakerClientOptions) {
    this.baseUrl = new URL(opts.baseUrl);
    this.wsUrl = this.buildWsBaseUrl();
    this.reconnect = { ...DEFAULT_RECONNECT, ...(opts.reconnect ?? {}) };
    this.subscribedObjects = opts.subscribedObjects ?? { ...DEFAULT_SUBSCRIBED_OBJECTS };
    this.random = opts.random ?? Math.random;
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms) as unknown as object);
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.webSocketFactory =
      opts.webSocketFactory ?? defaultWebSocketFactory();
  }

  /** Current connection state, cheap to read. */
  getConnectionState(): ConnectionStateSnapshot {
    return { ...this.connection };
  }

  /** Current merged status snapshot. */
  getStatusSnapshot(): MoonrakerStatusSnapshot {
    return {
      ...this.status,
      connection: { ...this.connection },
      objects: { ...this.status.objects },
    };
  }

  // ── REST API ─────────────────────────────────────────────────────────────

  /** GET /printer/info. */
  async getPrinterInfo(): Promise<PrinterInfo> {
    const result = await this.requestJson<{ result: PrinterInfo }>(
      "GET",
      "/printer/info",
    );
    this.status.printerInfo = result.result;
    return result.result;
  }

  /** GET /printer/objects/query?objects=name=field1,field2&... */
  async queryObjects(
    objects: Record<string, string[] | null>,
  ): Promise<Record<string, Record<string, unknown>>> {
    const params = new URLSearchParams();
    for (const [name, fields] of Object.entries(objects)) {
      params.set(name, fields === null ? "" : fields.join(","));
    }
    const result = await this.requestJson<{
      result: { status: Record<string, Record<string, unknown>> };
    }>("GET", `/printer/objects/query?${params.toString()}`);
    return result.result.status;
  }

  /** GET /server/files/list?root=<root> */
  async listFiles(root = "gcodes"): Promise<FileListEntry[]> {
    const result = await this.requestJson<{ result: FileListEntry[] }>(
      "GET",
      `/server/files/list?root=${encodeURIComponent(root)}`,
    );
    return result.result;
  }

  /** GET /server/files/metadata?filename=<filename> */
  async getFileMetadata(filename: string): Promise<FileMetadata> {
    const result = await this.requestJson<{ result: FileMetadata }>(
      "GET",
      `/server/files/metadata?filename=${encodeURIComponent(filename)}`,
    );
    return result.result;
  }

  /**
   * POST /server/files/upload — multipart with `file` field.
   *
   * PLA-514: the plugin-sdk RPC channel does NOT preserve native fetch
   * behavior for `FormData` bodies. `worker-rpc-host` serializes any
   * non-string body via `String(body)` (yielding `"[object FormData]"`),
   * which destroys the multipart envelope and drops the auto-synthesized
   * `Content-Type: multipart/form-data; boundary=…` header. The result on
   * Moonraker is `HTTP 500 ParseFailedException: Missing Content-Type
   * header`.
   *
   * Fix: hand-roll the multipart body as a string and pass the matching
   * `Content-Type` header explicitly. Bytes flow through as a latin1-encoded
   * string so the SDK serializer is an identity pass-through; G-code is
   * printable ASCII so the latin1↔UTF-8 trip is lossless.
   *
   * The host enforces `http.outbound`; the worker enforces the host scope.
   */
  async uploadGcode(
    filename: string,
    payload: Uint8Array | Blob,
    options: { path?: string; root?: string } = {},
  ): Promise<{ item: { path: string; root: string; size: number; modified: number }; print_started?: boolean }> {
    const bytes: Uint8Array = payload instanceof Uint8Array
      ? payload
      : new Uint8Array(await payload.arrayBuffer());

    const boundary = `----paperclipFormBoundary${randomBytes(12).toString("hex")}`;
    const CRLF = "\r\n";
    // latin1 maps bytes 0x00-0xFF 1:1 into JS string code units, so the SDK's
    // `String(body)` serializer is a no-op for transport. The host writes the
    // string to the wire via Node's default UTF-8 encoder; G-code is ASCII,
    // which is identical under latin1 and UTF-8.
    const payloadStr = Buffer.from(bytes).toString("latin1");

    const parts: string[] = [];
    parts.push(`--${boundary}${CRLF}`);
    parts.push(
      `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`,
    );
    parts.push(`Content-Type: application/octet-stream${CRLF}${CRLF}`);
    parts.push(payloadStr);
    parts.push(CRLF);
    if (options.path) {
      parts.push(`--${boundary}${CRLF}`);
      parts.push(`Content-Disposition: form-data; name="path"${CRLF}${CRLF}`);
      parts.push(`${options.path}${CRLF}`);
    }
    if (options.root) {
      parts.push(`--${boundary}${CRLF}`);
      parts.push(`Content-Disposition: form-data; name="root"${CRLF}${CRLF}`);
      parts.push(`${options.root}${CRLF}`);
    }
    parts.push(`--${boundary}--${CRLF}`);
    const body = parts.join("");

    const result = await this.requestJson<{
      item: { path: string; root: string; size: number; modified: number };
      print_started?: boolean;
    }>("POST", "/server/files/upload", {
      body,
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    });
    return result;
  }

  /** POST /printer/print/start?filename=<filename> */
  async startPrint(filename: string): Promise<string> {
    const result = await this.requestJson<{ result: string }>(
      "POST",
      `/printer/print/start?filename=${encodeURIComponent(filename)}`,
    );
    return result.result;
  }

  /** POST /printer/print/pause */
  async pausePrint(): Promise<string> {
    const result = await this.requestJson<{ result: string }>(
      "POST",
      "/printer/print/pause",
    );
    return result.result;
  }

  /** POST /printer/print/resume */
  async resumePrint(): Promise<string> {
    const result = await this.requestJson<{ result: string }>(
      "POST",
      "/printer/print/resume",
    );
    return result.result;
  }

  /** POST /printer/print/cancel */
  async cancelPrint(): Promise<string> {
    const result = await this.requestJson<{ result: string }>(
      "POST",
      "/printer/print/cancel",
    );
    return result.result;
  }

  /** DELETE /server/files/<root>/<path> via delete_file endpoint. */
  async deleteFile(path: string, root = "gcodes"): Promise<{ item: { path: string; root: string } }> {
    const fullPath = `${root}/${path.replace(/^\/+/, "")}`;
    const result = await this.requestJson<{ item: { path: string; root: string } }>(
      "DELETE",
      `/server/files/${encodeURIComponent(fullPath).replace(/%2F/gi, "/")}`,
    );
    return result;
  }

  // ── WebSocket lifecycle ──────────────────────────────────────────────────

  /**
   * Open the WS connection and (re)subscribe to the configured objects.
   * Idempotent — calling start() twice is a no-op while a connection is live.
   */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("MoonrakerClient.start() called after stop()");
    }
    if (this.ws && this.connection.state === "connected") return;
    if (this.connection.state === "connecting") return;
    this.connection.attempts = 0;
    await this.connectOnce();
  }

  /** Tear down the WS connection and cancel any pending reconnect. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectHandle) {
      this.clearTimeoutFn(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "client stop");
      } catch {
        // best-effort close
      }
      this.ws = null;
    }
    this.setConnectionState({ state: "idle", attempts: 0 });
    for (const pending of this.pendingRpc.values()) {
      pending.reject(new Error("MoonrakerClient stopped"));
    }
    this.pendingRpc.clear();
  }

  /**
   * Manual retry path the UI exposes after the client surfaces `failed`.
   * Resets the attempt counter and tries again.
   */
  async retryConnection(): Promise<void> {
    if (this.stopped) {
      throw new Error("MoonrakerClient.retryConnection() called after stop()");
    }
    this.connection.attempts = 0;
    if (this.reconnectHandle) {
      this.clearTimeoutFn(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    await this.connectOnce();
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Resolve API key once and pass it to the caller. Caller is responsible for
   * NOT logging it. The string is held in a local for the lifetime of one
   * call and dropped on return.
   */
  private async resolveApiKey(): Promise<string | null> {
    if (!this.opts.apiKeyRef) return null;
    return this.opts.secrets.resolve(this.opts.apiKeyRef);
  }

  private async requestJson<T>(
    method: string,
    path: string,
    init: {
      // Mirrors `PluginHttpFetchBody` from the plugin SDK (fork.9+). The host
      // SDK only accepts string / binary / FormData bodies — not the broad DOM
      // `BodyInit` (which would include `URLSearchParams`, `Blob`, streams).
      body?: string | Uint8Array | ArrayBuffer | Buffer | FormData | null;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = this.scopedUrl(path);
    const apiKey = await this.resolveApiKey();
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.headers ?? {}),
    };
    if (apiKey) headers["X-Api-Key"] = apiKey;
    const requestInit = {
      method,
      headers,
      body: init.body ?? null,
    };
    // ── BEGIN api-key live window ───────────────────────────────────────
    let response: Response;
    try {
      response = await this.opts.http.fetch(url.toString(), requestInit);
    } catch (err) {
      this.opts.logger.warn("moonraker.request.fetch_error", {
        method,
        url: safeLogUrl(url.toString()),
        error: redactApiKey(String(err instanceof Error ? err.message : err)),
      });
      throw err;
    }
    // ── END api-key live window: do NOT reference `apiKey` past this point.
    if (!response.ok) {
      const text = await safeReadText(response);
      this.opts.logger.warn("moonraker.request.error_response", {
        method,
        url: safeLogUrl(url.toString()),
        status: response.status,
        statusText: response.statusText,
      });
      throw new MoonrakerHttpError(response.status, response.statusText, url.toString(), text);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(
        `Moonraker returned non-JSON response for ${safeLogUrl(url.toString())}: ${String(err)}`,
      );
    }
  }

  /**
   * Build a request URL relative to the configured base and assert the final
   * host matches. Throws `MoonrakerOutboundScopeError` if a caller smuggles
   * an absolute URL pointing at a different host.
   */
  private scopedUrl(path: string): URL {
    const url = new URL(path, this.baseUrl);
    if (url.host !== this.baseUrl.host || url.protocol !== this.baseUrl.protocol) {
      throw new MoonrakerOutboundScopeError(url.host, this.baseUrl.host);
    }
    return url;
  }

  /**
   * WS URL: same host as the base URL, with `http(s)` swapped for `ws(s)`.
   * The API key is appended at connection time inside `connectOnce()` — it is
   * NEVER stored on this URL object.
   */
  private buildWsBaseUrl(): URL {
    const wsUrl = new URL("/websocket", this.baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    return wsUrl;
  }

  private setConnectionState(next: Partial<ConnectionStateSnapshot> & { state: ConnectionState }): void {
    this.connection = {
      ...this.connection,
      ...next,
    };
    this.status.connection = { ...this.connection };
    try {
      this.opts.onConnectionState?.({ ...this.connection });
    } catch (err) {
      this.opts.logger.error("moonraker.connection.callback_error", {
        error: String(err instanceof Error ? err.message : err),
      });
    }
  }

  private setStatusObjects(update: Record<string, Record<string, unknown>>): void {
    const next = { ...this.status.objects };
    for (const [name, fields] of Object.entries(update)) {
      next[name] = { ...(next[name] ?? {}), ...fields };
    }
    this.status = {
      ...this.status,
      objects: next,
      updatedAt: new Date().toISOString(),
    };
    try {
      this.opts.onStatus?.(this.getStatusSnapshot());
    } catch (err) {
      this.opts.logger.error("moonraker.status.callback_error", {
        error: String(err instanceof Error ? err.message : err),
      });
    }
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    this.setConnectionState({ state: this.connection.attempts > 0 ? "reconnecting" : "connecting" });
    const apiKey = await this.resolveApiKey();
    const wsUrl = new URL(this.wsUrl.toString());
    if (apiKey) {
      wsUrl.searchParams.set("token", apiKey);
    }
    const urlForLog = safeLogUrl(this.wsUrl.toString());
    const ws = this.webSocketFactory(wsUrl.toString());
    this.ws = ws;
    // ── do not retain wsUrl beyond this point; the key string is on it.
    ws.addEventListener("open", () => {
      this.opts.logger.info("moonraker.ws.connected", { url: urlForLog });
      this.connection.attempts = 0;
      this.setConnectionState({ state: "connected", attempts: 0, lastError: undefined, nextRetryInMs: undefined });
      this.subscribeOnConnect().catch((err) => {
        this.opts.logger.error("moonraker.ws.subscribe_failed", {
          error: redactApiKey(String(err instanceof Error ? err.message : err)),
        });
      });
    });
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : (() => {
        try {
          return new TextDecoder().decode(event.data as ArrayBuffer);
        } catch {
          return "";
        }
      })();
      if (!raw) return;
      this.handleMessage(raw);
    });
    ws.addEventListener("close", (event) => {
      this.opts.logger.warn("moonraker.ws.closed", {
        url: urlForLog,
        code: event.code,
        reason: redactApiKey(event.reason ?? ""),
      });
      this.ws = null;
      this.scheduleReconnect(`closed code=${event.code ?? "?"}`);
    });
    ws.addEventListener("error", (event) => {
      const message = redactApiKey(String(event.message ?? "ws error"));
      this.opts.logger.warn("moonraker.ws.error", { url: urlForLog, error: message });
      // Some implementations fire `error` without a follow-up close. Force
      // a reconnect schedule here; if a close arrives later, `scheduleReconnect`
      // is idempotent against an existing pending timer.
      this.scheduleReconnect(message);
    });
  }

  private async subscribeOnConnect(): Promise<void> {
    const id = ++this.wsRpcId;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "printer.objects.subscribe",
      params: { objects: this.subscribedObjects },
    };
    await this.callWs(message);
  }

  /**
   * Send a JSON-RPC request and wait for a matching id response.
   */
  private async callWs(message: JsonRpcRequest, timeoutMs = 10_000): Promise<unknown> {
    if (!this.ws || this.connection.state !== "connected") {
      throw new Error("MoonrakerClient WS not connected");
    }
    const ws = this.ws;
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(message.id, { resolve, reject });
      const timer = this.setTimeoutFn(() => {
        if (this.pendingRpc.delete(message.id)) {
          reject(new Error(`MoonrakerClient WS rpc ${message.method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        this.clearTimeoutFn(timer);
        this.pendingRpc.delete(message.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.opts.logger.warn("moonraker.ws.bad_json", { length: raw.length });
      return;
    }
    if (isJsonRpcResponse(parsed)) {
      const pending = this.pendingRpc.get(parsed.id);
      if (pending) {
        this.pendingRpc.delete(parsed.id);
        if ("error" in parsed) {
          pending.reject(new Error(`Moonraker rpc error ${parsed.error.code}: ${parsed.error.message}`));
        } else {
          pending.resolve(parsed.result);
          // Subscribe response also carries the initial status snapshot under
          // `result.status` — merge so the dashboard has data immediately.
          const result = (parsed as JsonRpcResponseSuccess).result as
            | { status?: Record<string, Record<string, unknown>> }
            | undefined;
          if (result?.status) {
            this.setStatusObjects(result.status);
          }
        }
      }
      return;
    }
    if (isJsonRpcNotification(parsed)) {
      if (parsed.method === "notify_status_update" && Array.isArray(parsed.params)) {
        const [statusObj] = parsed.params as [Record<string, Record<string, unknown>> | undefined];
        if (statusObj) this.setStatusObjects(statusObj);
      }
      return;
    }
  }

  private scheduleReconnect(reasonRaw: string): void {
    if (this.stopped) return;
    if (this.reconnectHandle) return; // already pending
    const reason = redactApiKey(reasonRaw);
    this.connection.attempts += 1;
    if (this.connection.attempts > this.reconnect.maxAttempts) {
      this.setConnectionState({
        state: "failed",
        lastError: reason,
        nextRetryInMs: undefined,
      });
      this.opts.logger.error("moonraker.ws.reconnect_failed", {
        attempts: this.connection.attempts - 1,
        lastError: reason,
      });
      return;
    }
    const delay = this.computeBackoff(this.connection.attempts);
    this.setConnectionState({
      state: "reconnecting",
      lastError: reason,
      nextRetryInMs: delay,
    });
    this.opts.logger.info("moonraker.ws.reconnect_scheduled", {
      attempt: this.connection.attempts,
      delayMs: delay,
      reason,
    });
    this.reconnectHandle = this.setTimeoutFn(() => {
      this.reconnectHandle = null;
      this.connectOnce().catch((err) => {
        this.opts.logger.warn("moonraker.ws.reconnect_attempt_failed", {
          error: redactApiKey(String(err instanceof Error ? err.message : err)),
        });
        this.scheduleReconnect(String(err instanceof Error ? err.message : err));
      });
    }, delay);
  }

  private computeBackoff(attempt: number): number {
    const base = Math.min(
      this.reconnect.initialDelayMs * this.reconnect.multiplier ** (attempt - 1),
      this.reconnect.maxDelayMs,
    );
    const jitter = this.reconnect.jitter;
    if (jitter <= 0) return Math.round(base);
    const factor = 1 - jitter + 2 * jitter * this.random();
    return Math.round(base * factor);
  }
}

function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { jsonrpc?: string }).jsonrpc === "2.0" &&
    typeof (msg as { id?: unknown }).id === "number" &&
    (("result" in msg) || ("error" in msg))
  );
}

function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { jsonrpc?: string }).jsonrpc === "2.0" &&
    typeof (msg as { method?: unknown }).method === "string" &&
    !("id" in msg)
  );
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function defaultWebSocketFactory(): WebSocketFactory {
  return (url: string) => {
    const g = globalThis as { WebSocket?: new (url: string) => WebSocketLike };
    if (!g.WebSocket) {
      throw new Error(
        "MoonrakerClient: no global WebSocket constructor available — pass `webSocketFactory` explicitly (Node ≥22 required for the default).",
      );
    }
    return new g.WebSocket(url);
  };
}
