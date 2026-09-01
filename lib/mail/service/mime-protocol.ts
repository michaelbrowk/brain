import type { Writable } from "node:stream";

export const BMP1_MAGIC = Buffer.from("BMP1", "ascii");
export const BMP1_HEADER_BYTES = 12;
export const BMP1_MAX_DATA_BYTES = 64 * 1024;
export const BMP1_MAX_CONTROL_BYTES = 16 * 1024;

export const BMP1_FRAME = Object.freeze({
  request: 0x01,
  rawData: 0x02,
  rawEnd: 0x03,
  artifactBegin: 0x10,
  artifactData: 0x11,
  artifactEnd: 0x12,
  done: 0x13,
  error: 0x14,
});

export interface Bmp1Frame {
  readonly type: number;
  readonly payload: Buffer;
}

const lateWriteErrorGuards = new WeakMap<Writable, (error: Error) => void>();

export async function* readBmp1Frames(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Bmp1Frame> {
  let pending: Buffer = Buffer.alloc(0);
  try {
    for await (const candidate of source) {
      if (!(candidate instanceof Uint8Array)) {
        throw new Error("BMP1 input chunk is invalid");
      }
      let nextPending: Buffer;
      try {
        const chunk = Buffer.from(
          candidate.buffer,
          candidate.byteOffset,
          candidate.byteLength,
        );
        nextPending =
          pending.length === 0
            ? Buffer.from(chunk)
            : Buffer.concat([pending, chunk], pending.length + chunk.length);
      } finally {
        candidate.fill(0);
      }
      pending.fill(0);
      pending = nextPending;

      while (pending.length >= BMP1_HEADER_BYTES) {
        if (!pending.subarray(0, BMP1_MAGIC.length).equals(BMP1_MAGIC)) {
          throw new Error("BMP1 magic is invalid");
        }
        if (pending[5] !== 0 || pending.readUInt16BE(6) !== 0) {
          throw new Error("BMP1 reserved header bits are invalid");
        }
        const payloadBytes = pending.readUInt32BE(8);
        if (payloadBytes > BMP1_MAX_DATA_BYTES) {
          throw new Error("BMP1 frame exceeds the payload limit");
        }
        const frameBytes = BMP1_HEADER_BYTES + payloadBytes;
        if (pending.length < frameBytes) break;
        const type = pending[4]!;
        const payload = Buffer.from(
          pending.subarray(BMP1_HEADER_BYTES, frameBytes),
        );
        const remainder = Buffer.from(pending.subarray(frameBytes));
        pending.fill(0);
        pending = remainder;
        try {
          yield Object.freeze({ type, payload });
        } finally {
          payload.fill(0);
        }
      }
      if (pending.length > BMP1_HEADER_BYTES + BMP1_MAX_DATA_BYTES) {
        throw new Error("BMP1 buffered input exceeds the frame limit");
      }
    }
    if (pending.length !== 0) {
      throw new Error("BMP1 stream ended inside a frame");
    }
  } finally {
    pending.fill(0);
  }
}

export async function writeBmp1Frame(
  destination: Writable,
  type: number,
  payload: Uint8Array = Buffer.alloc(0),
): Promise<void> {
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new Error("BMP1 frame type is invalid");
  }
  if (!(payload instanceof Uint8Array) || payload.byteLength > BMP1_MAX_DATA_BYTES) {
    throw new Error("BMP1 frame payload is invalid");
  }
  ensureLateWriteErrorGuard(destination);
  const frame = Buffer.allocUnsafe(BMP1_HEADER_BYTES + payload.byteLength);
  BMP1_MAGIC.copy(frame, 0);
  frame[4] = type;
  frame[5] = 0;
  frame.writeUInt16BE(0, 6);
  frame.writeUInt32BE(payload.byteLength, 8);
  frame.set(payload, BMP1_HEADER_BYTES);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        destination.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      destination.once("error", onError);
      destination.write(frame, (error) => finish(error));
    });
  } finally {
    frame.fill(0);
  }
}

function ensureLateWriteErrorGuard(destination: Writable): void {
  if (lateWriteErrorGuards.has(destination)) return;
  const guard = () => undefined;
  lateWriteErrorGuards.set(destination, guard);
  destination.on("error", guard);
  destination.once("close", () => {
    destination.off("error", guard);
    lateWriteErrorGuards.delete(destination);
  });
}

export async function writeBmp1JsonFrame(
  destination: Writable,
  type: number,
  value: unknown,
): Promise<void> {
  const payload = encodeBmp1Json(value);
  try {
    await writeBmp1Frame(destination, type, payload);
  } finally {
    payload.fill(0);
  }
}

export function encodeBmp1Json(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > BMP1_MAX_CONTROL_BYTES) {
    throw new Error("BMP1 control payload exceeds the limit");
  }
  return payload;
}

export function decodeBmp1Json(payload: Buffer): unknown {
  if (payload.length === 0 || payload.length > BMP1_MAX_CONTROL_BYTES) {
    throw new Error("BMP1 control payload is invalid");
  }
  return JSON.parse(payload.toString("utf8")) as unknown;
}
