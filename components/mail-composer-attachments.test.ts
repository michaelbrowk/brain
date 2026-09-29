// @vitest-environment jsdom

// THE FILES ON THE COMPOSE SHEET, AS A LIST. What the sheet admits, what it
// says when it refuses, and what it hands the send: the codec's own caps,
// asked in the browser before a byte is read, and base64 read from the file
// only when the letter goes.

import { describe, expect, it } from "vitest";

import { MAIL_SEND_ATTACHMENT_LIMITS } from "@/lib/mail/send-attachment-codec";
import {
  ATTACHMENT_REFUSALS,
  admitAttachments,
  attachmentMimeType,
  encodeAttachments,
  type ComposeAttachment,
} from "./mail-composer-attachments";

const MIB = 1024 * 1024;

/** A file whose `size` says what the test needs without allocating it: the
 *  admission reads the size and the name, never the bytes. */
function sized(name: string, bytes: number, type = "application/pdf"): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

function standing(files: readonly File[]): ComposeAttachment[] {
  return files.map((file, index) => ({ id: index, file, filename: file.name }));
}

describe("the files a compose sheet admits", () => {
  it("admits files inside the caps, in order, under the names they travel with", () => {
    const { admitted, refusal } = admitAttachments(
      [],
      [sized("Quote.pdf", 2 * MIB), sized('Report "final".pdf', 3 * MIB)],
    );

    expect(refusal).toBeNull();
    expect(admitted.map((entry) => entry.filename)).toEqual([
      "Quote.pdf",
      "Report _final_.pdf",
    ]);
  });

  it("refuses the file that would carry the set past the total, and keeps the ones that fit", () => {
    const { admitted, refusal } = admitAttachments(standing([sized("a.pdf", 4 * MIB)]), [
      sized("big.bin", 12 * MIB),
      sized("small.txt", 1024, "text/plain"),
    ]);

    expect(admitted.map((entry) => entry.filename)).toEqual(["small.txt"]);
    expect(refusal).toBe(ATTACHMENT_REFUSALS.total);
    expect(refusal).toBe("A message can carry 10 MB of files.");
  });

  it("admits a set exactly at the total cap", () => {
    const { admitted, refusal } = admitAttachments(
      standing([sized("a.pdf", 3)]),
      [sized("b.pdf", MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes - 3)],
    );

    expect(refusal).toBeNull();
    expect(admitted).toHaveLength(1);
  });

  it("refuses the eleventh file", () => {
    const nine = standing(Array.from({ length: 9 }, (_, index) => sized(`${index}.txt`, 10)));
    const { admitted, refusal } = admitAttachments(nine, [
      sized("tenth.txt", 10),
      sized("eleventh.txt", 10),
    ]);

    expect(admitted.map((entry) => entry.filename)).toEqual(["tenth.txt"]);
    expect(refusal).toBe(ATTACHMENT_REFUSALS.count);
    expect(refusal).toBe("A message can carry 10 files.");
  });

  it("refuses a name past the codec's byte cap, counted in UTF-8", () => {
    // 128 two-byte characters are 256 bytes; 127 fit.
    const { admitted, refusal } = admitAttachments(
      [],
      [sized(`${"é".repeat(128)}`, 10), sized(`${"é".repeat(127)}`, 10)],
    );

    expect(admitted.map((entry) => entry.filename)).toEqual(["é".repeat(127)]);
    expect(refusal).toBe(ATTACHMENT_REFUSALS.name);
  });

  it("sends a type the codec cannot carry as octet-stream, and lowers the case of one it can", () => {
    expect(attachmentMimeType("")).toBe("application/octet-stream");
    expect(attachmentMimeType("text/plain; charset=utf-8")).toBe("application/octet-stream");
    expect(attachmentMimeType("Image/PNG")).toBe("image/png");
    expect(attachmentMimeType("application/pdf")).toBe("application/pdf");
  });

  it("reads each file as standard base64 only when the letter goes", async () => {
    const hello = new File(["hello"], "hello.txt", { type: "text/plain" });
    const empty = new File([], "empty.bin");
    const encoded = await encodeAttachments([
      { id: 1, file: hello, filename: "hello.txt" },
      { id: 2, file: empty, filename: "empty.bin" },
    ]);

    expect(encoded).toEqual([
      { filename: "hello.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" },
      { filename: "empty.bin", mimeType: "application/octet-stream", dataBase64: "" },
    ]);
  });
});
