/**
 * Boot-time config contract + host replay.
 *
 * The host spawns plugin workers with an EMPTY bootstrap config and replays
 * each configured company's stored row through the `configChanged` RPC right
 * after boot. setup() makes NO `ctx.config.get()` call at all — a
 * worker→host call from setup runs in service scope with nothing in flight,
 * and the host's single-in-flight attribution permanently DENIES the method
 * for the worker's lifetime (an early version did attempt a best-effort
 * setup read; the denial poisoned `config.get` so every later in-dispatch
 * gate re-read failed closed). The worker must:
 *
 *   1. boot permissive WITHOUT touching `ctx.config.get()` — zero
 *      worker→host calls at spawn, lifecycle holds `ready`, and the three
 *      manifest tools stay registered (returning `prerequisite_missing`);
 *   2. apply the config the host replays through `onConfigChanged` and start
 *      the Moonraker client from it, with no worker restart;
 *   3. converge on the per-company replay burst (identical replays must not
 *      churn clients), stop the old client when the connection identity
 *      actually changes, and degrade back to permissive init when the replayed
 *      config is absent or invalid — never crash the worker.
 */
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../src/manifest.js";
import plugin, { createKlipperWorker } from "../../src/worker.js";

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

const BASE_CONFIG = { moonrakerBaseUrl: "http://printer.lan:7125" };

/**
 * Count `ctx.config.get()` calls. The boot contract is that setup NEVER
 * calls it (a service-scope call with nothing in flight permanently poisons
 * the method on real hosts), so every test in this file can assert the
 * counter stays at zero until a dispatch-driven read happens.
 */
function countConfigReads(harness: ReturnType<typeof createTestHarness>) {
  const calls = { count: 0 };
  const orig = harness.ctx.config.get.bind(harness.ctx.config.get);
  harness.ctx.config.get = (async () => {
    calls.count += 1;
    return orig();
  }) as typeof harness.ctx.config.get;
  return calls;
}

function makeHarness(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...CAPABILITIES],
    config,
  });
  return harness;
}

describe("boot: setup makes no config read (poisoning-safe)", () => {
  it("createKlipperWorker never calls ctx.config.get at spawn (no boot death)", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);

    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    // THE boot contract: zero worker→host config reads outside dispatches.
    // (The pre-fix code made a best-effort setup read that the host denied
    // in service scope — and that denial permanently poisoned the method.)
    expect(reads.count).toBe(0);
    expect(worker.client).toBeNull();
    expect(worker.configKnown).toBe(false);
    // The boot log line is a documented contract (operators grep for it).
    expect(
      harness.logs.some(
        (e) =>
          e.level === "info" &&
          e.message.includes("booted without a config read"),
      ),
    ).toBe(true);
  });

  it("all three manifest tools stay registered after a denied boot read", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);
    await createKlipperWorker(harness.ctx, { autoStart: false });

    for (const tool of [
      "klipper.get_printer_status",
      "klipper.upload_gcode",
      "klipper.start_print",
    ]) {
      const result = await harness.executeTool<{ data?: { error?: string } }>(
        tool,
        tool === "klipper.upload_gcode"
          ? { filename: "demo.gcode", artifactId: "00000000-0000-0000-0000-000000000000" }
          : tool === "klipper.start_print"
            ? { filename: "demo.gcode" }
            : {},
      );
      expect(result.data?.error).toBe("prerequisite_missing");
    }
  });

  it("config data key reports unconfigured while the replay is pending", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);
    await createKlipperWorker(harness.ctx, { autoStart: false });
    const cfg = await harness.getData<{ configured: boolean; moonrakerBaseUrl: string | null }>(
      "config",
    );
    expect(cfg).toEqual({ configured: false, moonrakerBaseUrl: null });
  });
});

describe("boot: host config replay via onConfigChanged", () => {
  it("plugin.setup survives the denied read; onConfigChanged starts the client", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);

    // VITEST is set, so setup's autoStart is disabled — no real WS dial.
    await plugin.definition.setup(harness.ctx);
    expect(reads.count).toBe(0);
    expect(
      harness.logs.some(
        (e) => e.level === "info" && e.message.includes("booted without a config read"),
      ),
    ).toBe(true);

    // The loader replays the stored row right after boot.
    await plugin.definition.onConfigChanged?.({ ...BASE_CONFIG });

    const cfg = await harness.getData<{ configured: boolean; moonrakerBaseUrl: string | null }>(
      "config",
    );
    expect(cfg.configured).toBe(true);
    expect(cfg.moonrakerBaseUrl).toBe("http://printer.lan:7125");
    expect(
      harness.logs.some(
        (e) => e.level === "info" && e.message.includes("config applied via host replay"),
      ),
    ).toBe(true);
  });

  it("onHealth distinguishes replay-pending from connected", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);
    await plugin.definition.setup(harness.ctx);

    const before = await plugin.definition.onHealth!();
    expect(before.status).toBe("ok");
    expect(before.details).toMatchObject({ configKnown: false, clientActive: false });

    await plugin.definition.onConfigChanged?.({ ...BASE_CONFIG });
    const after = await plugin.definition.onHealth!();
    expect(after.status).toBe("ok");
    expect(after.details).toMatchObject({ configKnown: true, clientActive: true });
  });

  it("an identical replay burst converges on one client (no churn)", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig({ ...BASE_CONFIG }, "configChanged", false);
    const first = worker.client;
    expect(first).not.toBeNull();

    // The host replays EVERY configured company's row at each boot; a burst
    // of identical snapshots must keep the same client instance.
    await worker.applyConfig({ ...BASE_CONFIG }, "configChanged", false);
    await worker.applyConfig({ ...BASE_CONFIG }, "configChanged", false);
    expect(worker.client).toBe(first);
  });

  it("a replay with a different connection identity replaces the client", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig({ ...BASE_CONFIG }, "configChanged", false);
    const first = worker.client!;

    await worker.applyConfig(
      { moonrakerBaseUrl: "http://other-printer.lan:7125" },
      "configChanged",
      false,
    );
    expect(worker.client).not.toBe(first);
    // The replaced client is stopped — a stale transport must never outlive
    // its config. start() after stop() throws by contract.
    await expect(first.start()).rejects.toThrow(/after stop/);
    expect(
      harness.logs.some((e) => e.level === "info" && e.message.includes("klipper.connection_replaced")),
    ).toBe(true);
  });

  it("gate-flag-only replays keep the live client (no rebuild)", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig({ ...BASE_CONFIG }, "configChanged", false);
    const first = worker.client!;

    // An operator toggling only an opt-in flag must not tear down the WS.
    await worker.applyConfig(
      { ...BASE_CONFIG, auto_upload_artifacts: true, allow_agent_initiated_print: true },
      "configChanged",
      false,
    );
    expect(worker.client).toBe(first);
  });

  it("a replay with an invalid baseUrl stops the client and degrades permissively", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig({ ...BASE_CONFIG }, "configChanged", false);
    expect(worker.client).not.toBeNull();

    await worker.applyConfig(
      { moonrakerBaseUrl: "file:///etc/passwd" },
      "configChanged",
      false,
    );
    expect(worker.client).toBeNull();
    const cfg = await harness.getData<{ configured: boolean }>("config");
    expect(cfg.configured).toBe(false);
    expect(
      harness.logs.some(
        (e) => e.level === "warn" && e.message.includes("rejected moonrakerBaseUrl"),
      ),
    ).toBe(true);
  });

  it("a replay clearing moonrakerBaseUrl stops the client", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig({ ...BASE_CONFIG }, "configChanged", false);
    const first = worker.client!;

    await worker.applyConfig({}, "configChanged", false);
    expect(worker.client).toBeNull();
    await expect(first.start()).rejects.toThrow(/after stop/);
  });

  it("onConfigChanged apply failures never error the worker (best-effort replay)", async () => {
    const harness = makeHarness();
    const reads = countConfigReads(harness);
    await plugin.definition.setup(harness.ctx);

    // Malformed replay payload (null) — must degrade permissively, not throw.
    await expect(
      plugin.definition.onConfigChanged!(null as unknown as Record<string, unknown>),
    ).resolves.toBeUndefined();

    const cfg = await harness.getData<{ configured: boolean }>("config");
    expect(cfg.configured).toBe(false);
  });
});

describe("boot: a readable config at setup is ignored until the replay lands", () => {
  it("even a readable config is NOT applied at setup; the replay builds the client", async () => {
    const harness = makeHarness({ ...BASE_CONFIG });
    const reads = countConfigReads(harness);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    // setup() never reads config — there is no safe scope for it.
    expect(reads.count).toBe(0);
    expect(worker.configKnown).toBe(false);
    expect(worker.client).toBeNull();

    // The host replay applies it.
    await worker.applyConfig({ ...BASE_CONFIG }, "configChanged", false);
    expect(worker.configKnown).toBe(true);
    expect(worker.client).not.toBeNull();
    const cfg = await harness.getData<{ configured: boolean }>("config");
    expect(cfg.configured).toBe(true);
  });
});
