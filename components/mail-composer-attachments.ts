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
/** How much of a name a sentence quotes. A name may be 255 bytes, and the
 *  slot is one line on a desktop: the file is recognised by its start. */
const QUOTED_NAME_CHARACTERS = 40;

function quoted(name: string): string {
  const characters = Array.from(name);
  return characters.length > QUOTED_NAME_CHARACTERS
    ? `“${characters.slice(0, QUOTED_NAME_CHARACTERS - 1).join("")}…”`
    : `“${name}”`;
}

/** What the slot says when a file is not taken, naming the file it means.
 *  The caps are named in the unit a person reads a file size in; the codec's
 *  MiB is the reader's MB, the way `formatBytes` counts them on the chips. */
export const ATTACHMENT_REFUSALS = Object.freeze({
  count: (name: string) =>
    `${quoted(name)} wasn’t attached. A message can carry ${MAIL_SEND_ATTACHMENT_LIMITS.maxCount} files.`,
  total: (name: string) =>
    `${quoted(name)} is too large. A message can carry ${TOTAL_MB} MB of files.`,
  name: (name: string) => `${quoted(name)} has a name too long to send.`,
  unnamed: "A file with no name can’t be attached.",
  folder: (name: string) => `${quoted(name)} is a folder. Folders can’t be attached.`,
  unreadable: (name: string) =>
    `${quoted(name)} couldn’t be read. Remove it and attach it again.`,
  /** The service's own refusal of the whole set, which names no file. */
  tooLarge: `These files are too large to send. A message can carry ${TOTAL_MB} MB of files.`,
});

/** A file the browser could not read when the letter went, by name. */
export class UnreadableAttachmentError extends Error {
  constructor(readonly filename: string) {
    super("unreadable attachment");
    this.name = "UnreadableAttachmentError";
  }
}

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
    if (file.name === "") {
      refuse(ATTACHMENT_REFUSALS.unnamed);
      continue;
    }
    const filename = safeAttachmentFilename(file.name);
    if (!isSafeAttachmentFilename(filename)) {
      refuse(ATTACHMENT_REFUSALS.name(file.name));
      continue;
    }
    if (count >= MAIL_SEND_ATTACHMENT_LIMITS.maxCount) {
      refuse(ATTACHMENT_REFUSALS.count(file.name));
      continue;
    }
    if (total + file.size > MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes) {
      refuse(ATTACHMENT_REFUSALS.total(file.name));
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
 *  stand in memory as ten reads at once on top of their own base64. A file
 *  the browser cannot read rejects with its name. */
export async function encodeAttachments(
  attachments: readonly ComposeAttachment[],
): Promise<MailSendAttachment[]> {
  const encoded: MailSendAttachment[] = [];
  for (const attachment of attachments) {
    let dataBase64: string;
    try {
      dataBase64 = await readBase64(attachment.file);
    } catch {
      throw new UnreadableAttachmentError(attachment.file.name);
    }
    encoded.push({
      filename: attachment.filename,
      mimeType: attachmentMimeType(attachment.file.type),
      dataBase64,
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
