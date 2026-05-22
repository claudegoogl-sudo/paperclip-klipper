/**
 * paperclip-klipper plugin UI — PLA-480 / §6.4 (rev-4, full printer page).
 *
 * Exports the `Page` component bound to the host `page` slot at
 * `/:companyPrefix/printer` (e.g. `/PLA/printer`). The orchestrator pulls
 * live data from the worker's RPC surface (`registerRpcSurface.ts`) and
 * stacks the five sections per the rev-4 UX spec:
 *
 *   1. Connection banner
 *   2. Active print panel  ← promoted above the queue while printing
 *   3. gcode file list (inline Start per row; no thumbnails in v1.0)
 *   4. Upload affordance
 *   5. Last-completed-job summary (collapsible footer)
 *
 * No direct `fetch` from UI; no `ctx.assets` — thumbnails are deferred to v1.1.
 */
import { useCallback } from "react";
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
import { FileList } from "./FileList.js";
import { LastCompletedJob } from "./LastCompletedJob.js";
import { UploadAffordance } from "./UploadAffordance.js";
import { fontSize, sp, stack } from "./theme.js";
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

  const initialStatusLoading = status.loading && !status.data;

  // Needs-config / unconfigured short-circuit. The preferred PLA-502 signal
  // is `connection.state === "unconfigured"` (rendered inline by
  // ConnectionBanner). The full-replace fallback below covers the case
  // where the worker surfaces this through a `status.error` code instead.
  if (isUnconfiguredError(status.error)) {
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
          <UnconfiguredCard />
        </main>
      </ErrorBoundary>
    );
  }

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
        {/* §1 */}
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

        {/* Order:
            - When printing: §2 (active) promoted above §3 (file list).
            - When idle: §3 above §2 so the empty-state "Start a print ↑"
              CTA sits beneath the file list its arrow points up at. */}
        {isPrinting ? (
          <>
            <ActivePrint status={status.data} onRefresh={refreshStatus} />
            <FileList
              files={files.data}
              loading={files.loading}
              error={files.error}
              onRetry={refreshFiles}
              onStarted={refreshFiles}
            />
          </>
        ) : (
          <>
            <FileList
              files={files.data}
              loading={files.loading}
              error={files.error}
              onRetry={refreshFiles}
              onStarted={refreshFiles}
            />
            <ActivePrint status={status.data} onRefresh={refreshStatus} />
          </>
        )}

        {/* §4 */}
        <UploadAffordance onUploaded={refreshFiles} />

        {/* §5 */}
        <LastCompletedJob status={status.data} />
      </main>
    </ErrorBoundary>
  );
}

/**
 * Sentinel: the worker surfaces "needs config" either as a structured
 * `connection.state === "unconfigured"` (preferred — caught in
 * ConnectionBanner) or as a `status` error whose code / message matches the
 * patterns below. PLA-502 will pin the wire shape; until then the message
 * match keeps the UI responsive.
 */
function isUnconfiguredError(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "unconfigured") return true;
  const msg = (error.message ?? "").toLowerCase();
  return msg.includes("unconfigured") || msg.includes("moonrakerbaseurl");
}

function UnconfiguredCard() {
  return (
    <section
      role="status"
      aria-label="Set up your Klipper printer"
      data-testid="klipper-unconfigured"
      style={{
        ...stack(3),
        padding: sp(4),
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: "6px",
      }}
    >
      <h2 style={{ margin: 0, fontSize: fontSize.lg }}>Set up your Klipper printer</h2>
      <p style={{ margin: 0 }} id="klipper-unconfigured-helper">
        Add your Moonraker host URL to start using this page. Configuration is in the plugin's
        settings.
      </p>
      <button
        type="button"
        disabled
        aria-describedby="klipper-unconfigured-helper"
        data-testid="klipper-unconfigured-cta"
        style={{
          alignSelf: "flex-start",
          minHeight: "44px",
          padding: `${sp(2)} ${sp(3)}`,
          fontWeight: 600,
        }}
      >
        Open settings
      </button>
      <span style={{ fontSize: fontSize.sm, opacity: 0.7 }}>
        Configuration is provided by your operator — ask them to set <code>moonrakerBaseUrl</code>.
      </span>
    </section>
  );
}
