import { describe, expect, it } from "vitest";

import type { MailMessageDto } from "./message-types";
import {
  deriveReplyAllRecipients,
  deriveReplyRecipients,
  forwardedPlainText,
  forwardedSubject,
} from "./reply-forward";

const message: MailMessageDto = {
  accountId: "account-a00000000000000000000000000000000",
  messageId: "message-1",
  threadId: "thread-1",
  from: { name: "Sender", address: "sender@example.test" },
  replyTo: [{ name: "Team", address: "reply@example.test" }],
  to: [
    { name: "Me", address: "r.o.wan+brain@gmail.com" },
    { name: "Colleague", address: "other@example.test" },
  ],
  cc: [
    { name: "Duplicate", address: "REPLY@example.test" },
    { name: "Cc", address: "cc@example.test" },
  ],
  subject: "Project update",
  sentAt: Date.UTC(2026, 6, 20, 8, 30),
  unread: true,
  inInbox: true,
  snippet: "Preview",
  textBody: "Body",
  htmlBody: null,
  hasAttachments: true,
};

const account = {
  emailAddress: "rowan@gmail.com",
  providerKind: "gmail" as const,
};

describe("mail reply and forward foundations", () => {
  it("prefers Reply-To for Reply", () => {
    expect(deriveReplyRecipients(message, account)).toEqual({
      to: [{ name: "Team", address: "reply@example.test" }],
      cc: [],
    });
  });

  it("builds Reply All without self or provider-equivalent duplicates", () => {
    expect(deriveReplyAllRecipients(message, account)).toEqual({
      to: [
        { name: "Team", address: "reply@example.test" },
        { name: "Colleague", address: "other@example.test" },
      ],
      cc: [{ name: "Cc", address: "cc@example.test" }],
    });
  });

  it("keeps distinct plus-tagged recipients at an external domain", () => {
    expect(
      deriveReplyAllRecipients(
        {
          ...message,
          replyTo: [],
          to: [
            { name: "Me", address: "r.o.wan+brain@gmail.com" },
            { name: "US team", address: "team+us@example.test" },
            { name: "EU team", address: "team+eu@example.test" },
          ],
          cc: [
            { name: "Exact duplicate", address: "TEAM+US@example.test" },
          ],
        },
        account,
      ),
    ).toEqual({
      to: [
        { name: "Sender", address: "sender@example.test" },
        { name: "US team", address: "team+us@example.test" },
        { name: "EU team", address: "team+eu@example.test" },
      ],
      cc: [],
    });
  });

  it("does not guess that an unrelated custom address is a verified self alias", () => {
    expect(
      deriveReplyAllRecipients(
        {
          ...message,
          replyTo: [],
          to: [
            { name: "Primary alias", address: "r.o.w.a.n+tag@googlemail.com" },
            { name: "List", address: "work@example.test" },
          ],
          cc: [],
        },
        account,
      ),
    ).toEqual({
      to: [
        { name: "Sender", address: "sender@example.test" },
        { name: "List", address: "work@example.test" },
      ],
      cc: [],
    });
  });

  it("keeps the sender when external plus variants only resemble a correspondent", () => {
    expect(
      deriveReplyAllRecipients(
        {
          ...message,
          from: { name: "Sender", address: "sender@example.test" },
          replyTo: [],
          to: [{ name: "EU team", address: "team+eu@example.test" }],
          cc: [],
        },
        account,
        [{ name: "US team", address: "team+us@example.test" }],
      ),
    ).toEqual({
      to: [
        { name: "Sender", address: "sender@example.test" },
        { name: "EU team", address: "team+eu@example.test" },
      ],
      cc: [],
    });
    expect(
      deriveReplyRecipients(
        {
          ...message,
          from: { name: "Sender", address: "sender@example.test" },
          replyTo: [],
          to: [{ name: "EU team", address: "team+eu@example.test" }],
          cc: [],
        },
        account,
        [{ name: "US team", address: "team+us@example.test" }],
      ),
    ).toEqual({
      to: [{ name: "Sender", address: "sender@example.test" }],
      cc: [],
    });
  });

  it("falls back from a self-authored message to the original recipient", () => {
    expect(
      deriveReplyRecipients(
        {
          ...message,
          from: { name: "Me", address: "rowan+sent@gmail.com" },
          replyTo: [],
          to: [{ name: "Reader", address: "reader@example.test" }],
          cc: [],
        },
        account,
      ),
    ).toEqual({
      to: [{ name: "Reader", address: "reader@example.test" }],
      cc: [],
    });
  });

  it("builds bounded inert forward context and an idempotent subject", () => {
    const context = forwardedPlainText(message, `Hello\u0000\r\n${"🔥".repeat(100_000)}`);
    expect(context).toContain("---------- Forwarded message ----------");
    expect(context).toContain("From: Sender <sender@example.test>");
    expect(context).toContain("To: Me <r.o.wan+brain@gmail.com>");
    expect(context).not.toContain("\u0000");
    expect(new TextEncoder().encode(context).byteLength).toBeLessThanOrEqual(
      256 * 1024 + 2,
    );
    expect(forwardedSubject(message.subject)).toBe("Fwd: Project update");
    expect(forwardedSubject("FW: Existing")).toBe("FW: Existing");
  });
});
