/**
 * In-process mock Moonraker server. Used by the PLA-475 MoonrakerClient tests
 * to exercise REST + WS without touching a real printer.
 *
 * Implements only the subset PLA-475 cares about:
 *   - `GET /printer/info`
 *   - `GET /printer/objects/query`
 *   - `GET /server/files/list`
 *   - `GET /server/files/metadata`
 *   - `POST /server/files/upload`
 *   - `POST /printer/print/{start,pause,resume,cancel}`
 *   - `DELETE /server/files/<path>`
 *   - `GET /websocket` upgrade — JSON-RPC over text frames
 *
 * The WS handshake is hand-rolled because the project intentionally avoids
 * pulling in the `ws` package as a devDependency. We only need text frames
 * <= 64 KiB (Moonraker status payloads are small) so the framing code stays
 * short. If the WS protocol footprint grows we should switch to `ws`.
 *
 * Test-side affordances:
 *   - `recordedRequests` lets tests assert on URL + headers.
 *   - `seenApiKeys` is the set of `X-Api-Key` header values the server
 *     received. Tests assert this is non-empty (to prove the client
 *     forwarded the key) and that the values do NOT appear in any
 *     logger output.
 *   - `pushStatusUpdate(payload)` fans a `notify_status_update` to every
 *     connected WS client.
 *   - `closeAllWebSockets(code)` simulates a printer reboot or network drop.
 *   - `stop()` shuts the server down; `start()` brings it back up on the
 *     same port (used by the reconnect test).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

interface ClientConnection {
  id: string;
  socket: Duplex;
  apiKeyQuery: string | null;
}

export interface MockMoonrakerOptions {
  /**
   * If set, the server requires `X-Api-Key: <value>` on every REST request
   * and `?token=<value>` on the WS upgrade. Unset means unauthenticated.
   */
  requireApiKey?: string;
  /** Initial /printer/info payload. */
  printerInfo?: Record<string, unknown>;
  /** Files returned by /server/files/list. */
  files?: Array<{ path: string; size?: number; modified?: number }>;
  /** Metadata returned by /server/files/metadata, keyed by filename. */
  metadata?: Record<string, Record<string, unknown>>;
}

export class MockMoonraker {
  private server: Server | null = null;
  private port = 0;
  public readonly recordedRequests: RecordedRequest[] = [];
  public readonly seenApiKeys = new Set<string>();
  public readonly uploadedFiles: Array<{ filename: string; size: number }> = [];
  private clients = new Map<string, ClientConnection>();
  private nextRpcId = 0;

  constructor(private readonly options: MockMoonrakerOptions = {}) {}

  /** Resolve when the server is listening; returns the chosen port. */
  async start(port = 0): Promise<number> {
    if (this.server) return this.port;
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.handleHttp(req, res));
      server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket as Duplex, head));
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        this.port = addr.port;
        this.server = server;
        resolve(this.port);
      });
    });
  }

  /** Stop the server; closes all WS connections first. */
  async stop(): Promise<void> {
    this.closeAllWebSockets(1001, "server stopping");
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/websocket`;
  }

  /** Push a `notify_status_update` to every connected WS client. */
  pushStatusUpdate(statusObj: Record<string, Record<string, unknown>>): void {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      method: "notify_status_update",
      params: [statusObj, Date.now() / 1000],
    });
    for (const client of this.clients.values()) {
      try {
        writeTextFrame(client.socket, message);
      } catch {
        // best-effort
      }
    }
  }

  /** Force-close every active WS connection (simulate printer reboot). */
  closeAllWebSockets(code = 1006, reason = ""): void {
    for (const client of this.clients.values()) {
      try {
        writeCloseFrame(client.socket, code, reason);
      } catch {
        // best-effort
      }
      client.socket.destroy();
    }
    this.clients.clear();
  }

  /** How many WS clients are currently connected. */
  connectedClients(): number {
    return this.clients.size;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      this.recordedRequests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      });
      const apiKey = req.headers["x-api-key"];
      if (typeof apiKey === "string") {
        this.seenApiKeys.add(apiKey);
      }
      try {
        this.route(req, res, body);
      } catch (err) {
        writeJson(res, 500, { error: String(err) });
      }
    });
  }

  private route(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const url = new URL(req.url ?? "/", this.baseUrl());
    const method = (req.method ?? "GET").toUpperCase();

    // Auth gate (REST). Skip for the WS upgrade route — Moonraker auths WS
    // via `?token=` rather than the X-Api-Key header.
    if (this.options.requireApiKey) {
      const got = req.headers["x-api-key"];
      if (got !== this.options.requireApiKey) {
        writeJson(res, 401, { error: "missing or wrong X-Api-Key" });
        return;
      }
    }

    if (method === "GET" && url.pathname === "/printer/info") {
      writeJson(res, 200, {
        result: this.options.printerInfo ?? {
          state: "ready",
          state_message: "Printer is ready",
          hostname: "mock-printer",
          software_version: "v0.12.0-mock",
        },
      });
      return;
    }

    if (method === "GET" && url.pathname === "/printer/objects/query") {
      // Build a `status` map with empty objects for every requested name.
      const status: Record<string, Record<string, unknown>> = {};
      for (const [name] of url.searchParams.entries()) {
        status[name] = { mock: true };
      }
      writeJson(res, 200, { result: { status, eventtime: 12345.6 } });
      return;
    }

    if (method === "GET" && url.pathname === "/server/files/list") {
      writeJson(res, 200, {
        result: this.options.files ?? [
          { path: "demo.gcode", size: 1234, modified: 1, permissions: "rw" },
        ],
      });
      return;
    }

    if (method === "GET" && url.pathname === "/server/files/metadata") {
      const filename = url.searchParams.get("filename") ?? "";
      const meta = this.options.metadata?.[filename] ?? {
        filename,
        size: 1234,
        estimated_time: 600,
        filament_total: 1500,
        thumbnails: [
          {
            width: 32,
            height: 32,
            size: 4,
            data: Buffer.from([0, 1, 2, 3]).toString("base64"),
          },
        ],
      };
      writeJson(res, 200, { result: meta });
      return;
    }

    if (method === "POST" && url.pathname === "/server/files/upload") {
      // We don't fully parse multipart; just record total body size.
      const filenameMatch = body.toString("utf8").match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : "unknown.gcode";
      this.uploadedFiles.push({ filename, size: body.length });
      writeJson(res, 201, {
        item: { path: filename, root: "gcodes", size: body.length, modified: Date.now() / 1000 },
        print_started: false,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/printer/print/start") {
      writeJson(res, 200, { result: "ok" });
      return;
    }
    if (method === "POST" && url.pathname === "/printer/print/pause") {
      writeJson(res, 200, { result: "ok" });
      return;
    }
    if (method === "POST" && url.pathname === "/printer/print/resume") {
      writeJson(res, 200, { result: "ok" });
      return;
    }
    if (method === "POST" && url.pathname === "/printer/print/cancel") {
      writeJson(res, 200, { result: "ok" });
      return;
    }

    if (method === "DELETE" && url.pathname.startsWith("/server/files/")) {
      writeJson(res, 200, {
        item: { path: url.pathname.replace(/^\/server\/files\//, ""), root: "gcodes" },
      });
      return;
    }

    writeJson(res, 404, { error: `mock route not implemented: ${method} ${url.pathname}` });
  }

  // ── WebSocket ───────────────────────────────────────────────────────────

  private handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
    const url = new URL(req.url ?? "/", this.baseUrl());
    if (url.pathname !== "/websocket") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    if (this.options.requireApiKey && token !== this.options.requireApiKey) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );

    const id = randomBytes(6).toString("hex");
    const client: ClientConnection = { id, socket, apiKeyQuery: token };
    this.clients.set(id, client);
    socket.on("close", () => {
      this.clients.delete(id);
    });
    socket.on("error", () => {
      this.clients.delete(id);
    });

    // Frame reader. Buffer raw bytes and decode as enough arrives.
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const decoded = readTextFrame(buf);
        if (!decoded) break;
        buf = buf.subarray(decoded.consumed);
        if (decoded.opcode === 0x8) {
          // close frame
          try {
            writeCloseFrame(socket, 1000, "");
          } catch {
            // best-effort
          }
          this.clients.delete(id);
          socket.end();
          return;
        }
        if (decoded.opcode === 0x1) {
          this.handleWsMessage(client, decoded.payload);
        }
        // ignore ping/pong/binary opcodes for the mock
      }
    });
  }

  private handleWsMessage(client: ClientConnection, payload: string): void {
    let msg: { id?: number; method?: string; params?: unknown };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.method === "printer.objects.subscribe" && typeof msg.id === "number") {
      // Respond with the current snapshot for every requested object.
      const params = msg.params as { objects?: Record<string, unknown> } | undefined;
      const status: Record<string, Record<string, unknown>> = {};
      const objs = params?.objects ?? {};
      for (const name of Object.keys(objs)) {
        status[name] = { mock: true, name };
      }
      const response = {
        jsonrpc: "2.0",
        id: msg.id,
        result: { eventtime: 1.23, status },
      };
      writeTextFrame(client.socket, JSON.stringify(response));
    } else if (typeof msg.id === "number") {
      // Echo a generic success for any other JSON-RPC call.
      writeTextFrame(
        client.socket,
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "ok" }),
      );
    }
  }
}

// ── Frame helpers ─────────────────────────────────────────────────────────

interface DecodedFrame {
  opcode: number;
  payload: string;
  consumed: number;
}

function readTextFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;
  const byte0 = buf[0];
  const byte1 = buf[1];
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    const high = buf.readUInt32BE(offset);
    const low = buf.readUInt32BE(offset + 4);
    if (high !== 0 || low > 0xffffffff) {
      throw new Error("MockMoonraker: frame too large");
    }
    payloadLen = low;
    offset += 8;
  }
  if (!masked) {
    // Client → server frames must be masked. Spec violation; bail.
    throw new Error("MockMoonraker: client frame missing mask");
  }
  if (buf.length < offset + 4 + payloadLen) return null;
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  const data = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    data[i] = buf[offset + i] ^ mask[i % 4];
  }
  return {
    opcode,
    payload: data.toString("utf8"),
    consumed: offset + payloadLen,
  };
}

function writeTextFrame(socket: Duplex, payload: string): void {
  const data = Buffer.from(payload, "utf8");
  const header = encodeFrameHeader(0x1, data.length);
  socket.write(Buffer.concat([header, data]));
}

function writeCloseFrame(socket: Duplex, code: number, reason: string): void {
  const reasonBuf = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  const header = encodeFrameHeader(0x8, payload.length);
  socket.write(Buffer.concat([header, payload]));
}

function encodeFrameHeader(opcode: number, payloadLen: number): Buffer {
  const byte0 = 0x80 | (opcode & 0x0f);
  if (payloadLen < 126) {
    return Buffer.from([byte0, payloadLen]);
  }
  if (payloadLen < 65536) {
    const buf = Buffer.alloc(4);
    buf[0] = byte0;
    buf[1] = 126;
    buf.writeUInt16BE(payloadLen, 2);
    return buf;
  }
  const buf = Buffer.alloc(10);
  buf[0] = byte0;
  buf[1] = 127;
  buf.writeUInt32BE(0, 2);
  buf.writeUInt32BE(payloadLen, 6);
  return buf;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}
