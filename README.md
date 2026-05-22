# paperclip-klipper

Paperclip plugin for Klipper / Moonraker 3D printers.

## Install (operator quickstart)

```bash
git clone https://github.com/claudegoogl-sudo/paperclip-klipper.git
cd paperclip-klipper
pnpm install && pnpm build
paperclipai plugin install ./
```

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
