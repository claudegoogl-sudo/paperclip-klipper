/**
 * Idle-window host-call isolation (invocation-scope poisoning regression).
 *
 * The host attributes worker→host RPCs that do not echo an invocation id via
 * single-in-flight attribution: an id-less call with NOTHING in flight
 * permanently denies ("poisons") that method for the worker process. An
 * earlier revision poisoned `config.get` at spawn (setup() made a
 * best-effort read in service scope) and `secrets.resolve` within one poll
 * cycle (the FlashForge status poll resolved the check code per /detail
 * request, ~every 10s, almost always outside any dispatch). The first real
 * dispatch then found both methods dead: the upload gate re-read config,
 * got the poisoned denial, failed closed to `{}`, and refused the upload
 * with a misleading "auto_upload_artifacts is false" even though the
 * persisted config was correct.
 *
 * The contract regression-tested here:
 *   - setup() makes ZERO worker→host calls (config.get / secrets.resolve);
 *   - config application resolves each configured credential EXACTLY ONCE
 *     (it runs inside the host's scoped config push, so that call is
 *     attributed) and then the idle loop — status polls, health probes, UI
 *     data keys, UI actions — makes ZERO further host calls;
 *   - a dispatch after any idle window still works: the in-dispatch config
 *     re-read is attributed by the in-flight invocation, and the transport
 *     requests ride the apply-time credential cache;
 *   - credential failure at apply time fails closed (no client, tools
 *     refuse) and a re-apply refreshes the cached value.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../src/manifest.js";
import { createKlipperWorker } from "../../src/worker.js";
import { bootWithReplay } from "../helpers/replayBoot.js";
import { MockFlashForge } from "../fixtures/flashforge/mockServer.js";
import { MockMoonraker } from "../fixtures/moonraker/mockServer.js";

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

const SERIAL = "SN-TEST-C5";
const CHECK_CODE = "idle-window-check-code";
const API_KEY = "idle-window-api-key";

const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
const GCODE = new Uint8Array([0x47, 0x31, 0x20, 0x58, 0x31, 0x30, 0x0a]); // "G1 X10\n"

function artifactCtx() {
  return {
    artifacts: {
      async fetch() {
        return {
          bytes: GCODE,
          filename: "bracket.gcode",
          contentType: "application/octet-stream",
          byteSize: GCODE.length,
        };
      },
    },
  };
}

/** Wrap ctx.config.get + ctx.secrets.resolve with call counters. */
function countHostCalls(harness: TestHarness) {
  const configGets: unknown[] = [];
  const secretResolves: unknown[] = [];
  const origGet = harness.ctx.config.get.bind(harness.ctx.config.get);
  const origResolve = harness.ctx.secrets.resolve.bind(harness.ctx.secrets.resolve);
  harness.ctx.config.get = (async () => {
    configGets.push(Date.now());
    return origGet();
  }) as typeof harness.ctx.config.get;
  harness.ctx.secrets.resolve = (async (ref: string) => {
    secretResolves.push(ref);
    if (typeof ref === "string" && ref.includes("moonraker")) return API_KEY;
    return CHECK_CODE;
  }) as typeof harness.ctx.secrets.resolve;
  return { configGets, secretResolves };
}

/** FlashForge JSON endpoints carry the check code in the body, not headers. */
function bodyCheckCode(req: { body?: Buffer | string }): unknown {
  try {
    const parsed = JSON.parse(Buffer.from(req.body ?? "").toString("utf8"));
    return (parsed as { checkCode?: unknown }).checkCode;
  } catch {
    return undefined;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("boot: zero worker→host calls at spawn", () => {
  it("setup() calls neither ctx.config.get nor ctx.secrets.resolve", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {
        transport: "flashforge",
        flashforgeBaseUrl: "http://127.0.0.1:1",
        flashforgeSerialNumber: SERIAL,
        flashforgeCheckCodeRef: "flashforge-check-code",
      },
    });
    const calls = countHostCalls(harness);
    await createKlipperWorker(harness.ctx, { autoStart: false });
    expect(calls.configGets).toHaveLength(0);
    expect(calls.secretResolves).toHaveLength(0);
  });
});

describe("idle window: apply + 3+ poll cycles make ZERO host calls (flashforge)", () => {
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("exactly one resolve at apply, then silence through polls, data keys, actions, and probes", async () => {
    const config = {
      transport: "flashforge",
      flashforgeBaseUrl: mock.baseUrl(),
      flashforgeSerialNumber: SERIAL,
      flashforgeCheckCodeRef: "flashforge-check-code",
      auto_upload_artifacts: true,
    };
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config,
    });
    const calls = countHostCalls(harness);
    // config is passed explicitly so the helper needs no ctx.config.get seed
    // read — every counted call below is a WORKER call.
    const worker = await bootWithReplay(harness, {
      config,
      autoStart: true,
      flashforgeClientOverrides: { pollIntervalMs: 15 },
    });
    expect(worker.client?.kind).toBe("flashforge");

    // The apply-time resolve happened exactly once (scoped push).
    expect(calls.secretResolves).toHaveLength(1);
    expect(calls.configGets).toHaveLength(0);

    await waitFor(() => worker.client!.getConnectionState().state === "connected");
    // Let >=3 poll cycles run past the first successful poll.
    await new Promise((r) => setTimeout(r, 60));
    const pollRequests = mock.recordedRequests.filter((r) => r.url === "/detail").length;
    expect(pollRequests).toBeGreaterThanOrEqual(3);

    // ── the poisoning window: idle work must be host-call-silent ──
    const configGetsBefore = calls.configGets.length;
    const secretResolvesBefore = calls.secretResolves.length;

    // UI data keys (host→worker reads, never dispatches).
    await harness.getData("status");
    await harness.getData("connection");
    await harness.getData("config");
    await harness.getData("files");
    // UI actions (same surface class — no dispatch in flight).
    await harness.performAction("refresh");
    // Health probes ride the same cached credential.
    await worker.client!.probeHealth?.();
    // ...and keep polling in the background the whole time.
    await new Promise((r) => setTimeout(r, 60));

    expect(calls.configGets).toHaveLength(configGetsBefore);
    expect(calls.configGets).toHaveLength(0);
    expect(calls.secretResolves).toHaveLength(secretResolvesBefore);
    expect(calls.secretResolves).toHaveLength(1);
  });
});

describe("idle window: WS reconnects make ZERO host calls (moonraker)", () => {
  it("a reconnect after a dropped WS reuses the cached key without resolving", async () => {
    const mock = new MockMoonraker({ requireApiKey: API_KEY });
    await mock.start();
    try {
      const harness = createTestHarness({
        manifest,
        capabilities: [...CAPABILITIES],
        config: {
          moonrakerBaseUrl: mock.baseUrl(),
          moonrakerApiKeyRef: "moonraker-key",
        },
      });
      const calls = countHostCalls(harness);
      const worker = await bootWithReplay(harness, {
        autoStart: true,
        clientOverrides: {
          reconnect: {
            initialDelayMs: 10,
            maxDelayMs: 50,
            multiplier: 2,
            maxAttempts: 6,
            jitter: 0,
          },
          random: () => 0.5,
        },
      });
      const client = worker.client!;
      await waitFor(() => client.getConnectionState().state === "connected");

      // Simulate a printer reboot at 3am: nothing in flight.
      const resolvesBefore = calls.secretResolves.length;
      mock.closeAllWebSockets(1006, "printer reboot");
      await waitFor(() => client.getConnectionState().state === "reconnecting");
      await waitFor(() => client.getConnectionState().state === "connected");
      expect(calls.secretResolves).toHaveLength(resolvesBefore);

      // The mock refuses WS upgrades with a wrong token (401 → the client
      // would flip back to reconnecting/failed). Staying connected past a
      // poll tick proves the reconnect authenticated with the CACHED key.
      await new Promise((r) => setTimeout(r, 50));
      expect(client.getConnectionState().state).toBe("connected");
    } finally {
      await mock.stop();
    }
  });
});

describe("dispatch after an idle poisoning window (integration)", () => {
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({
      serialNumber: SERIAL,
      checkCode: CHECK_CODE,
      gcodeList: ["bracket.gcode"],
    });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  async function bootIdleThenDispatch() {
    const config = {
      transport: "flashforge",
      flashforgeBaseUrl: mock.baseUrl(),
      flashforgeSerialNumber: SERIAL,
      flashforgeCheckCodeRef: "flashforge-check-code",
      auto_upload_artifacts: true,
      // allow_agent_initiated_print stays OFF: start_print must reach the
      // plugin-level refusal, proving the gate config was readable.
    };
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config,
    });
    const calls = countHostCalls(harness);
    const worker = await bootWithReplay(harness, {
      config,
      autoStart: true,
      flashforgeClientOverrides: { pollIntervalMs: 15 },
    });
    await waitFor(() => worker.client!.getConnectionState().state === "connected");
    // The live failure: >=3 idle poll cycles before the first dispatch.
    await new Promise((r) => setTimeout(r, 60));
    return { harness, calls };
  }

  it("upload_gcode passes the config gate and delivers the artifact", async () => {
    const { harness, calls } = await bootIdleThenDispatch();

    const result = await harness.executeTool<{
      data?: { item?: { path: string } };
      error?: string;
    }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.item?.path).toBe("bracket.gcode");
    const upload = mock.recordedRequests.find((r) => r.url === "/uploadGcode");
    expect(upload).toBeDefined();

    // The dispatch itself re-read config (attributed by the in-flight
    // invocation — allowed) but resolved NO secrets (cached credential).
    expect(calls.configGets).toHaveLength(1);
    expect(calls.secretResolves).toHaveLength(1);
  });

  it("start_print reaches the plugin-level refusal (gate config readable in-dispatch)", async () => {
    const { harness } = await bootIdleThenDispatch();

    const result = await harness.executeTool<{ error?: string }>(
      "klipper.start_print",
      { filename: "bracket.gcode" },
    );
    // NOT "prerequisite_missing" (that would mean config was unreadable) —
    // the gate refusal proves the live config read succeeded and the
    // opt-in flag resolved to false.
    expect(result.error).toMatch(/allow_agent_initiated_print/);
  });
});

describe("credential lifecycle at apply time", () => {
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("a resolve failure at apply fails closed: no client, tools refuse, reason logged", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {
        transport: "flashforge",
        flashforgeBaseUrl: mock.baseUrl(),
        flashforgeSerialNumber: SERIAL,
        flashforgeCheckCodeRef: "flashforge-check-code",
      },
    });
    harness.ctx.secrets.resolve = (async () => {
      throw new Error("Secret is not bound to plugin at flashforgeCheckCodeRef");
    }) as typeof harness.ctx.secrets.resolve;

    const worker = await bootWithReplay(harness);

    // Fail closed: no transport, no partial client, permissive refusal.
    expect(worker.client).toBeNull();
    const result = await harness.executeTool<{ data?: { error?: string } }>(
      "klipper.get_printer_status",
      {},
    );
    expect(result.data?.error).toBe("prerequisite_missing");
    expect(
      harness.logs.some(
        (e) =>
          e.level === "warn" &&
          e.message.includes("could not resolve the flashforge check-code ref") &&
          e.message.includes("fail closed"),
      ),
    ).toBe(true);
    // The FAILURE REASON is loggable (it names the ref, never a value).
    const flat = JSON.stringify(harness.logs);
    expect(flat).not.toContain(CHECK_CODE);
  });

  it("a live client whose secret stops resolving on re-apply is stopped (fail closed)", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {
        transport: "flashforge",
        flashforgeBaseUrl: mock.baseUrl(),
        flashforgeSerialNumber: SERIAL,
        flashforgeCheckCodeRef: "flashforge-check-code",
      },
    });
    const worker = await bootWithReplay(harness);
    expect(worker.client).not.toBeNull();

    harness.ctx.secrets.resolve = (async () => {
      throw new Error("binding revoked");
    }) as typeof harness.ctx.secrets.resolve;
    await worker.applyConfig(
      {
        transport: "flashforge",
        flashforgeBaseUrl: mock.baseUrl(),
        flashforgeSerialNumber: SERIAL,
        flashforgeCheckCodeRef: "flashforge-check-code",
      },
      "configChanged",
      false,
    );
    expect(worker.client).toBeNull();
  });

  it("an unchanged-fingerprint re-apply refreshes the credential the poll uses", async () => {
    const rotated = "rotated-check-code";
    let current = CHECK_CODE;
    const config = {
      transport: "flashforge",
      flashforgeBaseUrl: mock.baseUrl(),
      flashforgeSerialNumber: SERIAL,
      flashforgeCheckCodeRef: "flashforge-check-code",
    };
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config,
    });
    const origResolve = harness.ctx.secrets.resolve.bind(harness.ctx.secrets.resolve);
    harness.ctx.secrets.resolve = (async (ref: string) => current) as typeof harness.ctx.secrets.resolve;
    void origResolve;

    const worker = await bootWithReplay(harness, {
      config,
      autoStart: true,
      flashforgeClientOverrides: { pollIntervalMs: 15 },
    });
    const first = worker.client!;
    await waitFor(() => first.getConnectionState().state === "connected");
    expect(
      mock.recordedRequests.some(
        (r) => r.url === "/detail" && bodyCheckCode(r) === CHECK_CODE,
      ),
    ).toBe(true);

    // Operator rotates the secret value (same ref → same connection
    // identity) and the host replays the row. The cache must refresh.
    current = rotated;
    await worker.applyConfig(
      {
        transport: "flashforge",
        flashforgeBaseUrl: mock.baseUrl(),
        flashforgeSerialNumber: SERIAL,
        flashforgeCheckCodeRef: "flashforge-check-code",
      },
      "configChanged",
      false,
    );
    expect(worker.client).toBe(first); // no client churn...
    await waitFor(() =>
      mock.recordedRequests.some(
        (r) => r.url === "/detail" && bodyCheckCode(r) === rotated,
      ),
    ); // ...but the poll already uses the rotated value.
  });
});
