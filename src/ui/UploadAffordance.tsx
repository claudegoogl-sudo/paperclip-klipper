/**
 * Upload affordance — section 4 of the Klipper page UI (see §6.4 rev-4).
 *
 * Native `<input type="file">` picker → base64-encoded upload via
 * `usePluginAction('upload_gcode')`. Inline success/failure surface (no
 * toast — the section itself is the status carrier).
 *
 * Filename validation mirrors `src/manifest.ts:130` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gcode$`).
 * Auto-upload-flag gate is enforced worker-side; the verbatim worker error
 * is surfaced here without rewording (UX: no dark patterns).
 *
 * **Worker contract dependency:** the `upload_gcode` action is tracked as a
 * follow-up item. Until it lands, `usePluginAction('upload_gcode')` resolves
 * with the SDK's "unknown action" error, which we surface verbatim.
 */
import { useEffect, useRef, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { StatusBadge } from "./components.js";
import type { FileListEntry } from "../worker/MoonrakerClient.js";
import { fontSize, muted, sp, stack, TAP_TARGET_MIN } from "./theme.js";
import { formatBytes } from "./format.js";

// Mirrors the manifest validation regex for client-side fail-fast.
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gcode$/;

interface UploadAffordanceProps {
  /** Refresh `files` after a successful upload so the new row appears. */
  onUploaded?: () => void;
  /**
   * Optional injection point for tests. In production we rely on the SDK's
   * own data store. Tests can stub this so the helper "Refreshing file
   * list…" hint resolves without a real refresh.
   */
  _filesData?: ReturnType<typeof usePluginData<FileListEntry[]>>;
}

type UploadState =
  | { phase: "idle" }
  | { phase: "selected"; file: File }
  | { phase: "validating"; file: File; error: string }
  | { phase: "uploading"; file: File }
  | { phase: "refreshing"; file: File }
  | { phase: "success"; file: File }
  | { phase: "error"; file: File; message: string };

const SUCCESS_AUTO_CLEAR_MS = 4000;

export function UploadAffordance({ onUploaded }: UploadAffordanceProps) {
  const upload = usePluginAction("upload_gcode");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<UploadState>({ phase: "idle" });

  // Auto-clear the success badge after a brief hold (Peak-End — user has
  // already moved on to Start). Keep the failure badge visible until the
  // user acts on it.
  useEffect(() => {
    if (state.phase !== "success") return;
    const t = setTimeout(() => setState({ phase: "idle" }), SUCCESS_AUTO_CLEAR_MS);
    return () => clearTimeout(t);
  }, [state.phase]);

  function pick() {
    inputRef.current?.click();
  }

  function onPicked(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    // Reset the input value so picking the same file twice still fires.
    ev.target.value = "";
    if (!file) return;
    if (!FILENAME_RE.test(file.name)) {
      setState({
        phase: "validating",
        file,
        error: "Filename must start with a letter or digit and end in .gcode.",
      });
      return;
    }
    setState({ phase: "selected", file });
  }

  async function handleUpload() {
    if (state.phase !== "selected") return;
    const { file } = state;
    setState({ phase: "uploading", file });
    let base64: string;
    try {
      base64 = await readFileAsBase64(file);
    } catch (err) {
      setState({
        phase: "error",
        file,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    try {
      await upload({ filename: file.name, gcodeBase64: base64 });
      setState({ phase: "refreshing", file });
      onUploaded?.();
      setState({ phase: "success", file });
    } catch (err) {
      setState({
        phase: "error",
        file,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function reset() {
    setState({ phase: "idle" });
  }

  function tryAgain() {
    if (state.phase === "error" || state.phase === "validating") {
      setState({ phase: "selected", file: state.file });
    }
  }

  return (
    <section
      aria-label="Upload G-code"
      data-testid="klipper-upload"
      style={{
        ...stack(2),
        padding: sp(3),
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: "6px",
      }}
    >
      <h3 style={{ margin: 0, fontSize: fontSize.md }}>Upload G-code</h3>

      {/* Hidden native picker. */}
      <input
        ref={inputRef}
        type="file"
        accept=".gcode"
        onChange={onPicked}
        data-testid="klipper-upload-input"
        style={{ display: "none" }}
      />

      {state.phase === "idle" ? <IdleSurface onPick={pick} /> : null}

      {state.phase === "validating" ? (
        <ValidationFailureSurface file={state.file} error={state.error} onPickAnother={pick} />
      ) : null}

      {state.phase === "selected" ? (
        <SelectedSurface
          file={state.file}
          onPickAnother={pick}
          onUpload={handleUpload}
        />
      ) : null}

      {state.phase === "uploading" || state.phase === "refreshing" ? (
        <UploadingSurface file={state.file} refreshing={state.phase === "refreshing"} />
      ) : null}

      {state.phase === "success" ? (
        <SuccessSurface file={state.file} onClear={reset} />
      ) : null}

      {state.phase === "error" ? (
        <FailureSurface
          file={state.file}
          message={state.message}
          onTryAgain={tryAgain}
          onPickAnother={pick}
        />
      ) : null}
    </section>
  );
}

function IdleSurface({ onPick }: { onPick: () => void }) {
  return (
    <div style={stack(1)}>
      <button
        type="button"
        onClick={onPick}
        data-testid="klipper-upload-pick"
        style={{ minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}`, alignSelf: "flex-start" }}
      >
        Choose .gcode file
      </button>
      <span style={muted}>No file selected.</span>
    </div>
  );
}

function ValidationFailureSurface({
  file,
  error,
  onPickAnother,
}: {
  file: File;
  error: string;
  onPickAnother: () => void;
}) {
  return (
    <div style={stack(2)}>
      <StatusBadge label={error} status="error" />
      <span style={muted}>
        {file.name} · {formatBytes(file.size)}
      </span>
      <button
        type="button"
        onClick={onPickAnother}
        data-testid="klipper-upload-pick-another"
        style={{ minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}`, alignSelf: "flex-start" }}
      >
        Choose another
      </button>
    </div>
  );
}

function SelectedSurface({
  file,
  onPickAnother,
  onUpload,
}: {
  file: File;
  onPickAnother: () => void;
  onUpload: () => void;
}) {
  return (
    <div style={stack(2)}>
      <div role="group" aria-label="Upload controls" style={{ display: "flex", gap: sp(2) }}>
        <button
          type="button"
          onClick={onPickAnother}
          data-testid="klipper-upload-pick-another"
          style={{ flex: 1, minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}` }}
        >
          Choose another
        </button>
        <button
          type="button"
          onClick={onUpload}
          data-testid="klipper-upload-submit"
          style={{ flex: 1, minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}`, fontWeight: 600 }}
        >
          Upload
        </button>
      </div>
      <span style={muted}>
        {file.name} · {formatBytes(file.size)}
      </span>
    </div>
  );
}

function UploadingSurface({ file, refreshing }: { file: File; refreshing: boolean }) {
  return (
    <div style={stack(1)} aria-busy="true">
      <div style={{ display: "flex", gap: sp(2) }}>
        <button
          type="button"
          disabled
          data-testid="klipper-upload-pick-another"
          style={{ flex: 1, minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}` }}
        >
          Choose another
        </button>
        <button
          type="button"
          disabled
          aria-busy="true"
          data-testid="klipper-upload-submit"
          style={{ flex: 1, minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}`, fontWeight: 600 }}
        >
          Uploading…
        </button>
      </div>
      <progress
        aria-label="Uploading"
        data-testid="klipper-upload-progress"
        style={{ width: "100%", height: "8px" }}
      />
      <span style={muted}>
        {refreshing ? "Refreshing file list…" : `${file.name} · ${formatBytes(file.size)}`}
      </span>
    </div>
  );
}

function SuccessSurface({ file, onClear }: { file: File; onClear: () => void }) {
  return (
    <div style={stack(1)}>
      <StatusBadge label={`Uploaded — ${file.name}`} status="ok" />
      <button
        type="button"
        onClick={onClear}
        data-testid="klipper-upload-dismiss"
        style={{ minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}`, alignSelf: "flex-start" }}
      >
        Upload another
      </button>
    </div>
  );
}

function FailureSurface({
  file,
  message,
  onTryAgain,
  onPickAnother,
}: {
  file: File;
  message: string;
  onTryAgain: () => void;
  onPickAnother: () => void;
}) {
  return (
    <div style={stack(2)} data-testid="klipper-upload-error">
      <StatusBadge label={message} status="error" />
      <span style={muted}>
        {file.name} · {formatBytes(file.size)}
      </span>
      <div style={{ display: "flex", gap: sp(2) }}>
        <button
          type="button"
          onClick={onPickAnother}
          data-testid="klipper-upload-pick-another"
          style={{ flex: 1, minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}` }}
        >
          Choose another
        </button>
        <button
          type="button"
          onClick={onTryAgain}
          data-testid="klipper-upload-try-again"
          style={{ flex: 1, minHeight: TAP_TARGET_MIN, padding: `${sp(2)} ${sp(3)}`, fontWeight: 600 }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}

async function readFileAsBase64(file: File): Promise<string> {
  // FileReader is friendlier on large files than ArrayBuffer + btoa, which
  // chokes on the spread-into-fromCharCode trick at multi-MB sizes.
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
