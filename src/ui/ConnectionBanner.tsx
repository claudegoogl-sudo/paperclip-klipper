/**
 * Connection banner — section 1 of the Klipper page UI (PLA-480 / §6.4).
 *
 * Reads `connection` shape from the worker (registerRpcSurface.ts) and
 * renders only the states the user can act on or wait for. `idle` and
 * `connected` are intentionally invisible — banner-blindness is real and
 * a green "all good" pill wastes vertical space on a 390px viewport.
 *
 * The "(re)connect" CTA on `failed` calls `usePluginAction('retry_connection')`.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { Spinner, StatusBadge } from "./components.js";
import type { ConnectionStateSnapshot } from "../worker/MoonrakerClient.js";
import { row, sp, TAP_TARGET_MIN } from "./theme.js";
import { trimErrorMessage } from "./format.js";

export interface ConnectionBannerProps {
  /** Connection snapshot — may be null while the initial `status` fetch is in flight. */
  connection: ConnectionStateSnapshot | null;
  /** Refresh callback wired to the parent `usePluginData('status').refresh`. */
  onReconnected?: () => void;
}

export function ConnectionBanner({ connection, onReconnected }: ConnectionBannerProps) {
  const retry = usePluginAction("retry_connection");
  const toast = usePluginToast();
  const [retrying, setRetrying] = useState(false);

  // While we don't know the state yet, render nothing — the parent already
  // shows a Spinner for the initial status load.
  if (!connection) return null;
  const state = connection.state;

  // Idle (config not bound yet) and connected (steady-state) are hidden by
  // design — see UX spec §1.
  if (state === "idle" || state === "connected") return null;

  // Needs-config / unconfigured — PLA-502 follow-up. Until PLA-502 lands
  // the exact signal shape, the Page also performs a top-level short-circuit
  // for the full-replace card; this branch covers the "preferred" surface
  // where the worker emits `connection.state === "unconfigured"`.
  if ((state as string) === "unconfigured") {
    return (
      <BannerShell role="status" aria-live="polite" testId="klipper-banner-unconfigured">
        <StatusBadge label="Set up your Klipper printer" status="warning" />
        <span style={{ flex: 1, minWidth: 0 }}>
          Add your Moonraker host URL to start using this page. Configuration is in the plugin's
          settings.
        </span>
      </BannerShell>
    );
  }

  if (state === "connecting") {
    return (
      <BannerShell role="status" aria-live="polite" testId="klipper-banner-connecting">
        <Spinner size="sm" label="Connecting to printer" />
        <StatusBadge label="Connecting to printer…" status="pending" />
      </BannerShell>
    );
  }

  if (state === "reconnecting") {
    const nextRetrySec = connection.nextRetryInMs
      ? Math.max(1, Math.round(connection.nextRetryInMs / 1000))
      : null;
    const label = nextRetrySec
      ? `Reconnecting (attempt ${connection.attempts}) — next try in ${nextRetrySec}s`
      : `Reconnecting (attempt ${connection.attempts})…`;
    return (
      <BannerShell role="status" aria-live="polite" testId="klipper-banner-reconnecting">
        <Spinner size="sm" label="Reconnecting to printer" />
        <StatusBadge label={label} status="warning" />
      </BannerShell>
    );
  }

  // state === "failed"
  const fullError = connection.lastError ?? "";
  const trimmed = trimErrorMessage(fullError, 120);
  const message = trimmed
    ? `Printer is unreachable. Last error: ${trimmed}`
    : "Printer is unreachable.";

  async function handleReconnect() {
    if (retrying) return;
    setRetrying(true);
    try {
      await retry();
      toast({
        title: "Reconnected to printer",
        tone: "success",
      });
      onReconnected?.();
    } catch (err) {
      toast({
        title: "Could not reconnect",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setRetrying(false);
    }
  }

  function handleShowFullError() {
    if (!fullError || fullError === trimmed) return;
    toast({ title: "Connection error", body: fullError, tone: "warn" });
  }

  return (
    <BannerShell role="alert" aria-live="assertive" testId="klipper-banner-failed">
      <StatusBadge label="Printer unreachable" status="error" />
      <span
        data-testid="klipper-banner-failed-message"
        onClick={fullError && fullError !== trimmed ? handleShowFullError : undefined}
        style={{ flex: 1, minWidth: 0, cursor: fullError && fullError !== trimmed ? "pointer" : "default" }}
      >
        {message}
      </span>
      <button
        type="button"
        onClick={handleReconnect}
        disabled={retrying}
        aria-busy={retrying || undefined}
        data-testid="klipper-banner-reconnect"
        style={{
          minHeight: TAP_TARGET_MIN,
          minWidth: TAP_TARGET_MIN,
          padding: `${sp(2)} ${sp(3)}`,
        }}
      >
        {retrying ? "Reconnecting…" : "Reconnect"}
      </button>
    </BannerShell>
  );
}

interface BannerShellProps {
  children: ReactNode;
  role: "status" | "alert";
  "aria-live": "polite" | "assertive";
  testId: string;
}

function BannerShell({ children, role, "aria-live": ariaLive, testId }: BannerShellProps) {
  return (
    <div
      role={role}
      aria-live={ariaLive}
      data-testid={testId}
      style={{
        ...row(2),
        minHeight: TAP_TARGET_MIN,
        padding: `${sp(2)} ${sp(3)}`,
        flexWrap: "wrap",
      }}
    >
      {children}
    </div>
  );
}
