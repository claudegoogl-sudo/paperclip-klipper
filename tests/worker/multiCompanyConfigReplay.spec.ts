/**
 * Multi-company config replay through the real SDK worker RPC host.
 *
 * The host replays every configured company's stored row via `configChanged`
 * after each worker start. Companies can hold different configs (one company
 * uses FlashForge, the rest a Moonraker default). The worker is declared
 * multi-company, so every delivery must succeed: the SDK must not reject a
 * second, distinct company's config with CROSS_TENANT_CONFIG (-32006).
 */
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import manifest from "../../src/manifest.js";
import plugin from "../../src/worker.js";

type RpcMessage = { id?: number; result?: unknown; error?: { code: number; message: string } };

function connect() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const host = startWorkerRpcHost({ plugin, stdin, stdout });
  const pending = new Map<number, (m: RpcMessage) => void>();
  let buf = "";
  stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as RpcMessage & { method?: string };
      if (msg.method === undefined && typeof msg.id === "number") pending.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const call = (method: string, params: unknown) =>
    new Promise<RpcMessage>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { host, call };
}

const MOONRAKER_DEFAULT = { moonrakerBaseUrl: "http://printer.lan:7125" };
const FLASHFORGE = {
  transport: "flashforge",
  flashforgeBaseUrl: "http://192.0.2.10:8898",
  flashforgeSerialNumber: "SN-TEST",
  flashforgeCheckCodeRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001" },
};

describe("multi-company config replay (host startup delivery)", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it("declares multiCompanyConfig on the plugin definition", () => {
    expect(plugin.definition.multiCompanyConfig).toBe(true);
  });

  it("accepts a distinct config for a second company (no -32006)", async () => {
    const { host, call } = connect();
    stop = () => host.stop();
    const init = await call("initialize", {
      manifest,
      config: {},
      instanceInfo: { instanceId: "inst-test", hostVersion: "0.0.0-test" },
      apiVersion: manifest.apiVersion,
    });
    expect(init.error).toBeUndefined();

    // Host replay order is companyId ascending: identical defaults first,
    // then a company with its own printer, then another default.
    const rows = [
      { companyId: "11111111-1111-4111-8111-111111111111", config: MOONRAKER_DEFAULT },
      { companyId: "22222222-2222-4222-8222-222222222222", config: MOONRAKER_DEFAULT },
      { companyId: "33333333-3333-4333-8333-333333333333", config: FLASHFORGE },
      { companyId: "44444444-4444-4444-8444-444444444444", config: MOONRAKER_DEFAULT },
    ];
    const errors: Array<{ code: number } | undefined> = [];
    for (const row of rows) {
      const res = await call("configChanged", row);
      errors.push(res.error);
    }
    expect(errors).toEqual([undefined, undefined, undefined, undefined]);
  });
});
