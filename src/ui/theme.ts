/**
 * Module-local design helpers for the Klipper page UI (see §6.4).
 *
 * The host CSS-modules toolchain isn't wired through esbuild for plugin
 * bundles, so per the UX spec we keep all spacing/sizing/typography
 * primitives in one place rather than scattering bare `style={{ … }}`
 * literals across components. If the SDK ever ships a token surface
 * (R1.1), migrate here first.
 */
import type { CSSProperties } from "react";

/** 4px grid — `sp(2)` → `"8px"`, `sp(3)` → `"12px"`, etc. */
export const sp = (n: number): string => `${n * 4}px`;

/** Minimum tap target floor (WCAG / Apple HIG). */
export const TAP_TARGET_MIN = "44px";

export const fontSize = {
  sm: "12px",
  base: "14px",
  md: "16px",
  lg: "18px",
} as const;

export const stack = (gap: number = 3): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  gap: sp(gap),
});

export const row = (gap: number = 2): CSSProperties => ({
  display: "flex",
  flexDirection: "row",
  gap: sp(gap),
  alignItems: "center",
});

export const muted: CSSProperties = {
  opacity: 0.7,
  fontSize: fontSize.sm,
};

/** Visually-hidden, screen-reader-accessible. */
export const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  borderWidth: 0,
};
