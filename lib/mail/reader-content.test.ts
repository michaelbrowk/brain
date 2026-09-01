import { describe, expect, it } from "vitest";

import {
  readableMailBody,
  readableSanitizedMailHtml,
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
