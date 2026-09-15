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
   * 5 MiB of decoded payload per message, the one number every other outgoing
   * cap is derived from. What sets it is the service's memory contract rather
   * than what a provider would accept: `MemoryHigh=192M` and `MemoryMax=256M`
   * in `ops/brain-mail.service`.
   *
   * The figure was 10 MiB until 2026-09-15, on a measurement that stopped at
   * the MIME build. Measured again through the whole path a send takes, the
   * request body off the socket, `JSON.parse`, `validateMailSendInput`, the
   * build, and `store.enqueue` into SQLite in the same request, five runs each
   * against a 39 MiB bare-node baseline:
   *
   *   payload   build    built and enqueued
   *    5 MiB    104.3 MiB   173.0 MiB
   *    6 MiB    115.7 MiB   179.3 MiB
   *    7 MiB    127.4 MiB   186.0 MiB (one run 201.3)
   *   10 MiB    164.3 MiB   278.4 MiB
   *
   * The enqueue is what the build measurement missed: the row carries the
   * whole finished message as base64url, and `JSON.stringify` makes a second
   * copy of it beside the first. 5 MiB is the largest figure whose every run
   * stayed under `MemoryHigh` with room for the service's own resident set,
   * about 19 MiB of it, and 83 MiB under `MemoryMax`. The later turn that
   * reads the row back to deliver it peaks at 80 MiB and never overlaps.
   *
   * `MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes` follows from this number:
   * base64 at 76 columns multiplies a payload by 1.3684, so 5 MiB of files
   * becomes 6.84 MiB of parts, and the 1 MiB text part and the headers take
   * the finished message to the 10 MiB stated there.
   */
  maxTotalBytes: 5_242_880,
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
 * The decoded size read off the base64 length. Decoding 5 MiB to measure it
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
