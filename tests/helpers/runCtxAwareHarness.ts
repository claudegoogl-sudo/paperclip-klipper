/**
 * fork51-generation SDK testing-harness adapter.
 *
 * The 2026.923.1-fork51 harness projects `executeTool`'s runCtx down to the
 * four identity fields (agentId/runId/companyId/projectId) and drops
 * everything else. Production injects `runCtx.artifacts` inside
 * `handleExecuteTool`, but the harness never does — so specs that stub
 * `artifacts` (every upload-path spec) would silently receive `undefined`
 * and fail with "Cannot read properties of undefined (reading 'fetch')".
 *
 * This wrapper restores the previous pass-through contract: the caller's
 * runCtx (identity fields + artifact stubs) is merged over the identity
 * defaults and handed to the registered handler verbatim. Tool
 * registrations still reach the harness itself, so non-tool harness
 * surfaces keep working.
 */
import { randomUUID } from "node:crypto";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";

type Handler = (params: unknown, runCtx: ToolRunContext) => Promise<unknown>;
type ExecuteTool = (
  name: string,
  params: unknown,
  runCtx?: Record<string, unknown>,
) => Promise<unknown>;

export function createRunCtxAwareHarness(options: Parameters<typeof createTestHarness>[0]) {
  const harness = createTestHarness(options as never);
  const handlers = new Map<string, Handler>();

  const originalRegister = harness.ctx.tools.register.bind(harness.ctx.tools);
  harness.ctx.tools.register = ((name: string, declaration: unknown, fn: Handler) => {
    handlers.set(name, fn);
    return originalRegister(name, declaration as never, fn as never);
  }) as typeof harness.ctx.tools.register;

  (harness as unknown as { executeTool: ExecuteTool }).executeTool = async (
    name,
    params,
    runCtx = {},
  ) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`No tool handler registered for '${name}'`);
    return handler(params, {
      agentId: "agent-test",
      runId: randomUUID(),
      companyId: "company-test",
      projectId: "project-test",
      ...runCtx,
    } as ToolRunContext);
  };

  return harness;
}
