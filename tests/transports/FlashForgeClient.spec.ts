/**
 * FlashForgeClient unit coverage against the in-process mock printer
 * (tests/fixtures/flashforge/mockServer.ts). No physical printer is
 * touched — every assertion runs against recorded HTTP requests.
 *
 * Covers the acceptance surface:
 *   - upload: exact method/path/multipart shape, auth + metadata headers,
 *     `printNow` hard-false (no upload may imply a print).
 *   - status: /detail → Moonraker-compatible snapshot objects mapping.
 *   - health: fresh-probe reachability, fail-closed on 5xx / dropped
 *     connections / refused ports.
 *   - job control + file list shapes.
 *   - the check code credential never appears in logger output.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginHttpClient, PluginLogger } from "@paperclipai/plugin-sdk";
import {
  FlashForgeClient,
  detailToSnapshotObjects,
  mapMachineState,
  type FlashForgeClientOptions,
} from "../../src/worker/transports/FlashForgeClient.js";
import { MockFlashForge } from "../fixtures/flashforge/mockServer.js";

const SERIAL = "SN-TEST-C5";
const CHECK_CODE = "CHECK-CODE-TEST";

interface CapturedLog {
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

function makeCapturingLogger(logs: CapturedLog[]): PluginLogger {
  return {
    debug: (message: string, meta?: Record<string, unknown>) => logs.push({ level: "debug", message, meta }),
    info: (message: string, meta?: Record<string, unknown>) => logs.push({ level: "info", message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) => logs.push({ level: "warn", message, meta }),
    error: (message: string, meta?: Record<string, unknown>) => logs.push({ level: "error", message, meta }),
  };
}

function makeHttp(): PluginHttpClient {
  return {
    // The FlashForge client only issues string bodies + plain headers, so
    // the widened PluginHttpFetchInit narrows cleanly for native fetch.
    fetch: (url, init) =>
      fetch(url, {
        method: init?.method,
        headers: init?.headers as HeadersInit | undefined,
        body: init?.body as BodyInit | null | undefined,
      }),
  };
}

function headerOf(
  req: { headers: Record<string, string | string[] | undefined> },
  name: string,
): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

describe("FlashForgeClient — upload (mock HTTP API)", () => {
  let mock: MockFlashForge;
  let logs: CapturedLog[];

  beforeEach(async () => {
    logs = [];
    mock = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  function makeClient(overrides: Partial<FlashForgeClientOptions> = {}) {
    return new FlashForgeClient({
      baseUrl: mock.baseUrl(),
      serialNumber: SERIAL,
    checkCode: CHECK_CODE,
      http: makeHttp(),
      logger: makeCapturingLogger(logs),
      // Never schedule follow-up polls in these tests.
      pollIntervalMs: 60_000,
      ...overrides,
    });
  }

  it("delivers the G-code to POST /uploadGcode with the reference-client header set", async () => {
    const client = makeClient();
    const payload = new Uint8Array([0x47, 0x31, 0x0a]); // "G1\n"

    const result = await client.uploadGcode("bracket.gcode", payload);

    // AC2: the actual HTTP request is asserted.
    const upload = mock.recordedRequests.find((r) => r.url === "/uploadGcode");
    expect(upload, "no upload request reached the mock printer").toBeDefined();
    expect(upload!.method).toBe("POST");

    const headers = upload!.headers;
    expect(headerOf({ headers }, "serialnumber")).toBe(SERIAL);
    expect(headerOf({ headers }, "checkcode")).toBe(CHECK_CODE);
    expect(headerOf({ headers }, "filesize")).toBe("3");
    // SECURITY: printNow is hard-false; leveling is never requested.
    expect(headerOf({ headers }, "printnow")).toBe("false");
    expect(headerOf({ headers }, "levelingbeforeprint")).toBe("false");
    expect(headerOf({ headers }, "flowcalibration")).toBe("false");
    expect(headerOf({ headers }, "usematlstation")).toBe("false");
    expect(headerOf({ headers }, "gcodetoolcnt")).toBe("0");
    // base64("[]") — empty material mapping list.
    expect(headerOf({ headers }, "materialmappings")).toBe("W10=");

    // Multipart: field name gcodeFile, filename, payload bytes present,
    // Content-Type carries the boundary that appears in the body.
    const ct = headerOf({ headers }, "content-type") ?? "";
    expect(ct).toMatch(/^multipart\/form-data; boundary=.+/);
    const body = upload!.body!.toString("latin1");
    expect(ct.replace(/^.*boundary=/, "")).toBeTruthy();
    expect(body).toContain('name="gcodeFile"');
    expect(body).toContain('filename="bracket.gcode"');
    expect(body).toContain("G1\n");

    // The tool-facing result reports the uploaded filename.
    expect(result.item.path).toBe("bracket.gcode");
    expect(result.item.size).toBe(3);
    expect(result.print_started).toBe(false);
  });

  it("rejects a subdirectory path option (no such concept on FlashForge)", async () => {
    const client = makeClient();
    await expect(
      client.uploadGcode("x.gcode", new Uint8Array([1]), { path: "sub/dir" }),
    ).rejects.toThrow(/does not support a subdirectory path/i);
    expect(mock.recordedRequests.filter((r) => r.url === "/uploadGcode")).toHaveLength(0);
  });

  it("fails the upload when the printer rejects the credentials", async () => {
    const client = new FlashForgeClient({
      baseUrl: mock.baseUrl(),
      serialNumber: "WRONG-SN",
    checkCode: CHECK_CODE,
      http: makeHttp(),
      logger: makeCapturingLogger(logs),
    });
    await expect(
      client.uploadGcode("x.gcode", new Uint8Array([1])),
    ).rejects.toThrow(/FlashForge 200 \(code 1\)/);
  });

  it("never writes the resolved check code to any log line", async () => {
    const client = makeClient();
    await client.uploadGcode("x.gcode", new Uint8Array([1, 2, 3]));
    // Force a failing request too — error paths must redact as well.
    mock.failureMode = "http500";
    await client.probeHealth().catch(() => undefined);
    const all = logs.map((l) => `${l.message} ${JSON.stringify(l.meta ?? {})}`).join("\n");
    expect(all).not.toContain(CHECK_CODE);
  });
});

describe("FlashForgeClient — status, files, jobs, print start", () => {
  let mock: MockFlashForge;
  let logs: CapturedLog[];

  beforeEach(async () => {
    logs = [];
    mock = new MockFlashForge({
      serialNumber: SERIAL,
      checkCode: CHECK_CODE,
      gcodeList: ["bracket.gcode", "gear.gcode"],
    });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  function makeClient() {
    return new FlashForgeClient({
      baseUrl: mock.baseUrl(),
      serialNumber: SERIAL,
    checkCode: CHECK_CODE,
      http: makeHttp(),
      logger: makeCapturingLogger(logs),
      pollIntervalMs: 60_000,
    });
  }

  it("polls /detail into a Moonraker-compatible snapshot and reports connected", async () => {
    const client = makeClient();
    await client.start();
    try {
      expect(client.getConnectionState().state).toBe("connected");
      const snapshot = client.getStatusSnapshot();
      expect(snapshot.updatedAt).toBeTruthy();
      const printStats = snapshot.objects.print_stats as Record<string, unknown>;
      expect(printStats.state).toBe("standby");
      const extruder = snapshot.objects.extruder as Record<string, unknown>;
      expect(extruder.temperature).toBe(25.1);
      const bed = snapshot.objects.heater_bed as Record<string, unknown>;
      expect(bed.temperature).toBe(24.5);
      const ff = snapshot.objects.flashforge as Record<string, unknown>;
      expect(ff.model).toBe("Creator 5");
      expect(ff.firmwareVersion).toBe("1.9.2");
    } finally {
      client.stop();
    }
  });

  it("lists files from /gcodeList", async () => {
    const client = makeClient();
    const files = await client.listFiles();
    expect(files.map((f) => f.path)).toEqual(["bracket.gcode", "gear.gcode"]);
  });

  it("starts a print via POST /printGcode with the new-firmware payload", async () => {
    const client = makeClient();
    await client.startPrint("bracket.gcode");
    const req = mock.recordedRequests.find((r) => r.url === "/printGcode");
    expect(req).toBeDefined();
    const parsed = JSON.parse(req!.body!.toString("utf8"));
    expect(parsed.serialNumber).toBe(SERIAL);
    expect(parsed.checkCode).toBe(CHECK_CODE);
    expect(parsed.fileName).toBe("bracket.gcode");
    expect(parsed.levelingBeforePrint).toBe(false);
    expect(parsed.flowCalibration).toBe(false);
    expect(parsed.useMatlStation).toBe(false);
    expect(parsed.gcodeToolCnt).toBe(0);
    expect(parsed.materialMappings).toEqual([]);
    expect(mock.printJobs).toEqual(["bracket.gcode"]);
  });

  it("sends pause/resume/cancel through /control jobCtl_cmd", async () => {
    const client = makeClient();
    await client.pausePrint();
    await client.resumePrint();
    await client.cancelPrint();
    expect(mock.jobControlCommands).toEqual(["pause", "continue", "cancel"]);
  });

  it("refuses moonraker-only operations with a clear error", async () => {
    const client = makeClient();
    await expect(client.getFileMetadata("x.gcode")).rejects.toThrow(
      /not supported by the flashforge transport/,
    );
    await expect(client.deleteFile("x.gcode")).rejects.toThrow(
      /not supported by the flashforge transport/,
    );
    await expect(client.queryObjects({})).rejects.toThrow(
      /not supported by the flashforge transport/,
    );
  });
});

describe("FlashForgeClient — fail-closed health", () => {
  let mock: MockFlashForge;
  let logs: CapturedLog[];

  beforeEach(async () => {
    logs = [];
    mock = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  function makeClient(baseUrl: string) {
    return new FlashForgeClient({
      baseUrl,
      serialNumber: SERIAL,
    checkCode: CHECK_CODE,
      http: makeHttp(),
      logger: makeCapturingLogger(logs),
      pollIntervalMs: 60_000,
      probeTimeoutMs: 2_000,
    });
  }

  it("reports reachable with machine state when the printer answers", async () => {
    const report = await makeClient(mock.baseUrl()).probeHealth();
    expect(report.reachable).toBe(true);
    expect(report.message).toContain("ready");
    expect((report.details as Record<string, unknown>).machineState).toBe("ready");
  });

  it("reports unreachable on HTTP 500 (fail closed)", async () => {
    mock.failureMode = "http500";
    const report = await makeClient(mock.baseUrl()).probeHealth();
    expect(report.reachable).toBe(false);
  });

  it("reports unreachable on a dropped connection (fail closed)", async () => {
    mock.failureMode = "drop";
    const report = await makeClient(mock.baseUrl()).probeHealth();
    expect(report.reachable).toBe(false);
  });

  it("reports unreachable on a refused port (fail closed)", async () => {
    await mock.stop();
    const report = await makeClient("http://127.0.0.1:1").probeHealth();
    expect(report.reachable).toBe(false);
    expect(report.message).toContain("unreachable");
  });
});

describe("FlashForgeClient — poll failure lifecycle", () => {
  it("surfaces reconnecting → failed and recovers via retryConnection", async () => {
    const logs: CapturedLog[] = [];
    // Bind a port, stop the printer, then point the client at the dead
    // port (connection refused is immediate — no fake timers needed).
    const mock = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE });
    const port = await mock.start();
    await mock.stop();
    const client = new FlashForgeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      serialNumber: SERIAL,
    checkCode: CHECK_CODE,
      http: makeHttp(),
      logger: makeCapturingLogger(logs),
      pollIntervalMs: 10,
      maxAttempts: 1,
    });
    await client.start();
    expect(client.getConnectionState().state).toBe("failed");
    expect(client.getConnectionState().attempts).toBe(1);

    // Bring the printer back up on the SAME port and retry.
    await mock.start();
    try {
      await client.retryConnection();
      expect(client.getConnectionState().state).toBe("connected");
      expect(client.getStatusSnapshot().objects.print_stats).toBeDefined();
    } finally {
      client.stop();
      await mock.stop();
    }
  });
});

describe("FlashForge machine-state mapping", () => {
  it("maps firmware states onto Klipper print_stats states the UI renders", () => {
    expect(mapMachineState("ready")).toBe("standby");
    expect(mapMachineState("busy")).toBe("standby");
    expect(mapMachineState("downloading")).toBe("standby");
    expect(mapMachineState("printing")).toBe("printing");
    expect(mapMachineState("heating")).toBe("printing");
    expect(mapMachineState("pause")).toBe("paused");
    expect(mapMachineState("paused")).toBe("paused");
    expect(mapMachineState("pausing")).toBe("paused");
    expect(mapMachineState("cancel")).toBe("cancelled");
    expect(mapMachineState("completed")).toBe("complete");
    expect(mapMachineState("error")).toBe("error");
    // Unknown firmware values surface verbatim — never guessed as idle.
    expect(mapMachineState("martian_mode")).toBe("martian_mode");
  });

  it("maps a printing /detail payload into the snapshot object set", () => {
    const objects = detailToSnapshotObjects({
      status: "printing",
      printFileName: "benchy.gcode",
      printProgress: 0.42,
      printDuration: 630,
      printLayer: 21,
      targetPrintLayer: 50,
      nozzleTemps: [210.5, 205],
      nozzleTargetTemps: [210, 205],
      platTemp: 60,
      platTargetTemp: 60,
    });
    expect(objects.print_stats).toMatchObject({
      state: "printing",
      filename: "benchy.gcode",
      print_duration: 630,
      info: { current_layer: 21, total_layer: 50 },
    });
    expect(objects.extruder).toMatchObject({ temperature: 210.5, target: 210 });
    expect(objects.heater_bed).toMatchObject({ temperature: 60, target: 60 });
    expect(objects.virtual_sdcard).toMatchObject({ progress: 0.42 });
    // Single-nozzle fallback when the per-tool arrays are absent.
    const fallback = detailToSnapshotObjects({
      status: "ready",
      rightTemp: 25,
      rightTargetTemp: 0,
    });
    expect(fallback.extruder).toMatchObject({ temperature: 25, target: 0 });
  });
});
