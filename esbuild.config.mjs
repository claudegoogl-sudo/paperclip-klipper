import esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

// PLA-526 — single source of truth for the plugin version.
//
// `src/manifest.ts` previously hardcoded its `version` field, which drifted
// from `package.json.version` whenever a release branch bumped one and forgot
// the other (PLA-525 was triggered by the operator installing v0.1.3 while
// the host reported v0.1.1 because `src/manifest.ts:37` still said "0.1.1").
//
// We inject `__PLUGIN_VERSION__` at build time via esbuild's `define`. The
// constant is declared for TypeScript in `src/globals.d.ts`. The
// `scripts/check-manifest-version.mjs` post-build gate re-parses the
// emitted `dist/manifest.js` and fails the build on mismatch so the next
// hardcoded-version regression is loud.
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  await readFile(resolve(REPO_ROOT, "package.json"), "utf8"),
);
const define = {
  __PLUGIN_VERSION__: JSON.stringify(pkg.version),
};

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

// The SDK preset defaults to `sourcemap: true`, which embeds every original
// TypeScript file — ours plus the vendored host packages — into `dist/*.map`
// as `sourcesContent`. `package.json` ships `dist/` verbatim, so the released
// tarball carried our full source. "external" keeps the map on disk for local
// debugging but drops the `//# sourceMappingURL=` footer; the `files`
// negation keeps `dist/**/*.map` out of the package.
const sourcemap = "external";

const workerCtx = await esbuild.context({
  ...presets.esbuild.worker,
  sourcemap,
  define: { ...(presets.esbuild.worker.define ?? {}), ...define },
});
const manifestCtx = await esbuild.context({
  ...presets.esbuild.manifest,
  sourcemap,
  define: { ...(presets.esbuild.manifest.define ?? {}), ...define },
});
const uiCtx = await esbuild.context({
  ...presets.esbuild.ui,
  sourcemap,
  define: { ...(presets.esbuild.ui.define ?? {}), ...define },
});

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
