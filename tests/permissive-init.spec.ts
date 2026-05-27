import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createKlipperWorker } from "../src/worker.js";

/**
 * PLA-502/503 — permissive worker init.
 *
 * When the worker starts without `moonrakerBaseUrl` in config, setup must:
 *   - resolve (not throw) so `plugin install` exits 0 and the host marks
 *     the plugin `ready` with `lastError: null`;
 *   - still register the RPC surface so the page slot mounts;
 *   - have every tool handler return a structured `prerequisite_missing`
 *     result (matching the CAD plugin pattern) rather than crashing.
 *
 * The existing happy-path coverage in `plugin.spec.ts` continues to assert
 * that supplying `moonrakerBaseUrl` keeps the original behavior intact.
 */

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

describe("paperclip-klipper permissive init (PLA-502/503)", () => {
  it("createKlipperWorker resolves without throwing when moonrakerBaseUrl is absent", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {},
    });
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    expect(worker.client).toBeNull();
    // The warn log line is a documented contract — operators rely on it to
    // know why a freshly installed plugin is inert.
    expect(
      harness.logs.some(
        (e) => e.level === "warn" && e.message.includes("moonrakerBaseUrl"),
      ),
    ).toBe(true);
  });

  it("get_printer_status tool returns prerequisite_missing when unconfigured", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {},
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<{
      data?: { error?: string; message?: string };
    }>("klipper.get_printer_status", {});
    expect(result.data?.error).toBe("prerequisite_missing");
    expect(result.data?.message).toMatch(/moonrakerBaseUrl/);
  });

  it("upload_gcode tool returns prerequisite_missing when unconfigured (before the auto-upload gate)", async () => {
    // Even when the upload gate would otherwise let the call through, the
    // missing-config check must short-circuit first — BEFORE the worker
    // touches `runCtx.artifacts.fetch`. If a future regression flips the
    // order and starts fetching the artifact before checking the client,
    // this test will fail loudly (the stubbed fetch would never be called
    // anyway, but the prereq-missing branch must remain first-line).
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { auto_upload_artifacts: true },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<{
      data?: { error?: string };
    }>("klipper.upload_gcode", {
      filename: "demo.gcode",
      artifactId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.data?.error).toBe("prerequisite_missing");
  });

  it("start_print tool returns prerequisite_missing when unconfigured", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { allow_agent_initiated_print: true },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const result = await harness.executeTool<{
      data?: { error?: string };
    }>("klipper.start_print", { filename: "demo.gcode" });
    expect(result.data?.error).toBe("prerequisite_missing");
  });

  it("config data key reports unconfigured state for the page slot", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {},
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const cfg = await harness.getData<{
      configured: boolean;
      moonrakerBaseUrl: string | null;
    }>("config");
    expect(cfg).toEqual({ configured: false, moonrakerBaseUrl: null });
  });

  it("status data key returns a safe snapshot (no crash) when unconfigured", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {},
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const status = await harness.getData<{
      connection: { state: string };
    }>("status");
    expect(status.connection.state).toBe("idle");
  });

  it("files data key returns an empty list when unconfigured", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {},
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const files = await harness.getData<unknown[]>("files");
    expect(files).toEqual([]);
  });

  it("refresh action throws prerequisite_missing when unconfigured", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {},
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    await expect(harness.performAction("refresh")).rejects.toThrow(
      /moonrakerBaseUrl/,
    );
  });

  it("config data key reports configured=true when moonrakerBaseUrl is set", async () => {
    // Happy-path counterpart so a future regression that breaks the
    // configured branch is caught by this same file.
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: "http://127.0.0.1:1" },
    });
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const cfg = await harness.getData<{
      configured: boolean;
      moonrakerBaseUrl: string | null;
    }>("config");
    expect(cfg.configured).toBe(true);
    expect(cfg.moonrakerBaseUrl).toBe("http://127.0.0.1:1");
  });
});
