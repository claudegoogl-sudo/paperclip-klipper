import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createKlipperWorker } from "../src/worker.js";
import { validateMoonrakerBaseUrl } from "../src/worker/validateMoonrakerBaseUrl.js";

/**
 * Safety follow-up: klipper must not send a resolved `moonrakerApiKeyRef`
 * credential to a host it was not configured to talk to, regardless of what
 * value reaches config. Before this fix `worker.ts` did a presence check
 * only (`if (!baseUrl)`) and handed the raw string straight to
 * `MoonrakerClient`, which itself never validated scheme or host up front.
 *
 * These tests fail against the pre-fix code because `validateMoonrakerBaseUrl`
 * did not exist and `createKlipperWorker` never rejected a malformed/hostile
 * `moonrakerBaseUrl` — it either crashed inside `new URL()` or happily wired
 * up a client pointed at whatever string was supplied.
 */

const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "events.subscribe",
  "events.emit",
] as const;

describe("validateMoonrakerBaseUrl (unit)", () => {
  it("accepts a well-formed https URL with no allowlist configured", () => {
    const result = validateMoonrakerBaseUrl("https://printer.lan:7125");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.host).toBe("printer.lan:7125");
  });

  it("accepts a well-formed http URL (Moonraker is commonly unencrypted on a LAN)", () => {
    const result = validateMoonrakerBaseUrl("http://127.0.0.1:7125");
    expect(result.ok).toBe(true);
  });

  it("rejects a non-http(s) scheme", () => {
    const result = validateMoonrakerBaseUrl("ftp://printer.lan");
    expect(result).toEqual({ ok: false, reason: "unsupported_scheme", host: "printer.lan" });
  });

  it("rejects an unparseable value", () => {
    const result = validateMoonrakerBaseUrl("not a url");
    expect(result).toEqual({ ok: false, reason: "unparseable", host: null });
  });

  it("rejects an attacker origin whose PATH merely contains the expected host (ported from paperclip-plugin-cad's parseGitHubUrl F4 test)", () => {
    const result = validateMoonrakerBaseUrl(
      "https://attacker.example/path/moonraker.local/status",
      ["moonraker.local"],
    );
    expect(result).toEqual({
      ok: false,
      reason: "host_not_allowed",
      host: "attacker.example",
    });
  });

  it("accepts when the host matches an explicit allowlist", () => {
    const result = validateMoonrakerBaseUrl("https://moonraker.local/", ["moonraker.local"]);
    expect(result.ok).toBe(true);
  });

  it("rejects when the host does not match an explicit allowlist", () => {
    const result = validateMoonrakerBaseUrl("https://other.example/", ["moonraker.local"]);
    expect(result).toEqual({ ok: false, reason: "host_not_allowed", host: "other.example" });
  });
});

describe("createKlipperWorker fails closed on an invalid moonrakerBaseUrl", () => {
  it("falls back to permissive-init (client: null) for a non-http(s) scheme, and warns with the host only", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: "javascript:alert(1)", moonrakerApiKeyRef: "secret-key" },
    });
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    expect(worker.client).toBeNull();
    const warnLine = harness.logs.find(
      (e) => e.level === "warn" && e.message.includes("rejected moonrakerBaseUrl"),
    );
    expect(warnLine).toBeDefined();
    // The rejected host must be logged (operators need it to diagnose) but
    // never the full raw value and never the credential reference.
    expect(JSON.stringify(warnLine)).not.toContain("secret-key");
  });

  it("falls back to permissive-init when the configured host is not on the operator allowlist", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: {
        moonrakerBaseUrl: "https://attacker.example/path/moonraker.local/status",
        moonrakerAllowedHosts: ["moonraker.local"],
        moonrakerApiKeyRef: "secret-key",
      },
    });
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    expect(worker.client).toBeNull();
    const result = await harness.executeTool<{ data?: { error?: string } }>(
      "klipper.get_printer_status",
      {},
    );
    expect(result.data?.error).toBe("prerequisite_missing");
  });

  it("does not throw / crash worker setup on an unparseable moonrakerBaseUrl", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: "not a url" },
    });
    await expect(createKlipperWorker(harness.ctx, { autoStart: false })).resolves.not.toThrow();
  });

  it("still connects when moonrakerBaseUrl is valid and no allowlist is set (no behavior change for existing single-host configs)", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...CAPABILITIES],
      config: { moonrakerBaseUrl: "http://127.0.0.1:1" },
    });
    const worker = await createKlipperWorker(harness.ctx, { autoStart: false });
    expect(worker.client).not.toBeNull();
  });
});
