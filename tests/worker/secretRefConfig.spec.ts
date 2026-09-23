/**
 * Worker-level config handling of the two secret-ref shapes.
 *
 * The config fingerprints decide whether a replayed config rebuilds the
 * printer client. With object-shaped binding refs in play:
 *   - a replay that only re-serializes the same object (different key
 *     order) is the SAME connection identity — the live client is kept;
 *   - a real change (different secretId or pinned version) IS a new
 *     connection — the old client is replaced;
 *   - legacy string refs keep their raw value as the identity, so existing
 *     configs see no identity churn across the upgrade.
 */
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../src/manifest.js";
import { createKlipperWorker } from "../../src/worker.js";

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

const UUID_A = "690a5384-1234-4abc-8abc-000000000001";
const UUID_B = "690a5384-1234-4abc-8abc-000000000002";

function makeHarness(config: Record<string, unknown>) {
  return createTestHarness({
    manifest,
    capabilities: [...CAPABILITIES],
    config,
  });
}

describe("worker fingerprints — moonraker apiKeyRef shapes", () => {
  const BASE = { moonrakerBaseUrl: "http://printer.lan:7125" } as const;

  it("reordered object keys are the SAME connection (replay burst converges)", async () => {
    const harness = makeHarness(BASE);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig(
      { ...BASE, moonrakerApiKeyRef: { type: "secret_ref", secretId: UUID_A } },
      "configChanged",
      false,
    );
    const first = worker.client!;
    expect(first).not.toBeNull();

    await worker.applyConfig(
      { moonrakerBaseUrl: BASE.moonrakerBaseUrl, moonrakerApiKeyRef: { secretId: UUID_A, type: "secret_ref" } },
      "configChanged",
      false,
    );
    expect(worker.client).toBe(first);
  });

  it("a different secretId (or pinned version) is a NEW connection", async () => {
    const harness = makeHarness(BASE);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig(
      { ...BASE, moonrakerApiKeyRef: { type: "secret_ref", secretId: UUID_A } },
      "configChanged",
      false,
    );
    const first = worker.client!;

    await worker.applyConfig(
      { ...BASE, moonrakerApiKeyRef: { type: "secret_ref", secretId: UUID_B } },
      "configChanged",
      false,
    );
    expect(worker.client).not.toBe(first);

    const second = worker.client!;
    await worker.applyConfig(
      { ...BASE, moonrakerApiKeyRef: { type: "secret_ref", secretId: UUID_B, version: 2 } },
      "configChanged",
      false,
    );
    expect(worker.client).not.toBe(second);
  });

  it("legacy string refs keep their raw value as identity (no upgrade churn)", async () => {
    const harness = makeHarness(BASE);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig({ ...BASE, moonrakerApiKeyRef: "moonraker-key-name" }, "configChanged", false);
    const first = worker.client!;
    await worker.applyConfig({ ...BASE, moonrakerApiKeyRef: "moonraker-key-name" }, "configChanged", false);
    expect(worker.client).toBe(first);
  });

  it("string → object ref switch replaces the client (identity differs)", async () => {
    const harness = makeHarness(BASE);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig({ ...BASE, moonrakerApiKeyRef: UUID_A }, "configChanged", false);
    const first = worker.client!;
    await worker.applyConfig(
      { ...BASE, moonrakerApiKeyRef: { type: "secret_ref", secretId: UUID_A } },
      "configChanged",
      false,
    );
    expect(worker.client).not.toBe(first);
  });
});

describe("worker fingerprints — flashforge checkCodeRef shapes", () => {
  const BASE = {
    transport: "flashforge" as const,
    flashforgeBaseUrl: "http://192.168.1.50",
    flashforgeSerialNumber: "SN-C5",
  };

  it("reordered object keys keep the live flashforge client", async () => {
    const harness = makeHarness(BASE);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig(
      { ...BASE, flashforgeCheckCodeRef: { type: "secret_ref", secretId: UUID_A } },
      "configChanged",
      false,
    );
    const first = worker.client!;
    expect(first?.kind).toBe("flashforge");

    await worker.applyConfig(
      { ...BASE, flashforgeCheckCodeRef: { secretId: UUID_A, type: "secret_ref" } },
      "configChanged",
      false,
    );
    expect(worker.client).toBe(first);
  });

  it("a different check-code secret replaces the flashforge client", async () => {
    const harness = makeHarness(BASE);
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });

    await worker.applyConfig(
      { ...BASE, flashforgeCheckCodeRef: { type: "secret_ref", secretId: UUID_A } },
      "configChanged",
      false,
    );
    const first = worker.client!;
    await worker.applyConfig(
      { ...BASE, flashforgeCheckCodeRef: "legacy-name-ref" },
      "configChanged",
      false,
    );
    expect(worker.client).not.toBe(first);
    expect(worker.client).not.toBeNull();
  });
});
