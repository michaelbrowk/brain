import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAIL_CHANGE_FEED_CAPACITY,
  MailChangeFeed,
  MailChangeFeedBusyError,
  MailChangeFeedClosedError,
  type MailServiceChange,
} from "./change-feed-ring";

const ACCOUNT = `account-a${"1".repeat(32)}`;
const OTHER = `account-a${"2".repeat(32)}`;

function sync(accountId = ACCOUNT): MailServiceChange {
  return { accountId, mailboxIds: ["inbox"], kind: "sync" };
}

function read(
  feed: MailChangeFeed,
  cursor: number | null,
  waitMs = 25_000,
  options: { readonly paused?: () => boolean; readonly signal?: AbortSignal } = {},
) {
  return feed.read({
    cursor,
    waitMs,
    paused: options.paused ?? (() => false),
    signal: options.signal ?? new AbortController().signal,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the service's change feed", () => {
  it("answers a first read at once with the cursor to wait from", async () => {
    const feed = new MailChangeFeed({ initialCursor: 40 });
    feed.append(sync());

    await expect(read(feed, null)).resolves.toEqual({
      apiVersion: 1,
      cursor: 41,
      changes: [],
    });
  });

  it("starts its cursor somewhere a previous process could not have reached", () => {
    const first = new MailChangeFeed();
    const second = new MailChangeFeed();

    expect(Number.isSafeInteger(first.latestCursor())).toBe(true);
    expect(first.latestCursor()).not.toBe(second.latestCursor());
  });

  it("hands back every change after the cursor, in order", async () => {
    const feed = new MailChangeFeed({ initialCursor: 0 });
    feed.append(sync());
    feed.append({ accountId: OTHER, mailboxIds: ["inbox", "all"], kind: "mutation" });
    feed.append({
      accountId: ACCOUNT,
      mailboxIds: [],
      kind: "content_ready",
      messageId: "message-1",
    });

    await expect(read(feed, 1)).resolves.toEqual({
      apiVersion: 1,
      cursor: 3,
      changes: [
        { accountId: OTHER, mailboxIds: ["inbox", "all"], kind: "mutation" },
        {
          accountId: ACCOUNT,
          mailboxIds: [],
          kind: "content_ready",
          messageId: "message-1",
        },
      ],
    });
  });

  it("tells a reader the ring has passed to start again", async () => {
    const feed = new MailChangeFeed({ initialCursor: 0 });
    for (let index = 0; index < MAIL_CHANGE_FEED_CAPACITY + 1; index += 1) {
      feed.append(sync());
    }

    // The change after cursor 0 has left the ring, so what follows it is not
    // the whole story.
    await expect(read(feed, 0)).resolves.toEqual({
      apiVersion: 1,
      cursor: MAIL_CHANGE_FEED_CAPACITY + 1,
      changes: [],
      reset: true,
    });
    // One step later the oldest change still held is the next one.
    const kept = await read(feed, 1);
    expect(kept?.reset).toBeUndefined();
    expect(kept?.changes).toHaveLength(MAIL_CHANGE_FEED_CAPACITY);
  });

  it("resets a cursor from another process rather than guessing", async () => {
    const feed = new MailChangeFeed({ initialCursor: 500 });
    feed.append(sync());

    await expect(read(feed, 9_000)).resolves.toMatchObject({ reset: true, cursor: 501 });
    await expect(read(feed, 12)).resolves.toMatchObject({ reset: true, cursor: 501 });
  });

  it("holds a caught-up reader and answers on the next change", async () => {
    vi.useFakeTimers();
    const feed = new MailChangeFeed({ initialCursor: 7 });
    const pending = read(feed, 7);
    await vi.advanceTimersByTimeAsync(3_000);
    feed.append(sync());

    await expect(pending).resolves.toEqual({
      apiVersion: 1,
      cursor: 8,
      changes: [sync()],
    });
  });

  it("answers empty with the same cursor when the wait runs out", async () => {
    vi.useFakeTimers();
    const feed = new MailChangeFeed({ initialCursor: 7 });
    const pending = read(feed, 7, 25_000);
    let answered = false;
    void pending.then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ apiVersion: 1, cursor: 7, changes: [] });
  });

  it("refuses a second reader while one is waiting", async () => {
    vi.useFakeTimers();
    const feed = new MailChangeFeed({ initialCursor: 7 });
    const first = read(feed, 7);

    await expect(read(feed, 7)).rejects.toBeInstanceOf(MailChangeFeedBusyError);
    feed.append(sync());
    await expect(first).resolves.toMatchObject({ cursor: 8 });
    // The slot is free again once the first reader has its answer.
    const third = read(feed, 8);
    feed.append(sync());
    await expect(third).resolves.toMatchObject({ cursor: 9 });
  });

  it("frees the slot when the reader leaves", async () => {
    vi.useFakeTimers();
    const feed = new MailChangeFeed({ initialCursor: 7 });
    const controller = new AbortController();
    const first = read(feed, 7, 25_000, { signal: controller.signal });
    controller.abort();

    await expect(first).resolves.toBeNull();
    const second = read(feed, 7);
    feed.append(sync());
    await expect(second).resolves.toMatchObject({ cursor: 8 });
  });

  it("answers nothing while paused and keeps the reader's cursor", async () => {
    vi.useFakeTimers();
    const feed = new MailChangeFeed({ initialCursor: 7 });
    let paused = true;
    feed.append(sync());
    const pending = read(feed, 7, 25_000, { paused: () => paused });
    feed.append(sync());
    await vi.advanceTimersByTimeAsync(25_000);

    await expect(pending).resolves.toEqual({ apiVersion: 1, cursor: 7, changes: [] });
    // Nothing was lost: the next read after the resume gets both changes.
    paused = false;
    await expect(read(feed, 7)).resolves.toMatchObject({
      cursor: 9,
      changes: [sync(), sync()],
    });
  });

  it("answers the held read quietly on close and refuses every read after it", async () => {
    vi.useFakeTimers();
    const feed = new MailChangeFeed({ initialCursor: 7 });
    const held = read(feed, 7);

    feed.close();

    await expect(held).resolves.toEqual({ apiVersion: 1, cursor: 7, changes: [] });
    expect(feed.isClosed()).toBe(true);
    await expect(read(feed, 7)).rejects.toBeInstanceOf(MailChangeFeedClosedError);
    await expect(read(feed, null)).rejects.toBeInstanceOf(MailChangeFeedClosedError);
    // A record appended while the process winds down is simply not served.
    expect(() => feed.append(sync())).not.toThrow();
  });

  it("answers at once when asked not to wait", async () => {
    const feed = new MailChangeFeed({ initialCursor: 7 });

    await expect(read(feed, 7, 0)).resolves.toEqual({ apiVersion: 1, cursor: 7, changes: [] });
  });

  it("refuses a change it could not describe", () => {
    const feed = new MailChangeFeed({ initialCursor: 0 });

    expect(() =>
      feed.append({ accountId: "someone", mailboxIds: ["inbox"], kind: "sync" }),
    ).toThrow();
    expect(() =>
      feed.append({
        accountId: ACCOUNT,
        mailboxIds: ["drafts" as "inbox"],
        kind: "sync",
      }),
    ).toThrow();
    expect(() =>
      feed.append({ accountId: ACCOUNT, mailboxIds: [], kind: "content_ready" }),
    ).toThrow();
    expect(feed.latestCursor()).toBe(0);
  });
});
