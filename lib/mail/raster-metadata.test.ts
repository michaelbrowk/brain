import { describe, expect, it } from "vitest";

import { extractFirstGifFrame, inspectMailRaster } from "./raster-metadata";

describe("mail raster metadata", () => {
  it("verifies bounded PNG, JPEG, GIF, and WebP containers", () => {
    expect(inspectMailRaster("image/png", tinyPng(3, 2))).toEqual({
      width: 3,
      height: 2,
      frames: 1,
    });
    expect(inspectMailRaster("image/jpeg", tinyJpeg(3, 2))).toEqual({
      width: 3,
      height: 2,
      frames: 1,
    });
    expect(inspectMailRaster("image/gif", tinyGif(3, 2))).toEqual({
      width: 3,
      height: 2,
      frames: 1,
    });
    expect(inspectMailRaster("image/webp", tinyWebp(3, 2))).toEqual({
      width: 3,
      height: 2,
      frames: 1,
    });
  });

  it("fails closed on MIME confusion and truncated containers", () => {
    expect(inspectMailRaster("image/jpeg", tinyPng(3, 2))).toBeNull();
    expect(inspectMailRaster("image/svg+xml", Buffer.from("<svg/>"))).toBeNull();
    expect(inspectMailRaster("image/png", tinyPng(3, 2).subarray(0, 24))).toBeNull();
    expect(inspectMailRaster("image/gif", tinyGif(3, 2).subarray(0, -1))).toBeNull();
  });

  it("rejects duplicate or contradictory container metadata", () => {
    expect(inspectMailRaster("image/jpeg", jpegWithDuplicateFrame())).toBeNull();
    expect(inspectMailRaster("image/gif", gifWithOversizedFrame())).toBeNull();
    expect(inspectMailRaster("image/webp", webpWithDuplicateExtendedHeader())).toBeNull();
    expect(inspectMailRaster("image/png", pngWithMismatchedFrameCount())).toBeNull();
  });

  it("rejects a small animated WebP canvas with an oversized nested payload", () => {
    expect(inspectMailRaster("image/webp", animatedWebp(1, 1, 16_384, 16_384))).toBeNull();
    expect(inspectMailRaster("image/webp", animatedWebp(2, 3, 2, 3))).toEqual({
      width: 2,
      height: 3,
      frames: 1,
    });
  });

  it("extracts and independently verifies the first animated GIF frame", () => {
    const animated = animatedGif(640, 360, 85);
    const extracted = extractFirstGifFrame(animated);

    expect(inspectMailRaster("image/gif", animated)).toEqual({
      width: 640,
      height: 360,
      frames: 85,
    });
    expect(extracted).not.toBeNull();
    expect(inspectMailRaster("image/gif", extracted!)).toEqual({
      width: 640,
      height: 360,
      frames: 1,
    });
    expect(extracted!.byteLength).toBeLessThan(animated.byteLength);
    extracted!.fill(0);
  });
});

export function tinyPng(width = 1, height = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([1])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

function tinyJpeg(width: number, height: number): Buffer {
  const frame = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xd9])]);
}

function tinyGif(width: number, height: number): Buffer {
  const logical = Buffer.alloc(7);
  logical.writeUInt16LE(width, 0);
  logical.writeUInt16LE(height, 2);
  return Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    logical,
    Buffer.from([
      0x2c, 0, 0, 0, 0,
      width & 0xff, (width >>> 8) & 0xff,
      height & 0xff, (height >>> 8) & 0xff,
      0,
      2,
      2, 0x44, 0x01,
      0,
      0x3b,
    ]),
  ]);
}

function animatedGif(width: number, height: number, frames: number): Buffer {
  const single = tinyGif(width, height);
  const frame = single.subarray(13, -1);
  return Buffer.concat([
    single.subarray(0, 13),
    ...Array.from({ length: frames }, () => frame),
    single.subarray(-1),
  ]);
}

function tinyWebp(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14);
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE(bits, 1);
  const body = Buffer.concat([
    Buffer.from("WEBPVP8L", "ascii"),
    Buffer.from([5, 0, 0, 0]),
    payload,
    Buffer.from([0]),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function jpegWithDuplicateFrame(): Buffer {
  const value = tinyJpeg(1, 1);
  return Buffer.concat([value.subarray(0, -2), value.subarray(2, -2), value.subarray(-2)]);
}

function gifWithOversizedFrame(): Buffer {
  const value = tinyGif(1, 1);
  const copy = Buffer.from(value);
  copy.writeUInt16LE(2, 13 + 1 + 4);
  return copy;
}

function webpWithDuplicateExtendedHeader(): Buffer {
  const header = Buffer.alloc(18);
  header.write("VP8X", 0, "ascii");
  header.writeUInt32LE(10, 4);
  const body = Buffer.concat([
    Buffer.from("WEBP", "ascii"),
    header,
    header,
    tinyWebp(1, 1).subarray(12),
  ]);
  return riff(body);
}

function pngWithMismatchedFrameCount(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);
  const frame = Buffer.alloc(26);
  frame.writeUInt32BE(1, 4);
  frame.writeUInt32BE(1, 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("acTL", animation),
    pngChunk("fcTL", frame),
    pngChunk("IDAT", Buffer.from([1])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function animatedWebp(
  canvasWidth: number,
  canvasHeight: number,
  payloadWidth: number,
  payloadHeight: number,
): Buffer {
  const extended = Buffer.alloc(18);
  extended.write("VP8X", 0, "ascii");
  extended.writeUInt32LE(10, 4);
  extended[8] = 0x02;
  writeUInt24LE(extended, 12, canvasWidth - 1);
  writeUInt24LE(extended, 15, canvasHeight - 1);
  const animation = Buffer.alloc(14);
  animation.write("ANIM", 0, "ascii");
  animation.writeUInt32LE(6, 4);
  const frameHeader = Buffer.alloc(16);
  writeUInt24LE(frameHeader, 6, canvasWidth - 1);
  writeUInt24LE(frameHeader, 9, canvasHeight - 1);
  const payload = tinyWebp(payloadWidth, payloadHeight).subarray(12);
  const frame = webpChunk("ANMF", Buffer.concat([frameHeader, payload]));
  return riff(Buffer.concat([Buffer.from("WEBP", "ascii"), extended, animation, frame]));
}

function webpChunk(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function riff(body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function writeUInt24LE(buffer: Buffer, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
}
