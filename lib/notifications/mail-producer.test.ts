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
  it("says Someone rather than an empty title the schema would refuse", () => {
    expect(senderName([{ name: null, address: "" }])).toBe("Someone");
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

  /** THE OWNER'S OWN SENT MAIL (spec §7).
   *
   *  On IMAP every message is its own thread and the owner's reply lives in
   *  another mailbox, so an Inbox page never carries it. On Gmail the whole
   *  conversation is one thread: `lastMessageAt` counts the SENT-labelled
   *  messages too, the thread keeps INBOX because one message in it has that
   *  label, and `participants` filters the owner out. So the owner answering
   *  from their phone used to bump the thread and the bell said "Ana Silva"
   *  about words Ana did not write.
   *
   *  `unread` is what tells them apart: a thread whose newest message is the
   *  owner's own has nothing unread left in it.
   */
  it("produces nothing when the owner's own reply is the newest message on Gmail", () => {
    const result = newMailNotifications(
      [
        item({
          subject: "Re: Lunch on Friday",
          lastMessageAt: Date.parse("2026-09-14T11:30:00.000Z"),
          messageCount: 2,
          unread: false,
        }),
      ],
      Date.parse("2026-09-14T11:00:00.000Z"),
      AT,
    );
    expect(result.notifications).toEqual([]);
    // The mark still moves, so the owner's own reply is not offered again on
    // every poll for as long as the thread sits in the inbox.
    expect(result.watermark).toBe(Date.parse("2026-09-14T11:30:00.000Z"));
  });

  it("produces a row for the IMAP shape, where the letter is unread", () => {
    const result = newMailNotifications(
      [item({ unread: true })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications).toHaveLength(1);
  });

  it("produces nothing when a re-sync rewrites the timestamp of a thread already read", () => {
    // A label applied to an old Gmail thread, an IMAP COPY into INBOX, a
    // migration: the timestamp moves and the thread looks new. It is read, so
    // it says nothing.
    const result = newMailNotifications(
      [item({ unread: false, lastMessageAt: Date.parse("2026-09-14T11:59:00.000Z") })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications).toEqual([]);
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
          lastMessageAt: Date.parse("2026-09-14T11:45:00.000Z"),
        }),
      ],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.watermark).toBe(Date.parse("2026-09-14T11:45:00.000Z"));
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
  });

  it("never moves the mark past the scan's own instant", () => {
    // IMAP's date parser takes any safe integer, and falls back to the
    // SENDER-supplied header when INTERNALDATE is missing. One letter stamped
    // in 2027 used to move the mark to 2027, and every real letter after it
    // read as older than the mark: that account's bell went quiet for a year,
    // on disk, past a restart.
    const result = newMailNotifications(
      [item({ lastMessageAt: Date.parse("2027-01-01T00:00:00.000Z") })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.watermark).toBe(Date.parse(AT));
  });

  it("still announces the letter that lands after a future-stamped one", () => {
    const first = newMailNotifications(
      [item({ threadId: "t1", lastMessageAt: Date.parse("2027-01-01T00:00:00.000Z") })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    const second = newMailNotifications(
      [
        item({ threadId: "t1", lastMessageAt: Date.parse("2027-01-01T00:00:00.000Z") }),
        item({ threadId: "t2", lastMessageAt: Date.parse("2026-09-14T12:30:00.000Z") }),
      ],
      first.watermark,
      "2026-09-14T12:31:00.000Z",
    );
    // Both are offered. The real letter is new, and the future-stamped one is
    // an id the centre already holds, which is where it stops.
    expect(second.notifications).toHaveLength(2);
  });

  it("cuts a display name the schema would refuse rather than losing the letter", () => {
    // The centre caps `title` at 200 and refuses the whole row above it, while
    // the mark moves on regardless. An over-long name used to cost the letter
    // itself and leave one log line as the only trace of it.
    const result = newMailNotifications(
      [item({ participants: [{ name: "A".repeat(400), address: "ana@example.com" }] })],
      Date.parse("2026-09-14T10:00:00.000Z"),
      AT,
    );
    expect(result.notifications[0].title).toHaveLength(200);
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
