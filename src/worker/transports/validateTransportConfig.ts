/**
 * Transport selection + fail-closed FlashForge config validation.
 *
 * Rules (binding for the transport config surface):
 *   - An ABSENT `transport` resolves to moonraker — the pre-transport
 *     behavior, byte-for-byte. Only the literal strings "moonraker" and
 *     "flashforge" are accepted; any other value is rejected with a clear
 *     error (never silently coerced, never a silent moonraker fallthrough).
 *   - `transport=flashforge` REQUIRES flashforgeBaseUrl,
 *     flashforgeSerialNumber and flashforgeCheckCodeRef. Missing fields are
 *     reported together (clear validation error at load, not a crash, not a
 *     moonraker fallthrough).
 *   - URL validation mirrors validateMoonrakerBaseUrl: WHATWG parse, strict
 *     protocol + host equality, host allowlist (default: the URL's own
 *     host). The FlashForge default LAN port 8898 is applied when the URL
 *     omits one.
 */

/** Default FlashForge LAN-mode HTTP port when the base URL omits one. */
const FLASHFORGE_DEFAULT_PORT = 8898;

export type PrinterTransportKind = "moonraker" | "flashforge";

export type TransportSelection =
  | { ok: true; kind: PrinterTransportKind }
  | { ok: false; reason: string; value: string };

/**
 * Resolve the `transport` config value. `undefined`/`null` → moonraker
 * (unchanged legacy behavior). Unknown values are rejected, not guessed.
 */
export function selectTransport(
  raw: unknown,
): TransportSelection {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, kind: "moonraker" };
  }
  if (raw === "moonraker" || raw === "flashforge") {
    return { ok: true, kind: raw };
  }
  return {
    ok: false,
    reason:
      `unsupported transport value: ${JSON.stringify(String(raw))} ` +
      `(expected "moonraker" or "flashforge")`,
    value: String(raw),
  };
}

export interface FlashForgeConnectionConfig {
  /** Canonical base URL string (default port applied when omitted). */
  baseUrl: string;
  allowedHosts?: string[];
  serialNumber: string;
  checkCodeRef: string;
}

export type FlashForgeConfigValidation =
  | { ok: true; config: FlashForgeConnectionConfig }
  | {
      ok: false;
      reason:
        | "missing_fields"
        | "unparseable"
        | "unsupported_scheme"
        | "host_not_allowed";
      fields: string[];
      host: string | null;
    };

/**
 * Validate the flashforge.* config keys. Returns every missing field at
 * once so an operator fixes the whole config in one pass.
 */
export function validateFlashForgeConfig(config: {
  flashforgeBaseUrl?: unknown;
  flashforgeAllowedHosts?: unknown;
  flashforgeSerialNumber?: unknown;
  flashforgeCheckCodeRef?: unknown;
}): FlashForgeConfigValidation {
  const missing: string[] = [];
  const baseUrlRaw =
    typeof config.flashforgeBaseUrl === "string" ? config.flashforgeBaseUrl.trim() : "";
  const serialNumber =
    typeof config.flashforgeSerialNumber === "string"
      ? config.flashforgeSerialNumber.trim()
      : "";
  const checkCodeRef =
    typeof config.flashforgeCheckCodeRef === "string"
      ? config.flashforgeCheckCodeRef.trim()
      : "";
  if (!baseUrlRaw) missing.push("flashforgeBaseUrl");
  if (!serialNumber) missing.push("flashforgeSerialNumber");
  if (!checkCodeRef) missing.push("flashforgeCheckCodeRef");
  if (missing.length > 0) {
    return { ok: false, reason: "missing_fields", fields: missing, host: null };
  }

  let url: URL;
  try {
    url = new URL(baseUrlRaw);
  } catch {
    return { ok: false, reason: "unparseable", fields: ["flashforgeBaseUrl"], host: null };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: "unsupported_scheme",
      fields: ["flashforgeBaseUrl"],
      host: url.host,
    };
  }
  // FlashForge LAN mode serves HTTP on 8898; apply it as the default port so
  // a bare `http://<ip>` behaves like the reference client.
  if (url.port === "") {
    url.port = String(FLASHFORGE_DEFAULT_PORT);
  }
  const allowedHosts = Array.isArray(config.flashforgeAllowedHosts)
    ? config.flashforgeAllowedHosts.filter((h): h is string => typeof h === "string" && h.length > 0)
    : undefined;
  const allowlist =
    allowedHosts && allowedHosts.length > 0 ? allowedHosts : [url.host];
  if (!allowlist.includes(url.host)) {
    return {
      ok: false,
      reason: "host_not_allowed",
      fields: ["flashforgeBaseUrl", "flashforgeAllowedHosts"],
      host: url.host,
    };
  }

  return {
    ok: true,
    config: {
      baseUrl: url.toString(),
      ...(allowedHosts ? { allowedHosts } : {}),
      serialNumber,
      checkCodeRef,
    },
  };
}

/** Human-readable one-liner for a failed validation (log/UI surfaces). */
export function describeFlashForgeConfigFailure(
  result: Extract<FlashForgeConfigValidation, { ok: false }>,
): string {
  switch (result.reason) {
    case "missing_fields":
      return (
        `flashforge transport config is incomplete — missing required field(s): ` +
        `${result.fields.join(", ")}. transport=flashforge requires flashforgeBaseUrl, ` +
        `flashforgeSerialNumber and flashforgeCheckCodeRef. The worker stays ` +
        `unconfigured (fail closed); it will NOT fall back to moonraker.`
      );
    case "unparseable":
      return (
        `flashforgeBaseUrl is not a parseable URL — refusing to start the ` +
        `FlashForge transport (fail closed).`
      );
    case "unsupported_scheme":
      return (
        `flashforgeBaseUrl must be http(s) — refusing to start the FlashForge ` +
        `transport (fail closed).`
      );
    case "host_not_allowed":
      return (
        `flashforgeBaseUrl host ${result.host ?? "(unknown)"} is not in the ` +
        `configured allowlist — refusing to start the FlashForge transport (fail closed).`
      );
  }
}
