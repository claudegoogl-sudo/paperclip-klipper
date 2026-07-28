/**
 * Build-time-injected globals.
 *
 * `__PLUGIN_VERSION__` is substituted at build time by esbuild's `define`
 * (see `esbuild.config.mjs`) from `package.json.version`, giving the
 * manifest a single source of truth for the plugin version.
 *
 * This file is consumed by `tsc --noEmit` so the TypeScript type-checker
 * accepts the otherwise-undefined global; the actual value is inlined by
 * the bundler before it reaches the runtime.
 */
declare const __PLUGIN_VERSION__: string;
