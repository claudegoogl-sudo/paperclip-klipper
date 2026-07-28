import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Sourcemaps carry the full original TypeScript in `sourcesContent`. Publishing
// them ships our source — and the vendored host packages' source — to anyone
// who downloads a release asset. The build keeps maps on disk for local
// debugging; this asserts they never reach the tarball.

// Internal tracker ids and real vault namespaces reach the bundle through
// ordinary source comments and manifest strings. The build strips comments
// via esbuild `minifyWhitespace`; this asserts the result, scoped to the
// bundled output under dist/.
//
// The needles are built from split literals so this spec's own prose cannot
// trip the check if it is ever packaged, and are declared non-global so
// `.test()` cannot carry `lastIndex` state between files and silently skip
// every other one.
const TICKET_ID_RE = new RegExp("\\bPLA" + "-\\d{1,5}\\b");
const VAULT_NS_PLACEHOLDERS = ["EXAMPLE", "OTHER", "\\.\\.\\."];
const VAULT_NS_RE = new RegExp(
  "vault" + `://(?!(?:${VAULT_NS_PLACEHOLDERS.join("|")})(?![\\w-]))[\\w-]+`,
);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist");
const tempDirs: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function npmPack(args: string[]): string {
  return execFileSync("npm", ["pack", "--ignore-scripts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// `npm pack` is the slow part of this suite, so pack once and share the
// extracted tree across every assertion that needs to read packed files.
let extracted: string | undefined;
function packAndExtract(): string {
  if (extracted) return extracted;
  const dest = mkdtempSync(join(tmpdir(), "pack-"));
  tempDirs.push(dest);
  const tarball = npmPack(["--pack-destination", dest]).trim().split("\n").pop()!;
  execFileSync("tar", ["-xzf", join(dest, tarball), "-C", dest]);
  extracted = dest;
  return dest;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("published tarball", () => {
  it("is built, and still emits sourcemaps on disk for local debugging", () => {
    expect(statSync(join(DIST, "worker.js")).isFile()).toBe(true);
    const maps = walk(DIST).filter((f) => f.endsWith(".map"));
    expect(maps.length).toBeGreaterThan(0);
  });

  it("packs no sourcemap entries", () => {
    const listed = JSON.parse(npmPack(["--dry-run", "--json"])) as Array<{
      files: Array<{ path: string }>;
    }>;
    const paths = listed[0].files.map((f) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => p.endsWith(".map"))).toEqual([]);
  });

  it("packs no file containing sourcesContent or a sourceMappingURL footer", () => {
    const dest = packAndExtract();
    const offenders = walk(join(dest, "package")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes("sourcesContent") || text.includes("sourceMappingURL=");
    });
    expect(offenders.map((f) => f.slice(dest.length + 1))).toEqual([]);
  });

  it("packs no internal ticket ids or non-placeholder vault namespaces in dist/", () => {
    const dest = packAndExtract();
    const offenders = walk(join(dest, "package"))
      .filter((file) => file.includes("/dist/"))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return TICKET_ID_RE.test(text) || VAULT_NS_RE.test(text);
      });
    expect(offenders.map((f) => f.slice(dest.length + 1))).toEqual([]);
  });
}, 180_000);
