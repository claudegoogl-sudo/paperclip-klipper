/**
 * Stream channel name the worker emits status + connection snapshots on
 * and the UI subscribes to via `usePluginStream`.
 *
 * Kept in its own module so the UI bundle can import the constant without
 * pulling the Node-only worker entry (which calls `runWorker(...)` at the
 * top level) into the browser build. `src/worker.ts` re-exports it so
 * consumers can also `import { STREAM_CHANNEL } from "./worker.js"`.
 */
export const STREAM_CHANNEL = "klipper";
