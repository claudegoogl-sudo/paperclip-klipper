/**
 * Local minimal implementations of the shared SDK components the UX spec
 * asks for (StatusBadge / KeyValueList / Spinner / ErrorBoundary).
 *
 * **Why local:** `@paperclipai/plugin-sdk/ui/components.d.ts` declares
 * `StatusBadge`, `KeyValueList`, `Spinner`, `ErrorBoundary` etc., and a
 * runtime exists in `dist/ui/components.js`, but neither the package
 * `exports` map (`./ui`, `./ui/hooks`, `./ui/types`) nor the `./ui` index
 * re-exports them. Plugin bundles therefore cannot import them. This is a
 * real SDK gap — a follow-up against R1.1 (Plugin SDK gap analysis) will
 * cover (a) re-exporting them from `@paperclipai/plugin-sdk/ui` and (b)
 * adding `./ui/components` to the exports map.
 *
 * The local implementations match the SDK type contracts so a future
 * delete-and-replace import swap (when the SDK gap is closed) is trivial.
 * Visuals are intentionally neutral — host design tokens take over if a
 * plugin bundle is loaded into the host frame; standalone smoke renders
 * stay legible.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { fontSize, sp } from "./theme.js";

export type StatusBadgeVariant = "ok" | "warning" | "error" | "info" | "pending";

export interface StatusBadgeProps {
  label: string;
  status: StatusBadgeVariant;
}

const STATUS_PALETTE: Record<StatusBadgeVariant, { bg: string; fg: string }> = {
  ok: { bg: "rgba(16, 185, 129, 0.12)", fg: "#065f46" },
  warning: { bg: "rgba(245, 158, 11, 0.14)", fg: "#92400e" },
  error: { bg: "rgba(220, 38, 38, 0.12)", fg: "#991b1b" },
  info: { bg: "rgba(37, 99, 235, 0.12)", fg: "#1e3a8a" },
  pending: { bg: "rgba(107, 114, 128, 0.14)", fg: "#374151" },
};

export function StatusBadge({ label, status }: StatusBadgeProps) {
  const { bg, fg } = STATUS_PALETTE[status];
  return (
    <span
      role="status"
      data-status={status}
      data-testid="sdk-status-badge"
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${sp(1)} ${sp(2)}`,
        borderRadius: "999px",
        background: bg,
        color: fg,
        fontSize: fontSize.sm,
        lineHeight: 1.3,
        fontWeight: 500,
      }}
    >
      {label}
    </span>
  );
}

export interface KeyValuePair {
  label: string;
  value: ReactNode;
}

export interface KeyValueListProps {
  pairs: KeyValuePair[];
}

export function KeyValueList({ pairs }: KeyValueListProps) {
  return (
    <dl
      data-testid="sdk-keyvalue-list"
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        gap: `${sp(1)} ${sp(3)}`,
      }}
    >
      {pairs.map((p, i) => (
        <div key={`${p.label}-${i}`} style={{ display: "contents" }}>
          <dt style={{ fontSize: fontSize.sm, opacity: 0.7 }}>{p.label}</dt>
          <dd
            style={{ margin: 0, fontSize: fontSize.sm, fontVariantNumeric: "tabular-nums" }}
            data-testid={`sdk-keyvalue-${p.label}`}
          >
            {p.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  label?: string;
}

const SPINNER_DIM = { sm: 14, md: 20, lg: 28 } as const;

export function Spinner({ size = "md", label }: SpinnerProps) {
  const dim = SPINNER_DIM[size];
  return (
    <span
      role="status"
      aria-label={label ?? "Loading"}
      data-testid="sdk-spinner"
      style={{
        display: "inline-block",
        width: `${dim}px`,
        height: `${dim}px`,
        border: "2px solid currentColor",
        borderRightColor: "transparent",
        borderRadius: "50%",
        opacity: 0.7,
        animation: "klipper-spin 0.8s linear infinite",
      }}
    />
  );
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.props.onError) this.props.onError(error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div role="alert" data-testid="sdk-error-fallback" style={{ padding: sp(3) }}>
          <StatusBadge label="Something went wrong" status="error" />
          <p style={{ marginTop: sp(2), fontSize: fontSize.sm, opacity: 0.8 }}>
            {this.state.error.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
