/**
 * Pure-formatting helpers for the Klipper page UI (PLA-480 / §6.4).
 *
 * Kept side-effect-free and free of React/DOM imports so they can be unit
 * tested under the default `node` vitest environment without dragging in
 * jsdom. Every helper is `Intl`-based — no `moment`-style deps.
 */

/** Format a byte count as KB / MB / GB with one decimal. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit: string = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  // 1 decimal for KB/MB/GB so "1.2 MB" matches the spec.
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

/**
 * Format `modifiedEpochSec` (unix seconds, what Moonraker returns) as a
 * relative string ("just now", "5 min ago", "2 days ago") for up to 7 days,
 * then as an absolute date.
 */
export function formatRelativeTime(
  modifiedEpochSec: number | null | undefined,
  now: Date = new Date(),
): string {
  if (modifiedEpochSec == null || !Number.isFinite(modifiedEpochSec)) return "—";
  const past = new Date(modifiedEpochSec * 1000);
  const deltaSec = Math.round((now.getTime() - past.getTime()) / 1000);
  if (!Number.isFinite(deltaSec)) return "—";
  if (deltaSec < 30) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (deltaSec < 3600) return rtf.format(-Math.round(deltaSec / 60), "minute");
  if (deltaSec < 86400) return rtf.format(-Math.round(deltaSec / 3600), "hour");
  if (deltaSec < 86400 * 7) return rtf.format(-Math.round(deltaSec / 86400), "day");
  return past.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Format an elapsed/remaining duration as `H?Mm` (e.g. `1h 23m`, `45m`).
 * Returns `—` for non-finite or negative inputs.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h <= 0 && m <= 0) return "<1m";
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Compute remaining seconds for a print given elapsed time and a 0..1
 * progress. Returns `null` (caller renders `—`) when progress is too low
 * to make a meaningful estimate, mirroring the UX spec's `progress > 0.02`
 * guardrail. Refuses to return `NaN`.
 */
export function estimateRemainingSeconds(
  elapsedSec: number | null | undefined,
  progress: number | null | undefined,
): number | null {
  if (elapsedSec == null || !Number.isFinite(elapsedSec) || elapsedSec < 0) {
    return null;
  }
  if (progress == null || !Number.isFinite(progress) || progress <= 0.02) {
    return null;
  }
  if (progress >= 1) return 0;
  return Math.max(0, elapsedSec * (1 / progress - 1));
}

/**
 * Truncate a filename so the `.gcode` suffix is preserved when the head
 * is overlong. Used in the detail view title region per spec.
 */
export function truncateFilename(filename: string, maxLen = 32): string {
  if (filename.length <= maxLen) return filename;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || filename.length - dot > 8) {
    return `${filename.slice(0, maxLen - 1)}…`;
  }
  const ext = filename.slice(dot);
  const head = filename.slice(0, Math.max(1, maxLen - ext.length - 1));
  return `${head}…${ext}`;
}

/**
 * Trim a long error string to a maximum length with an ellipsis. Used for
 * the connection-banner error display so that a noisy Moonraker response
 * cannot blow out the banner height (UX spec §1).
 */
export function trimErrorMessage(msg: string | null | undefined, maxLen = 120): string {
  if (!msg) return "";
  const clean = msg.trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

/**
 * Resolve `FileMetadata.thumbnails[0]` to a data: URL when inline base64 is
 * present. Returns `null` when no inline thumbnail is available — the UI
 * is expected to render a glyph fallback in that case (UX spec §2).
 *
 * The host never resolves `relative_path` for us — that's a §6.5 follow-up.
 */
export function firstInlineThumbnailDataUrl(
  thumbnails: Array<{ width: number; height: number; size: number; relative_path?: string; data?: string }> | undefined,
): string | null {
  if (!thumbnails || thumbnails.length === 0) return null;
  // Prefer the largest inline thumb for the detail view; the list view
  // displays it at 48×48 so any inline thumb looks acceptable.
  const inline = [...thumbnails]
    .filter((t) => typeof t.data === "string" && t.data.length > 0)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  if (inline.length === 0) return null;
  return `data:image/png;base64,${inline[0]!.data}`;
}
