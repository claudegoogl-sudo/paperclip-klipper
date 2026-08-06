/**
 * Regression coverage for the live-install drift detector.
 *
 * The incident this guards: a plugin version was deployed by swapping dist/
 * into an existing package directory, so the running code matched no commit
 * and the directory name reported a version several releases stale. Every
 * test below pins one of the inferences that failure made unsafe — including
 * the nested package layout this plugin ships in, where the outer directory
 * can carry a package.json with no version field at all.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — .mjs has no .d.ts; the helpers are plain JS by design
import { parseWorkerProcesses, extractWorkerCandidates, pickNewestVersionTag, hashSourceTree, diffFileHashes, compareInstall, isDistStale, resolvePackageRoot, readRecordedDistHashes } from "../scripts/check-live-drift.mjs";

describe("resolvePackageRoot", () => {
  it("resolves a flat layout — package.json two levels up from worker.js", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-flat-"));
    try {
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "worker.js"), "");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "flat-plugin", version: "1.2.3" }),
      );
      expect(resolvePackageRoot(join(root, "dist", "worker.js"))).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a nested layout — walks past the outer dir to the inner package", () => {
    const outer = mkdtempSync(join(tmpdir(), "drift-nested-"));
    try {
      // outer dir is named like a stale install dir would be on this host.
      const outerVersioned = join(outer, "plugin-0.1.7");
      const inner = join(outerVersioned, "package");
      mkdirSync(join(inner, "dist"), { recursive: true });
      writeFileSync(join(inner, "dist", "worker.js"), "");
      writeFileSync(
        join(inner, "package.json"),
        JSON.stringify({ name: "@platform/plugin", version: "0.1.10" }),
      );
      expect(resolvePackageRoot(join(inner, "dist", "worker.js"))).toBe(inner);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("skips an outer package.json that lacks version and keeps walking up", () => {
    // This is the trap the parent issue calls out: an outer dir whose
    // package.json has no version field would yield a false exit 1 if the
    // detector assumed a fixed two-level walk. The walker must keep going.
    const outer = mkdtempSync(join(tmpdir(), "drift-nested-noversion-"));
    try {
      const outerVersioned = join(outer, "plugin-0.1.7");
      const inner = join(outerVersioned, "package");
      mkdirSync(join(inner, "dist"), { recursive: true });
      writeFileSync(join(inner, "dist", "worker.js"), "");
      // Outer package.json present but with NO version — must be ignored.
      writeFileSync(join(outerVersioned, "package.json"), JSON.stringify({ name: "outer-stub" }));
      writeFileSync(
        join(inner, "package.json"),
        JSON.stringify({ name: "@platform/plugin", version: "0.1.10" }),
      );
      expect(resolvePackageRoot(join(inner, "dist", "worker.js"))).toBe(inner);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("skips an outer package.json that lacks name and keeps walking up", () => {
    const outer = mkdtempSync(join(tmpdir(), "drift-nested-noname-"));
    try {
      const outerVersioned = join(outer, "plugin-0.1.7");
      const inner = join(outerVersioned, "package");
      mkdirSync(join(inner, "dist"), { recursive: true });
      writeFileSync(join(inner, "dist", "worker.js"), "");
      writeFileSync(join(outerVersioned, "package.json"), JSON.stringify({ version: "0.0.0" }));
      writeFileSync(
        join(inner, "package.json"),
        JSON.stringify({ name: "@platform/plugin", version: "0.1.10" }),
      );
      expect(resolvePackageRoot(join(inner, "dist", "worker.js"))).toBe(inner);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("returns null when no ancestor has a name+version package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-no-pkg-"));
    try {
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "worker.js"), "");
      expect(resolvePackageRoot(join(root, "dist", "worker.js"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("extractWorkerCandidates", () => {
  it("pulls pid + worker path from ps lines for flat and nested layouts", () => {
    const ps = [
      "  PID ARGS",
      " 2229 /usr/bin/node /home/x/plugin-packages/flat-1.0.0/dist/worker.js",
      " 3310 /usr/bin/node /home/x/plugin-packages/klipper-0.1.7/package/dist/worker.js",
    ].join("\n");
    expect(extractWorkerCandidates(ps)).toEqual([
      {
        pid: 2229,
        workerPath: "/home/x/plugin-packages/flat-1.0.0/dist/worker.js",
      },
      {
        pid: 3310,
        workerPath: "/home/x/plugin-packages/klipper-0.1.7/package/dist/worker.js",
      },
    ]);
  });

  it("ignores processes that are not plugin workers", () => {
    const ps = " 1 /sbin/init\n 42 /usr/bin/node /srv/app/server.js";
    expect(extractWorkerCandidates(ps)).toEqual([]);
  });
});

describe("parseWorkerProcesses", () => {
  it("resolves flat and nested package roots from a real filesystem", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-ps-"));
    try {
      const flat = join(root, "flat-1.0.0");
      const nested = join(root, "klipper-0.1.7", "package");
      mkdirSync(join(flat, "dist"), { recursive: true });
      writeFileSync(join(flat, "dist", "worker.js"), "");
      writeFileSync(
        join(flat, "package.json"),
        JSON.stringify({ name: "flat-plugin", version: "1.0.0" }),
      );
      mkdirSync(join(nested, "dist"), { recursive: true });
      writeFileSync(join(nested, "dist", "worker.js"), "");
      writeFileSync(
        join(nested, "package.json"),
        JSON.stringify({ name: "@platform/klipper", version: "0.1.10" }),
      );
      const ps = [
        "  PID ARGS",
        ` 2229 /usr/bin/node ${join(flat, "dist", "worker.js")}`,
        ` 3310 /usr/bin/node ${join(nested, "dist", "worker.js")}`,
      ].join("\n");
      expect(parseWorkerProcesses(ps)).toEqual([
        { pid: 2229, workerPath: join(flat, "dist", "worker.js"), packageRoot: flat },
        { pid: 3310, workerPath: join(nested, "dist", "worker.js"), packageRoot: nested },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks past an outer package.json without version (the nested trap)", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-ps-trap-"));
    try {
      const outerVersioned = join(root, "klipper-0.1.7");
      const inner = join(outerVersioned, "package");
      mkdirSync(join(inner, "dist"), { recursive: true });
      writeFileSync(join(inner, "dist", "worker.js"), "");
      writeFileSync(join(outerVersioned, "package.json"), JSON.stringify({ name: "stub" }));
      writeFileSync(
        join(inner, "package.json"),
        JSON.stringify({ name: "@platform/klipper", version: "0.1.10" }),
      );
      const ps = ` 3310 /usr/bin/node ${join(inner, "dist", "worker.js")}`;
      expect(parseWorkerProcesses(ps)).toEqual([
        { pid: 3310, workerPath: join(inner, "dist", "worker.js"), packageRoot: inner },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pickNewestVersionTag", () => {
  it("orders numerically, not lexically", () => {
    expect(pickNewestVersionTag(["v0.1.9", "v0.1.43", "v0.1.10"])).toBe("v0.1.43");
  });

  it("ignores tags that are not plain version tags", () => {
    expect(pickNewestVersionTag(["archive/main-v0.9.0", "v0.1.0", "", "main"])).toBe("v0.1.0");
  });

  it("returns null when nothing is tagged", () => {
    expect(pickNewestVersionTag(["main", "archive/main-v0.1.0"])).toBeNull();
  });
});

describe("hashSourceTree", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "drift-spec-"));
    mkdirSync(join(root, "a", "nested"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "a", "nested", "one.ts"), "export const one = 1;\n");
    writeFileSync(join(root, "b", "two.ts"), "export const two = 2;\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("is stable across runs and uses posix-relative keys", () => {
    const first = hashSourceTree(root);
    const second = hashSourceTree(root);
    expect(first.hash).toBe(second.hash);
    expect(Object.keys(first.files).sort()).toEqual(["a/nested/one.ts", "b/two.ts"]);
  });

  it("changes when a byte changes", () => {
    const before = hashSourceTree(root).hash;
    writeFileSync(join(root, "b", "two.ts"), "export const two = 3;\n");
    expect(hashSourceTree(root).hash).not.toBe(before);
  });

  it("changes when a file moves, even though the bytes are unchanged", () => {
    const moved = mkdtempSync(join(tmpdir(), "drift-spec-moved-"));
    try {
      mkdirSync(join(moved, "b"), { recursive: true });
      writeFileSync(join(moved, "b", "renamed.ts"), "export const two = 3;\n");
      mkdirSync(join(moved, "a", "nested"), { recursive: true });
      writeFileSync(join(moved, "a", "nested", "one.ts"), "export const one = 1;\n");
      expect(hashSourceTree(moved).hash).not.toBe(hashSourceTree(root).hash);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });
});

describe("isDistStale", () => {
  it("ignores the sub-second spread a one-pass package copy leaves behind", () => {
    expect(isDistStale(1_000_000, 1_000_300)).toBe(false);
  });

  it("flags src edited well after the dist beside it was built", () => {
    expect(isDistStale(1_000_000, 1_000_000 + 60_000)).toBe(true);
  });

  it("is not stale when dist is newer than src", () => {
    expect(isDistStale(2_000_000, 1_000_000)).toBe(false);
  });

  it("says nothing when there is no dist to compare", () => {
    expect(isDistStale(0, 1_000_000)).toBe(false);
  });
});

describe("diffFileHashes", () => {
  it("splits added, removed, and changed", () => {
    expect(
      diffFileHashes({ keep: "a", gone: "b", edit: "c" }, { keep: "a", edit: "c2", fresh: "d" }),
    ).toEqual({ added: ["fresh"], removed: ["gone"], changed: ["edit"] });
  });
});

const DIST_HASHES = {
  "dist/worker.js": "def",
  "dist/manifest.js": "ghi",
  "dist/ui/index.js": "jkl",
};

const CLEAN_LIVE = {
  packageRoot: "/p/klipper-0.1.10",
  version: "0.1.10",
  sourceHash: "abc",
  files: { "worker.ts": "1" },
  distStale: false,
  distMtime: 2000,
  srcMtime: 1000,
  distHashes: { ...DIST_HASHES },
};
const CLEAN_REF = {
  name: "v0.1.10",
  isTag: true,
  version: "0.1.10",
  sourceHash: "abc",
  files: { "worker.ts": "1" },
  distHashes: { ...DIST_HASHES },
};

describe("compareInstall", () => {
  it("reports nothing when the running source is a tagged commit", () => {
    expect(compareInstall({ live: CLEAN_LIVE, ref: CLEAN_REF })).toEqual([]);
  });

  it("flags source drift with a per-file breakdown", () => {
    const live = { ...CLEAN_LIVE, sourceHash: "zzz", files: { "worker.ts": "2", "new.ts": "3" } };
    const findings = compareInstall({ live, ref: CLEAN_REF });
    const drift = findings.find((f: { code: string }) => f.code === "SOURCE_DRIFT");
    expect(drift.severity).toBe("error");
    expect(drift.detail).toEqual({ added: ["new.ts"], removed: [], changed: ["worker.ts"] });
  });

  it("treats an untagged comparison as an error even when the bytes match", () => {
    const findings = compareInstall({
      live: CLEAN_LIVE,
      ref: { ...CLEAN_REF, name: "origin/main", isTag: false },
    });
    expect(findings.map((f: { code: string }) => f.code)).toEqual(["NO_MATCHING_TAG"]);
  });

  it("flags a version mismatch separately from byte drift", () => {
    const findings = compareInstall({ live: { ...CLEAN_LIVE, version: "0.1.9" }, ref: CLEAN_REF });
    expect(findings.map((f: { code: string }) => f.code)).toContain("VERSION_MISMATCH");
  });

  it("warns when dist predates the src sitting beside it", () => {
    const live = { ...CLEAN_LIVE, distStale: true, distMtime: 1000, srcMtime: 2000 };
    const stale = compareInstall({ live, ref: CLEAN_REF }).find(
      (f: { code: string }) => f.code === "DIST_STALE",
    );
    expect(stale.severity).toBe("warn");
  });

  it("warns when the directory name reports a version the install is not (nested layout)", () => {
    const live = { ...CLEAN_LIVE, packageRoot: "/p/klipper-0.1.7/package" };
    const misleading = compareInstall({ live, ref: CLEAN_REF }).find(
      (f: { code: string }) => f.code === "DIR_NAME_MISLEADING",
    );
    expect(misleading.severity).toBe("warn");
    expect(misleading.message).toContain("0.1.7");
  });

  it("does not warn on a directory name with no version in it", () => {
    const live = { ...CLEAN_LIVE, packageRoot: "/home/x/some-plugin/package" };
    expect(compareInstall({ live, ref: CLEAN_REF })).toEqual([]);
  });

  it("flags dist drift when the running dist/ differs from the recorded hash", () => {
    const live = { ...CLEAN_LIVE, distHashes: { "dist/worker.js": "aaa" } };
    const ref = { ...CLEAN_REF, distHashes: { "dist/worker.js": "bbb" } };
    const drift = compareInstall({ live, ref }).find((f: { code: string }) => f.code === "DIST_DRIFT");
    expect(drift?.severity).toBe("error");
    expect(drift?.message).toContain("dist swap");
    expect(drift?.detail?.changed).toEqual(["dist/worker.js"]);
  });

  it("reports NO_DIST_ATTESTATION when the tag has no recorded dist hashes", () => {
    const live = { ...CLEAN_LIVE, distHashes: { "dist/worker.js": "aaa" } };
    const ref = { ...CLEAN_REF, distHashes: null };
    const finding = compareInstall({ live, ref }).find((f: { code: string }) => f.code === "NO_DIST_ATTESTATION");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("no recorded dist hashes");
  });

  it("reports DIST_MISSING when the live install has no dist/", () => {
    const live = { ...CLEAN_LIVE, distHashes: null };
    const ref = { ...CLEAN_REF, distHashes: { "dist/worker.js": "bbb" } };
    const finding = compareInstall({ live, ref }).find((f: { code: string }) => f.code === "DIST_MISSING");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("no dist/ to compare");
  });

  it("regression: dist swap with matching src/ is caught as DIST_DRIFT", () => {
    const live = {
      ...CLEAN_LIVE,
      sourceHash: CLEAN_REF.sourceHash,
      files: { ...CLEAN_REF.files },
      distHashes: { "dist/worker.js": "malicious_hash" },
    };
    const ref = { ...CLEAN_REF, distHashes: { "dist/worker.js": "trusted_hash" } };
    const findings = compareInstall({ live, ref });
    const drift = findings.find((f: { code: string }) => f.code === "DIST_DRIFT");
    expect(drift?.severity).toBe("error");
    expect(drift?.message).toContain("dist swap");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("warns (not errors) when the live install ships no src/ tree", () => {
    // Older packaging omitted src/ from the tarball. Without it, source
    // cannot be attested — but version / tag / dist findings still produce
    // a verdict. Treat the missing tree as a warning so the check exits 2
    // (drift) rather than 1 (could not determine).
    const live = { ...CLEAN_LIVE, sourceMissing: true, sourceHash: null as string | null, files: {} };
    const findings = compareInstall({ live, ref: CLEAN_REF });
    const finding = findings.find((f: { code: string }) => f.code === "NO_SOURCE_ATTESTATION");
    expect(finding?.severity).toBe("warn");
    expect(findings.some((f: { code: string }) => f.code === "SOURCE_DRIFT")).toBe(false);
  });
});

describe("readRecordedDistHashes", () => {
  it("parses a sha256sum-style dist.sha256 file", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-sha-"));
    try {
      writeFileSync(
        join(root, "dist.sha256"),
        "aaa  dist/worker.js\nbbb  dist/manifest.js\nccc  dist/ui/index.js\n",
      );
      expect(readRecordedDistHashes(root)).toEqual({
        "dist/worker.js": "aaa",
        "dist/manifest.js": "bbb",
        "dist/ui/index.js": "ccc",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when no dist.sha256 exists (older tag)", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-no-sha-"));
    try {
      expect(readRecordedDistHashes(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
