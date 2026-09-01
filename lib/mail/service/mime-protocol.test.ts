import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  BMP1_FRAME,
  BMP1_HEADER_BYTES,
  BMP1_MAGIC,
  readBmp1Frames,
  writeBmp1Frame,
} from "./mime-protocol";

describe("BMP1 framing", () => {
  it("zeroes the source chunk after copying a complete frame", async () => {
    const source = frame(BMP1_FRAME.rawData, "private");
    const iterator = readBmp1Frames(chunks(source))[Symbol.asyncIterator]();

    const result = await iterator.next();
    expect(result.done).toBe(false);
    if (result.done) return;
    expect(source).toEqual(Buffer.alloc(source.length));
    expect(result.value.payload.toString()).toBe("private");

    await iterator.return?.();
  });

  it("zeroes an incomplete source chunk before rejecting it", async () => {
    const source = frame(BMP1_FRAME.rawData, "private").subarray(
      0,
      BMP1_HEADER_BYTES + 2,
    );
    const sourceLength = source.length;

    await expect(consume(readBmp1Frames(chunks(source)))).rejects.toThrow(
      "BMP1 stream ended inside a frame",
    );
    expect(source).toEqual(Buffer.alloc(sourceLength));
  });

  it("zeroes a source chunk with a malformed payload length", async () => {
    const source = Buffer.alloc(BMP1_HEADER_BYTES);
    BMP1_MAGIC.copy(source);
    source[4] = BMP1_FRAME.rawData;
    source.writeUInt32BE(64 * 1024 + 1, 8);

    await expect(consume(readBmp1Frames(chunks(source)))).rejects.toThrow(
      "BMP1 frame exceeds the payload limit",
    );
    expect(source).toEqual(Buffer.alloc(source.length));
  });

  it("keeps the payload readable while zeroing the source on consumer return", async () => {
    const source = frame(BMP1_FRAME.rawData, "private");
    const iterator = readBmp1Frames(chunks(source))[Symbol.asyncIterator]();

    const result = await iterator.next();
    expect(result.done).toBe(false);
    if (result.done) return;
    const payload = result.value.payload;
    expect(source).toEqual(Buffer.alloc(source.length));
    expect(payload.toString()).toBe("private");

    await iterator.return?.();
    expect(payload).toEqual(Buffer.alloc(payload.length));
  });

  it("keeps the payload readable while zeroing the source on consumer throw", async () => {
    const source = frame(BMP1_FRAME.rawData, "private");
    const iterator = readBmp1Frames(chunks(source))[Symbol.asyncIterator]();

    const result = await iterator.next();
    expect(result.done).toBe(false);
    if (result.done) return;
    const payload = result.value.payload;
    expect(source).toEqual(Buffer.alloc(source.length));
    expect(payload.toString()).toBe("private");

    await expect(iterator.throw?.(new Error("consumer failed"))).rejects.toThrow(
      "consumer failed",
    );
    expect(payload).toEqual(Buffer.alloc(payload.length));
  });

  it("zeroes each yielded payload before advancing to the next frame", async () => {
    const iterator = readBmp1Frames(
      chunks(Buffer.concat([frame(BMP1_FRAME.rawData, "first"), frame(BMP1_FRAME.rawData, "second")])),
    )[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done) return;
    const firstPayload = first.value.payload;
    expect(firstPayload.toString()).toBe("first");

    const second = await iterator.next();
    expect(firstPayload).toEqual(Buffer.alloc(firstPayload.length));
    expect(second.done).toBe(false);
    if (second.done) return;
    const secondPayload = second.value.payload;
    expect(secondPayload.toString()).toBe("second");

    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(secondPayload).toEqual(Buffer.alloc(secondPayload.length));
  });

  it("zeroes the owned outbound frame after a write failure", async () => {
    const retained: Buffer[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        retained.push(chunk);
        callback(new Error("write failed"));
      },
    });

    await expect(
      writeBmp1Frame(destination, BMP1_FRAME.rawData, Buffer.from("private")),
    ).rejects.toThrow("write failed");
    expect(retained).toHaveLength(1);
    expect(retained[0]).toEqual(Buffer.alloc(retained[0]?.length ?? 0));
  });

  it("contains a late socket error after the write callback has completed", async () => {
    const destination = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback();
        setImmediate(() => {
          destination.emit("error", Object.assign(new Error("broken pipe"), {
            code: "EPIPE",
          }));
        });
      },
    });

    await expect(
      writeBmp1Frame(destination, BMP1_FRAME.rawData, Buffer.from("private")),
    ).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    destination.destroy();
  });
});

function frame(type: number, value: string): Buffer {
  const payload = Buffer.from(value);
  const result = Buffer.alloc(BMP1_HEADER_BYTES + payload.length);
  BMP1_MAGIC.copy(result);
  result[4] = type;
  result.writeUInt32BE(payload.length, 8);
  payload.copy(result, BMP1_HEADER_BYTES);
  payload.fill(0);
  return result;
}

async function* chunks(value: Buffer): AsyncIterable<Uint8Array> {
  yield value;
}

async function consume(source: AsyncIterable<unknown>): Promise<void> {
  for await (const _value of source) {
    void _value;
    // Consume every frame so deferred parser errors are observed.
  }
}
