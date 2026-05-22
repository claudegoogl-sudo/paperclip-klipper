/**
 * PLA-376 — regression coverage for the release-time manifest gate.
 * Proves the gate catches the v0.1.1 incident shape (a tool name
 * containing ':') and accepts the dot/hyphen/underscore lowercase forms
 * the host validator allows.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs has no .d.ts; the helper is plain JS by design
import { validateManifest } from "../scripts/validate-manifest.mjs";

function fixture(toolName: string) {
  return {
    id: "platform.paperclip-klipper",
    apiVersion: 1 as const,
    version: "0.1.0",
    displayName: "Klipper",
    description: "fixture for PLA-376 regression coverage",
    author: "Platform",
    categories: ["connector"] as const,
    capabilities: ["agent.tools.register"] as const,
    entrypoints: { worker: "./dist/worker.js" },
    tools: [
      {
        name: toolName,
        displayName: "Tool",
        description: "fixture tool",
        parametersSchema: { type: "object" },
      },
    ],
  };
}

describe("validate-manifest gate (PLA-376)", () => {
  it("rejects a manifest with a colon in tools[].name (the v0.1.1 incident)", () => {
    const result = validateManifest(fixture("bad:name"));
    expect(result.ok).toBe(false);
  });

  it("accepts dotted, hyphenated, and underscored lowercase names", () => {
    for (const good of ["run.script", "do-thing", "do_thing", "x"]) {
      const result = validateManifest(fixture(good));
      expect(result.ok, `expected ok for ${JSON.stringify(good)}`).toBe(true);
    }
  });
});
