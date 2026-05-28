/**
 * PLA-514 regression: `MoonrakerClient.uploadGcode` MUST send Moonraker a
 * `Content-Type: multipart/form-data; boundary=…` header whose boundary token
 * literally appears as the delimiter in the request body. The previous
 * implementation passed a `FormData` to the plugin-sdk `PluginHttpClient`,
 * which serializes non-string bodies via `String(body)` (yielding
 * `"[object FormData]"`) and never synthesizes the multipart Content-Type
 * header. The result on Moonraker was
 * `HTTP 500 ParseFailedException: Missing Content-Type header`.
 *
 * This test exercises `MoonrakerClient` directly against a stub
 * `PluginHttpClient` that records every `fetch(url, init)` call and asserts:
 *   1. Captured `init.headers` (case-insensitive) carries a Content-Type
 *      matching `/^multipart\/form-data; boundary=.+/`.
 *   2. Captured `init.body` is a string whose opening delimiter contains the
 *      SAME boundary declared in the Content-Type header, proving header and
 *      body agree.
 *   3. The body contains the `filename="…"` Content-Disposition expected by
 *      Moonraker's `/server/files/upload`.
 *
 * Run via `npm test`.
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { MoonrakerClient } from "../../src/worker/MoonrakerClient.js";
import { registerRpcSurface } from "../../src/worker/registerRpcSurface.js";
import manifest from "../../src/manifest.js";
import type {
  PluginHttpClient,
  PluginHttpFetchInit,
  PluginLogger,
  PluginSecretsClient,
} from "@paperclipai/plugin-sdk";

interface RecordedCall {
  url: string;
  init: PluginHttpFetchInit | undefined;
}

function makeRecordingHttp(): { http: PluginHttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const http: PluginHttpClient = {
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      // Return a synthetic 201 with the shape `uploadGcode` parses.
      const body = JSON.stringify({
        item: { path: "x.gcode", root: "gcodes", size: 2, modified: 0 },
        print_started: false,
      });
      return new Response(body, {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { http, calls };
}

function makeNoopLogger(): PluginLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function makeStubSecrets(): PluginSecretsClient {
  return {
    async resolve(_ref: string) {
      return "stub-secret";
    },
  };
}

function lowerKey(headers: HeadersInit | undefined, key: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(key) ?? undefined;
  const target = key.toLowerCase();
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      if (k.toLowerCase() === target) return v;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

describe("MoonrakerClient.uploadGcode — PLA-514 multipart Content-Type", () => {
  it("sends a multipart Content-Type header whose boundary literally appears in the body", async () => {
    const { http, calls } = makeRecordingHttp();
    const client = new MoonrakerClient({
      baseUrl: "http://printer.lan:7125/",
      http,
      secrets: makeStubSecrets(),
      logger: makeNoopLogger(),
    });

    // Acceptance fixture from PLA-514: payload bytes "G1".
    await client.uploadGcode("x.gcode", new Uint8Array([0x47, 0x31]));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://printer.lan:7125/server/files/upload");

    // (1) Header MUST be multipart/form-data with a non-empty boundary.
    const ct = lowerKey(call.init?.headers, "content-type");
    expect(ct).toBeDefined();
    expect(ct).toMatch(/^multipart\/form-data; boundary=.+/);

    // Pull the boundary token out of the Content-Type header.
    const boundaryMatch = ct!.match(/boundary=(.+)$/);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1]!;
    expect(boundary.length).toBeGreaterThan(0);

    // (2) Captured body MUST be a string whose first bytes carry the same
    // boundary as the header (header + body agree). RFC 7578 prepends "--"
    // to the boundary token at part delimiters.
    expect(typeof call.init?.body).toBe("string");
    const body = call.init!.body as string;
    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(body).toContain(`--${boundary}--\r\n`); // closing delimiter present.

    // (3) Multipart envelope MUST include the filename header Moonraker keys
    //     on, and the raw payload bytes must round-trip into the body.
    expect(body).toContain('filename="x.gcode"');
    expect(body).toContain("G1");
  });
});

/**
 * PLA-612 worker-side gunzip. Real prints (>10 MB raw) only fit the
 * issue-attachment store when gzipped, but Moonraker needs plain g-code. The
 * `klipper.upload_gcode` handler must transparently inflate gzip-magic
 * artifacts before upload, leave plain artifacts byte-for-byte untouched, and
 * refuse — with a structured error rather than a raw throw — when a gzip bomb
 * would inflate past the cap.
 *
 * These exercise the tool handler (not MoonrakerClient) by registering the RPC
 * surface against a recording fake client that captures the exact `bytes`
 * argument handed to `uploadGcode`, then driving it through the SDK test
 * harness with a stubbed `runCtx.artifacts.fetch`.
 */
const GUNZIP_CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

const GUNZIP_ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";

interface UploadCapture {
  filename: string;
  bytes: Uint8Array;
  options: { path?: string; root?: string };
}

function setupGunzipHarness(opts: {
  artifactBytes: Uint8Array;
  maxInflatedGcodeBytes?: number;
}) {
  const captured: UploadCapture[] = [];
  const fakeClient = {
    async uploadGcode(
      filename: string,
      bytes: Uint8Array,
      options: { path?: string; root?: string } = {},
    ) {
      captured.push({ filename, bytes, options });
      return {
        item: { path: filename, root: "gcodes", size: bytes.length, modified: 0 },
        print_started: false,
      };
    },
  } as unknown as MoonrakerClient;

  const config = {
    moonrakerBaseUrl: "http://printer.lan:7125",
    auto_upload_artifacts: true,
  };
  const harness = createTestHarness({
    manifest,
    capabilities: [...GUNZIP_CAPABILITIES],
    config,
  });
  registerRpcSurface(harness.ctx, {
    config,
    client: fakeClient,
    maxInflatedGcodeBytes: opts.maxInflatedGcodeBytes,
  });

  const exec = () =>
    harness.executeTool<{ data?: unknown; error?: string }>(
      "klipper.upload_gcode",
      { filename: "demo.gcode", artifactId: GUNZIP_ARTIFACT_ID },
      {
        artifacts: {
          async fetch(id: string) {
            expect(id).toBe(GUNZIP_ARTIFACT_ID);
            return {
              bytes: opts.artifactBytes,
              filename: "demo.gcode",
              contentType: "application/octet-stream",
              byteSize: opts.artifactBytes.length,
            };
          },
        },
      },
    );

  return { harness, captured, exec };
}

describe("klipper.upload_gcode — PLA-612 worker-side gunzip", () => {
  it("gunzips a gzip-magic artifact so plain g-code reaches client.uploadGcode", async () => {
    const plain = new TextEncoder().encode(
      "G28\nG1 X10 Y10 F3000\nG1 Z0.2 F600\nM104 S210\n",
    );
    const gz = new Uint8Array(gzipSync(plain));
    // Sanity: the artifact really is a gzip container, distinct from the plain
    // payload (magic bytes present, different length).
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    expect(gz.length).not.toBe(plain.length);

    const { harness, captured, exec } = setupGunzipHarness({ artifactBytes: gz });
    const result = await exec();

    expect(result.error).toBeUndefined();
    expect(captured).toHaveLength(1);
    // The DECOMPRESSED payload reached the client — not the gz container.
    expect(Buffer.from(captured[0]!.bytes).equals(Buffer.from(plain))).toBe(true);
    // Regression guard: the still-gzipped magic must not survive to the client.
    expect(captured[0]!.bytes[0]).not.toBe(0x1f);
    // Observability: the inflate is logged for operators.
    expect(
      harness.logs.some(
        (e) => e.level === "info" && e.message === "klipper.upload_gcode.gunzip",
      ),
    ).toBe(true);
  });

  it("passes a plain (non-gzip) artifact through byte-for-byte", async () => {
    const plain = new TextEncoder().encode("G28\nG1 X1 Y1\nM104 S0\n");
    const { captured, exec } = setupGunzipHarness({ artifactBytes: plain });
    const result = await exec();

    expect(result.error).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(Buffer.from(captured[0]!.bytes).equals(Buffer.from(plain))).toBe(true);
  });

  it("refuses with a clear error (no raw throw) when inflation would exceed the cap", async () => {
    // A 64 KiB payload inflates well past a 16-byte cap, so gunzipSync throws
    // ERR_BUFFER_TOO_LARGE *during* inflation — the bomb guard fires before the
    // payload is fully materialized.
    const big = new Uint8Array(64 * 1024).fill(0x41);
    const gz = new Uint8Array(gzipSync(big));
    const { harness, captured, exec } = setupGunzipHarness({
      artifactBytes: gz,
      maxInflatedGcodeBytes: 16,
    });
    const result = await exec();

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/gzip bomb/);
    expect(result.error).toContain("16-byte cap");
    // Nothing oversized ever reached the printer.
    expect(captured).toHaveLength(0);
    // Observability: the rejection is logged at warn with the bomb flag.
    expect(
      harness.logs.some(
        (e) =>
          e.level === "warn" &&
          e.message === "klipper.upload_gcode.gunzip_failed" &&
          e.meta?.bomb === true,
      ),
    ).toBe(true);
  });
});
