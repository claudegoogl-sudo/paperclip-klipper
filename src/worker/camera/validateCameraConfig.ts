/**
 * Camera egress scope (security condition C3 from the phase-2 security
 * review of the Creator 5 camera section).
 *
 * The plugin worker's `http.outbound` capability has NO network-level
 * enforcement — outbound scoping is application code end to end. The
 * camera client therefore validates its upstream like the transports do
 * (WHATWG URL parse, http(s)-only, userinfo rejected, host allowlist) and
 * adds a strict PATH+QUERY allowlist on top: the only reachable camera URL
 * is `/?action=stream`. Allowlist default is the single FlashForge printer
 * host (the one machine this plugin already talks to), so a config or
 * injection-driven caller can never turn the camera fetch into an SSRF
 * pivot to other LAN services, and a viewer can never influence the
 * upstream target — the upstream URL derives from operator config alone,
 * never from request input.
 */
import type { KlipperConfig } from "../registerRpcSurface.js";

/** The one camera URL this plugin may ever fetch. */
export const CAMERA_STREAM_PATH_AND_QUERY = "/?action=stream";

export type CameraConfigValidation =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: string; host: string | null };

function hasUserinfo(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

/**
 * Validate the operator-configured camera base URL. `defaultHost` is the
 * host of the configured FlashForge transport URL: when the operator has
 * not set an explicit allowlist, the camera may only talk to the printer
 * it already talks to.
 */
export function validateCameraBaseUrl(
  raw: unknown,
  allowedHosts: unknown,
  defaultHost: string | null,
): CameraConfigValidation {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "missing_fields", host: null };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "unparseable", host: null };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme", host: url.host };
  }
  if (hasUserinfo(url)) {
    return { ok: false, reason: "userinfo_rejected", host: url.host };
  }
  const explicit =
    Array.isArray(allowedHosts) && allowedHosts.length > 0
      ? allowedHosts.filter((h): h is string => typeof h === "string" && h.length > 0)
      : [];
  // Default allowlist: the configured FlashForge host when there is one,
  // otherwise the camera URL's own host (mirrors the transport validators,
  // whose default is always the URL's own host).
  const allowlist = explicit.length > 0 ? explicit : [defaultHost ?? url.host];
  if (!allowlist.some((h) => h.toLowerCase() === url.host.toLowerCase())) {
    return { ok: false, reason: "host_not_allowed", host: url.host };
  }
  return { ok: true, url: url.toString(), host: url.host };
}

/** Allowlist shape extracted from config (mirrors the transport validators). */
export function cameraAllowedHostsFromConfig(
  config: Pick<KlipperConfig, "flashforgeCameraAllowedHosts">,
): string[] | undefined {
  const hosts = config.flashforgeCameraAllowedHosts;
  return Array.isArray(hosts) && hosts.length > 0 ? (hosts as string[]) : undefined;
}

/**
 * Enforce the path+query allowlist and produce the exact upstream URL for a
 * fetch. Used immediately before every camera connect (defense-in-depth:
 * the feed re-checks even though config was validated at apply time).
 */
export function scopedCameraUrl(cameraBaseUrl: string): URL {
  const url = new URL(cameraBaseUrl);
  if (hasUserinfo(url)) {
    throw new Error("camera scope violation: userinfo URLs are not allowed");
  }
  if (url.pathname !== "/") {
    throw new Error(`camera scope violation: path ${url.pathname} is not allowed`);
  }
  const params = [...new URLSearchParams(url.search).entries()];
  if (params.length !== 1 || params[0]![0] !== "action" || params[0]![1] !== "stream") {
    throw new Error("camera scope violation: only /?action=stream may be fetched");
  }
  return url;
}
