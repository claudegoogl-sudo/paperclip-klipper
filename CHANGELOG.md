# Changelog

All notable changes to `@platform/paperclip-klipper` are recorded here. The
plugin follows semver against the host plugin API (PLA-526 keeps
`package.json.version` and the manifest version in lockstep via the build
`define`).

## 0.2.12 — 2026-09-26

### Fixed
- **No stream-drop warning on activation.** When a config apply stopped a
  started transport (for example during the per-company config replay at
  worker start), the transport's `stop()` pushed a final `idle` connection
  state through `ctx.streams.emit` with no dispatch claim. The host dropped
  it fail-closed (`pin_mismatch`), logged a warning pair, and the worker
  reset its pin mirror. The worker now closes the status channel before it
  stops the transport, emits only while a channel is open, and ignores
  callbacks from a stopped or replaced transport. Suppressed emits log
  `klipper.stream.emit_suppressed` at debug level. The host drop is
  unchanged.

## 0.2.11 — 2026-09-26

### Fixed
- **Every configured company now receives its config at worker start.** The
  plugin now declares `multiCompanyConfig: true`. The worker was already
  multi-company in practice: tools, data and actions read the dispatching
  company's config inside the dispatch and rebuild the transport when needed.
  Without the declaration, the SDK rejected each company whose stored config
  differed from the first one in replay order (`CROSS_TENANT_CONFIG`,
  `-32006`). The host then logged `startup config delivery rejected` and a
  `failed` count on every activation. A company with its own printer config
  (for example a FlashForge transport while other companies keep the Moonraker
  default) hit this every time.

### Security
- **The page data and actions serve the held printer only to the company that
  owns it.** One worker now holds every company's config, but it keeps one
  printer client and one camera feed at a time. The worker records the owning
  company: the company whose config was applied last, or whose dispatch last
  credentialed the client. `status`, `connection`, `files`, `file_metadata`,
  `config` and every print, file, upload and camera action check the
  host-authorized company scope of the caller against that owner. Another
  company (or an unscoped caller while an owner is set) gets the idle shape for
  data keys and `prerequisite_missing` for actions. A denial logs
  `klipper.tenancy.client_denied`.

### Unchanged
- Manifest capabilities (5) and tools (3). Dispatch-time config resolution,
  credential handling and the tool gates are unchanged.

## 0.2.10 — 2026-09-25

### Fixed
- **`klipper.get_printer_status` reports the calling company's printer.** The
  worker is shared by every company. The status tool used to return whatever
  client the worker held — after a fresh boot that is another company's idle
  boot client (`connection.state: "idle"`, no FlashForge `machineState`). It
  now resolves the dispatching company's transport from the live config inside
  the dispatch, like `upload_gcode` and `start_print`. It stays read-only.
- **Tools work on a worker that has no applied config.** After a bare worker
  restart with no config replay, all three tools returned
  `prerequisite_missing` before the in-dispatch resolution could build the
  client. The client null-guard now runs after one shared resolution helper;
  `prerequisite_missing` is returned only when the LIVE config is missing or
  invalid.
- A status dispatch whose credential resolution fails returns a soft
  `degraded: true` result with the (secret-free) reason. It never returns the
  snapshot of a client that belongs to another company.

### Unchanged
- Manifest capabilities (5) and tools (3). `auto_upload_artifacts` and
  `allow_agent_initiated_print` gates run in the same order as before.

## 0.2.9 — 2026-09-25

### Fixed
- **Status stream self-heals after a host drop.** When the host drops our
  status-stream `open` (`streams.dropped` for our channel), the worker now
  clears its local pin mirror so the next credentialed dispatch re-opens the
  channel. Before, same-company dedupe kept the stream silent until a
  transport restart.

### Tests
- New spec for the drop→re-open path (red on 0.2.8, green now).
- New spec for the in-place re-point path (same connection, other company):
  single transport, re-pointed channel, zero extra host calls.
- Refreshed the stale SDK generation note in the test harness docblock.

## 0.2.8 — 2026-09-25

### Fixed
- **`klipper.upload_gcode` now uploads non-ASCII G-code byte-exact** on both
  the FlashForge and Moonraker transports. The multipart body was built as a
  latin1 string; the SDK sends string bodies as UTF-8, so every byte >= 0x80
  (for example an em-dash or degree sign in a slicer comment) became two
  bytes. The FlashForge file part then no longer matched the `fileSize`
  header and the printer answered "Send file error". The body is now a
  Buffer, which the SDK sends as base64 and the host decodes byte-exact.
  No new capabilities; no host change.

## 0.2.7 — 2026-09-24

### Added
- **The printer page now receives a live status stream.** The worker opens
  its status stream channel inside the first credentialed tool dispatch
  (the moment the transport loop starts with the dispatching company's
  identity) and keeps it open while the transport runs, so the page's
  `usePluginStream` subscription receives status and connection-state
  events pushed from the transport's poll/reconnect callbacks. The host
  pins the channel to the dispatching company from the echoed invocation
  scope — the worker never claims the attribution itself — and every later
  out-of-dispatch emit is tenant-verified against that pin. A dispatch
  from another company re-points the stream to that company (the worker
  holds one transport; the stream follows the dispatch), and stopping the
  transport closes the channel so the subscription sees the stream end
  instead of silently starving.

### Changed
- Vendored plugin SDK refreshed to the 2026.924.1-fork51.1 generation:
  every worker→host notification echoes the host-issued invocation id
  (the stream pin's authorization path), and the host's
  `streams.dropped` signal is forwarded to the plugin log so a dropped
  emit is worker-visible instead of silent.
- `upload_gcode` now refuses with a reportable tool error when the host
  dispatches without an artifacts client (older host generations) instead
  of crashing the handler.

## 0.2.6 — 2026-09-24

### Added
- **Live camera section on the printer page.** The worker proxies the
  printer's single-viewer MJPG camera — scope-pinned to `/?action=stream`,
  http(s)-only, host-allowlisted, no userinfo — over ONE upstream
  connection, opened only while a board user is actually viewing the page
  section and closed on unmount, tab-hide, or after the idle timeout.
  Frames are pulled by the page over the authenticated actions bridge
  (`camera_open` / `camera_next` / `camera_retry` refuse agent callers;
  `camera_close` is safe for all) — the camera is never exposed to agent
  keys or on any additional port. Keep-latest single-frame buffer (never a
  queue), fail-closed caps (512 KB/frame, 1 MB SOI-less prefix), jittered
  exponential backoff (1 s → 30 s) with terminal `failed` after 6 attempts,
  20 s viewer-idle self-release, frames never logged. A stale frame is
  never shown as live (stale banner past 2.5 s) and an explicit Retry is
  offered after terminal failure.

### Changed
- **Printer-control actions now gate agent-key callers**: `pause_print`,
  `resume_print`, `cancel_print`, and `start_print` require the same live
  `allow_agent_initiated_print` read the agent tools enforce; `delete_file`
  and the `upload_gcode` action require live `auto_upload_artifacts`.
  Board users keep tap-to-consent. The `upload_gcode` action shares the
  tool's upload pipeline as code identity (filename/path backstops, gzip
  bomb guard, inline base64 cap); the tool validates inputs BEFORE the
  in-dispatch credential resolve so a malformed call never spends a
  resolve.
- Vendored plugin SDK refreshed to the 2026.923.1-fork51 generation.

## 0.2.5 — 2026-09-24

### Fixed
- **Transport credentials resolve lazily inside tool dispatches —
  config-apply resolves NOTHING.** 0.2.4 resolved `moonrakerApiKeyRef` /
  `flashforgeCheckCodeRef` inside the host's scoped `configChanged` push,
  but the host runs plugin applies async to that push, so every apply-time
  resolve landed with 0 or 2+ invocations in flight and was DENIED by
  single-in-flight attribution (`InvocationScopeDeniedError`) — no
  credentialed transport ever came up. Resolution now happens in the one
  reliably attributed context: an in-flight tool dispatch (the executeTool
  scope carries companyId+runId). Ref-bearing transports converge DORMANT
  at apply (fail-closed idle), the first credentialed dispatch resolves the
  ref exactly once, starts the transport, and passes the gates; the
  resolved plaintext is cached in memory keyed to the live config
  fingerprint and invalidated on EVERY config application, so a rotated
  secret lands at the next dispatch. The idle state is observable — status
  data key, status tool, and health all report "credential not resolved
  yet" — and a resolve failure keeps the transport dormant with no
  credential material in any log. As a side effect, credentialed dispatches
  no longer run on the last-applied company's client: the client is
  rebuilt from the dispatching company's validated live config whenever
  the connection fingerprint differs.
- **Unauthenticated-moonraker dispatches are identity-guarded on the
  shared worker.** The host runs ONE worker child per plugin, shared by
  every company, and the unauth branch of the credential gate used to
  return ok without comparing the live client against the dispatching
  company's config — after company B's config row was applied last, a
  company A dispatch uploaded to and drove B's printer (persistent
  cross-tenant misrouting, not a rare race). The branch now validates the
  live config (fail-closed on invalid), and rebuilds the client from it
  whenever the live client's connection identity differs. Dispatch-time
  rebuilds also keep the worker's config identity in sync, so the next
  apply of the previous company's row correctly replaces the connection
  instead of misreading it as an unchanged replay.
- **The credentialed fast path re-verifies the HELD client's identity
  (C1b, same cross-tenant class as the unauth guard).** The resolution
  cache is keyed to the config fingerprint, not to the client — and an
  interleaved dispatch from another company can replace the held client
  (e.g. the unauth rebuild above) without touching the cache. Company
  A(resolved) → company B(unauth rebuild) → company A used to fast-path
  onto B's client and upload to / print on B's printer until the next
  config application. The fast path now requires the same
  connection-identity predicate as the resolve path and falls through to
  the full in-dispatch resolve on mismatch; the unauth rebuild also drops
  any surviving cache entry (the transport holds no plaintext after it).
- **upload_gcode order is gate → validate → resolve** (matching
  start_print): a malformed filename or subdirectory is refused before any
  credential resolve or transport start — a malformed call never spends a
  resolve.

## 0.2.4 — 2026-09-24

### Fixed
- **Dispatch-time config/secret reads are no longer denied
  (`InvocationScopeDeniedError`).** The host attributes worker→host RPCs that
  do not echo an invocation id via single-in-flight attribution, and any
  id-less call with nothing in flight permanently denies that method for the
  worker's lifetime. Two worker paths kept tripping it:
  `setup()` made a best-effort `ctx.config.get()` in service scope
  (poisoning `config.get` at spawn), and the FlashForge status poll resolved
  the check-code secret once per `/detail` cycle (~every 10s, almost always
  outside any dispatch — poisoning `secrets.resolve`). The first real
  dispatch then failed closed: the upload gate's live config re-read got the
  poisoned denial, degraded to `{}`, and refused the upload with a
  misleading "auto_upload_artifacts is false" even though the persisted
  config was correct; the upload would have failed at secret resolution
  next.

### Changed
- **setup() makes no worker→host calls.** Config reaches the worker
  exclusively through the host's `configChanged` replay (boot) and operator
  saves — the path the host actually implements. Until it lands, the worker
  boots permissive and tools return `prerequisite_missing`.
- **Transport credentials resolve once per config application.**
  `moonrakerApiKeyRef` / `flashforgeCheckCodeRef` are resolved inside the
  host's scoped `configChanged` push and handed to the transport client,
  which holds the plaintext in memory only (never logged, redaction guards
  unchanged). The status poll, WS reconnect loop, health probes, and UI data
  keys now make ZERO worker→host calls. The cache never outlives the config
  that produced it: every application (including unchanged-connection
  replays) re-resolves and swaps the value in, and a resolve failure stops
  the transport fail-closed (tools return `prerequisite_missing`). A rotated
  secret takes effect at the next config save or worker restart — per-call
  freshness for dispatch-driven requests is the one behavior this trade
  retires, and it is documented in the manifest and README.
- In-dispatch gate reads (`ctx.config.get()` inside tool handlers) are
  unchanged: with the spawn and idle paths fixed, those calls always run
  with a dispatch in flight and stay attributed.

## 0.2.3 — 2026-09-23

### Fixed
- **Trim parity for legacy string check-code refs.** The object-binding
  release (0.2.2) stopped trimming whitespace around a legacy string
  `flashforgeCheckCodeRef`, so a padded config value (e.g. pasted with
  leading/trailing spaces) would have been handed to the host's secret
  resolution untrimmed and failed to resolve. Transport config validation
  trims the string branch again — a padded string resolves exactly as it
  did before 0.2.2. The object branch keeps its normalized handling
  (secretId trim + version collapse) unchanged.

### Changed
- **Disjoint secret-ref connection identities (config fingerprints).**
  Legacy string refs previously kept their raw value as the connection
  fingerprint identity, so a string that literally read
  `secret_ref:<uuid>:<ver>` would collide with that object binding's
  canonical identity and the two configs would alias one connection.
  String identities now carry a `string:` prefix, making string and object
  identities disjoint by construction. One-time consequence for existing
  legacy-string configs: the first fingerprint computed by this version
  differs from the pre-upgrade one, so each such config sees exactly one
  client rebuild (reconnect + re-detect) at upgrade time and then
  stabilizes. No config value is rewritten and resolve behavior is
  unchanged.
- The manifest-vs-host secret-ref contract test now records the host
  generation its host-code replica was last verified against, so replica
  refreshes are driven by host upgrades instead of memory.

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
