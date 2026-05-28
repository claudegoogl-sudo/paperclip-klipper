# Changelog

All notable changes to `@platform/paperclip-klipper` are recorded here. The
plugin follows semver against the host plugin API (PLA-526 keeps
`package.json.version` and the manifest version in lockstep via the build
`define`).

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
