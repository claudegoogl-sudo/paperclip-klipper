// @vitest-environment jsdom
/**
 * Camera section UI tests (pull-based live view over the actions bridge).
 *
 * Covers:
 *   - unconfigured / loading states render the quiet hint or nothing
 *   - a fetched frame renders as an <img> data URL and the section reads
 *     "Live" while frames are fresh
 *   - a stale frame (staleMs past the threshold) flips the section to the
 *     stale banner instead of presenting a frozen frame as live
 *   - a terminally-failed upstream shows the error surface with an
 *     explicit Retry that calls camera_retry (F2 re-arm discipline)
 *   - unmount tells the worker camera_close (release the printer's
 *     single-viewer slot), as does hiding the tab
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const actionFns = new Map<string, Mock>();

function getAction(key: string): Mock {
  let fn = actionFns.get(key);
  if (!fn) {
    fn = vi.fn().mockResolvedValue({ ok: true });
    actionFns.set(key, fn);
  }
  return fn;
}

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginAction: (key: string) => getAction(key),
}));

import { CameraSection } from "../../src/ui/CameraSection.js";

const FRESH_FRAME = {
  ok: true,
  state: "connected",
  attempts: 0,
  lastError: null,
  nextRetryInMs: null,
  frame: { jpegBase64: "ZmFrZWpwZWc=", capturedAt: Date.now() },
  staleMs: 30,
};

beforeEach(() => {
  actionFns.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CameraSection", () => {
  it("renders nothing while config is still loading (configured undefined)", () => {
    const { container } = render(<CameraSection configured={undefined} />);
    expect(container.querySelector("[data-testid='klipper-camera-section']")).toBeNull();
    expect(container.querySelector("[data-testid='klipper-camera-unconfigured']")).toBeNull();
  });

  it("renders the quiet hint when the camera is not configured", () => {
    render(<CameraSection configured={false} />);
    expect(screen.getByTestId("klipper-camera-unconfigured")).toBeTruthy();
    expect(screen.getByText(/flashforgeCameraBaseUrl/)).toBeTruthy();
    // and it never opens the upstream
    expect(getAction("camera_open")).not.toHaveBeenCalled();
  });

  it("opens on mount, polls camera_next, and renders a fresh frame as Live", async () => {
    getAction("camera_next").mockResolvedValue({ ...FRESH_FRAME });
    render(<CameraSection configured={true} />);
    await waitFor(() => expect(getAction("camera_open")).toHaveBeenCalled());
    await waitFor(() => expect(getAction("camera_next")).toHaveBeenCalled());
    const img = (await screen.findByTestId("klipper-camera-frame")) as HTMLImageElement;
    expect(img.src).toBe("data:image/jpeg;base64,ZmFrZWpwZWc=");
    await waitFor(() => expect(screen.getByTestId("klipper-camera-status").textContent).toContain("Live"));
    expect(screen.queryByTestId("klipper-camera-stale")).toBeNull();
  });

  it("shows the stale banner when the newest frame is past the staleness threshold", async () => {
    getAction("camera_next").mockResolvedValue({
      ...FRESH_FRAME,
      staleMs: 4_000,
    });
    render(<CameraSection configured={true} />);
    await screen.findByTestId("klipper-camera-frame");
    await waitFor(() => expect(screen.getByTestId("klipper-camera-stale")).toBeTruthy());
  });

  it("a failed upstream surfaces the error + Retry, and Retry calls camera_retry", async () => {
    getAction("camera_next").mockResolvedValue({
      ok: true,
      state: "failed",
      attempts: 6,
      lastError: "camera_http_403",
      nextRetryInMs: null,
      frame: null,
      staleMs: null,
    });
    render(<CameraSection configured={true} />);
    await waitFor(() => expect(screen.getByTestId("klipper-camera-error")).toBeTruthy());
    expect(screen.getByTestId("klipper-camera-error").textContent).toContain("camera_http_403");
    const retry = screen.getByTestId("klipper-camera-retry") as HTMLButtonElement;
    fireEvent.click(retry);
    await waitFor(() => expect(getAction("camera_retry")).toHaveBeenCalled());
  });

  it("unmount tells the worker camera_close (releases the printer's camera slot)", async () => {
    getAction("camera_next").mockResolvedValue({ ...FRESH_FRAME });
    const { unmount } = render(<CameraSection configured={true} />);
    await screen.findByTestId("klipper-camera-frame");
    unmount();
    await waitFor(() => expect(getAction("camera_close")).toHaveBeenCalled());
  });

  it("hiding the tab stops polling and closes the upstream; showing it reopens", async () => {
    getAction("camera_next").mockResolvedValue({ ...FRESH_FRAME });
    render(<CameraSection configured={true} />);
    await screen.findByTestId("klipper-camera-frame");
    const closesBefore = getAction("camera_close").mock.calls.length;

    // Simulate the operator switching tabs.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(getAction("camera_close").mock.calls.length).toBeGreaterThan(closesBefore));

    // Polling must have stopped: count calls, wait past a poll period, expect no growth.
    const nextCallsAtHide = getAction("camera_next").mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(getAction("camera_next").mock.calls.length).toBe(nextCallsAtHide);

    // Back to visible → the section reopens the feed.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(getAction("camera_open").mock.calls.length).toBeGreaterThan(1));
  });
});
