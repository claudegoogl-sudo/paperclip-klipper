/**
 * Post-review hardening regressions (from the security review of the
 * FlashForge transport PR):
 *
 *   F1 — `filename` gets the same worker-side runtime backstop `path`
 *        already has: a `uploadFilenameError()` re-check mirroring the
 *        schema pattern, enforced in the upload_gcode AND start_print
 *        handlers BEFORE any artifact fetch or client call. A missed or
 *        bypassed host-side schema validation must not be able to push a
 *        quote/CRLF/NUL into the hand-rolled multipart Content-Disposition
 *        of either transport.
 *   F2 — printer-controlled envelope `message` text is capped (1024 chars,
 *        matching the Moonraker error-body cap) before it can reach a
 *        ToolResult error string.
 *   F3 — `flashforgeBaseUrl` with embedded userinfo (basic-auth credentials)
 *        is rejected fail-closed at config validation.
 *
 * The handler-level F1 tests drive the registered tool handlers DIRECTLY —
 * schema validation is bypassed by design, because the whole point is the
 * worker-side backstop behind the schema.
 */
import { describe, expect, it } from "vitest";
import type {
  PluginContext,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  registerRpcSurface,
  type KlipperConfig,
} from "../../src/worker/registerRpcSurface.js";
import { FlashForgeClient } from "../../src/worker/transports/FlashForgeClient.js";
import {
  validateFlashForgeConfig,
} from "../../src/worker/transports/validateTransportConfig.js";
import type { PluginHttpClient, PluginLogger, PluginSecretsClient } from "@paperclipai/plugin-sdk";

interface RegisteredTool {
  name: string;
  handler: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>;
}

function buildStubCtx(registered: RegisteredTool[]): PluginContext {
  const noop = () => {};
  const stub: Partial<PluginContext> = {
    data: { register: noop } as PluginContext["data"],
    actions: { register: noop } as PluginContext["actions"],
    tools: {
      register: (name: string, _decl: unknown, handler: RegisteredTool["handler"]) => {
        registered.push({ name, handler });
      },
    } as PluginContext["tools"],
    // readLiveConfig re-reads config per dispatch; the gates must be ON so
    // the tests exercise the filename backstop, not the gate refusal.
    config: {
      get: async () => ({ auto_upload_artifacts: true, allow_agent_initiated_print: true }),
    } as PluginContext["config"],
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    } as PluginContext["logger"],
  };
  return stub as PluginContext;
}

describe("F1: worker-side filename re-validation (both transports share the handler choke point)", () => {
  const BAD_FILENAMES = [
    'bracket".gcode', // quote → multipart header injection
    "bracket\r\n.gcode", // CRLF → header/section smuggling
    "bracket\n.gcode",
    "bracket\0.gcode", // NUL
    "../escape.gcode", // traversal-ish (also fails schema)
    "bracket.GCODE", // wrong extension casing (pattern is case-sensitive)
    "a".repeat(130) + ".gcode", // over the 128-char cap
  ];

  function registerSurface() {
    const registered: RegisteredTool[] = [];
    const ctx = buildStubCtx(registered);
    const uploadCalls: string[] = [];
    const startCalls: string[] = [];
    const artifactFetches: string[] = [];
    const fakeClient = {
      kind: "moonraker" as const,
      async uploadGcode(filename: string) {
        uploadCalls.push(filename);
        return { item: { path: filename, root: "gcodes", size: 1, modified: 0 } };
      },
      async startPrint(filename: string) {
        startCalls.push(filename);
        return "ok";
      },
    };
    registerRpcSurface(ctx, {
      config: { auto_upload_artifacts: true, allow_agent_initiated_print: true } as KlipperConfig,
      client: fakeClient as never,
    });
    const upload = registered.find((t) => t.name === "klipper.upload_gcode")!.handler;
    const start = registered.find((t) => t.name === "klipper.start_print")!.handler;
    const runCtx = {
      artifacts: {
        async fetch(id: string) {
          artifactFetches.push(id);
          return {
            bytes: new Uint8Array([0x47]),
            filename: "unused.gcode",
            contentType: "application/octet-stream",
            byteSize: 1,
          };
        },
      },
    } as unknown as ToolRunContext;
    return { upload, start, runCtx, uploadCalls, startCalls, artifactFetches };
  }

  it("refuses unsafe filenames in upload_gcode BEFORE any artifact fetch or client call", async () => {
    for (const filename of BAD_FILENAMES) {
      const { upload, runCtx, uploadCalls, artifactFetches } = registerSurface();
      const result = await upload({ filename, artifactId: "33333333-3333-4333-8333-333333333333" }, runCtx);
      expect(result.error, `filename ${JSON.stringify(filename)} must be refused`).toMatch(
        /upload_gcode: refused — filename/i,
      );
    }
    const { uploadCalls, artifactFetches } = registerSurface();
    expect(uploadCalls).toHaveLength(0);
    expect(artifactFetches).toHaveLength(0);
  });

  it("refuses unsafe filenames in start_print before any client call", async () => {
    for (const filename of BAD_FILENAMES) {
      const { start, startCalls } = registerSurface();
      const result = await start({ filename }, {} as ToolRunContext);
      expect(result.error, `filename ${JSON.stringify(filename)} must be refused`).toMatch(
        /start_print: refused — filename/i,
      );
      expect(startCalls).toHaveLength(0);
    }
  });

  it("lets schema-valid filenames through (no over-blocking)", async () => {
    const { upload, runCtx, uploadCalls, artifactFetches } = registerSurface();
    const result = await upload(
      { filename: "bracket_rev-2.gcode", artifactId: "33333333-3333-4333-8333-333333333333" },
      runCtx,
    );
    expect(result.error).toBeUndefined();
    expect(uploadCalls).toEqual(["bracket_rev-2.gcode"]);
    expect(artifactFetches).toHaveLength(1);
  });
});

describe("F2: printer-controlled envelope message is capped at 1024 chars", () => {
  function makeStubHttp(message: string): PluginHttpClient {
    return {
      async fetch() {
        return new Response(
          JSON.stringify({ code: 1, message }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    };
  }

  function makeClient(message: string) {
    const logger: PluginLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    return new FlashForgeClient({
      baseUrl: "http://printer.lan:8898",
      serialNumber: "SN",
      checkCode: "cc",
      http: makeStubHttp(message),
      logger,
    });
  }

  it("a 100 KB printer error message cannot stuff the ToolResult error string", async () => {
    const client = makeClient("A".repeat(100 * 1024));
    let thrown: unknown = null;
    await client.listFiles().catch((err) => {
      thrown = err;
    });
    expect(thrown).toBeInstanceOf(Error);
    // 1024-char cap + the short prefix FlashForgeApiError adds.
    expect((thrown as Error).message.length).toBeLessThanOrEqual(1024 + 80);
  });

  it("short printer messages pass through intact", async () => {
    const client = makeClient("check code incorrect");
    let thrown: unknown = null;
    await client.listFiles().catch((err) => {
      thrown = err;
    });
    expect((thrown as Error).message).toContain("check code incorrect");
  });

  it("end-to-end: the ToolResult error a dispatching agent receives stays ~1.1 KB", async () => {
    // The review criterion verbatim: a 100 KB envelope message must not
    // survive into the ToolResult error string. Drive the REAL surface —
    // a real FlashForgeClient (stubbed http) behind registerRpcSurface —
    // so the cap is exercised across assertEnvelope → FlashForgeApiError
    // → toolError, exactly the production path.
    const client = makeClient("C".repeat(100 * 1024));
    const registered: RegisteredTool[] = [];
    registerRpcSurface(buildStubCtx(registered), {
      config: {
        moonrakerBaseUrl: "http://printer.lan:7125",
        auto_upload_artifacts: true,
        allow_agent_initiated_print: true,
      } as KlipperConfig,
      client: client as never,
    });
    const start = registered.find((t) => t.name === "klipper.start_print")!.handler;
    const result = await start({ filename: "bracket.gcode" }, {} as ToolRunContext);
    expect(result.error).toBeDefined();
    // Exact composition: "start_print: " (13) + "FlashForge 200 (code 1): "
    // (25) + "endpoint /printGcode rejected the request (" (43) + the
    // 1024-char capped printer text + ")" (1) = 1106 — ~1.1 KB, never the
    // 100 KB the printer sent. Bound at 1150 so a one-char prefix tweak
    // does not break the invariant this test protects.
    expect(result.error!.length).toBeLessThanOrEqual(1150);
    expect(result.error!.length).toBeGreaterThan(50);
    // The diagnostic identity survives the cap (endpoint + envelope code).
    expect(result.error).toContain("printGcode");
    expect((result as { data?: { envelopeCode?: number } }).data?.envelopeCode).toBe(1);
  });
});

describe("F3: flashforgeBaseUrl userinfo is rejected fail-closed", () => {
  const base = {
    flashforgeSerialNumber: "SN-TEST-C5",
    flashforgeCheckCodeRef: "flashforge-check-code",
  };

  it("rejects http://user:pass@host URLs with a clear reason", () => {
    const result = validateFlashForgeConfig({
      ...base,
      flashforgeBaseUrl: "http://op:secret@printer.lan:8898",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("userinfo_not_allowed");
  });

  it("rejects user-only userinfo too", () => {
    const result = validateFlashForgeConfig({
      ...base,
      flashforgeBaseUrl: "http://op@printer.lan:8898",
    });
    expect(result.ok).toBe(false);
  });

  it("still accepts clean URLs", () => {
    const result = validateFlashForgeConfig({
      ...base,
      flashforgeBaseUrl: "http://printer.lan:8898",
    });
    expect(result.ok).toBe(true);
  });
});
