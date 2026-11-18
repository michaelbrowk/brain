import { describe, expect, it } from "vitest";

import {
  preferSanitizedHtmlAlternative,
  readableMailBody,
  readableSanitizedMailHtml,
  sanitizeSnippet,
  textFromSanitizedHtml,
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

  it("keeps a long agenda without punctuation in both MIME alternatives", () => {
    const lines = [
      "Review the research findings with the design team",
      "Confirm the priorities for the next release with engineering",
      "Collect feedback from everyone who tested the prototype",
      "Decide which changes to include in the first public release",
      "Share the updated timeline with the customer research group",
      "Plan the follow up conversations before the meeting",
    ];
    const text = lines.join("\n");
    const html = lines.map((line) => `<p>${line}</p>`).join("");
    expect(readableMailBody(text)).toBe(text);
    expect(readableSanitizedMailHtml(html)).toBe(html);
  });

  it("still recognizes a transfer body wrapped onto MIME lines", () => {
    const text = Array(4).fill("QUJD".repeat(19)).join("\r\n");
    expect(readableMailBody(text)).toBeNull();
    expect(readableSanitizedMailHtml(`<pre>${text}</pre>`)).toBeNull();
  });

  it("prefers a ticket image over the sender's plain-text fallback", () => {
    const text = "Please open the HTML version of this email.";
    const html = '<img data-brain-cid="ticket">';
    const ticket = { attachmentId: "scan", filename: "ticket.png", contentId: "ticket", bytes: 128,
      mimeType: "image/png", disposition: "inline" as const };
    expect(preferSanitizedHtmlAlternative(text, html, [ticket])).toBe(true);
    expect(preferSanitizedHtmlAlternative(text, html, [])).toBe(false);
    expect(preferSanitizedHtmlAlternative(text, `<img data-brain-remote-image="remote-image-a${"1".repeat(32)}">`)).toBe(true);
    expect(preferSanitizedHtmlAlternative(text, "<p></p>")).toBe(false);
  });

  it("ignores stylesheet metadata in the preview and forwarded text", () => {
    const css = '<span data-brain-mail-css="#brain-mail-content .bm-c-cta{color:red}"></span>';
    expect(readableSanitizedMailHtml(css)).toBeNull();
    const html = css + '<p><a class="bm-c-cta" data-brain-href="https://example.test/pass">View <b>pass</b></a></p>';
    expect(textFromSanitizedHtml(html, { includeLinkDestinations: true })).toBe("View pass (https://example.test/pass)");
    expect(textFromSanitizedHtml(html)).toBe("View pass");
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
