import { createHash } from "node:crypto";

/**
 * The multipart/mixed writer behind an outgoing attachment. It is deliberately
 * the only place that turns bytes into MIME parts, so the header a recipient
 * sees and the bytes a replay check rebuilds come from one derivation.
 */

export interface OutboundAttachmentPart {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

/**
 * The download path truncates a filename to 180 bytes before it reaches a
 * header. The same bound here keeps the Content-Disposition line inside the
 * 998-byte header limit even when every character percent-encodes to three.
 */
const MAX_FILENAME_HEADER_BYTES = 180;
/** RFC 2046 bcharsnospace, which is what a receiving parser will accept. */
const SAFE_BOUNDARY = /^[A-Za-z0-9'()+_,\-./:=?]{1,70}$/;
const BASE64_LINE_LENGTH = 76;
/** 57 source bytes are exactly one 76-character line, with nothing left over. */
const BASE64_LINE_SOURCE_BYTES = 57;
/** 512 whole lines at a time, so the encoder never holds a full-size string. */
const BASE64_CHUNK_SOURCE_BYTES = BASE64_LINE_SOURCE_BYTES * 512;
const CRLF = Buffer.from("\r\n", "ascii");

/**
 * Deterministic, because `draftMatchesSubmission` rebuilds the whole message
 * and compares its bytes to the stored ones. A random boundary would make
 * every replay check fail.
 */
export function multipartBoundary(messageId: string): string {
  const digest = createHash("sha256").update(messageId).digest("hex").slice(0, 32);
  return `----brain-${digest}`;
}

/**
 * The ASCII fallback plus, when the two differ, the RFC 5987 form beside it.
 * Runs of characters a header parameter cannot carry collapse to one
 * underscore, so a name made only of them does not grow into a row of them.
 */
export function encodeAttachmentFilename(filename: string): string {
  const unicode = truncateToBytes(filename.normalize("NFC"), MAX_FILENAME_HEADER_BYTES);
  const ascii = unicode.replace(/[^A-Za-z0-9._-]+/g, "_") || "attachment";
  if (ascii === unicode) return `filename="${ascii}"`;
  const encoded = encodeURIComponent(unicode).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The text part first, then one base64 part per file, then the closing
 * delimiter with no trailing break: the caller appends the message's own.
 * The caller keeps ownership of every `bytes` buffer and wipes them itself.
 *
 * Every byte is measured before anything is allocated, so a 10 MiB set of
 * files produces one buffer of the finished size rather than a string of it
 * and a buffer of it. A send at the cap is the peak this service has to
 * survive inside `MemoryHigh=192M`.
 */
export function buildMultipartBody(
  text: string,
  parts: readonly OutboundAttachmentPart[],
  boundary: string,
): Buffer {
  if (typeof boundary !== "string" || !SAFE_BOUNDARY.test(boundary)) {
    throw new Error("outbound multipart boundary is invalid");
  }
  const headers: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\n` +
        "Content-Transfer-Encoding: base64\r\n\r\n",
      "utf8",
    ),
  ];
  const bodies: Buffer[] = [Buffer.from(text, "utf8")];
  for (const part of parts) {
    headers.push(
      Buffer.from(
        `--${boundary}\r\nContent-Type: ${part.mimeType}\r\n` +
          `Content-Disposition: attachment; ${encodeAttachmentFilename(part.filename)}\r\n` +
          "Content-Transfer-Encoding: base64\r\n\r\n",
        "utf8",
      ),
    );
    bodies.push(part.bytes);
  }
  const closing = Buffer.from(`\r\n--${boundary}--`, "utf8");
  let total = closing.byteLength;
  for (let index = 0; index < headers.length; index += 1) {
    total +=
      (index === 0 ? 0 : CRLF.byteLength) +
      headers[index].byteLength +
      base64BodyLength(bodies[index].byteLength);
  }
  const body = Buffer.alloc(total);
  let cursor = 0;
  for (let index = 0; index < headers.length; index += 1) {
    if (index > 0) cursor += CRLF.copy(body, cursor);
    cursor += headers[index].copy(body, cursor);
    cursor = writeBase64Body(body, cursor, bodies[index]);
  }
  cursor += closing.copy(body, cursor);
  if (cursor !== total) {
    throw new Error("outbound multipart body length is inconsistent");
  }
  return body;
}

/**
 * One base64 body, wrapped at 76 columns, as a buffer. Shared with the
 * single-part builder so both message shapes wrap through one derivation.
 */
export function encodeBase64Body(bytes: Buffer): Buffer {
  const body = Buffer.alloc(base64BodyLength(bytes.byteLength));
  writeBase64Body(body, 0, bytes);
  return body;
}

/** How many bytes `writeBase64Body` will write, measured without writing. */
function base64BodyLength(byteLength: number): number {
  if (byteLength === 0) return 0;
  const fullLines = Math.floor(byteLength / BASE64_LINE_SOURCE_BYTES);
  const remainder = byteLength - fullLines * BASE64_LINE_SOURCE_BYTES;
  if (remainder === 0) {
    return fullLines * BASE64_LINE_LENGTH + (fullLines - 1) * CRLF.byteLength;
  }
  return (
    fullLines * (BASE64_LINE_LENGTH + CRLF.byteLength) +
    Math.ceil(remainder / 3) * 4
  );
}

/**
 * Encodes into the caller's buffer a chunk at a time. The chunk is a whole
 * number of lines, so the encoding of a chunk is the encoding of the whole
 * buffer sliced at the same place, and no full-size string is ever made.
 */
function writeBase64Body(target: Buffer, offset: number, bytes: Buffer): number {
  let cursor = offset;
  let atFirstLine = true;
  for (
    let index = 0;
    index < bytes.byteLength;
    index += BASE64_CHUNK_SOURCE_BYTES
  ) {
    const chunk = Buffer.from(
      bytes
        .subarray(
          index,
          Math.min(index + BASE64_CHUNK_SOURCE_BYTES, bytes.byteLength),
        )
        .toString("base64"),
      "ascii",
    );
    for (let at = 0; at < chunk.byteLength; at += BASE64_LINE_LENGTH) {
      if (!atFirstLine) cursor += CRLF.copy(target, cursor);
      atFirstLine = false;
      cursor += chunk.copy(
        target,
        cursor,
        at,
        Math.min(at + BASE64_LINE_LENGTH, chunk.byteLength),
      );
    }
  }
  return cursor;
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}
