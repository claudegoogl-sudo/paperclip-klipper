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
    const dest = mkdtempSync(join(tmpdir(), "pack-"));
    tempDirs.push(dest);
    const tarball = npmPack(["--pack-destination", dest]).trim().split("\n").pop()!;
    execFileSync("tar", ["-xzf", join(dest, tarball), "-C", dest]);

    const offenders = walk(join(dest, "package")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes("sourcesContent") || text.includes("sourceMappingURL=");
    });
    expect(offenders.map((f) => f.slice(dest.length + 1))).toEqual([]);
  });
}, 180_000);
