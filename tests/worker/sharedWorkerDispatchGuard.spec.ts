/**
 * Shared-worker dispatch guard (SE review conditions on 0.2.5):
 *
 *   C1 — the host runs ONE worker child per plugin, shared by every
 *        company (plugin-worker-manager keys workers by pluginId). The
 *        unauthenticated-moonraker branch of `ensureCredential` used to
 *        return ok WITHOUT comparing the live client against the
 *        dispatching company's config fingerprint, so after company B's
 *        config row was applied last (boot replay / operator save
 *        ordering), a company A dispatch uploaded to and drove B's
 *        printer — persistent cross-tenant misrouting, not a rare race.
 *        The branch now applies the credentialed path's own identity
 *        guard: validate the live config, rebuild the client from it
 *        whenever the live client's connection identity differs, and fail
 *        closed when the live config itself is invalid.
 *
 *   F5 — upload_gcode used to resolve the credential BEFORE the local
 *        filename/path validation, contradicting the handler's own
 *        "validation runs first so a malformed call never spends a
 *        resolve" invariant. Ordering regression below: the refusal must
 *        cost zero resolves and zero wire traffic.
 *
 *   C1b — the credentialed fast path re-verifies the HELD client. The
 *        cache is keyed to the config fingerprint, not to the client, and
 *        the unauth rebuild (C1) replaces the client without touching the
 *        cache — so A(resolved) → B(unauth rebuild) → A used to fast-path
 *        onto B's client and upload/print on B's printer. The fast path
 *        now requires the same connection-identity predicate as the
 *        resolve path, and the unauth rebuild drops any surviving cache
 *        entry (the transport holds no plaintext after it).
 *
 * The interleaving tests replay the exact hostile order on one worker:
 * apply B's config row → dispatch A → the connection must target A's
 * printer X, and B's printer Y must never see an upload.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../src/manifest.js";
import { createKlipperWorker, type KlipperWorker } from "../../src/worker.js";
import { MockMoonraker } from "../fixtures/moonraker/mockServer.js";

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const GCODE = new Uint8Array([0x47, 0x31, 0x20, 0x58, 0x31, 0x30, 0x0a]); // "G1 X10\n"

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

describe("C1: unauth dispatch identity guard on the shared worker", () => {
  let printerX: MockMoonraker; // company A's printer
  let printerY: MockMoonraker; // company B's printer

  beforeEach(async () => {
    printerX = new MockMoonraker();
    printerY = new MockMoonraker();
    await printerX.start();
    await printerY.start();
  });

  afterEach(async () => {
    await printerX.stop();
    await printerY.stop();
  });

  function configA(): Record<string, unknown> {
    return { moonrakerBaseUrl: printerX.baseUrl(), auto_upload_artifacts: true };
  }

  /**
   * One shared worker; company B's unauth row was applied LAST (the boot
   * replay / operator-save ordering), so the live client targets B's
   * printer Y. The harness config — what `ctx.config.get` returns for the
   * in-flight dispatch — is company A's.
   */
  async function bootLastAppliedB(): Promise<{
    harness: ReturnType<typeof createTestHarness>;
    worker: KlipperWorker;
    clientBefore: KlipperWorker["client"];
  }> {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: configA(),
    });
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    await worker.applyConfig(
      { moonrakerBaseUrl: printerY.baseUrl() },
      "configChanged",
      true,
    );
    await waitFor(() => worker.client!.getConnectionState().state === "connected");
    return { harness, worker, clientBefore: worker.client };
  }

  it("apply B → dispatch A: the upload targets A's printer X, B's printer Y is untouched", async () => {
    const { harness, worker, clientBefore } = await bootLastAppliedB();

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
    // The client was rebuilt from A's validated live config…
    expect(worker.client).not.toBeNull();
    expect(worker.client).not.toBe(clientBefore);
    // …the upload landed on A's printer X…
    expect(printerX.uploadedFiles).toHaveLength(1);
    expect(printerX.uploadedFiles[0]!.filename).toBe("bracket.gcode");
    // …and B's printer Y never received an upload.
    expect(printerY.uploadedFiles).toHaveLength(0);
  });

  it("a second A dispatch reuses the rebuilt client (no churn between same-identity dispatches)", async () => {
    const { harness, worker } = await bootLastAppliedB();

    const first = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(first.error).toBeUndefined();
    const rebuilt = worker.client;
    expect(printerX.uploadedFiles).toHaveLength(1);

    const second = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(second.error).toBeUndefined();
    expect(worker.client).toBe(rebuilt);
    expect(printerX.uploadedFiles).toHaveLength(2);
    expect(printerY.uploadedFiles).toHaveLength(0);
  });

  it("an invalid live config fails closed instead of driving the last-applied client", async () => {
    const { harness, worker } = await bootLastAppliedB();

    // Company A's live config is invalid (unsupported scheme). The old
    // branch returned ok and would have uploaded on B's client.
    harness.setConfig({
      moonrakerBaseUrl: "ftp://printer-a.lan:7125",
      auto_upload_artifacts: true,
    });
    const result = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );

    expect(result.error).toMatch(/config is invalid/);
    expect(printerX.uploadedFiles).toHaveLength(0);
    expect(printerY.uploadedFiles).toHaveLength(0);
    // The refused dispatch does not converge the last-applied transport.
    expect(worker.client).not.toBeNull();
    expect(worker.client!.getConnectionState().state).toBe("connected");
  });
});

describe("F5: upload_gcode order is gate → validate → resolve", () => {
  it("a malformed filename is refused before the in-dispatch resolve (no resolve, no wire traffic)", async () => {
    const mock = new MockMoonraker({ requireApiKey: "order-test-key" });
    await mock.start();
    try {
      const config = {
        moonrakerBaseUrl: mock.baseUrl(),
        moonrakerApiKeyRef: "moonraker-key",
        auto_upload_artifacts: true,
      };
      const harness = createTestHarness({
        manifest,
        capabilities: [...CAPABILITIES],
        config,
      });
      const resolves: unknown[] = [];
      harness.ctx.secrets.resolve = (async (ref: unknown) => {
        resolves.push(ref);
        return "order-test-key";
      }) as typeof harness.ctx.secrets.resolve;
      const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
      await worker.applyConfig(config, "configChanged", false); // dormant

      // The SDK harness passes params straight to the handler (no schema
        // validation), so the quote below reaches the worker-side backstop —
      // which must run BEFORE the credential resolve.
      const result = await harness.executeTool<{ error?: string }>(
        "klipper.upload_gcode",
        { filename: 'bracket".gcode', artifactId: ARTIFACT_ID },
        artifactCtx(),
      );

      expect(result.error).toMatch(/refused — filename/);
      expect(resolves).toHaveLength(0);
      expect(mock.recordedRequests).toHaveLength(0);
      // Still dormant: nothing was resolved, nothing started.
      expect(worker.getCredentialPendingReason()).toContain(
        "credential not resolved yet",
      );
    } finally {
      await mock.stop();
    }
  });
});

describe("C1b: credentialed fast path re-verifies the held client", () => {
  let printerX: MockMoonraker; // company A's credentialed printer
  let printerY: MockMoonraker; // company B's unauth printer

  beforeEach(async () => {
    printerX = new MockMoonraker({ requireApiKey: "key-a" });
    printerY = new MockMoonraker();
    await printerX.start();
    await printerY.start();
  });

  afterEach(async () => {
    await printerX.stop();
    await printerY.stop();
  });

  function configA(): Record<string, unknown> {
    return {
      moonrakerBaseUrl: printerX.baseUrl(),
      moonrakerApiKeyRef: "moonraker-key",
      auto_upload_artifacts: true,
    };
  }

  function configB(): Record<string, unknown> {
    return {
      moonrakerBaseUrl: printerY.baseUrl(),
      auto_upload_artifacts: true,
    };
  }

  it(
    "A(credentialed X) → B(unauth Y) → A: the second A dispatch re-resolves," +
      " rebuilds, and uploads to X — never onto B's client or printer Y",
    async () => {
      const harness = createTestHarness({
        manifest,
        capabilities: [...CAPABILITIES],
        config: configA(),
      });
      const resolves: unknown[] = [];
      harness.ctx.secrets.resolve = (async (ref: unknown) => {
        resolves.push(ref);
        return "key-a";
      }) as typeof harness.ctx.secrets.resolve;

      const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
      // 0.2.5 apply resolves NOTHING — the credentialed transport
      // converges DORMANT (client held with no credential, not started)
      // until the first dispatch resolves the ref.
      await worker.applyConfig(configA(), "configChanged", false);
      expect(resolves).toHaveLength(0);
      expect(worker.getCredentialPendingReason()).toContain(
        "credential not resolved yet",
      );

      // Step 1 — A dispatches: in-dispatch resolve, client A, upload on X.
      const first = await harness.executeTool<{ error?: string }>(
        "klipper.upload_gcode",
        { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
        artifactCtx(),
      );
      expect(first.error).toBeUndefined();
      expect(resolves).toHaveLength(1);
      expect(printerX.uploadedFiles).toHaveLength(1);
      expect(printerY.uploadedFiles).toHaveLength(0);
      const clientA = worker.client;
      expect(printerX.seenApiKeys.has("key-a")).toBe(true);

      // Step 2 — B dispatches (unauth, printer Y): the C1 identity guard
      // rebuilds the client from B's validated live config. This branch
      // does not resolve a credential — resolves stays at 1.
      harness.setConfig(configB());
      const second = await harness.executeTool<{ error?: string }>(
        "klipper.upload_gcode",
        { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
        artifactCtx(),
      );
      expect(second.error).toBeUndefined();
      expect(resolves).toHaveLength(1);
      expect(printerY.uploadedFiles).toHaveLength(1);
      expect(worker.client).not.toBeNull();
      expect(worker.client).not.toBe(clientA);
      const clientB = worker.client;

      // Step 3 — A dispatches again: the cache fingerprint still matches
      // A's config, but the held client is B's. Trusting it here routed
      // the upload onto printer Y (the C1b attack). The fix re-verifies
      // the held client's identity, falls through to the in-dispatch
      // resolve, and rebuilds company A's client from A's validated
      // config.
      harness.setConfig(configA());
      const third = await harness.executeTool<{ error?: string }>(
        "klipper.upload_gcode",
        { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
        artifactCtx(),
      );
      expect(third.error).toBeUndefined();
      // Routing first: the upload must land on X, and Y must still hold
      // ONLY B's own (legitimate) upload from step 2.
      expect(printerX.uploadedFiles).toHaveLength(2);
      expect(printerY.uploadedFiles).toHaveLength(1);
      // The fix re-resolves in-dispatch (fast path fell through).
      expect(resolves).toHaveLength(2);
      expect(worker.client).not.toBeNull();
      expect(worker.client).not.toBe(clientB);
      // The rebuilt client authenticated with A's freshly resolved key.
      expect(printerX.seenApiKeys.has("key-a")).toBe(true);

      // The rebuild starts its WS loop asynchronously; wait for the
      // token-authenticated handshake to complete so (a) the test proves
      // the rebuilt client actually connects and (b) teardown never races
      // an in-flight WS upgrade against the mock server's close().
      await waitFor(() => worker.client!.getConnectionState().state === "connected");
    },
  );
});
