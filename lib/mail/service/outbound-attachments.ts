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
 */
export function buildMultipartBody(
  text: string,
  parts: readonly OutboundAttachmentPart[],
  boundary: string,
): Buffer {
  if (typeof boundary !== "string" || !SAFE_BOUNDARY.test(boundary)) {
    throw new Error("outbound multipart boundary is invalid");
  }
  const sections: string[] = [
    [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(text, "utf8").toString("base64")),
    ].join("\r\n"),
  ];
  for (const part of parts) {
    sections.push(
      [
        `--${boundary}`,
        `Content-Type: ${part.mimeType}`,
        `Content-Disposition: attachment; ${encodeAttachmentFilename(part.filename)}`,
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(part.bytes.toString("base64")),
      ].join("\r\n"),
    );
  }
  return Buffer.from(`${sections.join("\r\n")}\r\n--${boundary}--`, "utf8");
}

function wrapBase64(encoded: string): string {
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += BASE64_LINE_LENGTH) {
    lines.push(encoded.slice(index, index + BASE64_LINE_LENGTH));
  }
  return lines.join("\r\n");
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
