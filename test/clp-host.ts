import { randomUUID } from "node:crypto";
import net from "node:net";

export interface ReceivedFrame {
  readonly kind: "json" | "binary";
  readonly payload: Buffer;
}

interface Waiter {
  readonly resolve: (frame: ReceivedFrame) => void;
  readonly reject: (error: Error) => void;
}

const MAX_FRAME_BYTES = 1024 * 1024;

/** A tiny sequential-session CLP host used to test the public Node client. */
export class FakeClpHost {
  private readonly frames: ReceivedFrame[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly connectionWaiters: Array<(socket: net.Socket) => void> = [];
  private buffered = Buffer.alloc(0);
  private socket: net.Socket | undefined;
  private stopped = false;

  private constructor(
    public readonly endpoint: string,
    private readonly server: net.Server,
  ) {}

  public static async start(): Promise<FakeClpHost> {
    const endpoint = `chymeral-node-sdk-${process.pid}-${randomUUID()}`;
    const server = net.createServer();
    const host = new FakeClpHost(endpoint, server);
    server.on("connection", (socket) => host.attach(socket));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(resolveEndpoint(endpoint), () => {
        server.off("error", onError);
        resolve();
      });
    });
    return host;
  }

  public async nextFrame(): Promise<ReceivedFrame> {
    const frame = this.frames.shift();
    if (frame !== undefined) {
      return frame;
    }
    if (this.stopped) {
      throw new Error("fake CLP host is closed");
    }
    return new Promise<ReceivedFrame>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  public async nextJson(): Promise<Record<string, unknown>> {
    const frame = await this.nextFrame();
    if (frame.kind !== "json") {
      throw new Error("expected a JSON frame from the client");
    }
    const message: unknown = JSON.parse(frame.payload.toString("utf8"));
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("client JSON frame is not an object");
    }
    return message as Record<string, unknown>;
  }

  public async sendJson(message: Record<string, unknown>): Promise<void> {
    await this.sendFrame("json", Buffer.from(JSON.stringify(message), "utf8"));
  }

  public async sendJsonFragmented(
    message: Record<string, unknown>,
    fragmentSize: number,
  ): Promise<void> {
    const frame = encodeFrame("json", Buffer.from(JSON.stringify(message), "utf8"));
    const socket = await this.waitForSocket();
    for (let offset = 0; offset < frame.length; offset += fragmentSize) {
      await write(socket, frame.subarray(offset, Math.min(offset + fragmentSize, frame.length)));
    }
  }

  public async close(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const error = new Error("fake CLP host is closed");
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private attach(socket: net.Socket): void {
    if (this.socket !== undefined && this.socket !== socket) {
      this.socket.destroy();
    }
    this.socket = socket;
    this.buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (this.socket === socket) {
        this.receive(chunk);
      }
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.buffered = Buffer.alloc(0);
      }
    });
    for (const resolve of this.connectionWaiters.splice(0)) {
      resolve(socket);
    }
  }

  private async sendFrame(kind: ReceivedFrame["kind"], payload: Buffer): Promise<void> {
    const socket = await this.waitForSocket();
    await write(socket, encodeFrame(kind, payload));
  }

  private waitForSocket(): Promise<net.Socket> {
    if (this.socket !== undefined && !this.socket.destroyed) {
      return Promise.resolve(this.socket);
    }
    if (this.stopped) {
      return Promise.reject(new Error("fake CLP host is closed"));
    }
    return new Promise<net.Socket>((resolve) => this.connectionWaiters.push(resolve));
  }

  private receive(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    try {
      while (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) {
          throw new Error(`invalid CLP frame length ${length}`);
        }
        const frameEnd = length + 4;
        if (this.buffered.length < frameEnd) {
          return;
        }
        const discriminator = this.buffered[4];
        const kind =
          discriminator === 0x4a ? "json" : discriminator === 0x42 ? "binary" : undefined;
        if (kind === undefined) {
          throw new Error("invalid CLP frame discriminator");
        }
        this.enqueue({ kind, payload: Buffer.from(this.buffered.subarray(5, frameEnd)) });
        this.buffered = this.buffered.subarray(frameEnd);
      }
    } catch (error) {
      this.stopped = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(failure);
      }
    }
  }

  private enqueue(frame: ReceivedFrame): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(frame);
      return;
    }
    this.frames.push(frame);
  }
}

function resolveEndpoint(endpoint: string): string {
  if (process.platform === "linux") {
    return `\0${endpoint}`;
  }
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${endpoint}`;
  }
  throw new Error("tests support only Linux and Windows local IPC");
}

function encodeFrame(kind: ReceivedFrame["kind"], payload: Buffer): Buffer {
  const length = payload.length + 1;
  if (length > MAX_FRAME_BYTES) {
    throw new Error(`test frame length ${length} exceeds ${MAX_FRAME_BYTES}`);
  }
  const frame = Buffer.allocUnsafe(length + 4);
  frame.writeUInt32BE(length, 0);
  frame[4] = kind === "json" ? 0x4a : 0x42;
  payload.copy(frame, 5);
  return frame;
}

function write(socket: net.Socket, bytes: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(bytes, (error) =>
      error === undefined || error === null ? resolve() : reject(error),
    );
  });
}
