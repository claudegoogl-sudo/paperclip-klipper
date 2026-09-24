# paperclip-klipper

Paperclip plugin for Klipper / Moonraker 3D printers.

## Install (operator quickstart)

```bash
git clone https://github.com/claudegoogl-sudo/paperclip-klipper.git
cd paperclip-klipper
pnpm install && pnpm build
paperclipai plugin install ./
```

## Printer transports

The plugin drives two printer families through one transport seam
(`src/worker/transports/`):

| `transport` value | Firmware / API | Default |
| --- | --- | --- |
| `moonraker` (or unset) | Klipper + Moonraker REST/WebSocket | yes |
| `flashforge` | FlashForge closed firmware (Creator 5 / Creator 5 Pro, *Network > LAN Only* HTTP API) | no |

Unset `transport` behaves exactly like `moonraker` — historical configs need no
change. Any other value is rejected at load with a clear error (fail closed;
no silent fallthrough).

### Moonraker transport (default)

Config keys: `moonrakerBaseUrl` (required), `moonrakerAllowedHosts`,
`moonrakerApiKeyRef` (secret-ref), `auto_upload_artifacts`,
`allow_agent_initiated_print`.

### FlashForge transport (`transport: "flashforge"`)

Config keys (all three required when the transport is selected):

| Key | Kind | Notes |
| --- | --- | --- |
| `flashforgeBaseUrl` | URL | e.g. `http://192.168.1.50:8898`. Port `8898` is applied when omitted; URLs embedding credentials (userinfo) are rejected — the check code belongs in the secret-ref. All FlashForge traffic is scoped to this host (`flashforgeAllowedHosts` mirrors the moonraker allowlist). |
| `flashforgeSerialNumber` | string | The Device ID shown in the printer's *Network > LAN Only* settings. An identifier, not a credential. |
| `flashforgeCheckCodeRef` | secret-ref | The per-printer check code (the LAN-mode credential). Resolved by the worker INSIDE the first tool dispatch that needs it; held in worker memory only — never stored or logged. Before that first dispatch the transport is dormant and status/health report "credential not resolved yet". |

#### Secret-reference shapes (both ref keys)

`moonrakerApiKeyRef` and `flashforgeCheckCodeRef` accept **two shapes**:

- **Binding object (preferred on current hosts)** — what the host settings UI
  submits and what the host persists as a company-scoped secret binding when
  the config is saved:

  ```json
  { "type": "secret_ref", "secretId": "<secret UUID>", "version": "latest" }
  ```

  `version` is optional (`"latest"` or a positive integer; absent behaves as
  `"latest"`). `secretId` must be the secret's UUID.
- **Legacy string ref** — a bare secret name/UUID string, kept for backward
  compatibility with configs written before object bindings existed. Note
  that current host generations refuse to RESOLVE bare-UUID string refs (the
  per-tenant config-overrides route answers 422 for them), so new setups
  should always use the object shape.

Either way the plaintext value is resolved by the worker **inside the first
tool dispatch that needs it** (`klipper.upload_gcode` / `klipper.start_print`)
and held in worker memory, keyed to the config fingerprint that produced it;
it is never stored, logged, or written to state. Every config application
(boot replay or operator save) invalidates the cache, so a rotated secret
takes effect at the next dispatch. A ref that cannot be resolved fails the
dispatch with a clear "credential not resolved yet" reason and the transport
stays dormant (fail closed — no silent fallback, no unauthenticated request).

**Fail-closed idle.** Until the first credentialed dispatch, a ref-bearing
transport stays DORMANT: no WebSocket, no status poll, no request leaves the
process. The status data key, the `klipper.get_printer_status` tool, and the
health report all say `credential not resolved yet` during that window — an
observable degraded state, not a misleading gate error. Background
resolution (UI actions, the status poll, WS reconnects) is deliberately
unsupported on this SDK generation; resolving there is exactly what the
attribution rules forbid (see below).

> Why not resolve at config-apply or per request? Worker→host RPCs that run
> with no (or with several concurrent) invocations in flight cannot be
> attributed to a tenant, and the host permanently denies a method after
> seeing an unattributable one. The activation config replay delivers rows
> back-to-back while the plugin's apply runs async to the push, so an
> apply-time resolve lands unattributed and is denied — observed live, on
> every row, during plugin activation. The ONE reliably attributed context
> for this worker class is an in-flight tool dispatch, so the credential
> resolves there; config re-reads for the opt-in gates ride the same
> attributed path.

Endpoint shapes follow the printer's LAN-only HTTP API (`POST /detail`,
`/gcodeList`, `/uploadGcode`, `/printGcode`, `/control`): JSON endpoints carry
the serial number and check code in the request body; uploads carry them in
headers next to the multipart `gcodeFile` field.

Upload-only rollout example (recommended first configuration — agents may push
files; starting a print stays an operator action):

```json
{
  "transport": "flashforge",
  "flashforgeBaseUrl": "http://192.168.1.50:8898",
  "flashforgeSerialNumber": "<Device ID from the printer network settings>",
  "flashforgeCheckCodeRef": {
    "type": "secret_ref",
    "secretId": "<secret UUID>",
    "version": "latest"
  },
  "auto_upload_artifacts": true,
  "allow_agent_initiated_print": false
}
```

### Security model (both transports)

- `allow_agent_initiated_print` is **default-deny**: `klipper.start_print` is
  refused unless an operator explicitly sets it to `true`. The gate is
  re-read from live config on every dispatch and fails closed on any read
  error.
- An upload can never imply a print. The FlashForge upload sends
  `printNow: false` unconditionally — there is no flag, argument, or code
  path that starts a print from an upload.
- `auto_upload_artifacts` gates uploads only; it never weakens the print gate.
- Health is fail-closed for the FlashForge transport: `onHealth` issues a
  fresh `/detail` probe and reports `degraded` when the printer is
  unreachable (refused, timeout, 5xx, or error envelope) — never a stale
  `ok`.
- Status polling (`/detail` every 10 s) feeds the same dashboard snapshot
  path as the Moonraker WebSocket; machine states map onto the familiar
  `print_stats.state` values (`ready`→`standby`, `printing`, `pause`→`paused`,
  `completed`→`complete`, …).

## Boot-time config (host replay semantics)

The Paperclip host spawns plugin workers with an **empty bootstrap config** and
delivers each configured company's stored config row through the
`configChanged` RPC right after the worker starts. A `ctx.config.get()` issued
from `setup()` therefore runs in service scope with no company attached, and
recent hosts deny it (`company context is required`).

This plugin treats that denial as **config unknown, not boot failure**:

- `setup()` reads config best-effort. On denial the worker boots *permissive*:
  the full data/action/tool surface is registered, tools return a structured
  `prerequisite_missing` result, lifecycle holds `ready`, and a warning names
  the wait (`waiting for the host config replay`).
- `onConfigChanged` (the host replay and every operator config save) applies
  the snapshot in-process and starts/stops the active transport's client
  (Moonraker WebSocket or FlashForge poll) without a worker restart. The
  application itself makes ZERO worker→host calls (no `config.get`, no
  `secrets.resolve`) and converges ref-bearing transports DORMANT.
  Application is idempotent by connection identity
  (transport + baseUrl + allowlist + credential ref), so the per-company
  replay burst at boot converges on one dormant client; an unauthenticated
  Moonraker (no ref) starts immediately as before; an absent or invalid
  `moonrakerBaseUrl` degrades back to permissive init instead of crashing
  the worker. Every application invalidates the credential cache, so a
  rotated secret lands at the next credentialed dispatch.
- `onHealth` reports `configKnown` / `clientActive` so a replay-pending boot is
  visible in the plugin health dashboard.

The company-context authorization is never bypassed: a denied read yields
unknown config (never a guessed or stale one), and the high-blast-radius tool
gates (`auto_upload_artifacts`, `allow_agent_initiated_print`) re-read config
on every dispatch and fail closed.

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
pnpm typecheck
pnpm validate:manifest
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.

## Vendored SDK tarballs

`@paperclipai/plugin-sdk` and `@paperclipai/shared` are not yet published to npm.
This repo vendors packed tarballs under `.paperclip-sdk/` (~300 KB total) and
`package.json` references them via `file:.paperclip-sdk/*.tgz`. This is
intentional so `pnpm install` works from a fresh clone without needing access
to the upstream Paperclip checkout.

Snapshot source: `@paperclipai/plugin-sdk@2026.916.1` and
`@paperclipai/shared@2026.916.1`, packed from the published npm artifacts
(`npm pack <pkg>@<version>` inside `.paperclip-sdk/`). The snapshot is
refreshed when a plugin needs an SDK capability the vendored copy predates
(e.g. actor-context delivery to action handlers); keep the tarballs pinned to
exact versions so installs stay byte-reproducible.

## Install Into a Running Paperclip Server (alternative)

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"'"$(pwd)"'","isLocalPath":true}'
```
