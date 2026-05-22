// @vitest-environment jsdom
/**
 * UI interaction tests for the Klipper page (PLA-480 / §6.4 rev-4).
 *
 * Covers all five sections per AC §5 (rev-4):
 *   §1 ConnectionBanner — connected / connecting / reconnecting / failed / unconfigured
 *   §2 ActivePrint — empty + idle CTA / printing / paused / error / cancel-confirm
 *   §3 FileList — list / loading / empty / error+retry / inline Start per row
 *   §4 UploadAffordance — idle / selected / validation-error / uploading / success / failure
 *   §5 LastCompletedJob — hidden during printing; visible + collapsible after
 *
 * Data shapes feed in from the PLA-475 MockMoonraker fixture (where the
 * worker contract matters); SDK hooks are mocked so the component tree
 * never touches the bridge transport (host runtime, not present in vitest).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../src/manifest.js";
import type {
  ConnectionStateSnapshot,
  FileListEntry,
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

function makeDataResult<T>(data: T | null, opts: Partial<{ loading: boolean; error: { message: string; code?: string } | null }> = {}) {
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
  error?: { message: string; code?: string } | null;
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

const PAGE_CONTEXT = {
  companyId: null,
  companyPrefix: null,
  projectId: null,
  entityId: null,
  entityType: null,
  userId: null,
};

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

// ── Page orchestrator ────────────────────────────────────────────────────
describe("Page orchestrator (PLA-480 §6.4 rev-4)", () => {
  it("renders all five sections wired to the right RPC keys", async () => {
    const conn: ConnectionStateSnapshot = { state: "connected", attempts: 0 };
    const status: MoonrakerStatusSnapshot = {
      objects: {
        print_stats: { state: "standby" },
        extruder: {},
        heater_bed: {},
        virtual_sdcard: {},
        display_status: {},
      },
      updatedAt: new Date().toISOString(),
      connection: conn,
    };
    const files: FileListEntry[] = [
      { path: "benchy.gcode", size: 1024 * 1024, modified: Date.now() / 1000 - 60 },
    ];
    setDataMap({ status: { data: status }, files: { data: files } });

    const { Page } = await import("../../src/ui/index.js");
    render(<Page context={PAGE_CONTEXT} />);

    // §1 banner hidden in `connected` state.
    expect(screen.queryByTestId("klipper-banner-failed")).toBeNull();
    expect(screen.queryByTestId("klipper-banner-connecting")).toBeNull();
    // §3 file list shows the row.
    expect(screen.getByTestId("klipper-files")).toBeTruthy();
    expect(screen.getByText("benchy.gcode")).toBeTruthy();
    // §2 idle empty-state with the Start-a-print CTA pointing at §3.
    expect(screen.getByTestId("klipper-active-empty")).toBeTruthy();
    expect(screen.getByTestId("klipper-active-empty-cta")).toBeTruthy();
    // §4 upload affordance.
    expect(screen.getByTestId("klipper-upload")).toBeTruthy();
    // §5 hidden when state is standby (no completion to surface yet).
    expect(screen.queryByTestId("klipper-last-completed")).toBeNull();

    // Stream subscribed to the documented channel.
    expect(streamFn).toHaveBeenCalledWith("klipper");
    const keysSeen = dataFn.mock.calls.map((c) => c[0]);
    expect(keysSeen).toContain("status");
    expect(keysSeen).toContain("files");
  });

  it("promotes the active print panel above the queue while printing", async () => {
    const printingStatus: MoonrakerStatusSnapshot = {
      objects: {
        print_stats: { state: "printing", filename: "big.gcode", print_duration: 600, info: { current_layer: 10, total_layer: 100 } },
        extruder: { temperature: 200, target: 210 },
        heater_bed: { temperature: 60, target: 60 },
        virtual_sdcard: { progress: 0.25 },
        display_status: {},
      },
      updatedAt: new Date().toISOString(),
      connection: { state: "connected", attempts: 0 },
    };
    setDataMap({
      status: { data: printingStatus },
      files: { data: [] as FileListEntry[] },
    });

    const { Page } = await import("../../src/ui/index.js");
    const { container } = render(<Page context={PAGE_CONTEXT} />);

    expect(screen.getByTestId("klipper-active")).toBeTruthy();
    expect(screen.getByTestId("klipper-active-percent").textContent).toBe("25%");
    expect(screen.getByTestId("klipper-active-layers-eta").textContent).toMatch(/Layer 10 of 100/);

    // Ordering: active before file list while printing.
    const activeEl = container.querySelector("[data-testid='klipper-active']");
    const filesEl =
      container.querySelector("[data-testid='klipper-files']") ??
      container.querySelector("[data-testid='klipper-files-empty']");
    expect(activeEl).toBeTruthy();
    expect(filesEl).toBeTruthy();
    expect(
      activeEl!.compareDocumentPosition(filesEl!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the full-replace unconfigured card when status.error has code 'unconfigured'", async () => {
    setDataMap({
      status: { data: null, error: { message: "moonrakerBaseUrl is not set", code: "unconfigured" } },
      files: { data: [] as FileListEntry[] },
    });
    const { Page } = await import("../../src/ui/index.js");
    render(<Page context={PAGE_CONTEXT} />);

    expect(screen.getByTestId("klipper-unconfigured")).toBeTruthy();
    const cta = screen.getByTestId("klipper-unconfigured-cta") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    expect(cta.getAttribute("aria-describedby")).toBe("klipper-unconfigured-helper");
    // None of the regular five sections render when we short-circuit.
    expect(screen.queryByTestId("klipper-files")).toBeNull();
    expect(screen.queryByTestId("klipper-upload")).toBeNull();
  });

  it("wraps the page in an ErrorBoundary that contains render crashes", async () => {
    setDataMap({
      status: { data: { objects: null as unknown as Record<string, Record<string, unknown>>, updatedAt: null, connection: { state: "connected", attempts: 0 } } },
      files: { data: [] as FileListEntry[] },
    });
    const { Page } = await import("../../src/ui/index.js");
    expect(() => render(<Page context={PAGE_CONTEXT} />)).not.toThrow();
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
    expect(btn.getAttribute("style")).toMatch(/min-height:\s*44px/);
    await user.click(btn);
    expect(getAction("retry_connection")).toHaveBeenCalledTimes(1);
  });

  it("renders an unconfigured 'set up your printer' inline branch (PLA-502 preferred surface)", async () => {
    // The narrow ConnectionStateSnapshot type doesn't include the future
    // "unconfigured" variant yet (PLA-502 will widen it). Cast through
    // `unknown` so this test pins the UI commitment we'll honour.
    await renderBanner({ state: "unconfigured", attempts: 0 } as unknown as ConnectionStateSnapshot);
    expect(screen.getByTestId("klipper-banner-unconfigured")).toBeTruthy();
    expect(screen.getByText(/Set up your Klipper printer/i)).toBeTruthy();
    expect(screen.getByText(/Add your Moonraker host URL to start using this page/i)).toBeTruthy();
  });
});

// ── Active print ─────────────────────────────────────────────────────────
describe("ActivePrint (§6.4 §2)", () => {
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

  it("renders the empty state with a 'Start a print ↓' CTA in standby", async () => {
    await renderActive(statusFromStats({ state: "standby" }));
    const empty = screen.getByTestId("klipper-active-empty");
    expect(empty.textContent).toMatch(/No active print/);
    expect(screen.getByTestId("klipper-active-empty-cta").textContent).toMatch(/Start a print/);
  });

  it("empty-state CTA focuses the file list's first Start button", async () => {
    const user = userEvent.setup();
    // Provide an anchor and a Start button so the CTA's lookup succeeds.
    const list = document.createElement("section");
    list.id = "klipper-file-list";
    const startBtn = document.createElement("button");
    startBtn.setAttribute("data-testid", "klipper-file-row-start");
    list.appendChild(startBtn);
    document.body.appendChild(list);
    list.scrollIntoView = vi.fn();

    await renderActive(statusFromStats({ state: "complete", filename: "x.gcode", total_duration: 60 }));
    await user.click(screen.getByTestId("klipper-active-empty-cta"));
    expect(list.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(startBtn);

    document.body.removeChild(list);
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
    expect(screen.getByTestId("klipper-active-progress").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByTestId("klipper-active-display-message").textContent).toBe("Cooling");
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

// ── File list (§6.4 §3 — inline Start, no thumbnails) ─────────────────────
describe("FileList (§6.4 §3, against MockMoonraker fixture)", () => {
  let mock: MockMoonraker;
  let client: MoonrakerClient;
  let fixtureFiles: FileListEntry[];

  beforeAll(async () => {
    mock = new MockMoonraker({
      files: [
        { path: "alpha.gcode", size: 256 * 1024, modified: 1779000000 },
        { path: "queue/beta.gcode", size: 1.2 * 1024 * 1024, modified: 1779100000 },
      ],
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
  });

  afterAll(async () => {
    await mock.stop();
  });

  async function renderList(extra: Partial<{ onStarted: () => void; onRetry: () => void }> = {}) {
    const { FileList } = await import("../../src/ui/FileList.js");
    setDataMap({});
    render(<FileList files={fixtureFiles} loading={false} error={null} {...extra} />);
  }

  it("lists files newest-first with size + relative-time subline", async () => {
    await renderList();
    expect(screen.getByTestId("klipper-files")).toBeTruthy();
    // Beta is the newer modified value → it must appear first.
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toMatch(/beta\.gcode/);
    expect(items[1].textContent).toMatch(/alpha\.gcode/);
  });

  it("renders the loading skeleton when files are null and loading", async () => {
    const { FileList } = await import("../../src/ui/FileList.js");
    setDataMap({});
    render(<FileList files={null} loading={true} error={null} />);
    expect(screen.getByTestId("klipper-files-loading")).toBeTruthy();
    expect(screen.getAllByTestId("klipper-files-skeleton-row")).toHaveLength(3);
  });

  it("renders an empty state pointing to the Upload affordance when files are []", async () => {
    const { FileList } = await import("../../src/ui/FileList.js");
    setDataMap({});
    render(<FileList files={[]} loading={false} error={null} />);
    expect(screen.getByTestId("klipper-files-empty")).toBeTruthy();
    expect(screen.getByText(/Upload affordance/)).toBeTruthy();
  });

  it("renders an error state with a Retry button", async () => {
    const { FileList } = await import("../../src/ui/FileList.js");
    const retry = vi.fn();
    setDataMap({});
    render(<FileList files={null} loading={false} error={{ message: "boom" }} onRetry={retry} />);
    expect(screen.getByTestId("klipper-files-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("klipper-files-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("inline Start per row invokes start_print with { filename }", async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    await renderList({ onStarted });
    const startButtons = screen.getAllByTestId("klipper-file-row-start");
    expect(startButtons).toHaveLength(2);
    // Newest-first → button[0] starts beta.gcode.
    await user.click(startButtons[0]);
    expect(getAction("start_print")).toHaveBeenCalledWith({ filename: "queue/beta.gcode" });
    expect(onStarted).toHaveBeenCalled();
  });

  it("inline Start row has the printer-glyph fallback (no thumbnails in v1.0)", async () => {
    await renderList();
    const glyphs = screen.getAllByTestId("klipper-thumb-glyph");
    expect(glyphs.length).toBeGreaterThan(0);
    // No image element rendered — thumbnails deferred to v1.1.
    expect(screen.queryByTestId("klipper-thumb-image")).toBeNull();
  });
});

// ── Upload affordance (§6.4 §4) ──────────────────────────────────────────
describe("UploadAffordance (§6.4 §4)", () => {
  async function renderUpload(onUploaded = vi.fn()) {
    const { UploadAffordance } = await import("../../src/ui/UploadAffordance.js");
    render(<UploadAffordance onUploaded={onUploaded} />);
    return { onUploaded };
  }

  function pickFile(file: File) {
    const input = screen.getByTestId("klipper-upload-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
  }

  it("renders an idle Choose-file CTA + 'No file selected' helper", async () => {
    await renderUpload();
    expect(screen.getByTestId("klipper-upload")).toBeTruthy();
    expect(screen.getByTestId("klipper-upload-pick")).toBeTruthy();
    expect(screen.getByText(/No file selected/)).toBeTruthy();
  });

  it("rejects bad filenames client-side with the manifest regex message", async () => {
    await renderUpload();
    pickFile(new File(["G1"], "weird name.gcode"));
    expect(screen.getByText(/Filename must start with a letter or digit/)).toBeTruthy();
  });

  it("after a valid pick, shows filename + Choose another + Upload", async () => {
    await renderUpload();
    pickFile(new File(["G1 X0\n"], "cube.gcode"));
    expect(screen.getByTestId("klipper-upload-submit")).toBeTruthy();
    expect(screen.getByText(/cube\.gcode/)).toBeTruthy();
  });

  it("Upload calls upload_gcode with {filename, gcodeBase64} and surfaces success", async () => {
    const user = userEvent.setup();
    const { onUploaded } = await renderUpload();
    const file = new File(["G1 X0\n"], "cube.gcode");
    pickFile(file);
    await user.click(screen.getByTestId("klipper-upload-submit"));
    // FileReader is async — wait for the success badge.
    const badge = await screen.findByText(/Uploaded — cube\.gcode/);
    expect(badge).toBeTruthy();
    const call = getAction("upload_gcode").mock.calls[0]?.[0] as {
      filename: string;
      gcodeBase64: string;
    };
    expect(call.filename).toBe("cube.gcode");
    expect(typeof call.gcodeBase64).toBe("string");
    expect(call.gcodeBase64.length).toBeGreaterThan(0);
    // Base64 of "G1 X0\n" is "RzEgWDAK".
    expect(call.gcodeBase64).toBe("RzEgWDAK");
    expect(onUploaded).toHaveBeenCalled();
  });

  it("surfaces upload failures verbatim from PluginBridgeError (no rewording)", async () => {
    const user = userEvent.setup();
    getAction("upload_gcode").mockRejectedValueOnce(
      new Error("auto_upload_artifacts is false; the platform.klipper.config.auto_upload_artifacts config flag must be set to true before uploads are allowed."),
    );
    await renderUpload();
    pickFile(new File(["G1"], "cube.gcode"));
    await user.click(screen.getByTestId("klipper-upload-submit"));
    const err = await screen.findByTestId("klipper-upload-error");
    expect(err.textContent).toMatch(/auto_upload_artifacts is false/);
    expect(screen.getByTestId("klipper-upload-try-again")).toBeTruthy();
  });
});

// ── Last completed job (§6.4 §5) ─────────────────────────────────────────
describe("LastCompletedJob (§6.4 §5)", () => {
  function statusWith(stats: Record<string, unknown>): MoonrakerStatusSnapshot {
    return {
      objects: {
        print_stats: stats,
        extruder: {},
        heater_bed: {},
        virtual_sdcard: {},
        display_status: {},
      },
      updatedAt: new Date().toISOString(),
      connection: { state: "connected", attempts: 0 },
    };
  }

  async function renderFooter(snapshot: MoonrakerStatusSnapshot | null) {
    const { LastCompletedJob } = await import("../../src/ui/LastCompletedJob.js");
    render(<LastCompletedJob status={snapshot} />);
  }

  it("hidden when state is standby / printing / paused", async () => {
    await renderFooter(statusWith({ state: "printing", filename: "x.gcode" }));
    expect(screen.queryByTestId("klipper-last-completed")).toBeNull();
    cleanup();
    await renderFooter(statusWith({ state: "standby" }));
    expect(screen.queryByTestId("klipper-last-completed")).toBeNull();
  });

  it("collapsed footer shows filename + 'finished' on complete", async () => {
    await renderFooter(statusWith({ state: "complete", filename: "cube.gcode", total_duration: 3700 }));
    expect(screen.getByTestId("klipper-last-completed")).toBeTruthy();
    const toggle = screen.getByTestId("klipper-last-completed-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/cube\.gcode/);
    expect(toggle.textContent).toMatch(/finished/);
    // Body hidden in collapsed state.
    expect(screen.queryByTestId("klipper-last-completed-body")).toBeNull();
  });

  it("expanding reveals StatusBadge + total duration", async () => {
    const user = userEvent.setup();
    await renderFooter(statusWith({ state: "complete", filename: "cube.gcode", total_duration: 3700 }));
    const toggle = screen.getByTestId("klipper-last-completed-toggle");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const body = screen.getByTestId("klipper-last-completed-body");
    expect(body.textContent).toMatch(/Finished after 1h 1m/);
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("shows the Failed pill + state_message for error state", async () => {
    const user = userEvent.setup();
    await renderFooter(statusWith({ state: "error", filename: "fail.gcode", state_message: "Thermal runaway" }));
    await user.click(screen.getByTestId("klipper-last-completed-toggle"));
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/Last error: Thermal runaway/)).toBeTruthy();
  });

  it("shows the Cancelled pill on cancelled state", async () => {
    const user = userEvent.setup();
    await renderFooter(statusWith({ state: "cancelled", filename: "abort.gcode", total_duration: 600 }));
    await user.click(screen.getByTestId("klipper-last-completed-toggle"));
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText(/Cancelled after 10m/)).toBeTruthy();
  });
});
