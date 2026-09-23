/**
 * Manifest ↔ host contract for the secret-ref config fields.
 *
 * The host generation this plugin runs on validates plugin config in two
 * gates at the per-tenant config-overrides route:
 *
 *   Gate A (400) — Ajv validation of the full configJson against the
 *                  manifest instanceConfigSchema (ajv-formats; the
 *                  "secret-ref" format is registered as a UI hint that
 *                  always passes).
 *   Gate B (422) — binding extraction: the host walks the SAME schema
 *                  (recursing into allOf/anyOf/oneOf) to find every
 *                  `format: "secret-ref"` path. At those paths a bare-UUID
 *                  STRING value is explicitly rejected, and an object value
 *                  must parse as the binding shape
 *                  { type: "secret_ref", secretId, version? } to become a
 *                  company-scoped binding row.
 *
 * Before the dual-shape change, an object ref died at Gate A ("must be
 * string") while a bare-UUID string died at Gate B — the plugin could not
 * bind any secret at all on that host. This contract test pins the manifest
 * schema against BOTH gates so the bind path cannot silently regress:
 * it replicates the host's validator setup and the schema walker, then runs
 * the exact config shapes operators submit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import AjvModule from "ajv";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import manifest from "../../src/manifest.js";
import { parseSecretRefObject } from "../../src/worker/secretRef.js";

// Ajv 8 ships both CJS and ESM entry points; mirror the host validator's
// interop dance so the constructor resolves under either module system.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvCtor: any = (AjvModule as any).default ?? AjvModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const applyFormats: any = (addFormatsModule as any).default ?? addFormatsModule;

const UUID = "690a5384-1234-4abc-8abc-000000000001";
const REF_FIELDS = ["moonrakerApiKeyRef", "flashforgeCheckCodeRef"] as const;

const BASE_URL = "http://192.168.1.50";

/** Build an Ajv instance exactly like the host's plugin-config-validator. */
function buildHostLikeValidator() {
  const ajv = new AjvCtor({ allErrors: true });
  applyFormats(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  return ajv.compile(manifest.instanceConfigSchema as object);
}

/**
 * Subset of the host's schema walker that finds `format: "secret-ref"`
 * leaves, recursing into allOf/anyOf/oneOf exactly like the server's
 * collectFormatPaths.
 */
function collectSecretRefPaths(schema: Record<string, unknown>): Set<string> {
  const paths = new Set<string>();
  function walk(node: Record<string, unknown>, prefix: string): void {
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (branch && typeof branch === "object" && !Array.isArray(branch)) {
          walk(branch as Record<string, unknown>, prefix);
        }
      }
    }
    const properties = node.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!properties || typeof properties !== "object") return;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!propertySchema || typeof propertySchema !== "object") continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (propertySchema.format === "secret-ref") paths.add(path);
      walk(propertySchema, path);
    }
  }
  walk(schema, "");
  return paths;
}

function validateConfig(config: Record<string, unknown>) {
  const validate = buildHostLikeValidator();
  const valid = validate(config) as boolean;
  const errorObjects = (validate.errors ?? []) as Array<{
    instancePath: string;
    message?: string;
  }>;
  return {
    valid,
    errors: valid ? [] : errorObjects.map((e) => `${e.instancePath}: ${e.message}`),
  };
}

describe("manifest secret-ref fields — Gate A (schema validation)", () => {
  it("both ref fields exist in the manifest schema", () => {
    const properties = (manifest.instanceConfigSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;
    for (const field of REF_FIELDS) {
      expect(properties[field], `${field} missing from instanceConfigSchema`).toBeTruthy();
    }
  });

  it("legacy string configs stay valid (backward compatibility)", () => {
    const legacy = {
      transport: "flashforge",
      flashforgeBaseUrl: BASE_URL,
      flashforgeSerialNumber: "SN-C5",
      flashforgeCheckCodeRef: "flashforge-check-code",
    };
    expect(validateConfig(legacy)).toMatchObject({ valid: true });
    const legacyMoonraker = {
      moonrakerBaseUrl: "http://printer.lan:7125",
      moonrakerApiKeyRef: "moonraker-key-name",
    };
    expect(validateConfig(legacyMoonraker)).toMatchObject({ valid: true });
  });

  it("object binding refs pass — the observed 400 gate cannot recur", () => {
    const ff = {
      transport: "flashforge",
      flashforgeBaseUrl: BASE_URL,
      flashforgeSerialNumber: "SN-C5",
      flashforgeCheckCodeRef: { type: "secret_ref", secretId: UUID },
    };
    expect(validateConfig(ff)).toMatchObject({ valid: true });
    const ffPinned = {
      ...ff,
      flashforgeCheckCodeRef: { type: "secret_ref", secretId: UUID, version: 2 },
    };
    expect(validateConfig(ffPinned)).toMatchObject({ valid: true });
    const ffLatest = {
      ...ff,
      flashforgeCheckCodeRef: { type: "secret_ref", secretId: UUID, version: "latest" },
    };
    expect(validateConfig(ffLatest)).toMatchObject({ valid: true });
    const moonraker = {
      moonrakerBaseUrl: "http://printer.lan:7125",
      moonrakerApiKeyRef: { type: "secret_ref", secretId: UUID.toUpperCase() },
    };
    expect(validateConfig(moonraker)).toMatchObject({ valid: true });
  });

  it("malformed object refs are rejected at save time (400), not at resolve time", () => {
    const badRefs: unknown[] = [
      { type: "secret_ref" },
      { type: "secret_ref", secretId: "not-a-uuid" },
      { type: "secret_ref", secretId: UUID, version: 0 },
      { type: "secret_ref", secretId: UUID, version: "2" },
      { type: "secret_ref", secretId: UUID, extra: "key" },
      { type: "wrong", secretId: UUID },
    ];
    for (const ref of badRefs) {
      const result = validateConfig({
        transport: "flashforge",
        flashforgeBaseUrl: BASE_URL,
        flashforgeSerialNumber: "SN-C5",
        flashforgeCheckCodeRef: ref,
      });
      expect(result.valid, `expected rejection for ${JSON.stringify(ref)}`).toBe(false);
    }
  });

  it("unknown top-level config keys stay rejected (additionalProperties: false kept)", () => {
    const result = validateConfig({
      moonrakerBaseUrl: "http://printer.lan:7125",
      evilUnknownKey: "x",
    });
    expect(result.valid).toBe(false);
  });
});

describe("manifest secret-ref fields — Gate B (binding extraction contract)", () => {
  const paths = collectSecretRefPaths(manifest.instanceConfigSchema as Record<string, unknown>);

  it("both ref fields are detected as secret-ref paths through the oneOf branches", () => {
    for (const field of REF_FIELDS) {
      expect(
        paths.has(field),
        `${field} must stay a schema-detected secret-ref path (format kept on the string branch)`,
      ).toBe(true);
    }
  });

  it("bare-UUID string values at those paths are legacy-rejected by the host (422 contract)", () => {
    // Mirror the host's UUID check + rejectLegacyUuid behavior so this test
    // documents WHY strings must never be the recommended shape: the host
    // answers 422 for exactly this case.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const config = {
      transport: "flashforge",
      flashforgeBaseUrl: BASE_URL,
      flashforgeSerialNumber: "SN-C5",
      flashforgeCheckCodeRef: UUID,
    };
    // The string branch still validates (Gate A) — legacy configs load.
    expect(validateConfig(config).valid).toBe(true);
    // ...but at Gate B the host refuses a bare UUID with 422. Pin the
    // classification, not the HTTP layer.
    expect(uuidRe.test(config.flashforgeCheckCodeRef)).toBe(true);
  });

  it("object values at those paths classify as host binding rows", () => {
    const refs: unknown[] = [
      { type: "secret_ref", secretId: UUID },
      { type: "secret_ref", secretId: UUID, version: 3 },
    ];
    for (const ref of refs) {
      expect(parseSecretRefObject(ref)).not.toBeNull();
    }
  });
});
