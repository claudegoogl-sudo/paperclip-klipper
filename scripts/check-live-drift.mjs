#!/usr/bin/env node
/**
 * Live-install drift detector.
 *
 * Answers one question: is the plugin source that is *currently running*
 * identical to a tagged commit on `main`?
 *
 * The running install is resolved from the live worker process's argv, not
 * from the newest `plugin-packages/` directory. Directory names are not
 * trustworthy — an in-place dist swap leaves the old version in the path, and
 * a packaged install whose outer directory is named for an old version (the
 * layout this plugin ships in) will report a version it has not been for
 * several releases.
 *
 * Exit codes: 0 clean, 2 drift, 1 could not determine (treat as drift).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** Files whose bytes define "the source that is running". */
const SOURCE_DIR = "src";

/**
 * A packaged install is written in one pass, so its files land within a second
 * of each other in whatever order the copy walked them. Only treat dist/ as
 * stale when src/ is newer by more than that, or every fresh install reports a
 * phantom staleness purely from file-copy ordering.
 */
const DIST_STALE_TOLERANCE_MS = 5000;

/**
 * Files in dist/ whose hashes are recorded at release time and compared at
 * check time. worker.js needs path-comment normalization; the others are
 * byte-identical across builds.
 */
export const DIST_HASH_PATHS = ["dist/worker.js", "dist/manifest.js", "dist/ui/index.js"];

/**
 * Normalise esbuild's embedded module-path comments.
 *
 * esbuild embeds `// <cwd>` comments at module boundaries, which differ between
 * builds from different working directories or package managers. This regex
 * normalises them to `// <basename>` so the hash is reproducible.
 */
export function normaliseEsbuildComments(content) {
  return content.replace(/^(\s*)\/\/ .+\/(node_modules\/.*)$/gm, "$1// $2");
}

/**
 * Hash a dist file, with normalization for worker.js.
 *
 * worker.js contains esbuild path comments that differ between build environments.
 * Normalize those away before hashing. Other dist files are byte-identical.
 */
export function hashDistFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const normalised = filePath.endsWith("worker.js") ? normaliseEsbuildComments(content) : content;
  return createHash("sha256").update(normalised).digest("hex");
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Walk up from a worker.js path to the nearest directory whose `package.json`
 * has both `name` and `version`. Returns `null` if none is found before the
 * filesystem root.
 *
 * The packaged install for this plugin uses a nested layout
 * (`<dir>/package/dist/worker.js`) where the outer directory may also contain
 * a `package.json` lacking a `version` field. A fixed two-level walk would
 * silently anchor on whichever level the layout happened to put first, so we
 * probe each ancestor instead. Matching the plugin by `name` (not by directory
 * name) keeps a misleading directory name from producing a false exit 1.
 */
export function resolvePackageRoot(workerPath) {
  let dir = dirname(workerPath);
  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg && typeof pkg.name === "string" && typeof pkg.version === "string") {
          return dir;
        }
      } catch {
        // fall through — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Parse `ps` output into worker-process candidates, without touching the
 * filesystem. Pure string parsing so it can be unit-tested in isolation.
 *
 * A worker command line looks like one of:
 *   /usr/bin/node /path/to/plugin-packages/<dir>/dist/worker.js          (flat)
 *   /usr/bin/node /path/to/plugin-packages/<dir>/package/dist/worker.js  (nested)
 */
export function extractWorkerCandidates(psText) {
  const out = [];
  for (const line of String(psText).split("\n")) {
    const match = line.match(/(\S+\/dist\/worker\.js)(?:\s|$)/);
    if (!match) continue;
    const pidMatch = line.trim().match(/^\S+\s+(\d+)\s/) ?? line.trim().match(/^(\d+)\s/);
    out.push({
      pid: pidMatch ? Number(pidMatch[1]) : null,
      workerPath: match[1],
    });
  }
  return out;
}

/**
 * Parse `ps` output into the plugin worker processes it describes, resolving
 * each candidate's package root by walking up to the nearest package.json
 * with both `name` and `version`. The directory name is never used.
 */
export function parseWorkerProcesses(psText) {
  return extractWorkerCandidates(psText).map((c) => ({
    pid: c.pid,
    workerPath: c.workerPath,
    packageRoot: resolvePackageRoot(c.workerPath),
  }));
}

/** Newest `vX.Y.Z` tag by numeric precedence. Non-conforming tags are ignored. */
export function pickNewestVersionTag(tags) {
  const parsed = [];
  for (const tag of tags) {
    const m = String(tag).trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);
    if (!m) continue;
    parsed.push({ tag: m[0], parts: [Number(m[1]), Number(m[2]), Number(m[3])] });
  }
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  return parsed[0].tag;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join("/"));
  }
  return out;
}

/**
 * Content hash of a source tree: sha256 over `path\0sha256(bytes)\n` for every
 * file, in sorted path order. Path-sensitive, so a renamed-but-identical file
 * still registers as drift.
 */
export function hashSourceTree(root) {
  const files = {};
  for (const rel of walk(root)) {
    files[rel] = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
  }
  const composite = createHash("sha256");
  for (const rel of Object.keys(files).sort()) composite.update(`${rel}\0${files[rel]}\n`);
  return { hash: composite.digest("hex"), files };
}

/** True when src/ is newer than the dist/ built from it by more than copy-ordering noise. */
export function isDistStale(distMtime, srcMtime, toleranceMs = DIST_STALE_TOLERANCE_MS) {
  if (!distMtime) return false;
  return srcMtime - distMtime > toleranceMs;
}

/** Per-file breakdown of two `hashSourceTree` results. */
export function diffFileHashes(refFiles, liveFiles) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const rel of Object.keys(liveFiles)) {
    if (!(rel in refFiles)) added.push(rel);
    else if (refFiles[rel] !== liveFiles[rel]) changed.push(rel);
  }
  for (const rel of Object.keys(refFiles)) {
    if (!(rel in liveFiles)) removed.push(rel);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * Read the recorded dist hashes from a dist.sha256 file in an extracted directory.
 * Returns null if the file does not exist (older tags).
 */
export function readRecordedDistHashes(extractedDir) {
  const sha256Path = join(extractedDir, "dist.sha256");
  if (!existsSync(sha256Path)) return null;
  const content = readFileSync(sha256Path, "utf8");
  const hashes = {};
  for (const line of content.trim().split("\n")) {
    const [hash, path] = line.split("  ");
    if (hash && path) hashes[path] = hash;
  }
  return hashes;
}

/**
 * Hash the dist files in a live install.
 */
export function hashLiveDist(packageRoot) {
  const hashes = {};
  for (const rel of DIST_HASH_PATHS) {
    const fullPath = join(packageRoot, rel);
    if (!existsSync(fullPath)) continue;
    try {
      hashes[rel] = hashDistFile(fullPath);
    } catch (e) {
      // If we can't hash a file, skip it — absence will be caught in comparison.
    }
  }
  return hashes;
}

/**
 * Compare a live install against a git ref. Returns findings ordered
 * most-severe first. `error` findings mean the running system is not
 * attested by any commit; `warn` findings are hygiene problems that do not
 * by themselves prove the code differs.
 */
export function compareInstall({ live, ref }) {
  const findings = [];

  if (live.sourceMissing) {
    findings.push({
      severity: "warn",
      code: "NO_SOURCE_ATTESTATION",
      message:
        `Live install ships no src/ tree, so its source cannot be attested. ` +
        `Install a release that includes src/ to enable source attestation.`,
    });
  } else if (live.sourceHash !== ref.sourceHash) {
    findings.push({
      severity: "error",
      code: "SOURCE_DRIFT",
      message: `Running src/ does not match ${ref.name}.`,
      detail: diffFileHashes(ref.files, live.files),
    });
  }

  // Compare dist hashes if they were recorded at release time.
  if (ref.distHashes !== null) {
    if (live.distHashes === null) {
      findings.push({
        severity: "error",
        code: "DIST_MISSING",
        message: `Live install has no dist/ to compare against recorded hashes.`,
      });
    } else {
      const distDiff = diffFileHashes(ref.distHashes, live.distHashes);
      if (distDiff.changed.length > 0 || distDiff.added.length > 0 || distDiff.removed.length > 0) {
        findings.push({
          severity: "error",
          code: "DIST_DRIFT",
          message: `Running dist/ does not match ${ref.name}. An in-place dist swap cannot be ruled out.`,
          detail: distDiff,
        });
      }
    }
  } else {
    // Older tags don't have dist hashes recorded — we can't attest the running bytes.
    findings.push({
      severity: "error",
      code: "NO_DIST_ATTESTATION",
      message:
        `Tag ${ref.name} has no recorded dist hashes. The running binary cannot be attested. ` +
        `Rebuild from this tag to verify the binary.`,
    });
  }
  if (live.version !== ref.version) {
    findings.push({
      severity: "error",
      code: "VERSION_MISMATCH",
      message: `Live version ${live.version} != ${ref.name} version ${ref.version}.`,
    });
  }
  if (!ref.isTag) {
    findings.push({
      severity: "error",
      code: "NO_MATCHING_TAG",
      message:
        `No version tag on main matches the live version ${live.version}; ` +
        `compared against ${ref.name} instead. A tag is what makes the running ` +
        `code attestable.`,
    });
  }
  if (live.distStale) {
    findings.push({
      severity: "warn",
      code: "DIST_STALE",
      message:
        `Live dist/ is older than live src/ (dist ${new Date(live.distMtime).toISOString()} < ` +
        `src ${new Date(live.srcMtime).toISOString()}). The running bytes may predate the source beside them.`,
    });
  }
  // Look at both the package root's basename and its parent's basename so a
  // misleading directory name is caught regardless of layout. Flat installs
  // carry the version in `basename(packageRoot)`; nested installs
  // (`<dir>/package`) carry it in the parent directory name.
  const dirComponents = [basename(live.packageRoot), basename(dirname(live.packageRoot))];
  const dirVersion = dirComponents
    .map((c) => c.match(/(\d+\.\d+\.\d+)/)?.[1])
    .find((v) => v && v !== live.version);
  if (dirVersion) {
    findings.push({
      severity: "warn",
      code: "DIR_NAME_MISLEADING",
      message:
        `Package directory is named for ${dirVersion} but contains ${live.version}. ` +
        `Do not infer the live version from the directory name.`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  const res = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", ...opts });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || "").trim()}`);
  }
  return res.stdout;
}

function newestMtime(root) {
  let newest = 0;
  for (const rel of walk(root)) {
    const m = statSync(join(root, rel)).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

function readLiveInstall(packageRoot, pid) {
  const pkgPath = join(packageRoot, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`No package.json at ${packageRoot}`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const srcRoot = join(packageRoot, SOURCE_DIR);
  const distRoot = join(packageRoot, "dist");
  const distMtime = existsSync(distRoot) ? newestMtime(distRoot) : 0;
  const distHashes = existsSync(distRoot) ? hashLiveDist(packageRoot) : null;
  if (!existsSync(srcRoot)) {
    // Older packaging did not ship src/ in the install. Without it, source
    // cannot be attested — but we can still attest the dist (and surface
    // version / tag / directory-name findings). Treat the missing tree as a
    // distinct signal rather than a fatal error so the check still produces
    // a verdict.
    return {
      pid,
      packageRoot,
      name: pkg.name,
      version: pkg.version,
      sourceHash: null,
      files: {},
      sourceMissing: true,
      distMtime,
      srcMtime: 0,
      distStale: false,
      distHashes,
    };
  }
  const { hash, files } = hashSourceTree(srcRoot);
  const srcMtime = newestMtime(srcRoot);
  return {
    pid,
    packageRoot,
    name: pkg.name,
    version: pkg.version,
    sourceHash: hash,
    files,
    sourceMissing: false,
    distMtime,
    srcMtime,
    distStale: isDistStale(distMtime, srcMtime),
    distHashes,
  };
}

/** Materialise a ref's source tree in a temp dir so both sides hash identically. */
function readRefInstall(refName, isTag) {
  const dir = mkdtempSync(join(tmpdir(), "drift-ref-"));
  try {
    const archive = spawnSync("git", ["archive", "--format=tar", refName, SOURCE_DIR, "package.json"], {
      cwd: REPO_ROOT,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (archive.status !== 0) {
      throw new Error(`git archive ${refName} failed: ${archive.stderr?.toString().trim()}`);
    }
    const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
    if (untar.status !== 0) throw new Error(`tar extract failed for ${refName}`);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const { hash, files } = hashSourceTree(join(dir, SOURCE_DIR));
    const distHashes = readRecordedDistHashes(dir);
    return { name: refName, isTag, version: pkg.version, sourceHash: hash, files, distHashes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function resolveLivePackageRoot(expectedName, explicitPath) {
  if (explicitPath) return { packageRoot: resolve(explicitPath), pid: null };
  const ps = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error("could not run `ps` to locate the live worker process");
  const candidates = parseWorkerProcesses(ps.stdout).filter((c) => {
    if (!c.packageRoot) return false;
    const pkgPath = join(c.packageRoot, "package.json");
    if (!existsSync(pkgPath)) return false;
    try {
      return JSON.parse(readFileSync(pkgPath, "utf8")).name === expectedName;
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) {
    throw new Error(
      `No running worker process for ${expectedName}. The plugin is not live here, ` +
        `or it runs on another host. Pass --live <package-root> to check a path directly.`,
    );
  }
  return candidates[0];
}

function parseArgs(argv) {
  const opts = { json: false, strict: false, live: null, ref: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--live") opts.live = argv[++i];
    else if (a === "--ref") opts.ref = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const repoPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  const { packageRoot, pid } = resolveLivePackageRoot(repoPkg.name, opts.live);
  const live = readLiveInstall(packageRoot, pid);

  let refName = opts.ref;
  let isTag = false;
  if (!refName) {
    const tags = git(["tag", "--list", "--merged", "origin/main"]).split("\n");
    const liveTag = tags.map((t) => t.trim()).find((t) => t === `v${live.version}`);
    if (liveTag) {
      refName = liveTag;
      isTag = true;
    } else {
      refName = pickNewestVersionTag(tags) ?? "origin/main";
      isTag = false;
    }
  } else {
    isTag = /^v\d+\.\d+\.\d+$/.test(refName);
  }
  const ref = readRefInstall(refName, isTag);

  const findings = compareInstall({ live, ref });
  const errors = findings.filter((f) => f.severity === "error" || (opts.strict && f.severity === "warn"));
  const ok = errors.length === 0;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          live: {
            pid: live.pid,
            packageRoot: live.packageRoot,
            version: live.version,
            sourceHash: live.sourceHash,
            distHashes: live.distHashes,
          },
          ref: { name: ref.name, isTag: ref.isTag, version: ref.version, sourceHash: ref.sourceHash, distHashes: ref.distHashes },
          findings,
        },
        null,
        2,
      ),
    );
  } else {
    const tag = "[check-live-drift]";
    console.log(`${tag} live  : ${live.version} @ ${live.packageRoot}${live.pid ? ` (pid ${live.pid})` : ""}`);
    console.log(`${tag} ref   : ${ref.version} @ ${ref.name}${ref.isTag ? " (tag)" : " (NOT a tag)"}`);
    console.log(`${tag} sha256: live ${live.sourceHash.slice(0, 16)} / ref ${ref.sourceHash.slice(0, 16)}`);
    for (const f of findings) {
      console.log(`${tag} ${f.severity.toUpperCase()} ${f.code}: ${f.message}`);
      if (f.detail) {
        const detailPrefix = f.code === "DIST_DRIFT" ? "dist/" : `${SOURCE_DIR}/`;
        for (const kind of ["changed", "added", "removed"]) {
          for (const file of f.detail[kind]) console.log(`${tag}     ${kind}: ${detailPrefix}${file}`);
        }
      }
    }
    console.log(ok ? `${tag} OK — running source is attested by ${ref.name}.` : `${tag} DRIFT.`);
  }
  return ok ? 0 : 2;
}

const isDirectInvocation = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`[check-live-drift] could not determine drift state: ${err.message}`);
    process.exit(1);
  }
}
