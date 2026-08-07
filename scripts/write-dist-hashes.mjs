#!/usr/bin/env node
/**
 * Generate dist.sha256 for release attestation.
 *
 * Hashes the dist/ files that execute at runtime so check-live-drift can
 * attest the running binary against the tagged commit.
 *
 * Run after `npm run build` and before creating the release tag.
 *
 * Usage:
 *   node scripts/write-dist-hashes.mjs
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashDistFile, DIST_HASH_PATHS } from "./check-live-drift.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);

const hashes = [];
for (const rel of DIST_HASH_PATHS) {
  const fullPath = join(REPO_ROOT, rel);
  try {
    const hash = hashDistFile(fullPath);
    hashes.push(`${hash}  ${rel}`);
    console.log(`${rel}: ${hash}`);
  } catch (e) {
    console.error(`Error hashing ${rel}: ${e.message}`);
    process.exit(1);
  }
}

writeFileSync(join(REPO_ROOT, "dist.sha256"), hashes.join("\n") + "\n");
console.log(`\nWrote dist.sha256 with ${hashes.length} entries.`);
