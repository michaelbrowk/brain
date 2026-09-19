import { describe, expect, it } from "vitest";

import { MAIL_RESOURCE_LIMITS } from "../security";
import {
  buildOutboundRfc2822,
  buildSmtpWireRfc2822,
  type OutboundMessageSource,
} from "./outbound-message";

const createdAt = Date.parse("2026-07-15T09:30:00.000Z");

function base(patch: Partial<OutboundMessageSource> = {}): OutboundMessageSource {
  return {
    from: "me@example.com",
    to: ["friend@example.net"],
    cc: [],
    bcc: [],
    subject: "Plain",
    text: "one line",
    messageId: "<brain.1@example.com>",
    createdAt,
    reply: null,
    attachments: [],
    origin: "app",
    agentLine: false,
    ...patch,
  };
}

function decodeBody(raw: Buffer): string {
  return Buffer.from(
    raw.toString("utf8").split("\r\n\r\n", 2)[1].replaceAll("\r\n", ""),
    "base64",
  ).toString("utf8");
}

describe("outbound RFC 2822 builder", () => {
  it("builds a bounded UTF-8 compose message without leaking recipients into errors", () => {
    const built = buildOutboundRfc2822(
      base({
        cc: ["team@example.org"],
        bcc: ["private@example.test"],
        subject: "Привет",
        text: "Первая строка\nВторая строка",
      }),
    );

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
    const built = buildOutboundRfc2822(
      base({
        subject: "Re: Hello",
        text: "Reply",
        messageId: "<brain.reply@example.com>",
        reply: {
          inReplyTo: "<parent@example.net>",
          references: ["<root@example.net>", "<root@example.net>"],
        },
      }),
    );

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
    {
      name: "an origin that is neither the app nor an agent",
      patch: { origin: "cron" as OutboundMessageSource["origin"] },
    },
    {
      name: "an attachment filename carrying a quote",
      patch: {
        attachments: [
          {
            filename: 'a".pdf',
            mimeType: "application/pdf",
            bytes: Buffer.from("PDF-BYTES"),
          },
        ],
      },
    },
    {
      name: "an attachment mime type that is not a type",
      patch: {
        attachments: [
          {
            filename: "invoice.pdf",
            mimeType: "not a type",
            bytes: Buffer.from("PDF-BYTES"),
          },
        ],
      },
    },
  ])("rejects $name", ({ patch }) => {
    expect(() =>
      buildOutboundRfc2822(base(patch as Partial<OutboundMessageSource>)),
    ).toThrow();
  });

  it("builds a single part, byte identical to today, when there are no attachments", () => {
    // The regression that matters most. Every message Brain has ever sent went
    // down the single-part path, and a multipart wrapper around a plain note
    // would change every Sent copy and every threading fingerprint.
    const before = buildOutboundRfc2822(base());
    const source = before.rawRfc2822.toString("utf8");
    expect(source).toContain('Content-Type: text/plain; charset="UTF-8"\r\n');
    expect(source).not.toContain("multipart/mixed");
    expect(decodeBody(before.rawRfc2822)).toBe("one line");
  });

  it("wraps the text and two attachments in multipart/mixed with the text first", () => {
    const built = buildOutboundRfc2822(
      base({
        subject: "With files",
        text: "see attached",
        messageId: "<brain.2@example.com>",
        attachments: [
          {
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            bytes: Buffer.from("PDF-BYTES"),
          },
          {
            filename: "счёт 2026.pdf",
            mimeType: "application/pdf",
            bytes: Buffer.from("SECOND"),
          },
        ],
      }),
    );
    const source = built.rawRfc2822.toString("utf8");
    const boundary = /boundary="([^"]+)"/.exec(source)![1];
    expect(source).toContain(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = source.split(`--${boundary}`);
    expect(parts).toHaveLength(5); // preamble, three parts, the closing tail
    expect(parts[1]).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="invoice.pdf"');
    expect(parts[2]).toContain("Content-Transfer-Encoding: base64");
    expect(parts[3]).toContain(
      "Content-Disposition: attachment; filename=\"_2026.pdf\"; filename*=UTF-8''%D1%81%D1%87%D1%91%D1%82%202026.pdf",
    );
    expect(source.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it("refuses a message that crosses the outgoing ceiling and wipes the buffer", () => {
    expect(() =>
      buildOutboundRfc2822(
        base({
          subject: "Too big",
          text: "x",
          messageId: "<brain.3@example.com>",
          attachments: [
            {
              filename: "big.bin",
              mimeType: "application/octet-stream",
              bytes: Buffer.alloc(MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes),
            },
          ],
        }),
      ),
    ).toThrow("outbound message exceeds the configured byte limit");
  });

  it("writes the single-part message byte for byte", () => {
    // Every Sent copy and every replay check compares these bytes, so the
    // shape is pinned exactly rather than by what it happens to contain.
    expect(buildOutboundRfc2822(base()).rawRfc2822.toString("utf8")).toBe(
      "From: me@example.com\r\n" +
        "To: friend@example.net\r\n" +
        "Subject: =?UTF-8?B?UGxhaW4=?=\r\n" +
        "Date: Wed, 15 Jul 2026 09:30:00 +0000\r\n" +
        "Message-ID: <brain.1@example.com>\r\n" +
        "MIME-Version: 1.0\r\n" +
        'Content-Type: text/plain; charset="UTF-8"\r\n' +
        "Content-Transfer-Encoding: base64\r\n" +
        "\r\n" +
        "b25lIGxpbmU=\r\n",
    );
  });

  it("carries X-Brain-Agent only when the origin is mcp", () => {
    const agent = buildOutboundRfc2822(base({ origin: "mcp" }));
    expect(agent.rawRfc2822.toString("utf8")).toContain("X-Brain-Agent: mcp\r\n");
    const person = buildOutboundRfc2822(base());
    expect(person.rawRfc2822.toString("utf8")).not.toContain("X-Brain-Agent");
  });

  it("appends the recipient-visible line only with agentLine, and only for mcp", () => {
    const told = buildOutboundRfc2822(
      base({ text: "hello", origin: "mcp", agentLine: true }),
    );
    expect(decodeBody(told.rawRfc2822)).toBe(
      "hello\r\n\r\nSent by an agent through Brain.",
    );

    const quiet = buildOutboundRfc2822(
      base({ text: "hello", origin: "mcp", agentLine: false }),
    );
    expect(decodeBody(quiet.rawRfc2822)).toBe("hello");

    // A person's own message never gets the line, whatever the toggle says.
    const person = buildOutboundRfc2822(
      base({ text: "hello", origin: "app", agentLine: true }),
    );
    expect(decodeBody(person.rawRfc2822)).toBe("hello");
  });
});
