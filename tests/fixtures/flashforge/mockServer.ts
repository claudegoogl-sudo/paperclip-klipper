/**
 * In-process mock FlashForge printer (Creator 5 LAN-only HTTP API).
 *
 * Implements the endpoint subset the FlashForgeClient uses, with the exact
 * shapes derived from the community reference client (GhostTypes/ff-5mp-api-py):
 *   - POST /detail     — {serialNumber, checkCode} body → {code, detail}
 *   - POST /gcodeList  — {serialNumber, checkCode} body → {code, gcodeList}
 *   - POST /uploadGcode— multipart `gcodeFile` + auth/metadata headers
 *   - POST /printGcode — {serialNumber, checkCode, fileName, …} body
 *   - POST /control    — {serialNumber, checkCode, payload:{cmd,args}} body
 *
 * Success envelope mirrors the firmware: HTTP 200 + `code` 0 (or 200).
 *
 * Test-side affordances:
 *   - `recordedRequests` — every request (method, url, lowercased headers,
 *     raw body) for assertions.
 *   - strict auth by default: JSON bodies and upload headers must carry the
 *     configured serialNumber + checkCode or the printer answers with the
 *     firmware's auth-failure envelope (code 1).
 *   - `setDetail(payload)` — swap the /detail answer (state changes).
 *   - `failureMode` — "none" | "http500" | "drop" to exercise the
 *     fail-closed paths (5xx, connection reset).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedFlashForgeRequest {
  method: string;
  url: string;
  /** Node lowercases header names on intake. */
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

export type FlashForgeFailureMode = "none" | "http500" | "drop";

export interface MockFlashForgeOptions {
  /** Required serial number (Device ID). Requests must match it. */
  serialNumber?: string;
  /** Required check code. Requests must match it. */
  checkCode?: string;
  /** Initial /detail payload (defaults to a ready Creator 5). */
  detail?: Record<string, unknown>;
  /** Files reported by /gcodeList. */
  gcodeList?: string[];
  /** Injected failure behavior for every endpoint. Default "none". */
  failureMode?: FlashForgeFailureMode;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export class MockFlashForge {
  private server: Server | null = null;
  private port = 0;
  public readonly recordedRequests: RecordedFlashForgeRequest[] = [];
  public readonly uploadedFiles: Array<{ filename: string; size: number; headers: Record<string, string | string[] | undefined> }> = [];
  public readonly printJobs: string[] = [];
  public readonly jobControlCommands: string[] = [];
  public failureMode: FlashForgeFailureMode;

  private detail: Record<string, unknown>;
  private readonly serialNumber: string;
  private readonly checkCode: string;
  private readonly gcodeList: string[];

  constructor(private readonly options: MockFlashForgeOptions = {}) {
    this.serialNumber = options.serialNumber ?? "SN-TEST-C5";
    this.checkCode = options.checkCode ?? "CHECK-CODE-TEST";
    this.detail =
      options.detail ?? {
        code: 0,
        message: "success",
        detail: {
          status: "ready",
          name: "Creator 5",
          model: "Creator 5",
          pid: 40,
          firmwareVersion: "1.9.2",
          printFileName: "",
          printProgress: 0,
          estimatedTime: 0,
          printDuration: 0,
          platTemp: 24.5,
          platTargetTemp: 0,
          rightTemp: 25.1,
          rightTargetTemp: 0,
          nozzleTemps: [25.1],
          nozzleTargetTemps: [0],
          printLayer: 0,
          targetPrintLayer: 0,
          doorStatus: "close",
          errorCode: "",
        },
      };
    this.gcodeList = options.gcodeList ?? [];
    this.failureMode = options.failureMode ?? "none";
  }

  /** Swap the /detail answer (e.g. simulate an active print). */
  setDetail(detail: Record<string, unknown>): void {
    this.detail = { code: 0, message: "success", detail };
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Start (or restart, on the same port) the mock printer. */
  async start(port: number = this.port): Promise<number> {
    if (this.server) return this.port;
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res);
      });
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        this.port = addr.port;
        this.server = server;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private authOk(
    req: IncomingMessage,
    body: Buffer,
  ): { ok: true } | { ok: false; respond: (res: ServerResponse) => void } {
    const header = (name: string) => {
      const raw = req.headers[name.toLowerCase()];
      return Array.isArray(raw) ? raw[0] : raw;
    };
    let jsonBody: Record<string, unknown> | null = null;
    try {
      jsonBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      jsonBody = null;
    }
    // Uploads authenticate via headers; JSON endpoints via body fields.
    const sn = header("serialNumber") ?? jsonBody?.serialNumber;
    const cc = header("checkCode") ?? jsonBody?.checkCode;
    if (sn === this.serialNumber && cc === this.checkCode) return { ok: true };
    return {
      ok: false,
      respond: (res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 1, message: "serial number or check code incorrect" }));
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const url = req.url ?? "/";
    this.recordedRequests.push({
      method: req.method ?? "GET",
      url,
      headers: { ...req.headers },
      body,
    });

    if (this.failureMode === "drop") {
      res.socket?.destroy();
      return;
    }
    if (this.failureMode === "http500") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("internal error");
      return;
    }

    const auth = this.authOk(req, body);
    if (!auth.ok) {
      auth.respond(res);
      return;
    }

    if (url === "/detail") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.detail));
      return;
    }

    if (url === "/gcodeList") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, message: "success", gcodeList: this.gcodeList }));
      return;
    }

    if (url === "/uploadGcode") {
      const text = body.toString("latin1");
      const filenameMatch = text.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] ?? "(unknown)";
      this.uploadedFiles.push({ filename, size: body.length, headers: { ...req.headers } });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, message: "success" }));
      return;
    }

    if (url === "/printGcode") {
      const parsed = JSON.parse(body.toString("utf8")) as { fileName?: unknown };
      const fileName = typeof parsed.fileName === "string" ? parsed.fileName : "(unknown)";
      this.printJobs.push(fileName);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, message: "success" }));
      return;
    }

    if (url === "/control") {
      const parsed = JSON.parse(body.toString("utf8")) as {
        payload?: { cmd?: string; args?: { action?: string } };
      };
      const action = parsed.payload?.args?.action ?? "(unknown)";
      this.jobControlCommands.push(action);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, message: "success" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 404, message: "not found" }));
  }
}
