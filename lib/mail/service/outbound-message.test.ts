import { describe, expect, it } from "vitest";

import {
  buildOutboundRfc2822,
  buildSmtpWireRfc2822,
} from "./outbound-message";

const createdAt = Date.parse("2026-07-15T09:30:00.000Z");

describe("outbound RFC 2822 builder", () => {
  it("builds a bounded UTF-8 compose message without leaking recipients into errors", () => {
    const built = buildOutboundRfc2822({
      from: "me@example.com",
      to: ["friend@example.net"],
      cc: ["team@example.org"],
      bcc: ["private@example.test"],
      subject: "Привет",
      text: "Первая строка\nВторая строка",
      messageId: "<brain.1@example.com>",
      createdAt,
      reply: null,
    });

    const source = built.rawRfc2822.toString("utf8");
    expect(source).toContain("From: me@example.com\r\n");
    expect(source).toContain("To: friend@example.net\r\n");
    expect(source).toContain("Cc: team@example.org\r\n");
    expect(source).toContain("Bcc: private@example.test\r\n");
    expect(source).toContain("Subject: =?UTF-8?B?");
    expect(source).toContain("Date: Wed, 15 Jul 2026 09:30:00 +0000\r\n");
    expect(source).toContain("Message-ID: <brain.1@example.com>\r\n");
    expect(source).not.toContain("Первая строка");

    const encoded = source.split("\r\n\r\n", 2)[1].replaceAll("\r\n", "");
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
      "Первая строка\r\nВторая строка",
    );
    expect(built.envelope.bcc).toEqual(["private@example.test"]);

    const smtpWire = buildSmtpWireRfc2822(built.rawRfc2822);
    expect(smtpWire.toString("utf8")).not.toMatch(/(?:^|\r\n)Bcc:/i);
    expect(smtpWire.toString("utf8")).toContain("Cc: team@example.org\r\n");
    expect(smtpWire.subarray(smtpWire.indexOf("\r\n\r\n"))).toEqual(
      built.rawRfc2822.subarray(built.rawRfc2822.indexOf("\r\n\r\n")),
    );
    smtpWire.fill(0);
  });

  it("removes a folded Bcc field without touching a body line named Bcc", () => {
    const raw = Buffer.from(
      "From: me@example.com\r\nBcc: first@example.net,\r\n second@example.net\r\nSubject: Safe\r\n\r\nBcc: visible body text\r\n",
      "utf8",
    );
    const smtpWire = buildSmtpWireRfc2822(raw);
    expect(smtpWire.toString("utf8")).toBe(
      "From: me@example.com\r\nSubject: Safe\r\n\r\nBcc: visible body text\r\n",
    );
    smtpWire.fill(0);
    raw.fill(0);
  });

  it("adds a safe reply chain and appends the direct parent once", () => {
    const built = buildOutboundRfc2822({
      from: "me@example.com",
      to: ["friend@example.net"],
      cc: [],
      bcc: [],
      subject: "Re: Hello",
      text: "Reply",
      messageId: "<brain.reply@example.com>",
      createdAt,
      reply: {
        inReplyTo: "<parent@example.net>",
        references: ["<root@example.net>", "<root@example.net>"],
      },
    });

    const source = built.rawRfc2822.toString("utf8");
    expect(source).toContain("In-Reply-To: <parent@example.net>\r\n");
    expect(source).toContain(
      "References: <root@example.net>\r\n <parent@example.net>\r\n",
    );
  });

  it.each([
    {
      name: "header injection",
      patch: { subject: "Hello\r\nBcc: attacker@example.net" },
    },
    {
      name: "duplicate recipients",
      patch: { cc: ["FRIEND@example.net"] },
    },
    {
      name: "unsafe parent message id",
      patch: {
        reply: {
          inReplyTo: "<safe@example.net>\r\nBcc: attacker@example.net",
          references: [],
        },
      },
    },
  ])("rejects $name", ({ patch }) => {
    expect(() =>
      buildOutboundRfc2822({
        from: "me@example.com",
        to: ["friend@example.net"],
        cc: [],
        bcc: [],
        subject: "Hello",
        text: "Body",
        messageId: "<brain.1@example.com>",
        createdAt,
        reply: null,
        ...patch,
      }),
    ).toThrow();
  });

  it("fails before producing a raw payload above the one MiB send limit", () => {
    expect(() =>
      buildOutboundRfc2822({
        from: "me@example.com",
        to: ["friend@example.net"],
        cc: [],
        bcc: [],
        subject: "Large",
        text: "x".repeat(900 * 1024),
        messageId: "<brain.1@example.com>",
        createdAt,
        reply: null,
      }),
    ).toThrow(/configured byte limit/i);
  });
});
