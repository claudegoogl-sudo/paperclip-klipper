/**
 * Last-completed-job summary — section 5 of the Klipper page UI
 * (see §6.4 rev-4).
 *
 * Collapsible footer that surfaces `print_stats` when state is `complete`,
 * `cancelled`, or `error`. Hidden during `standby` / `printing` / `paused`
 * (the active panel is the source of truth for in-flight jobs).
 *
 * Helpful-not-loud: no auto-toast on completion — `ActivePrint.tsx`
 * already fires the Peak-End toast at the transition; this footer is the
 * close-the-loop affordance after the toast fades.
 */
import { useState } from "react";
import { StatusBadge } from "./components.js";
import type { MoonrakerStatusSnapshot } from "../worker/MoonrakerClient.js";
import { fontSize, muted, sp, stack, TAP_TARGET_MIN } from "./theme.js";
import { formatDuration } from "./format.js";

export interface LastCompletedJobProps {
  status: MoonrakerStatusSnapshot | null;
}

interface PrintStatsShape {
  state?: string;
  filename?: string;
  total_duration?: number;
  state_message?: string;
}

const COMPLETED_STATES = new Set(["complete", "cancelled", "error"]);

interface PillSpec {
  status: "ok" | "warning" | "error";
  label: string;
}

function pillFor(state: string | undefined): PillSpec | null {
  if (state === "complete") return { status: "ok", label: "Finished" };
  if (state === "cancelled") return { status: "warning", label: "Cancelled" };
  if (state === "error") return { status: "error", label: "Failed" };
  return null;
}

export function LastCompletedJob({ status }: LastCompletedJobProps) {
  const [expanded, setExpanded] = useState(false);
  const stats = (status?.objects?.print_stats as PrintStatsShape | undefined) ?? {};
  const state = stats.state;
  if (!state || !COMPLETED_STATES.has(state)) return null;

  const pill = pillFor(state);
  if (!pill) return null;
  const filename = stats.filename ?? "(unknown file)";
  const totalDuration = stats.total_duration;
  const stateMessage = stats.state_message;

  const summary =
    state === "complete"
      ? "finished"
      : state === "cancelled"
        ? "cancelled"
        : "failed";

  return (
    <section
      role="region"
      aria-label="Last completed job"
      data-testid="klipper-last-completed"
      style={{
        ...stack(1),
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: "6px",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls="klipper-last-completed-body"
        data-testid="klipper-last-completed-toggle"
        style={{
          minHeight: TAP_TARGET_MIN,
          padding: `${sp(2)} ${sp(3)}`,
          display: "flex",
          alignItems: "center",
          gap: sp(2),
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          width: "100%",
        }}
      >
        <span aria-hidden="true" style={{ width: "1em", display: "inline-block" }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ fontWeight: 600, fontSize: fontSize.base }}>Last job</span>
        <span
          style={{
            ...muted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {filename} · {summary}
        </span>
      </button>

      {expanded ? (
        <div
          id="klipper-last-completed-body"
          data-testid="klipper-last-completed-body"
          style={{ ...stack(2), padding: `${sp(2)} ${sp(3)} ${sp(3)}` }}
        >
          <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{filename}</span>
          <StatusBadge label={pill.label} status={pill.status} />
          {totalDuration != null && Number.isFinite(totalDuration) ? (
            <span style={muted}>
              {state === "complete" ? "Finished" : state === "cancelled" ? "Cancelled" : "Failed"}{" "}
              after {formatDuration(totalDuration)}
            </span>
          ) : null}
          {state === "error" && stateMessage ? (
            <StatusBadge label={`Last error: ${stateMessage}`} status="error" />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
