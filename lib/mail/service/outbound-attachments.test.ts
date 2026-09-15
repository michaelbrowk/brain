import { describe, expect, it } from "vitest";

import {
  buildMultipartBody,
  encodeAttachmentFilename,
  encodeBase64Body,
  multipartBoundary,
} from "./outbound-attachments";

const messageId = "<brain.1@example.com>";

describe("outgoing multipart writer", () => {
  it("derives the boundary from the message id so a replay rebuilds it", () => {
    const boundary = multipartBoundary(messageId);
    expect(boundary).toMatch(/^----brain-[0-9a-f]{32}$/);
    expect(multipartBoundary(messageId)).toBe(boundary);
    expect(multipartBoundary("<brain.2@example.com>")).not.toBe(boundary);
  });

  it("encodes a non-ASCII filename with RFC 5987 and keeps an ASCII fallback", () => {
    // The same encoding the download path already emits, so a filename that
    // survives a download survives a send.
    expect(encodeAttachmentFilename("счёт 2026.pdf")).toBe(
      "filename=\"_2026.pdf\"; filename*=UTF-8''%D1%81%D1%87%D1%91%D1%82%202026.pdf",
    );
    expect(encodeAttachmentFilename("invoice.pdf")).toBe('filename="invoice.pdf"');
  });

  it("puts the text part first and closes the last boundary", () => {
    const boundary = multipartBoundary(messageId);
    const body = buildMultipartBody(
      "see attached",
      [
        {
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          bytes: Buffer.from("PDF-BYTES"),
        },
      ],
      boundary,
    ).toString("utf8");

    const parts = body.split(`--${boundary}`);
    expect(parts).toHaveLength(4);
    expect(parts[1]).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(parts[1]).toContain("Content-Transfer-Encoding: base64");
    expect(parts[2]).toContain("Content-Type: application/pdf");
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="invoice.pdf"');
    expect(parts[2]).toContain("Content-Transfer-Encoding: base64");
    expect(body.endsWith(`--${boundary}--`)).toBe(true);

    const encoded = parts[2].split("\r\n\r\n", 2)[1].replaceAll("\r\n", "");
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("PDF-BYTES");
  });

  it("wraps every base64 line at 76 characters", () => {
    const body = buildMultipartBody(
      "x",
      [
        {
          filename: "big.bin",
          mimeType: "application/octet-stream",
          bytes: Buffer.alloc(1_000, 7),
        },
      ],
      multipartBoundary(messageId),
    ).toString("utf8");
    for (const line of body.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it("truncates a long non-ASCII name to the bound the header limit needs", () => {
    // 255 bytes of Cyrillic percent-encode to three bytes each, so the bound
    // rather than the filename cap is what keeps the header under 998.
    const name = `${"я".repeat(127)}.pdf`;
    expect(Buffer.byteLength(name)).toBe(258);
    const header = `Content-Disposition: attachment; ${encodeAttachmentFilename(name)}`;
    expect(Buffer.byteLength(header)).toBeLessThan(998);
    expect(header).toContain("%D1%8F");
    expect(header).not.toContain(".pdf\"");
  });

  it("encodes a payload spanning chunks exactly as one wrapped encoding", () => {
    // The writer encodes 57 source bytes per line and 512 lines per chunk.
    // Both numbers have to hold or a receiver reads a different file.
    for (const size of [0, 1, 56, 57, 58, 29_184, 29_185, 61_000]) {
      const bytes = Buffer.alloc(size, 5);
      const whole = bytes.toString("base64");
      const wrapped: string[] = [];
      for (let index = 0; index < whole.length; index += 76) {
        wrapped.push(whole.slice(index, index + 76));
      }
      expect(encodeBase64Body(bytes).toString("ascii")).toBe(
        wrapped.join("\r\n"),
      );
    }
  });

  it("leaves the caller's bytes intact so the caller can wipe them once", () => {
    const bytes = Buffer.from("PDF-BYTES");
    buildMultipartBody(
      "one line",
      [{ filename: "invoice.pdf", mimeType: "application/pdf", bytes }],
      multipartBoundary(messageId),
    );
    expect(bytes.toString("utf8")).toBe("PDF-BYTES");
  });

  it("refuses a boundary that could be forged from a header", () => {
    expect(() =>
      buildMultipartBody("one line", [], 'not a boundary"'),
    ).toThrow(/boundary/i);
  });
});
