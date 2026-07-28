/**
 * MoonrakerClient unit tests (Workstream 6.3).
 *
 * Covers the acceptance criteria from the issue:
 *   - REST methods exercise the mock Moonraker fixture.
 *   - WS subscribe + status updates land on the client snapshot.
 *   - Reconnect with backoff verified by killing the mock WS, waiting, then
 *     restarting the mock and asserting the client reconnects within the cap.
 *   - Secret redaction: the resolved API key never appears in any logger
 *     line, activity row, or stream payload captured during the suite.
 *   - Outbound scope enforcement: requests to a different host throw before
 *     fetch is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createKlipperWorker } from "../src/worker.js";
import {
  MoonrakerClient,
  MoonrakerOutboundScopeError,
  redactApiKey,
} from "../src/worker/MoonrakerClient.js";
import { MockMoonraker } from "./fixtures/moonraker/mockServer.js";

const SECRET_REF = "moonraker-api-key";
// The harness resolves a secret ref to `resolved:<ref>` (see plugin-sdk
// testing.js). Assertions below treat this value as the exact plaintext that
// must NEVER appear in logs, streams, or fixtures.
const RESOLVED_KEY = `resolved:${SECRET_REF}`;

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

interface RecordedStreamEvent {
  channel: string;
  event: unknown;
}

/**
 * Narrow `createKlipperWorker`'s `client: MoonrakerClient | null` return
 * (the null branch handles permissive init) for tests that
 * have configured `moonrakerBaseUrl` and therefore expect a real client.
 */
function expectClient<T extends { client: unknown }>(worker: T): T & { client: NonNullable<T["client"]> } {
  if (worker.client === null || worker.client === undefined) {
    throw new Error("test setup: createKlipperWorker returned a null client");
  }
  return worker as T & { client: NonNullable<T["client"]> };
}

function harnessWithStreams(config: Record<string, unknown>) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...CAPABILITIES],
    config,
  });
  const streamEvents: RecordedStreamEvent[] = [];
  const origEmit = harness.ctx.streams.emit.bind(harness.ctx.streams);
  harness.ctx.streams.emit = (channel: string, event: unknown) => {
    streamEvents.push({ channel, event });
    return origEmit(channel, event);
  };
  return { harness, streamEvents };
}

function flatten(meta: unknown, acc: string[] = []): string[] {
  if (meta === null || meta === undefined) return acc;
  if (typeof meta === "string") {
    acc.push(meta);
    return acc;
  }
  if (Array.isArray(meta)) {
    for (const v of meta) flatten(v, acc);
    return acc;
  }
  if (typeof meta === "object") {
    for (const v of Object.values(meta as Record<string, unknown>)) flatten(v, acc);
  }
  return acc;
}

function assertNoApiKeyLeak(
  haystacks: Iterable<unknown>,
  apiKey: string,
): void {
  for (const h of haystacks) {
    const flat = flatten(h).join("\n");
    if (flat.includes(apiKey)) {
      throw new Error(`API key leaked into log/stream/activity payload: ${flat.slice(0, 500)}`);
    }
  }
}

describe("MoonrakerClient REST", () => {
  let mock: MockMoonraker;

  beforeEach(async () => {
    mock = new MockMoonraker({ requireApiKey: RESOLVED_KEY });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("forwards X-Api-Key on every REST call and never logs the key", async () => {
    const { harness, streamEvents } = harnessWithStreams({
      moonrakerBaseUrl: mock.baseUrl(),
      moonrakerApiKeyRef: SECRET_REF,
    });
    const { client } = expectClient(await createKlipperWorker(harness.ctx, { autoStart: false }));

    const info = await client.getPrinterInfo();
    expect(info.state).toBe("ready");

    const files = await client.listFiles("gcodes");
    expect(files[0].path).toBe("demo.gcode");

    const meta = await client.getFileMetadata("demo.gcode");
    expect(meta.filename).toBe("demo.gcode");
    expect(meta.thumbnails?.[0].data).toBeTruthy();

    const objects = await client.queryObjects({ print_stats: null, extruder: ["temperature"] });
    expect(objects.print_stats).toBeDefined();

    const startResult = await client.startPrint("demo.gcode");
    expect(startResult).toBe("ok");
    expect(await client.pausePrint()).toBe("ok");
    expect(await client.cancelPrint()).toBe("ok");

    const del = await client.deleteFile("demo.gcode");
    expect(del.item.root).toBe("gcodes");

    // X-Api-Key seen by the server proves the client forwarded it.
    expect(mock.seenApiKeys.has(RESOLVED_KEY)).toBe(true);
    // No request was rejected with 401.
    const denied = mock.recordedRequests.filter((r) =>
      Object.entries(r.headers).some(([k, v]) => k.toLowerCase() === "x-api-key" && v !== RESOLVED_KEY),
    );
    expect(denied).toHaveLength(0);

    // The plaintext key must not appear in any log/activity/metric/stream.
    assertNoApiKeyLeak(
      [harness.logs, harness.activity, harness.metrics, streamEvents],
      RESOLVED_KEY,
    );
  });

  it("uploads multipart G-code", async () => {
    const { harness } = harnessWithStreams({
      moonrakerBaseUrl: mock.baseUrl(),
      moonrakerApiKeyRef: SECRET_REF,
    });
    const { client } = expectClient(await createKlipperWorker(harness.ctx, { autoStart: false }));

    const payload = Buffer.from("G28\nG1 X10 Y10\n");
    const result = await client.uploadGcode("part.gcode", payload);
    expect(result.item.path).toBe("part.gcode");
    expect(mock.uploadedFiles[0].filename).toBe("part.gcode");
    // Multipart envelope adds boundary bytes — size on the server is larger
    // than the raw payload, never smaller.
    expect(mock.uploadedFiles[0].size).toBeGreaterThan(payload.length);

    assertNoApiKeyLeak([harness.logs], RESOLVED_KEY);
  });

  it("throws MoonrakerOutboundScopeError when a caller smuggles a foreign host", async () => {
    const { harness } = harnessWithStreams({
      moonrakerBaseUrl: mock.baseUrl(),
    });
    const client = new MoonrakerClient({
      baseUrl: mock.baseUrl(),
      http: harness.ctx.http,
      secrets: harness.ctx.secrets,
      logger: harness.ctx.logger,
    });
    // Force the private method by using `as any` casts is brittle; instead
    // exercise via a public path that builds a URL from a string that
    // happens to encode a foreign host. `requestJson` uses `new URL(path,
    // baseUrl)`, so an absolute foreign URL bypasses the base and we
    // expect the host check to fire.
    await expect(
      (client as unknown as { requestJson: (m: string, p: string) => Promise<unknown> }).requestJson(
        "GET",
        "http://attacker.example/printer/info",
      ),
    ).rejects.toBeInstanceOf(MoonrakerOutboundScopeError);
  });

  it("redactApiKey scrubs token query params and api-key headers", () => {
    expect(redactApiKey("ws://h/?token=abc&other=1")).toBe("ws://h/?token=[redacted]&other=1");
    expect(redactApiKey("x-api-key: secret-value")).toBe("x-api-key: [redacted]");
    expect(redactApiKey("plain message")).toBe("plain message");
  });
});

describe("MoonrakerClient WebSocket", () => {
  let mock: MockMoonraker;

  beforeEach(async () => {
    mock = new MockMoonraker({ requireApiKey: RESOLVED_KEY });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("connects, subscribes, receives status updates", async () => {
    const { harness, streamEvents } = harnessWithStreams({
      moonrakerBaseUrl: mock.baseUrl(),
      moonrakerApiKeyRef: SECRET_REF,
    });
    const updates: number[] = [];
    const { client } = expectClient(await createKlipperWorker(harness.ctx, {
      autoStart: false,
      clientOverrides: {
        onStatus: () => updates.push(Date.now()),
      },
    }));

    await client.start();
    await waitFor(() => client.getConnectionState().state === "connected", 2000);

    // Initial subscribe response seeds the snapshot.
    await waitFor(
      () => Object.keys(client.getStatusSnapshot().objects).length > 0,
      2000,
    );
    expect(client.getStatusSnapshot().objects.print_stats).toMatchObject({ mock: true });

    // Push an out-of-band status update.
    mock.pushStatusUpdate({ extruder: { temperature: 210 } });
    await waitFor(
      () => (client.getStatusSnapshot().objects.extruder as { temperature?: number } | undefined)?.temperature === 210,
      2000,
    );

    client.stop();
    assertNoApiKeyLeak(
      [harness.logs, harness.activity, harness.metrics, streamEvents],
      RESOLVED_KEY,
    );
  });

  it("reconnects with backoff after the mock WS is killed", async () => {
    const { harness, streamEvents } = harnessWithStreams({
      moonrakerBaseUrl: mock.baseUrl(),
      moonrakerApiKeyRef: SECRET_REF,
    });
    const { client } = expectClient(await createKlipperWorker(harness.ctx, {
      autoStart: false,
      clientOverrides: {
        reconnect: {
          initialDelayMs: 50,
          maxDelayMs: 500,
          multiplier: 2,
          maxAttempts: 6,
          jitter: 0, // deterministic
        },
        random: () => 0.5,
      },
    }));

    await client.start();
    await waitFor(() => client.getConnectionState().state === "connected", 2000);

    // Kill the WS server entirely; the client must enter `reconnecting`.
    await mock.stop();
    await waitFor(() => client.getConnectionState().state === "reconnecting", 2000);

    // Bring the mock server back up on the same port.
    await mock.start(parsePort(mock.baseUrl()));
    await waitFor(() => client.getConnectionState().state === "connected", 5000);

    client.stop();
    assertNoApiKeyLeak(
      [harness.logs, harness.activity, harness.metrics, streamEvents],
      RESOLVED_KEY,
    );
  });

  it("surfaces a failed state after maxAttempts and supports manual retry", async () => {
    // Connect successfully, kill the server permanently, and verify the
    // client surfaces `failed` once the attempt budget is exhausted. Then
    // bring the server back and verify `retryConnection()` recovers.
    const { harness } = harnessWithStreams({
      moonrakerBaseUrl: mock.baseUrl(),
      moonrakerApiKeyRef: SECRET_REF,
    });
    const { client } = expectClient(await createKlipperWorker(harness.ctx, {
      autoStart: false,
      clientOverrides: {
        reconnect: {
          initialDelayMs: 25,
          maxDelayMs: 50,
          multiplier: 1.5,
          maxAttempts: 3,
          jitter: 0,
        },
        random: () => 0.5,
      },
    }));

    await client.start();
    await waitFor(() => client.getConnectionState().state === "connected", 2000);

    const port = parsePort(mock.baseUrl());
    await mock.stop();
    await waitFor(() => client.getConnectionState().state === "failed", 5000);
    expect(client.getConnectionState().attempts).toBeGreaterThanOrEqual(3);

    // Bring the mock back and exercise manual retry.
    await mock.start(port);
    await client.retryConnection();
    await waitFor(() => client.getConnectionState().state === "connected", 2000);

    client.stop();
  });
});

describe("MoonrakerClient unauthenticated mode", () => {
  let mock: MockMoonraker;

  beforeEach(async () => {
    mock = new MockMoonraker(); // no apiKey
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("works without an api-key ref and omits X-Api-Key", async () => {
    const { harness } = harnessWithStreams({
      moonrakerBaseUrl: mock.baseUrl(),
    });
    const { client } = expectClient(await createKlipperWorker(harness.ctx, { autoStart: false }));

    await client.getPrinterInfo();
    // No X-Api-Key header was sent on any request.
    const sentApiKey = mock.recordedRequests.some((r) => {
      const v = r.headers["x-api-key"];
      return typeof v === "string" && v.length > 0;
    });
    expect(sentApiKey).toBe(false);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function parsePort(baseUrl: string): number {
  return Number(new URL(baseUrl).port);
}

// Vitest sometimes mocks timers — make sure these tests use real timers.
vi.useRealTimers();
