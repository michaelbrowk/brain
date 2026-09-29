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
import { MailProviderSyncError, type MailMessageService } from "./message-service";

const ACCOUNT_A = "account-a11111111111111111111111111111111";
const ACCOUNT_B = "account-a22222222222222222222222222222222";
const ACCOUNT_C = "account-a33333333333333333333333333333333";
/** The switch is turned on here, and both accounts finish their backfill at
 *  BACKFILLED. Letters dated LATER arrived after both. */
const ENABLED_AT = 1_000;
const BACKFILLED = 1_500;
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

  it("keeps a plus tag and splits at the last @", () => {
    // A tag is part of the address a person chose to give out; folding it
    // would let one decision speak for addresses the owner never saw.
    expect(normalizeSenderAddress("Lena+News@Example.com")).toBe("lena+news@example.com");
    expect(normalizeSenderAddress('"a@b"@Example.com')).toBe('"a@b"@example.com');
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
    gateMoment: ENABLED_AT,
    category: "people",
    inInbox: true,
    firstMessageAt: LATER,
    startsConversation: true,
    sender: "stranger@example.com",
    own: false,
    known: false,
    addressDecision: null,
    domainDecision: null,
  });

  it("gates a first letter from a stranger that arrived after the switch", () => {
    expect(isMailSenderGated(gated)).toBe(true);
  });

  it.each([
    ["the switch is off or this account's backfill has not finished", { gateMoment: null }],
    ["it is a notification", { category: "notification" as MailThreadCategory }],
    ["it is a newsletter", { category: "newsletter" as MailThreadCategory }],
    ["it is not in the Inbox", { inInbox: false }],
    ["its first message has no date", { firstMessageAt: null }],
    ["its first message came at the gating moment", { firstMessageAt: ENABLED_AT }],
    ["its first message came before the gating moment", { firstMessageAt: ENABLED_AT - 1 }],
    ["its first message answers another", { startsConversation: false }],
    ["it has no readable sender", { sender: null }],
    ["the sender is the owner", { own: true }],
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
  it("gates nothing in an account until its own backfill has finished, and keeps gating the others", async () => {
    const world = await readyWorld();
    world.mail.addAccount(ACCOUNT_C, "me@c.test", { cacheReady: false });
    world.mail.addThread(ACCOUNT_A, { threadId: "fresh-a", from: "stranger@example.net", at: LATER });
    world.mail.addThread(ACCOUNT_C, { threadId: "fresh-c", from: "other@example.org", at: LATER });

    expect(await newSenders(world, ACCOUNT_C, ["fresh-c"])).toEqual([false]);
    expect(await newSenders(world, ACCOUNT_A, ["fresh-a"])).toEqual([true]);
    // The account's initial sync has not finished, so its backfill cannot.
    await step(world, ACCOUNT_C, false);
    expect(world.store.readBackfillProgress(ACCOUNT_C)?.completedAt).toBeNull();
    expect((await world.screen.readState()).backfillComplete).toBe(false);
  });

  it("starts gating an account from the moment its own backfill finished", async () => {
    const world = await readyWorld();
    world.mail.addAccount(ACCOUNT_C, "me@c.test", { cacheReady: true });
    world.clock.now = LATER + 100;
    await finishAccount(world, ACCOUNT_C);
    // Synced late, dated before the account started gating.
    world.mail.addThread(ACCOUNT_C, { threadId: "late", from: "late@example.org", at: LATER + 50 });
    world.mail.addThread(ACCOUNT_C, { threadId: "after", from: "after@example.org", at: LATER + 150 });

    expect(await newSenders(world, ACCOUNT_C, ["late", "after"])).toEqual([false, true]);
  });

  it("learns an account connected after the switch from its history, and gates only what arrives after its own backfill", async () => {
    const world = await readyWorld();
    world.mail.addAccount(ACCOUNT_C, "me@c.test", { cacheReady: false });
    await step(world, ACCOUNT_C, false);
    // The initial sync brings the history: a colleague wrote long before the
    // switch, and forty people wrote after the switch but before this account
    // was connected.
    world.mail.addThread(ACCOUNT_C, { threadId: "c-old", from: "colleague@corp.test", at: 100 });
    const since: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      since.push(`c-${index}`);
      world.mail.addThread(ACCOUNT_C, {
        threadId: `c-${index}`,
        from: `person${index}@corp.test`,
        at: LATER + index,
      });
    }
    world.mail.setCacheReady(ACCOUNT_C);
    world.clock.now = LATER + 100;
    await finishAccount(world, ACCOUNT_C);

    expect((await world.screen.readState()).backfillComplete).toBe(true);
    expect((await newSenders(world, ACCOUNT_C, since)).filter(Boolean)).toEqual([]);
    world.mail.addThread(ACCOUNT_C, { threadId: "c-again", from: "colleague@corp.test", at: 5_000 });
    world.mail.addThread(ACCOUNT_C, { threadId: "c-stranger", from: "new@elsewhere.test", at: 5_000 });
    expect(await newSenders(world, ACCOUNT_C, ["c-again", "c-stranger"])).toEqual([false, true]);
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
      fromOwner: true,
    });
    world.mail.addThread(ACCOUNT_B, { threadId: "old-b", from: "Partner@C.test", at: 700 });
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

  it("keeps a stranger a stranger after the account's backfill, however many steps run", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "fresh", from: "stranger@example.net", at: LATER });

    for (let index = 0; index < 5; index += 1) await step(world, ACCOUNT_A, true);

    expect(await newSenders(world, ACCOUNT_A, ["fresh"])).toEqual([true]);
  });

  it("never gates a letter that answers another, and keeps learning from new Sent mail", async () => {
    const world = await readyWorld();
    // The owner wrote from the phone; the reply is its own thread (IMAP keeps
    // one message a thread) and carries In-Reply-To.
    world.mail.addThread(ACCOUNT_A, {
      threadId: "reply",
      from: "x@partner.test",
      at: LATER + 1,
      reply: true,
    });
    world.mail.addThread(ACCOUNT_A, {
      threadId: "sent-from-phone",
      from: "me@a.test",
      to: ["y@partner.test"],
      at: LATER,
      inbox: false,
      sent: true,
      fromOwner: true,
    });
    await step(world, ACCOUNT_A, true);
    world.mail.addThread(ACCOUNT_A, { threadId: "fresh-from-y", from: "y@partner.test", at: LATER + 2 });

    expect(await newSenders(world, ACCOUNT_A, ["reply", "fresh-from-y"])).toEqual([false, false]);
  });

  it("treats the owner's aliases as the owner in every account", async () => {
    const world = await readyWorld();
    // A thread the owner started from a send-as alias: Gmail marks it sent.
    world.mail.addThread(ACCOUNT_A, {
      threadId: "alias-started",
      from: "michael@alias.test",
      at: LATER,
      sent: true,
      fromOwner: true,
    });
    expect(await newSenders(world, ACCOUNT_A, ["alias-started"])).toEqual([false]);
    await step(world, ACCOUNT_A, true);
    // The same alias writing into the other account carries no mark there.
    world.mail.addThread(ACCOUNT_B, { threadId: "alias-in-b", from: "Michael <michael@alias.test>", at: LATER });

    expect(await newSenders(world, ACCOUNT_B, ["alias-in-b"])).toEqual([false]);
    await expect(
      world.screen.decide(
        { address: "michael@alias.test", scope: "address", decision: "block" },
        NO_DEADLINE,
      ),
    ).rejects.toMatchObject({ code: "mail_sender_own_address" });
    expect((await world.screen.readState()).domainScopeRefused).toContain("alias.test");
  });

  it("refuses a decision about the owner's own address or domain, and domain scope for mail providers", async () => {
    const world = await readyWorld();

    for (const input of [
      { address: "Me <ME@A.test>", scope: "address", decision: "block" },
      { address: "me@a.test", scope: "address", decision: "accept" },
      { address: "someone@a.test", scope: "domain", decision: "block" },
    ] as const) {
      await expect(world.screen.decide(input, NO_DEADLINE)).rejects.toMatchObject({
        code: "mail_sender_own_address",
      });
    }
    for (const domain of ["gmail.com", "outlook.com", "icloud.com", "proton.me", "mail.ru"]) {
      await expect(
        world.screen.decide(
          { address: `someone@${domain}`, scope: "domain", decision: "block" },
          NO_DEADLINE,
        ),
      ).rejects.toMatchObject({ code: "mail_sender_domain_scope_refused" });
    }
    await expect(
      world.screen.decide(
        { address: "someone@gmail.com", scope: "address", decision: "block" },
        NO_DEADLINE,
      ),
    ).resolves.toMatchObject({ pending: false });
    expect((await world.screen.readState()).domainScopeRefused).toEqual(
      expect.arrayContaining(["gmail.com", "a.test", "b.test"]),
    );
  });

  it("blocks a domain but spares the owner's threads and every known address there", async () => {
    const world = await createWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "friend-old", from: "friend@corp.test", at: 500 });
    await finishBackfill(world);
    world.mail.addThread(ACCOUNT_A, { threadId: "mine", from: "Me <me@a.test>", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "friend-new", from: "friend@corp.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "spam", from: "spammer@corp.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, {
      threadId: "sent-by-owner",
      from: "owner@corp.test",
      at: LATER,
      fromOwner: true,
    });
    expect(await newSenders(world, ACCOUNT_A, ["mine", "friend-new", "spam"])).toEqual([
      false,
      false,
      true,
    ]);

    const result = await world.screen.decide(
      { address: "spammer@corp.test", scope: "domain", decision: "block" },
      NO_DEADLINE,
    );

    expect(result.archived).toEqual([{ accountId: ACCOUNT_A, threadId: "spam" }]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([
      "friend-old",
      "mine",
      "friend-new",
      "sent-by-owner",
    ]);
    world.mail.addThread(ACCOUNT_A, { threadId: "friend-later", from: "friend@corp.test", at: LATER + 9 });
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toContain("friend-later");

    // Only the known address's own block archives it.
    await world.screen.decide(
      { address: "friend@corp.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["mine", "sent-by-owner"]);
  });

  it("never archives a letter from the owner's alias, learned after a block of its domain", async () => {
    const world = await readyWorld();
    await world.screen.decide(
      { address: "spammer@corp.test", scope: "domain", decision: "block" },
      NO_DEADLINE,
    );
    world.mail.addThread(ACCOUNT_A, {
      threadId: "sent-as-alias",
      from: "owner@corp.test",
      to: ["someone@elsewhere.test"],
      at: LATER,
      inbox: false,
      sent: true,
      fromOwner: true,
    });
    await step(world, ACCOUNT_A, true);
    world.mail.addThread(ACCOUNT_B, { threadId: "alias-to-b", from: "owner@corp.test", at: LATER + 1 });

    await step(world, ACCOUNT_B, true);

    expect(world.mail.inbox(ACCOUNT_B)).toEqual(["alias-to-b"]);
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
    await step(world, ACCOUNT_B, false);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual(["growth-4"]);

    await step(world, ACCOUNT_B, true);
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

  it("archives only the new block's senders, not those of an older block", async () => {
    const world = await readyWorld();
    await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    // Arrived after the older block, before the sync that would archive it.
    world.mail.addThread(ACCOUNT_A, { threadId: "old-block", from: "news@growth.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "new-block", from: "promo@deals.test", at: LATER });

    const result = await world.screen.decide(
      { address: "promo@deals.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );

    expect(result.archived).toEqual([{ accountId: ACCOUNT_A, threadId: "new-block" }]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["old-block"]);
  });

  it("leaves a thread the owner moved back, until a newer letter arrives in it", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "keep", from: "news@growth.test", at: LATER });
    await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    await world.mail.port.updateThread(
      { accountId: ACCOUNT_A, threadId: "keep", archive: false },
      new AbortController().signal,
    );

    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["keep"]);

    world.mail.addMessage(ACCOUNT_A, "keep", { from: "news@growth.test", at: LATER + 50 });
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);
  });

  it("never archives an accepted sender while a block stands elsewhere", async () => {
    const world = await readyWorld();
    await world.screen.decide(
      { address: "lena@example.net", scope: "address", decision: "accept" },
      NO_DEADLINE,
    );
    await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    world.mail.addThread(ACCOUNT_A, { threadId: "lena", from: "lena@example.net", at: LATER });

    await step(world, ACCOUNT_A, true);

    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["lena"]);
  });

  it("archives at most twenty-five a step and leaves a refused thread alone for an hour", async () => {
    const world = await readyWorld();
    await world.screen.decide(
      { address: "bulk@mass.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    for (let index = 0; index < 30; index += 1) {
      world.mail.addThread(ACCOUNT_A, { threadId: `bulk-${index}`, from: "bulk@mass.test", at: LATER });
    }
    world.mail.addThread(ACCOUNT_B, { threadId: "stuck", from: "bulk@mass.test", at: LATER });
    const original = world.mail.updateThread.getMockImplementation()!;
    world.mail.updateThread.mockImplementation(async (input, signal) => {
      if (input.threadId === "stuck") {
        throw new MailProviderSyncError("mail_provider_mutation_unsupported");
      }
      return original(input, signal);
    });

    const first = await step(world, ACCOUNT_A, true);
    expect(first.hasMore).toBe(true);
    expect(world.mail.inbox(ACCOUNT_A)).toHaveLength(5);
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);

    await step(world, ACCOUNT_B, true);
    await step(world, ACCOUNT_B, true);
    expect(
      world.mail.updateThread.mock.calls.filter(([input]) => input.threadId === "stuck"),
    ).toHaveLength(1);
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

  it("finishes an Undo that arrives while the block is still archiving", async () => {
    const world = await readyWorld();
    for (const threadId of ["t1", "t2", "t3"]) {
      world.mail.addThread(ACCOUNT_A, { threadId, from: "news@growth.test", at: LATER });
    }
    const gate = world.mail.holdArchiveOf("t2");

    const blocking = world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    await gate.reached;
    const [decision] = world.store.listBlocked(10);
    const undoing = world.screen.undo(decision!.decisionId, { restore: true }, NO_DEADLINE);
    gate.release();
    const [block, undo] = await Promise.all([blocking, undoing]);

    expect(block.archived.map((ref) => ref.threadId)).toEqual(["t1", "t2"]);
    expect(undo.restored.map((ref) => ref.threadId).sort()).toEqual(["t1", "t2"]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["t1", "t2", "t3"]);
    expect(world.store.listBlocked(10)).toEqual([]);
    expect(world.store.listPendingRestores(ACCOUNT_A, 10)).toEqual([]);
  });

  it("finishes an Undo that arrives while the archiver is working", async () => {
    const world = await readyWorld();
    const block = await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    for (const threadId of ["t1", "t2", "t3"]) {
      world.mail.addThread(ACCOUNT_A, { threadId, from: "news@growth.test", at: LATER + 1 });
    }
    const gate = world.mail.holdArchiveOf("t2");

    const archiving = step(world, ACCOUNT_A, true);
    await gate.reached;
    const undoing = world.screen.undo(block.decisionId, { restore: true }, NO_DEADLINE);
    gate.release();
    await archiving;
    const undo = await undoing;

    expect(undo.restored.map((ref) => ref.threadId).sort()).toEqual(["t1", "t2"]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["t1", "t2", "t3"]);
  });

  it("restores a thread whose archive was cut short before its record was finished", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "news@growth.test", at: LATER });
    // The provider archives the thread and the answer never arrives, as when
    // the process dies between the two.
    const original = world.mail.updateThread.getMockImplementation()!;
    world.mail.updateThread.mockImplementationOnce(async (input, signal) => {
      await original(input, signal);
      throw new Error("connection reset after the archive");
    });

    const block = await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    expect(block).toMatchObject({ archived: [], pending: true });
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);

    const undo = await world.screen.undo(block.decisionId, { restore: true }, NO_DEADLINE);

    expect(undo.restored).toEqual([{ accountId: ACCOUNT_A, threadId: "t1" }]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["t1"]);
  });

  it("gives up a restore the provider refuses, retries one that failed in passing, and says so in the log", async () => {
    const events: unknown[] = [];
    const world = await readyWorld({ onEvent: (event) => events.push(event) });
    for (const threadId of ["gone", "flaky", "fine"]) {
      world.mail.addThread(ACCOUNT_A, { threadId, from: "news@growth.test", at: LATER });
    }
    const block = await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    const original = world.mail.updateThread.getMockImplementation()!;
    let flakyCalls = 0;
    world.mail.updateThread.mockImplementation(async (input, signal) => {
      if (input.threadId === "gone") throw new MailProviderSyncError("mail_provider_thread_stale");
      if (input.threadId === "flaky" && flakyCalls++ < 1) throw new Error("socket reset");
      return original(input, signal);
    });

    const undo = await world.screen.undo(block.decisionId, { restore: true }, NO_DEADLINE);

    expect(undo.restored.map((ref) => ref.threadId)).toEqual(["fine"]);
    expect(undo.pending).toBe(true);
    expect(events).toContainEqual({
      event: "mail_sender_restore_failed",
      phase: "undo",
      accountId: ACCOUNT_A,
      threadCount: 1,
    });
    await step(world, ACCOUNT_A, false);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["fine"]);
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A).sort()).toEqual(["fine", "flaky"]);
  });

  it("moves back two hundred on Undo and leaves the rest to the next steps", async () => {
    const world = await readyWorld();
    for (let index = 0; index < 205; index += 1) {
      world.mail.addThread(ACCOUNT_A, { threadId: `bulk-${index}`, from: "bulk@mass.test", at: LATER });
    }
    const block = await world.screen.decide(
      { address: "bulk@mass.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);

    const undo = await world.screen.undo(block.decisionId, { restore: true }, NO_DEADLINE);

    expect(undo.restored).toHaveLength(200);
    expect(undo.pending).toBe(true);
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toHaveLength(205);
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
    await step(world, ACCOUNT_A, true);

    expect(unblock).toEqual({ apiVersion: 1, restored: [], pending: false });
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["growth-2"]);
  });

  it("answers the standing decision when the same one is made twice, and carries a block's archive into a changed verdict", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "news@growth.test", at: LATER });

    const first = await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    const again = await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    expect(again).toEqual({ apiVersion: 1, decisionId: first.decisionId, archived: [], pending: false });

    const accept = await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "accept" },
      NO_DEADLINE,
    );
    expect(accept.decisionId).not.toBe(first.decisionId);
    await expect(
      world.screen.undo(first.decisionId, { restore: true }, NO_DEADLINE),
    ).rejects.toMatchObject({ code: "mail_sender_decision_not_found" });

    const undo = await world.screen.undo(accept.decisionId, { restore: true }, NO_DEADLINE);
    expect(undo.restored).toEqual([{ accountId: ACCOUNT_A, threadId: "t1" }]);
    world.mail.addThread(ACCOUNT_A, { threadId: "t2", from: "news@growth.test", at: LATER + 7 });
    expect(await newSenders(world, ACCOUNT_A, ["t2"])).toEqual([true]);
  });

  it("undoes an accept by removing the decision and the known entry it added", async () => {
    const world = await createWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "old", from: "friend@example.net", at: 10 });
    await finishBackfill(world);
    world.mail.addThread(ACCOUNT_A, { threadId: "lena", from: "lena@example.net", at: LATER });
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
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);
  });

  it("lets everything through while switched off and learns again when switched back on", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "fresh", from: "stranger@example.net", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "growth", from: "news@growth.test", at: LATER });
    await world.screen.decide(
      { address: "news@growth.test", scope: "address", decision: "block" },
      NO_DEADLINE,
    );
    world.mail.addThread(ACCOUNT_A, { threadId: "growth-2", from: "news@growth.test", at: LATER });

    const off = await world.screen.setEnabled(false);
    await step(world, ACCOUNT_A, true);

    expect(off).toMatchObject({ enabled: false, enabledAt: null, backfillComplete: false });
    expect(await newSenders(world, ACCOUNT_A, ["fresh"])).toEqual([false]);
    expect(world.mail.inbox(ACCOUNT_A)).toContain("growth-2");

    world.clock.now = LATER + 500;
    const on = await world.screen.setEnabled(true);
    expect(on).toMatchObject({ enabled: true, enabledAt: LATER + 500, backfillComplete: false });
    await finishBackfill(world);
    // The stranger wrote before the switch came back on, so the new backfill
    // counts them as known.
    expect(await newSenders(world, ACCOUNT_A, ["fresh"])).toEqual([false]);
  });

  it("drops a backfill step that read while the switch was flipped", async () => {
    const world = await createWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "old", from: "friend@example.net", at: 500 });
    world.mail.onNextBackfillRead(() => {
      world.store.setEnabled(false, ENABLED_AT);
      world.store.setEnabled(true, ENABLED_AT + 1);
    });

    await step(world, ACCOUNT_A, false);

    expect(world.store.readBackfillProgress(ACCOUNT_A)).toBeNull();
    expect(world.store.isKnown("friend@example.net")).toBe(false);
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

  it("annotates every thread item the message service returns, and only an Inbox thread waits", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "fresh", from: "stranger@example.net", at: LATER });
    world.mail.addThread(ACCOUNT_A, {
      threadId: "archived-stranger",
      from: "stranger2@example.net",
      at: LATER,
      inbox: false,
    });
    const fresh = world.mail.item(ACCOUNT_A, "fresh");
    const archived = world.mail.item(ACCOUNT_A, "archived-stranger");
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
        items: [fresh, archived],
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
    expect(mailbox.items.map((item) => item.newSender)).toEqual([true, false]);
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
  readonly isReply: boolean;
  readonly fromOwner: boolean;
}

interface FakeThread {
  readonly threadId: string;
  readonly category: MailThreadCategory;
  inInbox: boolean;
  readonly sent: boolean;
  readonly messages: FakeMessage[];
}

interface FakeAccount {
  readonly address: string;
  cacheReady: boolean;
}

/**
 * The screen's port, over an in-memory mailbox that keeps the cache's rules:
 * rows numbered as they arrive, a From phase and a Sent phase read in windows,
 * and the first message of a thread being its earliest.
 */
function createFakeMail(initial: Readonly<Record<string, string>>) {
  const accounts = new Map<string, FakeAccount>(
    Object.entries(initial).map(([accountId, address]) => [
      accountId,
      { address, cacheReady: true },
    ]),
  );
  const threads = new Map<string, FakeThread[]>(
    Object.keys(initial).map((accountId) => [accountId, []]),
  );
  let rowid = 0;
  let beforeNextBackfillRead: (() => void) | null = null;
  const find = (accountId: string, threadId: string) =>
    threads.get(accountId)!.find((entry) => entry.threadId === threadId);
  const item = (accountId: string, threadId: string): MailThreadListItem => {
    const thread = find(accountId, threadId)!;
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
  const updateThread = vi.fn<MailSenderMailPort["updateThread"]>(
    async (input: MailThreadMutationInput & { readonly threadId: string }) => {
      const thread = find(input.accountId, input.threadId);
      if (!thread || !("archive" in input)) throw new Error("unexpected mutation");
      thread.inInbox = !input.archive;
      return Object.freeze({ apiVersion: 1 as const, thread: item(input.accountId, input.threadId) });
    },
  );
  const readThreadFirstSenders = vi.fn(
    async (accountId: string, threadIds: readonly string[]) =>
      new Map(
        threadIds.flatMap((threadId) => {
          const thread = find(accountId, threadId);
          if (!thread) return [];
          const first = thread.messages[0]!;
          return [
            [
              threadId,
              {
                address: first.from,
                firstMessageAt: first.sentAt,
                startsConversation: !first.isReply,
                fromOwner: first.fromOwner,
                inInbox: thread.inInbox,
              },
            ] as const,
          ];
        }),
      ),
  );
  const port: MailSenderMailPort = {
    async listAccounts() {
      return [...accounts].map(([accountId, account]) => ({
        accountId,
        address: account.address,
        connected: true,
      }));
    },
    readThreadFirstSenders,
    async readSenderBackfillBatch(accountId, input) {
      const hook = beforeNextBackfillRead;
      beforeNextBackfillRead = null;
      hook?.();
      const cacheReady = accounts.get(accountId)!.cacheReady;
      const rows = threads.get(accountId)!.flatMap((thread) =>
        thread.messages.map((message) => ({ message, sent: thread.sent })),
      );
      const last = rows.reduce((max, entry) => Math.max(max, entry.message.rowid), 0);
      if (input.learnFrom && input.fromCursor < last) {
        const end = Math.min(input.fromCursor + input.window, last);
        return {
          known: rows
            .filter(
              ({ message }) =>
                message.rowid > input.fromCursor && message.rowid <= end && message.from !== null,
            )
            .map(({ message }) => message.from!),
          own: [],
          fromCursor: end,
          sentCursor: input.sentCursor,
          done: end >= last && input.sentCursor >= last,
          cacheReady,
        };
      }
      if (input.sentCursor < last) {
        const end = Math.min(input.sentCursor + input.window, last);
        const window = rows.filter(
          ({ message, sent }) =>
            (sent || message.fromOwner) &&
            message.rowid > input.sentCursor &&
            message.rowid <= end,
        );
        return {
          known: window.flatMap(({ message }) => [...message.to, ...message.cc]),
          own: window.flatMap(({ message }) =>
            message.fromOwner && message.from !== null ? [message.from] : [],
          ),
          fromCursor: input.fromCursor,
          sentCursor: end,
          done: (!input.learnFrom || input.fromCursor >= last) && end >= last,
          cacheReady,
        };
      }
      return {
        known: [],
        own: [],
        fromCursor: input.fromCursor,
        sentCursor: input.sentCursor,
        done: true,
        cacheReady,
      };
    },
    async listInboxThreadFirstSenders(accountId) {
      return threads
        .get(accountId)!
        .filter((thread) => thread.inInbox)
        .map((thread) => ({
          threadId: thread.threadId,
          address: thread.messages[0]!.from,
          fromOwner: thread.messages[0]!.fromOwner,
          lastMessageAt: thread.messages.at(-1)!.sentAt,
        }));
    },
    updateThread,
  };
  return {
    port,
    updateThread,
    readThreadFirstSenders,
    item,
    addAccount(accountId: string, address: string, options: { readonly cacheReady: boolean }) {
      accounts.set(accountId, { address, cacheReady: options.cacheReady });
      threads.set(accountId, []);
    },
    setCacheReady(accountId: string) {
      accounts.get(accountId)!.cacheReady = true;
    },
    onNextBackfillRead(hook: () => void) {
      beforeNextBackfillRead = hook;
    },
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
        readonly reply?: boolean;
        readonly fromOwner?: boolean;
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
            isReply: input.reply ?? false,
            fromOwner: input.fromOwner ?? false,
          },
        ],
      });
    },
    addMessage(accountId: string, threadId: string, input: { readonly from: string; readonly at: number }) {
      rowid += 1;
      find(accountId, threadId)!.messages.push({
        rowid,
        from: input.from,
        to: [],
        cc: [],
        sentAt: input.at,
        isReply: true,
        fromOwner: false,
      });
    },
    /** Holds the archive of one thread until released, so a test can act
     *  while that provider call is in flight. */
    holdArchiveOf(threadId: string) {
      let reach!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = updateThread.getMockImplementation()!;
      updateThread.mockImplementation(async (input, signal) => {
        if (input.threadId === threadId && "archive" in input && input.archive) {
          reach();
          await released;
        }
        return original(input, signal);
      });
      return { reached, release };
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

async function createWorld(options: { readonly onEvent?: (event: unknown) => void } = {}) {
  const clock = { now: ENABLED_AT };
  const { store } = await createStore(() => clock.now);
  const mail = createFakeMail({ [ACCOUNT_A]: "Me <me@a.test>", [ACCOUNT_B]: "me@b.test" });
  const screen = new MailSenderScreen({
    store,
    mail: mail.port,
    now: () => clock.now,
    onEvent: options.onEvent,
    backfillWindow: 2,
  });
  return { store, mail, screen, clock };
}

/** A screen whose backfill has run over both accounts, finishing at
 *  BACKFILLED, and whose clock then moves on. */
async function readyWorld(
  options: { readonly onEvent?: (event: unknown) => void } = {},
): Promise<World> {
  const world = await createWorld(options);
  await finishBackfill(world);
  return world;
}

async function finishBackfill(world: World): Promise<void> {
  const resume = Math.max(world.clock.now, LATER + 100);
  world.clock.now = Math.max(world.clock.now, BACKFILLED);
  for (const accountId of [ACCOUNT_A, ACCOUNT_B]) await finishAccount(world, accountId);
  world.clock.now = resume;
}

async function finishAccount(world: World, accountId: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const { hasMore } = await step(world, accountId, false);
    if (!hasMore) return;
  }
  throw new Error("the backfill did not finish");
}

function step(
  world: World,
  accountId: string,
  syncSucceeded: boolean,
): Promise<{ readonly hasMore: boolean }> {
  return world.screen.runBackgroundSenderStep(
    accountId,
    { syncSucceeded },
    new AbortController().signal,
  );
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
