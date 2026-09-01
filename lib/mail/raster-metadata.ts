export interface VerifiedMailRaster {
  readonly width: number;
  readonly height: number;
  readonly frames: number;
}

/**
 * Reads only bounded raster container metadata. It never decodes pixels and
 * returns null when the declared MIME type and magic bytes do not agree.
 */
export function inspectMailRaster(
  mimeType: string,
  input: Uint8Array,
): VerifiedMailRaster | null {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return inspectPng(bytes);
    case "image/jpeg":
      return inspectJpeg(bytes);
    case "image/gif":
      return inspectGif(bytes);
    case "image/webp":
      return inspectWebp(bytes);
    default:
      return null;
  }
}

/**
 * Reduces a structurally valid animated GIF to its first rendered frame
 * without decoding pixels. The returned container is independently verified.
 */
export function extractFirstGifFrame(input: Uint8Array): Buffer | null {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const original = inspectGif(bytes);
  if (original === null || original.frames < 2) return null;
  const packed = bytes[10]!;
  const prefixEnd =
    13 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  if (prefixEnd > bytes.length) return null;
  let offset = prefixEnd;
  let graphicControl: Buffer | null = null;
  while (offset < bytes.length) {
    const blockStart = offset;
    const block = bytes[offset++]!;
    if (block === 0x3b) return null;
    if (block === 0x21) {
      if (offset >= bytes.length) return null;
      const label = bytes[offset++]!;
      const extensionEnd = skipGifSubBlocks(bytes, offset);
      if (extensionEnd < 0) return null;
      if (label === 0xf9) {
        graphicControl = Buffer.from(bytes.subarray(blockStart, extensionEnd));
      } else if (label === 0x01) {
        graphicControl?.fill(0);
        graphicControl = null;
      }
      offset = extensionEnd;
      continue;
    }
    if (block !== 0x2c || offset + 9 > bytes.length) return null;
    const imagePacked = bytes[offset + 8]!;
    offset += 9;
    if ((imagePacked & 0x80) !== 0) {
      offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    }
    if (offset >= bytes.length) return null;
    offset++;
    const imageEnd = skipGifSubBlocks(bytes, offset);
    if (imageEnd < 0) return null;
    const output = Buffer.concat([
      bytes.subarray(0, prefixEnd),
      graphicControl ?? Buffer.alloc(0),
      bytes.subarray(blockStart, imageEnd),
      Buffer.from([0x3b]),
    ]);
    graphicControl?.fill(0);
    const inspected = inspectGif(output);
    if (
      inspected === null ||
      inspected.frames !== 1 ||
      inspected.width !== original.width ||
      inspected.height !== original.height
    ) {
      output.fill(0);
      return null;
    }
    return output;
  }
  graphicControl?.fill(0);
  return null;
}

function inspectPng(bytes: Buffer): VerifiedMailRaster | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let frames = 1;
  let sawHeader = false;
  let sawEnd = false;
  let sawAnimationControl = false;
  let frameControls = 0;
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) return null;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return null;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      sawHeader = true;
    } else if (type === "IHDR") {
      return null;
    }
    if (type === "acTL") {
      if (length !== 8 || sawAnimationControl || sawImageData) return null;
      frames = bytes.readUInt32BE(dataStart);
      sawAnimationControl = true;
    }
    if (type === "fcTL") {
      if (length !== 26 || !sawAnimationControl) return null;
      const frameWidth = bytes.readUInt32BE(dataStart + 4);
      const frameHeight = bytes.readUInt32BE(dataStart + 8);
      const x = bytes.readUInt32BE(dataStart + 12);
      const y = bytes.readUInt32BE(dataStart + 16);
      if (
        frameWidth < 1 ||
        frameHeight < 1 ||
        x + frameWidth > width ||
        y + frameHeight > height
      ) {
        return null;
      }
      frameControls++;
    }
    if (type === "IDAT") {
      if (length === 0) return null;
      sawImageData = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.length) return null;
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  if (
    !sawHeader ||
    !sawEnd ||
    (sawAnimationControl && frameControls !== frames) ||
    (!sawAnimationControl && frameControls !== 0)
  ) {
    return null;
  }
  return raster(width, height, frames);
}

function inspectJpeg(bytes: Buffer): VerifiedMailRaster | null {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return null;
  }
  let offset = 2;
  let dimensions: VerifiedMailRaster | null = null;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xd9) break;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7 || dimensions !== null) return null;
      dimensions = raster(
        bytes.readUInt16BE(offset + 5),
        bytes.readUInt16BE(offset + 3),
        1,
      );
      if (dimensions === null) return null;
    }
    if (marker === 0xda) break;
    offset += length;
  }
  return dimensions;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function inspectGif(bytes: Buffer): VerifiedMailRaster | null {
  if (
    bytes.length < 14 ||
    (bytes.toString("ascii", 0, 6) !== "GIF87a" &&
      bytes.toString("ascii", 0, 6) !== "GIF89a")
  ) {
    return null;
  }
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const packed = bytes[10]!;
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    offset += 3 * 2 ** ((packed & 0x07) + 1);
  }
  let frames = 0;
  let sawTrailer = false;
  while (offset < bytes.length) {
    const block = bytes[offset++]!;
    if (block === 0x3b) {
      sawTrailer = offset === bytes.length;
      break;
    }
    if (block === 0x2c) {
      if (offset + 9 > bytes.length) return null;
      const left = bytes.readUInt16LE(offset);
      const top = bytes.readUInt16LE(offset + 2);
      const frameWidth = bytes.readUInt16LE(offset + 4);
      const frameHeight = bytes.readUInt16LE(offset + 6);
      if (
        frameWidth < 1 ||
        frameHeight < 1 ||
        left + frameWidth > width ||
        top + frameHeight > height
      ) {
        return null;
      }
      const imagePacked = bytes[offset + 8]!;
      offset += 9;
      if ((imagePacked & 0x80) !== 0) {
        offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
      }
      if (offset >= bytes.length) return null;
      offset++;
      offset = skipGifSubBlocks(bytes, offset);
      if (offset < 0) return null;
      frames++;
      continue;
    }
    if (block === 0x21) {
      if (offset >= bytes.length) return null;
      offset++;
      offset = skipGifSubBlocks(bytes, offset);
      if (offset < 0) return null;
      continue;
    }
    return null;
  }
  return sawTrailer ? raster(width, height, frames) : null;
}

function skipGifSubBlocks(bytes: Buffer, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset++]!;
    if (length === 0) return offset;
    if (offset + length > bytes.length) return -1;
    offset += length;
  }
  return -1;
}

function inspectWebp(bytes: Buffer): VerifiedMailRaster | null {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    return null;
  }
  let offset = 12;
  let dimensions: VerifiedMailRaster | null = null;
  let primaryDimensions: VerifiedMailRaster | null = null;
  let animated = false;
  let frames = 0;
  let sawExtendedHeader = false;
  let sawAnimationHeader = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || chunkEnd > bytes.length) return null;
    if (type === "VP8X") {
      if (length !== 10 || sawExtendedHeader || offset !== 12) return null;
      sawExtendedHeader = true;
      animated = (bytes[dataStart]! & 0x02) !== 0;
      dimensions = raster(
        readUInt24LE(bytes, dataStart + 4) + 1,
        readUInt24LE(bytes, dataStart + 7) + 1,
        1,
      );
    } else if (type === "VP8 ") {
      if (primaryDimensions !== null || length < 10) return null;
      if (
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) return null;
      primaryDimensions = raster(
        bytes.readUInt16LE(dataStart + 6) & 0x3fff,
        bytes.readUInt16LE(dataStart + 8) & 0x3fff,
        1,
      );
      if (dimensions === null) dimensions = primaryDimensions;
    } else if (type === "VP8L") {
      if (primaryDimensions !== null || length < 5 || bytes[dataStart] !== 0x2f) {
        return null;
      }
      const bits = bytes.readUInt32LE(dataStart + 1);
      primaryDimensions = raster(
        (bits & 0x3fff) + 1,
        ((bits >>> 14) & 0x3fff) + 1,
        1,
      );
      if (dimensions === null) dimensions = primaryDimensions;
    } else if (type === "ANIM") {
      if (!sawExtendedHeader || !animated || sawAnimationHeader || length !== 6) {
        return null;
      }
      sawAnimationHeader = true;
    } else if (type === "ANMF") {
      if (!sawAnimationHeader || dimensions === null || length < 16) return null;
      const x = readUInt24LE(bytes, dataStart) * 2;
      const y = readUInt24LE(bytes, dataStart + 3) * 2;
      const frameWidth = readUInt24LE(bytes, dataStart + 6) + 1;
      const frameHeight = readUInt24LE(bytes, dataStart + 9) + 1;
      if (
        x + frameWidth > dimensions.width ||
        y + frameHeight > dimensions.height
      ) {
        return null;
      }
      const payloadDimensions = inspectWebpFramePayload(
        bytes,
        dataStart + 16,
        dataEnd,
      );
      if (
        payloadDimensions === null ||
        payloadDimensions.width !== frameWidth ||
        payloadDimensions.height !== frameHeight
      ) {
        return null;
      }
      frames++;
    }
    offset = chunkEnd;
  }
  if (offset !== bytes.length || dimensions === null) return null;
  if (animated) {
    if (!sawAnimationHeader || frames < 1 || primaryDimensions !== null) return null;
    return raster(dimensions.width, dimensions.height, frames);
  }
  if (frames !== 0 || sawAnimationHeader || primaryDimensions === null) return null;
  if (
    primaryDimensions.width !== dimensions.width ||
    primaryDimensions.height !== dimensions.height
  ) {
    return null;
  }
  return dimensions;
}

function inspectWebpFramePayload(
  bytes: Buffer,
  start: number,
  end: number,
): VerifiedMailRaster | null {
  let offset = start;
  let dimensions: VerifiedMailRaster | null = null;
  let sawAlpha = false;
  while (offset + 8 <= end) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || chunkEnd > end) return null;
    if (type === "ALPH") {
      if (dimensions !== null || sawAlpha || length === 0) return null;
      sawAlpha = true;
    } else if (type === "VP8 ") {
      if (
        dimensions !== null ||
        length < 10 ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        return null;
      }
      dimensions = raster(
        bytes.readUInt16LE(dataStart + 6) & 0x3fff,
        bytes.readUInt16LE(dataStart + 8) & 0x3fff,
        1,
      );
    } else if (type === "VP8L") {
      if (dimensions !== null || length < 5 || bytes[dataStart] !== 0x2f) {
        return null;
      }
      const bits = bytes.readUInt32LE(dataStart + 1);
      dimensions = raster(
        (bits & 0x3fff) + 1,
        ((bits >>> 14) & 0x3fff) + 1,
        1,
      );
    } else {
      return null;
    }
    offset = chunkEnd;
  }
  return offset === end ? dimensions : null;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function raster(width: number, height: number, frames: number): VerifiedMailRaster | null {
  return Number.isSafeInteger(width) &&
    width > 0 &&
    Number.isSafeInteger(height) &&
    height > 0 &&
    Number.isSafeInteger(frames) &&
    frames > 0
    ? Object.freeze({ width, height, frames })
    : null;
}
