/**
 * FlashForgeClient — HTTP transport for FlashForge printers running the
 * closed FlashForge firmware (Creator 5 / Creator 5 Pro), driven through the
 * printer's *Network > LAN Only* mode.
 *
 * Endpoint shapes are derived from the community reference client
 * (GhostTypes/ff-5mp-api-py), not guessed:
 *   - POST /detail     — {serialNumber, checkCode} JSON body; full machine
 *                        state (status, temps, progress, job info).
 *   - POST /gcodeList  — {serialNumber, checkCode}; list of stored files.
 *   - POST /uploadGcode— multipart field `gcodeFile`; auth + upload metadata
 *                        carried in headers (serialNumber, checkCode,
 *                        fileSize, printNow, levelingBeforePrint, …).
 *   - POST /printGcode — {serialNumber, checkCode, fileName, …} JSON body.
 *   - POST /control    — {serialNumber, checkCode, payload:{cmd,args}} for
 *                        job control (jobCtl_cmd pause/continue/cancel).
 * Success envelope: HTTP 200 plus `code` 0 or 200.
 *
 * Security invariants (binding for this transport):
 *   - `allow_agent_initiated_print` stays default-deny; the RPC surface
 *     gates the agent tool. This class additionally hard-codes upload
 *     metadata so an upload can never imply a print: `printNow` is always
 *     "false" and `levelingBeforePrint` "false" — there is no code path
 *     that starts a print from upload.
 *   - The check code is a per-printer credential: resolved per call via
 *     `ctx.secrets.resolve`, never cached beyond one request, never logged.
 *     Request bodies carry it, so bodies are never logged either.
 *   - Outbound traffic is restricted to the configured base URL host —
 *     every URL this client builds is checked against the base host before
 *     fetching (mirrors MoonrakerClient.scopedUrl).
 *   - Health probing is fail-closed: probeHealth() issues a FRESH /detail
 *     request and reports unreachable on any failure — refused, timeout,
 *     5xx, non-JSON, or an error envelope. It never answers from cache.
 */
import { randomBytes } from "node:crypto";
import type {
  PluginHttpClient,
  PluginSecretsClient,
  PluginLogger,
} from "@paperclipai/plugin-sdk";
import { resolveSecretRef, type SecretRef } from "../secretRef.js";
import type {
  ConnectionStateSnapshot,
  FileListEntry,
  FileMetadata,
  MoonrakerStatusSnapshot,
  PrinterInfo,
} from "../MoonrakerClient.js";
import type {
  GcodeUploadResult,
  PrinterTransport,
  TransportHealthReport,
} from "./PrinterTransport.js";

/** Default FlashForge LAN-mode HTTP port when the base URL omits one. */
export const FLASHFORGE_DEFAULT_PORT = 8898;

const REDACTED = "[redacted]";

/**
 * Strip credential material from a string before it can reach a log line.
 * The check code travels in JSON bodies (`"checkCode":"…"`) and upload
 * headers (`checkCode: …`); this covers both spellings defensively.
 */
export function redactCheckCode(input: string): string {
  if (!input) return input;
  return input
    .replace(/("checkCode"\s*:\s*")[^"]+/gi, `$1${REDACTED}`)
    .replace(/(checkCode\s*[:=]\s*)[^\s,;"}]+/gi, `$1${REDACTED}`);
}

/** Sanitized URL for logging — protocol + host + path only, never a query. */
function safeLogUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return redactCheckCode(rawUrl);
  }
}

export class FlashForgeOutboundScopeError extends Error {
  constructor(actual: string, expected: string) {
    super(
      `outbound request to host ${actual} is not permitted; configured FlashForge host is ${expected}`,
    );
    this.name = "FlashForgeOutboundScopeError";
  }
}

export class FlashForgeApiError extends Error {
  constructor(
    /** HTTP status when the printer answered; 0 for transport failures. */
    public readonly status: number,
    /** Printer envelope `code` when present (non-0/200), else null. */
    public readonly envelopeCode: number | null,
    message: string,
    public readonly url?: string,
  ) {
    super(`FlashForge ${status}${envelopeCode !== null ? ` (code ${envelopeCode})` : ""}: ${message}`);
    this.name = "FlashForgeApiError";
  }
}

export interface FlashForgeDetail {
  /** Raw machine status string, e.g. "ready" | "printing" | "pause". */
  status?: string;
  name?: string;
  model?: string;
  pid?: number;
  firmwareVersion?: string;
  printFileName?: string;
  /** 0..1 float (reference multiplies by 100 for a percent). */
  printProgress?: number;
  /** Seconds remaining (firmware-counted while printing). */
  estimatedTime?: number;
  /** Seconds elapsed on the current job. */
  printDuration?: number;
  platTemp?: number;
  platTargetTemp?: number;
  rightTemp?: number;
  rightTargetTemp?: number;
  /** Per-tool nozzle temperatures (Creator 5 series); index 0 = tool 0. */
  nozzleTemps?: Array<number | null>;
  nozzleTargetTemps?: Array<number | null>;
  chamberTemp?: number | null;
  chamberTargetTemp?: number | null;
  printLayer?: number;
  targetPrintLayer?: number;
  doorStatus?: string;
  errorCode?: string;
  [extra: string]: unknown;
}

/** `/detail` response envelope. */
export interface FlashForgeDetailResponse {
  code: number;
  message?: string;
  detail?: FlashForgeDetail;
}

/** `/gcodeList` response envelope (Creator 5 answers bare file names). */
export interface FlashForgeGcodeListResponse {
  code: number;
  message?: string;
  gcodeList?: unknown;
}

export interface FlashForgeClientOptions {
  /** Base URL of the printer, e.g. `http://192.168.1.50:8898`. */
  baseUrl: string;
  /** Printer serial number — the LAN-mode Device ID (an identifier, not a secret). */
  serialNumber: string;
  /**
   * Secret ref for the per-printer check code credential — either the
   * legacy string shape or the object binding ref; passed to
   * `ctx.secrets.resolve` exactly as configured (fail closed if the host
   * cannot resolve it).
   */
  checkCodeRef: SecretRef;
  http: PluginHttpClient;
  secrets: PluginSecretsClient;
  logger: PluginLogger;
  /** Status poll interval while started. Default 10s. */
  pollIntervalMs?: number;
  /** Bound on a health probe before it is reported unreachable. Default 5s. */
  probeTimeoutMs?: number;
  /** Consecutive poll failures before surfacing `failed`. Default 6. */
  maxAttempts?: number;
  /** Notified on every connection-state transition. */
  onConnectionState?: (snapshot: ConnectionStateSnapshot) => void;
  /** Notified on every status snapshot refresh. */
  onStatus?: (snapshot: MoonrakerStatusSnapshot) => void;
  /** Override timers (tests). */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/** Firmware machine states → Klipper `print_stats.state` values the UI renders. */
export function mapMachineState(rawStatus: string | undefined): string {
  switch ((rawStatus ?? "").toLowerCase()) {
    case "printing":
    case "heating":
      return "printing";
    case "pausing":
    case "pause":
    case "paused":
      return "paused";
    case "cancel":
      return "cancelled";
    case "completed":
      return "complete";
    case "error":
      return "error";
    case "ready":
    case "busy":
    case "downloading":
    case "calibrate_doing":
      return "standby";
    default:
      // Unknown firmware value: surface it verbatim rather than guessing —
      // a wrong mapping here would misreport a live printer as idle.
      return rawStatus ?? "unknown";
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Map a `/detail` payload into the Moonraker-compatible snapshot shape. */
export function detailToSnapshotObjects(
  detail: FlashForgeDetail,
): MoonrakerStatusSnapshot["objects"] {
  const progress = num(detail.printProgress) ?? 0;
  const nozzleTemps = Array.isArray(detail.nozzleTemps) ? detail.nozzleTemps : null;
  const nozzleTargets = Array.isArray(detail.nozzleTargetTemps)
    ? detail.nozzleTargetTemps
    : null;
  const firstNozzle = nozzleTemps ? num(nozzleTemps[0]) : undefined;
  const firstNozzleTarget = nozzleTargets ? num(nozzleTargets[0]) : undefined;
  const objects: MoonrakerStatusSnapshot["objects"] = {
    print_stats: {
      state: mapMachineState(typeof detail.status === "string" ? detail.status : undefined),
      filename: typeof detail.printFileName === "string" ? detail.printFileName : "",
      print_duration: num(detail.printDuration) ?? 0,
      total_duration: num(detail.printDuration) ?? 0,
      info: {
        current_layer: num(detail.printLayer) ?? 0,
        total_layer: num(detail.targetPrintLayer) ?? 0,
      },
    },
    extruder: {
      temperature: firstNozzle ?? num(detail.rightTemp) ?? 0,
      target: firstNozzleTarget ?? num(detail.rightTargetTemp) ?? 0,
    },
    heater_bed: {
      temperature: num(detail.platTemp) ?? 0,
      target: num(detail.platTargetTemp) ?? 0,
    },
    virtual_sdcard: { progress },
    display_status: {
      message: typeof detail.status === "string" ? detail.status : "",
      progress,
    },
    flashforge: {
      machineState: typeof detail.status === "string" ? detail.status : "",
      name: typeof detail.name === "string" ? detail.name : "",
      model: typeof detail.model === "string" ? detail.model : "",
      firmwareVersion: typeof detail.firmwareVersion === "string" ? detail.firmwareVersion : "",
      estimatedTimeSeconds: num(detail.estimatedTime) ?? 0,
      doorOpen: detail.doorStatus === "open",
      errorCode: typeof detail.errorCode === "string" ? detail.errorCode : "",
    },
  };
  return objects;
}

function envelopeOk(code: unknown): boolean {
  return code === 0 || code === 200;
}

/**
 * Cap on printer-controlled envelope `message` text before it can reach an
 * error string that flows into ToolResults (and thus agent context windows).
 * Mirrors the Moonraker error-body cap in `toolError`. A hostile or MITM'd
 * printer must not be able to stuff the consumer's context.
 */
const MAX_ENVELOPE_MESSAGE_CHARS = 1024;

/**
 * FlashForgeClient. Construct once per worker; `start()` opens the poll
 * loop, `stop()` tears it down. REST methods may be called regardless of
 * poll state.
 */
export class FlashForgeClient implements PrinterTransport {
  readonly kind = "flashforge" as const;

  private readonly baseUrl: URL;
  private readonly serialNumber: string;
  private readonly checkCodeRef: SecretRef;
  private readonly http: PluginHttpClient;
  private readonly secrets: PluginSecretsClient;
  private readonly logger: PluginLogger;
  private readonly pollIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  private connection: ConnectionStateSnapshot = { state: "idle", attempts: 0 };
  private status: MoonrakerStatusSnapshot = {
    objects: {},
    updatedAt: null,
    connection: { state: "idle", attempts: 0 },
  };
  private printerInfo: PrinterInfo | null = null;
  private pollHandle: unknown = null;
  private stopped = false;
  private pollInFlight: Promise<void> | null = null;

  constructor(private readonly opts: FlashForgeClientOptions) {
    this.baseUrl = new URL(opts.baseUrl);
    this.serialNumber = opts.serialNumber;
    this.checkCodeRef = opts.checkCodeRef;
    this.http = opts.http;
    this.secrets = opts.secrets;
    this.logger = opts.logger;
    this.pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms) as unknown as object);
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  getConnectionState(): ConnectionStateSnapshot {
    return { ...this.connection };
  }

  getStatusSnapshot(): MoonrakerStatusSnapshot {
    return {
      ...this.status,
      connection: { ...this.connection },
      objects: { ...this.status.objects },
    };
  }

  async getPrinterInfo(): Promise<PrinterInfo> {
    const detail = await this.fetchDetail();
    this.printerInfo = this.detailToPrinterInfo(detail);
    return this.printerInfo;
  }

  /** FlashForge's LAN API exposes no object model — refuse with a clear error. */
  async queryObjects(
    _objects: Record<string, string[] | null>,
  ): Promise<Record<string, Record<string, unknown>>> {
    throw new Error("queryObjects is not supported by the flashforge transport");
  }

  /** FlashForge's LAN API has no per-file metadata endpoint. */
  async getFileMetadata(_filename: string): Promise<FileMetadata> {
    throw new Error("file_metadata is not supported by the flashforge transport");
  }

  /** FlashForge's LAN API has no file-delete endpoint. */
  async deleteFile(
    _path: string,
    _root?: string,
  ): Promise<{ item: { path: string; root: string } }> {
    throw new Error("delete_file is not supported by the flashforge transport");
  }

  async listFiles(_root?: string): Promise<FileListEntry[]> {
    // FlashForge exposes a single file space; the Moonraker `root` concept
    // does not apply and is deliberately ignored.
    const data = await this.requestJson<FlashForgeGcodeListResponse>("/gcodeList");
    this.assertEnvelope(data, "/gcodeList");
    const raw = data.gcodeList;
    if (!Array.isArray(raw)) return [];
    const entries: FileListEntry[] = [];
    for (const item of raw) {
      if (typeof item === "string" && item.length > 0) {
        entries.push({ path: item });
      } else if (item && typeof item === "object" && typeof (item as { gcodeFileName?: unknown }).gcodeFileName === "string") {
        entries.push({ path: (item as { gcodeFileName: string }).gcodeFileName });
      }
    }
    return entries;
  }

  /**
   * Upload G-code via POST /uploadGcode.
   *
   * The plugin-sdk RPC channel stringifies non-string bodies (see
   * MoonrakerClient.uploadGcode), so the multipart envelope is hand-rolled
   * with a latin1-encoded string and an explicit Content-Type, exactly like
   * the Moonraker upload. Field name is `gcodeFile` per the reference
   * client.
   *
   * SECURITY: `printNow` is hard-coded "false". There is no parameter, no
   * config flag, and no code path that makes an upload start a print —
   * starting a print is a separate, gated operation (startPrint).
   */
  async uploadGcode(
    filename: string,
    payload: Uint8Array | Blob,
    options: { path?: string; root?: string } = {},
  ): Promise<GcodeUploadResult> {
    if (options.path && options.path.length > 0) {
      throw new Error(
        "FlashForge upload does not support a subdirectory path; the printer has a single file space",
      );
    }
    const bytes: Uint8Array =
      payload instanceof Uint8Array ? payload : new Uint8Array(await payload.arrayBuffer());

    const boundary = `----paperclipFormBoundary${randomBytes(12).toString("hex")}`;
    const CRLF = "\r\n";
    const payloadStr = Buffer.from(bytes).toString("latin1");
    const parts: string[] = [];
    parts.push(`--${boundary}${CRLF}`);
    parts.push(
      `Content-Disposition: form-data; name="gcodeFile"; filename="${filename}"${CRLF}`,
    );
    parts.push(`Content-Type: application/octet-stream${CRLF}${CRLF}`);
    parts.push(payloadStr);
    parts.push(CRLF);
    parts.push(`--${boundary}--${CRLF}`);
    const body = parts.join("");

    const checkCode = await this.resolveCheckCode();
    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      // Header names/expected values mirror the reference client's upload.
      serialNumber: this.serialNumber,
      checkCode,
      fileSize: String(bytes.length),
      printNow: "false",
      levelingBeforePrint: "false",
      flowCalibration: "false",
      useMatlStation: "false",
      gcodeToolCnt: "0",
      // base64("[]") — empty material mapping list, per reference client.
      materialMappings: "W10=",
    };

    const url = this.scopedUrl("/uploadGcode");
    let response: Response;
    try {
      response = await this.http.fetch(url.toString(), { method: "POST", headers, body });
    } catch (err) {
      this.logger.warn("flashforge.upload.fetch_error", {
        method: "POST",
        url: safeLogUrl(url.toString()),
        error: redactCheckCode(String(err instanceof Error ? err.message : err)),
      });
      throw err;
    }
    const data = await this.readJson<FlashForgeGcodeListResponse>(response, url);
    if (!response.ok) {
      throw new FlashForgeApiError(
        response.status,
        typeof data?.code === "number" ? data.code : null,
        `upload failed for ${safeLogUrl(url.toString())}`,
        url.toString(),
      );
    }
    this.assertEnvelope(data, "/uploadGcode");
    this.logger.info("flashforge.upload.success", {
      transport: "flashforge",
      filename,
      size: bytes.length,
      // Explicit for audit readers: this transport never implies a print.
      printNow: false,
    });
    return {
      item: { path: filename, root: "flashforge", size: bytes.length, modified: 0 },
      print_started: false,
    };
  }

  /**
   * Start a print via POST /printGcode (Creator 5 always uses the
   * "new firmware" payload shape). Whether an AGENT may call this is gated
   * in the RPC surface (`allow_agent_initiated_print`, default-deny); the
   * UI action is operator-initiated consent.
   */
  async startPrint(filename: string): Promise<string> {
    const body = {
      fileName: filename,
      levelingBeforePrint: false,
      flowCalibration: false,
      useMatlStation: false,
      gcodeToolCnt: 0,
      materialMappings: [],
    };
    const data = await this.requestJson<{ code: number; message?: string }>("/printGcode", body);
    this.assertEnvelope(data, "/printGcode");
    return filename;
  }

  async pausePrint(): Promise<string> {
    return this.jobControl("pause");
  }

  async resumePrint(): Promise<string> {
    return this.jobControl("continue");
  }

  async cancelPrint(): Promise<string> {
    return this.jobControl("cancel");
  }

  // ── Poll lifecycle ──────────────────────────────────────────────────────

  /** Start polling /detail. Idempotent while a loop is live. */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("FlashForgeClient.start() called after stop()");
    }
    if (this.pollHandle) return;
    this.setConnectionState({ state: "connecting" });
    // First poll runs immediately; scheduleNext continues the loop unless
    // the very first poll already exhausted maxAttempts (failed).
    await this.pollOnce();
    if (!this.stopped && this.connection.state !== "failed") {
      this.scheduleNext();
    }
  }

  /**
   * Restart the poll loop after a `failed` state (the UI retry affordance).
   * A `failed` state stops the loop, mirroring MoonrakerClient — the
   * operator decides when to retry rather than the worker hammering a
   * dead printer forever.
   */
  async retryConnection(): Promise<void> {
    if (this.stopped) {
      throw new Error("FlashForgeClient.retryConnection() called after stop()");
    }
    if (this.pollHandle) return;
    this.setConnectionState({ state: "connecting", attempts: 0 });
    await this.pollOnce();
    if (!this.stopped && this.connection.state !== "failed") {
      this.scheduleNext();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.pollHandle) {
      this.clearTimeoutFn(this.pollHandle);
      this.pollHandle = null;
    }
    this.setConnectionState({ state: "idle", attempts: 0 });
  }

  /**
   * Fail-closed reachability probe. Issues a FRESH /detail request (never
   * the cached poll snapshot) and reports unreachable for refused /
   * timeout / 5xx / non-JSON / error-envelope outcomes. Never throws.
   */
  async probeHealth(): Promise<TransportHealthReport> {
    try {
      const detail = await this.withTimeout(this.fetchDetail(), this.probeTimeoutMs);
      const rawState = typeof detail.status === "string" ? detail.status : "unknown";
      return {
        reachable: true,
        // Raw firmware state — the same string the printer's own screen
        // shows, so an operator can correlate without a mapping table.
        message: `FlashForge printer reachable (machine state: ${rawState})`,
        details: {
          transport: "flashforge",
          machineState: typeof detail.status === "string" ? detail.status : "",
          model: typeof detail.model === "string" ? detail.model : "",
          firmwareVersion:
            typeof detail.firmwareVersion === "string" ? detail.firmwareVersion : "",
        },
      };
    } catch (err) {
      const message = err instanceof FlashForgeApiError
        ? `FlashForge printer answered with an error (${err.message})`
        : `FlashForge printer unreachable (${err instanceof Error ? err.message : String(err)})`;
      this.logger.warn("flashforge.health.probe_failed", {
        transport: "flashforge",
        error: redactCheckCode(String(err instanceof Error ? err.message : err)),
      });
      return { reachable: false, message, details: { transport: "flashforge" } };
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async jobControl(action: "pause" | "continue" | "cancel"): Promise<string> {
    const body = {
      payload: { cmd: "jobCtl_cmd", args: { jobID: "", action } },
    };
    const data = await this.requestJson<{ code: number; message?: string }>("/control", body);
    this.assertEnvelope(data, "/control");
    return action;
  }

  /** Resolve the check code per call; never cached, never logged. */
  private async resolveCheckCode(): Promise<string> {
    return resolveSecretRef(this.secrets, this.checkCodeRef);
  }

  /**
   * POST JSON to an endpoint with auth in the body (mirrors the reference
   * client). Bodies are never logged — they carry the check code.
   */
  private async requestJson<T>(path: string, extraBody?: Record<string, unknown>): Promise<T> {
    const checkCode = await this.resolveCheckCode();
    const url = this.scopedUrl(path);
    const body = JSON.stringify({
      serialNumber: this.serialNumber,
      checkCode,
      ...(extraBody ?? {}),
    });
    let response: Response;
    try {
      response = await this.http.fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
      });
    } catch (err) {
      this.logger.warn("flashforge.request.fetch_error", {
        method: "POST",
        url: safeLogUrl(url.toString()),
        error: redactCheckCode(String(err instanceof Error ? err.message : err)),
      });
      throw err;
    }
    const data = await this.readJson<T>(response, url);
    if (!response.ok) {
      throw new FlashForgeApiError(
        response.status,
        this.envelopeCodeOf(data),
        `request failed for ${safeLogUrl(url.toString())}`,
        url.toString(),
      );
    }
    return data;
  }

  /** GET the parsed JSON of a response; tolerate the firmware's misspelled content-type. */
  private async readJson<T>(response: Response, url: URL): Promise<T> {
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FlashForgeApiError(
        response.status,
        null,
        `non-JSON response from ${safeLogUrl(url.toString())}`,
        url.toString(),
      );
    }
  }

  private envelopeCodeOf(data: unknown): number | null {
    return data && typeof data === "object" && typeof (data as { code?: unknown }).code === "number"
      ? (data as { code: number }).code
      : null;
  }

  /** Assert the success envelope (HTTP-level status was already checked). */
  private assertEnvelope(data: { code?: unknown; message?: unknown }, path: string): void {
    if (!envelopeOk(data?.code)) {
      // The envelope `message` is printer-controlled text — cap it before it
      // becomes error output (context-stuffing guard, see MAX_ENVELOPE_MESSAGE_CHARS).
      const message = String(data?.message ?? "no message").slice(0, MAX_ENVELOPE_MESSAGE_CHARS);
      throw new FlashForgeApiError(
        200,
        this.envelopeCodeOf(data),
        `endpoint ${path} rejected the request (${message})`,
      );
    }
  }

  /** Fresh /detail fetch (used by the poll loop, getPrinterInfo and probeHealth). */
  private async fetchDetail(): Promise<FlashForgeDetail> {
    const data = await this.requestJson<FlashForgeDetailResponse>("/detail");
    this.assertEnvelope(data, "/detail");
    if (!data.detail || typeof data.detail !== "object") {
      throw new FlashForgeApiError(200, null, "/detail response carried no detail object");
    }
    return data.detail;
  }

  private detailToPrinterInfo(detail: FlashForgeDetail): PrinterInfo {
    return {
      state: mapMachineState(detail.status),
      state_message: typeof detail.errorCode === "string" ? detail.errorCode : "",
      hostname: typeof detail.name === "string" ? detail.name : "",
      software_version:
        typeof detail.firmwareVersion === "string" ? detail.firmwareVersion : "",
    };
  }

  /** One poll iteration: refresh the snapshot or advance the failure state. */
  private async pollOnce(): Promise<void> {
    try {
      const detail = await this.fetchDetail();
      this.printerInfo = this.detailToPrinterInfo(detail);
      const wasDown = this.connection.state !== "connected";
      this.status = {
        objects: detailToSnapshotObjects(detail),
        updatedAt: new Date().toISOString(),
        connection: { ...this.connection, state: "connected", attempts: 0 },
        printerInfo: this.printerInfo,
      };
      this.connection = { state: "connected", attempts: 0 };
      if (wasDown) {
        this.setConnectionState({ state: "connected", attempts: 0 });
      }
      this.opts.onStatus?.(this.getStatusSnapshot());
    } catch (err) {
      const attempts = this.connection.attempts + 1;
      const reason = redactCheckCode(String(err instanceof Error ? err.message : err));
      const state = attempts >= this.maxAttempts ? "failed" : "reconnecting";
      this.connection = {
        state,
        attempts,
        lastError: reason,
        ...(state === "reconnecting" ? { nextRetryInMs: this.pollIntervalMs } : {}),
      };
      this.status = { ...this.status, connection: { ...this.connection } };
      this.setConnectionState({ ...this.connection });
      this.logger.warn("flashforge.poll.failed", {
        transport: "flashforge",
        attempts,
        state,
        error: reason,
      });
    }
  }

  private scheduleNext(): void {
    if (this.stopped || this.pollHandle) return;
    this.pollHandle = this.setTimeoutFn(() => {
      this.pollHandle = null;
      // Serialize polls: a slow /detail must not stack a second request.
      this.pollInFlight = (this.pollInFlight ?? Promise.resolve())
        .then(() => this.pollOnce())
        .catch(() => undefined)
        .finally(() => {
          if (this.pollInFlight) this.pollInFlight = null;
          // `failed` stops the loop (see retryConnection); every other state
          // keeps polling so a printer that comes back self-heals.
          if (!this.stopped && this.connection.state !== "failed") {
            this.scheduleNext();
          }
        });
    }, this.pollIntervalMs);
  }

  private setConnectionState(
    next: Partial<ConnectionStateSnapshot> & { state: ConnectionStateSnapshot["state"] },
  ): void {
    this.connection = { ...this.connection, ...next };
    this.status = { ...this.status, connection: { ...this.connection } };
    try {
      this.opts.onConnectionState?.({ ...this.connection });
    } catch (err) {
      this.logger.debug("flashforge.connection_state.emit_failed", {
        error: String(err instanceof Error ? err.message : err),
      });
    }
  }

  /**
   * Build a request URL relative to the configured base and assert the final
   * host matches — mirrors MoonrakerClient.scopedUrl so the same
   * smuggling-proof host equality applies to this transport.
   */
  private scopedUrl(path: string): URL {
    const url = new URL(path, this.baseUrl);
    if (url.host !== this.baseUrl.host || url.protocol !== this.baseUrl.protocol) {
      throw new FlashForgeOutboundScopeError(url.host, this.baseUrl.host);
    }
    return url;
  }

  /** Resolve-or-timeout race (the SDK fetch init has no AbortSignal slot). */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = this.setTimeoutFn(() => {
        reject(new Error(`probe timed out after ${ms}ms`));
      }, ms);
      promise.then(
        (value) => {
          this.clearTimeoutFn(handle);
          resolve(value);
        },
        (err) => {
          this.clearTimeoutFn(handle);
          reject(err);
        },
      );
    });
  }
}
