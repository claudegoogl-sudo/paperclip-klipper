import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

// PLA-526 — keep rollup's secondary build path (`npm run build:rollup`) in
// sync with the esbuild primary path that injects `__PLUGIN_VERSION__` via
// `define`. The constant must be substituted in `src/manifest.ts` before
// `@rollup/plugin-typescript` strips the `declare const` ambient, otherwise
// the emitted JS references an undeclared global at runtime.
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  await readFile(resolve(REPO_ROOT, "package.json"), "utf8"),
);
const PLUGIN_VERSION_LITERAL = JSON.stringify(pkg.version);

/** @returns {import('rollup').Plugin} */
function injectPluginVersion() {
  return {
    name: "pla-526-inject-plugin-version",
    transform(code, id) {
      if (!id.endsWith(".ts") && !id.endsWith(".tsx")) return null;
      if (!code.includes("__PLUGIN_VERSION__")) return null;
      const replaced = code.replace(/__PLUGIN_VERSION__/g, PLUGIN_VERSION_LITERAL);
      return { code: replaced, map: null };
    },
  };
}

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

function withPlugins(config) {
  if (!config) return null;
  return {
    ...config,
    plugins: [
      injectPluginVersion(),
      nodeResolve({
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
        declarationMap: false,
      }),
    ],
  };
}

export default [
  withPlugins(presets.rollup.manifest),
  withPlugins(presets.rollup.worker),
  withPlugins(presets.rollup.ui),
].filter(Boolean);
