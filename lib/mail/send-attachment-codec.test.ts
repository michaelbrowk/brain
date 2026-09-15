import { describe, expect, it } from "vitest";

import {
  MAIL_SEND_ATTACHMENT_LIMITS,
  mailSendAttachmentBytes,
  validateMailSendAttachments,
} from "./send-attachment-codec";

/** "AQID" decodes to three bytes and carries no padding. */
const THREE_BYTES = "AQID";

function attachment(
  override: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    dataBase64: THREE_BYTES,
    ...override,
  };
}

/**
 * A base64 payload of exactly `bytes` decoded bytes, built from one repeated
 * character so the fixture stays low entropy and cheap to produce.
 */
function payloadOf(bytes: number): string {
  const groups = Math.ceil(bytes / 3);
  const padding = groups * 3 - bytes;
  return "A".repeat(groups * 4 - padding) + "=".repeat(padding);
}

const cases: readonly {
  readonly name: string;
  readonly make: () => unknown;
  readonly accepted: boolean;
}[] = [
  {
    name: "an empty list",
    make: () => [],
    accepted: true,
  },
  {
    name: "one well formed attachment",
    make: () => [attachment()],
    accepted: true,
  },
  {
    name: "one attachment past the count cap",
    make: () =>
      Array.from({ length: MAIL_SEND_ATTACHMENT_LIMITS.maxCount + 1 }, () =>
        attachment(),
      ),
    accepted: false,
  },
  {
    name: "an empty filename",
    make: () => [attachment({ filename: "" })],
    accepted: false,
  },
  {
    name: "a filename one byte past the cap",
    make: () => [
      attachment({
        filename: "a".repeat(MAIL_SEND_ATTACHMENT_LIMITS.maxFilenameBytes + 1),
      }),
    ],
    accepted: false,
  },
  {
    name: "a path separator in the filename",
    make: () => [attachment({ filename: "a/b.pdf" })],
    accepted: false,
  },
  {
    name: "a header injection in the filename",
    make: () => [attachment({ filename: "a\r\nBcc: x@y.z.pdf" })],
    accepted: false,
  },
  {
    // The note store's own blocklist refused this on the way in. Refusing it
    // twice in different words is how two lists drift apart.
    name: "a mime type the note store already screens",
    make: () => [attachment({ mimeType: "text/html" })],
    accepted: true,
  },
  {
    name: "a mime type that is not a type",
    make: () => [attachment({ mimeType: "not a type" })],
    accepted: false,
  },
  {
    name: "a line break inside the base64",
    make: () => [attachment({ dataBase64: "AQID\r\nAQID" })],
    accepted: false,
  },
  {
    name: "base64 that is not base64",
    make: () => [attachment({ dataBase64: "!!!" })],
    accepted: false,
  },
  {
    name: "two attachments one byte past the total cap",
    make: () => [
      attachment({ dataBase64: payloadOf(3) }),
      attachment({
        filename: "second.pdf",
        dataBase64: payloadOf(MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes - 2),
      }),
    ],
    accepted: false,
  },
  {
    name: "two attachments exactly at the total cap",
    make: () => [
      attachment({ dataBase64: payloadOf(3) }),
      attachment({
        filename: "second.pdf",
        dataBase64: payloadOf(MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes - 3),
      }),
    ],
    accepted: true,
  },
  {
    name: "a fourth key on an attachment",
    make: () => [attachment({ inline: true })],
    accepted: false,
  },
  {
    name: "a value that is not an array",
    make: () => "not an array",
    accepted: false,
  },
  {
    name: "an empty payload, which is a zero byte part",
    make: () => [attachment({ dataBase64: "" })],
    accepted: true,
  },
];

describe("outgoing attachment codec", () => {
  it.each(cases)("$name", ({ make, accepted }) => {
    const value = make();
    if (!accepted) {
      expect(() => validateMailSendAttachments(value)).toThrow(
        "mail_send_attachments_invalid",
      );
      return;
    }
    const result = validateMailSendAttachments(value);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toEqual(value);
  });

  it("reads a decoded size off the base64 length", () => {
    expect(mailSendAttachmentBytes("")).toBe(0);
    expect(mailSendAttachmentBytes(THREE_BYTES)).toBe(3);
    expect(mailSendAttachmentBytes(payloadOf(1))).toBe(1);
    expect(mailSendAttachmentBytes(payloadOf(2))).toBe(2);
    // A length that is not a whole number of groups cannot reach the
    // validator, and the exported reader still answers a whole number.
    expect(Number.isInteger(mailSendAttachmentBytes("AAAAA"))).toBe(true);
  });

  it("pins the three caps a sender and a tool both read", () => {
    expect(MAIL_SEND_ATTACHMENT_LIMITS).toEqual({
      maxCount: 10,
      maxFilenameBytes: 255,
      maxTotalBytes: 5_242_880,
    });
  });
});
