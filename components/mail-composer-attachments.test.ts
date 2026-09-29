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

  it("refuses the file that would carry the set past the total, by name, and keeps the ones that fit", () => {
    const { admitted, refusal } = admitAttachments(standing([sized("a.pdf", 4 * MIB)]), [
      sized("big.bin", 12 * MIB),
      sized("small.txt", 1024, "text/plain"),
    ]);

    expect(admitted.map((entry) => entry.filename)).toEqual(["small.txt"]);
    expect(refusal).toBe(ATTACHMENT_REFUSALS.total("big.bin"));
    expect(refusal).toBe("“big.bin” is too large. A message can carry 10 MB of files.");
  });

  it("counts the total across what stands and what arrives, not file by file", () => {
    // Neither file is past the cap on its own; together with what stands,
    // and together with each other, they are.
    const onTop = admitAttachments(standing([sized("a.pdf", 6 * MIB)]), [sized("b.pdf", 5 * MIB)]);
    expect(onTop.admitted).toHaveLength(0);
    expect(onTop.refusal).toBe(ATTACHMENT_REFUSALS.total("b.pdf"));

    const together = admitAttachments([], [sized("c.pdf", 6 * MIB), sized("d.pdf", 6 * MIB)]);
    expect(together.admitted.map((entry) => entry.filename)).toEqual(["c.pdf"]);
    expect(together.refusal).toBe(ATTACHMENT_REFUSALS.total("d.pdf"));
  });

  it("says the first refusal when several files are turned down", () => {
    const { refusal } = admitAttachments(
      [],
      [sized("big.bin", 12 * MIB), sized("é".repeat(128), 10)],
    );

    expect(refusal).toBe(ATTACHMENT_REFUSALS.total("big.bin"));
  });

  it("admits a set exactly at the total cap", () => {
    const { admitted, refusal } = admitAttachments(
      standing([sized("a.pdf", 3)]),
      [sized("b.pdf", MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes - 3)],
    );

    expect(refusal).toBeNull();
    expect(admitted).toHaveLength(1);
  });

  it("refuses the eleventh file by name", () => {
    const nine = standing(Array.from({ length: 9 }, (_, index) => sized(`${index}.txt`, 10)));
    const { admitted, refusal } = admitAttachments(nine, [
      sized("tenth.txt", 10),
      sized("eleventh.txt", 10),
    ]);

    expect(admitted.map((entry) => entry.filename)).toEqual(["tenth.txt"]);
    expect(refusal).toBe(ATTACHMENT_REFUSALS.count("eleventh.txt"));
    expect(refusal).toBe("“eleventh.txt” wasn’t attached. A message can carry 10 files.");
  });

  it("refuses a name past the codec's byte cap, counted in UTF-8, shortened in the sentence", () => {
    // 128 two-byte characters are 256 bytes; 127 fit.
    const { admitted, refusal } = admitAttachments(
      [],
      [sized(`${"é".repeat(128)}`, 10), sized(`${"é".repeat(127)}`, 10)],
    );

    expect(admitted.map((entry) => entry.filename)).toEqual(["é".repeat(127)]);
    expect(refusal).toBe(ATTACHMENT_REFUSALS.name("é".repeat(128)));
    expect(refusal).toBe(`“${"é".repeat(39)}…” has a name too long to send.`);
  });

  it("quotes a name of exactly 40 characters whole", () => {
    const name = `${"a".repeat(36)}.pdf`;
    expect(ATTACHMENT_REFUSALS.total(name)).toBe(
      `“${name}” is too large. A message can carry 10 MB of files.`,
    );
  });

  it("cuts a long name between whole characters as a reader sees them", () => {
    // A family emoji is one character of several code points; a flag is two
    // regional indicators; é here is e with a combining accent. None of them
    // is split by the cut, which keeps 39 of them before the ellipsis.
    const family = "👨‍👩‍👧";
    expect(ATTACHMENT_REFUSALS.total(`${"a".repeat(38)}${family} plan.pdf`)).toBe(
      `“${"a".repeat(38)}${family}…” is too large. A message can carry 10 MB of files.`,
    );
    const flag = "🇫🇷";
    expect(ATTACHMENT_REFUSALS.total(`${"a".repeat(38)}${flag} trip.pdf`)).toContain(
      `“${"a".repeat(38)}${flag}…”`,
    );
    const accented = "é";
    expect(ATTACHMENT_REFUSALS.total(`${"a".repeat(38)}${accented} résumé.pdf`)).toContain(
      `“${"a".repeat(38)}${accented}…”`,
    );
  });

  it("names the file by the name the writer gave it, not the one it travels under", () => {
    const { refusal } = admitAttachments([], [sized('Report "final".pdf', 12 * MIB)]);
    expect(refusal).toBe("“Report \"final\".pdf” is too large. A message can carry 10 MB of files.");
  });

  it("never quotes an empty name: a sentence without one says it without quotes", () => {
    expect(ATTACHMENT_REFUSALS.folder("")).toBe("A folder can’t be attached.");
    expect(ATTACHMENT_REFUSALS.unreadable("")).toBe(
      "A file couldn’t be read. Remove it and attach it again.",
    );
    for (const sentence of [
      ATTACHMENT_REFUSALS.total(""),
      ATTACHMENT_REFUSALS.count(""),
      ATTACHMENT_REFUSALS.name(""),
    ]) {
      expect(sentence).not.toContain("“”");
    }
  });

  it("refuses a file with no name with a sentence of its own", () => {
    const { admitted, refusal } = admitAttachments([], [sized("", 10)]);

    expect(admitted).toHaveLength(0);
    expect(refusal).toBe(ATTACHMENT_REFUSALS.unnamed);
    expect(refusal).toBe("A file with no name can’t be attached.");
  });

  it("names a folder and a file it could not read", () => {
    expect(ATTACHMENT_REFUSALS.folder("Photos")).toBe(
      "“Photos” is a folder. Folders can’t be attached.",
    );
    expect(ATTACHMENT_REFUSALS.unreadable("Quote.pdf")).toBe(
      "“Quote.pdf” couldn’t be read. Remove it and attach it again.",
    );
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

  it("names the file it could not read, so the slot can", async () => {
    // A file moved or changed on disk after it was chosen: the browser's
    // reader fails, and the refusal names that file.
    class FailingReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = new DOMException("gone", "NotReadableError");
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    }
    const original = globalThis.FileReader;
    globalThis.FileReader = FailingReader as unknown as typeof FileReader;
    try {
      await expect(
        encodeAttachments([{ id: 1, file: new File(["x"], "gone.pdf"), filename: "gone.pdf" }]),
      ).rejects.toMatchObject({ filename: "gone.pdf" });
    } finally {
      globalThis.FileReader = original;
    }
  });
});
