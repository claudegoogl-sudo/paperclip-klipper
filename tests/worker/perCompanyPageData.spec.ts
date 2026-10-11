/**
 * Per-company page data after a boot replay in ANY order.
 *
 * The worker is shared by every company. The host replays every company's
 * row at boot; before this change the LAST applied row owned the single
 * camera feed, and the page's status/files stayed "credential not resolved
 * yet" until an agent tool dispatch in that company resolved the ref. A
 * FlashForge company replayed before Moonraker companies therefore lost its
 * printer page on every restart.
 *
 * Now: cameras are per company (built from each company's own row), and the
 * page's scoped getData call converges the viewer's OWN transport (own row,
 * own bound secret) without any tool dispatch. Tenancy is unchanged: a
 * company never reaches another company's printer or frames.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const SERIAL = "SN-PAGE";
const CHECK_CODE = "page-check-code";
const FF_CO = "company-ff";
const MOON_1 = "company-moon-1";
const MOON_2 = "company-moon-2";
const CAM_B = "company-camera-b";
const NONE = "company-without-row";

const board = (companyId: string) => ({
  companyId,
  actor: { type: "user" as const, userId: `u-${companyId}`, companyId },
});

/** MJPG stand-in: one JPEG frame whose payload byte identifies the host. */
function stubCameraFetch(fills: Record<string, number>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url.host);
    const fill = fills[url.hostname] ?? 0x00;
    const frame = new Uint8Array([0xff, 0xd8, 0xff, ...new Array(32).fill(fill), 0xff, 0xd9]);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(frame);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" },
    });
  });
  return { fn, calls };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("per-company page data survives a boot replay in any order", () => {
  let ff: MockFlashForge;
  let moon: MockMoonraker;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    ff = new MockFlashForge({ serialNumber: SERIAL, checkCode: CHECK_CODE, gcodeList: ["ff-part.gcode"] });
    await ff.start();
    moon = new MockMoonraker({ files: [{ path: "moon-part.gcode", size: 10, modified: 1 }] });
    await moon.start();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await ff.stop();
    await moon.stop();
  });

  function ffRow() {
    const host = new URL(ff.baseUrl()).hostname;
    return {
      transport: "flashforge",
      flashforgeBaseUrl: ff.baseUrl(),
      flashforgeSerialNumber: SERIAL,
      flashforgeCheckCodeRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-0000000000aa" },
      flashforgeCameraBaseUrl: `http://${host}:8080/?action=stream`,
      flashforgeCameraAllowedHosts: [`${host}:8080`],
    };
  }
  const moonRow = () => ({ moonrakerBaseUrl: moon.baseUrl() });

  async function bootFlashForgeFirst() {
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES] });
    const resolves: unknown[] = [];
    harness.ctx.secrets.resolve = (async (ref: unknown) => {
      resolves.push(ref);
      return CHECK_CODE;
    }) as typeof harness.ctx.secrets.resolve;
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    // Live boot order: the FlashForge company first, Moonraker rows after it.
    await worker.applyConfig(ffRow() as never, "configChanged", false, FF_CO);
    await worker.applyConfig(moonRow() as never, "configChanged", false, MOON_1);
    await worker.applyConfig(moonRow() as never, "configChanged", false, MOON_2);
    return { harness, worker, resolves };
  }

  it("A1: the FlashForge company keeps its camera after later Moonraker rows; Moonraker companies get none", async () => {
    const { harness, worker } = await bootFlashForgeFirst();
    try {
      const cfg = await harness.getData<Record<string, unknown>>("config", { companyId: FF_CO });
      expect(cfg).toMatchObject({ configured: true, transport: "flashforge", cameraConfigured: true });
      expect(JSON.stringify(cfg)).not.toContain(new URL(ff.baseUrl()).hostname);
      const m = await harness.getData<Record<string, unknown>>("config", { companyId: MOON_1 });
      expect(m).toMatchObject({ configured: true, cameraConfigured: false });
      await expect(harness.performAction("camera_open", {}, board(MOON_1))).rejects.toThrow(
        /Camera not configured/,
      );
      await expect(harness.performAction("camera_open", {}, board(NONE))).rejects.toThrow(
        /Camera not configured/,
      );
      const open = await harness.performAction<{ ok: boolean }>("camera_open", {}, board(FF_CO));
      expect(open.ok).toBe(true);
    } finally {
      worker.client?.stop();
    }
  });

  it("A1: one company never gets another company's frames", async () => {
    const { fn } = stubCameraFetch({ "127.0.0.1": 0x11, "camera-b.test": 0x22 });
    globalThis.fetch = fn as unknown as typeof fetch;
    const { harness, worker } = await bootFlashForgeFirst();
    // A second company with its OWN camera, applied after FF_CO.
    await worker.applyConfig(
      {
        ...ffRow(),
        flashforgeCameraBaseUrl: "http://camera-b.test:8080/?action=stream",
        flashforgeCameraAllowedHosts: ["camera-b.test:8080"],
      } as never,
      "configChanged",
      false,
      CAM_B,
    );
    await worker.applyConfig(moonRow() as never, "configChanged", false, MOON_2);
    try {
      const frameFill = async (company: string): Promise<number | null> => {
        const next = await harness.performAction<{ frame: { jpegBase64: string } | null }>(
          "camera_next",
          {},
          board(company),
        );
        if (!next.frame) return null;
        return Buffer.from(next.frame.jpegBase64, "base64")[3] ?? null;
      };
      await harness.performAction("camera_open", {}, board(FF_CO));
      await harness.performAction("camera_open", {}, board(CAM_B));
      let ffFill: number | null = null;
      let b: number | null = null;
      await waitFor(async () => {
        ffFill = await frameFill(FF_CO);
        b = await frameFill(CAM_B);
        return ffFill !== null && b !== null;
      });
      expect(ffFill).toBe(0x11);
      expect(b).toBe(0x22);
    } finally {
      worker.client?.stop();
      await harness.performAction("camera_close", {}, board(FF_CO));
      await harness.performAction("camera_close", {}, board(CAM_B));
    }
  });

  it("A2+A3: FlashForge status and files work after the replay with no tool dispatch", async () => {
    const { harness, worker, resolves } = await bootFlashForgeFirst();
    try {
      // The page's own scoped call converges FF_CO's transport.
      await harness.getData("status", { companyId: FF_CO });
      expect(resolves).toHaveLength(1);
      await waitFor(() => ff.recordedRequests.some((r) => r.url === "/detail"));
      await waitFor(async () => {
        const s = await harness.getData<{ objects: Record<string, unknown> | null }>("status", {
          companyId: FF_CO,
        });
        return JSON.stringify(s.objects ?? {}).includes("Creator 5");
      });
      const status = await harness.getData<Record<string, unknown>>("status", { companyId: FF_CO });
      expect(status.degraded).toBeUndefined();
      const files = await harness.getData<unknown>("files", { companyId: FF_CO });
      expect(JSON.stringify(files)).toContain("ff-part.gcode");
      // Live transport: later page polls spend no further resolve.
      expect(resolves).toHaveLength(1);
      // The secret ref resolved is FF_CO's own (no other ref exists).
      expect(JSON.stringify(resolves[0])).toContain("0000000000aa");
    } finally {
      worker.client?.stop();
    }
  });

  it("A4: a Moonraker company page still works, and switching back does not leak FlashForge data", async () => {
    const { harness, worker } = await bootFlashForgeFirst();
    try {
      await harness.getData("status", { companyId: FF_CO });
      await waitFor(() => worker.client?.kind === "flashforge");
      const files = await harness.getData<unknown>("files", { companyId: MOON_1 });
      expect(worker.client?.kind).toBe("moonraker");
      expect(JSON.stringify(files)).toContain("moon-part.gcode");
      expect(JSON.stringify(files)).not.toContain("ff-part.gcode");
    } finally {
      worker.client?.stop();
    }
  });

  it("A5: a company with no row never reaches any printer; tool tenancy unchanged", async () => {
    const { harness, worker, resolves } = await bootFlashForgeFirst();
    try {
      await harness.getData("status", { companyId: FF_CO });
      for (const scope of [{ companyId: NONE }, {}]) {
        const s = await harness.getData<{ connection: { state: string } }>("status", scope);
        expect(s.connection.state).toBe("idle");
        const f = await harness.getData<unknown>("files", scope);
        expect(f).toEqual([]);
      }
      expect(resolves).toHaveLength(1);
      expect(harness.logs.some((l) => l.message === "klipper.tenancy.client_denied")).toBe(true);
    } finally {
      worker.client?.stop();
    }
  });

  it("A5: a failing secret stays fail-closed and is not retried on every poll", async () => {
    const harness = createRunCtxAwareHarness({ manifest, capabilities: [...CAPABILITIES] });
    let calls = 0;
    harness.ctx.secrets.resolve = (async () => {
      calls += 1;
      throw new Error("denied");
    }) as typeof harness.ctx.secrets.resolve;
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    await worker.applyConfig(ffRow() as never, "configChanged", false, FF_CO);
    await worker.applyConfig(moonRow() as never, "configChanged", false, MOON_1);
    for (let i = 0; i < 3; i += 1) {
      const s = await harness.getData<{ connection: { state: string } }>("status", { companyId: FF_CO });
      expect(s.connection.state).toBe("idle");
      expect(await harness.getData("files", { companyId: FF_CO })).toEqual([]);
    }
    expect(calls).toBe(1);
    expect(ff.recordedRequests).toHaveLength(0);
    worker.client?.stop();
  });
});
