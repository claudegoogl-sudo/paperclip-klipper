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
import { describe, expect, it } from "vitest";
import { MoonrakerClient } from "../../src/worker/MoonrakerClient.js";
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
