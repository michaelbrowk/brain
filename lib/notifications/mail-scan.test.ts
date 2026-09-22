import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_SCAN_PAGE } from "./mail-producer";
import { runMailScan } from "./mail-scan";
import type { BrainNotification } from "./model";
import { listNotifications, markNotificationsRead } from "./store";
import { readMailWatermarks } from "./watermarks";

/** The real port's two dependencies, so the mailbox literal inside
 *  `defaultPort` can be asserted rather than assumed. Every test that brings
 *  all five port members reaches neither of these modules. */
const service = vi.hoisted(() => ({
  accounts: [] as { accountId: string }[],
  mailboxCalls: [] as { accountId: string; mailboxId: string; limit?: number }[],
}));

vi.mock("@/lib/mail/brain-mail-client", () => ({
  createBrainMailClient: () => ({
    listAccounts: async () => ({ apiVersion: 2, accounts: service.accounts }),
    listMailboxThreads: async (
      accountId: string,
      mailboxId: string,
      options?: { limit?: number },
    ) => {
      service.mailboxCalls.push({ accountId, mailboxId, limit: options?.limit });
      return { apiVersion: 1, mailboxId, items: [], nextCursor: null };
    },
  }),
}));

vi.mock("@/lib/push/send", () => ({
  sendPush: async () => ({ sent: 0, removed: 0, skipped: "no-devices" as const }),
}));

const ACCOUNT = "account-adeadbeefdeadbeefdeadbeefdeadbeef";
const SECOND = "account-bdeadbeefdeadbeefdeadbeefdeadbeef";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "brain-mail-scan-"));
});

/** The poll warns rather than throws, and a test that expects a warning should
 *  not print one. */
function quiet() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

function thread(extra: Record<string, unknown> = {}) {
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

interface Push {
  title: string;
  body?: string;
  href: string;
  tag?: string;
}

/** THE CENTRE ITSELF, NOT A DOUBLE. The row is counted into or opened afresh
 *  depending on what the file already holds, so a test that faked the write
 *  would be testing its own fake. `dir` is the port's and the store's both. */
function harness(overrides: Record<string, unknown> = {}) {
  const pushed: Push[] = [];
  const mailboxCalls: string[] = [];
  const port = {
    dir,
    accounts: async () => [{ accountId: ACCOUNT }],
    inbox: async (accountId: string) => {
      mailboxCalls.push(accountId);
      return [thread()];
    },
    push: async (p: Push) => {
      pushed.push(p);
    },
    // Supplied rather than defaulted, so no test in this file reads the real
    // settings directory to answer an arithmetic question about letters.
    modules: async () => ({ mail: true, tasks: true }),
    ...overrides,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { port: port as any, pushed, mailboxCalls };
}

const rows = (): Promise<BrainNotification[]> => listNotifications(dir);
const mailRows = async (): Promise<BrainNotification[]> =>
  (await rows()).filter((row) => row.kind === "mail-new");

describe("the mail scan", () => {
  it("says nothing on the first pass and counts one letter on the second", async () => {
    const h = harness();
    expect(await runMailScan(h.port)).toEqual({ produced: 0 });
    expect(await rows()).toEqual([]);

    const later = harness({
      inbox: async () => [thread({ lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") })],
    });
    expect(await runMailScan(later.port)).toEqual({ produced: 1 });
    expect(await mailRows()).toEqual([
      {
        id: "mail-new:2026-09-14T12:00:00.000Z",
        kind: "mail-new",
        at: "2026-09-14T12:00:00.000Z",
        title: "1 new message",
        href: "/mail",
      },
    ]);
    // The push is unchanged: one per letter, with the sender and the subject
    // on it, tagged with the pair so two letters in one poll are two
    // notifications rather than one replacing the other.
    expect(later.pushed).toEqual([
      {
        title: "Ana Silva",
        body: "Lunch on Friday",
        href: "/mail",
        tag: `mail-new:${ACCOUNT}:7468726561642d6f6e65`,
      },
    ]);
  });

  it("writes one row for three letters across two accounts, dated by the newest", async () => {
    const accounts = [{ accountId: ACCOUNT }, { accountId: SECOND }];
    const first = harness({
      accounts: async () => accounts,
      inbox: async (id: string) => [thread({ accountId: id })],
    });
    await runMailScan(first.port);

    const h = harness({
      accounts: async () => accounts,
      inbox: async (id: string) =>
        id === ACCOUNT
          ? [
              thread({ threadId: "a1", lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") }),
              thread({ threadId: "a2", lastMessageAt: Date.parse("2026-09-14T12:05:00.000Z") }),
            ]
          : [
              thread({
                accountId: id,
                threadId: "b1",
                lastMessageAt: Date.parse("2026-09-14T12:03:00.000Z"),
              }),
            ],
    });
    expect(await runMailScan(h.port)).toEqual({ produced: 3 });
    const mail = await mailRows();
    expect(mail).toHaveLength(1);
    expect(mail[0].title).toBe("3 new messages");
    expect(mail[0].at).toBe("2026-09-14T12:05:00.000Z");
    // No sender, no subject, no account: the row says how many letters and
    // nothing about any one of them.
    expect(mail[0].body).toBeUndefined();
    expect(mail[0].href).toBe("/mail");
    expect(h.pushed).toHaveLength(3);
  });

  it("counts into the row while it is unread, and moves it to the head", async () => {
    await runMailScan(harness().port);
    await runMailScan(
      harness({
        inbox: async () => [
          thread({ threadId: "a1", lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") }),
          thread({ threadId: "a2", lastMessageAt: Date.parse("2026-09-14T12:01:00.000Z") }),
          thread({ threadId: "a3", lastMessageAt: Date.parse("2026-09-14T12:02:00.000Z") }),
        ],
      }).port,
    );
    const opened = (await mailRows())[0];
    expect(opened.title).toBe("3 new messages");

    expect(
      await runMailScan(
        harness({
          inbox: async () => [
            thread({ threadId: "a4", lastMessageAt: Date.parse("2026-09-14T12:30:00.000Z") }),
            thread({ threadId: "a5", lastMessageAt: Date.parse("2026-09-14T12:31:00.000Z") }),
          ],
        }).port,
      ),
    ).toEqual({ produced: 2 });

    const mail = await mailRows();
    expect(mail).toHaveLength(1);
    expect(mail[0].id).toBe(opened.id);
    expect(mail[0].title).toBe("5 new messages");
    expect(mail[0].at).toBe("2026-09-14T12:31:00.000Z");
  });

  it("opens a new row once the old one has been read", async () => {
    await runMailScan(harness().port);
    await runMailScan(
      harness({
        inbox: async () => [thread({ lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") })],
      }).port,
    );
    const read = (await mailRows())[0];
    expect(await markNotificationsRead([read.id], "2026-09-14T12:10:00.000Z", dir)).toBe(1);

    await runMailScan(
      harness({
        inbox: async () => [
          thread({ threadId: "a2", lastMessageAt: Date.parse("2026-09-14T12:20:00.000Z") }),
          thread({ threadId: "a3", lastMessageAt: Date.parse("2026-09-14T12:21:00.000Z") }),
        ],
      }).port,
    );

    const mail = await mailRows();
    expect(mail).toHaveLength(2);
    // Newest first. The read row keeps its count and its read mark: a row the
    // reader has dealt with is never counted into again.
    expect(mail[0].id).not.toBe(read.id);
    expect(mail[0].title).toBe("2 new messages");
    expect(mail[0].readAt).toBeUndefined();
    expect(mail[1]).toEqual({ ...read, readAt: "2026-09-14T12:10:00.000Z" });
  });

  it("polls every connected account", async () => {
    const h = harness();
    await runMailScan(h.port);
    expect(h.mailboxCalls).toEqual([ACCOUNT]);
  });

  it("says nothing again about a thread it has already counted", async () => {
    await runMailScan(harness().port);
    const page = [thread({ lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") })];
    expect(await runMailScan(harness({ inbox: async () => page }).port)).toEqual({ produced: 1 });
    // The same page again is a re-sync, not a new letter.
    const again = harness({ inbox: async () => page });
    expect(await runMailScan(again.port)).toEqual({ produced: 0 });
    expect(again.pushed).toEqual([]);
    expect((await mailRows())[0].title).toBe("1 new message");
  });

  it("pushes every letter even when the centre would not keep the row", async () => {
    // The phone's signal is the push, and the centre is the tally. A file the
    // store cannot write is a tally lost, not a letter lost.
    const warn = quiet();
    await runMailScan(harness().port);
    const h = harness({
      inbox: async () => [
        thread({ threadId: "a1", lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") }),
        thread({ threadId: "a2", lastMessageAt: Date.parse("2026-09-14T12:01:00.000Z") }),
      ],
      openMailRow: async () => null,
      notify: async () => "refused" as const,
    });
    expect(await runMailScan(h.port)).toEqual({ produced: 0 });
    expect(h.pushed).toHaveLength(2);
    // Once, not once per letter.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("2");
  });

  it("marks the account whatever the centre answered, so a refused row cannot ring forever", async () => {
    quiet();
    await runMailScan(harness().port);
    const newer = Date.parse("2026-09-14T12:00:00.000Z");
    await runMailScan(
      harness({
        inbox: async () => [thread({ lastMessageAt: newer })],
        openMailRow: async () => null,
        notify: async () => "refused" as const,
      }).port,
    );
    expect((await readMailWatermarks(dir))[ACCOUNT]).toBe(newer);
  });

  it("keeps scanning the other accounts when one cannot be reached", async () => {
    quiet();
    const accounts = [{ accountId: ACCOUNT }, { accountId: SECOND }];
    await runMailScan(
      harness({ accounts: async () => accounts, inbox: async (id: string) => [thread({ accountId: id })] })
        .port,
    );
    const h = harness({
      accounts: async () => accounts,
      inbox: async (accountId: string) => {
        if (accountId === ACCOUNT) throw new Error("mail_service_unavailable");
        return [
          thread({
            accountId,
            threadId: "thread-two",
            lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z"),
          }),
        ];
      },
    });
    expect(await runMailScan(h.port)).toEqual({ produced: 1 });
    expect((await mailRows())[0].title).toBe("1 new message");
  });

  it("does nothing at all when no account is connected", async () => {
    const h = harness({ accounts: async () => [] });
    expect(await runMailScan(h.port)).toEqual({ produced: 0 });
    expect(h.mailboxCalls).toEqual([]);
  });

  it("produces nothing and says so once when the mail service is down", async () => {
    vi.resetModules();
    const fresh = await import("./mail-scan");
    const warn = quiet();
    const h = harness({
      accounts: async () => {
        throw new Error("mail_service_unavailable");
      },
    });
    expect(await fresh.runMailScan(h.port)).toEqual({ produced: 0 });
    expect(await fresh.runMailScan(h.port)).toEqual({ produced: 0 });
    expect(await fresh.runMailScan(h.port)).toEqual({ produced: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h.mailboxCalls).toEqual([]);
  });

  it("lets a push failure pass without losing the row or the mark", async () => {
    quiet();
    await runMailScan(harness().port);
    const newer = Date.parse("2026-09-14T12:00:00.000Z");
    const h = harness({
      inbox: async () => [thread({ lastMessageAt: newer })],
      push: async () => {
        throw new Error("push service is unreachable");
      },
    });
    expect(await runMailScan(h.port)).toEqual({ produced: 1 });
    expect((await mailRows())[0].title).toBe("1 new message");
    expect((await readMailWatermarks(dir))[ACCOUNT]).toBe(newer);
  });

  it("writes one row and one push per letter for a whole page", async () => {
    // The centre took one row per thread until 0.12.2, so a busy morning was
    // twenty five rows and the bell was a second inbox.
    const page = (minute: number) =>
      Array.from({ length: MAIL_SCAN_PAGE }, (_unused, index) =>
        thread({
          threadId: `t${index}`,
          lastMessageAt: Date.parse("2026-09-14T11:00:00.000Z") + minute * 60_000 + index,
        }),
      );
    await runMailScan(harness({ inbox: async () => page(0) }).port);
    const h = harness({ inbox: async () => page(10) });
    expect(await runMailScan(h.port)).toEqual({ produced: MAIL_SCAN_PAGE });
    expect(await mailRows()).toHaveLength(1);
    expect((await mailRows())[0].title).toBe("25 new messages");
    expect(h.pushed).toHaveLength(MAIL_SCAN_PAGE);
  });

  it("never names an account address in a log line", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      path.join(process.cwd(), "lib/notifications/mail-scan.ts"),
      "utf8",
    );
    expect(source).not.toContain("emailAddress");
    expect(source).not.toContain("snippet");
  });
});

describe("the mailbox the real port asks for", () => {
  beforeEach(() => {
    service.accounts = [{ accountId: ACCOUNT }];
    service.mailboxCalls = [];
  });

  it("asks the mail service for the Inbox, one page, and nothing else", async () => {
    // The mailbox literal lives in `defaultPort`, which every other test in
    // this file replaces, so this is the only place the choice is visible.
    // Under "all" the poll would list Sent and count the owner's own letters,
    // which is the failure the page below is guarding.
    await runMailScan({
      dir,
      push: async () => undefined,
      modules: async () => ({ mail: true, tasks: true }),
    });
    expect(service.mailboxCalls).toEqual([
      { accountId: ACCOUNT, mailboxId: "inbox", limit: MAIL_SCAN_PAGE },
    ]);
  });
});

/** MAIL OFF: NOTHING IS POLLED AND NOTHING IS PRODUCED. Rows already in the
 *  centre are somebody's morning and stay exactly where they are, which is
 *  why nothing here removes one. */
describe("the mail scan with the module off", () => {
  it("produces nothing and asks the service nothing while Mail is off", async () => {
    const accounts = vi.fn(async () => [{ accountId: ACCOUNT }]);
    const h = harness({
      accounts,
      modules: async () => ({ mail: false, tasks: true }),
    });
    expect(await runMailScan(h.port)).toEqual({ produced: 0 });
    expect(accounts).not.toHaveBeenCalled();
    expect(h.mailboxCalls).toEqual([]);
    expect(await listNotifications(dir)).toEqual([]);
  });

  it("leaves a row the centre already holds alone", async () => {
    // A letter counted before the switch stays readable after it.
    const first = harness({
      inbox: async () => [thread({ lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") })],
    });
    await runMailScan(first.port);
    await runMailScan(
      harness({
        inbox: async () => [thread({ lastMessageAt: Date.parse("2026-09-14T13:00:00.000Z") })],
      }).port,
    );
    const before = await listNotifications(dir);
    expect(before.filter((row) => row.kind === "mail-new")).toHaveLength(1);

    await runMailScan(
      harness({ modules: async () => ({ mail: false, tasks: true }) }).port,
    );
    expect(await listNotifications(dir)).toEqual(before);
  });
});
