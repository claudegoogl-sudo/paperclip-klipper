import { describe, expect, it } from "vitest";
import {
  estimateRemainingSeconds,
  firstInlineThumbnailDataUrl,
  formatBytes,
  formatDuration,
  formatRelativeTime,
  trimErrorMessage,
  truncateFilename,
} from "../../src/ui/format.js";

describe("format helpers", () => {
  describe("formatBytes", () => {
    it("returns em-dash for null/negative/invalid", () => {
      expect(formatBytes(null)).toBe("—");
      expect(formatBytes(undefined)).toBe("—");
      expect(formatBytes(-1)).toBe("—");
      expect(formatBytes(Number.NaN)).toBe("—");
    });

    it("formats bytes, KB, and MB to one decimal", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1.2 * 1024 * 1024)).toBe("1.2 MB");
      expect(formatBytes(100 * 1024 * 1024)).toBe("100 MB");
    });
  });

  describe("formatRelativeTime", () => {
    const now = new Date("2026-05-22T12:00:00Z");

    it("returns em-dash for null/undefined", () => {
      expect(formatRelativeTime(null, now)).toBe("—");
      expect(formatRelativeTime(undefined, now)).toBe("—");
    });

    it("returns 'just now' for < 30 seconds", () => {
      const epoch = now.getTime() / 1000 - 10;
      expect(formatRelativeTime(epoch, now)).toBe("just now");
    });

    it("returns absolute date for ≥ 7 days", () => {
      const sevenDaysAgo = now.getTime() / 1000 - 86400 * 30;
      const out = formatRelativeTime(sevenDaysAgo, now);
      expect(out).not.toMatch(/ago/);
      // Locale-dependent — just assert it contains a 4-digit year.
      expect(out).toMatch(/\d{4}/);
    });

    it("returns a relative phrase for a value in the last hour", () => {
      const fiveMinAgo = now.getTime() / 1000 - 300;
      expect(formatRelativeTime(fiveMinAgo, now)).toMatch(/min/);
    });
  });

  describe("formatDuration", () => {
    it("returns em-dash for invalid input", () => {
      expect(formatDuration(null)).toBe("—");
      expect(formatDuration(-5)).toBe("—");
      expect(formatDuration(Number.NaN)).toBe("—");
    });

    it("formats sub-minute, minute-only and hour+minute durations", () => {
      expect(formatDuration(15)).toBe("<1m");
      expect(formatDuration(60)).toBe("1m");
      expect(formatDuration(45 * 60)).toBe("45m");
      expect(formatDuration(60 * 60 + 23 * 60)).toBe("1h 23m");
    });
  });

  describe("estimateRemainingSeconds", () => {
    it("returns null for invalid elapsed or low progress", () => {
      expect(estimateRemainingSeconds(null, 0.5)).toBe(null);
      expect(estimateRemainingSeconds(100, null)).toBe(null);
      expect(estimateRemainingSeconds(100, 0)).toBe(null);
      expect(estimateRemainingSeconds(100, 0.01)).toBe(null);
    });

    it("returns 0 once progress is at or above 1", () => {
      expect(estimateRemainingSeconds(100, 1)).toBe(0);
      expect(estimateRemainingSeconds(100, 1.2)).toBe(0);
    });

    it("scales remaining time with progress", () => {
      // 50% progress in 30 minutes → 30 more minutes left.
      expect(estimateRemainingSeconds(30 * 60, 0.5)).toBeCloseTo(30 * 60, 1);
    });
  });

  describe("truncateFilename", () => {
    it("returns the input when short enough", () => {
      expect(truncateFilename("benchy.gcode", 32)).toBe("benchy.gcode");
    });

    it("truncates mid-string and preserves the extension", () => {
      const long = "this-is-a-very-long-file-name-for-printing.gcode";
      const out = truncateFilename(long, 24);
      expect(out.length).toBeLessThanOrEqual(24);
      expect(out.endsWith(".gcode")).toBe(true);
      expect(out).toContain("…");
    });
  });

  describe("trimErrorMessage", () => {
    it("returns empty string for null/undefined", () => {
      expect(trimErrorMessage(null)).toBe("");
      expect(trimErrorMessage(undefined)).toBe("");
    });

    it("trims long strings and appends an ellipsis", () => {
      const long = "x".repeat(200);
      const out = trimErrorMessage(long, 50);
      expect(out.length).toBe(50);
      expect(out.endsWith("…")).toBe(true);
    });
  });

  describe("firstInlineThumbnailDataUrl", () => {
    it("returns null when no thumbnails", () => {
      expect(firstInlineThumbnailDataUrl(undefined)).toBe(null);
      expect(firstInlineThumbnailDataUrl([])).toBe(null);
    });

    it("returns null when only relative_path is provided", () => {
      expect(
        firstInlineThumbnailDataUrl([{ width: 32, height: 32, size: 4, relative_path: "foo.png" }]),
      ).toBe(null);
    });

    it("picks the largest inline thumbnail", () => {
      const url = firstInlineThumbnailDataUrl([
        { width: 32, height: 32, size: 4, data: "AAAA" },
        { width: 240, height: 240, size: 16, data: "BBBB" },
      ]);
      expect(url).toBe("data:image/png;base64,BBBB");
    });
  });
});
