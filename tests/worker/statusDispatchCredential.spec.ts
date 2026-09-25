/**
 * Tool dispatches resolve the DISPATCHING company's transport from the live
 * config before deciding `prerequisite_missing` (0.2.10).
 *
 * The worker is shared by every company. At boot it may hold another
 * company's idle Moonraker client, or no client at all (a bare worker
 * restart with no config replay). Before 0.2.10:
 *   - `klipper.get_printer_status` never resolved in-dispatch and returned
 *     whatever idle client the worker held;
 *   - all three tools returned `prerequisite_missing` from the client
 *     null-guard BEFORE the in-dispatch resolution could build the client.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { createRunCtxAwareHarness } from "../helpers/runCtxAwareHarness.js";
import manifest from "../../src/manifest.js";
import { createKlipperWorker } from "../../src/worker.js";
import { MockFlashForge } from "../fixtures/flashforge/mockServer.js";
import { MockMoonraker } from "../fixtures/moonraker/mockServer.js";

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

const SERIAL = "SN-TEST-STATUS";
const CHECK_CODE = "status-dispatch-check-code";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const GCODE = new Uint8Array([0x47, 0x31, 0x20, 0x58, 0x31, 0x30, 0x0a]);
const COMPANY_A = "company-a-moonraker";
const COMPANY_B = "company-b-flashforge";

function artifactCtx() {
  return {
    companyId: COMPANY_B,
    artifacts: {
      async create() {
        throw new Error("unused");
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

function flashforgeConfig(baseUrl: string, extra: Record<string, unknown> = {}) {
  return {
    transport: "flashforge" as const,
    flashforgeBaseUrl: baseUrl,
    flashforgeSerialNumber: SERIAL,
    flashforgeCheckCodeRef: "flashforge-check-code",
    ...extra,
  };
}

function countResolves(harness: TestHarness, fail = false) {
  const resolves: unknown[] = [];
  harness.ctx.secrets.resolve = (async (ref: unknown) => {
    resolves.push(ref);
    if (fail) throw new Error("secret lookup denied");
    return CHECK_CODE;
  }) as typeof harness.ctx.secrets.resolve;
  return resolves;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

type StatusResult = {
  error?: string;
  data?: {
    error?: string;
    degraded?: boolean;
    degradedReason?: string;
    connection?: { state?: string };
  } & Record<string, unknown>;
};

describe("get_printer_status resolves the dispatching company's transport", () => {
  let ff: MockFlashForge;
  let moon: MockMoonraker;

  beforeEach(async () => {
    ff = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE });
    await ff.start();
    moon = new MockMoonraker();
    await moon.start();
  });

  afterEach(async () => {
    await ff.stop();
    await moon.stop();
  });

  it("AC1: boot config = company A moonraker; status for company B flashforge returns the FlashForge snapshot", async () => {
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES] });
    const resolves = countResolves(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    await worker.applyConfig({ moonrakerBaseUrl: moon.baseUrl() }, "configChanged", false);
    expect(worker.client?.kind).toBe("moonraker");

    harness.setConfig(flashforgeConfig(ff.baseUrl()));
    const first = await harness.executeTool<StatusResult>("klipper.get_printer_status", {}, {
      companyId: COMPANY_B,
    });
    expect(first.error).toBeUndefined();
    expect(first.data?.error).not.toBe("prerequisite_missing");
    expect(resolves).toHaveLength(1);
    expect(worker.client?.kind).toBe("flashforge");

    await waitFor(() => ff.recordedRequests.some((r) => r.url === "/detail"));
    await waitFor(() => JSON.stringify(worker.client!.getStatusSnapshot()).includes("machineState"));
    const second = await harness.executeTool<StatusResult>("klipper.get_printer_status", {}, {
      companyId: COMPANY_B,
    });
    expect(JSON.stringify(second.data)).toContain("machineState");
    expect(second.data?.degraded).toBeUndefined();
    // Cached credential: the second status dispatch spends no resolve.
    expect(resolves).toHaveLength(1);
    // The Moonraker boot client of company A was never driven.
    expect(moon.recordedRequests ?? []).toHaveLength(0);
    // Read-only (AC4): status never uploads, prints or deletes.
    expect(ff.uploadedFiles).toHaveLength(0);
    expect(ff.printJobs).toHaveLength(0);
    expect(ff.recordedRequests.map((r) => r.url)).not.toContain("/uploadGcode");
    expect(ff.recordedRequests.map((r) => r.url)).not.toContain("/printGcode");
    expect(ff.recordedRequests.map((r) => r.url)).not.toContain("/control");
    worker.client?.stop();
  });

  it("AC2: worker with NO applied config (bare restart) resolves status from the live config", async () => {
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: flashforgeConfig(ff.baseUrl()),
    });
    const resolves = countResolves(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    expect(worker.client).toBeNull();

    const result = await harness.executeTool<StatusResult>("klipper.get_printer_status", {}, {
      companyId: COMPANY_B,
    });
    expect(result.error).toBeUndefined();
    expect(result.data?.error).not.toBe("prerequisite_missing");
    expect(resolves).toHaveLength(1);
    expect(worker.client?.kind).toBe("flashforge");
    worker.client?.stop();
  });

  it("AC2: an incomplete live config on a bare worker is still prerequisite_missing", async () => {
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: flashforgeConfig(ff.baseUrl(), { flashforgeSerialNumber: "" }),
    });
    const resolves = countResolves(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<StatusResult>("klipper.get_printer_status", {});
    expect(result.data?.error).toBe("prerequisite_missing");
    expect(resolves).toHaveLength(0);
    expect(worker.client).toBeNull();
  });

  it("AC5: a resolve failure is soft — degraded reason, no throw, no secret text", async () => {
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: flashforgeConfig(ff.baseUrl()),
    });
    countResolves(harness, true);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<StatusResult>("klipper.get_printer_status", {}, {
      companyId: COMPANY_B,
    });
    expect(result.error).toBeUndefined();
    expect(result.data?.degraded).toBe(true);
    expect(result.data?.degradedReason).toContain("credential not resolved yet");
    expect(JSON.stringify(result)).not.toContain(CHECK_CODE);
    expect(JSON.stringify(result)).not.toContain("flashforge-check-code");
    expect(ff.recordedRequests).toHaveLength(0);
    expect(worker.client).toBeNull();
  });

  it("AC5: a resolve failure never returns another company's held snapshot", async () => {
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES] });
    countResolves(harness, true);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    await worker.applyConfig({ moonrakerBaseUrl: moon.baseUrl() }, "configChanged", false);
    harness.setConfig(flashforgeConfig(ff.baseUrl()));
    const result = await harness.executeTool<StatusResult>("klipper.get_printer_status", {}, {
      companyId: COMPANY_B,
    });
    expect(result.data?.degraded).toBe(true);
    expect(result.data?.connection?.state).toBe("idle");
    expect(result.data?.objects ?? null).toBeNull();
  });
});

describe("upload_gcode / start_print reach the in-dispatch resolve on a bare worker", () => {
  let ff: MockFlashForge;

  beforeEach(async () => {
    ff = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE, gcodeList: ["bracket.gcode"] });
    await ff.start();
  });

  afterEach(async () => {
    await ff.stop();
  });

  it("AC3: upload_gcode builds the transport from the live config (no prerequisite_missing)", async () => {
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: flashforgeConfig(ff.baseUrl(), { auto_upload_artifacts: true }),
    });
    const resolves = countResolves(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    expect(worker.client).toBeNull();
    const result = await harness.executeTool<{ error?: string; data?: { error?: string } }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.error).not.toBe("prerequisite_missing");
    expect(resolves).toHaveLength(1);
    expect(ff.uploadedFiles.map((f) => f.filename)).toEqual(["bracket.gcode"]);
    worker.client?.stop();
  });

  it("AC3: start_print builds the transport from the live config (no prerequisite_missing)", async () => {
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: flashforgeConfig(ff.baseUrl(), { allow_agent_initiated_print: true }),
    });
    const resolves = countResolves(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<{ error?: string; data?: { error?: string; ok?: boolean } }>(
      "klipper.start_print",
      { filename: "bracket.gcode" },
      { companyId: COMPANY_B },
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.ok).toBe(true);
    expect(resolves).toHaveLength(1);
    expect(ff.printJobs).toEqual(["bracket.gcode"]);
    worker.client?.stop();
  });

  it("AC3: incomplete live config on a bare worker → prerequisite_missing, no resolve", async () => {
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { transport: "flashforge", auto_upload_artifacts: true, allow_agent_initiated_print: true },
    });
    const resolves = countResolves(harness);
    await createKlipperWorker(harness.ctx, { autoStart: false });
    for (const [tool, params] of [
      ["klipper.upload_gcode", { filename: "bracket.gcode", artifactId: ARTIFACT_ID }],
      ["klipper.start_print", { filename: "bracket.gcode" }],
    ] as const) {
      const r = await harness.executeTool<{ data?: { error?: string } }>(tool, params, artifactCtx());
      expect(r.data?.error).toBe("prerequisite_missing");
    }
    expect(resolves).toHaveLength(0);
  });

  it("AC4: print gate still refuses start_print on a bare worker (no resolve spent)", async () => {
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: flashforgeConfig(ff.baseUrl()),
    });
    const resolves = countResolves(harness);
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const print = await harness.executeTool<{ error?: string }>(
      "klipper.start_print",
      { filename: "bracket.gcode" },
      { companyId: COMPANY_B },
    );
    expect(print.error).toMatch(/allow_agent_initiated_print is false/);
    const upload = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(upload.error).toMatch(/auto_upload_artifacts is false/);
    expect(resolves).toHaveLength(0);
    expect(ff.printJobs).toHaveLength(0);
    expect(ff.uploadedFiles).toHaveLength(0);
  });
});
