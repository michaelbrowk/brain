import { describe, expect, it } from "vitest";

import type { MailContentAttachmentDto } from "./content-types";
import {
  ATTACHMENT_IMAGE_PREVIEW_MAX_BYTES,
  ATTACHMENT_PDF_PREVIEW_MAX_BYTES,
  attachmentUrl,
  classifyAttachment,
  formatBytes,
  listedAttachments,
} from "./attachment-preview";

const MIB = 1024 * 1024;

function attachment(
  overrides: Partial<MailContentAttachmentDto> = {},
): MailContentAttachmentDto {
  return {
    attachmentId: "attachment-a0123456789abcdef0123456789abcdef",
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    disposition: "attachment",
    contentId: null,
    bytes: 2 * MIB,
    ...overrides,
  };
}

describe("classifyAttachment", () => {
  it("previews the four raster types a browser decodes without help", () => {
    for (const mimeType of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(classifyAttachment(attachment({ mimeType }))).toBe("image");
    }
  });

  it("never previews SVG, which is a document and not a picture", () => {
    expect(classifyAttachment(attachment({ mimeType: "image/svg+xml", bytes: 1_024 }))).toBe(
      "file",
    );
  });

  it("leaves every other image type as a file", () => {
    for (const mimeType of ["image/heic", "image/tiff", "image/bmp", "image/avif"]) {
      expect(classifyAttachment(attachment({ mimeType }))).toBe("file");
    }
  });

  it("caps an image at 15 MiB, inclusive", () => {
    expect(ATTACHMENT_IMAGE_PREVIEW_MAX_BYTES).toBe(15 * MIB);
    expect(
      classifyAttachment(attachment({ bytes: ATTACHMENT_IMAGE_PREVIEW_MAX_BYTES })),
    ).toBe("image");
    expect(
      classifyAttachment(attachment({ bytes: ATTACHMENT_IMAGE_PREVIEW_MAX_BYTES + 1 })),
    ).toBe("file");
  });

  it("previews a PDF up to 30 MiB, inclusive", () => {
    expect(ATTACHMENT_PDF_PREVIEW_MAX_BYTES).toBe(30 * MIB);
    const pdf = { mimeType: "application/pdf", filename: "agenda.pdf" };
    expect(
      classifyAttachment(attachment({ ...pdf, bytes: ATTACHMENT_PDF_PREVIEW_MAX_BYTES })),
    ).toBe("pdf");
    expect(
      classifyAttachment(attachment({ ...pdf, bytes: ATTACHMENT_PDF_PREVIEW_MAX_BYTES + 1 })),
    ).toBe("file");
  });

  it("reads the type without regard to case", () => {
    expect(classifyAttachment(attachment({ mimeType: "IMAGE/PNG" }))).toBe("image");
    expect(classifyAttachment(attachment({ mimeType: "Image/Jpeg" }))).toBe("image");
    expect(classifyAttachment(attachment({ mimeType: "APPLICATION/PDF", bytes: 1_024 }))).toBe(
      "pdf",
    );
    expect(classifyAttachment(attachment({ mimeType: "IMAGE/SVG+XML", bytes: 1_024 }))).toBe(
      "file",
    );
  });

  it("goes by the type, not by the filename", () => {
    expect(
      classifyAttachment(attachment({ filename: "scan.pdf", mimeType: "application/zip" })),
    ).toBe("file");
    expect(
      classifyAttachment(attachment({ filename: "notes.zip", mimeType: "application/pdf" })),
    ).toBe("pdf");
    expect(classifyAttachment(attachment({ mimeType: "text/html" }))).toBe("file");
  });
});

describe("listedAttachments", () => {
  const logo = attachment({
    attachmentId: "attachment-logo",
    filename: "image001.png",
    mimeType: "image/png",
    disposition: "inline",
    contentId: "logo@example.test",
    bytes: 4_096,
  });
  const photo = attachment({ attachmentId: "attachment-photo", filename: "Image.jpg" });

  it("drops an inline image the letter's HTML already draws", () => {
    const html = '<p>Hi</p><img data-brain-cid="logo@example.test" alt="Logo">';
    expect(listedAttachments([logo, photo], html)).toEqual([photo]);
  });

  it("keeps an inline image nobody references", () => {
    expect(listedAttachments([logo, photo], "<p>No pictures here</p>")).toEqual([logo, photo]);
  });

  it("keeps everything when the reader shows the text part instead of the HTML", () => {
    expect(listedAttachments([logo, photo], null)).toEqual([logo, photo]);
  });

  it("keeps a referenced part the body cannot draw, so it is not lost", () => {
    // An explicit attachment is never promoted into the body, and an inline
    // image past the body's own size cap stays as alt text there.
    const promoted = { ...logo, attachmentId: "attachment-explicit", disposition: "attachment" as const };
    const huge = {
      ...logo,
      attachmentId: "attachment-huge",
      contentId: "huge@example.test",
      bytes: 9 * MIB,
    };
    const html = [
      '<img data-brain-cid="logo@example.test" alt="">',
      '<img data-brain-cid="huge@example.test" alt="">',
    ].join("");
    expect(listedAttachments([promoted, huge], html)).toEqual([promoted, huge]);
  });
});

describe("attachment helpers", () => {
  it("addresses the download route by id with the account in the query", () => {
    expect(attachmentUrl("account-a1", "attachment/b 2")).toBe(
      "/api/mail/attachments/attachment%2Fb%202?accountId=account-a1",
    );
  });

  it("formats sizes the way the chip always has", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_500)).toBe("2 KB");
    expect(formatBytes(2.5 * MIB)).toBe("2.5 MB");
  });
});
