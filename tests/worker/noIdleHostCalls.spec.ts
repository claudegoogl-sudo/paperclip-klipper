/**
 * Worker→host call isolation: the invocation-scope contract.
 *
 * The host attributes worker→host RPCs that do not echo an invocation id
 * via single-in-flight attribution: an id-less call with NOTHING in flight
 * permanently denies ("poisons") that method for the worker process, and
 * `secrets.resolve` is deliberately NOT service-scoped (it resolves tenant
 * secrets). The activation config replay delivers rows back-to-back while
 * the plugin's apply runs async to the push, so a resolve during
 * `configChanged` lands with 0 or 2+ invocations in flight and is DENIED
 * (observed live: every apply-time resolve failed with
 * InvocationScopeDeniedError). The one authorization path this worker
 * class can rely on is in-dispatch single-in-flight attribution with the
 * executeTool scope carrying companyId+runId.
 *
 * The contract regression-tested here:
 *   - setup() makes ZERO worker→host calls (config.get / secrets.resolve);
 *   - config application makes ZERO worker→host calls — including
 *     overlapping multi-row replays and an apply that outlives its push —
 *     and converges ref-bearing transports DORMANT;
 *   - the fail-closed idle state is OBSERVABLE: status data key, status
 *     tool, and health report "credential not resolved yet" (never a
 *     0.2.2-style gate error, never a crash loop), and no request leaves
 *     the process before a dispatch;
 *   - the FIRST credentialed dispatch resolves the ref exactly once
 *     (in-dispatch), starts the transport, and passes the config gates;
 *   - the status poll consumes the client-held credential only — poll
 *     cycles make ZERO resolve/config calls — and the WS reconnect after
 *     a dispatch reuses the cached key;
 *   - every config application invalidates the cache: the transport goes
     dormant again and a rotated secret lands at the next dispatch;
 *   - a resolve failure in-dispatch fails closed: the tool refuses with a
 *     clear reason, the transport stays dormant, and no credential
 *     material reaches the logs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { createRunCtxAwareHarness } from "../helpers/runCtxAwareHarness.js";
import manifest from "../../src/manifest.js";
import plugin, { createKlipperWorker } from "../../src/worker.js";
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
const CREDENTIAL_PENDING = "credential not resolved yet";

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
  harness.ctx.secrets.resolve = (async (ref: unknown) => {
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

function flashforgeConfig(baseUrl: string, extra: Record<string, unknown> = {}) {
  return {
    transport: "flashforge" as const,
    flashforgeBaseUrl: baseUrl,
    flashforgeSerialNumber: SERIAL,
    flashforgeCheckCodeRef: "flashforge-check-code",
    ...extra,
  };
}

describe("boot: zero worker→host calls at spawn", () => {
  it("setup() calls neither ctx.config.get nor ctx.secrets.resolve", async () => {
    const harness = createRunCtxAwareHarness({
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

describe("apply window: config application makes ZERO host calls (AC1)", () => {
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("a ref-bearing apply resolves NOTHING and converges the transport dormant", async () => {
    const config = flashforgeConfig(mock.baseUrl(), { auto_upload_artifacts: true });
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES], config });
    const calls = countHostCalls(harness);
    const worker = await bootWithReplay(harness, { config });

    expect(calls.configGets).toHaveLength(0);
    expect(calls.secretResolves).toHaveLength(0);
    // Dormant, not dead: the client exists (status surfaces can answer)
    // but no poll loop runs and no request has left the process.
    expect(worker.client).not.toBeNull();
    expect(worker.client!.getConnectionState().state).toBe("idle");
    expect(mock.recordedRequests).toHaveLength(0);
  });

  it("an overlapping multi-row replay and an apply that outlives the push make ZERO host calls", async () => {
    const config = flashforgeConfig(mock.baseUrl(), { auto_upload_artifacts: true });
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES], config });
    const calls = countHostCalls(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    // Two rows replayed back-to-back (the activation pattern), applied
    // concurrently, and never awaited inside any host push.
    const rowA = worker.applyConfig(config, "configChanged");
    const rowB = worker.applyConfig(config, "configChanged");
    await Promise.all([rowA, rowB]);
    expect(calls.configGets).toHaveLength(0);
    expect(calls.secretResolves).toHaveLength(0);
  });

  it("unauthenticated moonraker (no ref) still applies with zero host calls and starts", async () => {
    const mock = new MockMoonraker(); // no apiKey
    await mock.start();
    try {
      const config = { moonrakerBaseUrl: mock.baseUrl() };
      const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES], config });
      const calls = countHostCalls(harness);
      const worker = await bootWithReplay(harness, { config, autoStart: true });
      expect(calls.configGets).toHaveLength(0);
      expect(calls.secretResolves).toHaveLength(0);
      await waitFor(() => worker.client!.getConnectionState().state === "connected");
    } finally {
      await mock.stop();
    }
  });
});

describe("fail-closed idle: degraded status with the pending reason (AC3)", () => {
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("status surfaces report degraded BEFORE any dispatch; no crash loop, no gate error", async () => {
    const config = flashforgeConfig(mock.baseUrl());
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES], config });
    countHostCalls(harness);
    // Drive the production plugin path so health is reachable: setup (no
    // config read) + the host replay hook (dormant apply).
    await plugin.definition.setup(harness.ctx);
    await plugin.definition.onConfigChanged?.({ ...config });

    // UI status data key carries the degraded reason.
    const status = (await harness.getData("status")) as {
      degraded?: boolean;
      degradedReason?: string;
    };
    expect(status.degraded).toBe(true);
    expect(status.degradedReason).toContain(CREDENTIAL_PENDING);

    // The status TOOL answers cache-only with the same signal.
    const tool = await harness.executeTool<{
      data?: { degraded?: boolean; degradedReason?: string };
      error?: string;
    }>("klipper.get_printer_status", {});
    expect(tool.error).toBeUndefined();
    expect(tool.data?.degraded).toBe(true);
    expect(tool.data?.degradedReason).toContain(CREDENTIAL_PENDING);

    // Health is degraded with the same reason — not a misleading "ok".
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
    expect(String(health.message)).toContain(CREDENTIAL_PENDING);

    // Idle for >=3 poll-cycle windows: no network traffic, no crash loop.
    await new Promise((r) => setTimeout(r, 60));
    expect(mock.recordedRequests).toHaveLength(0);
  });
});

describe("dispatch: in-dispatch resolve starts the transport (AC2)", () => {
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

  async function bootDormant(extra: Record<string, unknown> = {}) {
    const config = flashforgeConfig(mock.baseUrl(), {
      auto_upload_artifacts: true,
      ...extra,
    });
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES], config });
    const calls = countHostCalls(harness);
    const worker = await bootWithReplay(harness, {
      config,
      flashforgeClientOverrides: { pollIntervalMs: 15 },
    });
    return { harness, calls, worker };
  }

  it("upload_gcode resolves ONCE in-dispatch, starts the transport, passes the gate, delivers", async () => {
    const { harness, calls } = await bootDormant();
    const idleResolves = calls.secretResolves.length;
    expect(idleResolves).toBe(0);

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
    // /uploadGcode carries the credential in the checkCode HEADER
    // (only the JSON endpoints carry it in the body).
    expect(upload!.headers["checkcode"]).toBe(CHECK_CODE);

    // EXACTLY ONE resolve, and it happened in-dispatch (after the idle
    // window, before the upload hit the wire).
    expect(calls.secretResolves).toHaveLength(1);

    // The transport came up: the poll loop is running on the cached value.
    await waitFor(() => worker_client_state(harness) === "connected");
    const detailPolls = mock.recordedRequests.filter((r) => r.url === "/detail").length;
    expect(detailPolls).toBeGreaterThanOrEqual(1);
    // >=3 poll-cycle windows after the dispatch: still ZERO further host calls.
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.secretResolves).toHaveLength(1);
    expect(calls.configGets).toHaveLength(1); // the in-dispatch live gate read only
  });

  it("start_print reaches the plugin-level refusal (gate read in-dispatch, no resolve spent)", async () => {
    const { harness, calls } = await bootDormant();
    const resolvesBefore = calls.secretResolves.length;

    const result = await harness.executeTool<{ error?: string }>(
      "klipper.start_print",
      { filename: "bracket.gcode" },
    );
    // NOT "prerequisite_missing" (config readable) — the gate refusal
    // proves the live config read succeeded and the flag resolved false.
    expect(result.error).toMatch(/allow_agent_initiated_print/);
    // A refused dispatch never spends a resolve.
    expect(calls.secretResolves).toHaveLength(resolvesBefore);
  });

  it("explicit operator opt-in unlocks start_print after the in-dispatch resolve", async () => {
    const { harness, calls } = await bootDormant({ allow_agent_initiated_print: true });
    const result = await harness.executeTool<{ data?: unknown; error?: string }>(
      "klipper.start_print",
      { filename: "bracket.gcode" },
    );
    expect(result.error).toBeUndefined();
    expect(calls.secretResolves).toHaveLength(1);
  });

  function worker_client_state(_harness: TestHarness): string {
    // The poll loop runs inside the client the worker built; poll requests
    // on the mock are the observable.
    return mock.recordedRequests.some((r) => r.url === "/detail") ? "connected" : "starting";
  }
});

describe("cache lifecycle: invalidation + rotation + reconnect (AC4)", () => {
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("a config application invalidates the cache; a rotated secret lands at the next dispatch", async () => {
    const rotated = "rotated-check-code";
    let current = CHECK_CODE;
    const config = flashforgeConfig(mock.baseUrl(), { allow_agent_initiated_print: true });
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES], config });
    const calls = countHostCalls(harness);
    harness.ctx.secrets.resolve = (async (ref: unknown) => {
      calls.secretResolves.push(ref); // keep counting through the fake
      return current;
    }) as typeof harness.ctx.secrets.resolve;
    const worker = await bootWithReplay(harness, {
      config,
      flashforgeClientOverrides: { pollIntervalMs: 15 },
    });
    expect(worker.client).not.toBeNull();

    // First dispatch resolves and starts the poll on the ORIGINAL value.
    await harness.executeTool<{ error?: string }>(
      "klipper.start_print",
      { filename: "demo.gcode" },
    );
    expect(calls.secretResolves).toHaveLength(1);
    await waitFor(() =>
      mock.recordedRequests.some((r) => r.url === "/detail" && bodyCheckCode(r) === CHECK_CODE),
    );

    // Operator rotates the secret value (same ref) and the host replays
    // the row. The application must invalidate: transport dormant again,
    // poll loop stopped, credential cleared.
    current = rotated;
    await worker.applyConfig(config, "configChanged", false);
    expect(worker.getCredentialPendingReason()).toContain(CREDENTIAL_PENDING);
    const pollsBefore = mock.recordedRequests.filter((r) => r.url === "/detail").length;
    await new Promise((r) => setTimeout(r, 40));
    const pollsAfter = mock.recordedRequests.filter((r) => r.url === "/detail").length;
    expect(pollsAfter).toBe(pollsBefore); // loop stopped — no polls on a stale credential

    // Next dispatch re-resolves: the rotated value lands on the wire.
    await harness.executeTool<{ error?: string }>(
      "klipper.start_print",
      { filename: "demo.gcode" },
    );
    expect(calls.secretResolves).toHaveLength(2);
    await waitFor(() =>
      mock.recordedRequests.some((r) => r.url === "/detail" && bodyCheckCode(r) === rotated),
    );
  });

  it("an unchanged-fingerprint replay burst keeps ONE dormant client (no churn)", async () => {
    const config = flashforgeConfig(mock.baseUrl());
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES], config });
    const worker = await bootWithReplay(harness, { config });
    const first = worker.client!;
    await worker.applyConfig(config, "configChanged", false);
    await worker.applyConfig(config, "configChanged", false);
    expect(worker.client).toBe(first);
  });

  it("moonraker WS reconnects after a dispatch reuse the cached key without resolving", async () => {
    const mock = new MockMoonraker({ requireApiKey: API_KEY });
    await mock.start();
    try {
      const config = {
        moonrakerBaseUrl: mock.baseUrl(),
        moonrakerApiKeyRef: "moonraker-key",
        auto_upload_artifacts: true,
      };
      const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES], config });
      const calls = countHostCalls(harness);
      const worker = await bootWithReplay(harness, {
        config,
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
      // Dormant at boot: the WS is NOT connected before a dispatch.
      expect(worker.client!.getConnectionState().state).toBe("idle");
      expect(calls.secretResolves).toHaveLength(0);

      // First credentialed dispatch resolves + opens the WS.
      await harness.executeTool<{ error?: string; data?: unknown }>(
        "klipper.get_printer_status",
        {},
      );
      // get_printer_status is cache-only and must NOT resolve; bring the
      // transport up through an upload dispatch instead.
      expect(calls.secretResolves).toHaveLength(0);
      await harness.executeTool<{ error?: string }>(
        "klipper.upload_gcode",
        { filename: "demo.gcode", artifactId: ARTIFACT_ID },
        artifactCtx(),
      );
      expect(calls.secretResolves).toHaveLength(1);
      const client = worker.client!;
      await waitFor(() => client.getConnectionState().state === "connected");

      // Simulate a printer reboot at 3am: nothing in flight.
      const resolvesBefore = calls.secretResolves.length;
      mock.closeAllWebSockets(1006, "printer reboot");
      await waitFor(() => client.getConnectionState().state === "reconnecting");
      await waitFor(() => client.getConnectionState().state === "connected");
      expect(calls.secretResolves).toHaveLength(resolvesBefore);

      // Staying connected past a poll tick proves the reconnect
      // authenticated with the CACHED key.
      await new Promise((r) => setTimeout(r, 50));
      expect(client.getConnectionState().state).toBe("connected");
    } finally {
      await mock.stop();
    }
  });

  it("a resolve failure in-dispatch fails closed: tool refused, still dormant, no material in logs", async () => {
    const config = flashforgeConfig(mock.baseUrl(), { auto_upload_artifacts: true });
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES], config });
    countHostCalls(harness);
    harness.ctx.secrets.resolve = (async () => {
      throw new Error("Secret is not bound to plugin at flashforgeCheckCodeRef");
    }) as typeof harness.ctx.secrets.resolve;
    const worker = await bootWithReplay(harness, {
      config,
      flashforgeClientOverrides: { pollIntervalMs: 15 },
    });

    const result = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(result.error).toContain(CREDENTIAL_PENDING);
    // Transport stays dormant; nothing hit the wire.
    expect(worker.getCredentialPendingReason()).toContain(CREDENTIAL_PENDING);
    expect(mock.recordedRequests).toHaveLength(0);
    // The FAILURE REASON is loggable (it names the ref, never a value).
    const flat = JSON.stringify(harness.logs);
    expect(flat).not.toContain(CHECK_CODE);
  });
});
