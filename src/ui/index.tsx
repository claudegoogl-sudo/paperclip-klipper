/**
 * paperclip-klipper plugin UI — PLA-486 minimal `dashboardWidget` placeholder.
 *
 * The host v1 runtime only supports `dashboardWidget` slots
 * (`PLUGIN_UI_SLOT_TYPES_V1_SUPPORTED`); PLA-485 chose Option A to ship v1.0
 * as a dashboard widget. This export exists solely to satisfy the install
 * validator and the manifest `exportName: "DashboardWidget"`.
 *
 * The original four-section `Page` orchestrator (connection banner, file
 * list, file detail, active print) was scaffolded under PLA-480 for a `page`
 * slot. The component files (`ConnectionBanner.tsx`, `FileList.tsx`,
 * `FileDetail.tsx`, `ActivePrint.tsx`, `components.tsx`, `theme.ts`,
 * `format.ts`) and their tests remain intact — PLA-480 (rescoped under
 * UXDesigner) will reuse them when wiring the real widget UX.
 *
 * Page-flavoured scaffold leftovers noted for PLA-480 to consider:
 *   - `streamChannel.ts` constant + `usePluginStream` subscription wiring
 *     lived inside the old `Page`; the widget can rewire them as needed.
 *   - `usePluginData<MoonrakerStatusSnapshot>("status")` and
 *     `usePluginData<FileListEntry[]>("files")` are still emitted by the
 *     worker RPC surface (PLA-475) and ready to drive the widget content.
 *   - No `usePluginRoute` import existed; nothing to strip there.
 *
 * TODO(PLA-480): Replace this placeholder with the real widget UX —
 *   connection state, last-job summary, and launcher button.
 */
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

/**
 * `DashboardWidget` is the entry component for the manifest's
 * `dashboardWidget` slot (id: `klipper-dashboard-widget`,
 * exportName: `DashboardWidget`).
 */
export function DashboardWidget(_props: PluginWidgetProps) {
  return (
    <div
      data-testid="klipper-dashboard-widget"
      style={{
        padding: "12px 16px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontSize: 14,
        lineHeight: 1.4,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Klipper</div>
      <div style={{ opacity: 0.7 }}>
        Printer widget — full UI lands in PLA-480.
      </div>
    </div>
  );
}
