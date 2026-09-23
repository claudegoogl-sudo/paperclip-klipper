/**
 * Unit coverage for the shared secret-ref helper: the object binding shape
 * must mirror the host's binding parser exactly (what the host accepts at
 * config-save is what this plugin treats as well-formed), legacy string
 * refs must keep working, and the canonical identity used by the config
 * fingerprints must be stable across object key order.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalSecretRefIdentity,
  isConfiguredSecretRef,
  normalizedSecretRef,
  parseSecretRefObject,
} from "../../src/worker/secretRef.js";

const UUID = "690a5384-1234-4abc-8abc-000000000001";

describe("parseSecretRefObject (host binding shape)", () => {
  it("parses the canonical object shape and normalizes fields", () => {
    expect(parseSecretRefObject({ type: "secret_ref", secretId: UUID })).toEqual({
      type: "secret_ref",
      secretId: UUID,
      version: "latest",
    });
    expect(parseSecretRefObject({ type: "secret_ref", secretId: ` ${UUID} ` })).toEqual({
      type: "secret_ref",
      secretId: UUID,
      version: "latest",
    });
    expect(parseSecretRefObject({ type: "secret_ref", secretId: UUID, version: "latest" })).toEqual({
      type: "secret_ref",
      secretId: UUID,
      version: "latest",
    });
    expect(parseSecretRefObject({ type: "secret_ref", secretId: UUID, version: 3 })).toEqual({
      type: "secret_ref",
      secretId: UUID,
      version: 3,
    });
  });

  it("accepts an UPPERCASE uuid (host regex is case-insensitive)", () => {
    expect(parseSecretRefObject({ type: "secret_ref", secretId: UUID.toUpperCase() })).toEqual({
      type: "secret_ref",
      secretId: UUID.toUpperCase(),
      version: "latest",
    });
  });

  it("rejects malformed objects like the host does", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "not-an-object",
      42,
      [],
      {},
      { type: "secret_ref" },
      { type: "secret_ref", secretId: "not-a-uuid" },
      { type: "secret_ref", secretId: UUID, version: 0 },
      { type: "secret_ref", secretId: UUID, version: -1 },
      { type: "secret_ref", secretId: UUID, version: 1.5 },
      { type: "secret_ref", secretId: UUID, version: "2" },
      { type: "SECRET_REF", secretId: UUID },
      { secretId: UUID },
    ];
    for (const value of bad) {
      expect(parseSecretRefObject(value), `expected rejection for ${JSON.stringify(value)}`).toBeNull();
    }
  });
});

describe("isConfiguredSecretRef (fail-closed missing-field gate)", () => {
  it("accepts non-empty legacy strings and well-formed objects", () => {
    expect(isConfiguredSecretRef("flashforge-check-code")).toBe(true);
    expect(isConfiguredSecretRef("  spaced  ")).toBe(true);
    expect(isConfiguredSecretRef({ type: "secret_ref", secretId: UUID })).toBe(true);
  });

  it("rejects empty strings and everything that is not a usable ref", () => {
    expect(isConfiguredSecretRef("")).toBe(false);
    expect(isConfiguredSecretRef("   ")).toBe(false);
    expect(isConfiguredSecretRef(undefined)).toBe(false);
    expect(isConfiguredSecretRef(null)).toBe(false);
    expect(isConfiguredSecretRef({})).toBe(false);
    expect(isConfiguredSecretRef({ type: "secret_ref" })).toBe(false);
    expect(isConfiguredSecretRef({ type: "secret_ref", secretId: "nope" })).toBe(false);
  });
});

describe("canonicalSecretRefIdentity (config fingerprint identity)", () => {
  it("prefixes legacy strings (`string:`) so string and object identities stay disjoint", () => {
    expect(canonicalSecretRefIdentity("flashforge-check-code")).toBe(
      "string:flashforge-check-code",
    );
  });

  it("a legacy string that literally equals an object's canonical form is a DIFFERENT identity", () => {
    const objectIdentity = canonicalSecretRefIdentity({ type: "secret_ref", secretId: UUID });
    const lookalike = `secret_ref:${UUID}:latest`;
    expect(canonicalSecretRefIdentity(lookalike)).not.toBe(objectIdentity);
    expect(canonicalSecretRefIdentity(lookalike)).toBe(`string:${lookalike}`);
  });

  it("a legacy string that mimics the malformed branch is also distinct", () => {
    const malformedIdentity = canonicalSecretRefIdentity({
      type: "secret_ref",
      secretId: "not-a-uuid",
    });
    expect(malformedIdentity.startsWith("secret_ref:malformed:")).toBe(true);
    // The exact lookalike a string would need to alias the malformed branch.
    const lookalike =
      'secret_ref:malformed:{"secretId":"not-a-uuid","type":"secret_ref"}';
    expect(canonicalSecretRefIdentity(lookalike)).not.toBe(malformedIdentity);
    expect(canonicalSecretRefIdentity(lookalike)).toBe(`string:${lookalike}`);
  });

  it("is stable across object key order and trims", () => {
    const a = canonicalSecretRefIdentity({ type: "secret_ref", secretId: UUID });
    const b = canonicalSecretRefIdentity({ secretId: UUID, type: "secret_ref" });
    const c = canonicalSecretRefIdentity({ type: "secret_ref", secretId: ` ${UUID} ` });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("distinguishes version and secret changes, and strings from objects", () => {
    const base = canonicalSecretRefIdentity({ type: "secret_ref", secretId: UUID });
    expect(canonicalSecretRefIdentity({ type: "secret_ref", secretId: UUID, version: 2 })).not.toBe(base);
    expect(canonicalSecretRefIdentity({ type: "secret_ref", secretId: UUID, version: "latest" })).toBe(
      base,
    );
    expect(canonicalSecretRefIdentity(UUID)).not.toBe(base);
  });
});

describe("normalizedSecretRef", () => {
  it("returns strings untouched and canonicalizes objects", () => {
    expect(normalizedSecretRef("ref")).toBe("ref");
    expect(normalizedSecretRef({ type: "secret_ref", secretId: UUID, version: "latest" })).toEqual({
      type: "secret_ref",
      secretId: UUID,
      version: "latest",
    });
    expect(normalizedSecretRef({ type: "secret_ref", secretId: UUID })).toEqual({
      type: "secret_ref",
      secretId: UUID,
      version: "latest",
    });
  });
});
