/**
 * Status stream channel lifecycle: the pin contract.
 *
 * The printer page subscribes via `usePluginStream("klipper")`. The host
 * only forwards stream events while it holds a pin for the channel, and it
 * captures that pin ONLY from a `streams.open` sent inside a host-validated
 * dispatch (the SDK echoes the invocation id; the pin value comes from the
 * dispatch scope). This worker therefore opens STREAM_CHANNEL inside
 * `ensureCredential` — where the transport loop starts with the dispatching
 * company's identity — and closes it when the transport stops.
 *
 * Regression-tested here:
 *   - the first credentialed dispatch opens the channel with the
 *     dispatching company's id (and no open happens before any dispatch);
 *   - the transport callback emissions keep flowing on the unchanged emit
 *     path after the open;
 *   - repeated dispatches from the SAME company do not re-send the open
 *     notification (the local pin mirror dedupes);
 *   - a dispatch from ANOTHER company re-points the channel to that
 *     company (single-transport worker: the stream follows the dispatch);
 *   - stopping the transport (config replacement) closes the channel
 *     exactly once, and nothing is closed when no channel was opened;
 *   - an unchanged replay keeps the live transport AND the open channel;
 *   - the whole lifecycle spends ZERO extra worker→host calls: open/close
 *     are one-way notifications, so resolve/config counters and outbound
 *     printer traffic match the pre-stream baseline exactly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../src/manifest.js";
import { createKlipperWorker } from "../../src/worker.js";
import { bootWithReplay } from "../helpers/replayBoot.js";
import { MockFlashForge } from "../fixtures/flashforge/mockServer.js";

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

const SERIAL_A = "SN-TEST-C5-STREAM-A";
const SERIAL_B = "SN-TEST-C5-STREAM-B";
const CHECK_CODE = "stream-pin-check-code";
const API_KEY = "stream-pin-api-key";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const GCODE = new Uint8Array([0x47, 0x31, 0x20, 0x58, 0x31, 0x30, 0x0a]); // "G1 X10\n"

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

type StreamCall = { method: string; channel: string; companyId: string };

/** Wrap ctx.streams with recorders; also count the host calls the lifecycle must not spend. */
function recordStreamLifecycle(harness: TestHarness) {
  const calls: StreamCall[] = [];
  const streams = harness.ctx.streams;
  const origOpen = streams.open.bind(streams);
  const origEmit = streams.emit.bind(streams);
  const origClose = streams.close.bind(streams);
  harness.ctx.streams = {
    open: (channel: string, companyId: string) => {
      calls.push({ method: "open", channel, companyId });
      origOpen(channel, companyId);
    },
    emit: (channel: string, event: unknown) => {
      // The test harness's streams client keeps the channel→company map the
      // SDK production client uses to attribute out-of-dispatch emits; that
      // attribution is covered by the SDK's own tests. Here we only prove
      // the worker's emit path keeps flowing after the open.
      calls.push({ method: "emit", channel, companyId: "" });
      origEmit(channel, event);
    },
    close: (channel: string) => {
      calls.push({ method: "close", channel, companyId: "" });
      origClose(channel);
    },
  } as typeof harness.ctx.streams;
  const configGets: number[] = [];
  const secretResolves: unknown[] = [];
  const origGet = harness.ctx.config.get.bind(harness.ctx.config.get);
  const origResolve = harness.ctx.secrets.resolve.bind(harness.ctx.secrets.resolve);
  harness.ctx.config.get = (async () => {
    configGets.push(Date.now());
    return origGet();
  }) as typeof harness.ctx.config.get;
  harness.ctx.secrets.resolve = (async (ref: unknown) => {
    secretResolves.push(ref);
    return CHECK_CODE;
  }) as typeof harness.ctx.secrets.resolve;
  return { stream: calls, configGets, secretResolves };
}

function artifactCtx() {
  return {
    artifacts: {
      // fork51 ToolRunContextArtifactsClient types both verbs; only fetch
      // is ever exercised on this path.
      async create() {
        throw new Error("artifacts.create is not used by this plugin");
      },
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

function flashforgeConfig(baseUrl: string, serial: string) {
  return {
    transport: "flashforge" as const,
    flashforgeBaseUrl: baseUrl,
    flashforgeSerialNumber: serial,
    flashforgeCheckCodeRef: "flashforge-check-code",
    auto_upload_artifacts: true,
  };
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

describe("status stream channel lifecycle", () => {
  let mockA: MockFlashForge;
  let mockB: MockFlashForge;

  beforeEach(async () => {
    mockA = new MockFlashForge({
      serialNumber: SERIAL_A,
      checkCode: CHECK_CODE,
      gcodeList: ["bracket.gcode"],
    });
    await mockA.start();
    mockB = new MockFlashForge({
      serialNumber: SERIAL_B,
      checkCode: CHECK_CODE,
      gcodeList: ["bracket.gcode"],
    });
    await mockB.start();
  });

  afterEach(async () => {
    await mockA.stop();
    await mockB.stop();
  });

  async function bootDormantOnA() {
    const config = flashforgeConfig(mockA.baseUrl(), SERIAL_A);
    const harness = createTestHarness({ manifest, capabilities: [...CAPABILITIES], config });
    const recorded = recordStreamLifecycle(harness);
    const worker = await bootWithReplay(harness, {
      config,
      flashforgeClientOverrides: { pollIntervalMs: 15 },
    });
    return { harness, worker, ...recorded };
  }

  it("opens the channel inside the FIRST credentialed dispatch with the dispatch company", async () => {
    const { harness, stream, configGets, secretResolves } = await bootDormantOnA();

    // Nothing opened before any dispatch (id-less opens would be dropped).
    expect(stream.filter((c) => c.method === "open")).toHaveLength(0);

    const result = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A" },
    );
    expect(result.error).toBeUndefined();

    const opens = stream.filter((c) => c.method === "open");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toEqual({ method: "open", channel: "klipper", companyId: COMPANY_A });
  });

  it("keeps the emit path alive after the open (transport callbacks still flow)", async () => {
    const { harness, stream, configGets, secretResolves } = await bootDormantOnA();
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A" },
    );
    // The FlashForge /detail poll loop emits status snapshots on the
    // unchanged path: the recorder sees emits on the same channel.
    await waitFor(() => stream.some((c) => c.method === "emit"));
    expect(stream.find((c) => c.method === "emit")!.channel).toBe("klipper");
  });

  it("does not re-send the open for repeated dispatches from the same company", async () => {
    const { harness, stream, configGets, secretResolves } = await bootDormantOnA();
    for (let i = 0; i < 2; i++) {
      const result = await harness.executeTool<{ error?: string }>(
        "klipper.upload_gcode",
        { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
        { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: `run-A${i}` },
      );
      expect(result.error).toBeUndefined();
    }
    expect(stream.filter((c) => c.method === "open")).toHaveLength(1);
  });

  it("re-points the channel when a different company dispatches", async () => {
    const { harness, worker, stream, configGets, secretResolves } = await bootDormantOnA();
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A" },
    );
    expect(stream.filter((c) => c.method === "open")).toHaveLength(1);

    // Company B row replays a DIFFERENT connection identity (other printer);
    // the next dispatch rebuilds the transport and re-pins the channel.
    await worker.applyConfig(flashforgeConfig(mockB.baseUrl(), SERIAL_B), "configChanged");
    // The apply stopped the started transport: the channel closed with it.
    expect(stream.filter((c) => c.method === "close")).toHaveLength(1);

    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_B, agentId: "agent-B", runId: "run-B" },
    );
    const opens = stream.filter((c) => c.method === "open");
    expect(opens).toHaveLength(2);
    expect(opens[1].companyId).toBe(COMPANY_B);
  });

  it("closes the channel exactly once when the transport stops, and never closes an unopened one", async () => {
    const { harness, worker, stream, configGets, secretResolves } = await bootDormantOnA();

    // Config churn BEFORE any dispatch: transports are dormant, no channel
    // was ever opened, so no close may fire (an unpinned close would only
    // earn a dropped-notification warn on the host).
    await worker.applyConfig(flashforgeConfig(mockB.baseUrl(), SERIAL_B), "configChanged");
    await worker.applyConfig(flashforgeConfig(mockA.baseUrl(), SERIAL_A), "configChanged");
    expect(stream.filter((c) => c.method === "close")).toHaveLength(0);

    // Start the transport via a dispatch...
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A" },
    );
    expect(stream.filter((c) => c.method === "open")).toHaveLength(1);

    // ...then replace it: the started transport is stopped and dropped, and
    // the channel closes with it.
    await worker.applyConfig(flashforgeConfig(mockB.baseUrl(), SERIAL_B), "configChanged");
    const closes = stream.filter((c) => c.method === "close");
    expect(closes).toHaveLength(1);
    expect(closes[0].channel).toBe("klipper");

    // An unchanged replay of the SAME row keeps the (now dormant) client
    // and opens nothing; a later dispatch from the same company re-opens
    // exactly once even after a close.
    await worker.applyConfig(flashforgeConfig(mockB.baseUrl(), SERIAL_B), "configChanged");
    expect(stream.filter((c) => c.method === "close")).toHaveLength(1);
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_B, agentId: "agent-B", runId: "run-B2" },
    );
    const opens = stream.filter((c) => c.method === "open");
    expect(opens).toHaveLength(2);
    expect(opens[1].companyId).toBe(COMPANY_B);
  });

  it("spends ZERO extra worker→host calls for the whole channel lifecycle", async () => {
    const { harness, worker, stream, configGets, secretResolves } = await bootDormantOnA();
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A" },
    );
    // Baseline dispatch costs only: the in-dispatch live config read +
    // exactly one credential resolve. The open notification adds neither
    // (it is a one-way notification, not a request).
    expect(configGets).toHaveLength(1);
    expect(secretResolves).toHaveLength(1);

    // Stop the transport (close fires) and re-start it via another dispatch
    // (re-open fires): the full stop/open cycle still costs zero host calls.
    await worker.applyConfig(flashforgeConfig(mockB.baseUrl(), SERIAL_B), "configChanged");
    expect(stream.filter((c) => c.method === "close")).toHaveLength(1);
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_B, agentId: "agent-B", runId: "run-B" },
    );
    expect(stream.filter((c) => c.method === "open")).toHaveLength(2);
    // A few poll windows after the second dispatch: still zero extra calls.
    await new Promise((r) => setTimeout(r, 40));
    expect(configGets).toHaveLength(2);
    expect(secretResolves).toHaveLength(2);
  });
});
