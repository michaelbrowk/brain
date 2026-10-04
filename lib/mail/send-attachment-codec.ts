/**
 * The wire shape of an outgoing attachment, shared by Brain and the mail
 * service so one list of rules decides what may reach a MIME header. The
 * service builds the multipart body from it; Brain fills it from a page's own
 * attachments.
 */

import { MAIL_MAX_RECIPIENTS } from "./recipients";

export const MAIL_SEND_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 10,
  maxFilenameBytes: 255,
  /**
   * 10 MiB of decoded payload per message, the one number every other outgoing
   * cap is derived from. What sets it is the service's memory contract rather
   * than what a provider would accept: `MemoryHigh=232M` and `MemoryMax=296M`
   * in `ops/brain-mail.service`.
   *
   * The figure was 10 MiB on an enqueue nobody had measured, then 5 MiB once
   * somebody did, then 8 MiB once the outbox row carried the message as a BLOB
   * rather than inside its JSON (schema 3), and is 10 MiB again now that the
   * service has been given the memory to hold it. Measured with
   * `scripts/mail-outbox-memory-probe.mjs`, `process.resourceUsage().maxRSS`,
   * one process per stage, three runs each, worst run shown, against a 35.8 MiB
   * bare-node baseline:
   *
   *   payload   build       enqueued     read back   drain ×20
   *    9 MiB    149.4 MiB   177.9 MiB     68.6 MiB   176.9 MiB
   *   10 MiB    160.3 MiB   191.8 MiB     71.4 MiB   197.2 MiB
   *   11 MiB    170.2 MiB   204.4 MiB     74.5 MiB   210.3 MiB
   *
   * The bar is `MemoryHigh` less 15 MiB — 217 MiB — which is the room the
   * service's own resident set needs above a bare node, and it is every run of
   * every stage rather than the worst stage alone. 10 MiB holds it with
   * 19.8 MiB to spare at its own worst, the drain. A drain of a hundred
   * measures 195.7 MiB, so the peak is set by one message and not by the depth
   * of the queue. 11 MiB holds the bar too, by 6.7 MiB, and that is the
   * headroom above this cap rather than a reason to take it: 10 MiB is the
   * figure asked for, and the memory went up to reach it.
   *
   * `MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes` follows from this number:
   * base64 at 76 columns multiplies a payload by 1.3684, so 10 MiB of files
   * becomes 13.68 MiB of parts. The text part costs more than its own limit,
   * because every line break becomes CRLF before it is encoded, so the worst
   * 1 MiB body is 2.74 MiB of part. The whole worst shape the composer can
   * build measures 16.45 MiB, under the 17 MiB stated there.
   */
  maxTotalBytes: 10_485_760,
});

/**
 * The most structure a body that carries a send may hold, counted as the
 * brackets, braces and commas outside its strings. A body is cut off by its
 * bytes first, and 24 MiB of JSON is still enough to cost hundreds of
 * megabytes once parsed when it is all structure: a million empty objects, or
 * twelve million numbers, measured at up to 854 MiB over the process's
 * resident set, before the codec ever saw the result and refused it. So the
 * structure is counted before the parse, against what a send can hold.
 *
 * The largest send is one object of at most sixteen members, three recipient
 * lists with `MAIL_MAX_RECIPIENTS` addresses between them, and
 * `MAIL_SEND_ATTACHMENT_LIMITS.maxCount` files of three members each (two
 * braces, two commas, and the comma after the file). That is 176, and a send
 * built at every cap counts 167. A draft and its mutations are flat objects
 * and hold less. The bound is eight times that: a refusal here is for a body
 * that is not a send at all, and what a send is stays the codec's to say.
 */
export const MAIL_SEND_BODY_MAX_STRUCTURAL_TOKENS =
  8 *
  (2 + 16 + 3 * 2 + MAIL_MAX_RECIPIENTS + 2 + MAIL_SEND_ATTACHMENT_LIMITS.maxCount * 5);

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Whether UTF-8 JSON text holds more than `maxTokens` brackets, braces and
 * commas outside its strings. One pass, no allocation, and it stops at the
 * token that crosses the bound, so the bodies it exists for cost a few
 * thousand bytes of reading. Every byte it tests for is ASCII, which no
 * multi-byte UTF-8 sequence contains. It does not say the text is JSON: a
 * string that never ends hides whatever follows it, and the parser refuses
 * that body on its own.
 */
export function exceedsMailJsonStructure(
  body: Uint8Array,
  maxTokens: number,
): boolean {
  let tokens = 0;
  let index = 0;
  while (index < body.length) {
    const byte = body[index]!;
    if (byte === QUOTE) {
      index = endOfJsonString(body, index + 1);
      continue;
    }
    // , [ ] { }
    if (
      byte === 0x2c ||
      byte === 0x5b ||
      byte === 0x5d ||
      byte === 0x7b ||
      byte === 0x7d
    ) {
      tokens += 1;
      if (tokens > maxTokens) return true;
    }
    index += 1;
  }
  return false;
}

/**
 * The index after the quote that closes a string whose content starts at
 * `start`, or the end of the body. A quote closes the string unless an odd
 * run of backslashes stands before it. The search for the quote is the
 * engine's own, so ten megabytes of base64 are skipped rather than read here.
 */
function endOfJsonString(body: Uint8Array, start: number): number {
  let from = start;
  for (;;) {
    const quote = body.indexOf(QUOTE, from);
    if (quote === -1) return body.length;
    let backslashes = 0;
    while (
      quote - 1 - backslashes >= start &&
      body[quote - 1 - backslashes] === BACKSLASH
    ) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return quote + 1;
    from = quote + 1;
  }
}

export interface MailSendAttachment {
  readonly filename: string;
  readonly mimeType: string;
  /** Standard base64, no line breaks. */
  readonly dataBase64: string;
}

export class MailSendAttachmentError extends Error {
  constructor() {
    super("mail_send_attachments_invalid");
    this.name = "MailSendAttachmentError";
  }
}

/**
 * A filename travels inside a MIME header parameter, so a separator, a quote,
 * a control character or a line break would either escape the parameter or
 * name a path the sender never chose.
 */
const UNSAFE_FILENAME = /[\u0000-\u001f\u007f"\\/]/u;
const UNSAFE_FILENAME_CHARACTERS = new RegExp(UNSAFE_FILENAME.source, "gu");
const MIME_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The two rules the service's MIME writer relies on as well, exported so one
 * list decides what may reach a header rather than two that drift. The byte
 * count is `TextEncoder`'s rather than `Buffer`'s because the compose sheet
 * asks the same question in a browser, where there is no `Buffer`; both
 * count a lone surrogate as the three bytes of its replacement character.
 */
export function isSafeAttachmentFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <=
      MAIL_SEND_ATTACHMENT_LIMITS.maxFilenameBytes &&
    !UNSAFE_FILENAME.test(value)
  );
}

/**
 * A name from someone's disk, made one the rule above admits: every character
 * a header parameter cannot carry becomes an underscore. A file called
 * `Report "final".pdf` is the writer's own file, and refusing it for its
 * quotes would be refusing them for their punctuation. The byte cap is not
 * this function's to meet; a name that is still too long is refused.
 */
export function safeAttachmentFilename(value: string): string {
  return value.replace(UNSAFE_FILENAME_CHARACTERS, "_");
}

export function isSafeAttachmentMimeType(value: unknown): value is string {
  return typeof value === "string" && MIME_TYPE.test(value);
}

export function validateMailSendAttachments(
  value: unknown,
): readonly MailSendAttachment[] {
  if (!Array.isArray(value) || value.length > MAIL_SEND_ATTACHMENT_LIMITS.maxCount) {
    throw new MailSendAttachmentError();
  }
  let total = 0;
  const attachments = value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Reflect.ownKeys(entry).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(entry, "filename") ||
      !Object.prototype.hasOwnProperty.call(entry, "mimeType") ||
      !Object.prototype.hasOwnProperty.call(entry, "dataBase64")
    ) {
      throw new MailSendAttachmentError();
    }
    const { filename, mimeType, dataBase64 } = entry as Record<string, unknown>;
    if (
      !isSafeAttachmentFilename(filename) ||
      !isSafeAttachmentMimeType(mimeType) ||
      typeof dataBase64 !== "string" ||
      dataBase64.length % 4 !== 0 ||
      !STANDARD_BASE64.test(dataBase64)
    ) {
      throw new MailSendAttachmentError();
    }
    total += mailSendAttachmentBytes(dataBase64);
    if (total > MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new MailSendAttachmentError();
    }
    return Object.freeze({ filename, mimeType, dataBase64 });
  });
  return Object.freeze(attachments);
}

/**
 * The decoded size read off the base64 length. Decoding 10 MiB to measure it
 * is the allocation the cap exists to prevent. The group count is floored
 * because the function is exported for a tool to size a file, and a length
 * that is not a whole number of groups would otherwise answer a fraction.
 */
export function mailSendAttachmentBytes(dataBase64: string): number {
  const padding = dataBase64.endsWith("==")
    ? 2
    : dataBase64.endsWith("=")
      ? 1
      : 0;
  return Math.floor(dataBase64.length / 4) * 3 - padding;
}
