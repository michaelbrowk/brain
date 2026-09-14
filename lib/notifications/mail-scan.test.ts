import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MAIL_APPENDS_PER_SCAN, runMailScan } from "./mail-scan";
import type { BrainNotification } from "./model";
import { readMailWatermarks } from "./watermarks";

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

function harness(overrides: Record<string, unknown> = {}) {
  const notified: BrainNotification[] = [];
  const pushed: { title: string; body?: string; href: string; tag?: string }[] = [];
  const mailboxCalls: string[] = [];
  const port = {
    dir,
    accounts: async () => [{ accountId: ACCOUNT }],
    inbox: async (accountId: string) => {
      mailboxCalls.push(accountId);
      return [thread()];
    },
    notify: async (n: BrainNotification) => {
      notified.push(n);
      return true;
    },
    push: async (p: { title: string; body?: string; href: string; tag?: string }) => {
      pushed.push(p);
    },
    ...overrides,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { port: port as any, notified, pushed, mailboxCalls };
}

describe("the mail scan", () => {
  it("says nothing on the first pass and reports something on the second", async () => {
    const h = harness();
    expect(await runMailScan(h.port)).toEqual({ produced: 0 });
    expect(h.notified).toEqual([]);

    const later = harness({
      dir,
      inbox: async () => [thread({ lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") })],
    });
    expect(await runMailScan(later.port)).toEqual({ produced: 1 });
    expect(later.notified[0].title).toBe("Ana Silva");
    // The tag is the row's own id, so two letters that arrive in one poll are
    // two notifications rather than one replacing the other: every mail row
    // carries the same href "/mail".
    expect(later.pushed).toEqual([
      {
        title: "Ana Silva",
        body: "Lunch on Friday",
        href: "/mail",
        tag: later.notified[0].id,
      },
    ]);
  });

  it("reads the inbox mailbox, so the owner's own sent mail is never a row", async () => {
    const h = harness();
    await runMailScan(h.port);
    expect(h.mailboxCalls).toEqual([ACCOUNT]);
  });

  it("says nothing again about a thread it has already reported", async () => {
    await runMailScan(harness().port);
    const page = [thread({ lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") })];
    expect(await runMailScan(harness({ dir, inbox: async () => page }).port)).toEqual({
      produced: 1,
    });
    // The same page again is a re-sync, not a new letter.
    const again = harness({ dir, inbox: async () => page });
    expect(await runMailScan(again.port)).toEqual({ produced: 0 });
    expect(again.notified).toEqual([]);
  });

  it("does not push a row the centre already held", async () => {
    quiet();
    await runMailScan(harness().port);
    const h = harness({
      dir,
      inbox: async () => [thread({ lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") })],
      notify: async () => false,
    });
    await runMailScan(h.port);
    expect(h.pushed).toEqual([]);
  });

  it("marks the account whatever the centre answered, so a refused row cannot ring forever", async () => {
    quiet();
    await runMailScan(harness().port);
    const newer = Date.parse("2026-09-14T12:00:00.000Z");
    await runMailScan(
      harness({ dir, inbox: async () => [thread({ lastMessageAt: newer })], notify: async () => false })
        .port,
    );
    expect((await readMailWatermarks(dir))[ACCOUNT]).toBe(newer);
  });

  it("says once that the centre refused rows, not once per row", async () => {
    const warn = quiet();
    await runMailScan(harness().port);
    await runMailScan(
      harness({
        dir,
        inbox: async () => [
          thread({ threadId: "t1", lastMessageAt: Date.parse("2026-09-14T12:00:00.000Z") }),
          thread({ threadId: "t2", lastMessageAt: Date.parse("2026-09-14T12:01:00.000Z") }),
        ],
        notify: async () => false,
      }).port,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("2");
  });

  it("keeps scanning the other accounts when one cannot be reached", async () => {
    quiet();
    await runMailScan(
      harness({
        accounts: async () => [{ accountId: ACCOUNT }, { accountId: SECOND }],
        inbox: async (accountId: string) => [thread({ accountId })],
      }).port,
    );
    const h = harness({
      dir,
      accounts: async () => [{ accountId: ACCOUNT }, { accountId: SECOND }],
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
      dir,
      inbox: async () => [thread({ lastMessageAt: newer })],
      push: async () => {
        throw new Error("push service is unreachable");
      },
    });
    expect(await runMailScan(h.port)).toEqual({ produced: 1 });
    expect((await readMailWatermarks(dir))[ACCOUNT]).toBe(newer);
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

describe("a scan that found more than the journal can take", () => {
  const THIRD = "account-cdeadbeefdeadbeefdeadbeefdeadbeef";
  const accounts = [{ accountId: ACCOUNT }, { accountId: SECOND }, { accountId: THIRD }];

  function page(accountId: string, minute: number) {
    const items = [];
    for (let index = 0; index < 25; index += 1) {
      items.push(
        thread({
          accountId,
          threadId: `${accountId}-t${index}`,
          lastMessageAt: Date.parse("2026-09-14T11:00:00.000Z") + minute * 60_000 + index,
        }),
      );
    }
    return items;
  }

  it("caps one scan at fifty appends", () => {
    expect(MAX_MAIL_APPENDS_PER_SCAN).toBe(50);
  });

  it("takes what fits and carries the rest of an account to the next tick", async () => {
    quiet();
    // The first pass sets three watermarks and says nothing.
    await runMailScan(harness({ accounts: async () => accounts, inbox: async (id: string) => page(id, 0) }).port);

    const busy = harness({
      dir,
      accounts: async () => accounts,
      inbox: async (id: string) => page(id, 10),
    });
    expect(await runMailScan(busy.port)).toEqual({ produced: 50 });
    // Two accounts reported whole. The third was not half-reported and its
    // mark did not move, so nothing it holds was lost.
    const marks = await readMailWatermarks(dir);
    expect(marks[THIRD]).toBe(Date.parse("2026-09-14T11:00:00.000Z") + 24);

    const next = harness({
      dir,
      accounts: async () => accounts,
      inbox: async (id: string) => page(id, 10),
    });
    expect(await runMailScan(next.port)).toEqual({ produced: 25 });
    expect(next.notified.every((row) => row.id.includes(THIRD))).toBe(true);
  });
});
