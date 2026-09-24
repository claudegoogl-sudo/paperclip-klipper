/**
 * Secret-reference shapes for plugin config fields.
 *
 * Host generations in wide deployment moved from legacy string secret refs
 * (a bare secret UUID or name in a `format: "secret-ref"` string field) to
 * object-shaped binding refs, upstream v2026.824.1:
 *
 *   { type: "secret_ref", secretId: <uuid>, version?: "latest" | <positive int> }
 *
 * The canonical shape is pinned by the shared validator
 * (`envBindingSecretRefSchema`) and the route-level parser
 * (`parseSecretRefBindingObject`) on the server:
 *   - `type` MUST be the literal "secret_ref";
 *   - `secretId` MUST be a UUID (trimmed);
 *   - `version` is optional; absent/null collapses to "latest".
 *
 * Company-scoped resolution on current hosts REJECTS string refs outright
 * (the resolve handler throws `InvalidSecretRefError` for anything that is
 * not the object shape), while older hosts resolved plain strings. Both
 * shapes therefore have to keep flowing through this plugin end-to-end:
 * the manifest schema accepts both (legacy configs stay valid), and the
 * worker passes whichever shape it was given straight to
 * `ctx.secrets.resolve` — the host decides what it can resolve, and an
 * unresolvable ref still refuses the transport at the same call sites as
 * before (fail closed, no silent fallback).
 */
import type { PluginSecretsClient } from "@paperclipai/plugin-sdk";

/** Mirrors the host's UUID check (case-insensitive, canonical hyphenated). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Object-shaped secret binding ref accepted by current host generations. */
export interface SecretRefObject {
  type: "secret_ref";
  /** UUID of the referenced secret (trimmed). */
  secretId: string;
  /** Absent/null behave exactly like "latest". */
  version?: "latest" | number;
}

/** Fully-normalized object ref (parse output shape). */
export interface NormalizedSecretRefObject {
  type: "secret_ref";
  secretId: string;
  version: "latest" | number;
}

/** Either ref shape found in plugin config. */
export type SecretRef = string | SecretRefObject;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse + normalize an object-shaped ref. Returns null for anything that is
 * not exactly the host binding shape (wrong type literal, non-UUID secretId,
 * version that is neither "latest" nor a positive integer). Mirrors the
 * server's `parseSecretRefBindingObject` so the plugin and the host agree on
 * what is well-formed before a config is ever saved.
 */
export function parseSecretRefObject(value: unknown): NormalizedSecretRefObject | null {
  if (!isPlainRecord(value)) return null;
  if (value.type !== "secret_ref") return null;
  if (typeof value.secretId !== "string") return null;
  const secretId = value.secretId.trim();
  if (!UUID_RE.test(secretId)) return null;
  const version = value.version;
  if (version === undefined || version === null || version === "latest") {
    // Absent collapses to "latest" — the host's parser returns the explicit
    // selector, so the plugin normalizes to the same canonical form.
    return { type: "secret_ref", secretId, version: "latest" };
  }
  if (typeof version === "number" && Number.isInteger(version) && version > 0) {
    return { type: "secret_ref", secretId, version };
  }
  return null;
}

/**
 * True when `value` is a usable ref of either shape: a non-empty string
 * (legacy) or a well-formed object ref. Malformed objects are NOT usable —
 * they must surface as a missing/invalid field, never silently degrade to
 * string semantics.
 */
export function isConfiguredSecretRef(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return parseSecretRefObject(value) !== null;
}

/**
 * Stable connection-identity for a ref, used by the config fingerprints.
 * Strings canonicalize under a `string:` prefix; objects canonicalize to
 * `secret_ref:<secretId>:<version|latest>` so two saves that only differ in
 * object key order (or whitespace) are the SAME connection, while a real
 * change (different secret or pinned version) is a different one. The
 * disjoint prefixes mean a legacy string can never collide with an object
 * identity — without the prefix, a string that literally read
 * "secret_ref:<uuid>:<ver>" would alias that object's canonical identity.
 * Malformed objects — which the host would refuse at resolve time — still
 * get a stable, value-derived identity under `secret_ref:malformed:` so a
 * replay burst cannot churn clients.
 *
 * The `string:` prefix is an identity CHANGE for pre-existing string
 * configs: the first fingerprint computed after this upgrade differs from
 * the pre-upgrade one, so each legacy-string config sees exactly one
 * client rebuild (reconnect + re-detect) at upgrade time and then
 * stabilizes. Config values and resolve behavior are untouched.
 */
export function canonicalSecretRefIdentity(ref: SecretRef): string {
  if (typeof ref === "string") return `string:${ref}`;
  const parsed = parseSecretRefObject(ref);
  if (parsed) {
    return `secret_ref:${parsed.secretId}:${parsed.version ?? "latest"}`;
  }
  return `secret_ref:malformed:${stableStringify(ref)}`;
}

/** Key-sorted JSON so malformed-object identity does not depend on order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Normalize a parsed object ref to its canonical field set (drops extras). */
export function normalizedSecretRef(ref: SecretRef): SecretRef {
  return typeof ref === "string" ? ref : parseSecretRefObject(ref) ?? ref;
}

/**
 * Resolve either ref shape through the plugin secrets client.
 *
 * The vendored plugin SDK (fork-pinned tarball) still types
 * `PluginSecretsClient.resolve(secretRef: string)` because it predates the
 * object-binding protocol; current hosts accept the object on the wire (the
 * RPC params are JSON-serialized) and REJECT string refs in company-scoped
 * resolution. The cast is contained HERE — and only here — so both client
 * transports can pass their ref through untouched. Drop this helper the day
 * the vendored SDK tarball is refreshed to a generation whose protocol type
 * is `string | binding object`.
 */
export async function resolveSecretRef(
  secrets: PluginSecretsClient,
  ref: SecretRef,
  runId?: string,
): Promise<string> {
  // fork51-generation SDK types `resolve(secretRef, runId)`. This worker's
  // config-apply path has no dispatch runId (the host replay is not a tool
  // dispatch), and fork51 hosts deny runId-less resolutions — the credential
  // timing fix that moves resolution into a dispatch scope is tracked
  // separately and will pass the dispatching runId here. The cast keeps the
  // call site compiling against both SDK generations without changing
  // behavior.
  return (secrets.resolve as unknown as (secretRef: string, runId?: string) => Promise<string>)(
    ref as string,
    runId,
  );
}
