import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Paperclip-klipper plugin manifest.
 *
 * Initial scaffold (Phase 1.1 / Workstream 6.2). The manifest declares
 * **only** the capabilities required by the spec; any expansion is a separate
 * governance ticket per the plan brief.
 *
 *   - http.outbound          — Moonraker REST API and Moonraker /websocket,
 *                              or the FlashForge Creator 5 LAN-only HTTP API
 *                              (transport=flashforge). The host has no
 *                              separate outbound-WebSocket capability today;
 *                              WS upgrades ride the same outbound network
 *                              grant (HTTP/1.1 Upgrade) and the worker
 *                              enforces the configured printer base URL as
 *                              the only permitted host for the active
 *                              transport.
 *   - secrets.read-ref       — resolve the Moonraker API key (and the
 *                              FlashForge check code) via
 *                              `ctx.secrets.resolve(...)`. Resolution happens
 *                              ONCE per config application (boot replay /
 *                              operator save — the host's scoped push) and
 *                              the plaintext is held in worker memory only:
 *                              never logged, never persisted, refreshed at
 *                              every config application.
 *   - agent.tools.register   — register agent tools (stub bodies at this
 *                              phase; real implementations land in 6.5).
 *   - events.subscribe       — subscribe to host events the worker will react
 *                              to in 6.5. Stub handlers only at this phase.
 *   - ui.page.register        — host-mounted `page` slot at
 *                              `/:companyPrefix/printer`. The nav-surface
 *                              spike resolved to Option 2 (page slot) and
 *                              §6.4 lands the real four-section UI behind
 *                              it. The capability count stays at
 *                              five — `ui.dashboardWidget.register` was
 *                              swapped out for `ui.page.register`; no net
 *                              expansion (governance ticket is still required
 *                              for any future additions).
 */
// `__PLUGIN_VERSION__` is substituted at build time from
// `package.json.version` by esbuild's `define` (see `esbuild.config.mjs`).
// Using `package.json.version` as the single source of truth means the
// installed plugin's reported version cannot drift from the package version.

/**
 * JSON-Schema branch for the object-shaped secret binding ref accepted by
 * current host generations: `{ type: "secret_ref", secretId, version? }`.
 * Kept in lockstep with the server's binding parser (secretId is a UUID;
 * version is "latest" or a positive integer; absent collapses to "latest";
 * unknown keys rejected so a typo like `secretID` fails at save time, not
 * at first resolve). `secret-ref` secret paths keep a string branch (with
 * `format: "secret-ref"`) because hosts detect bindable config paths by
 * that format marker and reject legacy bare-UUID string VALUES there with
 * an explicit 422 — while non-secret string refs (names) from older
 * configs still validate and resolve the way they always did.
 *
 * IMPORTANT: `format: "secret-ref"` is therefore repeated on the property
 * ITSELF (not only inside a branch) — the host's path walker reads format
 * directly off each property schema and never consults branch formats for
 * path detection.
 */
const SECRET_REF_OBJECT_SCHEMA = {
  type: "object",
  properties: {
    type: { enum: ["secret_ref"] },
    secretId: {
      type: "string",
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    },
    version: {
      anyOf: [{ enum: ["latest"] }, { type: "integer", minimum: 1 }],
    },
  },
  required: ["type", "secretId"],
  additionalProperties: false,
} as const;

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
  //   - moonrakerApiKeyRef / flashforgeCheckCodeRef: secret references for
  //     the Moonraker API key and the FlashForge check code. Accepted as the
  //     legacy string ref or the object binding ref
  //     { type: "secret_ref", secretId, version? } — current hosts persist
  //     the object shape as a company-scoped binding at config-save time;
  //     the worker resolves the configured ref once per config application
  //     and keeps the plaintext in memory only — it never reaches config,
  //     state, or logs. Optional per transport.
  //   - auto_upload_artifacts: when true, the worker may auto-upload
  //     produced G-code artifacts to the printer. Default off so the
  //     installed plugin is inert until the operator opts in (6.5 will
  //     gate the upload tool on this flag).
  //   - allow_agent_initiated_print: when true, the print-start tool is
  //     callable by agents without per-call human confirmation. Default
  //     off — gates a high-blast-radius action behind explicit opt-in.
  // `additionalProperties: false` makes unknown config keys fail-closed at
  // host load time (mirrors a fix applied in paperclip-plugin-cad).
  instanceConfigSchema: {
    type: "object",
    properties: {
      transport: {
        type: "string",
        enum: ["moonraker", "flashforge"],
        description:
          "Printer transport. Absent/unset behaves exactly like " +
          "\"moonraker\" (the historical behavior). \"flashforge\" drives " +
          "FlashForge-firmware printers (Creator 5 / Creator 5 Pro) through " +
          "their LAN-only HTTP API and requires the flashforge* config keys " +
          "(flashforgeBaseUrl, flashforgeSerialNumber, " +
          "flashforgeCheckCodeRef); incomplete flashforge config fails closed " +
          "at load with a clear validation error — it never falls back to " +
          "moonraker. Any other value is rejected by this enum.",
      },
      moonrakerBaseUrl: {
        type: "string",
        format: "uri",
        description:
          "Moonraker base URL (e.g. https://printer.lan). All outbound HTTP " +
          "and WebSocket traffic from this plugin is restricted to this host. " +
          "Rejected at worker setup (fail closed) if it does not parse as " +
          "http(s) or its host is not in moonrakerAllowedHosts.",
      },
      moonrakerAllowedHosts: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description:
          "Optional host allowlist for moonrakerBaseUrl. Defaults to the " +
          "single host parsed out of moonrakerBaseUrl itself, so most " +
          "operators never need to set this. Set explicitly to pin the " +
          "plugin to a specific host regardless of what moonrakerBaseUrl " +
          "later resolves to.",
      },
      moonrakerApiKeyRef: {
        // `format` stays on the PROPERTY itself: hosts detect bindable
        // secret paths (and the settings-UI secret picker) by reading
        // `format` directly off the property schema — a format hidden
        // inside a oneOf branch is invisible to that walk.
        format: "secret-ref",
        oneOf: [
          { type: "string" },
          SECRET_REF_OBJECT_SCHEMA,
        ],
        description:
          "Paperclip secret reference for the Moonraker API key. Two " +
          "accepted shapes: the legacy string ref kept for backward " +
          "compatibility, or the binding object { type: \"secret_ref\", " +
          "secretId, version? } that current hosts persist as a " +
          "company-scoped binding when this config is saved (the object " +
          "shape is what the host settings UI submits). Either shape is " +
          "resolved by the worker once per config application (boot replay " +
          "or operator save) and held in worker memory only — never stored " +
          "or logged; a rotation takes effect at the next config save or " +
          "worker restart. A missing/unresolvable ref refuses the transport " +
          "at load (fail closed). Omit for unauthenticated Moonraker " +
          "instances.",
      },
      flashforgeBaseUrl: {
        type: "string",
        format: "uri",
        description:
          "FlashForge printer base URL (e.g. http://192.168.1.50:8898). " +
          "Port 8898 is applied when omitted; URLs embedding credentials " +
          "(userinfo) are rejected. Required when transport is " +
          "\"flashforge\"; all FlashForge traffic is restricted to this host.",
      },
      flashforgeAllowedHosts: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description:
          "Optional host allowlist for flashforgeBaseUrl (mirrors " +
          "moonrakerAllowedHosts). Defaults to the single host parsed out " +
          "of flashforgeBaseUrl itself.",
      },
      flashforgeSerialNumber: {
        type: "string",
        minLength: 1,
        description:
          "Printer serial number — the Device ID the Creator 5 LAN-only " +
          "mode exposes in its network settings. An identifier, not a " +
          "credential; sent with every FlashForge request.",
      },
      flashforgeCheckCodeRef: {
        // See moonrakerApiKeyRef: `format` must sit on the property itself.
        format: "secret-ref",
        oneOf: [
          { type: "string" },
          SECRET_REF_OBJECT_SCHEMA,
        ],
        description:
          "Paperclip secret reference for the per-printer check code " +
          "(the LAN-mode credential shown next to the Device ID). Two " +
          "accepted shapes: the legacy string ref kept for backward " +
          "compatibility, or the binding object { type: \"secret_ref\", " +
          "secretId, version? } that current hosts persist as a " +
          "company-scoped binding when this config is saved (the object " +
          "shape is what the host settings UI submits). Either shape is " +
          "resolved by the worker once per config application (boot replay " +
          "or operator save) and held in worker memory only — never stored " +
          "or logged; a rotation takes effect at the next config save or " +
          "worker restart. A missing/unresolvable ref refuses the transport " +
          "at load (fail closed).",
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
    // Per-transport required keys are enforced fail-closed by the worker at
    // config-apply time (moonrakerBaseUrl for the moonraker transport;
    // flashforgeBaseUrl + flashforgeSerialNumber + flashforgeCheckCodeRef
    // for flashforge) because a static `required` list here would force
    // flashforge-only companies to also set moonrakerBaseUrl.
    required: [],
    additionalProperties: false,
  },

  // Agent tools — stubs only at this phase. Real implementations land in
  // a later phase (worker) and 6.5 (tool surface). The names and parameter
  // schemas are sketched here so the manifest declaration is stable; the
  // 6.5 ticket may refine schemas before the first usable release.
  tools: [
    {
      name: "klipper.get_printer_status",
      displayName: "Klipper Get Printer Status",
      description:
        "Returns the latest printer status snapshot (state, temperatures, " +
        "active job) from the configured transport — Moonraker or the " +
        "FlashForge LAN-only HTTP API.",
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
              "the dispatching agent's identity; the plugin worker " +
              "never sees the bytes inline.",
          },
          path: {
            type: "string",
            // Allowlist a relative virtual_sdcard subdirectory — 1-4
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

  // UI slots — resolved to Option 2 (a host-mounted `page` slot
  // at `/:companyPrefix/printer`). The four-section UI (connection banner,
  // recent uploads, file detail, active print) is implemented behind the
  // `Page` export in `src/ui/index.tsx` (see §6.4).
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
