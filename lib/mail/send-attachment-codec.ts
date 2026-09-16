/**
 * The wire shape of an outgoing attachment, shared by Brain and the mail
 * service so one list of rules decides what may reach a MIME header. The
 * service builds the multipart body from it; Brain fills it from a page's own
 * attachments.
 */

export const MAIL_SEND_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 10,
  maxFilenameBytes: 255,
  /**
   * 8 MiB of decoded payload per message, the one number every other outgoing
   * cap is derived from. What sets it is the service's memory contract rather
   * than what a provider would accept: `MemoryHigh=192M` and `MemoryMax=256M`
   * in `ops/brain-mail.service`.
   *
   * The figure was 10 MiB on an enqueue nobody had measured, then 5 MiB once
   * somebody did, and is 8 MiB now that the outbox row carries the message as a
   * BLOB rather than inside its JSON (schema 3). Measured with
   * `scripts/mail-outbox-memory-probe.mjs`, `process.resourceUsage().maxRSS`,
   * one process per stage, three runs each, worst run shown, against a 35.8 MiB
   * bare-node baseline:
   *
   *   payload   build       enqueued     read back
   *    5 MiB    101.4 MiB   119.6 MiB     56.4 MiB
   *    7 MiB    124.0 MiB   147.9 MiB     61.8 MiB
   *    8 MiB    136.1 MiB   162.2 MiB     64.7 MiB
   *    9 MiB    148.0 MiB   177.1 MiB     67.5 MiB
   *   10 MiB    159.1 MiB   190.7 MiB     70.0 MiB
   *
   * The enqueue is the peak a send has to survive, and the bar is `MemoryHigh`
   * less 15 MiB, which is the room the service's own resident set needs above a
   * bare node. 8 MiB holds it with 29.8 MiB to spare. 9 MiB misses by 0.1 MiB
   * and 10 MiB is 1.3 MiB under `MemoryHigh`, which is not a margin. The turn
   * that reads the row back to deliver it peaks at 64.7 MiB and never overlaps
   * a build.
   *
   * What the BLOB bought is the difference between 278 MiB and 190.7 MiB at
   * 10 MiB of files: the message used to be materialised twice more after the
   * build, once as a base64url string on the record and once by
   * `JSON.stringify` copying that string into the row.
   *
   * `MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes` follows from this number:
   * base64 at 76 columns multiplies a payload by 1.3684, so 8 MiB of files
   * becomes 10.95 MiB of parts, and the 1 MiB text part and the headers take
   * the finished message to the 14 MiB stated there.
   */
  maxTotalBytes: 8_388_608,
});

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
const MIME_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The two rules the service's MIME writer relies on as well, exported so one
 * list decides what may reach a header rather than two that drift.
 */
export function isSafeAttachmentFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAIL_SEND_ATTACHMENT_LIMITS.maxFilenameBytes &&
    !UNSAFE_FILENAME.test(value)
  );
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
 * The decoded size read off the base64 length. Decoding 8 MiB to measure it
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
