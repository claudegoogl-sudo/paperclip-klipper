/**
 * Recent uploads / queue — section 2 of the Klipper page UI (PLA-480 / §6.4).
 *
 * Mobile-first single-column list (not a `<table>`); each row is a single
 * ≥44px tap target that calls `onSelect(file)` to open the detail view.
 * Thumbnails are loaded lazily per row via `usePluginData('file_metadata')`
 * — never `ctx.assets`, never direct `fetch`.
 *
 * Sort: newest first (`modified` desc). No sort UI in v1 (Hick's Law).
 */
import { useMemo } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { Spinner, StatusBadge } from "./components.js";
import type { FileListEntry, FileMetadata } from "../worker/MoonrakerClient.js";
import { fontSize, muted, sp, TAP_TARGET_MIN } from "./theme.js";
import { firstInlineThumbnailDataUrl, formatBytes, formatRelativeTime } from "./format.js";

export interface FileListProps {
  /** The file list as returned by `usePluginData('files')`. */
  files: FileListEntry[] | null;
  loading: boolean;
  error: { message: string } | null;
  /** Refresh callback for the inline error-state retry button. */
  onRetry?: () => void;
  /** Open the detail view for a file. */
  onSelect: (file: FileListEntry) => void;
}

export function FileList({ files, loading, error, onRetry, onSelect }: FileListProps) {
  const sorted = useMemo(() => {
    if (!files) return [];
    return [...files].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  }, [files]);

  if (loading && !files) {
    return (
      <section aria-label="Recent G-code files" data-testid="klipper-files-loading">
        <SectionHeading>Recent G-code</SectionHeading>
        <SkeletonRows count={3} />
      </section>
    );
  }

  if (error) {
    return (
      <section aria-label="Recent G-code files" data-testid="klipper-files-error">
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
      <section aria-label="Recent G-code files" data-testid="klipper-files-empty">
        <SectionHeading>Recent G-code</SectionHeading>
        <p style={{ padding: sp(3), ...muted }}>
          No G-code uploaded yet. Files an agent uploads with{" "}
          <code>klipper.upload_gcode</code> will appear here.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Recent G-code files" data-testid="klipper-files">
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
          <FileRow key={file.path} file={file} onSelect={onSelect} />
        ))}
      </ul>
    </section>
  );
}

interface FileRowProps {
  file: FileListEntry;
  onSelect: (file: FileListEntry) => void;
}

function FileRow({ file, onSelect }: FileRowProps) {
  const displayName = file.path.split("/").pop() ?? file.path;
  const { data: meta, loading: metaLoading } = usePluginData<FileMetadata>("file_metadata", {
    filename: file.path,
  });
  const thumbUrl = meta ? firstInlineThumbnailDataUrl(meta.thumbnails) : null;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(file)}
        title={file.path}
        aria-label={`Open ${displayName}`}
        data-testid={`klipper-file-row-${file.path}`}
        style={{
          width: "100%",
          minHeight: TAP_TARGET_MIN,
          display: "grid",
          gridTemplateColumns: "48px 1fr auto",
          gap: sp(3),
          alignItems: "center",
          padding: `${sp(2)} ${sp(3)}`,
          textAlign: "left",
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
      >
        <Thumbnail loading={metaLoading} src={thumbUrl} alt="" sizePx={48} />
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
        <span aria-hidden="true" style={{ fontSize: fontSize.md, opacity: 0.5 }}>
          ›
        </span>
      </button>
    </li>
  );
}

interface ThumbnailProps {
  loading: boolean;
  src: string | null;
  alt: string;
  sizePx: number;
}

export function Thumbnail({ loading, src, alt, sizePx }: ThumbnailProps) {
  const dim = `${sizePx}px`;
  if (loading) {
    return (
      <span
        data-testid="klipper-thumb-loading"
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
        <Spinner size="sm" label="Loading thumbnail" />
      </span>
    );
  }
  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        width={sizePx}
        height={sizePx}
        data-testid="klipper-thumb-image"
        style={{ width: dim, height: dim, objectFit: "contain", borderRadius: "4px" }}
      />
    );
  }
  return <PrinterGlyph sizePx={sizePx} />;
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
        fontSize: `${Math.round(sizePx * 0.6)}px`,
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
        </li>
      ))}
    </ul>
  );
}
