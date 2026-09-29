import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MailThreadCategory,
  MailThreadListItem,
  MailThreadMutationInput,
} from "../message-types";
import {
  isMailSenderGated,
  MailSenderError,
  MailSenderScreen,
  MailSenderScreenedMessageService,
  normalizeSenderAddress,
  senderDomainOf,
  SqliteMailSenderStore,
  type MailSenderGateInput,
  type MailSenderMailPort,
} from "./senders";
import type { MailMessageService } from "./message-service";

const ACCOUNT_A = "account-a11111111111111111111111111111111";
const ACCOUNT_B = "account-a22222222222222222222222222222222";
const ENABLED_AT = 1_000;
const LATER = 2_000;
const NO_DEADLINE = Object.freeze({
  deadlineAt: Number.MAX_SAFE_INTEGER,
  signal: new AbortController().signal,
});
const roots: string[] = [];
const stores: SqliteMailSenderStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sender address normalization", () => {
  it("keeps only the lowercased address", () => {
    expect(normalizeSenderAddress('"Lena Okafor" <Lena.Okafor@Example.COM>')).toBe(
      "lena.okafor@example.com",
    );
    expect(normalizeSenderAddress("Lena (the one from work) <lena@example.com>")).toBe(
      "lena@example.com",
    );
    expect(normalizeSenderAddress("lena@example.com (work)")).toBe("lena@example.com");
    expect(normalizeSenderAddress("  LENA@EXAMPLE.COM.  ")).toBe("lena@example.com");
  });

  it("writes an international domain in punycode", () => {
    expect(normalizeSenderAddress("Hans <hans@München.de>")).toBe(
      "hans@xn--mnchen-3ya.de",
    );
    expect(normalizeSenderAddress("ivan@пример.рф")).toBe("ivan@xn--e1afmkfd.xn--p1ai");
  });

  it("refuses what is not an address", () => {
    for (const value of [
      "",
      "no at sign",
      "@example.com",
      "lena@",
      "le na@example.com",
      "lena@exa mple.com",
      "lena@exa_mple..com",
      `${"x".repeat(65)}@example.com`,
      `lena@${"a".repeat(250)}.com`,
      "lena@example.com\u0000",
    ]) {
      expect(normalizeSenderAddress(value), value).toBeNull();
    }
  });

  it("names the domain of a normalized address", () => {
    expect(senderDomainOf("lena@example.com")).toBe("example.com");
    expect(senderDomainOf("hans@xn--mnchen-3ya.de")).toBe("xn--mnchen-3ya.de");
  });
});

describe("the new-sender gate", () => {
  const gated: MailSenderGateInput = Object.freeze({
    screenEnabled: true,
    backfillComplete: true,
    enabledAt: ENABLED_AT,
    category: "people",
    firstMessageAt: LATER,
    sender: "stranger@example.com",
    known: false,
    addressDecision: null,
    domainDecision: null,
  });

  it("gates a first letter from a stranger that arrived after the switch", () => {
    expect(isMailSenderGated(gated)).toBe(true);
  });

  it.each([
    ["the switch is off", { screenEnabled: false }],
    ["the backfill is still running", { backfillComplete: false }],
    ["the switch never had a moment", { enabledAt: null }],
    ["it is a notification", { category: "notification" as MailThreadCategory }],
    ["it is a newsletter", { category: "newsletter" as MailThreadCategory }],
    ["its first message has no date", { firstMessageAt: null }],
    ["its first message came at the switch", { firstMessageAt: ENABLED_AT }],
    ["its first message came before the switch", { firstMessageAt: ENABLED_AT - 1 }],
    ["it has no readable sender", { sender: null }],
    ["the sender is known", { known: true }],
    ["the address was accepted", { addressDecision: "accept" as const }],
    ["the address was blocked", { addressDecision: "block" as const }],
    ["the domain was accepted", { domainDecision: "accept" as const }],
    ["the domain was blocked", { domainDecision: "block" as const }],
  ])("lets it through when %s", (_label, change) => {
    expect(isMailSenderGated({ ...gated, ...change })).toBe(false);
  });
});

describe("the senders store", () => {
  it("creates a private WAL database that starts switched on", async () => {
    const { store, stateDirectory } = await createStore(() => ENABLED_AT);

    const databasePath = path.join(stateDirectory, "senders.sqlite3");
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect(store.readState()).toEqual({ enabled: true, enabledAt: ENABLED_AT });
    store.close();
    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
    } finally {
      database.close();
    }
  });

  it("keeps the moment it was switched on across a restart", async () => {
    const { store, stateDirectory } = await createStore(() => ENABLED_AT);
    store.close();

    const reopened = new SqliteMailSenderStore({ stateDirectory, now: () => LATER });
    stores.push(reopened);
    await reopened.initialize();

    expect(reopened.readState()).toEqual({ enabled: true, enabledAt: ENABLED_AT });
  });

  it("refuses a database written by a newer schema", async () => {
    const { store, stateDirectory } = await createStore(() => ENABLED_AT);
    store.close();
    const database = new DatabaseSync(path.join(stateDirectory, "senders.sqlite3"));
    database.exec("PRAGMA user_version = 2");
    database.close();

    const reopened = new SqliteMailSenderStore({ stateDirectory });
    await expect(reopened.initialize()).rejects.toMatchObject({
      code: "mail_senders_unavailable",
    });
  });
});

describe("the new-senders screen", () => {
  it("gates nothing until the backfill has read every account", async () => {
    const world = await createWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "fresh", from: "stranger@example.net", at: LATER });

    expect(await newSenders(world, ACCOUNT_A, ["fresh"])).toEqual([false]);
    expect((await world.screen.readState()).backfillComplete).toBe(false);

    await finishBackfill(world);

    expect((await world.screen.readState()).backfillComplete).toBe(true);
    expect(await newSenders(world, ACCOUNT_A, ["fresh"])).toEqual([true]);
  });

  it("learns every From and every Sent recipient across accounts", async () => {
    const world = await createWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "old-a", from: "friend@a.test", at: 500 });
    world.mail.addThread(ACCOUNT_A, {
      threadId: "sent-a",
      from: "me@a.test",
      to: ["Colleague <colleague@b.test>"],
      cc: ["boss@b.test"],
      at: 600,
      inbox: false,
      sent: true,
    });
    world.mail.addThread(ACCOUNT_B, { threadId: "old-b", from: "Partner@C.test", at: 700 });
    // Arrived after the switch: its sender is exactly who the screen is for.
    world.mail.addThread(ACCOUNT_B, { threadId: "early", from: "stranger@example.net", at: LATER });
    await finishBackfill(world);

    for (const [threadId, from] of [
      ["from-friend", "friend@a.test"],
      ["from-colleague", "colleague@b.test"],
      ["from-boss", "boss@b.test"],
      ["from-partner", "partner@c.test"],
      ["from-me", "me@a.test"],
      ["from-stranger", "stranger@example.net"],
    ] as const) {
      world.mail.addThread(ACCOUNT_A, { threadId, from, at: LATER + 1 });
    }
    world.mail.addThread(ACCOUNT_A, {
      threadId: "stranger-notification",
      from: "stranger@example.net",
      at: LATER + 1,
      category: "notification",
    });

    expect(
      await newSenders(world, ACCOUNT_A, [
        "from-friend",
        "from-colleague",
        "from-boss",
        "from-partner",
        "from-me",
        "from-stranger",
        "stranger-notification",
      ]),
    ).toEqual([false, false, false, false, false, true, false]);
  });

  it("holds a decision once for every account and every address at a domain", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "lena-a", from: "lena@example.net", at: LATER });
    world.mail.addThread(ACCOUNT_B, { threadId: "lena-b", from: "Lena <LENA@example.net>", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "colleague", from: "other@example.net", at: LATER });
    world.mail.addThread(ACCOUNT_B, { threadId: "team-1", from: "one@team.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "team-2", from: "two@team.test", at: LATER });

    await world.screen.decide(
      { address: "Lena <lena@example.net>", scope: "address", decision: "accept" },
      NO_DEADLINE,
    );
    await world.screen.decide(
      { address: "one@team.test", scope: "domain", decision: "accept" },
      NO_DEADLINE,
    );

    expect(await newSenders(world, ACCOUNT_A, ["lena-a", "colleague", "team-2"])).toEqual([
      false,
      true,
      false,
    ]);
    expect(await newSenders(world, ACCOUNT_B, ["lena-b", "team-1"])).toEqual([false, false]);
  });

  it("archives a blocked sender's Inbox in every account now, and later letters after a sync", async () => {
    const events: unknown[] = [];
    const world = await readyWorld({ onEvent: (event) => events.push(event) });
    world.mail.addThread(ACCOUNT_A, { threadId: "growth-1", from: "news@growth.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "growth-2", from: "news@growth.test", at: LATER });
    world.mail.addThread(ACCOUNT_B, { threadId: "growth-3", from: "News <NEWS@growth.test>", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "other", from: "other@growth.test", at: LATER });

    const result = await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );

    expect(result.pending).toBe(false);
    expect(sortRefs(result.archived)).toEqual(
      sortRefs([
        { accountId: ACCOUNT_A, threadId: "growth-1" },
        { accountId: ACCOUNT_A, threadId: "growth-2" },
        { accountId: ACCOUNT_B, threadId: "growth-3" },
      ]),
    );
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["other"]);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);

    world.mail.addThread(ACCOUNT_B, { threadId: "growth-4", from: "news@growth.test", at: LATER + 5 });
    await world.screen.runBackgroundSenderStep(
      ACCOUNT_B,
      { syncSucceeded: false },
      new AbortController().signal,
    );
    expect(world.mail.inbox(ACCOUNT_B)).toEqual(["growth-4"]);

    await world.screen.runBackgroundSenderStep(
      ACCOUNT_B,
      { syncSucceeded: true },
      new AbortController().signal,
    );
    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);
    expect(events).toContainEqual({
      event: "mail_sender_blocked_archived",
      phase: "sync",
      accountId: ACCOUNT_B,
      threadCount: 1,
    });
    expect(JSON.stringify(events)).not.toContain("growth.test");

    const blocked = await world.screen.listBlocked();
    expect(blocked.blocked).toEqual([
      {
        decisionId: result.decisionId,
        key: "news@growth.test",
        scope: "address",
        decidedAt: expect.any(Number),
        archivedCount: 4,
      },
    ]);
  });

  it("blocks a whole domain but spares an address accepted on its own", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "kept", from: "person@spam.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "gone", from: "promo@spam.test", at: LATER });
    await world.screen.decide(
      { address: "person@spam.test", scope: "address", decision: "accept" },
      NO_DEADLINE,
    );

    const result = await world.screen.decide(
      { address: "promo@spam.test", scope: "domain", decision: "block" },
      NO_DEADLINE,
    );

    expect(result.archived).toEqual([{ accountId: ACCOUNT_A, threadId: "gone" }]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["kept"]);
  });

  it("undoes a block by moving back exactly the threads it archived", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "growth-1", from: "news@growth.test", at: LATER });
    world.mail.addThread(ACCOUNT_B, { threadId: "growth-2", from: "news@growth.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, {
      threadId: "archived-by-hand",
      from: "news@growth.test",
      at: LATER,
      inbox: false,
    });
    const block = await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    world.mail.updateThread.mockClear();

    const undo = await world.screen.undo(block.decisionId, { restore: true }, NO_DEADLINE);

    expect(undo.pending).toBe(false);
    expect(sortRefs(undo.restored)).toEqual(
      sortRefs([
        { accountId: ACCOUNT_A, threadId: "growth-1" },
        { accountId: ACCOUNT_B, threadId: "growth-2" },
      ]),
    );
    expect(world.mail.updateThread).toHaveBeenCalledTimes(2);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["growth-1"]);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual(["growth-2"]);
    expect((await world.screen.listBlocked()).blocked).toEqual([]);
    await expect(
      world.screen.undo(block.decisionId, { restore: true }, NO_DEADLINE),
    ).rejects.toMatchObject({ code: "mail_sender_decision_not_found" });
  });

  it("unblocks without moving old mail back, and stops archiving", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "growth-1", from: "news@growth.test", at: LATER });
    const block = await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );

    const unblock = await world.screen.undo(block.decisionId, { restore: false }, NO_DEADLINE);
    world.mail.addThread(ACCOUNT_A, { threadId: "growth-2", from: "news@growth.test", at: LATER + 1 });
    await world.screen.runBackgroundSenderStep(
      ACCOUNT_A,
      { syncSucceeded: true },
      new AbortController().signal,
    );

    expect(unblock).toEqual({ apiVersion: 1, restored: [], pending: false });
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["growth-2"]);
  });

  it("undoes an accept by removing the decision and the known entry it added", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "lena", from: "lena@example.net", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "old", from: "friend@example.net", at: 10 });
    await finishBackfill(world, true);
    world.mail.addThread(ACCOUNT_A, { threadId: "friend", from: "friend@example.net", at: LATER });

    const lena = await world.screen.decide(
      { address: "lena@example.net", scope: "address", decision: "accept" },
      NO_DEADLINE,
    );
    const friend = await world.screen.decide(
      { address: "friend@example.net", scope: "address", decision: "accept" },
      NO_DEADLINE,
    );
    expect(await newSenders(world, ACCOUNT_A, ["lena", "friend"])).toEqual([false, false]);

    await world.screen.undo(lena.decisionId, { restore: true }, NO_DEADLINE);
    await world.screen.undo(friend.decisionId, { restore: true }, NO_DEADLINE);

    // Lena was new before the accept and is new again. The friend was known
    // before anyone decided anything, and an undo cannot take that away.
    expect(await newSenders(world, ACCOUNT_A, ["lena", "friend"])).toEqual([true, false]);
  });

  it("archives two hundred now and leaves the rest to the next steps", async () => {
    const world = await readyWorld();
    for (let index = 0; index < 205; index += 1) {
      world.mail.addThread(ACCOUNT_A, {
        threadId: `bulk-${index}`,
        from: "bulk@mass.test",
        at: LATER + index,
      });
    }

    const result = await world.screen.decide(
      { address: "bulk@mass.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );

    expect(result.archived).toHaveLength(200);
    expect(result.pending).toBe(true);
    expect(world.mail.inbox(ACCOUNT_A)).toHaveLength(5);
    await world.screen.runBackgroundSenderStep(
      ACCOUNT_A,
      { syncSucceeded: true },
      new AbortController().signal,
    );
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);
  });

  it("lets everything through while switched off and learns again when switched back on", async () => {
    let now = LATER + 100;
    const world = await readyWorld({ now: () => now });
    world.mail.addThread(ACCOUNT_A, { threadId: "fresh", from: "stranger@example.net", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "growth", from: "news@growth.test", at: LATER });
    await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    world.mail.addThread(ACCOUNT_A, { threadId: "growth-2", from: "news@growth.test", at: LATER });

    const off = await world.screen.setEnabled(false);
    await world.screen.runBackgroundSenderStep(
      ACCOUNT_A,
      { syncSucceeded: true },
      new AbortController().signal,
    );

    expect(off).toEqual({
      apiVersion: 1,
      enabled: false,
      enabledAt: null,
      backfillComplete: false,
    });
    expect(await newSenders(world, ACCOUNT_A, ["fresh"])).toEqual([false]);
    expect(world.mail.inbox(ACCOUNT_A)).toContain("growth-2");

    now = LATER + 500;
    const on = await world.screen.setEnabled(true);
    expect(on).toEqual({
      apiVersion: 1,
      enabled: true,
      enabledAt: LATER + 500,
      backfillComplete: false,
    });
    await finishBackfill(world);
    // The stranger wrote before the switch came back on, so the new backfill
    // counts them as known.
    expect(await newSenders(world, ACCOUNT_A, ["fresh"])).toEqual([false]);
  });

  it("makes a sent message's recipients known", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "reply-1", from: "new.person@h.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "reply-2", from: "other@h.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "reply-3", from: "hidden@h.test", at: LATER });

    world.screen.recordSentRecipients({
      to: ["New.Person@H.test"],
      cc: ["Other <other@h.test>"],
    });

    expect(await newSenders(world, ACCOUNT_A, ["reply-1", "reply-2", "reply-3"])).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("refuses an address it cannot read and a decision it does not hold", async () => {
    const world = await readyWorld();

    await expect(
      world.screen.decide(
        { address: "not an address", scope: "address", decision: "block" },
        NO_DEADLINE,
      ),
    ).rejects.toBeInstanceOf(MailSenderError);
    await expect(
      world.screen.undo(
        "decision-a00000000000000000000000000000000",
        { restore: true },
        NO_DEADLINE,
      ),
    ).rejects.toMatchObject({ code: "mail_sender_decision_not_found" });
  });

  it("annotates every thread item the message service returns", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "fresh", from: "stranger@example.net", at: LATER });
    const fresh = world.mail.item(ACCOUNT_A, "fresh");
    const inner: MailMessageService & {
      readBackgroundSyncHealth(): Promise<{
        lastSuccessfulAt: number | null;
        lastErrorCode: string | null;
      }>;
    } = {
      readBackgroundSyncHealth: vi.fn().mockResolvedValue({
        lastSuccessfulAt: null,
        lastErrorCode: null,
      }),
      listThreads: vi.fn().mockResolvedValue({
        apiVersion: 1,
        items: [fresh],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 1 },
      }),
      listMailboxThreads: vi.fn().mockResolvedValue({
        apiVersion: 1,
        mailboxId: "all",
        items: [fresh],
        nextCursor: null,
        availability: { status: "available", lastSuccessfulAt: 1, windowTruncated: false },
      }),
      searchThreads: vi.fn().mockResolvedValue({
        apiVersion: 1,
        mailboxId: "inbox",
        scope: "headers_and_previews",
        items: [fresh],
        nextCursor: null,
        availability: { status: "available", lastSuccessfulAt: 1, windowTruncated: false },
        indexStatus: "ready",
        resultsTruncated: false,
      }),
      getThread: vi.fn().mockResolvedValue({ apiVersion: 1, thread: fresh, messages: [] }),
      getMailboxThread: vi.fn().mockResolvedValue(null),
      sync: vi.fn(),
      syncAccount: vi.fn(),
      updateThread: vi.fn().mockResolvedValue({ apiVersion: 1, thread: fresh }),
    };
    const screened = new MailSenderScreenedMessageService(inner, world.screen);

    const list = await screened.listThreads({ accountId: ACCOUNT_A, limit: 20 });
    const mailbox = await screened.listMailboxThreads({
      accountId: ACCOUNT_A,
      mailboxId: "all",
      limit: 20,
    });
    const search = await screened.searchThreads({
      accountId: ACCOUNT_A,
      mailboxId: "inbox",
      query: "x",
      limit: 20,
    });
    const detail = await screened.getThread({ accountId: ACCOUNT_A, threadId: "fresh" });
    const missing = await screened.getMailboxThread({
      accountId: ACCOUNT_A,
      mailboxId: "all",
      threadId: "fresh",
    });
    const updated = await screened.updateThread(
      { accountId: ACCOUNT_A, threadId: "fresh", read: true },
      new AbortController().signal,
    );

    expect(list.items[0]!.newSender).toBe(true);
    expect(list.sync).toEqual({ status: "idle", lastSuccessfulAt: 1 });
    expect(mailbox.items[0]!.newSender).toBe(true);
    expect(search.items[0]!.newSender).toBe(true);
    expect(search.indexStatus).toBe("ready");
    expect(detail!.thread.newSender).toBe(true);
    expect(missing).toBeNull();
    expect(updated.thread.newSender).toBe(true);
  });

  it("answers false rather than failing a list when the screen cannot read", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "fresh", from: "stranger@example.net", at: LATER });
    world.mail.readThreadFirstSenders.mockRejectedValueOnce(new Error("cache closed"));

    expect(await newSenders(world, ACCOUNT_A, ["fresh"])).toEqual([false]);
  });
});

interface FakeMessage {
  readonly rowid: number;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly sentAt: number | null;
}

interface FakeThread {
  readonly threadId: string;
  readonly category: MailThreadCategory;
  inInbox: boolean;
  readonly sent: boolean;
  readonly messages: FakeMessage[];
}

function createFakeMail(accounts: Readonly<Record<string, string>>) {
  const threads = new Map<string, FakeThread[]>(
    Object.keys(accounts).map((accountId) => [accountId, []]),
  );
  let rowid = 0;
  const item = (accountId: string, threadId: string): MailThreadListItem => {
    const thread = threads.get(accountId)!.find((entry) => entry.threadId === threadId)!;
    return Object.freeze({
      accountId,
      threadId,
      subject: threadId,
      participants: Object.freeze([]),
      snippet: null,
      lastMessageAt: thread.messages.at(-1)!.sentAt,
      messageCount: thread.messages.length,
      unread: true,
      starred: false,
      hasAttachments: false,
      listMessage: thread.category !== "people",
      sizeBytes: 0,
      category: thread.category,
      newSender: false,
    });
  };
  const updateThread = vi.fn(
    async (input: MailThreadMutationInput & { readonly threadId: string }) => {
      const thread = threads
        .get(input.accountId)!
        .find((entry) => entry.threadId === input.threadId);
      if (!thread || !("archive" in input)) throw new Error("unexpected mutation");
      thread.inInbox = !input.archive;
      return Object.freeze({ apiVersion: 1 as const, thread: item(input.accountId, input.threadId) });
    },
  );
  const readThreadFirstSenders = vi.fn(
    async (accountId: string, threadIds: readonly string[]) =>
      new Map(
        threadIds.flatMap((threadId) => {
          const thread = threads.get(accountId)!.find((entry) => entry.threadId === threadId);
          if (!thread) return [];
          const first = thread.messages[0]!;
          return [[threadId, { address: first.from, firstMessageAt: first.sentAt }] as const];
        }),
      ),
  );
  const port: MailSenderMailPort = {
    async listAccountIds() {
      return Object.keys(accounts);
    },
    async readAccountAddress(accountId) {
      return accounts[accountId] ?? null;
    },
    readThreadFirstSenders,
    async readSenderBackfillBatch(accountId, input) {
      const messages = threads.get(accountId)!.flatMap((thread) =>
        thread.messages.map((message) => ({ message, sent: thread.sent })),
      );
      const maxRowid = messages.reduce((max, entry) => Math.max(max, entry.message.rowid), 0);
      if (input.fromCursor < maxRowid) {
        const end = Math.min(input.fromCursor + input.window, maxRowid);
        return {
          addresses: messages
            .filter(
              ({ message }) =>
                message.rowid > input.fromCursor &&
                message.rowid <= end &&
                message.from !== null &&
                (message.sentAt === null || message.sentAt <= input.enabledAt),
            )
            .map(({ message }) => message.from!),
          fromCursor: end,
          sentCursor: input.sentCursor,
          done: end >= maxRowid && input.sentCursor >= maxRowid,
        };
      }
      if (input.sentCursor < maxRowid) {
        const end = Math.min(input.sentCursor + input.window, maxRowid);
        return {
          addresses: messages
            .filter(
              ({ message, sent }) =>
                sent && message.rowid > input.sentCursor && message.rowid <= end,
            )
            .flatMap(({ message }) => [...message.to, ...message.cc]),
          fromCursor: input.fromCursor,
          sentCursor: end,
          done: end >= maxRowid,
        };
      }
      return {
        addresses: [],
        fromCursor: input.fromCursor,
        sentCursor: input.sentCursor,
        done: true,
      };
    },
    async listInboxThreadFirstSenders(accountId) {
      return threads
        .get(accountId)!
        .filter((thread) => thread.inInbox)
        .map((thread) => ({ threadId: thread.threadId, address: thread.messages[0]!.from }));
    },
    updateThread,
  };
  return {
    port,
    updateThread,
    readThreadFirstSenders,
    item,
    addThread(
      accountId: string,
      input: {
        readonly threadId: string;
        readonly from: string;
        readonly at: number;
        readonly to?: readonly string[];
        readonly cc?: readonly string[];
        readonly category?: MailThreadCategory;
        readonly inbox?: boolean;
        readonly sent?: boolean;
      },
    ) {
      rowid += 1;
      threads.get(accountId)!.push({
        threadId: input.threadId,
        category: input.category ?? "people",
        inInbox: input.inbox ?? true,
        sent: input.sent ?? false,
        messages: [
          {
            rowid,
            from: input.from,
            to: input.to ?? [],
            cc: input.cc ?? [],
            sentAt: input.at,
          },
        ],
      });
    },
    inbox(accountId: string): string[] {
      return threads
        .get(accountId)!
        .filter((thread) => thread.inInbox)
        .map((thread) => thread.threadId);
    },
  };
}

type World = Awaited<ReturnType<typeof createWorld>>;

async function createStore(now: () => number) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "brain-mail-senders-"));
  roots.push(stateDirectory);
  const store = new SqliteMailSenderStore({ stateDirectory, now });
  stores.push(store);
  await store.initialize();
  return { store, stateDirectory };
}

async function createWorld(
  options: { readonly now?: () => number; readonly onEvent?: (event: unknown) => void } = {},
) {
  const { store } = await createStore(() => ENABLED_AT);
  const mail = createFakeMail({ [ACCOUNT_A]: "Me <me@a.test>", [ACCOUNT_B]: "me@b.test" });
  const screen = new MailSenderScreen({
    store,
    mail: mail.port,
    now: options.now ?? (() => LATER + 100),
    onEvent: options.onEvent,
    backfillWindow: 2,
  });
  return { store, mail, screen };
}

/** A screen whose backfill has already run over an empty cache. */
async function readyWorld(
  options: { readonly now?: () => number; readonly onEvent?: (event: unknown) => void } = {},
): Promise<World> {
  const world = await createWorld(options);
  await finishBackfill(world);
  return world;
}

async function finishBackfill(world: World, restart = false): Promise<void> {
  if (restart) {
    world.store.setEnabled(false, ENABLED_AT);
    world.store.setEnabled(true, ENABLED_AT);
  }
  for (const accountId of [ACCOUNT_A, ACCOUNT_B]) {
    for (let step = 0; step < 50; step += 1) {
      const { hasMore } = await world.screen.runBackgroundSenderStep(
        accountId,
        { syncSucceeded: false },
        new AbortController().signal,
      );
      if (!hasMore) break;
    }
  }
}

async function newSenders(
  world: World,
  accountId: string,
  threadIds: readonly string[],
): Promise<boolean[]> {
  const items = await world.screen.annotateItems(
    accountId,
    threadIds.map((threadId) => world.mail.item(accountId, threadId)),
  );
  return items.map((item) => item.newSender);
}

function sortRefs(
  refs: readonly { readonly accountId: string; readonly threadId: string }[],
): Array<{ accountId: string; threadId: string }> {
  return [...refs]
    .map((ref) => ({ accountId: ref.accountId, threadId: ref.threadId }))
    .sort((left, right) =>
      `${left.accountId}/${left.threadId}`.localeCompare(`${right.accountId}/${right.threadId}`),
    );
}
