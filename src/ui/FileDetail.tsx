/**
 * Detail view — section 3 of the Klipper page UI (PLA-480 / §6.4).
 *
 * Local state on the parent Page; Back returns to the queue. Renders the
 * selected file's metadata plus Start Print / Delete controls. Action keys
 * `start_print` and `delete_file` may not yet exist on the worker — the
 * follow-up to add them to `ctx.actions` is filed against PLA-475. Until
 * those land, the action handlers surface a bridge error inline (the
 * right failure mode for now per UX spec).
 */
import { useState } from "react";
import { usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { KeyValueList, Spinner, StatusBadge } from "./components.js";
import type { FileListEntry, FileMetadata } from "../worker/MoonrakerClient.js";
import { Thumbnail } from "./FileList.js";
import { fontSize, sp, stack, TAP_TARGET_MIN } from "./theme.js";
import { firstInlineThumbnailDataUrl, formatBytes, formatDuration, formatRelativeTime, truncateFilename } from "./format.js";

export interface FileDetailProps {
  file: FileListEntry;
  onBack: () => void;
  /** Refresh callback the parent hands in so we can refresh the file list after a delete. */
  onFilesChanged?: () => void;
}

export function FileDetail({ file, onBack, onFilesChanged }: FileDetailProps) {
  const displayName = file.path.split("/").pop() ?? file.path;
  const titleDisplay = truncateFilename(displayName, 32);
  const { data: meta, loading, error } = usePluginData<FileMetadata>("file_metadata", {
    filename: file.path,
  });
  const startPrint = usePluginAction("start_print");
  const deleteFile = usePluginAction("delete_file");
  const toast = usePluginToast();
  const [busy, setBusy] = useState<"start" | "delete" | null>(null);

  async function handleStart() {
    if (busy) return;
    setBusy("start");
    try {
      await startPrint({ filename: file.path });
      toast({ title: `Print started`, body: displayName, tone: "success" });
      onBack();
      onFilesChanged?.();
    } catch (err) {
      toast({
        title: "Could not start print",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (busy) return;
    // The UX spec is explicit: the confirm dialog *is* the recovery path
    // because Moonraker has no undo. Native confirm() is acceptable for v1
    // — the shared `ActionBar.confirm` flow uses the host's dialog primitive
    // but we wire actions ourselves here so we can refresh the parent
    // file list on success without an extra round-trip.
    const ok = typeof window !== "undefined" && typeof window.confirm === "function"
      ? window.confirm(`Delete ${displayName} from the printer? This cannot be undone.`)
      : true;
    if (!ok) return;
    setBusy("delete");
    try {
      await deleteFile({ path: file.path, root: "gcodes" });
      toast({ title: "Deleted", body: displayName, tone: "success" });
      onBack();
      onFilesChanged?.();
    } catch (err) {
      toast({
        title: "Could not delete file",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  const pairs = buildPairs(file, meta);

  return (
    <section
      aria-label={`Details for ${displayName}`}
      data-testid="klipper-detail"
      style={stack(3)}
    >
      <div
        style={{
          position: "sticky",
          top: 0,
          padding: `${sp(2)} ${sp(3)}`,
          background: "var(--surface-bg, transparent)",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to file list"
          data-testid="klipper-detail-back"
          style={{
            minHeight: TAP_TARGET_MIN,
            minWidth: TAP_TARGET_MIN,
            padding: `${sp(2)} ${sp(3)}`,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: fontSize.base,
          }}
        >
          ‹ Back
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: sp(3), padding: `0 ${sp(3)}` }}>
        <Thumbnail
          loading={loading && !meta}
          src={meta ? firstInlineThumbnailDataUrl(meta.thumbnails) : null}
          alt={displayName}
          sizePx={240}
        />
        <h2
          style={{ margin: 0, fontSize: fontSize.lg, wordBreak: "break-all" }}
          title={file.path}
          data-testid="klipper-detail-title"
        >
          {titleDisplay}
        </h2>
      </div>

      {error ? (
        <div style={{ padding: `0 ${sp(3)}` }}>
          <StatusBadge
            label={`Could not load metadata: ${error.message}`}
            status="error"
          />
        </div>
      ) : null}

      <div style={{ padding: `0 ${sp(3)}` }} data-testid="klipper-detail-metadata">
        {loading && !meta ? (
          <span style={{ display: "inline-flex", gap: sp(2), alignItems: "center" }}>
            <Spinner size="sm" label="Loading metadata" />
            <span>Loading metadata…</span>
          </span>
        ) : (
          <KeyValueList pairs={pairs} />
        )}
      </div>

      <div
        role="group"
        aria-label="File actions"
        style={{
          display: "flex",
          flexDirection: "row",
          gap: sp(2),
          padding: sp(3),
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={handleStart}
          disabled={busy !== null}
          aria-busy={busy === "start" || undefined}
          data-testid="klipper-detail-start"
          style={{
            flex: 1,
            minHeight: TAP_TARGET_MIN,
            padding: `${sp(2)} ${sp(3)}`,
            fontWeight: 600,
          }}
        >
          {busy === "start" ? "Starting…" : "Start print"}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy !== null}
          aria-busy={busy === "delete" || undefined}
          data-testid="klipper-detail-delete"
          style={{
            flex: 1,
            minHeight: TAP_TARGET_MIN,
            padding: `${sp(2)} ${sp(3)}`,
          }}
        >
          {busy === "delete" ? "Deleting…" : "Delete"}
        </button>
      </div>
    </section>
  );
}

function buildPairs(file: FileListEntry, meta: FileMetadata | null) {
  const pairs: { label: string; value: string }[] = [];
  pairs.push({ label: "Size", value: formatBytes(meta?.size ?? file.size) });
  pairs.push({
    label: "Last modified",
    value: formatRelativeTime(meta?.modified ?? file.modified),
  });
  if (meta?.estimated_time != null) {
    pairs.push({ label: "Est. print time", value: formatDuration(meta.estimated_time) });
  }
  if (meta?.filament_total != null) {
    const meters = meta.filament_total / 1000;
    pairs.push({ label: "Filament", value: `${meters.toFixed(1)} m` });
  }
  return pairs;
}
