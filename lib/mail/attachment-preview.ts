import type { MailContentAttachmentDto } from "./content-types";
import { referencedInlineCidAttachments } from "./reader-html";

/** What the reader can draw of an attachment: a picture, a PDF, or nothing
 *  but a chip that downloads it. */
export type AttachmentPreviewKind = "image" | "pdf" | "file";

/** The largest image the reader draws. A tile decodes the whole file, not a
 *  thumbnail of it, so the cap is what a phone can hold for a letter full of
 *  camera photos rather than what a browser could decode. */
export const ATTACHMENT_IMAGE_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

/** The largest PDF the viewer opens. It is read into memory whole before the
 *  parser sees it, and the parser keeps its own copy. */
export const ATTACHMENT_PDF_PREVIEW_MAX_BYTES = 30 * 1024 * 1024;

/** The raster types every browser decodes on its own. SVG is absent on
 *  purpose: it is a document that can carry script and remote references,
 *  and it stays a download like every other document. */
const PREVIEW_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Decided by the type the service parsed, never by the sender's filename. */
export function classifyAttachment(
  attachment: Pick<MailContentAttachmentDto, "mimeType" | "bytes">,
): AttachmentPreviewKind {
  const mimeType = attachment.mimeType.toLowerCase();
  if (PREVIEW_IMAGE_TYPES.has(mimeType)) {
    return attachment.bytes <= ATTACHMENT_IMAGE_PREVIEW_MAX_BYTES ? "image" : "file";
  }
  if (mimeType === "application/pdf") {
    return attachment.bytes <= ATTACHMENT_PDF_PREVIEW_MAX_BYTES ? "pdf" : "file";
  }
  return "file";
}

/**
 * The attachments the reader lists under a letter. An inline image the body
 * already draws is left out, since listing it would show the same picture
 * twice (the image001.png of every signature). "Draws" is the body's own rule,
 * `referencedInlineCidAttachments`, so a part the body cannot show (an
 * explicit attachment, an image past the body's cap) stays listed rather than
 * disappearing from both places. With no HTML on screen nothing is drawn, and
 * everything is listed.
 */
export function listedAttachments(
  attachments: readonly MailContentAttachmentDto[],
  renderedHtml: string | null,
): readonly MailContentAttachmentDto[] {
  if (renderedHtml === null) return attachments;
  const drawn = new Set(
    referencedInlineCidAttachments(renderedHtml, attachments).map(
      (attachment) => attachment.attachmentId,
    ),
  );
  if (drawn.size === 0) return attachments;
  return attachments.filter((attachment) => !drawn.has(attachment.attachmentId));
}

/** The authenticated download route for one attachment. */
export function attachmentUrl(accountId: string, attachmentId: string): string {
  const query = new URLSearchParams({ accountId });
  return `/api/mail/attachments/${encodeURIComponent(attachmentId)}?${query}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.ceil(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
