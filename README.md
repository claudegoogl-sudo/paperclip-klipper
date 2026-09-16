# paperclip-klipper

Paperclip plugin for Klipper / Moonraker 3D printers.

## Install (operator quickstart)

```bash
git clone https://github.com/claudegoogl-sudo/paperclip-klipper.git
cd paperclip-klipper
pnpm install && pnpm build
paperclipai plugin install ./
```

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
  the snapshot in-process and starts/stops the Moonraker client without a
  worker restart. Application is idempotent by connection identity
  (`moonrakerBaseUrl` + `moonrakerAllowedHosts` + `moonrakerApiKeyRef`), so
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
