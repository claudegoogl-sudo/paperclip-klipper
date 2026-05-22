// @vitest-environment jsdom
/**
 * PLA-502/503 — page slot renders a needs-config placeholder when the
 * worker reports `configured: false`. Mirrors the CAD plugin pattern of
 * keeping the page mounted while config is missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const dataFn = vi.fn();
const streamFn = vi.fn();
const actionFn = vi.fn().mockResolvedValue({ ok: true });
const toastFn = vi.fn();

function makeDataResult<T>(data: T | null) {
  return {
    data,
    loading: false,
    error: null,
    refresh: () => Promise.resolve(),
  };
}

function makeStreamResult() {
  return { latest: null, error: null };
}

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: (...args: unknown[]) => dataFn(...args),
  usePluginAction: () => actionFn,
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

beforeEach(() => {
  dataFn.mockReset();
  streamFn.mockReset();
  streamFn.mockImplementation(() => makeStreamResult());
});

afterEach(() => {
  cleanup();
});

describe("Klipper page — needs-config placeholder (PLA-502/503)", () => {
  it("renders the needs-config placeholder when configured=false", async () => {
    dataFn.mockImplementation((key: string) => {
      if (key === "config") {
        return makeDataResult({ configured: false, moonrakerBaseUrl: null });
      }
      return makeDataResult(null);
    });

    const { Page } = await import("../../src/ui/index.js");
    render(
      <Page
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

    expect(screen.getByTestId("klipper-page-needs-config")).toBeTruthy();
    expect(screen.getByText("Configure Moonraker")).toBeTruthy();
    // The normal page surface must NOT render alongside the placeholder.
    expect(screen.queryByTestId("klipper-page")).toBeNull();
  });

  it("does NOT render the placeholder when configured=true", async () => {
    dataFn.mockImplementation((key: string) => {
      if (key === "config") {
        return makeDataResult({
          configured: true,
          moonrakerBaseUrl: "http://printer.lan",
        });
      }
      if (key === "status") {
        return makeDataResult({
          objects: {
            print_stats: { state: "standby" },
            extruder: {},
            heater_bed: {},
            virtual_sdcard: {},
            display_status: {},
          },
          updatedAt: new Date().toISOString(),
          connection: { state: "connected", attempts: 0 },
        });
      }
      return makeDataResult(null);
    });

    const { Page } = await import("../../src/ui/index.js");
    render(
      <Page
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

    expect(screen.queryByTestId("klipper-page-needs-config")).toBeNull();
    expect(screen.getByTestId("klipper-page")).toBeTruthy();
  });

  it("does NOT render the placeholder while config is still loading", async () => {
    // Loading state: data is null but configured hasn't resolved yet.
    // The page should NOT pre-emptively show the placeholder.
    dataFn.mockImplementation(() => makeDataResult(null));

    const { Page } = await import("../../src/ui/index.js");
    render(
      <Page
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

    expect(screen.queryByTestId("klipper-page-needs-config")).toBeNull();
  });
});
