// @vitest-environment jsdom
/**
 * UI interaction tests for the Klipper plugin.
 *
 * PLA-486 swapped the orchestrator from a `page` slot's `Page` component to
 * a minimal `dashboardWidget` slot's `DashboardWidget` placeholder. The
 * widget smoke test below replaces the old four-section Page orchestrator
 * test; the section-level component tests (ConnectionBanner, ActivePrint,
 * FileList, FileDetail) are unchanged — those components stay on disk
 * because PLA-480 (rescoped, UXDesigner-led) will reuse them for the real
 * widget UX. SDK hooks are mocked so the component tree never touches the
 * bridge transport (which is a host runtime, not present under vitest).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../src/manifest.js";
import type {
  ConnectionStateSnapshot,
  FileListEntry,
  FileMetadata,
  MoonrakerStatusSnapshot,
} from "../../src/worker/MoonrakerClient.js";
import { MoonrakerClient } from "../../src/worker/MoonrakerClient.js";
import { MockMoonraker } from "../fixtures/moonraker/mockServer.js";

// ── SDK mocks ────────────────────────────────────────────────────────────
const dataFn = vi.fn();
const streamFn = vi.fn();
const actionFns = new Map<string, Mock>();
const toastFn = vi.fn();

function getAction(key: string): Mock {
  let fn = actionFns.get(key);
  if (!fn) {
    fn = vi.fn().mockResolvedValue({ ok: true });
    actionFns.set(key, fn);
  }
  return fn;
}

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: (...args: unknown[]) => dataFn(...args),
  usePluginAction: (key: string) => getAction(key),
  usePluginStream: (...args: unknown[]) => streamFn(...args),
  usePluginToast: () => toastFn,
  useHostContext: () => ({
    companyId: null,
    companyPrefix: null,
    projectId: null,
    entityId: null,
    entityType: null,
    userId: null,
  }),
}));

// Stable refs for the test harness to assert on.
function makeDataResult<T>(data: T | null, opts: Partial<{ loading: boolean; error: { message: string } | null }> = {}) {
  return {
    data,
    loading: opts.loading ?? false,
    error: opts.error ?? null,
    refresh: vi.fn(),
  };
}

function makeStreamResult() {
  return {
    events: [] as unknown[],
    lastEvent: null,
    connecting: false,
    connected: true,
    error: null,
    close: vi.fn(),
  };
}

interface DataMapEntry {
  data?: unknown;
  loading?: boolean;
  error?: { message: string } | null;
}

function setDataMap(map: Record<string, DataMapEntry>) {
  dataFn.mockImplementation((key: string, _params?: Record<string, unknown>) => {
    const entry = map[key];
    if (!entry) {
      return makeDataResult(null);
    }
    return makeDataResult(entry.data ?? null, {
      loading: entry.loading,
      error: entry.error,
    });
  });
}

beforeEach(() => {
  dataFn.mockReset();
  streamFn.mockReset();
  streamFn.mockImplementation(() => makeStreamResult());
  actionFns.clear();
  toastFn.mockReset();
});

afterEach(() => {
  cleanup();
});

// ── DashboardWidget placeholder (PLA-486) ────────────────────────────────
describe("DashboardWidget placeholder (PLA-486)", () => {
  it("renders the minimal placeholder bound to the dashboardWidget slot", async () => {
    const { DashboardWidget } = await import("../../src/ui/index.js");
    render(
      <DashboardWidget
        context={{
          companyId: null,
          companyPrefix: null,
          projectId: null,
          entityId: null,
          entityType: null,
          userId: null,
        }}
      />,
    );
    expect(screen.getByTestId("klipper-dashboard-widget")).toBeTruthy();
    expect(screen.getByText(/Klipper/)).toBeTruthy();
    // Placeholder only — the full widget UX (connection banner, last-job
    // summary, launcher button) lands in PLA-480, not here.
    expect(screen.getByText(/PLA-480/)).toBeTruthy();
  });
});

// ── Connection banner ────────────────────────────────────────────────────
describe("ConnectionBanner (§6.4 §1)", () => {
  async function renderBanner(connection: ConnectionStateSnapshot | null) {
    const { ConnectionBanner } = await import("../../src/ui/ConnectionBanner.js");
    return render(<ConnectionBanner connection={connection} />);
  }

  it("renders nothing for idle / connected (banner-blindness guard)", async () => {
    await renderBanner({ state: "idle", attempts: 0 });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a pending badge while connecting", async () => {
    await renderBanner({ state: "connecting", attempts: 1 });
    expect(screen.getByTestId("klipper-banner-connecting")).toBeTruthy();
    expect(screen.getByText(/Connecting to printer/i)).toBeTruthy();
  });

  it("renders attempt + retry countdown while reconnecting", async () => {
    await renderBanner({ state: "reconnecting", attempts: 3, nextRetryInMs: 4000 });
    expect(screen.getByTestId("klipper-banner-reconnecting")).toBeTruthy();
    expect(screen.getByText(/attempt 3/)).toBeTruthy();
    expect(screen.getByText(/next try in 4s/)).toBeTruthy();
  });

  it("renders failed state with a Reconnect button that calls retry_connection", async () => {
    const user = userEvent.setup();
    await renderBanner({ state: "failed", attempts: 6, lastError: "ECONNREFUSED 127.0.0.1:7125" });
    expect(screen.getByTestId("klipper-banner-failed")).toBeTruthy();
    expect(screen.getByText(/Printer is unreachable/)).toBeTruthy();
    expect(screen.getByText(/ECONNREFUSED 127.0.0.1:7125/)).toBeTruthy();
    const btn = screen.getByTestId("klipper-banner-reconnect");
    expect(btn.tagName).toBe("BUTTON");
    // Tap target floor (≥44px) — JSDOM doesn't compute layout, so we
    // assert via the inline style.
    expect(btn.getAttribute("style")).toMatch(/min-height:\s*44px/);
    await user.click(btn);
    expect(getAction("retry_connection")).toHaveBeenCalledTimes(1);
  });
});

// ── Active print ─────────────────────────────────────────────────────────
describe("ActivePrint (§6.4 §4)", () => {
  async function renderActive(snapshot: MoonrakerStatusSnapshot | null) {
    const { ActivePrint } = await import("../../src/ui/ActivePrint.js");
    return render(<ActivePrint status={snapshot} />);
  }

  function statusFromStats(
    stats: Record<string, unknown>,
    extras: Partial<Record<"extruder" | "heater_bed" | "virtual_sdcard" | "display_status", Record<string, unknown>>> = {},
  ): MoonrakerStatusSnapshot {
    return {
      objects: {
        print_stats: stats,
        extruder: extras.extruder ?? {},
        heater_bed: extras.heater_bed ?? {},
        virtual_sdcard: extras.virtual_sdcard ?? {},
        display_status: extras.display_status ?? {},
      },
      updatedAt: new Date().toISOString(),
      connection: { state: "connected", attempts: 0 },
    };
  }

  it("renders the empty state in standby", async () => {
    await renderActive(statusFromStats({ state: "standby" }));
    expect(screen.getByTestId("klipper-active-empty").textContent).toMatch(/No active print/);
  });

  it("renders progress, layers, ETA, and temps while printing", async () => {
    await renderActive(
      statusFromStats(
        { state: "printing", filename: "big.gcode", print_duration: 60 * 30, info: { current_layer: 50, total_layer: 100 } },
        {
          extruder: { temperature: 199.7, target: 210 },
          heater_bed: { temperature: 60, target: 60 },
          virtual_sdcard: { progress: 0.5 },
          display_status: { message: "Cooling" },
        },
      ),
    );
    expect(screen.getByTestId("klipper-active-filename").textContent).toMatch(/big\.gcode/);
    expect(screen.getByTestId("klipper-active-percent").textContent).toBe("50%");
    const eta = screen.getByTestId("klipper-active-layers-eta").textContent ?? "";
    expect(eta).toMatch(/Layer 50 of 100/);
    expect(eta).toMatch(/Elapsed 30m/);
    expect(eta).toMatch(/ETA 30m/);
    // Numeric % is alongside the bar — colour-independence (WCAG).
    expect(screen.getByTestId("klipper-active-progress").getAttribute("aria-valuenow")).toBe("50");
    // display_status.message rendered as a quiet helper.
    expect(screen.getByTestId("klipper-active-display-message").textContent).toBe("Cooling");
    // Temp pairs (KeyValueList values render as "200 °C / 210 °C").
    const hot = screen.getByTestId("sdk-keyvalue-Hotend").textContent ?? "";
    expect(hot).toMatch(/200 °C \/ 210 °C/);
  });

  it("Pause button calls pause_print", async () => {
    const user = userEvent.setup();
    await renderActive(
      statusFromStats(
        { state: "printing", filename: "x.gcode", print_duration: 100 },
        { virtual_sdcard: { progress: 0.1 } },
      ),
    );
    await user.click(screen.getByTestId("klipper-active-pause"));
    expect(getAction("pause_print")).toHaveBeenCalledTimes(1);
  });

  it("Pause button label flips to Resume when paused", async () => {
    await renderActive(
      statusFromStats(
        { state: "paused", filename: "x.gcode", print_duration: 100 },
        { virtual_sdcard: { progress: 0.1 } },
      ),
    );
    expect(screen.getByTestId("klipper-active-pause").textContent).toMatch(/Resume/);
  });

  it("Cancel confirms before calling cancel_print and skips when declined", async () => {
    const user = userEvent.setup();
    await renderActive(
      statusFromStats(
        { state: "printing", filename: "y.gcode", print_duration: 100 },
        { virtual_sdcard: { progress: 0.1 } },
      ),
    );
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByTestId("klipper-active-cancel"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(getAction("cancel_print")).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByTestId("klipper-active-cancel"));
    expect(getAction("cancel_print")).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("renders error state with a Dismiss action when state === 'error'", async () => {
    const user = userEvent.setup();
    await renderActive(
      statusFromStats(
        { state: "error", state_message: "Thermal runaway", filename: "fail.gcode" },
        { display_status: { message: "Heater fault" } },
      ),
    );
    expect(screen.getByTestId("klipper-active-error")).toBeTruthy();
    expect(screen.getByText(/Print error: Heater fault/)).toBeTruthy();
    await user.click(screen.getByTestId("klipper-active-error-dismiss"));
    expect(getAction("cancel_print")).toHaveBeenCalledTimes(1);
  });
});

// ── File list + detail view ──────────────────────────────────────────────
describe("FileList + FileDetail (§6.4 §2 + §3, against MockMoonraker fixture)", () => {
  let mock: MockMoonraker;
  let client: MoonrakerClient;
  let fixtureFiles: FileListEntry[];
  let fixtureMetadata: FileMetadata;

  beforeAll(async () => {
    mock = new MockMoonraker({
      files: [
        { path: "alpha.gcode", size: 256 * 1024, modified: 1779000000 },
        { path: "queue/beta.gcode", size: 1.2 * 1024 * 1024, modified: 1779100000 },
      ],
      metadata: {
        "alpha.gcode": {
          filename: "alpha.gcode",
          size: 256 * 1024,
          estimated_time: 3600,
          filament_total: 4200,
          modified: 1779000000,
          thumbnails: [
            { width: 32, height: 32, size: 4, data: "AAAA" },
            { width: 240, height: 240, size: 16, data: "BBBB" },
          ],
        },
      },
    });
    await mock.start();
    const harness = createTestHarness({
      manifest,
      capabilities: [
        "http.outbound",
        "secrets.read-ref",
        "agent.tools.register",
        "events.subscribe",
        "events.emit",
      ],
      config: { moonrakerBaseUrl: mock.baseUrl() },
    });
    client = new MoonrakerClient({
      baseUrl: mock.baseUrl(),
      http: harness.ctx.http,
      secrets: harness.ctx.secrets,
      logger: harness.ctx.logger,
    });
    fixtureFiles = await client.listFiles("gcodes");
    fixtureMetadata = await client.getFileMetadata("alpha.gcode");
  });

  afterAll(async () => {
    await mock.stop();
  });

  async function renderList(onSelect = vi.fn()) {
    const { FileList } = await import("../../src/ui/FileList.js");
    setDataMap({ file_metadata: { data: fixtureMetadata } });
    render(<FileList files={fixtureFiles} loading={false} error={null} onSelect={onSelect} />);
    return onSelect;
  }

  it("lists files newest-first with size + relative-time subline", async () => {
    await renderList();
    expect(screen.getByTestId("klipper-files")).toBeTruthy();
    const rows = screen.getAllByRole("button");
    // Beta is the newer modified value → it must appear first.
    expect(rows[0].getAttribute("aria-label")).toMatch(/beta\.gcode/);
    expect(rows[1].getAttribute("aria-label")).toMatch(/alpha\.gcode/);
  });

  it("renders the loading skeleton when files are null and loading", async () => {
    const { FileList } = await import("../../src/ui/FileList.js");
    setDataMap({});
    render(<FileList files={null} loading={true} error={null} onSelect={vi.fn()} />);
    expect(screen.getByTestId("klipper-files-loading")).toBeTruthy();
    expect(screen.getAllByTestId("klipper-files-skeleton-row")).toHaveLength(3);
  });

  it("renders an empty state with the upload hint when files are []", async () => {
    const { FileList } = await import("../../src/ui/FileList.js");
    setDataMap({ file_metadata: { data: null } });
    render(<FileList files={[]} loading={false} error={null} onSelect={vi.fn()} />);
    expect(screen.getByTestId("klipper-files-empty")).toBeTruthy();
    expect(screen.getByText(/klipper\.upload_gcode/)).toBeTruthy();
  });

  it("renders an error state with a Retry button", async () => {
    const { FileList } = await import("../../src/ui/FileList.js");
    const retry = vi.fn();
    setDataMap({});
    render(<FileList files={null} loading={false} error={{ message: "boom" }} onRetry={retry} onSelect={vi.fn()} />);
    expect(screen.getByTestId("klipper-files-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("klipper-files-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("clicking a row opens the detail view via onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = await renderList();
    await user.click(screen.getByRole("button", { name: /alpha\.gcode/i }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const arg = onSelect.mock.calls[0][0] as FileListEntry;
    expect(arg.path).toBe("alpha.gcode");
  });

  it("FileDetail renders KeyValueList from MockMoonraker metadata", async () => {
    const { FileDetail } = await import("../../src/ui/FileDetail.js");
    setDataMap({ file_metadata: { data: fixtureMetadata } });
    render(<FileDetail file={fixtureFiles.find((f) => f.path === "alpha.gcode")!} onBack={vi.fn()} />);
    expect(screen.getByTestId("klipper-detail-title").textContent).toMatch(/alpha\.gcode/);
    const meta = screen.getByTestId("klipper-detail-metadata");
    expect(meta.textContent).toMatch(/Size/);
    expect(meta.textContent).toMatch(/Est\. print time/);
    expect(meta.textContent).toMatch(/Filament/);
    // Inline base64 thumbnail rendered as data URL (no `ctx.assets`).
    const img = screen.getByTestId("klipper-thumb-image") as HTMLImageElement;
    expect(img.src.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("Start print calls start_print with { filename }", async () => {
    const user = userEvent.setup();
    const { FileDetail } = await import("../../src/ui/FileDetail.js");
    setDataMap({ file_metadata: { data: fixtureMetadata } });
    const onBack = vi.fn();
    render(<FileDetail file={fixtureFiles.find((f) => f.path === "alpha.gcode")!} onBack={onBack} />);
    await user.click(screen.getByTestId("klipper-detail-start"));
    expect(getAction("start_print")).toHaveBeenCalledWith({ filename: "alpha.gcode" });
    // On success the panel returns to the queue.
    expect(onBack).toHaveBeenCalled();
  });

  it("Delete confirms then calls delete_file with { path, root: 'gcodes' }", async () => {
    const user = userEvent.setup();
    const { FileDetail } = await import("../../src/ui/FileDetail.js");
    setDataMap({ file_metadata: { data: fixtureMetadata } });
    const onBack = vi.fn();
    const onChanged = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <FileDetail
        file={fixtureFiles.find((f) => f.path === "alpha.gcode")!}
        onBack={onBack}
        onFilesChanged={onChanged}
      />,
    );
    await user.click(screen.getByTestId("klipper-detail-delete"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(getAction("delete_file")).toHaveBeenCalledWith({ path: "alpha.gcode", root: "gcodes" });
    expect(onBack).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("Back button triggers onBack", async () => {
    const user = userEvent.setup();
    const { FileDetail } = await import("../../src/ui/FileDetail.js");
    setDataMap({ file_metadata: { data: fixtureMetadata } });
    const onBack = vi.fn();
    render(<FileDetail file={fixtureFiles[0]} onBack={onBack} />);
    await user.click(screen.getByTestId("klipper-detail-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
