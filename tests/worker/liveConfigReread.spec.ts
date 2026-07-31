/**
 * The opt-in gate flags (`auto_upload_artifacts`,
 * `allow_agent_initiated_print`) must be re-read from config on EVERY dispatch,
 * never captured once at setup(). A single worker process interleaves
 * dispatches for many tenant companies, so a config change (an admin toggling
 * a gate flag) — or the host scoping a different company's config onto the next
 * dispatch — must be reflected on the very next tool call, with no worker
 * restart. These drive the RPC surface through the SDK test harness and use
 * `harness.setConfig()` to mutate config BETWEEN two dispatches with no
 * re-registration in between, proving the read happens inside the handler.
 */
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { MoonrakerClient } from "../../src/worker/MoonrakerClient.js";
import { registerRpcSurface } from "../../src/worker/registerRpcSurface.js";
import manifest from "../../src/manifest.js";

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";

function setupHarness(initialConfig: Record<string, unknown>) {
  const startCalls: string[] = [];
  const uploadCalls: string[] = [];
  const fakeClient = {
    async startPrint(filename: string) {
      startCalls.push(filename);
      return { ok: true };
    },
    async uploadGcode(filename: string, bytes: Uint8Array) {
      uploadCalls.push(filename);
      return {
        item: { path: filename, root: "gcodes", size: bytes.length, modified: 0 },
        print_started: false,
      };
    },
  } as unknown as MoonrakerClient;

  const harness = createTestHarness({
    manifest,
    capabilities: [...CAPABILITIES],
    config: initialConfig,
  });
  // The client is a legitimate setup-time singleton; only the config read
  // moves per-dispatch. Register once, mutate config later via setConfig.
  registerRpcSurface(harness.ctx, {
    config: initialConfig as never,
    client: fakeClient,
  });

  const startPrint = () =>
    harness.executeTool<{ data?: unknown; error?: string }>(
      "klipper.start_print",
      { filename: "demo.gcode" },
      {},
    );

  const uploadGcode = () =>
    harness.executeTool<{ data?: unknown; error?: string }>(
      "klipper.upload_gcode",
      { filename: "demo.gcode", artifactId: ARTIFACT_ID },
      {
        artifacts: {
          async fetch() {
            return {
              bytes: new Uint8Array([0x47, 0x31]),
              filename: "demo.gcode",
              contentType: "application/octet-stream",
              byteSize: 2,
            };
          },
        },
      },
    );

  return { harness, startCalls, uploadCalls, startPrint, uploadGcode };
}

describe("config gates are re-read live on every dispatch (no setup-time caching)", () => {
  it("klipper.start_print picks up allow_agent_initiated_print enabled AFTER setup, on the next call", async () => {
    const base = { moonrakerBaseUrl: "http://printer.lan:7125" };
    const { harness, startCalls, startPrint } = setupHarness({
      ...base,
      allow_agent_initiated_print: false,
    });

    const before = await startPrint();
    expect(before.error).toMatch(/allow_agent_initiated_print is false/);
    expect(startCalls).toHaveLength(0);

    // Admin enables the gate — no re-registration / worker restart.
    harness.setConfig({ ...base, allow_agent_initiated_print: true });

    const after = await startPrint();
    expect(after.error).toBeUndefined();
    expect(startCalls).toEqual(["demo.gcode"]);
  });

  it("klipper.upload_gcode picks up auto_upload_artifacts enabled AFTER setup, on the next call", async () => {
    const base = { moonrakerBaseUrl: "http://printer.lan:7125" };
    const { harness, uploadCalls, uploadGcode } = setupHarness({
      ...base,
      auto_upload_artifacts: false,
    });

    const before = await uploadGcode();
    expect(before.error).toMatch(/auto_upload_artifacts is false/);
    expect(uploadCalls).toHaveLength(0);

    harness.setConfig({ ...base, auto_upload_artifacts: true });

    const after = await uploadGcode();
    expect(after.error).toBeUndefined();
    expect(uploadCalls).toEqual(["demo.gcode"]);
  });

  it("two back-to-back start_print dispatches each see the live gate value, never a cached one", async () => {
    const base = { moonrakerBaseUrl: "http://printer.lan:7125" };
    const { harness, startCalls, startPrint } = setupHarness({
      ...base,
      allow_agent_initiated_print: true,
    });

    // First dispatch: gate open → allowed.
    const first = await startPrint();
    expect(first.error).toBeUndefined();
    expect(startCalls).toEqual(["demo.gcode"]);

    // The dispatching tenant's config changes between calls (gate now closed).
    // If the handler cached the setup-time value it would stay open forever.
    harness.setConfig({ ...base, allow_agent_initiated_print: false });

    const second = await startPrint();
    expect(second.error).toMatch(/allow_agent_initiated_print is false/);
    // No second startPrint reached the client — the gate re-evaluated live.
    expect(startCalls).toEqual(["demo.gcode"]);
  });

  it("fails closed and logs at error when the use-time config read throws", async () => {
    const base = { moonrakerBaseUrl: "http://printer.lan:7125" };
    const { harness, startCalls, startPrint } = setupHarness({
      ...base,
      allow_agent_initiated_print: true,
    });

    // Simulate a host RPC failure on the use-time config read.
    harness.ctx.config.get = (async () => {
      throw new Error("host config RPC unavailable");
    }) as typeof harness.ctx.config.get;

    const result = await startPrint();
    // Fail-closed: the `=== true` gate denies on an empty config.
    expect(result.error).toMatch(/allow_agent_initiated_print is false/);
    expect(startCalls).toHaveLength(0);
    // Loud, not swallowed: logged at error with plugin + method.
    expect(
      harness.logs.some(
        (e) =>
          e.level === "error" &&
          e.message === "klipper.config_read_failed" &&
          e.meta?.method === "start_print" &&
          e.meta?.plugin === "platform.klipper",
      ),
    ).toBe(true);
  });
});
