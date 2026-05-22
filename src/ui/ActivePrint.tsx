/**
 * Active print panel — section 4 of the Klipper page UI (PLA-480 / §6.4).
 *
 * Reads the status snapshot from `usePluginData('status')`. The parent Page
 * elevates this panel above the queue when `print_stats.state ∈ {printing,
 * paused}` so progress/Cancel are above the fold on a 390px viewport.
 *
 * Pause and Resume share a button slot; the label flips on `state ===
 * 'paused'`. PLA-482 introduced a discrete `resume_print` action so the
 * resume path no longer relies on Moonraker's server-side pause toggle.
 */
import { useEffect, useState } from "react";
import {
  usePluginAction,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import { KeyValueList, StatusBadge } from "./components.js";
import type { MoonrakerStatusSnapshot } from "../worker/MoonrakerClient.js";
import { fontSize, muted, sp, stack, TAP_TARGET_MIN, visuallyHidden } from "./theme.js";
import { estimateRemainingSeconds, formatDuration, truncateFilename } from "./format.js";
import { FILE_LIST_ANCHOR_ID } from "./FileList.js";

/**
 * Empty-state CTA: scroll the file list into view and focus the first row's
 * Start button so a keyboard / screen-reader user lands in actionable
 * territory. Honours `prefers-reduced-motion`.
 */
function focusFileList() {
  if (typeof document === "undefined") return;
  const list = document.getElementById(FILE_LIST_ANCHOR_ID);
  if (!list) return;
  const reduced =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  list.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  const firstStart = list.querySelector<HTMLButtonElement>(
    '[data-testid="klipper-file-row-start"]',
  );
  if (firstStart) firstStart.focus();
}

/** Active-printer states for which we promote this panel above the queue. */
export const ACTIVE_PRINT_STATES = new Set(["printing", "paused"]);

export interface ActivePrintProps {
  status: MoonrakerStatusSnapshot | null;
  /** Refresh callback the parent hands in so we can refresh after Cancel/Pause. */
  onRefresh?: () => void;
}

interface PrintStats {
  state?: string;
  filename?: string;
  print_duration?: number;
  total_duration?: number;
  info?: { current_layer?: number; total_layer?: number };
  state_message?: string;
}

interface HeaterReading {
  temperature?: number;
  target?: number;
}

interface VirtualSdCard {
  progress?: number;
}

interface DisplayStatus {
  message?: string;
  progress?: number;
}

export function ActivePrint({ status, onRefresh }: ActivePrintProps) {
  const objects = status?.objects ?? {};
  const printStats = (objects.print_stats as PrintStats | undefined) ?? {};
  const extruder = (objects.extruder as HeaterReading | undefined) ?? {};
  const heaterBed = (objects.heater_bed as HeaterReading | undefined) ?? {};
  const vsd = (objects.virtual_sdcard as VirtualSdCard | undefined) ?? {};
  const display = (objects.display_status as DisplayStatus | undefined) ?? {};

  const state = printStats.state;
  const pause = usePluginAction("pause_print");
  const resume = usePluginAction("resume_print");
  const cancel = usePluginAction("cancel_print");
  const toast = usePluginToast();
  const [busy, setBusy] = useState<"pause" | "cancel" | null>(null);
  const [lastComplete, setLastComplete] = useState<string | null>(null);

  // Celebratory toast on transition to `complete` (Peak-End).
  useEffect(() => {
    if (state === "complete" && printStats.filename && lastComplete !== printStats.filename) {
      setLastComplete(printStats.filename);
      toast({
        title: `${printStats.filename} finished printing`,
        tone: "success",
        ttlMs: 8000,
      });
    }
  }, [state, printStats.filename, lastComplete, toast]);

  if (!status || !state || state === "standby" || state === "complete" || state === "cancelled") {
    return (
      <section
        aria-label="Active print"
        data-testid="klipper-active-empty"
        style={{ ...stack(2), padding: sp(3) }}
      >
        <span style={muted}>No active print.</span>
        <button
          type="button"
          onClick={focusFileList}
          data-testid="klipper-active-empty-cta"
          style={{
            alignSelf: "flex-start",
            minHeight: TAP_TARGET_MIN,
            padding: `${sp(2)} ${sp(3)}`,
          }}
        >
          Start a print ↓
        </button>
      </section>
    );
  }

  if (state === "error") {
    const errorMessage = display.message || printStats.state_message || "Print error";
    async function handleDismiss() {
      setBusy("cancel");
      try {
        await cancel();
        toast({ title: "Cleared print error", tone: "info" });
        onRefresh?.();
      } catch (err) {
        toast({
          title: "Could not clear error",
          body: err instanceof Error ? err.message : String(err),
          tone: "error",
        });
      } finally {
        setBusy(null);
      }
    }
    return (
      <section
        aria-label="Active print error"
        data-testid="klipper-active-error"
        style={{ ...stack(2), padding: sp(3) }}
      >
        <StatusBadge label={`Print error: ${errorMessage}`} status="error" />
        <button
          type="button"
          onClick={handleDismiss}
          disabled={busy === "cancel"}
          data-testid="klipper-active-error-dismiss"
          style={{
            alignSelf: "flex-start",
            minHeight: TAP_TARGET_MIN,
            padding: `${sp(2)} ${sp(3)}`,
          }}
        >
          {busy === "cancel" ? "Clearing…" : "Dismiss"}
        </button>
      </section>
    );
  }

  // Active states: printing / paused.
  const progress = clamp01(vsd.progress);
  const percent = Math.round((progress ?? 0) * 100);
  const elapsed = printStats.print_duration ?? 0;
  const remainingSec = estimateRemainingSeconds(elapsed, progress);
  const filename = printStats.filename ?? "(unknown file)";
  const layerNow = printStats.info?.current_layer;
  const layerTotal = printStats.info?.total_layer;
  const isPaused = state === "paused";

  async function handlePauseResume() {
    if (busy) return;
    setBusy("pause");
    try {
      if (isPaused) {
        await resume();
      } else {
        await pause();
      }
      onRefresh?.();
    } catch (err) {
      toast({
        title: isPaused ? "Could not resume" : "Could not pause",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleCancel() {
    if (busy) return;
    const ok = typeof window !== "undefined" && typeof window.confirm === "function"
      ? window.confirm(
          `Cancel ${filename}? The printer will stop and you will need to ` +
            "remove the partial print.",
        )
      : true;
    if (!ok) return;
    setBusy("cancel");
    try {
      await cancel();
      toast({ title: "Print cancelled", tone: "info" });
      onRefresh?.();
    } catch (err) {
      toast({
        title: "Could not cancel print",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-label="Active print"
      data-testid="klipper-active"
      style={{
        ...stack(3),
        padding: sp(3),
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: "6px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: sp(2), flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: fontSize.md }}>Active print</h3>
        <StatusBadge
          label={isPaused ? "Paused" : "Printing"}
          status={isPaused ? "warning" : "info"}
        />
      </div>

      <div style={stack(1)}>
        <span
          style={{ fontWeight: 600, fontSize: fontSize.base, wordBreak: "break-all" }}
          data-testid="klipper-active-filename"
          title={filename}
        >
          {truncateFilename(filename, 40)}
        </span>
        {display.message ? (
          <span style={muted} data-testid="klipper-active-display-message">
            {display.message}
          </span>
        ) : null}
      </div>

      <div style={stack(1)}>
        <progress
          value={progress ?? 0}
          max={1}
          aria-label="Print progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-testid="klipper-active-progress"
          style={{ width: "100%", height: "8px" }}
        />
        <span style={{ fontSize: fontSize.sm }}>
          <strong data-testid="klipper-active-percent">{percent}%</strong>
          <span style={visuallyHidden}> complete</span>
        </span>
        <span style={muted} data-testid="klipper-active-layers-eta">
          {layerNow != null && layerTotal != null
            ? `Layer ${layerNow} of ${layerTotal} · `
            : "Layer — · "}
          Elapsed {formatDuration(elapsed)} · ETA {formatDuration(remainingSec)}
        </span>
      </div>

      <KeyValueList
        pairs={[
          {
            label: "Hotend",
            value: formatTempPair(extruder.temperature, extruder.target),
          },
          {
            label: "Bed",
            value: formatTempPair(heaterBed.temperature, heaterBed.target),
          },
        ]}
      />

      <div
        role="group"
        aria-label="Print controls"
        style={{
          display: "flex",
          flexDirection: "row",
          gap: sp(2),
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={handlePauseResume}
          disabled={busy !== null}
          aria-busy={busy === "pause" || undefined}
          data-testid="klipper-active-pause"
          style={{ flex: 1, minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}` }}
        >
          {busy === "pause"
            ? isPaused
              ? "Resuming…"
              : "Pausing…"
            : isPaused
              ? "Resume"
              : "Pause"}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy !== null}
          aria-busy={busy === "cancel" || undefined}
          data-testid="klipper-active-cancel"
          style={{ flex: 1, minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}` }}
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    </section>
  );
}

function clamp01(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function formatTempPair(current: number | undefined, target: number | undefined): string {
  const cur = current != null && Number.isFinite(current) ? `${Math.round(current)} °C` : "—";
  const tgt = target != null && Number.isFinite(target) && target > 0 ? `${Math.round(target)} °C` : "—";
  return `${cur} / ${tgt}`;
}
