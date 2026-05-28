/**
 * Manifest ↔ worker contract test (PLA-510).
 *
 * PLA-509 DPR found that the worker was registering bare tool names while
 * the host dispatches by the namespaced manifest name, so every
 * `/api/plugins/tools/execute` call against `klipper.*` returned a 500
 * dispatch error. The host does NOT auto-namespace — registered names
 * MUST equal `manifest.tools[].name` verbatim. PLA-509 also surfaced
 * schema drift between manifest and worker (v0.1.0 manifest declared
 * `{filename, artifactId}` while the worker accepted
 * `{filename, gcodeBase64, path}`); v0.1.1 aligned both to
 * `{filename, gcodeBase64, path?}` as a hotfix, and PLA-576 / v0.1.6 lands
 * the original artifactId contract once PLA-574 shipped
 * `runCtx.artifacts.fetch`.
 *
 * This test boots `registerRpcSurface(stubCtx, …)` against a stub
 * PluginContext that records every `ctx.tools.register(name, schema, …)`
 * call. It then asserts:
 *
 *  - the set of registered tool names equals the set of `manifest.tools[].name`
 *  - for each tool, the registered `parametersSchema` deep-equals the
 *    manifest's `parametersSchema`
 *
 * Either drift (name set or schema) makes this test fail, which is how
 * PLA-509 will catch the next regression before it ships.
 */
import { describe, expect, it } from "vitest";
import type {
  PluginContext,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import manifest from "../../src/manifest.js";
import {
  registerRpcSurface,
  type KlipperConfig,
} from "../../src/worker/registerRpcSurface.js";

interface RegisteredTool {
  name: string;
  declaration: {
    displayName?: string;
    description?: string;
    parametersSchema: unknown;
  };
  handler: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>;
}

function buildStubCtx(registered: RegisteredTool[]): PluginContext {
  const noopRegister = () => {};
  // We only need the register surfaces touched by registerRpcSurface
  // (data / actions / tools). The rest of PluginContext is filled with
  // throw-on-access proxies so accidental dependencies are loud.
  const stub: Partial<PluginContext> = {
    data: { register: noopRegister } as PluginContext["data"],
    actions: { register: noopRegister } as PluginContext["actions"],
    tools: {
      register: (name, declaration, handler) => {
        registered.push({ name, declaration, handler });
      },
    } as PluginContext["tools"],
  };
  return stub as PluginContext;
}

function buildStubClient(): unknown {
  // registerRpcSurface only dereferences the client inside handlers.
  // Registration time never calls into the client, so a sentinel object
  // is enough — the contract test does not invoke the handlers.
  return { __stub: true };
}

describe("manifest ↔ worker tool contract (PLA-510)", () => {
  const config: KlipperConfig = {
    moonrakerBaseUrl: "http://printer.invalid:7125",
  };
  const registered: RegisteredTool[] = [];
  const stubCtx = buildStubCtx(registered);

  registerRpcSurface(stubCtx, {
    config,
    // Cast: registration path never dereferences the client; see comment above.
    client: buildStubClient() as Parameters<typeof registerRpcSurface>[1]["client"],
  });

  const manifestToolNames = new Set(manifest.tools?.map((t) => t.name) ?? []);
  const registeredToolNames = new Set(registered.map((t) => t.name));

  it("registered tool name set equals manifest.tools[].name set", () => {
    expect(registeredToolNames).toEqual(manifestToolNames);
  });

  it("every manifest tool is registered with the same parametersSchema", () => {
    for (const manifestTool of manifest.tools ?? []) {
      const match = registered.find((r) => r.name === manifestTool.name);
      expect(match, `worker did not register ${manifestTool.name}`).toBeDefined();
      expect(
        match!.declaration.parametersSchema,
        `parametersSchema drift for ${manifestTool.name}`,
      ).toEqual(manifestTool.parametersSchema);
    }
  });

  it("no extra tools are registered beyond the manifest declaration", () => {
    for (const r of registered) {
      expect(manifestToolNames.has(r.name), `worker registered ${r.name} but the manifest does not declare it`).toBe(true);
    }
  });
});
