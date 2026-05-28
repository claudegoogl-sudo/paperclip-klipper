import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Paperclip-klipper plugin manifest.
 *
 * Scaffold from PLA-474 (Phase 1.1 / Workstream 6.2). The manifest declares
 * **only** the capabilities required by the spec; any expansion is a separate
 * governance ticket per the plan brief.
 *
 *   - http.outbound          — Moonraker REST API and Moonraker /websocket.
 *                              The host has no separate outbound-WebSocket
 *                              capability today; WS upgrades ride the same
 *                              outbound network grant (HTTP/1.1 Upgrade) and
 *                              the worker enforces the configured Moonraker
 *                              base URL as the only permitted host.
 *   - secrets.read-ref       — resolve the Moonraker API key per call via
 *                              `ctx.secrets.resolve(config.moonrakerApiKeyRef)`.
 *                              The plaintext value is NEVER cached, logged, or
 *                              persisted in plugin state.
 *   - agent.tools.register   — register agent tools (stub bodies at this
 *                              phase; real implementations land in 6.5).
 *   - events.subscribe       — subscribe to host events the worker will react
 *                              to in 6.5. Stub handlers only at this phase.
 *   - ui.page.register        — host-mounted `page` slot at
 *                              `/:companyPrefix/printer`. PLA-473 Q1 resolved
 *                              the nav-surface spike to Option 2 (page slot)
 *                              and PLA-480 / §6.4 lands the real four-section
 *                              UI behind it. The capability count stays at
 *                              five — `ui.dashboardWidget.register` was
 *                              swapped out for `ui.page.register`; no net
 *                              expansion (governance ticket is still required
 *                              for any future additions).
 */
// `__PLUGIN_VERSION__` is substituted at build time from
// `package.json.version` by esbuild's `define` (see `esbuild.config.mjs`).
// PLA-526 made `package.json.version` the single source of truth so the
// installed plugin's reported version cannot drift from the package version.
const manifest: PaperclipPluginManifestV1 = {
  id: "platform.klipper",
  apiVersion: 1,
  version: __PLUGIN_VERSION__,
  displayName: "Klipper",
  description:
    "Paperclip plugin for Klipper / Moonraker 3D printers. Lets agents " +
    "inspect printer state, upload G-code, and (opt-in) initiate prints " +
    "through the Moonraker API.",
  author: "Platform",
  categories: ["connector"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "events.subscribe",
    "ui.page.register",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },

  // Persistent per-instance configuration. Validated by the host before
  // being passed to the worker via `ctx.config.get()`.
  //   - moonrakerBaseUrl: full base URL (e.g. https://printer.lan) — the
  //     worker scopes ALL outbound HTTP and WebSocket traffic to this host.
  //   - moonrakerApiKeyRef: secret reference (UUID/name) for the Moonraker
  //     API key. format:'secret-ref' tells the host to resolve via the
  //     secret provider; plaintext is rejected. Optional — public Moonraker
  //     instances can omit the key.
  //   - auto_upload_artifacts: when true, the worker may auto-upload
  //     produced G-code artifacts to the printer. Default off so the
  //     installed plugin is inert until the operator opts in (6.5 will
  //     gate the upload tool on this flag).
  //   - allow_agent_initiated_print: when true, the print-start tool is
  //     callable by agents without per-call human confirmation. Default
  //     off — gates a high-blast-radius action behind explicit opt-in.
  // `additionalProperties: false` makes unknown config keys fail-closed at
  // host load time (mirrors paperclip-plugin-cad's PLA-74 F3 fix).
  instanceConfigSchema: {
    type: "object",
    properties: {
      moonrakerBaseUrl: {
        type: "string",
        format: "uri",
        description:
          "Moonraker base URL (e.g. https://printer.lan). All outbound HTTP " +
          "and WebSocket traffic from this plugin is restricted to this host.",
      },
      moonrakerApiKeyRef: {
        type: "string",
        format: "secret-ref",
        description:
          "Paperclip secret reference for the Moonraker API key. Resolved " +
          "per call via ctx.secrets.resolve; never stored in plaintext. " +
          "Omit for unauthenticated Moonraker instances.",
      },
      auto_upload_artifacts: {
        type: "boolean",
        default: false,
        description:
          "When true, the plugin may auto-upload G-code artifacts produced " +
          "by agents to the printer. Defaults to false (opt-in).",
      },
      allow_agent_initiated_print: {
        type: "boolean",
        default: false,
        description:
          "When true, agents may start prints via the print-start tool " +
          "without per-call human confirmation. Defaults to false (opt-in).",
      },
    },
    required: ["moonrakerBaseUrl"],
    additionalProperties: false,
  },

  // Agent tools — stubs only at this phase. Real implementations land in
  // PLA-475 (worker) and 6.5 (tool surface). The names and parameter
  // schemas are sketched here so the manifest declaration is stable; the
  // 6.5 ticket may refine schemas before the first usable release.
  tools: [
    {
      name: "klipper.get_printer_status",
      displayName: "Klipper Get Printer Status",
      description:
        "Stub — returns Moonraker printer status (state, temperatures, " +
        "active job). Real implementation lands in 6.5.",
      parametersSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "klipper.upload_gcode",
      displayName: "Klipper Upload G-code",
      description:
        "Upload a G-code artifact to the printer's virtual_sdcard. The worker " +
        "resolves `artifactId` via `runCtx.artifacts.fetch` and streams the " +
        "bytes straight to Moonraker — callers never base64-encode the " +
        "payload through tool arguments. Gated on auto_upload_artifacts.",
      parametersSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.gcode$",
          },
          artifactId: {
            type: "string",
            format: "uuid",
            description:
              "Paperclip attachment UUID to upload. Resolved server-side via " +
              "the dispatching agent's identity (PLA-574); the plugin worker " +
              "never sees the bytes inline.",
          },
          path: {
            type: "string",
            // PLA-615: allowlist a relative virtual_sdcard subdirectory — 1-4
            // '/'-separated segments of [A-Za-z0-9._-], each starting
            // alphanumeric. Structurally rejects a leading '/', '..'/'.'
            // segments, backslashes and NUL so a caller cannot traverse out of
            // the gcodes root. The worker re-validates (defense-in-depth).
            pattern:
              "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$",
            description:
              "Optional virtual_sdcard subdirectory. Relative path of 1-4 " +
              "segments (no leading '/', no '..'); e.g. \"prints\" or " +
              "\"prints/today\".",
          },
        },
        required: ["filename", "artifactId"],
        additionalProperties: false,
      },
    },
    {
      name: "klipper.start_print",
      displayName: "Klipper Start Print",
      description:
        "Stub — start a print of a previously uploaded G-code file. Real " +
        "implementation lands in 6.5. Gated on allow_agent_initiated_print.",
      parametersSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.gcode$",
            description: "G-code filename to print (must already be uploaded).",
          },
        },
        required: ["filename"],
        additionalProperties: false,
      },
    },
  ],

  // UI slots — PLA-473 Q1 resolved to Option 2 (a host-mounted `page` slot
  // at `/:companyPrefix/printer`). The four-section UI (connection banner,
  // recent uploads, file detail, active print) is implemented behind the
  // `Page` export in `src/ui/index.tsx` per PLA-480 / §6.4.
  //
  // routePath is the company-scoped segment — the host resolves it to
  // `/:companyPrefix/printer` (e.g. `/PLA/printer`).
  ui: {
    slots: [
      {
        type: "page",
        id: "klipper-page",
        displayName: "Printer",
        exportName: "Page",
        routePath: "printer",
      },
    ],
  },
};

export default manifest;
