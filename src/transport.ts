import net from "node:net";

import { AsyncQueue } from "./async-queue.js";
import { InvalidInputError, ProtocolError, TransportError } from "./errors.js";
import { MAX_FRAME_BYTES } from "./types.js";

const WRITE_STALL_TIMEOUT_MS = 5_000;

type FrameKind = "json" | "binary";

interface Frame {
  readonly kind: FrameKind;
  readonly payload: Buffer;
}

class FrameDecoder {
  private bytes = Buffer.alloc(0);

  public push(chunk: Buffer): Frame[] {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    const frames: Frame[] = [];

    while (this.bytes.length >= 4) {
      const length = this.bytes.readUInt32BE(0);
      if (length === 0) {
        throw new ProtocolError("CLP frame is missing its kind discriminator");
      }
      if (length > MAX_FRAME_BYTES) {
        throw new ProtocolError(`CLP frame length ${length} exceeds ${MAX_FRAME_BYTES}`);
      }

      const frameEnd = 4 + length;
      if (this.bytes.length < frameEnd) {
        break;
      }

      const discriminator = this.bytes[4];
      const kind = discriminator === 0x4a ? "json" : discriminator === 0x42 ? "binary" : undefined;
      if (kind === undefined) {
        throw new ProtocolError("CLP frame has an unknown kind discriminator");
      }

      frames.push({
        kind,
        payload: Buffer.from(this.bytes.subarray(5, frameEnd)),
      });
      this.bytes = this.bytes.subarray(frameEnd);
    }

    return frames;
  }
}

/** A framed CLP stream over Node's local IPC socket abstraction. */
export class FramedTransport {
  private readonly decoder = new FrameDecoder();
  private readonly messages = new AsyncQueue<Record<string, unknown>>();
  private terminated = false;

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (error: Error) => {
      this.fail(new TransportError(`CLP transport I/O failed: ${error.message}`, { cause: error }));
    });
    socket.on("close", () => {
      this.fail(new TransportError("the CLP transport disconnected"));
    });
  }

  public static connect(endpoint: string): Promise<FramedTransport> {
    if (endpoint.length === 0) {
      return Promise.reject(new InvalidInputError("the CLP endpoint may not be empty"));
    }
    if (endpoint.includes("\0")) {
      return Promise.reject(new InvalidInputError("the CLP endpoint may not contain a null byte"));
    }

    return new Promise<FramedTransport>((resolve, reject) => {
      const socket = net.createConnection(resolveEndpoint(endpoint));
      const rejectConnection = (error: Error): void => {
        socket.destroy();
        reject(new TransportError(`CLP transport I/O failed: ${error.message}`, { cause: error }));
      };

      socket.once("error", rejectConnection);
      socket.once("connect", () => {
        socket.off("error", rejectConnection);
        resolve(new FramedTransport(socket));
      });
    });
  }

  public nextMessage(): Promise<Record<string, unknown>> {
    return this.messages.take();
  }

  public async sendJson(message: Record<string, unknown>): Promise<void> {
    let payload: Buffer;
    try {
      payload = Buffer.from(JSON.stringify(message), "utf8");
    } catch (error) {
      throw new InvalidInputError(
        `could not encode the CLP JSON message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.sendFrame("json", payload);
  }

  public sendBinary(payload: Uint8Array): Promise<void> {
    return this.sendFrame(
      "binary",
      Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
    );
  }

  public dispose(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.messages.close();
    this.socket.destroy();
  }

  private async sendFrame(kind: FrameKind, payload: Buffer): Promise<void> {
    this.ensureActive();
    const length = payload.length + 1;
    if (length > MAX_FRAME_BYTES) {
      throw new InvalidInputError(`CLP frame length ${length} exceeds ${MAX_FRAME_BYTES}`);
    }

    const frame = Buffer.allocUnsafe(4 + length);
    frame.writeUInt32BE(length, 0);
    frame[4] = kind === "json" ? 0x4a : 0x42;
    payload.copy(frame, 5);
    await this.write(frame);
  }

  private write(frame: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error !== undefined && error !== null) {
          reject(
            new TransportError(`CLP transport I/O failed: ${error.message}`, { cause: error }),
          );
        } else {
          resolve();
        }
      };
      const timeout = setTimeout(() => {
        const error = new TransportError("the CLP peer stopped reading output");
        this.fail(error);
        finish(error);
      }, WRITE_STALL_TIMEOUT_MS);

      try {
        this.socket.write(frame, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleData(chunk: Buffer): void {
    if (this.terminated) {
      return;
    }

    try {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.kind !== "json") {
          throw new ProtocolError("expected a JSON frame from the CLP host");
        }
        const message = JSON.parse(frame.payload.toString("utf8"));
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
          throw new ProtocolError("the CLP host sent a JSON message that is not an object");
        }
        this.messages.push(message as Record<string, unknown>);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new ProtocolError(String(error)));
    }
  }

  private ensureActive(): void {
    if (this.terminated || this.socket.destroyed) {
      throw new TransportError("the CLP transport disconnected");
    }
  }

  private fail(error: Error): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.messages.close(error);
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}

/** Maps Chymeral's GenericNamespaced endpoint to Node's local IPC syntax. */
function resolveEndpoint(endpoint: string): string {
  if (process.platform === "linux") {
    return `\0${endpoint}`;
  }
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${endpoint}`;
  }
  throw new InvalidInputError("Chymeral CLP local IPC is supported only on Linux and Windows");
}
