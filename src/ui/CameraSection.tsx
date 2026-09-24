/**
 * Camera section — live view from the printer's camera (§6.4 rev-4 addendum).
 *
 * Delivery model (per the phase-2 security review): PULL over the
 * authenticated actions bridge. This host generation drops worker
 * `streams.emit` notifications made outside a dispatch, so per-frame SSE
 * push cannot reach the page; instead the section polls `camera_next`
 * (~2 fps) while it is visible. The worker keeps ONE upstream MJPG
 * connection and a keep-latest single-frame buffer — a slow page just
 * re-reads an older frame, and the printer's single-viewer camera slot is
 * freed automatically when the section unmounts, the tab is hidden, or
 * the operator stops looking (worker-side 20 s idle timeout).
 *
 * Security: frames are served only through board-authenticated actions —
 * agent keys are refused worker-side (C1). The section never posts frames
 * anywhere: they render in an <img> and nothing else.
 *
 * Staleness: each poll reports `staleMs` from the worker's monotonic
 * capture clock. If the newest frame is older than STALE_AFTER_MS the
 * section shows a stale banner rather than ever presenting a frozen frame
 * as live. A terminally-failed upstream (F2) offers an explicit Retry
 * (camera_retry), mirroring the transports' re-arm discipline.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { fontSize, muted, sp, stack, TAP_TARGET_MIN } from "./theme.js";

const POLL_MS = 500;
/** Older than this and the section says "stale" instead of "live". */
const STALE_AFTER_MS = 2_500;

interface CameraConnectionInfo {
  state: string;
  attempts: number;
  lastError?: string | null;
  nextRetryInMs?: number | null;
}

interface CameraNextResult {
  ok: boolean;
  state: CameraConnectionInfo["state"];
  attempts: number;
  lastError: string | null;
  nextRetryInMs: number | null;
  frame: { jpegBase64: string; capturedAt: number } | null;
  staleMs: number | null;
}

export interface CameraSectionProps {
  /**
   * From the `config` data key's `cameraConfigured`. `undefined` (config
   * still loading) renders nothing; `false` renders a quiet hint.
   */
  configured?: boolean;
}

type Phase = "connecting" | "live" | "stale" | "reconnecting" | "failed" | "idle";

export function CameraSection({ configured }: CameraSectionProps) {
  const openAction = usePluginAction("camera_open");
  const nextAction = usePluginAction("camera_next");
  const closeAction = usePluginAction("camera_close");
  const retryAction = usePluginAction("camera_retry");

  // Keep latest action fns in a ref so the poll effect doesn't churn on
  // every render (the SDK may or may not memoize the callable).
  const actionsRef = useRef({ openAction, nextAction, closeAction, retryAction });
  actionsRef.current = { openAction, nextAction, closeAction, retryAction };

  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [detail, setDetail] = useState<string | null>(null); // lastError / retry hint
  const [retryInFlight, setRetryInFlight] = useState(false);
  const [tabVisible, setTabVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );

  // Pause the whole section when the tab is hidden: stop polling AND tell
  // the worker to release the printer's single-viewer camera slot.
  useEffect(() => {
    const onVisibility = () => {
      setTabVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!configured || !tabVisible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastFrameAt = 0;
    let workerStaleMs: number | null = null;

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void tick(), ms);
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = (await actionsRef.current.nextAction()) as CameraNextResult;
        if (cancelled) return;
        workerStaleMs = res.staleMs;
        if (res.frame) {
          lastFrameAt = Date.now();
          setFrameSrc(`data:image/jpeg;base64,${res.frame.jpegBase64}`);
        }
        setDetail(res.lastError);
        switch (res.state) {
          case "connected":
            setPhase(lastFrameAt === 0 ? "connecting" : "live");
            break;
          case "connecting":
            setPhase("connecting");
            break;
          case "reconnecting":
            setPhase("reconnecting");
            break;
          case "failed":
            setPhase("failed");
            schedule(POLL_MS * 4); // back off harder while failed
            return;
          default:
            setPhase("connecting");
        }
      } catch (err) {
        // Bridge error: worker restarting, action missing on old worker, or
        // camera removed from config. Surface briefly; keep trying gently.
        if (cancelled) return;
        setPhase((prev) => (prev === "failed" ? "failed" : "reconnecting"));
        setDetail(err instanceof Error ? err.message : String(err));
      }
      schedule(POLL_MS);
    };

    const staleTicker = setInterval(() => {
      if (cancelled) return;
      if (lastFrameAt > 0) {
        const ageMs = (workerStaleMs ?? 0) + (Date.now() - lastFrameAt);
        setPhase((prev) => {
          if (prev === "failed") return prev;
          if (ageMs > STALE_AFTER_MS) return prev === "stale" ? prev : "stale";
          return prev === "stale" || prev === "live" ? "live" : prev;
        });
      }
    }, POLL_MS);

    (async () => {
      try {
        await actionsRef.current.openAction();
      } catch {
        // surfaced by the first poll (prerequisite_missing etc.)
      }
      void tick();
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(staleTicker);
      // Release the printer's camera slot for the next viewer.
      actionsRef.current.closeAction().catch(() => {});
    };
  }, [configured, tabVisible]);

  const onRetry = useCallback(async () => {
    setRetryInFlight(true);
    try {
      await actionsRef.current.retryAction();
      setPhase("connecting");
      setDetail(null);
    } catch (err) {
      setDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setRetryInFlight(false);
    }
  }, []);

  if (configured === undefined) return null;

  if (configured === false) {
    return (
      <section
        aria-label="Printer camera"
        data-testid="klipper-camera-unconfigured"
        style={{ ...stack(1), padding: sp(3), border: "1px dashed rgba(0,0,0,0.15)", borderRadius: "6px" }}
      >
        <strong style={{ fontSize: fontSize.md }}>Camera not configured</strong>
        <span style={{ ...muted, fontSize: fontSize.sm }}>
          Set <code>flashforgeCameraBaseUrl</code> in the plugin settings to show the printer's live view here.
        </span>
      </section>
    );
  }

  const statusLabel: Record<Phase, string> = {
    connecting: "Connecting…",
    live: "Live",
    stale: "Stale — reconnecting",
    reconnecting: "Reconnecting…",
    failed: "Failed",
    idle: "Idle",
  };

  return (
    <section
      aria-label="Printer camera"
      data-testid="klipper-camera-section"
      style={{ ...stack(2), padding: sp(3), border: "1px solid rgba(0,0,0,0.08)", borderRadius: "6px" }}
    >
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: fontSize.md }}>Camera</strong>
        <span
          data-testid="klipper-camera-status"
          style={{ ...muted, fontSize: fontSize.sm }}
          role="status"
        >
          {statusLabel[phase]}
          {phase === "reconnecting" && detail ? ` — ${detail}` : ""}
        </span>
      </header>

      {frameSrc !== null ? (
        <div style={{ position: "relative", alignSelf: "stretch" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-testid="klipper-camera-frame"
            src={frameSrc}
            alt="Live view from the printer camera"
            style={{ width: "100%", height: "auto", display: "block", borderRadius: "4px" }}
          />
          {phase === "stale" || phase === "reconnecting" ? (
            <div
              data-testid="klipper-camera-stale"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(255,255,255,0.55)",
                fontWeight: 600,
                fontSize: fontSize.sm,
              }}
            >
              Frame is stale — the printer may have stopped streaming
            </div>
          ) : null}
        </div>
      ) : phase === "failed" ? (
        <div
          data-testid="klipper-camera-error"
          role="alert"
          style={{ ...stack(1), fontSize: fontSize.sm }}
        >
          <span style={{ fontWeight: 600 }}>
            The camera connection failed{detail ? `: ${detail}` : "."}
          </span>
          <span style={muted}>Streaming stopped after repeated failures. Retry when the printer is reachable.</span>
        </div>
      ) : (
        <div
          data-testid="klipper-camera-connecting"
          style={{ ...muted, fontSize: fontSize.sm, minHeight: "44px", display: "flex", alignItems: "center" }}
        >
          Waiting for the first frame from the printer…
        </div>
      )}

      {phase === "failed" ? (
        <button
          type="button"
          data-testid="klipper-camera-retry"
          onClick={() => void onRetry()}
          disabled={retryInFlight}
          style={{ alignSelf: "flex-start", minHeight: TAP_TARGET_MIN, fontWeight: 600 }}
        >
          {retryInFlight ? "Retrying…" : "Retry camera"}
        </button>
      ) : null}

      <span style={{ ...muted, fontSize: fontSize.sm }}>
        Frames are streamed only to signed-in board users viewing this page.
      </span>
    </section>
  );
}
