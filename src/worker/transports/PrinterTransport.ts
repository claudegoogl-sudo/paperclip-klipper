/**
 * PrinterTransport — the seam between the RPC surface (tools / data /
 * actions) and a printer's control API.
 *
 * Moonraker was the plugin's only transport; the FlashForge Creator 5 runs
 * closed firmware with no Moonraker, so the operations the RPC surface needs
 * are now named by this interface and each transport implements them.
 * `MoonrakerClient` satisfies the interface structurally (its method set is
 * the superset the surface was written against); `FlashForgeClient`
 * implements the same operations against the Creator 5 LAN-only HTTP API.
 *
 * Optional members are operations a transport cannot support — the RPC
 * surface surfaces a clear "not supported by this transport" error instead
 * of silently faking them.
 */
import type {
  ConnectionStateSnapshot,
  FileListEntry,
  FileMetadata,
  MoonrakerStatusSnapshot,
  PrinterInfo,
} from "../MoonrakerClient.js";

export type PrinterTransportKind = "moonraker" | "flashforge";

/** Result shape of a G-code upload (mirrors Moonraker's /server/files/upload). */
export interface GcodeUploadResult {
  item: { path: string; root: string; size: number; modified: number };
  print_started?: boolean;
}

/** Fresh, on-demand reachability report for health checks. */
export interface TransportHealthReport {
  /** False for refused / timeout / 5xx / non-JSON / envelope-error replies. */
  reachable: boolean;
  /** Short human-readable state or failure reason; never credential material. */
  message: string;
  /** Transport-specific extras (machine state, firmware, error code). */
  details?: Record<string, unknown>;
}

export interface PrinterTransport {
  /** Which transport this instance implements. */
  readonly kind: PrinterTransportKind;
  /**
   * Swap in a freshly resolved transport credential (the worker resolves
   * the configured secret ref once per config application and pushes the
   * value here). `null` means "unauthenticated" (Moonraker without an API
   * key). Implementations hold the value in memory only and must never log
   * it. Transports NEVER resolve credentials themselves: a client that
   * called `ctx.secrets.resolve` from its background loop (status poll, WS
   * reconnect, UI data keys) would fire worker→host RPCs with no dispatch
   * in flight, which the host's single-in-flight attribution permanently
   * denies — poisoning the method for the worker's lifetime.
   */
  applyCredential(credential: string | null): void;
  /** Current connection state, cheap to read. */
  getConnectionState(): ConnectionStateSnapshot;
  /**
   * Query printer objects (Moonraker /printer/objects/query). Transports
   * without an object model throw a clear unsupported error.
   */
  queryObjects(
    objects: Record<string, string[] | null>,
  ): Promise<Record<string, Record<string, unknown>>>;
  /**
   * Latest status snapshot in the Moonraker-compatible shape the dashboard
   * renders (`objects.print_stats`, `extruder`, `heater_bed`,
   * `virtual_sdcard`, `display_status`). Poll-based transports keep this
   * warm via their own update loop.
   */
  getStatusSnapshot(): MoonrakerStatusSnapshot;
  /** Printer identification / firmware info. */
  getPrinterInfo(): Promise<PrinterInfo>;
  /** List G-code files known to the printer. */
  listFiles(root?: string): Promise<FileListEntry[]>;
  /**
   * Upload G-code bytes. `options.path` (a virtual_sdcard subdirectory) is a
   * Moonraker-only concept; transports that have no subdirectory support
   * must REJECT a non-empty `path` with a clear error rather than ignore it.
   */
  uploadGcode(
    filename: string,
    payload: Uint8Array | Blob,
    options?: { path?: string; root?: string },
  ): Promise<GcodeUploadResult>;
  /** Start a print of an already-uploaded file. */
  startPrint(filename: string): Promise<string>;
  pausePrint(): Promise<string>;
  resumePrint(): Promise<string>;
  cancelPrint(): Promise<string>;
  /** Open the live update loop (WS or poll). Safe to call once per client. */
  start(): Promise<void>;
  /** Restart the loop after a `failed` connection state (UI affordance). */
  retryConnection(): Promise<void>;
  /** Tear the client down; no further requests are issued after stop(). */
  stop(): void;

  // ── Operations a transport may not support ─────────────────────────────
  // These are interface-required so callers stay type-safe; transports
  // without the operation throw a clear "not supported" error.
  /** Per-file metadata. FlashForge's LAN API has no metadata endpoint. */
  getFileMetadata(filename: string): Promise<FileMetadata>;
  /** Delete a stored file. FlashForge's LAN API has no delete endpoint. */
  deleteFile(path: string, root?: string): Promise<{ item: { path: string; root: string } }>;
  /**
   * On-demand reachability probe for health checks. Implementations MUST
   * issue a fresh request (never answer from cache — a stale "ok" is exactly
   * what fail-closed health exists to prevent) and MUST NOT throw; every
   * failure mode reports `reachable: false`.
   */
  probeHealth?(): Promise<TransportHealthReport>;
}
