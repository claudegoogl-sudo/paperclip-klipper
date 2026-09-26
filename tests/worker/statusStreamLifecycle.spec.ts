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
 *   - a host `streams.dropped` for the channel (open/pin-class reason)
 *     resets the local pin mirror, so the next same-company dispatch
 *     re-opens the channel instead of deduping against a pin the host
 *     never recorded (fire-and-forget open lost → self-healing re-open);
 *   - a dispatch from ANOTHER company with an UNCHANGED connection
 *     identity re-points the channel IN PLACE — no second transport — and
 *     the whole path still spends zero extra host calls;
 *   - the whole lifecycle spends ZERO extra worker→host calls: open/close
 *     are one-way notifications, so resolve/config counters and outbound
 *     printer traffic match the pre-stream baseline exactly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { StreamDropNotice } from "@paperclipai/plugin-sdk";
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

/**
 * Wrap ctx.streams with recorders; also count the host calls the lifecycle
 * must not spend, and capture `streams.onDropped` registrations so specs can
 * simulate host drop feedback via `fireDrop` (the harness has no host to
 * send real `streams.dropped` notifications).
 */
function recordStreamLifecycle(harness: TestHarness) {
  const calls: StreamCall[] = [];
  const streams = harness.ctx.streams;
  const origOpen = streams.open.bind(streams);
  const origEmit = streams.emit.bind(streams);
  const origClose = streams.close.bind(streams);
  const dropHandlers = new Set<(notice: StreamDropNotice) => void>();
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
    onDropped: (handler: (notice: StreamDropNotice) => void) => {
      dropHandlers.add(handler);
      return () => {
        dropHandlers.delete(handler);
      };
    },
  } as typeof harness.ctx.streams;
  const fireDrop = (notice: StreamDropNotice): void => {
    for (const handler of [...dropHandlers]) handler(notice);
  };
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
  return { stream: calls, configGets, secretResolves, fireDrop };
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

  it("re-points the channel IN PLACE when another company dispatches the same connection identity", async () => {
    const { harness, worker, stream, configGets, secretResolves } = await bootDormantOnA();
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A" },
    );
    expect(stream.filter((c) => c.method === "open")).toHaveLength(1);
    const transportBefore = worker.client;
    expect(transportBefore).not.toBeNull();

    // Company B dispatches the SAME printer (identical connection identity,
    // no config churn, transport already started): no second transport may
    // be built, but the channel must follow the dispatch.
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_B, agentId: "agent-B", runId: "run-B" },
    );
    const opens = stream.filter((c) => c.method === "open");
    expect(opens).toHaveLength(2);
    expect(opens[1]).toEqual({ method: "open", channel: "klipper", companyId: COMPANY_B });
    expect(worker.client).toBe(transportBefore);

    // Still zero extra host calls: the re-point added no config read beyond
    // the second dispatch's own baseline, and the unchanged credential
    // fingerprint made the second resolve a cache hit (no host call at all).
    expect(configGets).toHaveLength(2);
    expect(secretResolves).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(configGets).toHaveLength(2);
    expect(secretResolves).toHaveLength(1);
  });

  it("re-opens the channel after the host drops the open (pin-mirror reset)", async () => {
    const { harness, stream, fireDrop } = await bootDormantOnA();
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A" },
    );
    expect(stream.filter((c) => c.method === "open")).toHaveLength(1);

    // The host dropped our fire-and-forget open (scope validation failure).
    // The worker's mirror still believes the channel is open — without the
    // reset this dedupe would suppress every future same-company open and
    // the stream would stay dead until a transport restart.
    fireDrop({
      method: "streams.open",
      channel: "klipper",
      companyId: COMPANY_A,
      reason: "invalid_invocation_scope",
    });
    expect(
      harness.logs.some((l) => l.level === "warn" && l.message === "klipper.stream.pin_mirror_reset"),
    ).toBe(true);

    // The next SAME-company dispatch re-sends the open: the mirror was reset.
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A-after-drop" },
    );
    const opens = stream.filter((c) => c.method === "open");
    expect(opens).toHaveLength(2);
    expect(opens[1]).toEqual({ method: "open", channel: "klipper", companyId: COMPANY_A });
  });

  it("does NOT reset the pin mirror for drops that do not concern the channel", async () => {
    const { harness, stream, fireDrop } = await bootDormantOnA();
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A" },
    );
    expect(stream.filter((c) => c.method === "open")).toHaveLength(1);

    // Another channel's drop (and an unknown-reason emit drop on our channel
    // with no pin-class signal) must not tear down a healthy mirror.
    fireDrop({ method: "streams.emit", channel: "other", companyId: COMPANY_A, reason: "pin_mismatch" });
    fireDrop({ method: "streams.emit", channel: "klipper", companyId: COMPANY_A, reason: "some_future_reason" });

    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A2" },
    );
    // Dedupe held: the same-company dispatch did not re-send the open.
    expect(stream.filter((c) => c.method === "open")).toHaveLength(1);
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

  it("never emits outside an open channel while a config replay burst stops a started transport", async () => {
    const { harness, worker, stream } = await bootDormantOnA();
    await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      { ...artifactCtx(), companyId: COMPANY_A, agentId: "agent-A", runId: "run-A" },
    );
    await waitFor(() => stream.some((c) => c.method === "emit"));

    // Boot-replay-shaped burst: several distinct company rows alternate.
    // The first apply stops the STARTED transport (whose stop() pushes a
    // synchronous idle connection state); later applies churn dormant ones.
    for (let i = 0; i < 3; i++) {
      await worker.applyConfig(flashforgeConfig(mockB.baseUrl(), SERIAL_B), "configChanged");
      await worker.applyConfig(flashforgeConfig(mockA.baseUrl(), SERIAL_A), "configChanged");
    }
    // Let any in-flight poll of the stopped client settle.
    await new Promise((r) => setTimeout(r, 80));

    // Every emit must sit between an open and the next close: an emit with
    // no open channel has no company claim and the host drops it.
    let open = false;
    const unclaimed: number[] = [];
    stream.forEach((c, idx) => {
      if (c.method === "open") open = true;
      else if (c.method === "close") open = false;
      else if (c.method === "emit" && !open) unclaimed.push(idx);
    });
    expect(unclaimed).toEqual([]);
    expect(stream.filter((c) => c.method === "close")).toHaveLength(1);
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
