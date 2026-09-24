/**
 * Boot a klipper worker the way the production host does: spawn the worker
 * (setup makes NO config read — see the boot-semantics note at the top of
 * `src/worker.ts`), then replay the configured company row through
 * `applyConfig(..., "configChanged")`, exactly like the host's startup
 * config replay / an operator save.
 *
 * Tests seed the harness with a `config`; by default this helper pushes that
 * same snapshot through the replay path. Passing `config` explicitly replays
 * a different snapshot instead.
 */
import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { KlipperConfig } from "../../src/worker/registerRpcSurface.js";
import {
  createKlipperWorker,
  type CreateKlipperWorkerOptions,
  type KlipperWorker,
} from "../../src/worker.js";

export async function bootWithReplay(
  harness: TestHarness,
  options: CreateKlipperWorkerOptions & { config?: Record<string, unknown> } = {},
): Promise<KlipperWorker> {
  const { config, ...createOptions } = options;
  const worker = await createKlipperWorker(harness.ctx, {
    autoStart: false,
    ...createOptions,
  });
  const seed = (config ?? (await harness.ctx.config.get()) ?? {}) as Partial<KlipperConfig>;
  await worker.applyConfig(seed, "configChanged", createOptions.autoStart === true);
  return worker;
}
