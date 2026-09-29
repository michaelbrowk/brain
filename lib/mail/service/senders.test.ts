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
const block = (address: string, scope: "address" | "domain" = "address") =>
  ({ address, scope, decision: "block" }) as const;
const accept = (address: string, scope: "address" | "domain" = "address") =>
  ({ address, scope, decision: "accept" }) as const;

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
    followsStranger: false,
    sender: "stranger@example.com",
    own: false,
    known: false,
    addressDecision: null,
    domainDecision: null,
  });

  it("gates a first letter from a stranger that arrived after the switch", () => {
    expect(isMailSenderGated(gated)).toBe(true);
  });

  it("gates a stranger's follow-up that answers the stranger's own letter", () => {
    expect(
      isMailSenderGated({ ...gated, startsConversation: false, followsStranger: true }),
    ).toBe(true);
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

  it("answers the standing decision when the same one is made twice, and an undone changed verdict gives the old one back", async () => {
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
    ).rejects.toMatchObject({ code: "mail_sender_decision_changed" });
    // The replaced Block is neither listed nor worked on while the Accept stands.
    expect(world.store.listBlocked(10)).toEqual([]);
    const listing = vi.spyOn(world.mail.port, "listInboxThreadFirstSenders");
    await step(world, ACCOUNT_A, true);
    expect(listing).not.toHaveBeenCalled();
    listing.mockRestore();

    // Undo of an Accept moves nothing: the Block it replaced stands again,
    // under its own id, with its archive where it was.
    const undo = await world.screen.undo(accept.decisionId, { restore: true }, NO_DEADLINE);
    expect(undo.restored).toEqual([]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);
    expect(world.store.listBlocked(10).map((entry) => entry.decisionId)).toEqual([
      first.decisionId,
    ]);
    world.mail.addThread(ACCOUNT_A, { threadId: "t2", from: "news@growth.test", at: LATER + 7 });
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);
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

  it("gates a stranger's follow-up to his own letter, and lets a fresh stranger's reply-shaped letter pass", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_B, {
      threadId: "cold-1",
      from: "rep@sales.test",
      at: LATER + 1,
      messageId: "<cold-1@sales.test>",
    });
    // IMAP keeps one message a thread: the follow-up answers the first letter.
    world.mail.addThread(ACCOUNT_B, {
      threadId: "cold-2",
      from: "Rep <REP@sales.test>",
      at: LATER + 2,
      references: ["<cold-1@sales.test>"],
    });
    // A second follow-up names a letter the cache never saw; the sender
    // still has a letter waiting, so this one waits too.
    world.mail.addThread(ACCOUNT_B, {
      threadId: "cold-3",
      from: "rep@sales.test",
      at: LATER + 3,
      references: ["<unseen@sales.test>"],
    });
    // A fresh stranger with a forged In-Reply-To is the residual the design
    // accepts: nothing in the cache says who they are.
    world.mail.addThread(ACCOUNT_B, {
      threadId: "forged",
      from: "spam@bulk.test",
      at: LATER + 4,
      reply: true,
    });

    expect(await newSenders(world, ACCOUNT_B, ["cold-1", "cold-2", "cold-3", "forged"])).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // An answer to one of the owner's own letters is still an answer.
    world.mail.addThread(ACCOUNT_B, {
      threadId: "owner-letter",
      from: "me@b.test",
      at: LATER + 5,
      messageId: "<owner@b.test>",
      inbox: false,
    });
    world.mail.addThread(ACCOUNT_B, {
      threadId: "answer",
      from: "partner@elsewhere.test",
      at: LATER + 6,
      references: ["<owner@b.test>"],
    });
    expect(await newSenders(world, ACCOUNT_B, ["answer"])).toEqual([false]);
  });

  it("leaves an IMAP letter the owner moved back, though the move gave it a new thread id", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_B, {
      threadId: "uid-10",
      from: "news@growth.test",
      at: LATER,
      messageId: "<issue-1@growth.test>",
    });
    await world.screen.decide(block("news@growth.test"), NO_DEADLINE);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);
    // Moving it back to the Inbox gives it a new UID, so the next sync caches
    // the same message as a new thread.
    world.mail.addThread(ACCOUNT_B, {
      threadId: "uid-11",
      from: "news@growth.test",
      at: LATER,
      messageId: "<issue-1@growth.test>",
    });

    await step(world, ACCOUNT_B, true);

    expect(world.mail.inbox(ACCOUNT_B)).toEqual(["uid-11"]);
    world.mail.addThread(ACCOUNT_B, {
      threadId: "uid-12",
      from: "news@growth.test",
      at: LATER + 1,
      messageId: "<issue-2@growth.test>",
    });
    await step(world, ACCOUNT_B, true);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual(["uid-11"]);
  });

  it("never turns a finished archive back into an intent when the same block walks twice", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "x@growth.test", at: LATER });
    const original = world.mail.updateThread.getMockImplementation()!;
    world.mail.updateThread.mockImplementation(async (input, signal) => {
      if ("archive" in input && input.archive && !world.mail.inbox(ACCOUNT_A).includes(input.threadId)) {
        throw new MailProviderSyncError("mail_provider_thread_stale");
      }
      return original(input, signal);
    });

    const [first] = await Promise.all([
      world.screen.decide(block("x@growth.test"), NO_DEADLINE),
      world.screen.decide(block("x@growth.test"), NO_DEADLINE),
    ]);

    expect(world.store.readArchiveEffects(ACCOUNT_A).byThread.get(`${first.decisionId}/t1`)).toMatchObject({
      state: "done",
    });
    world.mail.updateThread.mockImplementation(original);
    await world.mail.port.updateThread(
      { accountId: ACCOUNT_A, threadId: "t1", archive: false },
      new AbortController().signal,
    );
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["t1"]);
  });

  it("answers an Undo whose time ran out while it waited, and removes nothing", async () => {
    const world = await readyWorld();
    const decision = await world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    world.mail.addThread(ACCOUNT_A, { threadId: "slow", from: "x@growth.test", at: LATER + 1 });
    const hold = world.mail.holdArchiveOf("slow");
    const background = step(world, ACCOUNT_A, true);
    await hold.reached;
    const controller = new AbortController();

    const undo = world.screen.undo(
      decision.decisionId,
      { restore: true },
      { deadlineAt: Number.MAX_SAFE_INTEGER, signal: controller.signal },
    );
    controller.abort();

    await expect(undo).rejects.toMatchObject({ code: "mail_senders_unavailable" });
    hold.release();
    await background;
    expect(world.store.listBlocked(10).map((entry) => entry.decisionId)).toEqual([
      decision.decisionId,
    ]);
  });

  it("writes no intent for an archive whose step was stopped while it waited", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "http", from: "x@growth.test", at: LATER });
    const hold = world.mail.holdArchiveOf("http");
    const decided = world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    await hold.reached;
    world.mail.addThread(ACCOUNT_B, { threadId: "bg", from: "x@growth.test", at: LATER + 1 });
    const controller = new AbortController();
    const background = world.screen
      .runBackgroundSenderStep(ACCOUNT_B, { syncSucceeded: true }, controller.signal)
      .then(
        () => "finished",
        () => "stopped",
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    hold.release();
    await decided;

    expect(await background).toBe("stopped");
    expect(world.store.readArchiveEffects(ACCOUNT_B).byThread.size).toBe(0);
    expect(
      world.mail.updateThread.mock.calls.filter(([input]) => input.threadId === "bg"),
    ).toHaveLength(0);
  });

  it("writes nothing for an archive whose request ran out of time while it waited", async () => {
    const world = await readyWorld();
    await world.screen.decide(block("y@other.test"), NO_DEADLINE);
    world.mail.addThread(ACCOUNT_A, { threadId: "late", from: "x@growth.test", at: LATER });
    world.mail.addThread(ACCOUNT_B, { threadId: "slow", from: "y@other.test", at: LATER });
    const listing = world.mail.holdListOf(ACCOUNT_A);

    // Time enough to start when the block walks its threads, gone by the
    // time the queue frees.
    const deciding = world.screen.decide(block("x@growth.test"), {
      deadlineAt: Date.now() + 1_700,
      signal: new AbortController().signal,
    });
    const hold = world.mail.holdArchiveOf("slow");
    const background = step(world, ACCOUNT_B, true);
    await hold.reached;
    listing.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    hold.release();
    await background;
    const result = await deciding;

    expect(result).toMatchObject({ archived: [], pending: true });
    expect(world.store.readArchiveEffects(ACCOUNT_A).byThread.size).toBe(0);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["late"]);
  });

  it("leaves a finished archive alone when the archiver queued the same thread behind the block", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "x@growth.test", at: LATER });
    const original = world.mail.updateThread.getMockImplementation()!;
    world.mail.updateThread.mockImplementation(async (input, signal) => {
      if ("archive" in input && input.archive && !world.mail.inbox(ACCOUNT_A).includes(input.threadId)) {
        throw new MailProviderSyncError("mail_provider_thread_stale");
      }
      return original(input, signal);
    });
    const hold = world.mail.holdArchiveOf("t1");
    const deciding = world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    await hold.reached;
    // The archiver walks the Inbox while the block's archive is in flight.
    const background = step(world, ACCOUNT_A, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    hold.release();
    const decision = await deciding;
    await background;

    expect(
      world.mail.updateThread.mock.calls.filter(
        ([input]) => input.threadId === "t1" && "archive" in input && input.archive,
      ),
    ).toHaveLength(1);
    expect(world.store.readArchiveEffects(ACCOUNT_A).byThread.get(`${decision.decisionId}/t1`)).toMatchObject({
      state: "done",
    });
  });

  it("has nothing more to do when every blocked letter left in the Inbox is one the owner put back", async () => {
    const world = await readyWorld();
    for (let index = 0; index < 30; index += 1) {
      world.mail.addThread(ACCOUNT_B, {
        threadId: `uid-${index}`,
        from: "news@growth.test",
        at: LATER,
        messageId: `<issue-${index}@growth.test>`,
      });
    }
    await world.screen.decide(block("news@growth.test"), NO_DEADLINE);
    await step(world, ACCOUNT_B, true);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);
    // The owner moves all of them back; IMAP gives each a new UID.
    for (let index = 0; index < 30; index += 1) {
      world.mail.addThread(ACCOUNT_B, {
        threadId: `back-${index}`,
        from: "news@growth.test",
        at: LATER,
        messageId: `<issue-${index}@growth.test>`,
      });
    }
    await finishAccount(world, ACCOUNT_B);

    const next = await step(world, ACCOUNT_B, true);

    expect(next.hasMore).toBe(false);
    expect(world.mail.inbox(ACCOUNT_B)).toHaveLength(30);
  });

  it("has nothing more to do when the letters the owner put back kept their thread and carry no Message-ID", async () => {
    const world = await readyWorld();
    for (let index = 0; index < 30; index += 1) {
      world.mail.addThread(ACCOUNT_A, {
        threadId: `g-${index}`,
        from: "news@growth.test",
        at: LATER,
        messageId: null,
      });
    }
    await world.screen.decide(block("news@growth.test"), NO_DEADLINE);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);
    for (let index = 0; index < 30; index += 1) {
      await world.mail.port.updateThread(
        { accountId: ACCOUNT_A, threadId: `g-${index}`, archive: false },
        new AbortController().signal,
      );
    }
    await finishAccount(world, ACCOUNT_A);

    const next = await step(world, ACCOUNT_A, true);

    expect(next.hasMore).toBe(false);
    expect(world.mail.inbox(ACCOUNT_A)).toHaveLength(30);
  });

  it("leaves an IMAP letter the owner moved back though a letter under another block carries its Message-ID", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_B, {
      threadId: "uid-1",
      from: "a@one.test",
      at: LATER,
      messageId: "<same@one.test>",
    });
    await world.screen.decide(block("a@one.test"), NO_DEADLINE);
    await world.screen.decide(block("b@two.test"), NO_DEADLINE);
    world.mail.addThread(ACCOUNT_B, {
      threadId: "uid-11",
      from: "a@one.test",
      at: LATER,
      messageId: "<same@one.test>",
    });
    world.mail.addThread(ACCOUNT_B, {
      threadId: "uid-12",
      from: "b@two.test",
      at: LATER + 1,
      messageId: "<same@one.test>",
    });

    await step(world, ACCOUNT_B, true);

    expect(world.mail.inbox(ACCOUNT_B)).toEqual(["uid-11"]);
  });

  it("archives a new letter in a thread the owner put back, though another copy was archived with that very date", async () => {
    const world = await readyWorld();
    for (const threadId of ["c1", "c2"]) {
      world.mail.addThread(ACCOUNT_B, {
        threadId,
        from: "news@growth.test",
        at: LATER,
        messageId: "<issue@growth.test>",
      });
    }
    world.mail.addMessage(ACCOUNT_B, "c2", { from: "news@growth.test", at: LATER + 5 });
    await world.screen.decide(block("news@growth.test"), NO_DEADLINE);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);
    await world.mail.port.updateThread(
      { accountId: ACCOUNT_B, threadId: "c1", archive: false },
      new AbortController().signal,
    );
    world.mail.addMessage(ACCOUNT_B, "c1", { from: "news@growth.test", at: LATER + 5 });
    await finishAccount(world, ACCOUNT_B);

    await step(world, ACCOUNT_B, true);

    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);
  });

  it("drops the intent when the provider refuses the archive outright, so an Undo leaves the owner's own archive alone", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "f", from: "x@growth.test", at: LATER });
    world.mail.updateThread.mockImplementationOnce(async () => {
      throw new MailProviderSyncError("mail_provider_mutation_unsupported");
    });
    const decision = await world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    expect(decision.pending).toBe(true);
    expect(world.store.readArchiveEffects(ACCOUNT_A).byThread.size).toBe(0);
    // The owner archives the letter himself.
    await world.mail.port.updateThread(
      { accountId: ACCOUNT_A, threadId: "f", archive: true },
      new AbortController().signal,
    );

    await world.screen.undo(decision.decisionId, { restore: true }, NO_DEADLINE);

    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);
  });

  it("asks again, inside the queue, whether a domain block still speaks for each thread", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "bob", from: "bob@acme.test", at: LATER + 2 });
    world.mail.addThread(ACCOUNT_A, { threadId: "alice", from: "alice@acme.test", at: LATER + 1 });
    const hold = world.mail.holdArchiveOf("bob");
    const domain = world.screen.decide(block("bob@acme.test", "domain"), NO_DEADLINE);
    await hold.reached;
    // Meanwhile the owner writes to alice through Brain: she is known now.
    world.screen.recordSentRecipients({ to: ["alice@acme.test"], cc: [] });
    hold.release();

    const result = await domain;

    expect(result.archived.map((ref) => ref.threadId)).toEqual(["bob"]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["alice"]);
  });

  it("answers the old id of a changed verdict with its own refusal, and an undone block gives back the accept it replaced", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "x@growth.test", at: LATER });
    const blocked = await world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    const accepted = await world.screen.decide(accept("x@growth.test"), NO_DEADLINE);

    await expect(
      world.screen.undo(blocked.decisionId, { restore: true }, NO_DEADLINE),
    ).rejects.toMatchObject({ code: "mail_sender_decision_changed" });

    world.mail.addThread(ACCOUNT_A, { threadId: "t2", from: "y@growth.test", at: LATER });
    await world.screen.decide(accept("y@growth.test"), NO_DEADLINE);
    const blockedY = await world.screen.decide(block("y@growth.test"), NO_DEADLINE);
    await world.screen.undo(blockedY.decisionId, { restore: true }, NO_DEADLINE);
    world.mail.addThread(ACCOUNT_A, { threadId: "t3", from: "y@growth.test", at: LATER + 9 });
    expect(await newSenders(world, ACCOUNT_A, ["t3"])).toEqual([false]);
    expect(world.mail.inbox(ACCOUNT_A)).toContain("t2");
    expect(accepted.decisionId).not.toBe(blocked.decisionId);
  });

  it("treats every account's address as the owner's on every provider, so nothing the owner writes gets stuck", async () => {
    const world = await readyWorld();
    // Say A is the Gmail account. A letter from the owner's other account (B's
    // address) carries no sent mark in A, and must not wait: no decision can
    // be made about an own address, so it could never leave New senders.
    world.mail.addThread(ACCOUNT_A, { threadId: "from-b", from: "Me <me@b.test>", at: LATER });
    // A letter claiming A's own address is not held either; a forgery of it
    // is the provider's spam filter's to catch, as before the screen.
    world.mail.addThread(ACCOUNT_A, { threadId: "claims-a", from: "me@a.test", at: LATER });
    world.mail.addThread(ACCOUNT_B, { threadId: "from-a", from: "me@a.test", at: LATER });

    expect(await newSenders(world, ACCOUNT_A, ["from-b", "claims-a"])).toEqual([false, false]);
    expect(await newSenders(world, ACCOUNT_B, ["from-a"])).toEqual([false]);
    await expect(
      world.screen.decide(block("me@a.test"), NO_DEADLINE),
    ).rejects.toMatchObject({ code: "mail_sender_own_address" });
  });

  it("refuses domain scope for the regional providers too", async () => {
    const world = await readyWorld();
    for (const domain of ["yahoo.co.jp", "hotmail.de", "t-online.de", "seznam.cz", "wp.pl"]) {
      await expect(
        world.screen.decide(block(`someone@${domain}`, "domain"), NO_DEADLINE),
      ).rejects.toMatchObject({ code: "mail_sender_domain_scope_refused" });
    }
  });

  it("tries a pending archive again when the same block is made twice", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "x@growth.test", at: LATER });
    world.mail.updateThread.mockImplementationOnce(async () => {
      throw new Error("socket reset");
    });
    const first = await world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    expect(first).toMatchObject({ archived: [], pending: true });

    const again = await world.screen.decide(block("x@growth.test"), NO_DEADLINE);

    expect(again.archived).toEqual([{ accountId: ACCOUNT_A, threadId: "t1" }]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);
  });

  it("leaves a thread the owner moved back when the same block is made twice", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "x@growth.test", at: LATER });
    await world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    await world.mail.port.updateThread(
      { accountId: ACCOUNT_A, threadId: "t1", archive: false },
      new AbortController().signal,
    );

    const again = await world.screen.decide(block("x@growth.test"), NO_DEADLINE);

    expect(again.archived).toEqual([]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["t1"]);
  });

  it("writes a new intent before re-archiving a thread a newer letter reopened", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "x@growth.test", at: LATER });
    const decision = await world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    await world.mail.port.updateThread(
      { accountId: ACCOUNT_A, threadId: "t1", archive: false },
      new AbortController().signal,
    );
    world.mail.addMessage(ACCOUNT_A, "t1", { from: "x@growth.test", at: LATER + 50 });
    world.mail.updateThread.mockImplementationOnce(async () => {
      throw new Error("socket reset");
    });

    await step(world, ACCOUNT_A, true);

    expect(world.store.readArchiveEffects(ACCOUNT_A).byThread.get(`${decision.decisionId}/t1`)).toMatchObject({
      state: "pending",
      threadLastAt: LATER + 50,
    });
  });

  it("archives both copies of a letter delivered twice, newest first, an hour apart", async () => {
    const world = await readyWorld();
    // The cache answers the Inbox newest first.
    world.mail.addThread(ACCOUNT_B, {
      threadId: "uid-2",
      from: "spam@bulk.test",
      at: LATER + 3_600_000,
      messageId: "<dup@bulk.test>",
    });
    world.mail.addThread(ACCOUNT_B, {
      threadId: "uid-1",
      from: "spam@bulk.test",
      at: LATER,
      messageId: "<dup@bulk.test>",
    });

    await world.screen.decide(block("spam@bulk.test"), NO_DEADLINE);

    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);
  });

  it("archives both copies of a letter delivered twice in the same second, by a block and by the archiver", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_B, { threadId: "uid-1", from: "spam@bulk.test", at: LATER, messageId: "<dup@bulk.test>" });
    world.mail.addThread(ACCOUNT_B, { threadId: "uid-2", from: "spam@bulk.test", at: LATER, messageId: "<dup@bulk.test>" });
    await world.screen.decide(block("spam@bulk.test"), NO_DEADLINE);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);

    world.mail.addThread(ACCOUNT_B, { threadId: "uid-3", from: "spam@bulk.test", at: LATER + 5, messageId: "<dup2@bulk.test>" });
    world.mail.addThread(ACCOUNT_B, { threadId: "uid-4", from: "spam@bulk.test", at: LATER + 5, messageId: "<dup2@bulk.test>" });
    await step(world, ACCOUNT_B, true);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);
  });

  it("archives an older letter that shares a Message-ID with one a domain block already archived", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_B, { threadId: "a1", from: "a@acme.test", at: LATER, messageId: "<m@acme.test>" });
    await world.screen.decide(block("a@acme.test", "domain"), NO_DEADLINE);
    world.mail.addThread(ACCOUNT_B, { threadId: "b1", from: "b@acme.test", at: LATER - 1, messageId: "<m@acme.test>" });

    await step(world, ACCOUNT_B, true);

    expect(world.mail.inbox(ACCOUNT_B)).toEqual([]);
  });

  it("does not take the owner's own reply in a thread he moved back for a newer letter", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "g1", from: "x@growth.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "g2", from: "x@growth.test", at: LATER });
    await world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    for (const threadId of ["g1", "g2"]) {
      await world.mail.port.updateThread(
        { accountId: ACCOUNT_A, threadId, archive: false },
        new AbortController().signal,
      );
    }
    // One reply carries the sent mark, the other only the owner's address.
    world.mail.addMessage(ACCOUNT_A, "g1", { from: "me@a.test", at: LATER + 50, fromOwner: true });
    world.mail.addMessage(ACCOUNT_A, "g2", { from: "Me <me@a.test>", at: LATER + 50 });

    await step(world, ACCOUNT_A, true);

    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["g1", "g2"]);
  });

  it("gives an undone Block the Accept it replaced, with its known entry, and moves back only the Block's own archive", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "x@growth.test", at: LATER });
    const accepted = await world.screen.decide(accept("x@growth.test"), NO_DEADLINE);
    const blocked = await world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual([]);

    const undone = await world.screen.undo(blocked.decisionId, { restore: true }, NO_DEADLINE);

    expect(undone.restored).toEqual([{ accountId: ACCOUNT_A, threadId: "t1" }]);
    expect(world.store.listBlocked(10)).toEqual([]);
    expect(world.store.isKnown("x@growth.test")).toBe(true);
    // The Accept stands again under its own id, and its own Undo still works.
    await world.screen.undo(accepted.decisionId, { restore: true }, NO_DEADLINE);
    expect(world.store.isKnown("x@growth.test")).toBe(false);
  });

  it("goes on past a thread whose sender became known while a domain block walked", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "bob", from: "bob@acme.test", at: LATER + 3 });
    world.mail.addThread(ACCOUNT_A, { threadId: "alice", from: "alice@acme.test", at: LATER + 2 });
    world.mail.addThread(ACCOUNT_A, { threadId: "carol", from: "carol@acme.test", at: LATER + 1 });
    const hold = world.mail.holdArchiveOf("bob");
    const domain = world.screen.decide(block("bob@acme.test", "domain"), NO_DEADLINE);
    await hold.reached;
    world.screen.recordSentRecipients({ to: ["alice@acme.test"], cc: [] });
    hold.release();

    const result = await domain;

    expect(result.archived.map((ref) => ref.threadId)).toEqual(["bob", "carol"]);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["alice"]);
  });

  it("leaves an IMAP letter the owner moved back when the same block is made twice", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_B, { threadId: "uid-10", from: "news@growth.test", at: LATER, messageId: "<i1@growth.test>" });
    await world.screen.decide(block("news@growth.test"), NO_DEADLINE);
    world.mail.addThread(ACCOUNT_B, { threadId: "uid-11", from: "news@growth.test", at: LATER, messageId: "<i1@growth.test>" });

    const again = await world.screen.decide(block("news@growth.test"), NO_DEADLINE);

    expect(again.archived).toEqual([]);
    expect(world.mail.inbox(ACCOUNT_B)).toEqual(["uid-11"]);
  });

  it("answers pending when the client leaves while its block's archive waits", async () => {
    const world = await readyWorld();
    await world.screen.decide(block("y@other.test"), NO_DEADLINE);
    world.mail.addThread(ACCOUNT_B, { threadId: "slowB", from: "y@other.test", at: LATER + 1 });
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "x@growth.test", at: LATER });
    const listing = world.mail.holdListOf(ACCOUNT_A);
    const controller = new AbortController();
    const deciding = world.screen.decide(block("x@growth.test"), {
      deadlineAt: Number.MAX_SAFE_INTEGER,
      signal: controller.signal,
    });
    const hold = world.mail.holdArchiveOf("slowB");
    const background = step(world, ACCOUNT_B, true);
    await hold.reached;
    listing.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const result = await deciding;
    hold.release();
    await background;

    expect(result).toMatchObject({ archived: [], pending: true });
    expect(world.store.listBlocked(10)).toHaveLength(2);
  });

  it("answers pending when the client leaves while an Undo's restore waits, and the scheduler finishes it", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, { threadId: "t1", from: "x@growth.test", at: LATER });
    world.mail.addThread(ACCOUNT_A, { threadId: "t2", from: "x@growth.test", at: LATER });
    const decision = await world.screen.decide(block("x@growth.test"), NO_DEADLINE);
    await world.screen.decide(block("y@other.test"), NO_DEADLINE);
    world.mail.addThread(ACCOUNT_B, { threadId: "slowB", from: "y@other.test", at: LATER + 1 });
    const restoring = world.mail.holdRestoreOf("t1");
    const controller = new AbortController();
    const undoing = world.screen.undo(
      decision.decisionId,
      { restore: true },
      { deadlineAt: Number.MAX_SAFE_INTEGER, signal: controller.signal },
    );
    await restoring.reached;
    // The archiver queues its work behind the first restore, so the second
    // restore waits behind the archiver when the client leaves.
    const archiving = world.mail.holdArchiveOf("slowB");
    const background = step(world, ACCOUNT_B, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    restoring.release();
    await archiving.reached;
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const undo = await undoing;
    archiving.release();
    await background;

    expect(undo).toEqual({
      apiVersion: 1,
      restored: [{ accountId: ACCOUNT_A, threadId: "t1" }],
      pending: true,
    });
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["t1"]);
    await step(world, ACCOUNT_A, true);
    expect(world.mail.inbox(ACCOUNT_A)).toEqual(["t1", "t2"]);
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

  it("names the first sender on a waiting thread and on no other", async () => {
    const world = await readyWorld();
    world.mail.addThread(ACCOUNT_A, {
      threadId: "lena",
      from: "Lena Okafor <Lena@Okafor.Example>",
      at: LATER,
    });
    world.mail.addThread(ACCOUNT_A, {
      threadId: "parcel",
      from: "Parcel <parcel@example.net>",
      at: LATER,
      category: "notification",
    });

    const [lena, parcel] = await world.screen.annotateItems(ACCOUNT_A, [
      world.mail.item(ACCOUNT_A, "lena"),
      // A thread that stopped waiting drops the sender it carried.
      {
        ...world.mail.item(ACCOUNT_A, "parcel"),
        newSender: true,
        newSenderFrom: { name: "Parcel", address: "parcel@example.net" },
      },
    ]);

    // The address as the decision routes will read it: the first message's
    // From, normalized, never a later participant or a Reply-To.
    expect(lena).toMatchObject({
      newSender: true,
      newSenderFrom: { name: "Lena Okafor", address: "lena@okafor.example" },
    });
    expect(parcel!.newSender).toBe(false);
    expect(parcel).not.toHaveProperty("newSenderFrom");
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
  readonly messageId: string | null;
  readonly references: readonly string[];
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
  const listHolds = new Map<string, Promise<void>>();
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
                // The cache keeps the display name apart from the address;
                // the fake's From is one header line, so it splits it here.
                name:
                  first.from === null
                    ? null
                    : (/^\s*(.+?)\s*<[^<>]+>\s*$/.exec(first.from)?.[1] ?? null),
                address: first.from,
                firstMessageAt: first.sentAt,
                startsConversation: !first.isReply,
                fromOwner: first.fromOwner,
                inInbox: thread.inInbox,
                references: first.references,
              },
            ] as const,
          ];
        }),
      ),
  );
  const firstOf = (thread: FakeThread) => thread.messages[0]!;
  const lower = (value: string | null) =>
    value === null ? null : (/<([^<>]+)>\s*$/.exec(value)?.[1] ?? value).trim().toLowerCase();
  const port: MailSenderMailPort = {
    async listAccounts() {
      return [...accounts].map(([accountId, account]) => ({
        accountId,
        address: account.address,
        connected: true,
      }));
    },
    readThreadFirstSenders,
    async readReferencedSenders(accountId, messageIds) {
      return threads
        .get(accountId)!
        .flatMap((thread) => thread.messages)
        .filter(
          (message) =>
            message.messageId !== null &&
            messageIds.includes(message.messageId) &&
            message.from !== null,
        )
        .map((message) => message.from!);
    },
    async hasConversationStart(accountId, input) {
      return threads.get(accountId)!.some((thread) => {
        const first = firstOf(thread);
        return (
          thread.inInbox &&
          thread.category === "people" &&
          !first.isReply &&
          first.sentAt !== null &&
          first.sentAt > input.after &&
          lower(first.from) === input.address
        );
      });
    },
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
    async listInboxThreadFirstSenders(accountId, ownAddresses) {
      const hold = listHolds.get(accountId);
      if (hold !== undefined) {
        listHolds.delete(accountId);
        await hold;
      }
      return threads
        .get(accountId)!
        .filter((thread) => thread.inInbox)
        .map((thread) => {
          const foreign = thread.messages.filter(
            (message) =>
              !message.fromOwner && !ownAddresses.includes(lower(message.from) ?? ""),
          );
          return {
            threadId: thread.threadId,
            address: firstOf(thread).from,
            fromOwner: firstOf(thread).fromOwner,
            lastForeignMessageAt: foreign.length === 0 ? null : foreign.at(-1)!.sentAt,
            firstMessageId: firstOf(thread).messageId,
          };
        });
    },
    updateThread,
  };
  return {
    port,
    updateThread,
    readThreadFirstSenders,
    item,
    addAccount(
      accountId: string,
      address: string,
      options: { readonly cacheReady: boolean },
    ) {
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
        readonly messageId?: string | null;
        readonly references?: readonly string[];
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
            isReply: input.reply ?? (input.references ?? []).length > 0,
            fromOwner: input.fromOwner ?? false,
            messageId:
              input.messageId === undefined ? `<${input.threadId}@fake.test>` : input.messageId,
            references: input.references ?? [],
          },
        ],
      });
    },
    addMessage(
      accountId: string,
      threadId: string,
      input: { readonly from: string; readonly at: number; readonly fromOwner?: boolean },
    ) {
      rowid += 1;
      find(accountId, threadId)!.messages.push({
        rowid,
        from: input.from,
        to: [],
        cc: [],
        sentAt: input.at,
        isReply: true,
        fromOwner: input.fromOwner ?? false,
        messageId: `<${threadId}-${rowid}@fake.test>`,
        references: [],
      });
    },
    /** Holds the move of one thread back to the Inbox until released. */
    holdRestoreOf(threadId: string) {
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
        if (input.threadId === threadId && "archive" in input && !input.archive) {
          reach();
          await released;
        }
        return original(input, signal);
      });
      return { reached, release };
    },
    /** Holds the next Inbox listing of one account until released. */
    holdListOf(accountId: string) {
      let release!: () => void;
      listHolds.set(
        accountId,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return { release };
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
