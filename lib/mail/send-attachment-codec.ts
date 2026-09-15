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
   * 10 MiB of decoded payload per message, the one number every other
   * outgoing cap is derived from. What sets it is the service's memory
   * contract rather than what a provider would accept: `MemoryHigh=192M` and
   * `MemoryMax=256M` in `ops/brain-mail.service`, measured twice on
   * 2026-09-15 at 155 and 165 MiB peak RSS for one send of 10 MiB against a
   * 37.5 MiB bare-node baseline. 165 is the number to hold against
   * `MemoryMax`, which leaves about 90 MiB of margin. `MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes` follows from it:
   * base64 at 76 columns multiplies a payload by 1.3684, so 10 MiB of files
   * becomes 13.68 MiB of parts, and the 1 MiB text part and the headers take
   * the finished message to the 18 MiB stated there.
   */
  maxTotalBytes: 10_485_760,
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
