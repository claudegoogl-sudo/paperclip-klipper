/**
 * Unit coverage for the fail-closed flashforge config validator, focused on
 * the two accepted secret-ref shapes: the legacy non-empty string and the
 * object binding ref. The ref value itself is opaque to the transport — it
 * must flow through to the connection config untouched (normalized objects
 * only) so the host decides resolvability at request time.
 */
import { describe, expect, it } from "vitest";
import {
  selectTransport,
  validateFlashForgeConfig,
} from "../../src/worker/transports/validateTransportConfig.js";

const UUID = "690a5384-1234-4abc-8abc-000000000001";
const BASE = {
  flashforgeBaseUrl: "http://192.168.1.50",
  flashforgeSerialNumber: "SN-C5",
};

describe("selectTransport", () => {
  it("absent/null/empty resolves to moonraker; unknown values rejected", () => {
    expect(selectTransport(undefined)).toEqual({ ok: true, kind: "moonraker" });
    expect(selectTransport(null)).toEqual({ ok: true, kind: "moonraker" });
    expect(selectTransport("")).toEqual({ ok: true, kind: "moonraker" });
    expect(selectTransport("moonraker")).toEqual({ ok: true, kind: "moonraker" });
    expect(selectTransport("flashforge")).toEqual({ ok: true, kind: "flashforge" });
    const bad = selectTransport("moonraker2");
    expect(bad.ok).toBe(false);
  });
});

describe("validateFlashForgeConfig — legacy string checkCodeRef", () => {
  it("accepts a name-style legacy string ref", () => {
    const result = validateFlashForgeConfig({
      ...BASE,
      flashforgeCheckCodeRef: "flashforge-check-code",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.checkCodeRef).toBe("flashforge-check-code");
      expect(result.config.baseUrl).toBe("http://192.168.1.50:8898/");
    }
  });
});

describe("validateFlashForgeConfig — object binding checkCodeRef", () => {
  it("accepts the object shape and normalizes it (absent version collapses to latest)", () => {
    const result = validateFlashForgeConfig({
      ...BASE,
      flashforgeCheckCodeRef: { type: "secret_ref", secretId: UUID },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.checkCodeRef).toEqual({
        type: "secret_ref",
        secretId: UUID,
        version: "latest",
      });
    }
  });

  it("keeps a pinned version on the normalized ref", () => {
    const result = validateFlashForgeConfig({
      ...BASE,
      flashforgeCheckCodeRef: { secretId: UUID, type: "secret_ref", version: 2 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.checkCodeRef).toEqual({ type: "secret_ref", secretId: UUID, version: 2 });
    }
  });
});

describe("validateFlashForgeConfig — fail closed on unusable refs", () => {
  it("reports missing for absent/empty/malformed refs (never string coercion)", () => {
    for (const ref of [
      undefined,
      "",
      "   ",
      null,
      {},
      { type: "secret_ref" },
      { type: "secret_ref", secretId: "nope" },
      { type: "secret_ref", secretId: UUID, version: "2" },
    ]) {
      const result = validateFlashForgeConfig({ ...BASE, flashforgeCheckCodeRef: ref });
      expect(result.ok, `expected missing_fields for ${JSON.stringify(ref)}`).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("missing_fields");
        expect(result.fields).toContain("flashforgeCheckCodeRef");
      }
    }
  });

  it("reports every missing flashforge field together", () => {
    const result = validateFlashForgeConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fields).toEqual([
        "flashforgeBaseUrl",
        "flashforgeSerialNumber",
        "flashforgeCheckCodeRef",
      ]);
    }
  });
});
