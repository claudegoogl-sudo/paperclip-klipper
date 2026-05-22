import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { createKlipperWorker } from "../src/worker.js";
import { MockMoonraker } from "./fixtures/moonraker/mockServer.js";

/**
 * Plugin-level scaffold + RPC surface tests.
 *
 * PLA-474 contributed the manifest shape and the config-gate refusals on the
 * high-blast-radius tools; those are still asserted here so the gates can
 * never silently regress. PLA-475 added MoonrakerClient and a real RPC
 * surface — the data/action/tool happy-path assertions now go through the
 * mock Moonraker fixture instead of returning a `todo` stub.
 *
 * Full MoonrakerClient coverage (REST, WS, reconnect, redaction) lives in
 * `MoonrakerClient.spec.ts`.
 */

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

describe("paperclip-klipper manifest (PLA-474)", () => {
  it("declares the required surface", () => {
    expect(manifest.id).toBe("platform.klipper");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        "http.outbound",
        "secrets.read-ref",
        "agent.tools.register",
        "events.subscribe",
        "ui.page.register",
      ]),
    );
    // PLA-480 — capability count must stay at five (issue AC §1). The
    // PLA-473 Q1 resolution swapped `ui.dashboardWidget.register` for
    // `ui.page.register`; no net addition.
    expect(manifest.capabilities).toHaveLength(5);
    expect(manifest.capabilities).not.toContain("ui.dashboardWidget.register");
    expect(manifest.ui?.slots).toEqual([
      {
        type: "page",
        id: "klipper-page",
        displayName: "Printer",
        exportName: "Page",
        routePath: "printer",
      },
    ]);
    expect(manifest.tools?.map((t) => t.name)).toEqual([
      "klipper.get_printer_status",
      "klipper.upload_gcode",
      "klipper.start_print",
    ]);
    expect(manifest.instanceConfigSchema).toMatchObject({
      type: "object",
      required: ["moonrakerBaseUrl"],
      additionalProperties: false,
    });
    const props = (manifest.instanceConfigSchema as { properties: Record<string, unknown> }).properties;
    expect(props.moonrakerApiKeyRef).toMatchObject({ format: "secret-ref" });
  });
});

describe("paperclip-klipper config gates (PLA-474)", () => {
  // These tests don't need a mock Moonraker — the gates refuse before any
  // network call is made, so we can run them against a never-bound URL.
  const config = { moonrakerBaseUrl: "http://127.0.0.1:1" };

  it("upload_gcode refuses when auto_upload_artifacts is unset", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...CAPABILITIES], config });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<{ error?: string }>(
      "upload_gcode",
      { filename: "test.gcode", gcodeBase64: Buffer.from("G28\n").toString("base64") },
    );
    expect(result.error).toMatch(/auto_upload_artifacts/);
  });

  it("start_print refuses when allow_agent_initiated_print is unset", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...CAPABILITIES], config });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<{ error?: string }>(
      "start_print",
      { filename: "test.gcode" },
    );
    expect(result.error).toMatch(/allow_agent_initiated_print/);
  });

  it("default plugin.setup() under VITEST does not open a WebSocket", async () => {
    // Guards the regression where a stray real-WS open caused vitest to
    // hang. setup() must skip auto-start when VITEST=true.
    expect(process.env.VITEST).toBe("true");
    const harness = createTestHarness({ manifest, capabilities: [...CAPABILITIES], config });
    await plugin.definition.setup(harness.ctx);
    // Nothing to wait on; if a real WS open had been attempted, the
    // process would log a connection failure to a non-listening port.
    // The assertion is implicit: this test completes without timing out.
  });
});

describe("paperclip-klipper RPC surface (PLA-475)", () => {
  let mock: MockMoonraker;

  beforeEach(async () => {
    mock = new MockMoonraker();
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("get_printer_status tool returns a structured snapshot", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<{ data?: { connection: { state: string } } }>(
      "get_printer_status",
      {},
    );
    expect(result.data?.connection.state).toBe("idle");
  });

  it("refresh action fetches /printer/info via the mock", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.performAction<{ ok: boolean; info: { state?: string } }>(
      "refresh",
    );
    expect(result.ok).toBe(true);
    expect(result.info.state).toBe("ready");
  });

  it("upload_gcode succeeds when the gate is open", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl(), auto_upload_artifacts: true },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<{ data?: { item: { path: string } }; error?: string }>(
      "upload_gcode",
      {
        filename: "demo.gcode",
        gcodeBase64: Buffer.from("G28\n").toString("base64"),
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.item.path).toBe("demo.gcode");
  });

  it("start_print succeeds when the gate is open", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl(), allow_agent_initiated_print: true },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<{ data?: { ok: boolean }; error?: string }>(
      "start_print",
      { filename: "demo.gcode" },
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.ok).toBe(true);
  });

  it("status data key reflects connection state", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const status = await harness.getData<{ connection: { state: string } }>("status");
    expect(status.connection.state).toBe("idle");
  });
});

describe("paperclip-klipper UI actions (PLA-482)", () => {
  // The actions registered for the UI buttons (start_print, delete_file,
  // resume_print) are intentionally NOT gated on `allow_agent_initiated_print`
  // — the user tap is the consent signal. Each action gets a success path
  // against the mock fixture plus an error path (mock stopped) so the
  // failure surface the UI relies on is exercised.
  let mock: MockMoonraker;

  beforeEach(async () => {
    mock = new MockMoonraker();
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("start_print action triggers POST /printer/print/start", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.performAction<{ ok: boolean; result: string }>(
      "start_print",
      { filename: "demo.gcode" },
    );
    expect(result).toEqual({ ok: true, result: "ok" });
    expect(
      mock.recordedRequests.some(
        (r) => r.method === "POST" && r.url.startsWith("/printer/print/start"),
      ),
    ).toBe(true);
  });

  it("start_print action is NOT gated on allow_agent_initiated_print", async () => {
    // The agent tool with the same name IS gated; the UI action must not be.
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {
        moonrakerBaseUrl: mock.baseUrl(),
        // allow_agent_initiated_print intentionally absent
      },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.performAction<{ ok: boolean }>(
      "start_print",
      { filename: "demo.gcode" },
    );
    expect(result.ok).toBe(true);
  });

  it("start_print action surfaces HTTP failure as a thrown error", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    await mock.stop(); // force a connect error on the next request
    await expect(
      harness.performAction("start_print", { filename: "demo.gcode" }),
    ).rejects.toThrow();
  });

  it("delete_file action triggers DELETE /server/files/<root>/<path>", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.performAction<{ ok: boolean; item: { path: string; root: string } }>(
      "delete_file",
      { path: "demo.gcode", root: "gcodes" },
    );
    expect(result.ok).toBe(true);
    expect(result.item.root).toBe("gcodes");
    expect(
      mock.recordedRequests.some(
        (r) => r.method === "DELETE" && r.url === "/server/files/gcodes/demo.gcode",
      ),
    ).toBe(true);
  });

  it("delete_file action rejects when `path` is missing", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    await expect(harness.performAction("delete_file", {})).rejects.toThrow(/path/);
  });

  it("resume_print action triggers POST /printer/print/resume", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.performAction<{ ok: boolean; result: string }>(
      "resume_print",
    );
    expect(result).toEqual({ ok: true, result: "ok" });
    expect(
      mock.recordedRequests.some(
        (r) => r.method === "POST" && r.url === "/printer/print/resume",
      ),
    ).toBe(true);
  });

  it("resume_print action surfaces HTTP failure as a thrown error", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    await mock.stop();
    await expect(harness.performAction("resume_print")).rejects.toThrow();
  });
});
