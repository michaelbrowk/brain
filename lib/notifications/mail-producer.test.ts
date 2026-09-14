import { describe, expect, it } from "vitest";
import type { MailThreadListItem } from "@/lib/mail/message-types";
import { newMailNotifications, senderName } from "./mail-producer";

const ACCOUNT = "account-adeadbeefdeadbeefdeadbeefdeadbeef";
const AT = "2026-09-14T12:00:00.000Z";

function item(extra: Partial<MailThreadListItem>): MailThreadListItem {
  return {
    accountId: ACCOUNT,
    threadId: "thread-one",
    subject: "Lunch on Friday",
    participants: [{ name: "Ana Silva", address: "ana@example.com" }],
    snippet: null,
    lastMessageAt: Date.parse("2026-09-14T11:00:00.000Z"),
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
    ...extra,
  };
}

describe("senderName", () => {
  it("takes the name when there is one", () => {
    expect(senderName([{ name: "Ana Silva", address: "ana@example.com" }])).toBe("Ana Silva");
  });
  it("falls back to the address", () => {
    expect(senderName([{ name: null, address: "ana@example.com" }])).toBe("ana@example.com");
    expect(senderName([{ name: "   ", address: "ana@example.com" }])).toBe("ana@example.com");
  });
  it("says Someone when a thread carries no participant", () => {
    expect(senderName([])).toBe("Someone");
  });
});

describe("newMailNotifications", () => {
  it("produces nothing on the first pass and only records the watermark", () => {
    const result = newMailNotifications([item({})], null, AT);
    expect(result.notifications).toEqual([]);
    expect(result.watermark).toBe(Date.parse("2026-09-14T11:00:00.000Z"));
  });

  it("produces a row for a people thread newer than the watermark", () => {
    const result = newMailNotifications([item({})], Date.parse("2026-09-14T10:00:00.000Z"), AT);
    expect(result.notifications).toEqual([
      {
        id: "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d6f6e65",
        kind: "mail-new",
        at: "2026-09-14T11:00:00.000Z",
        title: "Ana Silva",
        body: "Lunch on Friday",
        href: "/mail",
      },
    ]);
    expect(result.watermark).toBe(Date.parse("2026-09-14T11:00:00.000Z"));
  });

  it("produces nothing for a notification or a newsletter", () => {
    const result = newMailNotifications(
      [item({ category: "notification" }), item({ threadId: "t2", category: "newsletter" })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications).toEqual([]);
  });

  it("produces nothing for a list message even when the category says people", () => {
    const result = newMailNotifications(
      [item({ listMessage: true })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications).toEqual([]);
  });

  it("produces nothing for a thread the watermark already covers, which is a re-sync", () => {
    const result = newMailNotifications(
      [item({ lastMessageAt: Date.parse("2026-09-14T09:00:00.000Z") })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications).toEqual([]);
    expect(result.watermark).toBe(Date.parse("2026-09-14T10:00:00.000Z"));
  });

  it("produces a row for a reply that lands in a thread already known", () => {
    // A reply is the same threadId with a newer lastMessageAt, and it is worth
    // a notification: the spec says so in as many words (D6).
    const result = newMailNotifications(
      [item({ lastMessageAt: Date.parse("2026-09-14T11:30:00.000Z"), messageCount: 4 })],
      Date.parse("2026-09-14T11:00:00.000Z"),
      AT,
    );
    expect(result.notifications).toHaveLength(1);
  });

  it("produces nothing for a thread with no timestamp", () => {
    const result = newMailNotifications(
      [item({ lastMessageAt: null })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications).toEqual([]);
  });

  it("says (no subject) rather than leaving the body empty", () => {
    const result = newMailNotifications(
      [item({ subject: "   " })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications[0].body).toBe("(no subject)");
  });

  it("skips a thread whose id will not fit a notification id, and keeps the rest", () => {
    const result = newMailNotifications(
      [item({ threadId: "t".repeat(200) }), item({ threadId: "t2" })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications.map((n) => n.title)).toEqual(["Ana Silva"]);
  });

  it("raises the watermark to the newest thread it saw, whatever it produced", () => {
    const result = newMailNotifications(
      [
        item({ threadId: "t1", lastMessageAt: Date.parse("2026-09-14T11:00:00.000Z") }),
        item({
          threadId: "t2",
          category: "newsletter",
          lastMessageAt: Date.parse("2026-09-14T13:00:00.000Z"),
        }),
      ],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.watermark).toBe(Date.parse("2026-09-14T13:00:00.000Z"));
  });

  it("holds a row stamped in the future down to the scan's own instant", () => {
    // A Date header is whatever the sender's clock said. The centre sorts on
    // `at` and never re-reads it, so a letter stamped next year would sit at
    // the head of the bell until next year.
    const result = newMailNotifications(
      [item({ lastMessageAt: Date.parse("2027-01-01T00:00:00.000Z") })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications[0].at).toBe(AT);
    // The watermark still moves to what the page said, or the same
    // thread would be new again on every poll for a year.
    expect(result.watermark).toBe(Date.parse("2027-01-01T00:00:00.000Z"));
  });

  it("carries no mail address and no body into a row", () => {
    const result = newMailNotifications(
      [item({ snippet: "a body the poll must never repeat" })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    const row = JSON.stringify(result.notifications[0]);
    expect(row).not.toContain("ana@example.com");
    expect(row).not.toContain("a body the poll must never repeat");
  });

  it("reads no clock of its own, so the poll owns the instant", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await readFile(
      path.join(process.cwd(), "lib/notifications/mail-producer.ts"),
      "utf8",
    );
    expect(source).not.toContain("Date.now()");
  });
});
