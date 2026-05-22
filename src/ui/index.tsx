/**
 * paperclip-klipper plugin UI — PLA-480 / §6.4.
 *
 * Exports the `Page` component bound to the host `page` slot at
 * `/:companyPrefix/printer` (e.g. `/PLA/printer`). The orchestrator owns
 * the cross-section state (selectedFile for the detail view), pulls live
 * data from the worker's RPC surface (registerRpcSurface.ts), and stacks
 * the four sections per the UX spec — promoting the active-print panel
 * above the queue while a print is running so the controls land in the
 * thumb zone on a 390px viewport.
 *
 * No direct `fetch` from UI; no `ctx.assets` — thumbnails come from
 * `usePluginData('file_metadata').thumbnails[0].data`.
 */
import { useCallback, useMemo, useState } from "react";
import {
  usePluginData,
  usePluginStream,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary, Spinner } from "./components.js";
import type {
  ConnectionStateSnapshot,
  FileListEntry,
  MoonrakerStatusSnapshot,
} from "./../worker/MoonrakerClient.js";
import { ActivePrint, ACTIVE_PRINT_STATES } from "./ActivePrint.js";
import { ConnectionBanner } from "./ConnectionBanner.js";
import { FileDetail } from "./FileDetail.js";
import { FileList } from "./FileList.js";
import { sp, stack } from "./theme.js";
import { STREAM_CHANNEL } from "../streamChannel.js";

interface ClientStreamEvent {
  type?: "status" | "connection";
  snapshot?: MoonrakerStatusSnapshot;
  state?: ConnectionStateSnapshot;
}

interface ConfigDataSnapshot {
  configured: boolean;
  moonrakerBaseUrl: string | null;
}

/**
 * Rendered when the worker started without `moonrakerBaseUrl` (PLA-502/503).
 * Functional CTA only — UX polish is intentionally out of scope per the
 * issue brief.
 */
function NeedsConfigPlaceholder() {
  return (
    <main
      aria-label="Printer"
      data-testid="klipper-page-needs-config"
      style={{
        ...stack(2),
        padding: sp(3),
        maxWidth: "720px",
        margin: "0 auto",
      }}
    >
      <h1 style={{ margin: 0 }}>Configure Moonraker</h1>
      <p style={{ margin: 0 }}>
        Set <code>moonrakerBaseUrl</code> in plugin settings to connect this
        printer.
      </p>
    </main>
  );
}

/**
 * `Page` is the entry component for the manifest's `page` slot
 * (id: `klipper-page`, exportName: `Page`, routePath: `printer`).
 */
export function Page(_props: PluginPageProps) {
  const [selectedFile, setSelectedFile] = useState<FileListEntry | null>(null);

  // PLA-502/503: branch on plugin config presence. When the worker started
  // without `moonrakerBaseUrl` the page slot renders a needs-config CTA
  // instead of trying to read status/files (which would no-op anyway).
  const configData = usePluginData<ConfigDataSnapshot>("config");
  const status = usePluginData<MoonrakerStatusSnapshot>("status");
  const files = usePluginData<FileListEntry[]>("files");
  // Stream subscription keeps the active-print panel warm without polling.
  // Connection/error from the stream is intentionally not surfaced — the
  // status `usePluginData` call is the source of truth for the banner.
  usePluginStream<ClientStreamEvent>(STREAM_CHANNEL);

  const connection: ConnectionStateSnapshot | null = status.data?.connection ?? null;
  const printState = status.data?.objects?.print_stats as { state?: string } | undefined;
  const isPrinting = printState?.state ? ACTIVE_PRINT_STATES.has(printState.state) : false;

  const refreshStatus = useCallback(() => status.refresh(), [status]);
  const refreshFiles = useCallback(() => files.refresh(), [files]);
  const handleBack = useCallback(() => setSelectedFile(null), []);

  const initialStatusLoading = status.loading && !status.data;

  // Stable section nodes; ordering decided below.
  const activePanel = useMemo(
    () => (
      <ActivePrint
        key="active"
        status={status.data}
        onRefresh={refreshStatus}
      />
    ),
    [status.data, refreshStatus],
  );

  const queue = useMemo(
    () =>
      selectedFile ? (
        <FileDetail
          key="detail"
          file={selectedFile}
          onBack={handleBack}
          onFilesChanged={refreshFiles}
        />
      ) : (
        <FileList
          key="files"
          files={files.data}
          loading={files.loading}
          error={files.error}
          onRetry={refreshFiles}
          onSelect={setSelectedFile}
        />
      ),
    [selectedFile, files.data, files.loading, files.error, refreshFiles, handleBack],
  );

  // PLA-502/503: if the worker reported no configured base URL, render the
  // needs-config placeholder. Treat "loading" as "not yet known"; only
  // branch once `configured` has resolved to a concrete `false`.
  if (configData.data && configData.data.configured === false) {
    return (
      <ErrorBoundary>
        <NeedsConfigPlaceholder />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <main
        aria-label="Printer"
        data-testid="klipper-page"
        style={{
          ...stack(2),
          padding: sp(2),
          maxWidth: "720px",
          margin: "0 auto",
        }}
      >
        <ConnectionBanner connection={connection} onReconnected={refreshStatus} />

        {initialStatusLoading ? (
          <div
            data-testid="klipper-page-loading"
            style={{ display: "flex", gap: sp(2), alignItems: "center", padding: sp(3) }}
          >
            <Spinner size="sm" label="Loading printer status" />
            <span>Loading printer status…</span>
          </div>
        ) : null}

        {/* Promote the active-print panel above the queue while a print is
            running (UX spec IA, per-state ordering). When idle, the panel
            collapses to a single "No active print" line below the queue. */}
        {isPrinting ? (
          <>
            {activePanel}
            {queue}
          </>
        ) : (
          <>
            {queue}
            {activePanel}
          </>
        )}
      </main>
    </ErrorBoundary>
  );
}
