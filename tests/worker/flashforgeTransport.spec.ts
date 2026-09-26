/**
 * Worker-level FlashForge transport coverage, driven through the SDK test
 * harness against the in-process mock printer. No physical printer.
 *
 *   AC1 — transport config selection: flashforge keys surface in the config
 *         data key; an invalid transport value is rejected fail-closed.
 *   AC2 — klipper.upload_gcode delivers the artifact bytes to the configured
 *         printer over the FlashForge HTTP API and reports the filename.
 *   AC3 — job/printer status flows into the same status/health path; health
 *         reports degraded when the printer is unreachable (fail closed).
 *   AC4 — start_print stays default-deny; no upload path auto-starts a print.
 *   AC5 — transport=flashforge with missing config fails closed with a clear
 *         validation error (no crash, no moonraker fallthrough).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
import { createRunCtxAwareHarness } from "../helpers/runCtxAwareHarness.js";
import manifest from "../../src/manifest.js";
import plugin, { createKlipperWorker } from "../../src/worker.js";
import { bootWithReplay } from "../helpers/replayBoot.js";
import { MockFlashForge } from "../fixtures/flashforge/mockServer.js";
import {
  selectTransport,
  validateFlashForgeConfig,
} from "../../src/worker/transports/validateTransportConfig.js";

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

const SERIAL = "SN-TEST-C5";
const SECRET_REF = "flashforge-check-code";
// The harness resolves secret refs to `resolved:<ref>` (plugin-sdk testing).
const RESOLVED_CHECK_CODE = `resolved:${SECRET_REF}`;

const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";

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

function ffConfig(baseUrl: string, extra: Record<string, unknown> = {}) {
  return {
    transport: "flashforge" as const,
    flashforgeBaseUrl: baseUrl,
    flashforgeSerialNumber: SERIAL,
    flashforgeCheckCodeRef: SECRET_REF,
    ...extra,
  };
}

describe("worker — flashforge transport happy paths (mock printer)", () => {
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({
      serialNumber: SERIAL,
      checkCode: RESOLVED_CHECK_CODE,
      gcodeList: ["bracket.gcode"],
    });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  async function makeWorker(extraConfig: Record<string, unknown> = {}) {
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: ffConfig(mock.baseUrl(), extraConfig),
    });
    const worker = await bootWithReplay(harness, {
      flashforgeClientOverrides: { pollIntervalMs: 60_000 },
    });
    return { harness, worker };
  }

  it("AC1: config data key reports the flashforge transport and host", async () => {
    const { harness, worker } = await makeWorker();
    expect(worker.client?.kind).toBe("flashforge");
    const cfg = await harness.getData<{
      configured: boolean;
      moonrakerBaseUrl: string | null;
      transport?: string;
      flashforgeBaseUrl?: string | null;
    }>("config");
    expect(cfg).toMatchObject({
      configured: true,
      moonrakerBaseUrl: null,
      transport: "flashforge",
      flashforgeBaseUrl: mock.baseUrl(),
    });
  });

  it("AC2: upload_gcode delivers the artifact to the printer and reports the filename", async () => {
    const { harness } = await makeWorker({ auto_upload_artifacts: true });

    const result = await harness.executeTool<{
      data?: { item?: { path: string; size: number }; print_started?: boolean };
      error?: string;
    }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.item?.path).toBe("bracket.gcode");
    expect(result.data?.item?.size).toBe(GCODE.length);
    expect(result.data?.print_started).toBe(false);

    // The mock printer received the upload, authenticated as configured.
    expect(mock.uploadedFiles.map((f) => f.filename)).toEqual(["bracket.gcode"]);
    const uploadReq = mock.recordedRequests.find((r) => r.url === "/uploadGcode");
    expect(uploadReq).toBeDefined();
    const h = (name: string) => {
      const raw = uploadReq!.headers[name];
      return Array.isArray(raw) ? raw[0] : raw;
    };
    expect(h("serialnumber")).toBe(SERIAL);
    expect(h("checkcode")).toBe(RESOLVED_CHECK_CODE);
    // The artifact bytes actually reached the wire.
    expect(uploadReq!.body!.toString("latin1")).toContain("G1 X10\n");
  });

  it("AC2: upload stays gated on auto_upload_artifacts", async () => {
    const { harness } = await makeWorker();
    const result = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(result.error).toMatch(/auto_upload_artifacts is false/);
    expect(mock.uploadedFiles).toHaveLength(0);
  });

  it("AC3: status data key serves the flashforge snapshot on the shared path", async () => {
    const { harness, worker } = await makeWorker({ auto_upload_artifacts: true });
    // Bring the transport up through the PRODUCTION path — the in-dispatch
    // credential resolution starts the poll loop; the status data key then
    // serves whatever the poll warmed (no resolve of its own).
    const res = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(res.error).toBeUndefined();
    await waitFor(() => worker.client!.getConnectionState().state === "connected");
    try {
      const status = await harness.getData<{
        objects: Record<string, Record<string, unknown>>;
        connection: { state: string };
        updatedAt: string | null;
        degraded?: boolean;
        degradedReason?: string;
      }>("status", { companyId: "company-test" });
      expect(status.connection.state).toBe("connected");
      expect(status.degraded).toBeUndefined();
      expect(status.updatedAt).toBeTruthy();
      expect(status.objects.print_stats).toMatchObject({ state: "standby" });
      expect(status.objects.flashforge).toMatchObject({ model: "Creator 5" });
    } finally {
      worker.client!.stop();
    }
  });

  it("tenancy: another company's board/agent callers never reach the held printer or config", async () => {
    const { harness, worker } = await makeWorker({ auto_upload_artifacts: true });
    const OTHER = "company-other";
    // Company "company-test" credentials the transport in its own dispatch.
    const res = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(res.error).toBeUndefined();
    await waitFor(() => worker.client!.getConnectionState().state === "connected");
    try {
      // Owner still gets live data.
      const own = await harness.getData<{ connection: { state: string } }>("status", {
        companyId: "company-test",
      });
      expect(own.connection.state).toBe("connected");
      // Another company (and an unscoped caller) gets the idle shape only.
      for (const scope of [{ companyId: OTHER }, {}]) {
        const other = await harness.getData<{
          connection: { state: string };
          objects: Record<string, unknown>;
        }>("status", scope);
        expect(other.connection.state).toBe("idle");
        expect(other.objects?.flashforge).toBeUndefined();
        const files = await harness.getData<unknown>("files", scope);
        expect(JSON.stringify(files)).not.toContain("bracket.gcode");
      }
      // Mutating actions from another company fail closed.
      for (const [key, params] of [
        ["start_print", { filename: "bracket.gcode" }],
        ["delete_file", { path: "bracket.gcode" }],
        ["pause_print", {}],
        ["refresh", {}],
      ] as const) {
        await expect(
          harness.performAction(key, { ...params }, {
            companyId: OTHER,
            actor: { type: "user", userId: "u-other", companyId: OTHER },
          }),
        ).rejects.toThrow();
      }
      // Config + camera follow the APPLYING company.
      await worker.applyConfig(
        ffConfig(mock.baseUrl(), {
          auto_upload_artifacts: true,
          flashforgeCameraBaseUrl: `http://${new URL(mock.baseUrl()).hostname}:8080`,
        }) as never,
        "configChanged",
        false,
        "company-test",
      );
      const cfgOther = await harness.getData<{ configured: boolean; cameraConfigured: boolean }>(
        "config",
        { companyId: OTHER },
      );
      expect(cfgOther).toEqual({ configured: false, moonrakerBaseUrl: null, cameraConfigured: false });
      const cfgOwn = await harness.getData<{ configured: boolean }>("config", {
        companyId: "company-test",
      });
      expect(cfgOwn.configured).toBe(true);
      for (const key of ["camera_open", "camera_next", "camera_retry"]) {
        await expect(
          harness.performAction(key, {}, {
            companyId: OTHER,
            actor: { type: "user", userId: "u-other", companyId: OTHER },
          }),
        ).rejects.toThrow(/Camera not configured/);
      }
    } finally {
      worker.client?.stop();
      worker.camera?.dispose();
    }
  });

  it("AC3: onHealth reports ok when reachable and degraded when unreachable (fail closed)", async () => {
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {},
    });
    // Health reads NO config (only worker state + a transport probe) — the
    // counter proves it. The upload dispatch below legitimately reads once
    // (the in-dispatch gate check).
    let configReads = 0;
    const origGet = harness.ctx.config.get.bind(harness.ctx.config.get);
    harness.ctx.config.get = (async () => {
      configReads += 1;
      return origGet();
    }) as typeof harness.ctx.config.get;
    harness.setConfig(ffConfig(mock.baseUrl(), { auto_upload_artifacts: true }));
    await plugin.definition.setup(harness.ctx);

    await plugin.definition.onConfigChanged?.(
      ffConfig(mock.baseUrl(), { auto_upload_artifacts: true }),
    );
    // Pre-dispatch the transport is dormant: health must say degraded with
    // the pending reason, never a stale "ok".
    const pending = await plugin.definition.onHealth!();
    expect(pending.status).toBe("degraded");
    expect(String(pending.message)).toMatch(/credential not resolved yet/);

    // The in-dispatch credential resolution brings the transport up; a
    // fresh probe against the reachable printer then reports ok.
    const res = await harness.executeTool<{ error?: string }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(res.error).toBeUndefined();
    const healthy = await plugin.definition.onHealth!();
    expect(healthy.status).toBe("ok");
    expect(healthy.details).toMatchObject({
      transport: "flashforge",
      clientActive: true,
      configKnown: true,
    });

    // 5xx → degraded; refused port → degraded. Never a stale "ok".
    mock.failureMode = "http500";
    const degraded = await plugin.definition.onHealth!();
    expect(degraded.status).toBe("degraded");

    await mock.stop();
    const refused = await plugin.definition.onHealth!();
    expect(refused.status).toBe("degraded");
    expect(refused.message).toMatch(/unreachable/i);
    // Health never read config — only the upload dispatch's gate check did.
    expect(configReads).toBe(1);
  });

  it("AC4: start_print is refused with the print gate unset — even with auto_upload on", async () => {
    // Gate completely absent.
    const a = await makeWorker({ auto_upload_artifacts: true });
    const refusedA = await a.harness.executeTool<{ error?: string }>(
      "klipper.start_print",
      { filename: "bracket.gcode" },
      {},
    );
    expect(refusedA.error).toMatch(/allow_agent_initiated_print is false/);

    // Gate explicitly false, upload gate true.
    const b = await makeWorker({
      auto_upload_artifacts: true,
      allow_agent_initiated_print: false,
    });
    const refusedB = await b.harness.executeTool<{ error?: string }>(
      "klipper.start_print",
      { filename: "bracket.gcode" },
      {},
    );
    expect(refusedB.error).toMatch(/allow_agent_initiated_print is false/);

    // Nothing reached the printer.
    expect(mock.printJobs).toHaveLength(0);
  });

  it("AC4: no upload path auto-starts a print (printNow stays false, no printGcode call)", async () => {
    const { harness } = await makeWorker({ auto_upload_artifacts: true });
    const result = await harness.executeTool<{ data?: { print_started?: boolean } }>(
      "klipper.upload_gcode",
      { filename: "bracket.gcode", artifactId: ARTIFACT_ID },
      artifactCtx(),
    );
    expect(result.data?.print_started).toBe(false);
    const uploadReq = mock.recordedRequests.find((r) => r.url === "/uploadGcode");
    const printNow = uploadReq!.headers["printnow"];
    expect(Array.isArray(printNow) ? printNow[0] : printNow).toBe("false");
    expect(mock.recordedRequests.filter((r) => r.url === "/printGcode")).toHaveLength(0);
    expect(mock.printJobs).toHaveLength(0);
  });

  it("AC4: explicit operator opt-in unlocks start_print (gate semantics match moonraker)", async () => {
    const { harness } = await makeWorker({
      auto_upload_artifacts: true,
      allow_agent_initiated_print: true,
    });
    const result = await harness.executeTool<{ data?: { ok?: boolean }; error?: string }>(
      "klipper.start_print",
      { filename: "bracket.gcode" },
      {},
    );
    expect(result.error).toBeUndefined();
    expect(mock.printJobs).toEqual(["bracket.gcode"]);
  });
});

describe("worker — fail-closed transport config validation (AC5)", () => {
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({
      serialNumber: SERIAL,
      checkCode: RESOLVED_CHECK_CODE,
    });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  function makeHarnessWithConfig(config: Record<string, unknown>) {
    return createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config,
    });
  }

  it("missing flashforge config yields a clear validation error and a null client (no moonraker fallthrough)", async () => {
    const harness = makeHarnessWithConfig({ transport: "flashforge" });
    const worker = await bootWithReplay(harness);

    expect(worker.client).toBeNull();
    expect(
      harness.logs.some(
        (e) =>
          e.level === "warn" &&
          /rejected the flashforge transport config/.test(e.message) &&
          JSON.stringify(e.meta ?? {}).includes("flashforgeBaseUrl") &&
          JSON.stringify(e.meta ?? {}).includes("flashforgeSerialNumber") &&
          JSON.stringify(e.meta ?? {}).includes("flashforgeCheckCodeRef"),
      ),
    ).toBe(true);
    // The tool surface is permissive-init: structured refusal, no crash.
    const result = await harness.executeTool<{
      data?: { error?: string; message?: string };
      error?: string;
    }>("klipper.get_printer_status", {}, {});
    expect(result.data?.error).toBe("prerequisite_missing");
    expect(result.data?.message).toMatch(/flashforgeBaseUrl/);
  });

  it("partially-complete flashforge config also fails closed (not just fully-empty)", async () => {
    const harness = makeHarnessWithConfig({
      transport: "flashforge",
      flashforgeBaseUrl: mock.baseUrl(),
    });
    const worker = await bootWithReplay(harness);
    expect(worker.client).toBeNull();
    expect(
      harness.logs.some((e) => e.level === "warn" && /flashforgeSerialNumber/.test(JSON.stringify(e.meta ?? {}))),
    ).toBe(true);
  });

  it("an invalid transport value is rejected with a clear error (never coerced)", async () => {
    const harness = makeHarnessWithConfig({ transport: "octoprint" });
    const worker = await bootWithReplay(harness);
    expect(worker.client).toBeNull();
    expect(
      harness.logs.some(
        (e) =>
          e.level === "warn" &&
          /rejected the transport config value/.test(e.message) &&
          JSON.stringify(e.meta ?? {}).includes("octoprint"),
      ),
    ).toBe(true);
  });

  it("switching a live flashforge client to invalid config stops the client", async () => {
    const harness = makeHarnessWithConfig(ffConfig(mock.baseUrl()));
    const worker = await bootWithReplay(harness);
    expect(worker.client).not.toBeNull();
    const stopped: string[] = [];
    const previous = worker.client!;
    previous.stop = () => stopped.push("stopped");

    await worker.applyConfig({ transport: "flashforge" }, "configChanged", false);
    expect(stopped).toEqual(["stopped"]);
    expect(worker.client).toBeNull();
  });

  it("an identical flashforge config replay converges on one client", async () => {
    const harness = makeHarnessWithConfig(ffConfig(mock.baseUrl()));
    const worker = await bootWithReplay(harness);
    const first = worker.client;
    await worker.applyConfig(ffConfig(mock.baseUrl()), "configChanged", false);
    await worker.applyConfig(ffConfig(mock.baseUrl()), "configChanged", false);
    expect(worker.client).toBe(first);
  });
});

describe("transport config selection helpers (AC1)", () => {
  it("absent / empty transport resolves to moonraker", () => {
    expect(selectTransport(undefined)).toEqual({ ok: true, kind: "moonraker" });
    expect(selectTransport(null)).toEqual({ ok: true, kind: "moonraker" });
    expect(selectTransport("")).toEqual({ ok: true, kind: "moonraker" });
    expect(selectTransport("moonraker")).toEqual({ ok: true, kind: "moonraker" });
    expect(selectTransport("flashforge")).toEqual({ ok: true, kind: "flashforge" });
  });

  it("unknown values are rejected with a clear reason", () => {
    const bad = selectTransport("octoprint");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("octoprint");
  });

  it("manifest schema declares the transport enum and the flashforge keys", () => {
    const schema = manifest.instanceConfigSchema as {
      properties: Record<string, Record<string, unknown>>;
      required: unknown[];
    };
    expect(schema.properties.transport).toMatchObject({
      enum: ["moonraker", "flashforge"],
    });
    expect(schema.properties.flashforgeBaseUrl).toBeDefined();
    expect(schema.properties.flashforgeSerialNumber).toBeDefined();
    expect(schema.properties.flashforgeCheckCodeRef).toMatchObject({ format: "secret-ref" });
    expect(schema.properties.flashforgeAllowedHosts).toBeDefined();
  });

  it("validateFlashForgeConfig applies the default port and enforces the host allowlist", () => {
    const ok = validateFlashForgeConfig({
      flashforgeBaseUrl: "http://printer.lan",
      flashforgeSerialNumber: SERIAL,
      flashforgeCheckCodeRef: SECRET_REF,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.baseUrl).toBe("http://printer.lan:8898/");

    const notAllowed = validateFlashForgeConfig({
      flashforgeBaseUrl: "http://other.lan",
      flashforgeAllowedHosts: ["printer.lan:8898"],
      flashforgeSerialNumber: SERIAL,
      flashforgeCheckCodeRef: SECRET_REF,
    });
    expect(notAllowed.ok).toBe(false);
    if (!notAllowed.ok) expect(notAllowed.reason).toBe("host_not_allowed");
  });
});

/**
 * Object-shaped secret binding ref, end to end: the host binds config
 * secrets as { type: "secret_ref", secretId, version? } and rejects legacy
 * string refs at resolution time, so the operator-submitted object must
 * survive manifest validation → transport validation → the secrets client →
 * the printer request with the resolved check code authenticating exactly
 * as it does for string refs.
 */
describe("worker — flashforge transport with object checkCodeRef (mock printer)", () => {
  const UUID = "690a5384-1234-4abc-8abc-000000000001";
  const OBJECT_REF_CHECK_CODE = "resolved-object-ref-check-code";
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({
      serialNumber: SERIAL,
      checkCode: OBJECT_REF_CHECK_CODE,
      gcodeList: ["bracket.gcode"],
    });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("upload authenticates with the resolved check code from the object ref", async () => {
    const resolveCalls: unknown[] = [];
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {
        transport: "flashforge",
        flashforgeBaseUrl: mock.baseUrl(),
        flashforgeSerialNumber: SERIAL,
        flashforgeCheckCodeRef: { type: "secret_ref", secretId: UUID },
        auto_upload_artifacts: true,
      },
    });
    const origResolve = harness.ctx.secrets.resolve.bind(harness.ctx.secrets);
    harness.ctx.secrets.resolve = (async (ref: string) => {
      resolveCalls.push(ref);
      return OBJECT_REF_CHECK_CODE;
    }) as typeof harness.ctx.secrets.resolve;
    void origResolve;

    await bootWithReplay(harness, {
      flashforgeClientOverrides: { pollIntervalMs: 60_000 },
    });

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

    // The object ref flowed through the validator (normalized: explicit
    // "latest") and the resolved value authenticated against the printer.
    expect(resolveCalls).toEqual([{ type: "secret_ref", secretId: UUID, version: "latest" }]);
    const uploadReq = mock.recordedRequests.find((r) => r.url === "/uploadGcode");
    expect(uploadReq).toBeDefined();
    const h = (name: string) => {
      const raw = uploadReq!.headers[name];
      return Array.isArray(raw) ? raw[0] : raw;
    };
    expect(h("checkcode")).toBe(OBJECT_REF_CHECK_CODE);

    // The check code never leaked into the harness log surface.
    const flat = JSON.stringify(harness.logs);
    expect(flat.includes(OBJECT_REF_CHECK_CODE)).toBe(false);
  });
});

/**
 * Legacy string ref, trim parity end to end: the pre-object-binding
 * validator trimmed flashforgeCheckCodeRef before handing it to the
 * secrets client; 0.2.2 briefly dropped that trim, which would have sent a
 * padded config value to resolution verbatim and failed at the printer. A
 * padded string must resolve (trimmed) exactly like a clean one.
 */
describe("worker — flashforge transport with padded string checkCodeRef (trim parity)", () => {
  const PADDED_REF = "  padded-check-code-ref\t";
  const TRIMMED_REF = PADDED_REF.trim();
  const PADDED_RESOLVED_CODE = "resolved-padded-ref-check-code";
  let mock: MockFlashForge;

  beforeEach(async () => {
    mock = new MockFlashForge({
      serialNumber: SERIAL,
      checkCode: PADDED_RESOLVED_CODE,
      gcodeList: ["bracket.gcode"],
    });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("upload resolves the TRIMMED string ref and authenticates against the printer", async () => {
    const resolveCalls: unknown[] = [];
    const harness = createRunCtxAwareHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {
        transport: "flashforge",
        flashforgeBaseUrl: mock.baseUrl(),
        flashforgeSerialNumber: SERIAL,
        flashforgeCheckCodeRef: PADDED_REF,
        auto_upload_artifacts: true,
      },
    });
    const origResolve = harness.ctx.secrets.resolve.bind(harness.ctx.secrets);
    harness.ctx.secrets.resolve = (async (ref: string) => {
      resolveCalls.push(ref);
      return PADDED_RESOLVED_CODE;
    }) as typeof harness.ctx.secrets.resolve;
    void origResolve;

    await bootWithReplay(harness, {
      flashforgeClientOverrides: { pollIntervalMs: 60_000 },
    });

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

    // Trim parity: the padded config value reaches resolution trimmed, so
    // the request authenticates instead of failing on an untrimmed ref.
    expect(resolveCalls).toEqual([TRIMMED_REF]);
    const uploadReq = mock.recordedRequests.find((r) => r.url === "/uploadGcode");
    expect(uploadReq).toBeDefined();
    const h = (name: string) => {
      const raw = uploadReq!.headers[name];
      return Array.isArray(raw) ? raw[0] : raw;
    };
    expect(h("checkcode")).toBe(PADDED_RESOLVED_CODE);

    const flat = JSON.stringify(harness.logs);
    expect(flat.includes(PADDED_RESOLVED_CODE)).toBe(false);
  });
});
