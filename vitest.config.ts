import { defineConfig } from "vitest/config";

export default defineConfig({
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
