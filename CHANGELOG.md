# Changelog

All notable changes to `@platform/paperclip-klipper` are recorded here. The
plugin follows semver against the host plugin API (PLA-526 keeps
`package.json.version` and the manifest version in lockstep via the build
`define`).

## 0.2.2 — 2026-09-23

### Added
- **Object-shaped secret-ref support on the config bind path.** Current host
  generations bind plugin config secrets as
  `{ type: "secret_ref", secretId, version? }`: the per-tenant
  config-overrides route validates the object shape against the manifest
  schema, persists it as a company-scoped binding at save time, and the
  worker-side `secrets.resolve` refuses STRING refs outright. With the 0.2.1
  manifest (string-only `format: "secret-ref"` fields) no secret could be
  bound at all on those hosts — the object shape was rejected by schema
  validation while the bare-UUID string shape was rejected by the binding
  gate. Both `moonrakerApiKeyRef` and `flashforgeCheckCodeRef` now accept
  **both shapes** via a `oneOf` schema (the `format: "secret-ref"` marker
  stays on the property itself, where the host's bindable-path walk and the
  settings-UI secret picker read it). Legacy string configs stay valid;
  malformed object refs fail at save time with a field error instead of at
  first resolve.

### Changed
- Transport config validation, config fingerprints, and both transports
  (Moonraker + FlashForge) carry either ref shape end to end. Object refs
  are normalized (secretId trimmed, absent version collapsed to
  `"latest"`) before they reach the secrets client; fingerprint identity
  canonicalizes object refs so a re-serialized replay (different key order)
  keeps the live client, while a different secretId or pinned version
  replaces it. Legacy string refs keep their raw value as identity — no
  identity churn for existing configs.

### Security
- Fail-closed posture unchanged: a missing/unresolvable ref still refuses
  the transport with a clear error; resolved values still never touch logs,
  state, or config; the resolved check code still reaches FlashForge request
  bodies/headers exactly as before. Capability list is byte-identical to
  0.2.1 (`http.outbound`, `secrets.read-ref`, `agent.tools.register`,
  `events.subscribe`, `ui.page.register`).

## 0.2.1 — 2026-09-23

### Security (non-blocking findings from the FlashForge transport review)
- **F1 — worker-side `filename` re-validation.** `uploadFilenameError()`
  mirrors the `filename` schema pattern as a runtime backstop (the same
  defense-in-depth `path` already had via `uploadPathError`) and is enforced
  in the `upload_gcode` and `start_print` handlers BEFORE any artifact fetch
  or client call — a bypassed host-side schema validation can no longer push
  a quote, CR/LF, or NUL into the multipart `Content-Disposition` of either
  transport.
- **F2 — printer-controlled error text capped.** The FlashForge envelope
  `message` is sliced to 1024 chars (matching the Moonraker error-body cap)
  before it can reach a ToolResult error string, so a hostile or MITM'd
  printer cannot stuff the agent context window.
- **F3 — userinfo in `flashforgeBaseUrl` rejected.** URLs embedding
  credentials (`http://user:pass@host`) fail closed at config validation
  (`userinfo_not_allowed`) — basic-auth would otherwise ride every request
  and leak into `flashforgeBaseUrl` log lines; the check code belongs in the
  secret-ref.
- Eight regression tests driving the handlers directly (bypassing schema
  validation on purpose) — all red on 0.2.0, green with the fixes.

## 0.2.0 — 2026-09-23

### Added
- **FlashForge printer transport.** New `transport` config key
  (`"moonraker" | "flashforge"`) selects the printer API; unset keeps the
  historical Moonraker behavior exactly. `transport: "flashforge"` drives
  FlashForge-firmware printers (Creator 5 / Creator 5 Pro) through their
  *Network > LAN Only* HTTP API: G-code upload (`POST /uploadGcode`), job and
  printer status (`POST /detail`, polled every 10 s into the same dashboard
  snapshot path), file listing, and operator-initiated print/job control.
  Endpoint shapes derive from the community reference client
  (GhostTypes/ff-5mp-api-py).
- **Fail-closed config validation.** `transport: "flashforge"` requires
  `flashforgeBaseUrl`, `flashforgeSerialNumber` (the Device ID) and
  `flashforgeCheckCodeRef` (secret-ref for the check-code credential, resolved
  per call and never logged). Missing or invalid config stops any live client
  and surfaces a clear validation error — never a crash, never a silent
  fallthrough to moonraker. Unknown `transport` values are rejected the same
  way. The manifest schema enforces the enum; the static `required` list is
  now empty because required keys are per-transport (a flashforge-only company
  must not be forced to set `moonrakerBaseUrl`).
- **Fail-closed health for the FlashForge transport.** `onHealth` probes the
  printer with a fresh `/detail` request and reports `degraded` on refused /
  timeout / 5xx / error-envelope outcomes. Moonraker health semantics are
  unchanged.
- **Outbound scope enforcement for the FlashForge host**, mirroring the
  Moonraker allowlist pattern (`flashforgeAllowedHosts`, strict WHATWG
  host-equality checks, default port 8898 applied when the URL omits one).

### Security
- The agent print gate (`allow_agent_initiated_print`) stays **default-deny**
  for both transports. FlashForge uploads send `printNow: false`
  unconditionally — no upload path can start a print, and
  `auto_upload_artifacts` never weakens the print gate.
- 33 new unit tests against an in-process mock FlashForge HTTP server
  (no physical printer needed): upload wire shape + auth headers, snapshot
  mapping, health fail-closed paths, print-gate refusals, and config
  validation.

## 0.1.11 — 2026-09-16

### Fixed
- **Boot failure on hosts that deliver config via replay.** The host spawns
  plugin workers with an empty bootstrap config and replays each configured
  company's stored row through the `configChanged` RPC right after boot;
  `ctx.config.get()` from `setup()` runs in service scope with no company
  attached and is denied ("company context is required"). The worker
  previously treated that denial as fatal: lifecycle went ready→error and no
  worker process existed at all. The setup-time read is now best-effort — a
  denial means config UNKNOWN, not failure: the worker boots permissive
  (data/actions/tools registered; tools return `prerequisite_missing`) and
  holds `ready` until config lands.
- Added the `onConfigChanged` lifecycle hook (the authoritative config source
  on replay-delivering hosts). The host replay — and every operator config
  save — now applies in-process: it starts the Moonraker client without a
  worker restart, breaking the previous restart→denied-boot→error loop.
  Authorization is never bypassed: a denied read yields unknown config, and
  the opt-in tool gates keep re-reading config per dispatch (fail-closed).
- Replay application is idempotent by connection identity
  (baseUrl + allowedHosts + apiKeyRef): the per-company replay burst at every
  boot converges on one client instead of churning transports. A replay whose
  connection identity changed stops the old client before building the new
  one; a replay that is absent or fails `moonrakerBaseUrl` validation stops
  any live client and degrades back to permissive init — the worker never
  crashes on a bad config.
- `onHealth` now reports `configKnown` and `clientActive` details so a
  replay-pending boot is distinguishable from a configured connection in the
  plugin health dashboard.
- Event subscriptions (`issue.created`) are registered once per worker
  lifetime rather than only on the configured path, so replay bursts cannot
  stack duplicate handlers and an unconfigured worker still observes events.

## 0.1.8 — 2026-05-28 (PLA-615)

### Security
- `klipper.upload_gcode` now allowlists the optional `path` (virtual_sdcard
  subdirectory) parameter against a `pattern` in both the manifest and the
  worker-registered schema: 1-4 `/`-separated segments of `[A-Za-z0-9._-]`,
  each starting alphanumeric. This structurally rejects a leading `/`,
  `..`/`.` segments, backslashes and NUL so a caller cannot traverse out of
  the gcodes root (defense-in-depth against path traversal / OWASP A01 into
  Moonraker's `virtual_sdcard`).
- The worker re-validates `path` at runtime (`uploadPathError`) **before** the
  artifact fetch or upload and **rejects** — never sanitizes — an unsafe value
  with a structured `ToolResult` error, so a missed/bypassed host schema check
  still cannot forward a traversal sequence into Moonraker's upload `path`
  form field. Rejections are logged at `warn`
  (`klipper.upload_gcode.path_rejected`) with the reason for observability.

### Notes
- Pre-existing hardening surfaced during the v0.1.7 / PLA-612 security review
  (PLA-614); it did **not** block the v0.1.7 install. Gated behind
  `auto_upload_artifacts` and an identity-scoped `artifactId`.
- Whether the target Moonraker build also normalizes/rejects `..` in the upload
  `path` field is unverified against a live printer — the schema allowlist is
  belt-and-suspenders regardless. Re-review by SecurityEngineer (PLA-614)
  requested once schema + tests landed.

### References
- [PLA-615](../paperclipai/issues/PLA-615) — this hardening.
- [PLA-614](../paperclipai/issues/PLA-614) — v0.1.7 security sign-off that
  surfaced the finding.
- [PLA-612](../paperclipai/issues/PLA-612) — v0.1.7 gunzip change reviewed.

## 0.1.7 — 2026-05-28 (PLA-612)

### Fixed
- `klipper.upload_gcode` now transparently gunzips gzip-magic (`0x1f 0x8b`)
  artifacts before handing the bytes to `MoonrakerClient.uploadGcode`. Real
  prints exceed the 10 MB issue-attachment store ceiling, so only the gzipped
  artifact fits the store (DPR-130: 3.0 MB gz → 14.24 MB raw); the v0.1.6
  worker streamed those still-gzipped bytes to Moonraker, which are unprintable.
  Plain (non-gzip) artifacts pass through byte-for-byte unchanged.

### Security
- Gzip-bomb guard: inflation runs through
  `gunzipSync(bytes, { maxOutputLength: 64 MiB })`, which throws
  `ERR_BUFFER_TOO_LARGE` *during* decompression once the output would cross the
  cap — the bomb never fully materializes in memory. The handler catches the
  cap error and returns a structured `ToolResult` error instead of throwing.
  A corrupt-but-gzip-magic artifact is reported distinctly (not as a bomb).

### References
- [PLA-611](../paperclipai/issues/PLA-611) — parent (CTO).
- [PLA-576](../paperclipai/issues/PLA-576) — v0.1.6 `artifactId` dispatch this
  builds on (superseded PR #12).

## 0.1.6 — 2026-05-27 (PLA-576)

### Changed
- `klipper.upload_gcode` tool now takes `{filename, artifactId, path?}` instead
  of `{filename, gcodeBase64, path?}`. The worker resolves the attachment
  through `runCtx.artifacts.fetch(artifactId)` (PLA-574 SDK bridge) and streams
  the bytes straight to `MoonrakerClient.uploadGcode` — callers never base64-
  encode the payload through tool arguments. This unblocks DPR-130's 14 MB
  G-code dispatch, which previously tripped the host's request-body cap
  (PLA-564 / PLA-573).
- `@paperclipai/plugin-sdk` + `@paperclipai/shared` bumped to the
  `2026.428.1-fork.9` tarballs that expose the `runCtx.artifacts.fetch` surface
  introduced in [PLA-574](../paperclipai/issues/PLA-574).

### Removed
- Dropped the `gcodeBase64` branch of the `klipper.upload_gcode` schema. There
  is no deprecated fallback — the worker rejects calls that omit `artifactId`
  with the schema-validation error the host emits for unknown / missing
  parameters.

### Notes
- The UI's `upload_gcode` action stub in `src/ui/UploadAffordance.tsx` is
  unaffected; rewiring the UI to upload as an artifact first is tracked
  separately as PLA-504.

### References
- [PLA-511](../paperclipai/issues/PLA-511) — original artifactId contract
  intent.
- [PLA-573](../paperclipai/issues/PLA-573) — release umbrella.
- [PLA-574](../paperclipai/issues/PLA-574) — SDK `runCtx.artifacts.fetch` +
  cross-tenant auth.

## 0.1.5 — 2026-05-23 (PLA-555)

- `package.json` declares `files: ["dist/", "README.md"]` so `npm pack` cannot
  silently drop the gitignored `dist/` artifacts. Added `postbuild`
  `check-manifest-version` to guard against version drift between
  `package.json` and the built manifest.

## 0.1.4 — internal

- (Skipped publish — version slot reserved during PLA-526 build-time inject
  rollout.)

## 0.1.3 — internal

- (Skipped publish — version slot reserved.)

## 0.1.2 — 2026-05-23 (PLA-514)

- Hand-roll `multipart/form-data` body + Content-Type header in
  `MoonrakerClient.uploadGcode`. The plugin-sdk `PluginHttpClient` stringifies
  non-string bodies (`String(body) === "[object FormData]"`) and never
  synthesizes a multipart Content-Type, so Moonraker returned
  `HTTP 500 ParseFailedException: Missing Content-Type header` until this
  workaround landed.

## 0.1.1 — 2026-05-23 (PLA-510)

- Aligned worker tool registration names + `klipper.upload_gcode` schema with
  the manifest (`{filename, gcodeBase64, path?}`). PLA-509 DPR found the
  worker had been registering bare tool names while the host dispatches by the
  namespaced manifest name.

## 0.1.0 — initial Phase-1 scaffold

- Manifest, RPC surface stubs, MoonrakerClient + page slot, permissive worker
  init (PLA-474 / PLA-475 / PLA-480 / PLA-502 / PLA-503 / PLA-505).
