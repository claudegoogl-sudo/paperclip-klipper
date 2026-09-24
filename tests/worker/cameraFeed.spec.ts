/**
 * CameraFeed unit coverage (phase-2 camera section, conditions F1/F2/C1):
 *
 *   - Pull parsing: MJPG-Streamer's multipart/x-mixed-replace body is
 *     byte-scanned for SOI..EOI; frames split across chunk boundaries and
 *     multiple frames per chunk are both extracted; exactly ONE frame is
 *     retained (keep-latest — structural drop-on-backpressure, never a
 *     queue).
 *   - Hostile-input caps: a frame over 512 KB or a SOI-less prefix over
 *     1 MB FAILS CLOSED (upstream aborted, counts toward reconnect).
 *   - Reconnect discipline mirrors the transports: exponential backoff
 *     (1 s base, 30 s cap) with jitter, terminal `failed` after 6 failed
 *     attempts that only camera_retry clears.
 *   - Idle lifecycle: the feed closes the upstream after 20 s without
 *     viewer activity (polling camera_next refreshes the clock), freeing
 *     the printer's single-viewer slot; open() re-arms it.
 *   - Scope defense-in-depth: a base URL that survived config validation
     but lost its /?action=stream scope fails at connect time too.
 *   - Frames never appear in logs: every log line's meta is scanned.
 */
import { describe, expect, it } from "vitest";
import { CameraFeed, type CameraFeedOptions } from "../../src/worker/camera/CameraFeed.js";

const SOI = [0xff, 0xd8, 0xff];
const EOI = [0xff, 0xd9];

function jpegFrame(payloadLen = 64, fill = 0xab): Uint8Array {
  const bytes = new Uint8Array(3 + payloadLen + 2);
  bytes.set(SOI, 0);
  bytes.fill(fill, 3, 3 + payloadLen);
  bytes.set(EOI, 3 + payloadLen);
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

interface FakeStream {
  stream: ReadableStream<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
  error(err: unknown): void;
}

function fakeStream(): FakeStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (chunk) => controller.enqueue(chunk),
    close: () => controller.close(),
    error: (err) => controller.error(err),
  };
}

interface FetchRecord {
  url: string;
  signal: AbortSignal;
}

/** Manual timers: nothing fires unless the test fires it. */
function makeTimers() {
  const live = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const setTimeoutFn = (cb: () => void, ms: number) => {
    const id = next++;
    live.set(id, { cb, ms });
    return id;
  };
  const clearTimeoutFn = (handle: unknown) => {
    live.delete(handle as number);
  };
  const pending = () => [...live.entries()].map(([id, t]) => ({ id, ...t }));
  const fire = async (id: number) => {
    const t = live.get(id);
    if (!t) return;
    live.delete(id);
    t.cb();
    await settle();
  };
  return { setTimeoutFn, clearTimeoutFn, pending, fire };
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function makeFeed(overrides: Partial<CameraFeedOptions> = {}) {
  const timers = makeTimers();
  const fetches: FetchRecord[] = [];
  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const streams: FakeStream[] = [];
  let clock = 1_000;
  const fetchFn = async (url: string, init?: { signal?: AbortSignal }) => {
    const s = fakeStream();
    streams.push(s);
    const rec: FetchRecord = { url, signal: init?.signal ?? new AbortController().signal };
    fetches.push(rec);
    return new Response(s.stream, {
      status: 200,
      headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" },
    });
  };
  const feed = new CameraFeed({
    baseUrl: "http://printer.lan:8080/?action=stream",
    logger: {
      info: (message, meta) => logs.push({ level: "info", message, meta }),
      warn: (message, meta) => logs.push({ level: "warn", message, meta }),
      error: (message, meta) => logs.push({ level: "error", message, meta }),
      debug: (message, meta) => logs.push({ level: "debug", message, meta }),
    },
    fetchFn: fetchFn as unknown as NonNullable<CameraFeedOptions["fetchFn"]>,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    randomFn: () => 0.99, // max jitter → deterministic delay assertions
    nowFn: () => clock,
    ...overrides,
  });
  return {
    feed,
    timers,
    fetches,
    logs,
    streams,
    advanceClock: (ms: number) => {
      clock += ms;
    },
    abort: () => {
      for (const f of fetches) {
        Object.defineProperty(f.signal, "aborted", { value: true });
      }
    },
  };
}

async function openConnected(h = makeFeed(), firstFrame = jpegFrame()) {
  const snap = h.feed.open();
  await settle();
  h.streams[0].push(firstFrame);
  await settle();
  return { snap, h };
}

describe("camera feed: pull parsing and keep-latest buffer", () => {
  it("opens lazily: idle until open(), then connecting → connected on first frame", async () => {
    const h = makeFeed();
    expect(h.feed.snapshot().state).toBe("idle");
    h.feed.open();
    await settle();
    expect(h.feed.snapshot().state).toBe("connecting");
    h.streams[0].push(jpegFrame());
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.state).toBe("connected");
    expect(snap.attempts).toBe(0);
    expect(snap.frame).not.toBeNull();
    expect(snap.frame!.bytes[0]).toBe(0xff);
    expect(snap.staleMs).toBe(0);
  });

  it("extracts a frame split across chunk boundaries (SOI..EOI spanning reads)", async () => {
    const h = makeFeed();
    await openConnected(h);
    const frame = jpegFrame(200, 0x5c);
    h.streams[0].push(frame.subarray(0, 40));
    await settle();
    h.streams[0].push(frame.subarray(40, 150));
    await settle();
    h.streams[0].push(frame.subarray(150));
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.state).toBe("connected");
    expect([...snap.frame!.bytes]).toEqual([...frame]);
  });

  it("keeps ONLY the latest frame (no queueing — drop-on-backpressure)", async () => {
    const h = makeFeed();
    await openConnected(h);
    const f2 = jpegFrame(32, 0x11);
    const f3 = jpegFrame(48, 0x22);
    h.streams[0].push(join(jpegFrame(16, 0x00), f2, f3));
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.state).toBe("connected");
    expect([...snap.frame!.bytes]).toEqual([...f3]);
  });

  it("skips multipart boundary junk between frames and multiple SOI-less prefixes", async () => {
    const h = makeFeed();
    const h2 = await openConnected(h);
    void h2;
    const boundary = new TextEncoder().encode("--frame\r\nContent-Type: image/jpeg\r\n\r\n");
    const frame = jpegFrame(24, 0x33);
    h.streams[0].push(join(boundary, frame, boundary));
    await settle();
    const snap = h.feed.snapshot();
    expect([...snap.frame!.bytes]).toEqual([...frame]);
  });

  it("capture timestamps come from the injected clock; staleMs tracks it", async () => {
    const h = makeFeed();
    await openConnected(h);
    h.advanceClock(1500);
    expect(h.feed.snapshot().staleMs).toBe(1500);
    const f2 = jpegFrame(8, 0x77);
    h.streams[0].push(f2);
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.staleMs).toBe(0);
    expect([...snap.frame!.bytes]).toEqual([...f2]);
  });
});

describe("camera feed: hostile-input caps fail closed", () => {
  it("a frame over maxFrameBytes aborts the upstream and counts as a failure", async () => {
    const h = makeFeed({ maxFrameBytes: 1024 });
    const snap = h.feed.open();
    await settle();
    void snap;
    h.streams[0].push(join(jpegFrame(2000))); // 2005 bytes > 1024 cap
    await settle();
    const after = h.feed.snapshot();
    expect(after.state).toBe("reconnecting");
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain("camera_frame_too_large");
    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0].signal.aborted).toBe(true);
  });

  it("a SOI-less prefix over maxPrefixBytes is a parse violation (fail closed)", async () => {
    const h = makeFeed({ maxPrefixBytes: 512 });
    h.feed.open();
    await settle();
    h.streams[0].push(new Uint8Array(600).fill(0x00)); // junk, no SOI
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.state).toBe("reconnecting");
    expect(snap.attempts).toBe(1);
    expect(snap.lastError).toContain("camera_stream_prefix_too_large");
  });

  it("an in-progress frame exceeding the cap while reading is caught too", async () => {
    const h = makeFeed({ maxFrameBytes: 256 });
    h.feed.open();
    await settle();
    h.streams[0].push(new Uint8Array([...SOI])); // frame starts...
    h.streams[0].push(new Uint8Array(300).fill(0x11)); // ...but balloons past cap before EOI
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.lastError).toContain("camera_frame_too_large");
  });
});

describe("camera feed: connect hygiene", () => {
  it("rejects a non-multipart content-type without treating it as frames", async () => {
    const h = makeFeed();
    h.feed.open();
    // swap in an HTML error page response
    h.fetches.length = 0;
    (h.feed as unknown as { fetchFn: (u: string) => Promise<Response> }).fetchFn = async () =>
      new Response("<html>nope</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    h.feed.retry();
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.lastError).toContain("camera_content_type_unexpected");
  });

  it("an http error status fails the connect with a redacted reason", async () => {
    const h = makeFeed();
    h.feed.open();
    (h.feed as unknown as { fetchFn: (u: string) => Promise<Response> }).fetchFn = async () =>
      new Response("denied", { status: 403 });
    h.feed.retry();
    await settle();
    expect(h.feed.snapshot().lastError).toContain("camera_http_403");
  });

  it("re-scopes the URL to /?action=stream at connect time even if config drifted", async () => {
    const h = makeFeed({ baseUrl: "http://printer.lan:8080/other?x=1" });
    h.feed.open();
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.state).toBe("reconnecting");
    expect(snap.lastError).toContain("camera_scope_violation");
  });

  it("a fetch rejection (printer unreachable) counts as a failed attempt", async () => {
    const h = makeFeed();
    h.feed.open();
    (h.feed as unknown as { fetchFn: (u: string) => Promise<Response> }).fetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    h.feed.retry();
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.state).toBe("reconnecting");
    expect(snap.attempts).toBe(1);
    expect(snap.lastError).toContain("camera_connect_failed");
  });
});

describe("camera feed: reconnect discipline (F2)", () => {
  it("backoff grows exponentially with jitter and is capped at 30 s", async () => {
    const h = makeFeed({ reconnectBaseMs: 1000, reconnectMaxMs: 30_000 });
    h.feed.open();
    await settle();
    // fail the first stream, observe delay
    for (let i = 0; i < 4; i++) {
      h.streams[h.streams.length - 1].close(); // EOF → failure
      await settle();
      const expected = Math.floor(Math.min(1000 * 2 ** i, 30_000) * 0.995); // random=0.99
      const reconnect = h.timers.pending().find((timer) => timer.ms === expected);
      expect(reconnect).toBeDefined();
      await h.timers.fire(reconnect!.id);
    }
    const snap = h.feed.snapshot();
    expect(snap.attempts).toBeGreaterThanOrEqual(4);
    expect(snap.state).toBe("reconnecting");
  });

  it("goes terminally `failed` after maxAttempts and stops auto-reconnecting", async () => {
    const h = makeFeed({ maxAttempts: 3 });
    h.feed.open();
    await settle();
    for (let i = 0; i < 3; i++) {
      h.streams[h.streams.length - 1].close();
      await settle();
      const expected = Math.floor(Math.min(1000 * 2 ** (h.feed.snapshot().attempts - 1), 30_000) * 0.995);
      const reconnect = h.timers.pending().find((timer) => timer.ms === expected);
      if (reconnect) await h.timers.fire(reconnect.id);
    }
    const snap = h.feed.snapshot();
    expect(snap.state).toBe("failed");
    expect(snap.attempts).toBe(3);
    // only the (harmless) viewer idle timer remains — no reconnect scheduled
    expect(h.timers.pending().map((timer) => timer.ms)).toEqual([20_000]);
    // camera_open refuses while failed — the page must use camera_retry
    expect(() => h.feed.open()).toThrow(/camera retry/i);
  });

  it("retry() re-arms a failed feed (explicit operator action)", async () => {
    const h = makeFeed({ maxAttempts: 2 });
    h.feed.open();
    await settle();
    for (let i = 0; i < 2; i++) {
      h.streams[h.streams.length - 1].close();
      await settle();
      const attempts = h.feed.snapshot().attempts;
      const expected = Math.floor(Math.min(1000 * 2 ** (attempts - 1), 30_000) * 0.995);
      const reconnect = h.timers.pending().find((timer) => timer.ms === expected);
      if (reconnect) await h.timers.fire(reconnect.id);
    }
    expect(h.feed.snapshot().state).toBe("failed");
    const snap = h.feed.retry();
    await settle();
    expect(snap.state).toBe("connecting");
    expect(h.feed.snapshot().attempts).toBe(0);
    h.streams[h.streams.length - 1].push(jpegFrame());
    await settle();
    expect(h.feed.snapshot().state).toBe("connected");
  });

  it("a successful frame resets the attempt counter (flaky printer link)", async () => {
    const h = makeFeed();
    h.feed.open();
    await settle();
    h.streams[0].push(jpegFrame());
    await settle();
    h.streams[0].close(); // drop after frames
    await settle();
    expect(h.feed.snapshot().state).toBe("reconnecting");
    const reconnect = h.timers.pending().find((timer) => timer.ms === 995);
    expect(reconnect).toBeDefined();
    await h.timers.fire(reconnect!.id);
    await settle();
    h.streams[h.streams.length - 1].push(jpegFrame());
    await settle();
    const snap = h.feed.snapshot();
    expect(snap.state).toBe("connected");
    expect(snap.attempts).toBe(0);
  });
});

describe("camera feed: viewer lifecycle (single-viewer slot)", () => {
  it("closes the upstream after idleTimeoutMs without viewer activity", async () => {
    const h = makeFeed({ idleTimeoutMs: 5_000 });
    await openConnected(h);
    expect(h.feed.snapshot().state).toBe("connected");
    const idle = h.timers.pending().find((t) => t.ms === 5_000);
    expect(idle).toBeDefined();
    await h.timers.fire(idle!.id);
    const snap = h.feed.snapshot();
    expect(snap.state).toBe("idle");
    expect(h.fetches[0].signal.aborted).toBe(true);
    // idle is re-armable: open() starts a fresh upstream
    const reopen = h.feed.open();
    await settle();
    expect(reopen.state).toBe("connecting");
    expect(h.fetches).toHaveLength(2);
  });

  it("polling (touch) refreshes the idle clock — active viewers keep the feed warm", async () => {
    const h = makeFeed({ idleTimeoutMs: 5_000 });
    await openConnected(h);
    // simulate 3 polls at 4 s intervals — never crossing the 5 s window
    for (let i = 0; i < 3; i++) {
      h.advanceClock(4_000);
      h.feed.touch();
    }
    expect(h.feed.snapshot().state).toBe("connected");
    expect(h.timers.pending().some((t) => t.ms === 5_000)).toBe(true);
    expect(h.fetches).toHaveLength(1); // same upstream the whole time
  });

  it("close() is idempotent and returns the feed to idle", async () => {
    const h = makeFeed();
    await openConnected(h);
    h.feed.close("page_closed");
    expect(h.feed.snapshot().state).toBe("idle");
    h.feed.close("page_closed"); // second call must not throw or re-log state churn
    expect(h.feed.snapshot().state).toBe("idle");
  });

  it("a disposed feed refuses open/retry (config replaced)", async () => {
    const h = makeFeed();
    h.feed.dispose();
    expect(() => h.feed.open()).toThrow(/stopped/);
    expect(() => h.feed.retry()).toThrow(/stopped/);
  });
});

describe("camera feed: frames never reach logs (C1 hygiene)", () => {
  it("no log line's serialized meta carries frame-ish bytes or base64", async () => {
    const h = makeFeed();
    const secret = jpegFrame(300, 0x9e);
    await openConnected(h, secret);
    h.streams[0].push(secret);
    await settle();
    h.streams[0].close();
    await settle();
    const serialized = h.logs
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(serialized).not.toMatch(/9e{6,}/);
    expect(serialized).not.toContain("base64");
    // reasons are bounded redacted strings
    for (const l of h.logs) {
      if (l.meta?.reason !== undefined) {
        expect(typeof l.meta.reason).toBe("string");
        expect((l.meta.reason as string).length).toBeLessThanOrEqual(160);
      }
    }
  });
});
