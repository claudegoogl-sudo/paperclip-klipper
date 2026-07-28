/**
 * Strict validation for the operator-supplied `moonrakerBaseUrl` config
 * value, applied BEFORE it is ever used to construct a `MoonrakerClient`
 * (which is the only thing that ever gets handed the resolved
 * `moonrakerApiKeyRef` credential).
 *
 * Mirrors paperclip-plugin-cad's `parseGitHubUrl` fix: WHATWG `URL` parsing
 * plus strict `protocol`/`host` equality — never a regex or substring check
 * on the raw string. A naive `raw.includes(expectedHost)` (or a
 * `raw.startsWith(...)` prefix check) can be satisfied by an
 * attacker-controlled origin that merely mentions the expected host in its
 * *path*, e.g. `https://attacker.example/moonraker.local/...`. Only
 * `new URL(raw).host` reflects the actual network destination.
 */
export type MoonrakerBaseUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: "unparseable" | "unsupported_scheme" | "host_not_allowed"; host: string | null };

/**
 * Validate `raw` against `allowedHosts`. When `allowedHosts` is empty or
 * omitted, the allowlist defaults to the single host parsed out of `raw`
 * itself — i.e. any well-formed http(s) URL is accepted (matching today's
 * behavior for the single-instance case) while still rejecting bad schemes
 * and malformed values. Operators that want to pin the plugin to a specific
 * host regardless of what config value later lands can set
 * `moonrakerAllowedHosts` explicitly.
 */
export function validateMoonrakerBaseUrl(
  raw: string,
  allowedHosts?: string[],
): MoonrakerBaseUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable", host: null };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme", host: url.host };
  }
  const allowlist = allowedHosts && allowedHosts.length > 0 ? allowedHosts : [url.host];
  if (!allowlist.includes(url.host)) {
    return { ok: false, reason: "host_not_allowed", host: url.host };
  }
  return { ok: true, url };
}
