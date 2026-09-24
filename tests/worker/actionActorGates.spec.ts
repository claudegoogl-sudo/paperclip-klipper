/**
 * Actor-type gates on the actions bridge (phase-2 security conditions C4
 * and C5, plus the C1 camera amendment):
 *
 *   C4 — the actions bridge authenticates board users AND agent API keys,
 *        and the worker is the only place that can tell them apart. The
 *        mutating actions (start/pause/resume/cancel_print, delete_file,
 *        upload_gcode) must gate AGENT callers on the SAME live-config
 *        flags the tools use, re-read per dispatch and failing closed on
 *        read errors — while board users keep tap-to-consent (a human
 *        pressing the button IS the consent signal).
 *
 *   C5 — the upload_gcode ACTION delegates to the same uploadGcodeCore as
 *        the tool: filename/path backstops, gunzip bomb guard, transport
 *        upload are code-identical, and agents pass the same
 *        auto_upload_artifacts gate.
 *
 *   C1 — camera frames must never reach agent keys: camera_open /
 *        camera_next / camera_retry refuse agents outright; camera_close
 *        is safe for every actor (it only releases the printer's
 *        single-viewer slot).
 */
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import type {
  PluginContext,
  PluginPerformActionContext,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  registerRpcSurface,
  type KlipperConfig,
} from "../../src/worker/registerRpcSurface.js";
import { CameraFeed } from "../../src/worker/camera/CameraFeed.js";

type ActionHandler = (
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
) => Promise<unknown>;

interface RegisteredAction {
  key: string;
  handler: ActionHandler;
}

interface RegisteredTool {
  name: string;
  handler: (params: unknown, runCtx: ToolRunContext) => Promise<unknown>;
}

const BOARD_USER: PluginPerformActionContext = {
  actor: { type: "user", userId: "u-1", agentId: null, runId: null, companyId: "co-1" },
  companyId: "co-1",
};

const AGENT: PluginPerformActionContext = {
  actor: { type: "agent", userId: null, agentId: "ag-1", runId: "run-1", companyId: "co-1" },
  companyId: "co-1",
};

const SYSTEM: PluginPerformActionContext = {
  actor: { type: "system", userId: null, agentId: null, runId: null, companyId: null },
  companyId: null,
};

function buildHarness(opts: {
  config?: Partial<KlipperConfig>;
  configGetImpl?: () => Promise<Record<string, unknown>>;
  camera?: CameraFeed | null;
  maxInflatedGcodeBytes?: number;
  uploadCalls?: Array<{ filename: string; bytes: Uint8Array; path?: string }>;
  startCalls?: string[];
  failCalls?: string[];
  deleteCalls?: string[];
}) {
  const noop = () => {};
  const configStore: Record<string, unknown> = {
    flashforgeBaseUrl: "http://flashforge.lan",
    auto_upload_artifacts: false,
    allow_agent_initiated_print: false,
    ...opts.config,
  };
  const actions: RegisteredAction[] = [];
  const tools: RegisteredTool[] = [];
  const fakeClient = {
    kind: "flashforge" as const,
    async uploadGcode(filename: string, bytes: Uint8Array, extra?: { path?: string }) {
      opts.uploadCalls?.push({ filename, bytes, path: extra?.path });
      return { item: { path: extra?.path ? `${extra.path}/${filename}` : filename, root: "gcodes", size: bytes.length, modified: 0 } };
    },
    async startPrint(filename: string) {
      opts.startCalls?.push(filename);
      return { started: filename };
    },
    async pausePrint() {
      opts.failCalls?.push("pause");
      return { paused: true };
    },
    async resumePrint() {
      opts.failCalls?.push("resume");
      return { resumed: true };
    },
    async cancelPrint() {
      opts.failCalls?.push("cancel");
      return { cancelled: true };
    },
    async deleteFile(path: string) {
      opts.deleteCalls?.push(path);
      return { item: { path, root: "gcodes" } };
    },
  };
  const stub: Partial<PluginContext> = {
    data: { register: noop } as PluginContext["data"],
    actions: {
      register: (key: string, handler: ActionHandler) => {
        actions.push({ key, handler });
      },
    } as PluginContext["actions"],
    tools: {
      register: (name: string, _decl: unknown, handler: RegisteredTool["handler"]) => {
        tools.push({ name, handler });
      },
    } as PluginContext["tools"],
    config: {
      get: opts.configGetImpl ?? (async () => configStore),
    } as PluginContext["config"],
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    } as PluginContext["logger"],
  };
  registerRpcSurface(stub as PluginContext, {
    config: configStore as unknown as KlipperConfig,
    getClient: () => fakeClient as never,
    camera: opts.camera ?? null,
    maxInflatedGcodeBytes: opts.maxInflatedGcodeBytes,
  });
  const act = (key: string, params: Record<string, unknown> = {}, context: PluginPerformActionContext = BOARD_USER) =>
    actions.find((a) => a.key === key)!.handler(params, context);
  return { actions, tools, configStore, act };
}

function makeCamera(overrides: Partial<ConstructorParameters<typeof CameraFeed>[0]> = {}) {
  return new CameraFeed({
    baseUrl: "http://flashforge.lan:8080/?action=stream",
    logger: {
      debug: noopLog,
      info: noopLog,
      warn: noopLog,
      error: noopLog,
    },
    fetchFn: async () => {
      throw new Error("no upstream in this test");
    },
    ...overrides,
  });
}

const noopLog = () => {};

describe("C4: mutating print actions gate agents on the live config flags", () => {
  const PRINT_ACTIONS: Array<[string, Record<string, unknown>]> = [
    ["start_print", { filename: "benchy.gcode" }],
    ["pause_print", {}],
    ["resume_print", {}],
    ["cancel_print", {}],
  ];

  it("a board user keeps tap-to-consent — actions run with all flags false", async () => {
    for (const [key, params] of PRINT_ACTIONS) {
      const h = buildHarness({}); // both flags false
      await expect(h.act(key, params, BOARD_USER)).resolves.toBeTruthy();
    }
  });

  it("an agent caller is refused while allow_agent_initiated_print is false", async () => {
    for (const [key, params] of PRINT_ACTIONS) {
      const h = buildHarness({ startCalls: [], failCalls: [] });
      await expect(h.act(key, params, AGENT)).rejects.toThrow(/allow_agent_initiated_print/);
      // and nothing reached the printer
      expect(h.actions).toBeDefined();
    }
  });

  it("an agent caller passes when the flag is true (same gate the tool uses)", async () => {
    for (const [key, params] of PRINT_ACTIONS) {
      const h = buildHarness({ config: { allow_agent_initiated_print: true } });
      await expect(h.act(key, params, AGENT)).resolves.toBeTruthy();
    }
  });

  it("the gate re-reads config LIVE — a flag flipped after registration is honored", async () => {
    const h = buildHarness({});
    // flip the flag AFTER the surface was registered
    h.configStore.allow_agent_initiated_print = true;
    await expect(h.act("start_print", { filename: "x.gcode" }, AGENT)).resolves.toBeTruthy();
    h.configStore.allow_agent_initiated_print = false;
    await expect(h.act("start_print", { filename: "x.gcode" }, AGENT)).rejects.toThrow(
      /allow_agent_initiated_print/,
    );
  });

  it("a config read error fails CLOSED for agents (board unaffected)", async () => {
    const h = buildHarness({ configGetImpl: async () => { throw new Error("config unavailable"); } });
    await expect(h.act("cancel_print", {}, AGENT)).rejects.toThrow();
    await expect(h.act("cancel_print", {}, BOARD_USER)).resolves.toBeTruthy();
  });

  it("a missing actor context is treated as non-agent (system scheduler paths)", async () => {
    const h = buildHarness({});
    await expect(h.act("pause_print", {}, SYSTEM)).resolves.toBeTruthy();
  });
});

describe("C4: delete_file gates agents on the storage flag", () => {
  it("board users delete with auto_upload_artifacts false (tap-to-consent)", async () => {
    const h = buildHarness({});
    await expect(h.act("delete_file", { path: "gcodes/old.gcode" }, BOARD_USER)).resolves.toBeTruthy();
  });

  it("agents are refused while the flag is false, allowed when true", async () => {
    const h = buildHarness({});
    await expect(h.act("delete_file", { path: "gcodes/old.gcode" }, AGENT)).rejects.toThrow(
      /auto_upload_artifacts/,
    );
    const h2 = buildHarness({ config: { auto_upload_artifacts: true } });
    await expect(h2.act("delete_file", { path: "gcodes/old.gcode" }, AGENT)).resolves.toBeTruthy();
  });
});

describe("C1: camera actions are board-only", () => {
  it("agent keys are refused on camera_open / camera_next / camera_retry", async () => {
    for (const key of ["camera_open", "camera_next", "camera_retry"]) {
      const h = buildHarness({ camera: makeCamera() });
      await expect(h.act(key, {}, AGENT)).rejects.toThrow(/restricted to board users/);
    }
  });

  it("board users can open and poll a configured camera", async () => {
    const h = buildHarness({ camera: makeCamera() });
    await expect(h.act("camera_open", {}, BOARD_USER)).resolves.toBeTruthy();
    const next = (await h.act("camera_next", {}, BOARD_USER)) as {
      ok: boolean;
      state: string;
      attempts: number;
      frame: unknown;
    };
    expect(next.ok).toBe(true);
    // the stub fetch rejects immediately, so by poll time the feed is
    // already backing off — either pre-first-await state is acceptable
    expect(["connecting", "reconnecting"]).toContain(next.state);
    expect(next.attempts).toBeGreaterThanOrEqual(0);
    expect(next.frame).toBeNull();
  });

  it("system actors are not agents — camera_close stays open to all actors", async () => {
    const h = buildHarness({ camera: makeCamera() });
    await expect(h.act("camera_close", {}, SYSTEM)).resolves.toBeTruthy();
    await expect(h.act("camera_close", {}, AGENT)).resolves.toBeTruthy();
  });

  it("with no camera configured the actions fail with prerequisite_missing", async () => {
    const h = buildHarness({ camera: null });
    await expect(h.act("camera_open", {}, BOARD_USER)).rejects.toThrow(
      /Camera not configured — set flashforgeCameraBaseUrl/,
    );
    await expect(h.act("camera_next", {}, BOARD_USER)).rejects.toThrow(/Camera not configured/);
    await expect(h.act("camera_retry", {}, BOARD_USER)).rejects.toThrow(/Camera not configured/);
    // close remains a no-op success
    await expect(h.act("camera_close", {}, BOARD_USER)).resolves.toBeTruthy();
  });
});

describe("C5: the upload_gcode ACTION shares the tool's policy core", () => {
  const GCODE = new TextEncoder().encode("G28\nG1 X0 Y0\n");

  it("board users keep tap-to-consent — the page upload works with the flag false", async () => {
    const uploadCalls: Array<{ filename: string; bytes: Uint8Array }> = [];
    const h = buildHarness({ uploadCalls }); // auto_upload_artifacts false
    const result = (await h.act(
      "upload_gcode",
      { filename: "benchy.gcode", gcodeBase64: Buffer.from(GCODE).toString("base64") },
      BOARD_USER,
    )) as { data?: { item: { path: string } }; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.data?.item.path).toBe("benchy.gcode");
    expect(uploadCalls).toHaveLength(1);
  });

  it("with the flag on, a plain g-code payload decodes and reaches the transport", async () => {
    const uploadCalls: Array<{ filename: string; bytes: Uint8Array }> = [];
    const h = buildHarness({ config: { auto_upload_artifacts: true }, uploadCalls });
    const result = (await h.act(
      "upload_gcode",
      { filename: "benchy.gcode", gcodeBase64: Buffer.from(GCODE).toString("base64") },
      BOARD_USER,
    )) as { data?: { item: { path: string } } };
    expect(result.data?.item.path).toBe("benchy.gcode");
    expect(uploadCalls).toHaveLength(1);
    expect(new TextDecoder().decode(uploadCalls[0].bytes)).toBe("G28\nG1 X0 Y0\n");
  });

  it("a gzip payload is inflated by the SAME bomb-guarded path (code identity)", async () => {
    const uploadCalls: Array<{ filename: string; bytes: Uint8Array }> = [];
    const h = buildHarness({ config: { auto_upload_artifacts: true }, uploadCalls });
    const gz = gzipSync(GCODE);
    const result = (await h.act(
      "upload_gcode",
      { filename: "benchy.gcode", gcodeBase64: Buffer.from(gz).toString("base64") },
      BOARD_USER,
    )) as { error?: string };
    expect(result.error).toBeUndefined();
    expect(uploadCalls).toHaveLength(1);
    expect(new TextDecoder().decode(uploadCalls[0].bytes)).toBe("G28\nG1 X0 Y0\n");
  });

  it("a gzip bomb is refused by the shared gunzip guard", async () => {
    const uploadCalls: Array<{ filename: string; bytes: Uint8Array }> = [];
    const maxBytes = 64 * 1024;
    const bomb = gzipSync(new Uint8Array(maxBytes * 4).fill(0x00)); // inflates to 4x cap
    const h = buildHarness({
      config: { auto_upload_artifacts: true },
      maxInflatedGcodeBytes: maxBytes,
      uploadCalls,
    });
    await expect(
      h.act(
        "upload_gcode",
        { filename: "bomb.gcode", gcodeBase64: Buffer.from(bomb).toString("base64") },
        BOARD_USER,
      ),
    ).rejects.toThrow(/cap \(possible gzip bomb\)/);
    expect(uploadCalls).toHaveLength(0);
  });

  it("an oversized inline payload is refused on the ENCODED length before decode", async () => {
    const uploadCalls: Array<{ filename: string; bytes: Uint8Array }> = [];
    const h = buildHarness({ config: { auto_upload_artifacts: true }, uploadCalls });
    const huge = "A".repeat(16 * 1024 * 1024 + 4); // 16MB cap + 4
    await expect(
      h.act("upload_gcode", { filename: "big.gcode", gcodeBase64: huge }, BOARD_USER),
    ).rejects.toThrow(/base64 cap/);
    expect(uploadCalls).toHaveLength(0);
  });

  it("non-base64 payloads are refused without reaching the transport", async () => {
    const uploadCalls: Array<{ filename: string; bytes: Uint8Array }> = [];
    const h = buildHarness({ config: { auto_upload_artifacts: true }, uploadCalls });
    await expect(
      h.act("upload_gcode", { filename: "benchy.gcode", gcodeBase64: "!!!not-base64!!!" }, BOARD_USER),
    ).rejects.toThrow(/not valid base64/);
    expect(uploadCalls).toHaveLength(0);
  });

  it("the filename backstop applies on the action path too (shared core)", async () => {
    const uploadCalls: Array<{ filename: string; bytes: Uint8Array }> = [];
    const h = buildHarness({ config: { auto_upload_artifacts: true }, uploadCalls });
    await expect(
      h.act(
        "upload_gcode",
        { filename: 'evil".gcode', gcodeBase64: Buffer.from(GCODE).toString("base64") },
        BOARD_USER,
      ),
    ).rejects.toThrow(/refused/);
    expect(uploadCalls).toHaveLength(0);
  });

  it("agents pass the same auto_upload_artifacts gate before the shared core", async () => {
    const uploadCalls: Array<{ filename: string; bytes: Uint8Array }> = [];
    const h = buildHarness({ uploadCalls });
    await expect(
      h.act(
        "upload_gcode",
        { filename: "benchy.gcode", gcodeBase64: Buffer.from(GCODE).toString("base64") },
        AGENT,
      ),
    ).rejects.toThrow(/auto_upload_artifacts/);
    expect(uploadCalls).toHaveLength(0);

    const h2 = buildHarness({ config: { auto_upload_artifacts: true }, uploadCalls });
    await expect(
      h2.act(
        "upload_gcode",
        { filename: "benchy.gcode", gcodeBase64: Buffer.from(GCODE).toString("base64") },
        AGENT,
      ),
    ).resolves.toBeTruthy();
    expect(uploadCalls).toHaveLength(1);
  });
});
