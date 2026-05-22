/**
 * Recent uploads / queue — section 3 of the Klipper page UI (PLA-480 / §6.4).
 *
 * Mobile-first single-column list (not a `<table>`); each row is a `<li>`
 * with metadata + a trailing inline Start button (≥44px tap target). Per
 * rev-4 UX delta, thumbnails are deferred to v1.1 — rows are textual +
 * the `PrinterGlyph` SVG only. `FileDetail` was dropped; Start is inline.
 *
 * Sort: newest first (`modified` desc). No sort UI in v1 (Hick's Law).
 */
import { useMemo, useState } from "react";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { Spinner, StatusBadge } from "./components.js";
import type { FileListEntry } from "../worker/MoonrakerClient.js";
import { fontSize, muted, sp, TAP_TARGET_MIN } from "./theme.js";
import { formatBytes, formatRelativeTime } from "./format.js";

/** Anchor id used by the ActivePrint empty-state "Start a print" CTA. */
export const FILE_LIST_ANCHOR_ID = "klipper-file-list";

export interface FileListProps {
  /** The file list as returned by `usePluginData('files')`. */
  files: FileListEntry[] | null;
  loading: boolean;
  error: { message: string } | null;
  /** Refresh callback for the inline error-state retry button. */
  onRetry?: () => void;
  /** Refresh the file list after a Start invocation completes. */
  onStarted?: () => void;
}

export function FileList({ files, loading, error, onRetry, onStarted }: FileListProps) {
  const sorted = useMemo(() => {
    if (!files) return [];
    return [...files].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  }, [files]);

  if (loading && !files) {
    return (
      <section
        id={FILE_LIST_ANCHOR_ID}
        aria-label="Recent G-code files"
        data-testid="klipper-files-loading"
      >
        <SectionHeading>Recent G-code</SectionHeading>
        <SkeletonRows count={3} />
      </section>
    );
  }

  if (error) {
    return (
      <section
        id={FILE_LIST_ANCHOR_ID}
        aria-label="Recent G-code files"
        data-testid="klipper-files-error"
      >
        <SectionHeading>Recent G-code</SectionHeading>
        <div style={{ display: "flex", flexDirection: "column", gap: sp(2), padding: sp(3) }}>
          <StatusBadge label={`Could not load files: ${error.message}`} status="error" />
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              data-testid="klipper-files-retry"
              style={{
                alignSelf: "flex-start",
                minHeight: TAP_TARGET_MIN,
                padding: `${sp(2)} ${sp(3)}`,
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (sorted.length === 0) {
    return (
      <section
        id={FILE_LIST_ANCHOR_ID}
        aria-label="Recent G-code files"
        data-testid="klipper-files-empty"
      >
        <SectionHeading>Recent G-code</SectionHeading>
        <p style={{ padding: sp(3), ...muted }}>
          No G-code uploaded yet. Use the Upload affordance below to add a file.
        </p>
      </section>
    );
  }

  return (
    <section
      id={FILE_LIST_ANCHOR_ID}
      aria-label="Recent G-code files"
      data-testid="klipper-files"
    >
      <SectionHeading>Recent G-code</SectionHeading>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {sorted.map((file) => (
          <FileRow key={file.path} file={file} onStarted={onStarted} />
        ))}
      </ul>
    </section>
  );
}

interface FileRowProps {
  file: FileListEntry;
  onStarted?: () => void;
}

function FileRow({ file, onStarted }: FileRowProps) {
  const displayName = file.path.split("/").pop() ?? file.path;
  const startPrint = usePluginAction("start_print");
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);

  async function handleStart() {
    if (busy) return;
    setBusy(true);
    try {
      await startPrint({ filename: file.path });
      toast({ title: `Started ${displayName}`, tone: "success" });
      onStarted?.();
    } catch (err) {
      toast({
        title: "Could not start print",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      title={file.path}
      data-testid={`klipper-file-row-${file.path}`}
      style={{
        display: "grid",
        gridTemplateColumns: "48px 1fr auto",
        gap: sp(3),
        alignItems: "center",
        padding: `${sp(2)} ${sp(3)}`,
        minHeight: TAP_TARGET_MIN,
      }}
    >
      <PrinterGlyph sizePx={48} />
      <div style={{ display: "flex", flexDirection: "column", gap: sp(1), minWidth: 0 }}>
        <span
          style={{
            fontSize: fontSize.base,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayName}
        </span>
        <span style={muted}>
          {formatBytes(file.size)} · {formatRelativeTime(file.modified)}
        </span>
      </div>
      <button
        type="button"
        onClick={handleStart}
        disabled={busy}
        aria-busy={busy || undefined}
        data-testid="klipper-file-row-start"
        aria-label={`Start ${displayName}`}
        style={{
          flexShrink: 0,
          minHeight: TAP_TARGET_MIN,
          padding: `${sp(2)} ${sp(3)}`,
        }}
      >
        {busy ? "Starting…" : "Start"}
      </button>
    </li>
  );
}

function PrinterGlyph({ sizePx }: { sizePx: number }) {
  const dim = `${sizePx}px`;
  return (
    <span
      aria-hidden="true"
      data-testid="klipper-thumb-glyph"
      style={{
        width: dim,
        height: dim,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.04)",
        borderRadius: "4px",
      }}
    >
      <svg
        width={Math.round(sizePx * 0.6)}
        height={Math.round(sizePx * 0.6)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="4" width="18" height="9" rx="1.5" />
        <rect x="6" y="14" width="12" height="6" rx="1" />
        <path d="M7 8h10" />
      </svg>
    </span>
  );
}

function SectionHeading({ children }: { children: string }) {
  return (
    <h3
      style={{
        margin: 0,
        padding: `${sp(2)} ${sp(3)}`,
        fontSize: fontSize.sm,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        ...muted,
      }}
    >
      {children}
    </h3>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {Array.from({ length: count }, (_, i) => (
        <li
          key={i}
          data-testid="klipper-files-skeleton-row"
          style={{
            display: "grid",
            gridTemplateColumns: "48px 1fr auto",
            gap: sp(3),
            alignItems: "center",
            padding: `${sp(2)} ${sp(3)}`,
            minHeight: TAP_TARGET_MIN,
          }}
        >
          <span
            style={{
              width: "48px",
              height: "48px",
              background: "rgba(0,0,0,0.04)",
              borderRadius: "4px",
            }}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: sp(1) }}>
            <span
              style={{
                width: "60%",
                height: "14px",
                background: "rgba(0,0,0,0.06)",
                borderRadius: "2px",
              }}
            />
            <span
              style={{
                width: "40%",
                height: "10px",
                background: "rgba(0,0,0,0.04)",
                borderRadius: "2px",
              }}
            />
          </span>
          <Spinner size="sm" label="Loading" />
        </li>
      ))}
    </ul>
  );
}
