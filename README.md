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
| `flashforgeBaseUrl` | URL | e.g. `http://192.168.1.50:8898`. Port `8898` is applied when omitted. All FlashForge traffic is scoped to this host (`flashforgeAllowedHosts` mirrors the moonraker allowlist). |
| `flashforgeSerialNumber` | string | The Device ID shown in the printer's *Network > LAN Only* settings. An identifier, not a credential. |
| `flashforgeCheckCodeRef` | secret-ref | The per-printer check code (the LAN-mode credential). Resolved per call via `ctx.secrets.resolve`; never stored or logged. |

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
  "flashforgeCheckCodeRef": "<secret ref holding the check code>",
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
  (Moonraker WebSocket or FlashForge poll) without a worker restart.
  Application is idempotent by connection identity
  (transport + baseUrl + allowlist + credential ref), so
  the per-company replay burst at boot converges on one client; gate-flag-only
  changes never rebuild the transport; an absent or invalid `moonrakerBaseUrl`
  degrades back to permissive init instead of crashing the worker.
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

Snapshot source: `@paperclipai/plugin-sdk@2026.428.1-fork.5` and
`@paperclipai/shared@2026.428.1-fork.5`. Once these SDKs are published to npm,
switch the `devDependencies` to the registry versions and delete
`.paperclip-sdk/`.

## Install Into a Running Paperclip Server (alternative)

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"'"$(pwd)"'","isLocalPath":true}'
```
