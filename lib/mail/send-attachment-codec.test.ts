import { afterEach, describe, expect, it, vi } from "vitest";

import {
  exceedsMailJsonStructure,
  isSafeAttachmentFilename,
  MAIL_SEND_ATTACHMENT_LIMITS,
  MAIL_SEND_BODY_MAX_STRUCTURAL_TOKENS,
  mailSendAttachmentBytes,
  safeAttachmentFilename,
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

  describe("in the browser, where the compose sheet asks it", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("counts a filename's bytes without Node's Buffer", () => {
      // The sheet refuses a name before the send does, with the same rule,
      // and a browser has no `Buffer`. "é" is two bytes in UTF-8, so 127 of
      // them fit under 255 and 128 do not.
      vi.stubGlobal("Buffer", undefined);
      expect(isSafeAttachmentFilename("é".repeat(127))).toBe(true);
      expect(isSafeAttachmentFilename("é".repeat(128))).toBe(false);
    });

    it("turns the characters a header cannot carry into underscores", () => {
      // A file on a disk may be called anything a header parameter may not
      // hold. The sheet sends it under a name the rule admits rather than
      // refusing the writer's own file for its punctuation.
      expect(safeAttachmentFilename('Report "final" \\ v2.pdf')).toBe(
        "Report _final_ _ v2.pdf",
      );
      expect(safeAttachmentFilename("a/b\r\nc\u0000d\u007f.txt")).toBe("a_b__c_d_.txt");
      expect(safeAttachmentFilename("plain name.pdf")).toBe("plain name.pdf");
      expect(isSafeAttachmentFilename(safeAttachmentFilename('x"\\/\n.txt'))).toBe(true);
    });
  });

  it("pins the three caps a sender and a tool both read", () => {
    expect(MAIL_SEND_ATTACHMENT_LIMITS).toEqual({
      maxCount: 10,
      maxFilenameBytes: 255,
      maxTotalBytes: 10_485_760,
    });
  });
});

describe("the structure a send body may hold", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const exceeds = (text: string) =>
    exceedsMailJsonStructure(bytes(text), MAIL_SEND_BODY_MAX_STRUCTURAL_TOKENS);

  it("pins the bound, eight times the most a legal send holds", () => {
    expect(MAIL_SEND_BODY_MAX_STRUCTURAL_TOKENS).toBe(1_408);
  });

  it("admits the largest send the codecs admit, eight times over", () => {
    // A hundred recipients, ten files, and every member a send can carry,
    // with the characters that are structure outside a string inside every one.
    const awkward = 'a "quoted" [list], {object} \\ back\\\\slash "';
    const send = {
      accountId: "account-a00000000000000000000000000000000",
      idempotencyKey: awkward,
      mode: "reply",
      to: Array.from({ length: 34 }, (_, index) => `to-${index},[x]@example.net`),
      cc: Array.from({ length: 33 }, (_, index) => `cc-${index}{y}@example.net`),
      bcc: Array.from({ length: 33 }, (_, index) => `bcc-${index}"z"@example.net`),
      subject: awkward,
      text: `${awkward}\n`.repeat(2_000),
      replyToMessageId: "message-a",
      attachments: Array.from(
        { length: MAIL_SEND_ATTACHMENT_LIMITS.maxCount },
        (_, index) => attachment({ filename: `file-${index},[{}].pdf` }),
      ),
      origin: "app",
      agentLine: false,
    };
    const body = JSON.stringify(send);
    expect(exceeds(body)).toBe(false);
    const counted = (limit: number) => exceedsMailJsonStructure(bytes(body), limit);
    // 12 members, 3 lists of 100 addresses, 10 objects of 3 members: 167.
    expect(counted(166)).toBe(true);
    expect(counted(167)).toBe(false);
    expect(167 * 8).toBeLessThan(MAIL_SEND_BODY_MAX_STRUCTURAL_TOKENS);
  });

  it("refuses the bodies that cost memory to parse, long before their end", () => {
    expect(exceeds(`{"attachments":[${"{},".repeat(2_000_000)}{}]}`)).toBe(true);
    expect(exceeds(`[${"1,".repeat(6_000_000)}1]`)).toBe(true);
    expect(exceeds("[".repeat(1_409))).toBe(true);
    expect(exceeds(`${"[".repeat(704)}${"]".repeat(704)}`)).toBe(false);
  });

  it("counts nothing inside a string, whatever escapes it holds", () => {
    const structure = "[{}],".repeat(2_000);
    // A string that ends on an escaped backslash ends there.
    expect(exceeds(`["${structure}\\\\",1]`)).toBe(false);
    // An escaped quote does not end it, so what follows is still text.
    expect(exceeds(`["\\"${structure}"]`)).toBe(false);
    expect(exceeds(`["\\\\\\"${structure}"]`)).toBe(false);
    // The same structure after the string has ended is counted.
    expect(exceeds(`["\\\\"${structure}]`)).toBe(true);
    expect(exceeds(`["text",${structure}]`)).toBe(true);
    // A string that never ends hides the rest; the parser refuses that body.
    expect(exceeds(`["${structure}`)).toBe(false);
  });

  it("reads a body without Node's Buffer, as the codec's other rules do", () => {
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(exceeds('{"a":["b","c"]}')).toBe(false);
      expect(exceedsMailJsonStructure(bytes('{"a":["b","c"]}'), 4)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
