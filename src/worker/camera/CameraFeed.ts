/**
 * CameraFeed — the ONE upstream MJPG connection to the printer's
 * unauthenticated MJPG-Streamer endpoint, with keep-latest fan-in for the
 * printer page's camera section.
 *
 * Security posture (phase-2 security review):
 *   - The printer's camera endpoint authenticates NOTHING, so this worker
 *     is the trust boundary: it is the printer camera's only client. Frames
 *     are served exclusively through authenticated plugin actions gated to
 *     board actors (see registerRpcSurface.ts) — never through agent tools,
 *     data keys, or logs, and never written to disk.
 *   - Hostile-input bounds: the upstream serves 640x480 JPEG frames over a
 *     chatty multipart stream from an unauthenticated LAN device. Every
 *     buffer is capped: a frame larger than `maxFrameBytes` (512 KB) or a
 *     SOI-less prefix beyond 1 MB is a parse violation that FAILS CLOSED —
 *     the upstream is aborted immediately and the drop counts toward
 *     reconnect backoff.
 *   - Backpressure can never queue: exactly one "latest frame" slot is
 *     kept. A slow viewer polls slower and simply re-reads an older frame;
 *     frames in between are dropped on write. Memory ceiling per feed:
 *     one frame + one parse buffer.
 *   - Upstream reconnects mirror the MoonrakerClient WS discipline:
 *     exponential backoff with jitter (1 s base, 30 s cap) and a terminal
 *     `failed` state after `maxAttempts` consecutive failures that only an
 *     explicit retry (the `camera_retry` action) clears.
 *
 * Lifecycle: the feed is LAZY. The plugin page opens it when the camera
 * section becomes visible (`camera_open`), keeps it warm by polling
 * (`camera_next` refreshes the idle clock), and the feed CLOSES ITSELF
 * after `idleTimeoutMs` without any viewer activity — freeing the
 * printer's single-viewer camera slot for everyone else when no operator
 * is watching. Frames carry a monotonic capture timestamp so the page can
 * render a stale indicator instead of ever showing a frozen frame as live.
 */
export type CameraConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export interface CameraConnectionSnapshot {
  state: CameraConnectionState;
  /** Failed connect attempts since the last successful frame. */
  attempts: number;
  /** Redacted reason when state is reconnecting/failed. Never carries frame or printer data. */
  lastError?: string;
  /** Next reconnect delay in ms when state is reconnecting. */
  nextRetryInMs?: number;
}

export interface CameraFrame {
  /** Complete JPEG frame bytes (SOI..EOI), exactly as captured. */
  bytes: Uint8Array;
  /** Feed-clock monotonic timestamp of the capture (ms). */
  capturedAt: number;
}

export interface CameraSnapshot extends CameraConnectionSnapshot {
  /** Latest complete frame, when one has been captured. */
  frame: CameraFrame | null;
  /** ms since the latest frame was captured (Infinity when none). */
  staleMs: number;
}

export interface CameraFeedOptions {
  /** VALIDATED camera base URL (see validateCameraBaseUrl). */
  baseUrl: string;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
  };
  /**
   * Upstream fetch. Defaults to global fetch (the SDK explicitly permits
   * direct fetch for outbound work; ctx.http buffers whole bodies, which
   * cannot stream an infinite multipart response). The URL is re-scoped
   * through scopedCameraUrl() on every connect regardless of the impl.
   */
  fetchFn?: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<Response>;
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Per-frame hard cap. Default 512 KB (frames are ~54 KB at 640x480). */
  maxFrameBytes?: number;
  /** Cap on SOI-less leading bytes before a parse violation. Default 1 MB. */
  maxPrefixBytes?: number;
  /** Close the upstream after this much viewer inactivity. Default 20 s. */
  idleTimeoutMs?: number;
  /** Reconnect backoff base. Default 1 s. */
  reconnectBaseMs?: number;
  /** Reconnect backoff cap. Default 30 s. */
  reconnectMaxMs?: number;
  /** Consecutive failures before the terminal `failed` state. Default 6. */
  maxAttempts?: number;
  /** Jitter source for backoff — returns [0,1). Injectable for tests. */
  randomFn?: () => number;
  /** Monotonic-ish clock for frame timestamps and staleness. */
  nowFn?: () => number;
}

const DEFAULT_MAX_FRAME_BYTES = 512 * 1024;
const DEFAULT_MAX_PREFIX_BYTES = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 20_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 6;

function findSubarray(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const SOI = new Uint8Array([0xff, 0xd8, 0xff]);
const EOI = new Uint8Array([0xff, 0xd9]);

export class CameraFeed {
  private readonly baseUrl: string;
  private readonly logger: CameraFeedOptions["logger"];
  private readonly fetchFn: NonNullable<CameraFeedOptions["fetchFn"]>;
  private readonly setTimeoutFn: NonNullable<CameraFeedOptions["setTimeoutFn"]>;
  private readonly clearTimeoutFn: NonNullable<CameraFeedOptions["clearTimeoutFn"]>;
  private readonly maxFrameBytes: number;
  private readonly maxPrefixBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxAttempts: number;
  private readonly randomFn: () => number;
  private readonly nowFn: () => number;

  private state: CameraConnectionState = "idle";
  private attempts = 0;
  private lastError: string | undefined;
  private nextRetryInMs: number | undefined;
  private latest: CameraFrame | null = null;

  private controller: AbortController | null = null;
  private reconnectHandle: unknown = null;
  private idleHandle: unknown = null;
  private generation = 0;
  private stopped = false;

  constructor(opts: CameraFeedOptions) {
    this.baseUrl = opts.baseUrl;
    this.logger = opts.logger;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms) as unknown as object);
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxPrefixBytes = opts.maxPrefixBytes ?? DEFAULT_MAX_PREFIX_BYTES;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.randomFn = opts.randomFn ?? Math.random;
    this.nowFn = opts.nowFn ?? Date.now;
  }

  /** Current connection + frame snapshot for the polling action. */
  snapshot(): CameraSnapshot {
    return {
      state: this.state,
      attempts: this.attempts,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      ...(this.nextRetryInMs !== undefined ? { nextRetryInMs: this.nextRetryInMs } : {}),
      frame: this.latest,
      staleMs: this.latest === null ? Number.POSITIVE_INFINITY : this.nowFn() - this.latest.capturedAt,
    };
  }

  /** Viewer came back (or arrived). Opens the upstream when idle; refreshes the idle clock. */
  open(): CameraConnectionSnapshot {
    if (this.stopped) {
      throw new Error("camera feed is stopped (config replaced) — reconfigure to restart");
    }
    if (this.state === "failed") {
      throw new Error("camera connection failed — use the camera retry action to re-arm it");
    }
    this.touchIdleClock();
    if (this.state === "idle" && this.reconnectHandle === null) {
      this.beginConnect();
    }
    return this.snapshot();
  }

  /** Viewer activity heartbeat (camera_next polling). */
  touch(): void {
    this.touchIdleClock();
  }

  /**
   * Explicit re-arm from the terminal `failed` state (the camera_retry
   * action). Clears attempts + error and opens a fresh upstream.
   */
  retry(): CameraConnectionSnapshot {
    if (this.stopped) {
      throw new Error("camera feed is stopped (config replaced) — reconfigure to restart");
    }
    this.clearReconnectTimer();
    this.attempts = 0;
    this.lastError = undefined;
    this.nextRetryInMs = undefined;
    if (this.state !== "connected") this.beginConnect();
    return this.snapshot();
  }

  /** Manual stop (config replaced / page teardown). Idempotent. */
  close(reason = "camera_closed"): void {
    this.clearIdleClock();
    this.clearReconnectTimer();
    this.abortUpstream();
    if (this.state !== "idle") {
      this.state = "idle";
      this.attempts = 0;
      this.lastError = undefined;
      this.nextRetryInMs = undefined;
      this.logger.info("klipper.camera.state", { state: "idle", reason });
    }
  }

  /** Terminal stop on config replacement — the feed cannot be restarted. */
  dispose(): void {
    this.stopped = true;
    this.close("camera_disposed");
    this.latest = null;
  }

  // ── internal lifecycle ────────────────────────────────────────────────

  private touchIdleClock(): void {
    this.clearIdleClock();
    this.idleHandle = this.setTimeoutFn(() => {
      // No viewer polled within the window — free the printer's
      // single-viewer slot and go fully idle.
      if (this.state !== "failed") {
        this.abortUpstream();
        this.attempts = 0;
        this.lastError = undefined;
        this.nextRetryInMs = undefined;
        this.state = "idle";
        this.logger.info("klipper.camera.state", { state: "idle", reason: "viewer_idle_timeout" });
      }
    }, this.idleTimeoutMs);
  }

  private clearIdleClock(): void {
    if (this.idleHandle !== null) {
      this.clearTimeoutFn(this.idleHandle);
      this.idleHandle = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectHandle !== null) {
      this.clearTimeoutFn(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private abortUpstream(): void {
    this.generation += 1;
    if (this.controller) {
      try {
        this.controller.abort();
      } catch {
        // already aborted — fine
      }
      this.controller = null;
    }
  }

  private setState(state: CameraConnectionState, extra?: { lastError?: string; nextRetryInMs?: number }): void {
    this.state = state;
    if (extra?.lastError !== undefined) this.lastError = extra.lastError;
    this.nextRetryInMs = extra?.nextRetryInMs;
    this.logger.info("klipper.camera.state", {
      state,
      attempts: this.attempts,
      ...(extra?.lastError !== undefined ? { reason: extra.lastError } : {}),
      ...(extra?.nextRetryInMs !== undefined ? { nextRetryInMs: extra.nextRetryInMs } : {}),
    });
  }

  private beginConnect(): void {
    this.clearReconnectTimer();
    const generation = ++this.generation;
    void this.connect(generation);
  }

  private async connect(generation: number): Promise<void> {
    this.setState(this.attempts > 0 ? "reconnecting" : "connecting");
    const url = (() => {
      try {
        // Defense-in-depth: re-enforce the /?action=stream allowlist at the
        // wire even though config was validated at apply time.
        return new URL(this.baseUrl);
      } catch {
        this.failConnection("camera_url_invalid", generation);
        return null;
      }
    })();
    if (url === null) return;
    if (url.pathname !== "/" || [...new URLSearchParams(url.search).entries()].join(",") !== "action,stream") {
      this.failConnection("camera_scope_violation", generation);
      return;
    }

    this.controller = new AbortController();
    const controller = this.controller;
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), { signal: controller.signal });
    } catch (err) {
      if (generation !== this.generation) return; // superseded/stopped
      this.failConnection(fetchErrorReason(err), generation);
      return;
    }
    if (generation !== this.generation) return;

    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.toLowerCase().includes("multipart/x-mixed-replace")) {
      try {
        // Drain/ignore the body — status or content-type failed the check.
        await res.arrayBuffer().catch(() => undefined);
      } catch {
        // ignore
      }
      this.failConnection(
        res.ok ? "camera_content_type_unexpected" : `camera_http_${res.status}`,
        generation,
      );
      return;
    }
    if (!res.body) {
      this.failConnection("camera_empty_stream", generation);
      return;
    }

    await this.readFrames(res.body, generation, controller);
  }

  private async readFrames(
    body: ReadableStream<Uint8Array>,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    const reader = body.getReader();
    // Parse buffer: bytes between frames (headers, boundary text) and the
    // in-progress frame both live here. The buffer is capped two ways:
    // no SOI within maxPrefixBytes, or an in-progress frame beyond
    // maxFrameBytes — either is a hostile-stream violation (fail closed).
    let buffer = new Uint8Array(0);
    let soiIndex = -1;
    let framesSeen = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (generation !== this.generation) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          return;
        }
        if (done) break;
        if (soiIndex === -1) {
          buffer = concat(buffer, value);
          soiIndex = findSubarray(buffer, SOI, Math.max(0, buffer.length - value.length - SOI.length));
          if (soiIndex === -1 && buffer.length > this.maxPrefixBytes) {
            this.failConnection("camera_stream_prefix_too_large", generation);
            return;
          }
          if (soiIndex > 0) {
            buffer = new Uint8Array(buffer.subarray(soiIndex));
            soiIndex = 0;
          }
        } else {
          buffer = concat(buffer, value);
        }
        // Extract every complete frame currently in the buffer.
        for (;;) {
          const eoi = findSubarray(buffer, EOI, soiIndex === -1 ? 0 : soiIndex + SOI.length);
          if (eoi === -1) break;
          const frameEnd = eoi + EOI.length;
          const frame = buffer.subarray(0, frameEnd);
          if (frame.length > this.maxFrameBytes) {
            this.failConnection("camera_frame_too_large", generation);
            return;
          }
          // Keep-latest slot: overwrite, never queue (drop-on-backpressure).
          this.latest = { bytes: new Uint8Array(frame), capturedAt: this.nowFn() };
          framesSeen += 1;
          if (this.state !== "connected") {
            this.attempts = 0;
            this.lastError = undefined;
            this.nextRetryInMs = undefined;
            this.setState("connected");
          }
          buffer = new Uint8Array(buffer.subarray(frameEnd));
          soiIndex = findSubarray(buffer, SOI, 0);
          if (soiIndex > 0) {
            buffer = new Uint8Array(buffer.subarray(soiIndex));
            soiIndex = 0;
          }
          if (buffer.length > this.maxFrameBytes) {
            this.failConnection("camera_frame_too_large", generation);
            return;
          }
        }
        if (soiIndex !== -1 && buffer.length - soiIndex > this.maxFrameBytes) {
          this.failConnection("camera_frame_too_large", generation);
          return;
        }
      }
    } catch (err) {
      if (generation !== this.generation) return;
      this.failConnection(readErrorReason(err), generation);
      return;
    } finally {
      if (generation === this.generation && this.controller === controller) {
        this.controller = null;
      }
    }
    if (generation !== this.generation) return;
    // Upstream EOF: with zero frames this is just a failed connect; with
    // frames it is an upstream drop. Either way, reconnect discipline.
    this.failConnection(framesSeen > 0 ? "camera_upstream_closed" : "camera_empty_stream", generation);
  }

  /** Count a failure and either schedule a reconnect or go terminally failed. */
  private failConnection(reason: string, generation: number): void {
    if (generation !== this.generation) return;
    this.abortUpstream();
    this.attempts += 1;
    if (this.attempts >= this.maxAttempts) {
      this.setState("failed", { lastError: reason });
      this.logger.error("klipper.camera.failed_terminal", {
        attempts: this.attempts,
        reason,
      });
      return;
    }
    // Exponential backoff with jitter: base * 2^(attempts-1), capped, with
    // ±uniform jitter in [50%, 100%) of the computed delay.
    const backoff = Math.min(this.reconnectBaseMs * 2 ** (this.attempts - 1), this.reconnectMaxMs);
    const delay = Math.max(1, Math.floor(backoff * (0.5 + 0.5 * this.randomFn())));
    this.setState("reconnecting", { lastError: reason, nextRetryInMs: delay });
    this.clearReconnectTimer();
    this.reconnectHandle = this.setTimeoutFn(() => {
      this.reconnectHandle = null;
      if (this.state === "reconnecting") this.beginConnect();
    }, delay);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Redacted, bounded reason strings — never carry response or frame bytes. */
function fetchErrorReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `camera_connect_failed: ${msg.slice(0, 120)}`;
}

function readErrorReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `camera_read_failed: ${msg.slice(0, 120)}`;
}
