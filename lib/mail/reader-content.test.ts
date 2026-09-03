import { describe, expect, it } from "vitest";

import {
  readableMailBody,
  readableSanitizedMailHtml,
  sanitizeSnippet,
} from "./reader-content";

describe("mail reader content fallback", () => {
  it.each([
    "=E2=80=8C encoded plain",
    `${"QUJD".repeat(64)}==`,
    "=ZZ hello \ufffd",
    "broken \ufffd\ufffd decoder output",
  ])("rejects malformed or still transfer-encoded text: %s", (value) => {
    expect(readableMailBody(value)).toBeNull();
  });

  it("keeps ordinary readable text, including a literal equals sign", () => {
    expect(readableMailBody("A = B and the message is readable.")).toBe(
      "A = B and the message is readable.",
    );
  });

  it("rejects still-encoded sanitized HTML but keeps bounded CID-only mail", () => {
    expect(
      readableSanitizedMailHtml("<p>=CD=8F =E2=80=8C =C2=A0</p>"),
    ).toBeNull();
    expect(
      readableSanitizedMailHtml(`<p>${"QUJD".repeat(64)}</p>`),
    ).toBeNull();
    expect(
      readableSanitizedMailHtml(
        '<img data-brain-cid="logo@example.test" alt="">',
      ),
    ).not.toBeNull();
  });
});

describe("sanitizeSnippet", () => {
  it("expands entities, drops image markers and collapses whitespace", () => {
    expect(
      sanitizeSnippet("Your booking is confirmed. [image] Don&#39;t forget"),
    ).toBe("Your booking is confirmed. Don't forget");
    expect(sanitizeSnippet("[image] See what&#39;s trending")).toBe(
      "See what's trending",
    );
    expect(sanitizeSnippet("a\n\n  b\tc")).toBe("a b c");
    expect(sanitizeSnippet("[cid:logo@example] Hello")).toBe("Hello");
  });

  it("leaves a bracket that is not an image marker alone", () => {
    expect(sanitizeSnippet("[Urgent] the lease")).toBe("[Urgent] the lease");
  });

  it("returns nothing when nothing survives — absence, not the word", () => {
    expect(sanitizeSnippet("[image]")).toBe("");
    expect(sanitizeSnippet("   ")).toBe("");
    expect(sanitizeSnippet(null)).toBe("");
  });
});
