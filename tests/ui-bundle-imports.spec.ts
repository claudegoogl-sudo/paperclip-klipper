/**
 * The host UI loader rewrites bare imports by exact text match on
 * ` from "<spec>"` / `import "<spec>"`. A minified `from"react"` slips past
 * it and the page slot stays blank. Guard the BUILT bundle.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const SPECS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@paperclipai/plugin-sdk/ui",
];

describe("dist/ui/index.js host import shape", () => {
  let code = "";
  beforeAll(() => {
    execFileSync("node", ["./esbuild.config.mjs"], { cwd: root, stdio: "ignore" });
    code = readFileSync(resolve(root, "dist/ui/index.js"), "utf8");
  }, 120_000);

  it("has no minified `from\"<bare spec>\"` import", () => {
    expect(code).not.toMatch(/from"(?![./])/);
    expect(code).not.toMatch(/import"(?![./])/);
  });

  it("keeps ` from \"<spec>\"` for every host specifier it imports", () => {
    const found = [...code.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(found.length).toBeGreaterThan(0);
    for (const spec of found) expect(SPECS).toContain(spec);
    for (const spec of new Set(found)) expect(code).toContain(` from "${spec}"`);
  });
});
