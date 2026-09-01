import { MAIL_RESOURCE_LIMITS, admitOutgoingRawMessage } from "../security";
import type { MailEnvelope } from "../ports";

const MAX_ADDRESS_BYTES = 254;
const MAX_SUBJECT_BYTES = 998;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_REFERENCE_COUNT = 50;
const MAX_REFERENCE_BYTES = 32 * 1024;
const MAX_MESSAGE_ID_BYTES = 998;
const MAX_ENCODED_WORD_PAYLOAD_BYTES = 42;
const CRLF = Buffer.from("\r\n", "ascii");
const HEADER_BODY_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");

export interface OutboundReplyHeaders {
  readonly inReplyTo: string;
  readonly references: readonly string[];
}

export interface OutboundMessageSource {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly messageId: string;
  readonly createdAt: number;
  readonly reply: OutboundReplyHeaders | null;
}

export interface BuiltOutboundMessage {
  readonly envelope: MailEnvelope;
  readonly messageId: string;
  readonly rawRfc2822: Buffer;
}

/**
 * Builds the provider-neutral RFC 2822 payload used by Gmail and SMTP adapters.
 * The caller owns rawRfc2822 and should not include it in logs or errors.
 */
export function buildOutboundRfc2822(
  source: OutboundMessageSource,
): BuiltOutboundMessage {
  const envelope = validateEnvelope(source);
  const subject = validateSubject(source.subject);
  const text = validateText(source.text);
  const messageId = validateMessageId(source.messageId, "Message-ID", 254);
  const createdAt = validateTimestamp(source.createdAt);
  const reply = validateReplyHeaders(source.reply);

  const headers: string[] = [
    `From: ${envelope.from}`,
    foldAddressHeader("To", envelope.to),
  ];
  if (envelope.cc.length > 0) headers.push(foldAddressHeader("Cc", envelope.cc));
  // Gmail derives the SMTP envelope from these headers, then removes Bcc from
  // delivered copies. It must be present in the submitted raw message.
  if (envelope.bcc.length > 0) headers.push(foldAddressHeader("Bcc", envelope.bcc));
  headers.push(foldSubjectHeader(subject));
  headers.push(`Date: ${formatRfc2822Date(createdAt)}`);
  headers.push(`Message-ID: ${messageId}`);
  if (reply !== null) {
    headers.push(`In-Reply-To: ${reply.inReplyTo}`);
    headers.push(foldReferencesHeader(reply.references));
  }
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");

  const encodedBody = wrapBase64(Buffer.from(normalizeLineEndings(text), "utf8"));
  const rawRfc2822 = Buffer.from(
    `${headers.join("\r\n")}\r\n\r\n${encodedBody}\r\n`,
    "utf8",
  );
  try {
    admitOutgoingRawMessage(rawRfc2822.byteLength);
  } catch {
    rawRfc2822.fill(0);
    throw new Error("outbound message exceeds the configured byte limit");
  }

  return Object.freeze({ envelope, messageId, rawRfc2822 });
}

/**
 * Returns caller-owned SMTP DATA bytes without any Bcc header or continuation
 * lines. The envelope still retains blind recipients for RCPT TO, while the
 * immutable stored raw remains available for Gmail submission and the
 * sender-only Sent copy.
 */
export function buildSmtpWireRfc2822(raw: Buffer): Buffer {
  const headerEnd = raw.indexOf(HEADER_BODY_SEPARATOR);
  if (headerEnd < 1) throw new Error("outbound message headers are invalid");

  const retained: Buffer[] = [];
  let cursor = 0;
  let strippingBcc = false;
  let foundBcc = false;
  while (cursor <= headerEnd) {
    const lineEnd = raw.indexOf(CRLF, cursor);
    if (lineEnd < cursor || lineEnd > headerEnd) {
      throw new Error("outbound message headers are invalid");
    }
    const continuation = raw[cursor] === 0x20 || raw[cursor] === 0x09;
    const bcc = isBccHeader(raw, cursor, lineEnd);
    if (bcc) {
      strippingBcc = true;
      foundBcc = true;
    } else if (continuation && strippingBcc) {
      // A folded continuation belongs to the removed Bcc field.
    } else {
      strippingBcc = false;
      retained.push(raw.subarray(cursor, lineEnd + CRLF.length));
    }
    cursor = lineEnd + CRLF.length;
    if (lineEnd === headerEnd) break;
  }
  if (!foundBcc) return Buffer.from(raw);
  retained.push(raw.subarray(headerEnd + CRLF.length));
  return Buffer.concat(retained);
}

function isBccHeader(raw: Buffer, start: number, end: number): boolean {
  return (
    end - start >= 4 &&
    (raw[start] === 0x42 || raw[start] === 0x62) &&
    (raw[start + 1] === 0x43 || raw[start + 1] === 0x63) &&
    (raw[start + 2] === 0x43 || raw[start + 2] === 0x63) &&
    raw[start + 3] === 0x3a
  );
}

function validateEnvelope(source: OutboundMessageSource): MailEnvelope {
  if (!isRecord(source)) throw new Error("outbound message is invalid");
  const from = validateAddress(source.from);
  const to = validateAddressList(source.to, "To");
  const cc = validateAddressList(source.cc, "Cc");
  const bcc = validateAddressList(source.bcc, "Bcc");
  const recipients = [...to, ...cc, ...bcc];
  if (recipients.length === 0) {
    throw new Error("outbound message requires a recipient");
  }
  if (recipients.length > MAIL_RESOURCE_LIMITS.addressesPerMessage) {
    throw new Error("outbound message has too many recipients");
  }
  const seen = new Set<string>();
  for (const address of recipients) {
    const normalized = address.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error("outbound message contains duplicate recipients");
    }
    seen.add(normalized);
  }
  return Object.freeze({
    from,
    to: Object.freeze(to),
    cc: Object.freeze(cc),
    bcc: Object.freeze(bcc),
  });
}

function validateAddressList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} recipients are invalid`);
  return value.map(validateAddress);
}

function validateAddress(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) === 0 ||
    Buffer.byteLength(value) > MAX_ADDRESS_BYTES ||
    value.includes("\r") ||
    value.includes("\n") ||
    !/^[^<>\s@]+@[^<>\s@]+$/.test(value)
  ) {
    throw new Error("mail address is invalid or unsafe");
  }
  return value;
}

function validateSubject(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAX_SUBJECT_BYTES ||
    /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("mail subject is invalid or unsafe");
  }
  return value;
}

function validateText(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAX_TEXT_BYTES ||
    value.includes("\u0000")
  ) {
    throw new Error("mail text is invalid or too large");
  }
  return value;
}

function validateTimestamp(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new Error("outbound message timestamp is invalid");
  }
  return value;
}

function validateReplyHeaders(
  value: OutboundReplyHeaders | null,
): OutboundReplyHeaders | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !Object.prototype.hasOwnProperty.call(value, "inReplyTo") ||
    !Object.prototype.hasOwnProperty.call(value, "references") ||
    Reflect.ownKeys(value).length !== 2 ||
    !Array.isArray(value.references)
  ) {
    throw new Error("reply headers are invalid");
  }
  const inReplyTo = validateMessageId(
    value.inReplyTo,
    "In-Reply-To",
    MAX_MESSAGE_ID_BYTES,
  );
  if (value.references.length > MAX_REFERENCE_COUNT) {
    throw new Error("reply reference chain is too long");
  }
  const references = value.references.map((reference) =>
    validateMessageId(reference, "References", MAX_MESSAGE_ID_BYTES),
  );
  if (references.at(-1) !== inReplyTo) references.push(inReplyTo);
  const deduplicated = references.filter(
    (reference, index) => references.indexOf(reference) === index,
  );
  if (
    deduplicated.length > MAX_REFERENCE_COUNT ||
    Buffer.byteLength(deduplicated.join(" ")) > MAX_REFERENCE_BYTES
  ) {
    throw new Error("reply reference chain is too large");
  }
  return Object.freeze({
    inReplyTo,
    references: Object.freeze(deduplicated),
  });
}

function validateMessageId(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > maxBytes ||
    value.includes("\r") ||
    value.includes("\n") ||
    !/^<[^<>\s@]+@[^<>\s@]+>$/.test(value)
  ) {
    throw new Error(`${label} is invalid or unsafe`);
  }
  return value;
}

function foldAddressHeader(name: string, addresses: readonly string[]): string {
  if (addresses.length === 0) return `${name}:`;
  return `${name}: ${addresses.join(",\r\n ")}`;
}

function foldSubjectHeader(subject: string): string {
  if (subject.length === 0) return "Subject:";
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of subject) {
    const bytes = Buffer.byteLength(character);
    if (chunkBytes > 0 && chunkBytes + bytes > MAX_ENCODED_WORD_PAYLOAD_BYTES) {
      words.push(encodeWord(chunk));
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += bytes;
  }
  if (chunk.length > 0) words.push(encodeWord(chunk));
  return `Subject: ${words.join("\r\n ")}`;
}

function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function foldReferencesHeader(references: readonly string[]): string {
  if (references.length === 0) throw new Error("reply references are empty");
  return `References: ${references.join("\r\n ")}`;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
}

function wrapBase64(value: Buffer): string {
  try {
    const encoded = value.toString("base64");
    const lines: string[] = [];
    for (let index = 0; index < encoded.length; index += 76) {
      lines.push(encoded.slice(index, index + 76));
    }
    return lines.join("\r\n");
  } finally {
    value.fill(0);
  }
}

function formatRfc2822Date(value: number): string {
  return new Date(value).toUTCString().replace("GMT", "+0000");
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
