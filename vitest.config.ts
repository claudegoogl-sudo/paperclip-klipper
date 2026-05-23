import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// PLA-526 — mirror esbuild's `define` so vitest can import `src/manifest.ts`
// without choking on the build-time-injected `__PLUGIN_VERSION__` global.
// Vitest's `define` uses the same JSON-literal substitution semantics as
// esbuild, so `JSON.stringify` is required for string values.
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));

export default defineConfig({
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: [
      "tests/**/*.spec.ts",
      "tests/**/*.spec.tsx",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    // Per-file `@vitest-environment jsdom` docblocks switch the UI tests
    // (tests/ui/*.spec.tsx) into a DOM environment without paying the
    // jsdom startup cost for the existing node-only worker tests.
  },
});
