// THE FILES ON THE COMPOSE SHEET.
//
// They live in the sheet's memory and nowhere else: never in the draft, whose
// API stores no files, and never in localStorage. A file is held as the
// browser's own handle until the letter goes, and only then read, as base64,
// into the send input the MCP tool already speaks (`MailSendAttachment`).
//
// Every refusal is the codec's own rule asked early. The count, the total and
// the name's bytes are `MAIL_SEND_ATTACHMENT_LIMITS`; a name's characters and
// a content type are the codec's too. The route asks the same questions again,
// so nothing here is the last word; it is the first one, said in the slot at
// the moment of the gesture rather than after a round trip.

import {
  isSafeAttachmentFilename,
  isSafeAttachmentMimeType,
  MAIL_SEND_ATTACHMENT_LIMITS,
  safeAttachmentFilename,
  type MailSendAttachment,
} from "@/lib/mail/send-attachment-codec";

export type ComposeAttachment = {
  /** The sheet's own handle for the chip, stable across removals. */
  readonly id: number;
  readonly file: File;
  /** The name it travels under: the disk's own, with what a header cannot
   *  carry turned into underscores (`safeAttachmentFilename`). */
  readonly filename: string;
};

const TOTAL_MB = MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes / (1024 * 1024);

/** What the slot says when a file is not taken. The caps are named in the
 *  unit a person reads a file size in; the codec's MiB is the reader's MB,
 *  the way `formatBytes` counts them on the chips. */
export const ATTACHMENT_REFUSALS = Object.freeze({
  count: `A message can carry ${MAIL_SEND_ATTACHMENT_LIMITS.maxCount} files.`,
  total: `A message can carry ${TOTAL_MB} MB of files.`,
  name: "That file’s name is too long to send.",
  folder: "Folders can’t be attached.",
  unreadable: "A file couldn’t be read. Remove it and attach it again.",
});

/**
 * Which of `incoming` join the sheet. Each file is judged on its own against
 * what already stands, so a file that does not fit does not keep out a
 * smaller one after it; the first refusal is the sentence the slot says.
 */
export function admitAttachments(
  current: readonly ComposeAttachment[],
  incoming: readonly File[],
): {
  readonly admitted: readonly Omit<ComposeAttachment, "id">[];
  readonly refusal: string | null;
} {
  let count = current.length;
  let total = current.reduce((sum, entry) => sum + entry.file.size, 0);
  let refusal: string | null = null;
  const admitted: Omit<ComposeAttachment, "id">[] = [];
  const refuse = (sentence: string) => {
    refusal ??= sentence;
  };
  for (const file of incoming) {
    const filename = safeAttachmentFilename(file.name);
    if (!isSafeAttachmentFilename(filename)) {
      refuse(ATTACHMENT_REFUSALS.name);
      continue;
    }
    if (count >= MAIL_SEND_ATTACHMENT_LIMITS.maxCount) {
      refuse(ATTACHMENT_REFUSALS.count);
      continue;
    }
    if (total + file.size > MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes) {
      refuse(ATTACHMENT_REFUSALS.total);
      continue;
    }
    count += 1;
    total += file.size;
    admitted.push({ file, filename });
  }
  return { admitted, refusal };
}

/** A file's own type when the codec can carry it, lowered the way the
 *  codec's rule is written; anything else (no type, parameters, a shape
 *  that is not a type) goes as bytes the recipient's client names itself. */
export function attachmentMimeType(type: string): string {
  const lowered = type.toLowerCase();
  return isSafeAttachmentMimeType(lowered) ? lowered : "application/octet-stream";
}

/** The files as the send carries them. One at a time, so ten files never
 *  stand in memory as ten reads at once on top of their own base64. */
export async function encodeAttachments(
  attachments: readonly ComposeAttachment[],
): Promise<MailSendAttachment[]> {
  const encoded: MailSendAttachment[] = [];
  for (const attachment of attachments) {
    encoded.push({
      filename: attachment.filename,
      mimeType: attachmentMimeType(attachment.file.type),
      dataBase64: await readBase64(attachment.file),
    });
  }
  return encoded;
}

/** The browser's own encoder: a data URL is standard base64 with no line
 *  breaks, and what follows its first comma is the payload. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      if (comma === -1) reject(new Error("unreadable file"));
      else resolve(url.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("unreadable file"));
    reader.readAsDataURL(file);
  });
}
