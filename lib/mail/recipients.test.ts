import { describe, expect, it } from "vitest";

import {
  MAIL_MAX_RECIPIENTS,
  describeMailRecipientProblem,
  normalizeMailRecipient,
  parseMailRecipientFields,
} from "./recipients";

function parse(fields: {
  readonly to?: string;
  readonly cc?: string;
  readonly bcc?: string;
}) {
  return parseMailRecipientFields({
    to: fields.to ?? "",
    cc: fields.cc ?? "",
    bcc: fields.bcc ?? "",
  });
}

describe("mail recipient contract", () => {
  it.each([
    ["a single address", "friend@example.test", ["friend@example.test"]],
    [
      "comma separated addresses",
      "one@example.test,two@example.test",
      ["one@example.test", "two@example.test"],
    ],
    [
      "semicolon separated addresses",
      "one@example.test; two@example.test",
      ["one@example.test", "two@example.test"],
    ],
    ["a trailing separator", "friend@example.test, ", ["friend@example.test"]],
    ["repeated separators", "one@example.test,,;two@example.test", [
      "one@example.test",
      "two@example.test",
    ]],
    ["surrounding whitespace", "  friend@example.test  ", ["friend@example.test"]],
    ["mixed case", "Friend@Example.Test", ["friend@example.test"]],
    ["a display name", "Alice Smith <alice@example.test>", ["alice@example.test"]],
    [
      "a quoted display name holding a separator",
      '"Smith, Alice" <alice@example.test>, bob@example.test',
      ["alice@example.test", "bob@example.test"],
    ],
    [
      "an angle-bracketed address with no display name",
      "<friend@example.test>",
      ["friend@example.test"],
    ],
    ["a plus-addressed mailbox", "a+tag@example.test", ["a+tag@example.test"]],
    [
      "a duplicate the writer typed twice",
      "friend@example.test, Friend@Example.Test",
      ["friend@example.test"],
    ],
  ])("accepts %s", (_label, to, expected) => {
    expect(parse({ to })).toEqual({
      ok: true,
      recipients: { to: expected, cc: [], bcc: [] },
    });
  });

  it("addresses a message by blind copy alone", () => {
    expect(parse({ bcc: "friend@example.test" })).toEqual({
      ok: true,
      recipients: { to: [], cc: [], bcc: ["friend@example.test"] },
    });
  });

  it("keeps the first field a repeated recipient appears in", () => {
    expect(
      parse({
        to: "Alice <alice@example.test>",
        cc: "ALICE@example.test, bob@example.test",
        bcc: "bob@example.test, carol@example.test",
      }),
    ).toEqual({
      ok: true,
      recipients: {
        to: ["alice@example.test"],
        cc: ["bob@example.test"],
        bcc: ["carol@example.test"],
      },
    });
  });

  it("accepts the longest address the wire allows", () => {
    const local = "a".repeat(241);
    expect(parse({ to: `${local}@example.test` })).toMatchObject({ ok: true });
    expect(parse({ to: `${local}b@example.test` })).toEqual({
      ok: false,
      problem: {
        kind: "invalid_address",
        field: "to",
        token: `${local}b@example.test`,
      },
    });
  });

  it("accepts the largest recipient list the service allows", () => {
    const addresses = Array.from(
      { length: MAIL_MAX_RECIPIENTS },
      (_value, index) => `person${index}@example.test`,
    );
    expect(parse({ to: addresses.join(",") })).toMatchObject({ ok: true });
    expect(
      parse({ to: addresses.join(","), cc: "extra@example.test" }),
    ).toEqual({
      ok: false,
      problem: { kind: "too_many_recipients", count: MAIL_MAX_RECIPIENTS + 1 },
    });
  });

  it.each([
    ["an empty envelope", ""],
    ["separators alone", " , ; "],
  ])("refuses %s", (_label, to) => {
    expect(parse({ to })).toEqual({
      ok: false,
      problem: { kind: "no_recipients" },
    });
  });

  it.each([
    ["a token that is not an address", "not-an-address"],
    ["a missing domain", "friend@"],
    ["a missing local part", "@example.test"],
    ["a domain without a dot", "friend@localhost"],
    ["a trailing dot in the domain", "friend@example."],
    ["two addresses in one token", "one@example.test two@evil.test"],
    ["two at signs", "one@two@example.test"],
    ["an unterminated angle bracket", "Alice <alice@example.test"],
    ["a folded header injection", "friend@example.test\r\nBcc: eve@evil.test"],
    ["a bare newline", "friend@example.test\nBcc: eve@evil.test"],
    ["an embedded control character", "friend@example\u0007.test"],
  ])("refuses %s", (_label, to) => {
    expect(parse({ to })).toMatchObject({
      ok: false,
      problem: { kind: "invalid_address", field: "to" },
    });
  });

  it.each([
    ["a bare addr-spec", "friend@example.test", "friend@example.test"],
    ["one angle-bracketed mailbox", "<friend@example.test>", "friend@example.test"],
    [
      "a display name before one mailbox",
      "Alice Smith <alice@example.test>",
      "alice@example.test",
    ],
    [
      "a quoted display name before one mailbox",
      '"Smith, Alice" <alice@example.test>',
      "alice@example.test",
    ],
  ])("normalizes %s", (_label, token, expected) => {
    expect(normalizeMailRecipient(token)).toBe(expected);
  });

  /**
   * A token holding a second mailbox once normalized to the *last* one, so
   * `Alice <alice@example.test> <eve@evil.test>` addressed Eve while the writer
   * read Alice's name. No resolution of such a token is safe: refuse it.
   */
  it.each([
    [
      "a second mailbox after a display name",
      "Alice <alice@example.test> <eve@evil.test>",
    ],
    [
      "a bare address before an angle-bracketed one",
      "alice@example.test <eve@evil.test>",
    ],
    [
      "two adjacent angle-bracketed mailboxes",
      "<alice@example.test><eve@evil.test>",
    ],
    [
      "a second mailbox after a quoted display name",
      '"Alice" <alice@example.test> <eve@evil.test>',
    ],
    [
      "a bare address after an angle-bracketed one",
      "<alice@example.test> eve@evil.test",
    ],
    ["a stray opening bracket in the display name", "A<B <alice@example.test>"],
    ["a stray closing bracket in the display name", "Alice> <alice@example.test>"],
    ["a mailbox that is not the end of the token", "<alice@example.test> Alice"],
  ])("refuses %s", (_label, token) => {
    expect(normalizeMailRecipient(token)).toBeNull();
    expect(parse({ to: token })).toEqual({
      ok: false,
      problem: { kind: "invalid_address", field: "to", token },
    });
  });

  it("names the field a bad address came from", () => {
    expect(
      parse({ to: "friend@example.test", cc: "nonsense" }),
    ).toEqual({
      ok: false,
      problem: { kind: "invalid_address", field: "cc", token: "nonsense" },
    });
  });

  it("describes every problem in words a writer can act on", () => {
    expect(
      describeMailRecipientProblem({ kind: "no_recipients" }),
    ).toBe("Add at least one recipient.");
    expect(
      describeMailRecipientProblem({
        kind: "invalid_address",
        field: "cc",
        token: "nonsense",
      }),
    ).toBe("Cc “nonsense” is not an email address.");
    expect(
      describeMailRecipientProblem({ kind: "too_many_recipients", count: 101 }),
    ).toBe(`A message can reach ${MAIL_MAX_RECIPIENTS} recipients at most.`);
  });
});
