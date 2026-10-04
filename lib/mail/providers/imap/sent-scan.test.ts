import type { FetchMessageObject, MailboxObject } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoredImapMailAccount } from "../../service/account-types";
import { MailBackgroundSyncScheduler } from "../../service/background-sync";
import type { ImapSessionClient } from "../../service/imapflow-adapter";
import type { MailSentScanResult } from "../../service/senders";
import {
  IMAP_SENT_SCAN_BATCH,
  IMAP_SENT_SCAN_FIRST_RUN_CAP,
  ImapMailSyncAdapter,
} from "./sync-adapter";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";

afterEach(() => {
  vi.useRealTimers();
});

describe("the IMAP Sent-folder envelope scan", () => {
  it("examines the Sent mailbox read-only and asks for envelopes and nothing else", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider } = providerFor(server);

    const result = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    expect(result.envelopeCount).toBe(3);
    // EXAMINE, never SELECT: a read-only lock is what ImapFlow turns into one.
    expect(server.locks).toEqual([{ path: "Sent", readOnly: true }]);
    // ENVELOPE with the UID that orders it: no body, no body structure, no
    // header block, no flags.
    expect(server.fetches.map((fetch) => fetch.query)).toEqual([{ uid: true, envelope: true }]);
    expect(server.forbidden).toEqual([]);
  });

  it("hands over each letter's From with its To and Cc, addresses only, and never reads Bcc", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: [7, 8] } });
    const { provider } = providerFor(server);

    const result = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    // One pair a letter, so the caller can ask of each who wrote it.
    expect(result.envelopes).toEqual([
      { from: "alias7@example.test", recipients: ["to7@example.org", "cc7@example.org"] },
      { from: "alias8@example.test", recipients: ["to8@example.org", "cc8@example.org"] },
    ]);
    expect(JSON.stringify(result)).not.toContain("bcc7");
    expect(JSON.stringify(result)).not.toContain("Display Name");
    // The envelope's Bcc is an accessor in this fixture: it counts each read.
    expect(server.bccReads).toBe(0);
  });

  it("hands over only a letter that says plainly who wrote it", async () => {
    const me = { name: "Me", address: "Me@Example.test" };
    const server = serverFixture({
      sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 8) },
      envelopes: {
        // Two authors again, one of them written so that it is no address:
        // the letter still names two, whatever this adapter can read of them.
        7: { from: [me, { address: "not an address" }], sender: undefined },
        // Two Senders, the first of them the author.
        8: { from: [me], sender: [me, { address: "assistant@example.test" }] },
        // A delegate sent it as the owner: the Sender is somebody else.
        1: { from: [me], sender: [{ address: "assistant@example.test" }] },
        // Two authors, and no Sender to say which of them sent it.
        2: { from: [me, { address: "other@example.test" }], sender: undefined },
        // No author at all.
        3: { from: [], sender: undefined },
        // The Sender repeats the From, as a server fills it in.
        4: { from: [me], sender: [{ name: "Me again", address: "me@example.test" }] },
        // No Sender stated.
        5: { from: [me], sender: undefined },
        // Nobody in To or Cc: a Bcc-only letter teaches nothing.
        6: { from: [me], to: [], cc: [] },
      },
    });
    const { provider } = providerFor(server);

    const result = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    expect(result.envelopeCount).toBe(8);
    expect(result.envelopes).toEqual([
      { from: "me@example.test", recipients: ["to4@example.org", "cc4@example.org"] },
      { from: "me@example.test", recipients: ["to5@example.org", "cc5@example.org"] },
    ]);
    expect(server.bccReads).toBe(0);
  });

  it("walks the folder newest first in bounded batches and resumes from the cursor it handed back", async () => {
    const total = IMAP_SENT_SCAN_BATCH * 2 + 100;
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, total) } });
    const { provider, opened } = providerFor(server);

    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    const second = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));
    const third = scanned(await provider.scanSentEnvelopes({ cursor: second.cursor }, signal()));

    expect(server.fetches.map((fetch) => `${fetch.uid ? "uid " : ""}${fetch.range}`)).toEqual([
      `${total - IMAP_SENT_SCAN_BATCH + 1}:${total}`,
      `101:${total - IMAP_SENT_SCAN_BATCH}`,
      "1:100",
    ]);
    expect([first, second, third].map((step) => step.envelopeCount)).toEqual([
      IMAP_SENT_SCAN_BATCH,
      IMAP_SENT_SCAN_BATCH,
      100,
    ]);
    expect([first, second, third].map((step) => step.hasMore)).toEqual([true, true, false]);
    expect(recipientsOf(first)).toContain(`to${total}@example.org`);
    expect(recipientsOf(third)).toContain("to1@example.org");
    // One session a call: the caller's window is what spaces them.
    expect(opened.count).toBe(3);

    // Nothing new and the walk finished: a session, and no fetch at all.
    const idle = scanned(await provider.scanSentEnvelopes({ cursor: third.cursor }, signal()));
    expect(idle).toMatchObject({ envelopeCount: 0, hasMore: false, cursor: third.cursor });
    expect(server.fetches).toHaveLength(3);
  });

  it("stops the first walk at the cap and leaves the oldest letters unread", async () => {
    const total = IMAP_SENT_SCAN_FIRST_RUN_CAP + 300;
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, total) } });
    const { provider } = providerFor(server);

    let cursor: string | null = null;
    let read = 0;
    let steps = 0;
    for (;;) {
      const result: ScannedResult = scanned(await provider.scanSentEnvelopes({ cursor }, signal()));
      read += result.envelopeCount;
      cursor = result.cursor;
      steps += 1;
      if (!result.hasMore) break;
      expect(steps).toBeLessThan(100);
    }

    expect(read).toBe(IMAP_SENT_SCAN_FIRST_RUN_CAP);
    expect(steps).toBe(IMAP_SENT_SCAN_FIRST_RUN_CAP / IMAP_SENT_SCAN_BATCH);
    // Newest first: the 300 oldest are the ones past the cap.
    expect(server.fetches.at(-1)?.range).toBe(`301:${300 + IMAP_SENT_SCAN_BATCH}`);
    expect(server.fetches.every((fetch) => Number(fetch.range.split(":")[0]) > 300)).toBe(true);
  });

  it("reads only the UIDs above the stored one on a later run, in bounded batches", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 4) } });
    const { provider } = providerFor(server);
    const walked = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    expect(walked.hasMore).toBe(false);
    server.fetches.length = 0;

    server.append("Sent", IMAP_SENT_SCAN_BATCH + 2);
    const next = scanned(await provider.scanSentEnvelopes({ cursor: walked.cursor }, signal()));
    const rest = scanned(await provider.scanSentEnvelopes({ cursor: next.cursor }, signal()));

    expect(server.fetches.map((fetch) => `${fetch.uid ? "uid " : ""}${fetch.range}`)).toEqual([
      `uid 5:${4 + IMAP_SENT_SCAN_BATCH}`,
      `uid ${5 + IMAP_SENT_SCAN_BATCH}:${6 + IMAP_SENT_SCAN_BATCH}`,
    ]);
    // More than a batch is new, so the first asks which UIDs exist; the two
    // that are left fit a batch and are fetched by their range outright.
    expect(server.searches).toEqual(["5:*"]);
    expect(next).toMatchObject({ envelopeCount: IMAP_SENT_SCAN_BATCH, hasMore: true });
    expect(rest).toMatchObject({ envelopeCount: 2, hasMore: false });
    expect(recipientsOf(next)).toContain("to5@example.org");
    expect(recipientsOf(next)).not.toContain("to4@example.org");
  });

  it("reads a letter sent while the first walk is still going before it walks on", async () => {
    const total = IMAP_SENT_SCAN_BATCH + 10;
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, total) } });
    const { provider } = providerFor(server);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    server.append("Sent", 1);
    const fresh = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));
    const tail = scanned(await provider.scanSentEnvelopes({ cursor: fresh.cursor }, signal()));

    expect(recipientsOf(fresh)).toEqual([
      `to${total + 1}@example.org`,
      `cc${total + 1}@example.org`,
    ]);
    expect(fresh.hasMore).toBe(true);
    expect(tail).toMatchObject({ envelopeCount: 10, hasMore: false });
    expect(recipientsOf(tail)).toContain("to1@example.org");
    // One new UID is a range of one: nothing to search for.
    expect(server.searches).toEqual([]);
  });

  it("reads a letter whose UID is far above the cursor in one session, not a window per 250 UIDs", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 4) } });
    const { provider, opened } = providerFor(server);
    const done = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    server.fetches.length = 0;

    // A server that numbers UIDs across the whole account, or a long pause.
    // The newest letter of all came and went, so the folder's next UID is
    // past the last letter it holds.
    server.addSent("Sent", [1, 2, 3, 4, 200_000, 200_007], "\\Sent");
    server.append("Sent", 1);
    server.expunge("Sent", [200_008]);
    const next = scanned(await provider.scanSentEnvelopes({ cursor: done.cursor }, signal()));

    expect(server.searches).toEqual(["5:*"]);
    // The fetch names the letters the search found and no UID beyond them,
    // and having read all the search named is having read to the end.
    expect(server.fetches).toEqual([
      { range: "200000:200007", query: { uid: true, envelope: true }, uid: true },
    ]);
    expect(next).toMatchObject({
      envelopeCount: 2,
      hasMore: false,
      cursor: "s1_500_200008_0_0_0",
    });
    expect(recipientsOf(next)).toContain("to200007@example.org");
    expect(opened.count).toBe(2);
    // The cursor stands at the folder's end, so the next call has nothing.
    const idle = scanned(await provider.scanSentEnvelopes({ cursor: next.cursor }, signal()));
    expect(idle).toMatchObject({ envelopeCount: 0, hasMore: false });
    expect(server.fetches).toHaveLength(1);
  });

  it("steps over a UID range that holds nothing, when a letter came and went above the cursor", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 4) } });
    const { provider } = providerFor(server);
    const done = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    server.fetches.length = 0;

    // A thousand letters were appended and deleted again in another client:
    // UIDNEXT moved, and nothing is there. SEARCH n:* answers the newest
    // letter the folder has, which is below n and is not new.
    server.append("Sent", 1_000);
    server.expunge("Sent", range(5, 1_004));
    const next = scanned(await provider.scanSentEnvelopes({ cursor: done.cursor }, signal()));

    expect(server.searches).toEqual(["5:*"]);
    expect(server.fetches).toEqual([]);
    expect(next).toMatchObject({ envelopeCount: 0, hasMore: false, cursor: "s1_500_1004_0_0_0" });
  });

  it("misses no unread letter when the folder shrinks between two sessions of the walk", async () => {
    const total = IMAP_SENT_SCAN_BATCH + 40;
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, total) } });
    const { provider } = providerFor(server);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    // The owner deletes thirty of the oldest letters in another client, so
    // every sequence number above them moves down.
    server.expunge("Sent", range(1, 30));
    const second = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));

    // The ten that are left and unread, and none of the ones already read.
    expect(second.envelopeCount).toBe(10);
    expect(recipientsOf(second)).toContain("to31@example.org");
    expect(recipientsOf(second)).toContain("to40@example.org");
    expect(recipientsOf(second)).not.toContain("to41@example.org");
    expect(second.hasMore).toBe(false);
  });

  it("loses no letter and reads none twice through expunges and appends all around the walk", async () => {
    const total = 1_000;
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, total) } });
    const { provider } = providerFor(server);
    const seen = new Map<string, number>();
    const expunged = new Set<number>();
    // A fixed pseudo-random sequence, so a failure can be read again.
    let state = 12_345;
    const random = () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    let cursor: string | null = null;
    let top = total;
    for (let window = 0; window < 40; window += 1) {
      const result = await provider.scanSentEnvelopes({ cursor }, signal());
      if (result.status === "unchanged") break;
      const read = scanned(result);
      cursor = read.cursor;
      for (const address of recipientsOf(read)) {
        if (address.startsWith("to")) seen.set(address, (seen.get(address) ?? 0) + 1);
      }
      if (!read.hasMore && window > 10) break;
      if (window < 8) {
        // Between two sessions another client deletes a few letters anywhere
        // in the folder and sends a few more.
        const victims = Array.from({ length: 7 }, () => 1 + Math.floor(random() * top));
        server.expunge("Sent", victims);
        for (const victim of victims) expunged.add(victim);
        server.append("Sent", 3);
        top += 3;
      }
    }

    const missing = range(1, top).filter(
      (uid) => !expunged.has(uid) && !seen.has(`to${uid}@example.org`),
    );
    expect(missing).toEqual([]);
    expect([...seen.values()].filter((count) => count > 1)).toEqual([]);
  });

  it("starts the walk again under a new UIDVALIDITY and says that it did", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider } = providerFor(server);
    const before = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    expect(before.restart).toBeNull();

    server.renumber("Sent", BigInt(901), [50, 51]);
    const after = scanned(await provider.scanSentEnvelopes({ cursor: before.cursor }, signal()));

    expect(after.restart).toBe("uidvalidity_changed");
    expect(after.envelopeCount).toBe(2);
    expect(recipientsOf(after)).toContain("to51@example.org");
    expect(after.cursor).not.toBe(before.cursor);
    // The new cursor is the new folder's: nothing more to read.
    const settled = scanned(await provider.scanSentEnvelopes({ cursor: after.cursor }, signal()));
    expect(settled).toMatchObject({ envelopeCount: 0, restart: null, hasMore: false });
  });

  it("begins again from a cursor it cannot read rather than failing", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: [1] } });
    const { provider } = providerFor(server);

    const result = scanned(await provider.scanSentEnvelopes({ cursor: "not-a-cursor" }, signal()));

    expect(result).toMatchObject({ envelopeCount: 1, restart: null });
  });

  it("finds the folder by a localized name when the server states no attribute", async () => {
    const server = serverFixture({ sent: { path: "Отправленные", uids: [1] } });
    const { provider } = providerFor(server);

    const result = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    expect(result.envelopeCount).toBe(1);
    expect(server.locks).toEqual([{ path: "Отправленные", readOnly: true }]);
  });

  it("answers that there is no Sent mailbox, and does not spend a session to hear it again for ten minutes", async () => {
    const clock = { now: 1_000_000 };
    const server = serverFixture({ sent: null });
    const { provider, opened } = providerFor(server, () => clock.now);

    const first = await provider.scanSentEnvelopes({ cursor: null }, signal());
    const second = await provider.scanSentEnvelopes({ cursor: null }, signal());

    expect(first).toEqual({ status: "unavailable", reason: "no_sent_mailbox" });
    expect(second).toEqual(first);
    expect(opened.count).toBe(1);
    expect(server.locks).toEqual([]);

    // The owner makes the folder in another client; LIST is asked again once
    // the remembered answer is old.
    server.addSent("Sent", [1]);
    clock.now += 10 * 60_000 + 1;
    const later = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    expect(later.envelopeCount).toBe(1);
    expect(opened.count).toBe(2);
  });

  it("answers that the server refused the EXAMINE instead of failing, and rests the same ten minutes", async () => {
    const clock = { now: 1_000_000 };
    const server = serverFixture({
      sent: { path: "Sent", specialUse: "\\Sent", uids: [1] },
      refuseExamine: true,
    });
    const { provider, opened } = providerFor(server, () => clock.now);

    const first = await provider.scanSentEnvelopes({ cursor: null }, signal());
    const second = await provider.scanSentEnvelopes({ cursor: null }, signal());

    expect(first).toEqual({ status: "unavailable", reason: "examine_refused" });
    expect(second).toEqual(first);
    expect(opened.count).toBe(1);
    expect(server.fetches).toEqual([]);

    server.allowExamine();
    clock.now += 10 * 60_000 + 1;
    expect(scanned(await provider.scanSentEnvelopes({ cursor: null }, signal())).envelopeCount).toBe(1);
  });

  it("leaves a dropped connection a failure, so the next window asks again", async () => {
    const server = serverFixture({
      sent: { path: "Sent", specialUse: "\\Sent", uids: [1] },
      dropOnExamine: true,
    });
    const { provider, opened } = providerFor(server);

    await expect(provider.scanSentEnvelopes({ cursor: null }, signal())).rejects.toMatchObject({
      code: "mail_provider_unavailable",
    });
    await expect(provider.scanSentEnvelopes({ cursor: null }, signal())).rejects.toMatchObject({
      code: "mail_provider_unavailable",
    });
    expect(opened.count).toBe(2);
  });

  it("keeps to the budget section 11 of the architecture states", () => {
    expect(IMAP_SENT_SCAN_BATCH).toBe(250);
    expect(IMAP_SENT_SCAN_FIRST_RUN_CAP).toBe(5_000);
  });

  it("counts the cap by the envelopes asked for, so letters that slid back into the walk do not stretch it", async () => {
    const total = IMAP_SENT_SCAN_FIRST_RUN_CAP + 300;
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, total) } });
    const { provider } = providerFor(server);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    // A hundred of the oldest go, so the next range holds a hundred letters
    // the walk has read already and only 150 it has not.
    server.expunge("Sent", range(1, 100));
    let cursor = first.cursor;
    let steps = 1;
    for (;;) {
      const result: ScannedResult = scanned(await provider.scanSentEnvelopes({ cursor }, signal()));
      cursor = result.cursor;
      steps += 1;
      if (!result.hasMore) break;
      expect(steps).toBeLessThan(100);
    }

    const asked = server.fetches.reduce((sum, fetch) => {
      const [low, high] = fetch.range.split(":").map(Number) as [number, number];
      return sum + high - low + 1;
    }, 0);
    expect(asked).toBe(IMAP_SENT_SCAN_FIRST_RUN_CAP);
    expect(steps).toBe(IMAP_SENT_SCAN_FIRST_RUN_CAP / IMAP_SENT_SCAN_BATCH);
  });

  it("begins again from a cursor whose walk claims more than the cursor has read", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider } = providerFor(server);

    // The walk's ceiling is above the highest UID read plus one: no scan of
    // this folder wrote that. Taken at its word it would walk two letters.
    const result = scanned(await provider.scanSentEnvelopes({ cursor: "s1_500_3_2_10_2" }, signal()));

    expect(result).toMatchObject({ envelopeCount: 3, restart: null, cursor: "s1_500_3_0_0_0" });
  });

  it("begins again when the folder's next UID is below one the cursor has read", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider } = providerFor(server);

    // A restored mailbox under the same UIDVALIDITY: the cursor stands at
    // UID 90 and the folder's next UID is 4, so nothing above the cursor
    // would ever be read.
    const result = scanned(await provider.scanSentEnvelopes({ cursor: "s1_500_90_0_0_0" }, signal()));

    expect(result).toMatchObject({
      envelopeCount: 3,
      restart: "uidnext_regressed",
      cursor: "s1_500_3_0_0_0",
    });
    // A cursor that stands exactly at the end is not a regression.
    const settled = scanned(await provider.scanSentEnvelopes({ cursor: result.cursor }, signal()));
    expect(settled).toMatchObject({ envelopeCount: 0, restart: null });
    // One that stands on the folder's next UID is: no letter has that UID
    // yet, so the cursor read it in a folder that is not this one, and the
    // letter that takes the UID next would never be read.
    const boundary = scanned(await provider.scanSentEnvelopes({ cursor: "s1_500_4_0_0_0" }, signal()));
    expect(boundary).toMatchObject({
      envelopeCount: 3,
      restart: "uidnext_regressed",
      cursor: "s1_500_3_0_0_0",
    });
  });

  it("steps over a FETCH response that carries no envelope", async () => {
    // Another client set a flag while the fetch ran, and the server told this
    // session so in the middle of the answer.
    const server = serverFixture({
      sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) },
      flagUpdates: true,
    });
    const { provider } = providerFor(server);

    const walked = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    server.append("Sent", 1);
    const fresh = scanned(await provider.scanSentEnvelopes({ cursor: walked.cursor }, signal()));

    expect(walked).toMatchObject({ envelopeCount: 3, hasMore: false });
    expect(fresh).toMatchObject({ envelopeCount: 1, hasMore: false });
  });
});

/*
  One envelope a session cannot read (a line past the session's 64 KiB limit,
  which a Bcc blast reaches without the adapter ever reading Bcc, or a server
  too slow for the deadline) used to hold the scan at its batch for good, and
  every later letter with it. A batch that fails is asked for again at half
  its width, down to one message, and that one is passed over and counted.
*/
describe("a Sent-folder batch that cannot be read", () => {
  it("narrows the walk to the one letter, passes it over, and reads every other", async () => {
    const total = 600;
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, total) } });
    const { provider } = providerFor(server);
    server.failFetchOf(420);

    const read = new Set<string>();
    const outcomes: string[] = [];
    let skipped = 0;
    let cursor: string | null = null;
    for (let window = 0; window < 40; window += 1) {
      const result = await provider.scanSentEnvelopes({ cursor }, signal());
      outcomes.push(result.status);
      if (result.status !== "scanned") continue;
      cursor = result.cursor;
      skipped += result.skippedCount;
      for (const address of recipientsOf(result)) read.add(address);
      if (result.skippedCount > 0) expect(result.skipReason).toBe("envelope_unreadable");
      if (!result.hasMore) break;
    }

    expect(outcomes.at(-1)).toBe("scanned");
    expect(skipped).toBe(1);
    expect(read.has("to420@example.org")).toBe(false);
    for (const uid of [1, 419, 421, 600]) expect(read.has(`to${uid}@example.org`)).toBe(true);
    expect(read.size).toBe((total - 1) * 2);
    // Halving finds it in a few windows, not in one a letter: seven halvings,
    // then the letter by itself fails twice more before it is passed over.
    expect(outcomes.filter((status) => status === "batch_failed").length).toBeLessThanOrEqual(10);
    expect(outcomes.length).toBeLessThanOrEqual(20);
    // The failed batch was asked for again at half its width, never whole.
    expect(server.fetches.filter((fetch) => fetch.range === "351:600")).toHaveLength(1);
    // The letter by itself was asked for three times before it was given up.
    expect(server.fetches.filter((fetch) => fetch.range === "420:420")).toHaveLength(3);
  });

  it("does not pass a letter over for one dropped connection", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider } = providerFor(server);
    const done = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    // The owner sends one letter from his phone, and the connection drops
    // once in the middle of its fetch. In the steady state a batch is one
    // letter, so a batch of one that fails says nothing about the letter.
    server.append("Sent", 1);
    server.failFetchOf(4);
    await expect(
      provider.scanSentEnvelopes({ cursor: done.cursor }, signal()),
    ).resolves.toEqual({ status: "batch_failed" });
    server.failFetchOf(null);
    const next = scanned(await provider.scanSentEnvelopes({ cursor: done.cursor }, signal()));

    expect(next).toMatchObject({ envelopeCount: 1, skippedCount: 0, hasMore: false });
    expect(recipientsOf(next)).toContain("to4@example.org");
  });

  it("passes a letter over on its third failure running, and starts the count again after a read", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider } = providerFor(server);
    const done = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    const failed = { status: "batch_failed" };

    server.append("Sent", 1);
    server.failFetchOf(4);
    await expect(provider.scanSentEnvelopes({ cursor: done.cursor }, signal())).resolves.toEqual(failed);
    await expect(provider.scanSentEnvelopes({ cursor: done.cursor }, signal())).resolves.toEqual(failed);
    const third = scanned(await provider.scanSentEnvelopes({ cursor: done.cursor }, signal()));
    expect(third).toMatchObject({
      envelopeCount: 0,
      skippedCount: 1,
      skipReason: "envelope_unreadable",
      cursor: "s1_500_4_0_0_0",
    });

    // Two failures, a read, and two more failures: no letter has failed
    // three times running, so none is passed over.
    server.append("Sent", 1);
    server.failFetchOf(5);
    await expect(provider.scanSentEnvelopes({ cursor: third.cursor }, signal())).resolves.toEqual(failed);
    await expect(provider.scanSentEnvelopes({ cursor: third.cursor }, signal())).resolves.toEqual(failed);
    server.failFetchOf(null);
    const read = scanned(await provider.scanSentEnvelopes({ cursor: third.cursor }, signal()));
    expect(read).toMatchObject({ envelopeCount: 1, skippedCount: 0 });
    server.append("Sent", 1);
    server.failFetchOf(6);
    await expect(provider.scanSentEnvelopes({ cursor: read.cursor }, signal())).resolves.toEqual(failed);
    await expect(provider.scanSentEnvelopes({ cursor: read.cursor }, signal())).resolves.toEqual(failed);
    server.failFetchOf(null);
    expect(
      scanned(await provider.scanSentEnvelopes({ cursor: read.cursor }, signal())),
    ).toMatchObject({ envelopeCount: 1, skippedCount: 0, cursor: "s1_500_6_0_0_0" });
  });

  it("does the same above the cursor: one fat new letter does not hold the ones sent after it", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider } = providerFor(server);
    const done = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    server.append("Sent", 6);
    server.failFetchOf(4);

    let cursor = done.cursor;
    let learned = 0;
    let skipped = 0;
    let windows = 0;
    for (; windows < 12; windows += 1) {
      const result = await provider.scanSentEnvelopes({ cursor }, signal());
      if (result.status !== "scanned") continue;
      cursor = result.cursor;
      learned += result.envelopeCount;
      skipped += result.skippedCount;
      if (!result.hasMore) break;
    }

    expect(learned).toBe(5);
    expect(skipped).toBe(1);
    expect(cursor).toBe("s1_500_9_0_0_0");
    expect(windows).toBeLessThanOrEqual(6);
  });

  it("names the session's line limit when that is what the letter ran into", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: [1] } });
    const { provider } = providerFor(server);
    server.failFetchOf(1, { code: "LineTooLarge" });

    const result = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    // One letter in the folder is a batch of one: passed over at once.
    expect(result).toMatchObject({
      envelopeCount: 0,
      skippedCount: 1,
      skipReason: "envelope_line_too_long",
      hasMore: false,
      cursor: "s1_500_1_0_0_0",
    });
  });

  it("takes a page with more envelopes than it asked for as a batch it could not read, on the walk and above the cursor", async () => {
    const walking = serverFixture({
      sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) },
      overAnswer: true,
    });
    await expect(
      providerFor(walking).provider.scanSentEnvelopes({ cursor: null }, signal()),
    ).resolves.toEqual({ status: "batch_failed" });

    const above = serverFixture({
      sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 5) },
      overAnswer: true,
    });
    await expect(
      providerFor(above).provider.scanSentEnvelopes({ cursor: "s1_500_3_0_0_0" }, signal()),
    ).resolves.toEqual({ status: "batch_failed" });
    expect(above.fetches.at(-1)).toMatchObject({ range: "4:5", uid: true });
  });

  it("reads new mail by plain UID range once the search for it could not be read", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 4) } });
    const { provider } = providerFor(server);
    const done = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    server.fetches.length = 0;
    server.append("Sent", IMAP_SENT_SCAN_BATCH + 2);
    server.failSearch();

    await expect(
      provider.scanSentEnvelopes({ cursor: done.cursor }, signal()),
    ).resolves.toEqual({ status: "batch_failed" });
    const next = scanned(await provider.scanSentEnvelopes({ cursor: done.cursor }, signal()));

    // A search answer too long for a line means thousands of letters are
    // new, and then their UIDs are dense: a range a batch wide is as good.
    expect(server.searches).toEqual(["5:*"]);
    expect(server.fetches).toEqual([
      { range: `5:${4 + IMAP_SENT_SCAN_BATCH}`, query: { uid: true, envelope: true }, uid: true },
    ]);
    expect(next).toMatchObject({ envelopeCount: IMAP_SENT_SCAN_BATCH, hasMore: true });
  });

  it("goes on by UID range after a search it could not read, and does not ask it again a batch", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 4) } });
    const { provider } = providerFor(server);
    const done = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    // Two thousand letters are new, and the answer naming them never fits.
    server.append("Sent", 2_000);
    server.failSearch();

    let cursor = done.cursor;
    const windows: string[] = [];
    for (let window = 0; window < 40; window += 1) {
      const result = await provider.scanSentEnvelopes({ cursor }, signal());
      windows.push(result.status === "scanned" ? `read ${result.envelopeCount}` : result.status);
      if (result.status !== "scanned") continue;
      cursor = result.cursor;
      if (!result.hasMore) break;
    }

    // One window lost to the search, and then a batch a window: the search
    // used to be asked again before every batch, and to fail every time.
    expect(windows).toEqual(["batch_failed", ...Array.from({ length: 8 }, () => "read 250")]);
    expect(server.searches).toEqual(["5:*"]);
  });

  it("asks the search again once a range read that way held nothing", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 4) } });
    const { provider } = providerFor(server);
    const done = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    server.fetches.length = 0;
    // Six hundred UIDs above the cursor and four letters at the top of them:
    // here the search failed for the connection's sake, not for its length.
    server.append("Sent", 600);
    server.expunge("Sent", range(5, 600));
    server.failSearch();
    await expect(
      provider.scanSentEnvelopes({ cursor: done.cursor }, signal()),
    ).resolves.toEqual({ status: "batch_failed" });
    server.failSearch(false);

    const empty = scanned(await provider.scanSentEnvelopes({ cursor: done.cursor }, signal()));
    const read = scanned(await provider.scanSentEnvelopes({ cursor: empty.cursor }, signal()));

    expect(empty).toMatchObject({ envelopeCount: 0, hasMore: true });
    expect(read).toMatchObject({ envelopeCount: 4, hasMore: false });
    expect(server.searches).toEqual(["5:*", "255:*"]);
    expect(server.fetches.map((fetch) => fetch.range)).toEqual(["5:254", "601:604"]);
  });

  it("passes over one letter and no more when the search named fewer letters than there are", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 4) } });
    const { provider } = providerFor(server);
    const done = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    server.fetches.length = 0;
    // Three hundred letters are new. The server's search names one of them,
    // and that one is past the session's line limit.
    server.append("Sent", 300);
    server.searchAnswers([5]);
    server.failFetchOf(5, { code: "LineTooLarge" });

    const skipped = scanned(await provider.scanSentEnvelopes({ cursor: done.cursor }, signal()));

    // The fetch asks for the letter the search named and nothing beside it,
    // and passing it over moves the cursor past that one UID: it used to go
    // to the folder's end, and 299 letters nobody had tried went with it.
    expect(server.fetches.map((fetch) => fetch.range)).toEqual(["5:5"]);
    expect(skipped).toMatchObject({
      envelopeCount: 0,
      skippedCount: 1,
      cursor: "s1_500_5_0_0_0",
      hasMore: true,
    });
    server.searchAnswers(null);
    const next = scanned(await provider.scanSentEnvelopes({ cursor: skipped.cursor }, signal()));
    expect(next.envelopeCount).toBe(IMAP_SENT_SCAN_BATCH);
    expect(recipientsOf(next)).toContain("to6@example.org");
  });

  it("does not narrow for a stop, or for a session that failed before it asked for anything", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 300) } });
    const { provider } = providerFor(server);
    const stop = new AbortController();
    server.failFetchOf(300, { before: () => stop.abort() });

    await expect(provider.scanSentEnvelopes({ cursor: null }, stop.signal)).rejects.toBeDefined();
    server.failFetchOf(null);
    server.dropNextExamine();
    await expect(provider.scanSentEnvelopes({ cursor: null }, signal())).rejects.toMatchObject({
      code: "mail_provider_unavailable",
    });
    const result = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    expect(result.envelopeCount).toBe(IMAP_SENT_SCAN_BATCH);
    expect(server.fetches.map((fetch) => fetch.range)).toEqual(["51:300", "51:300"]);
  });
});

/*
  A scan session is a login, and a quiet Sent folder used to cost one a
  window for nothing: sixty an hour beside the sync's sixty. The sync's own
  session now asks the folder's STATUS on its way, and a scan opens a session
  only when that answer differs from its cursor or its first walk is not over.
*/
describe("what a quiet Sent folder costs its host", () => {
  async function syncing(
    server: ReturnType<typeof serverFixture>,
    now?: () => number,
    remainingMs?: () => number,
  ) {
    const made = providerFor(server, now, remainingMs);
    const anchor = await made.provider.getSyncAnchor(signal());
    const pass = () =>
      made.provider.listChanges(
        { startHistoryId: anchor, pageToken: null, maxItems: 5 },
        signal(),
      );
    return { ...made, pass };
  }

  it("opens no session of its own while nothing is sent, and one when something is", async () => {
    const clock = { now: 1_000_000 };
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server, () => clock.now);

    // Nobody has asked for a scan yet, so the sync asks nothing about Sent.
    await pass();
    expect(server.statuses).toEqual([]);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    expect(server.sessionsOf("Sent")).toBe(1);

    for (let minute = 0; minute < 60; minute += 1) {
      clock.now += 60_000;
      await pass();
      await expect(
        provider.scanSentEnvelopes({ cursor: first.cursor }, signal()),
      ).resolves.toEqual({ status: "unchanged" });
    }
    // An hour: sixty STATUS answers on the sync's sessions, and the scan's
    // one session is still the first. LIST was asked again on a sync session
    // each time its ten minutes ran out, never on a session of the scan's.
    expect(server.statuses).toEqual(Array.from({ length: 60 }, () => "Sent"));
    expect(server.sessionsOf("Sent")).toBe(1);
    expect(server.lists).toBe(6);

    // A letter is sent from the phone: the next sync sees UIDNEXT move, and
    // the scan after it opens a session and reads it.
    server.append("Sent", 1);
    clock.now += 60_000;
    await pass();
    const next = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));
    expect(next).toMatchObject({ envelopeCount: 1, hasMore: false });
    expect(recipientsOf(next)).toContain("to4@example.org");
    expect(server.sessionsOf("Sent")).toBe(2);
  });

  it("goes on walking while the first walk is unfinished, whatever the STATUS says", async () => {
    const total = IMAP_SENT_SCAN_BATCH + 10;
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, total) } });
    const { provider, pass } = await syncing(server);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    expect(first.hasMore).toBe(true);

    await pass();
    const second = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));

    expect(second).toMatchObject({ envelopeCount: 10, hasMore: false });
  });

  it("opens a session when the STATUS names another UIDVALIDITY or a next UID below the cursor", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    server.renumber("Sent", BigInt(901), [1, 2, 3]);
    await pass();
    const renumbered = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));
    expect(renumbered.restart).toBe("uidvalidity_changed");

    await pass();
    const regressed = scanned(
      await provider.scanSentEnvelopes({ cursor: "s1_901_90_0_0_0" }, signal()),
    );
    expect(regressed.restart).toBe("uidnext_regressed");
  });

  it("takes each STATUS once: a second scan without a sync in between does not trust the old answer", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    await pass();
    await expect(
      provider.scanSentEnvelopes({ cursor: first.cursor }, signal()),
    ).resolves.toEqual({ status: "unchanged" });

    // Sent after that STATUS was taken, and no sync has run since.
    server.append("Sent", 1);
    const next = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));

    expect(next.envelopeCount).toBe(1);
  });

  it("rests a quiet folder ten minutes after an empty scan when the sync's session cannot carry the STATUS", async () => {
    const clock = { now: 1_000_000 };
    const server = serverFixture({
      sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) },
      refuseStatus: true,
    });
    const { provider, pass } = await syncing(server, () => clock.now);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    // The server answers the STATUS with NO. The sync is not failed by it,
    // and does not ask again for ten minutes.
    await pass();
    await pass();
    expect(server.statuses).toEqual(["Sent"]);

    // With no STATUS to go by, the scan opens a session, finds nothing, and
    // then leaves the folder alone for ten minutes.
    const empty = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));
    expect(empty).toMatchObject({ envelopeCount: 0, hasMore: false });
    expect(server.sessionsOf("Sent")).toBe(2);
    for (let minute = 1; minute <= 9; minute += 1) {
      clock.now += 60_000;
      await pass();
      await expect(
        provider.scanSentEnvelopes({ cursor: empty.cursor }, signal()),
      ).resolves.toEqual({ status: "unchanged" });
    }
    expect(server.sessionsOf("Sent")).toBe(2);

    server.append("Sent", 1);
    clock.now += 60_000 + 1;
    await pass();
    const late = scanned(await provider.scanSentEnvelopes({ cursor: empty.cursor }, signal()));
    expect(late.envelopeCount).toBe(1);
    expect(server.sessionsOf("Sent")).toBe(3);
  });

  it("never fails a sync over the Sent folder's STATUS", async () => {
    const server = serverFixture({
      sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) },
      statusThrows: true,
    });
    const { provider, pass } = await syncing(server);
    await provider.scanSentEnvelopes({ cursor: null }, signal());

    await expect(pass()).resolves.toMatchObject({ changedThreadIds: [] });
    expect(server.statuses).toEqual(["Sent"]);
  });

  /*
    A session is one race against its deadline, and everything asked on it is
    inside that race. A STATUS the server never answers used to hold the
    session until the deadline took it, and the Inbox page that was already
    complete went with it: the Sent folder failed the Inbox sync.
  */
  it("hands the Inbox page back when the Sent STATUS is never answered, and rests the STATUS ten minutes", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server, () => Date.now());
    await provider.scanSentEnvelopes({ cursor: null }, signal());
    server.hangStatus();

    let settled: string | null = null;
    const page = pass().then(
      (value) => {
        settled = "resolved";
        return value;
      },
      (error: unknown) => {
        settled = "rejected";
        throw error;
      },
    );
    await vi.advanceTimersByTimeAsync(1_400);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe("resolved");
    await expect(page).resolves.toMatchObject({ changedThreadIds: [] });

    // A timeout is a refusal: the next syncs do not ask, the scan goes by
    // its own quiet window, and after ten minutes the sync asks again.
    await pass();
    expect(server.statuses).toEqual(["Sent"]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const later = pass();
    await vi.advanceTimersByTimeAsync(1_600);
    await later;
    expect(server.statuses).toEqual(["Sent", "Sent"]);
  });

  it("gives the LIST refresh that rides with the STATUS the same short wait", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server, () => Date.now());
    await provider.scanSentEnvelopes({ cursor: null }, signal());
    // LIST's ten minutes run out, and the server stalls on the next one.
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    server.hangList();

    const page = pass();
    await vi.advanceTimersByTimeAsync(1_600);

    await expect(page).resolves.toMatchObject({ changedThreadIds: [] });
    expect(server.statuses).toEqual([]);
  });

  it("asks no STATUS on a session with too little of its time left, and holds nothing against the server for it", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const left = { ms: 10_000 };
    const { provider, pass } = await syncing(server, undefined, () => left.ms);
    await provider.scanSentEnvelopes({ cursor: null }, signal());

    // The Inbox page took nearly all the session had.
    left.ms = 600;
    await pass();
    expect(server.statuses).toEqual([]);
    // Not a refusal: the next session, with time to spare, asks.
    left.ms = 9_000;
    await pass();
    expect(server.statuses).toEqual(["Sent"]);
  });

  it("caps the wait for the STATUS by what the session has left", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server, () => Date.now(), () => 1_200);
    await provider.scanSentEnvelopes({ cursor: null }, signal());
    server.hangStatus();

    let settled = false;
    const page = pass().then((value) => {
      settled = true;
      return value;
    });
    // 1,200 ms left, half a second kept back for the session to close in.
    await vi.advanceTimersByTimeAsync(750);
    expect(settled).toBe(true);
    await page;
  });

  it("asks the STATUS only after the page's own work, and not at all for a page that failed", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server);
    await provider.scanSentEnvelopes({ cursor: null }, signal());
    server.wire.length = 0;

    await pass();
    expect(server.wire).toEqual(["examine INBOX", "status Sent"]);

    // A cursor of another UIDVALIDITY: the page is refused before anything
    // is read, and nothing is asked about Sent on the way out.
    server.wire.length = 0;
    server.renumber("INBOX", BigInt(78), []);
    await expect(pass()).rejects.toMatchObject({ code: "mail_provider_cursor_invalid" });
    expect(server.wire).toEqual(["examine INBOX"]);
  });

  it("stops asking the STATUS two hours after the screen last asked for a scan", async () => {
    const clock = { now: 1_000_000 };
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server, () => clock.now);
    await provider.scanSentEnvelopes({ cursor: null }, signal());

    // The screen is switched off: no scan is asked for any more.
    clock.now += 2 * 60 * 60_000;
    await pass();
    expect(server.statuses).toEqual(["Sent"]);
    clock.now += 1;
    await pass();
    await pass();
    expect(server.statuses).toEqual(["Sent"]);
  });

  it("takes a mailbox list too long to read as an answer, and opens no session a window to hear it again", async () => {
    const clock = { now: 1_000_000 };
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    server.crowd(300);
    const { provider, pass, opened } = await syncing(server, () => clock.now);
    const before = opened.count;

    const answers: MailSentScanResult[] = [];
    for (let minute = 0; minute < 10; minute += 1) {
      await pass();
      answers.push(await provider.scanSentEnvelopes({ cursor: null }, signal()));
      clock.now += 60_000;
    }

    expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(
      new Set([JSON.stringify({ status: "unavailable", reason: "mailbox_list_unsupported" })]),
    );
    // Ten syncs, and one session of the scan's to hear the answer.
    expect(opened.count - before).toBe(11);
    expect(server.lists).toBe(1);
    expect(server.sessionsOf("Sent")).toBe(0);

    // When the answer is old, LIST is asked again on a session of the
    // sync's. The owner has tidied his folders meanwhile, and the scan reads.
    server.crowd(10);
    clock.now += 60_000;
    await pass();
    expect(server.lists).toBe(2);
    expect(
      scanned(await provider.scanSentEnvelopes({ cursor: null }, signal())).envelopeCount,
    ).toBe(3);
  });

  it("opens one session every six hours whatever the STATUS says, for a server whose STATUS is stale", async () => {
    const clock = { now: 1_000_000 };
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server, () => clock.now);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    // This server's STATUS answers from a cache it does not refresh: a
    // letter is sent, and UIDNEXT stays where it was.
    server.freezeStatus("Sent");
    server.append("Sent", 1);
    for (let minute = 1; minute < 6 * 60; minute += 1) {
      clock.now += 60_000;
      await pass();
      await expect(
        provider.scanSentEnvelopes({ cursor: first.cursor }, signal()),
      ).resolves.toEqual({ status: "unchanged" });
    }
    expect(server.sessionsOf("Sent")).toBe(1);

    clock.now += 60_000;
    await pass();
    const net = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));
    expect(net).toMatchObject({ envelopeCount: 1, hasMore: false });
    expect(recipientsOf(net)).toContain("to4@example.org");
    expect(server.sessionsOf("Sent")).toBe(2);

    // The STATUS still says what it said, and against the new cursor that
    // reads as a change. The session it sends the scan into finds the folder
    // where the cursor left it, so the STATUS is rested: a stale answer
    // costs a session in ten minutes, not one a window.
    const asked = server.statuses.length;
    for (let minute = 0; minute < 10; minute += 1) {
      clock.now += 60_000;
      await pass();
      await provider.scanSentEnvelopes({ cursor: net.cursor }, signal());
    }
    expect(server.sessionsOf("Sent")).toBe(3);
    expect(server.statuses.length).toBe(asked + 1);
  });

  it("goes back to the STATUS after its six-hourly session, and holds nothing against a STATUS that was right", async () => {
    const clock = { now: 1_000_000 };
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider, pass } = await syncing(server, () => clock.now);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    // An hour at a time, so the screen never stops asking; the last step
    // ends a millisecond short of the six hours.
    const hour = 60 * 60_000;
    for (const step of [hour, hour, hour, hour, hour, hour - 1]) {
      clock.now += step;
      await pass();
      await expect(
        provider.scanSentEnvelopes({ cursor: first.cursor }, signal()),
      ).resolves.toEqual({ status: "unchanged" });
    }
    clock.now += 1;
    await pass();
    const net = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));
    expect(net).toMatchObject({ envelopeCount: 0, hasMore: false });
    expect(server.sessionsOf("Sent")).toBe(2);

    // The six hours begin again from that session, and the sync goes on
    // asking the STATUS: a letter sent a minute later is read a window later.
    const asked = server.statuses.length;
    server.append("Sent", 1);
    clock.now += 60_000;
    await pass();
    expect(server.statuses.length).toBe(asked + 1);
    expect(
      scanned(await provider.scanSentEnvelopes({ cursor: net.cursor }, signal())).envelopeCount,
    ).toBe(1);
    clock.now += 60_000;
    await pass();
    await expect(
      provider.scanSentEnvelopes({ cursor: "s1_500_4_0_0_0" }, signal()),
    ).resolves.toEqual({ status: "unchanged" });
    expect(server.sessionsOf("Sent")).toBe(3);
  });

  it("costs a quiet account its sync's logins and one more in an hour, at the default interval and at the floor", async () => {
    for (const intervalMs of [60_000, 5_000]) {
      vi.useFakeTimers({ now: 0 });
      const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
      const { provider, pass } = await syncing(server, () => Date.now());
      let cursor: string | null = null;
      const scheduler = new MailBackgroundSyncScheduler(
        {
          listAccountIds: async () => [ACCOUNT_ID],
          listSyncAccounts: async () => [{ accountId: ACCOUNT_ID, providerKind: "imap" }],
          runBackgroundSyncStep: async () => {
            await pass();
            return {
              result: { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false },
              hasMore: false,
            };
          },
        },
        {
          initialDelayMs: 10,
          intervalMs,
          gmailIntervalMs: 5_000,
          senders: {
            async runBackgroundSenderStep() {
              return { hasMore: false };
            },
            async runBackgroundSentScanStep(_accountId, stop) {
              const result = await provider.scanSentEnvelopes({ cursor }, stop);
              if (result.status === "scanned") cursor = result.cursor;
            },
          },
        },
      );
      try {
        scheduler.start();
        await vi.advanceTimersByTimeAsync(3_600_000);
      } finally {
        await scheduler.stop();
        vi.useRealTimers();
      }

      // The anchor's session, then one a sync; and the scan's first, which
      // walked the folder. Before the STATUS rode on the sync it was one
      // more login a window: 60 an hour here, and 720 at the floor.
      expect(server.sessionsOf("INBOX")).toBe(1 + 3_600_000 / intervalMs);
      expect(server.sessionsOf("Sent")).toBe(1);
    }
  });
});

type ScannedResult = Extract<MailSentScanResult, { readonly status: "scanned" }>;

function scanned(result: MailSentScanResult): ScannedResult {
  if (result.status !== "scanned") {
    throw new Error(`the scan answered ${JSON.stringify(result)}`);
  }
  return result;
}

function recipientsOf(result: ScannedResult): string[] {
  return result.envelopes.flatMap((envelope) => [...envelope.recipients]);
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_value, index) => first + index);
}

interface FakeAddress {
  readonly name?: string;
  readonly address: string;
}

interface FakeEnvelope {
  from: FakeAddress[];
  sender: FakeAddress[] | undefined;
  to: FakeAddress[];
  cc: FakeAddress[];
}

interface FakeMailbox {
  readonly path: string;
  readonly specialUse?: string;
  uidValidity: bigint;
  uidNext: number;
  uids: number[];
}

/**
 * A stand-in for `ImapSessionClient` that holds one Sent mailbox, answers what
 * the scan issues (LIST, a mailbox lock, a fetch by sequence or by UID, a UID
 * search) and records each, so a test can assert the wire shape. Everything
 * that would write is recorded as forbidden. Like the fixture beside it, it is
 * written from the adapter's own reading of the protocol and proves nothing
 * about a real server; `imapflow-integration.test.ts` does that part.
 */
function serverFixture(options: {
  readonly sent: { readonly path: string; readonly specialUse?: string; readonly uids: readonly number[] } | null;
  readonly refuseExamine?: boolean;
  readonly dropOnExamine?: boolean;
  /** Every fetch answers its last envelope twice: one more than the range holds. */
  readonly overAnswer?: boolean;
  /** Every fetch also answers a flags-only FETCH response, with no envelope. */
  readonly flagUpdates?: boolean;
  /** What one letter's envelope says instead of the fixture's own, by UID. */
  readonly envelopes?: Readonly<Record<number, Partial<FakeEnvelope>>>;
  /** STATUS is answered with NO, which ImapFlow hands back as `false`. */
  readonly refuseStatus?: boolean;
  /** STATUS throws, as it does for a folder the server says is not there. */
  readonly statusThrows?: boolean;
}) {
  const mailboxes = new Map<string, FakeMailbox>();
  // The Inbox the sync's own sessions examine: empty, and never changing.
  mailboxes.set("INBOX", { path: "INBOX", uidValidity: BigInt(77), uidNext: 1, uids: [] });
  const addSent = (path: string, uids: readonly number[], specialUse?: string) => {
    mailboxes.set(path, {
      path,
      ...(specialUse === undefined ? {} : { specialUse }),
      uidValidity: BigInt(500),
      uidNext: Math.max(0, ...uids) + 1,
      uids: [...uids],
    });
  };
  if (options.sent !== null) addSent(options.sent.path, options.sent.uids, options.sent.specialUse);
  let refuseExamine = options.refuseExamine === true;
  const locks: { readonly path: string; readonly readOnly: boolean }[] = [];
  const fetches: { readonly range: string; readonly query: unknown; readonly uid: boolean }[] = [];
  const searches: string[] = [];
  const statuses: string[] = [];
  /** Every command a session issued, in the order it issued them. */
  const wire: string[] = [];
  const forbidden: string[] = [];
  const counters = { bccReads: 0, lists: 0 };
  let statusHangs = false;
  let listHangs = false;
  const never = () => new Promise<never>(() => undefined);
  const errorListeners: Array<(error: unknown) => void> = [];
  let selected: FakeMailbox | null = null;
  let dropNextExamine = false;
  let searchFails = false;
  /** What every search answers instead of what the folder holds. */
  let searchAnswer: readonly number[] | null = null;
  /** Folders with no role that LIST names beside the real ones. */
  let crowd = 0;
  /** What STATUS goes on answering for a folder whatever reaches it. */
  const staleStatus = new Map<string, { readonly uidNext: number; readonly uidValidity: bigint }>();
  /** The letter no session can fetch, and what the session says as it dies. */
  let unreadable: {
    readonly uid: number;
    readonly code?: string;
    readonly before?: () => void;
  } | null = null;
  const connectionLost = () =>
    Object.assign(new Error("Connection not available"), { code: "NoConnection" });

  const envelopeOf = (uid: number): FetchMessageObject["envelope"] => {
    const author = [{ name: "Display Name", address: `Alias${uid}@Example.test` }];
    const envelope = {
      date: new Date(1_700_000_000_000 + uid),
      subject: "Subject",
      messageId: `<sent-${uid}@example.test>`,
      from: author,
      // A server fills Sender in from From when the letter states none.
      sender: author,
      to: [{ name: "Display Name", address: `to${uid}@example.org` }],
      cc: [{ name: "Display Name", address: `cc${uid}@example.org` }],
      ...options.envelopes?.[uid],
    };
    Object.defineProperty(envelope, "bcc", {
      enumerable: true,
      get() {
        counters.bccReads += 1;
        return [{ address: `bcc${uid}@example.org` }];
      },
    });
    return envelope;
  };
  const forbid = (name: string) => async () => {
    forbidden.push(name);
    throw new Error(`${name} is not a command the scan may issue`);
  };

  const client = {
    secureConnection: true,
    authenticated: true,
    capabilities: new Map<string, boolean | number>([["IMAP4rev1", true]]),
    get mailbox(): MailboxObject | false {
      if (selected === null) return false;
      return {
        path: selected.path,
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: selected.uidValidity,
        uidNext: selected.uidNext,
        exists: selected.uids.length,
        readOnly: true,
      };
    },
    connect: async () => undefined,
    close: () => undefined,
    on: (_event: "error", listener: (error: unknown) => void) => {
      errorListeners.push(listener);
      return client;
    },
    unbind: () => {
      throw new Error("not used");
    },
    async getMailboxLock(path: string, lockOptions?: { readonly readOnly?: boolean }) {
      if (options.dropOnExamine === true || dropNextExamine) {
        dropNextExamine = false;
        throw connectionLost();
      }
      if (refuseExamine) {
        throw Object.assign(new Error("Command failed"), {
          response: "NO [NOPERM] Access denied",
          responseStatus: "NO",
          serverResponseCode: "NOPERM",
        });
      }
      const target = mailboxes.get(path);
      if (!target) throw new Error(`no such mailbox ${path}`);
      selected = target;
      wire.push(`examine ${path}`);
      locks.push({ path, readOnly: lockOptions?.readOnly === true });
      return {
        path,
        release: () => {
          selected = null;
        },
      };
    },
    async fetchAll(
      requested: string,
      query: unknown,
      fetchOptions?: { readonly uid?: boolean },
    ): Promise<FetchMessageObject[]> {
      if (selected === null) throw new Error("no mailbox selected");
      const byUid = fetchOptions?.uid === true;
      fetches.push({ range: requested, query, uid: byUid });
      const [first, last] = requested.split(":").map(Number) as [number, number];
      const uids = [...selected.uids].sort((left, right) => left - right);
      const answered = uids.flatMap((uid, index) => {
        const position = byUid ? uid : index + 1;
        return position >= first && position <= last
          ? [{ seq: index + 1, uid, envelope: envelopeOf(uid) } as FetchMessageObject]
          : [];
      });
      const fatal = unreadable;
      if (fatal !== null && answered.some((message) => message.uid === fatal.uid)) {
        fatal.before?.();
        // ImapFlow reports what killed the stream on the client's error
        // event; the fetch itself only learns that the connection is gone.
        if (fatal.code !== undefined) {
          for (const listener of errorListeners) {
            listener(Object.assign(new Error("stream error"), { code: fatal.code }));
          }
        }
        throw connectionLost();
      }
      const noise =
        options.flagUpdates === true
          ? [{ seq: 1, flags: new Set(["\\Seen"]) } as unknown as FetchMessageObject]
          : [];
      const repeated = answered.at(-1);
      return options.overAnswer === true && repeated !== undefined
        ? [...noise, ...answered, repeated]
        : [...noise, ...answered];
    },
    async search(query: { readonly uid?: string }, searchOptions?: { readonly uid?: boolean }) {
      if (selected === null) throw new Error("no mailbox selected");
      if (searchOptions?.uid !== true || typeof query.uid !== "string") {
        throw new Error("only a UID search by UID range is modelled");
      }
      searches.push(query.uid);
      if (searchFails) throw connectionLost();
      if (searchAnswer !== null) return [...searchAnswer];
      const from = Number(query.uid.split(":")[0]);
      const uids = [...selected.uids].sort((left, right) => left - right);
      const above = uids.filter((uid) => uid >= from);
      // RFC 3501: `n:*` always names the newest message, even one below n.
      return above.length > 0 || uids.length === 0 ? above : [uids.at(-1)!];
    },
    async list() {
      counters.lists += 1;
      wire.push("list");
      if (listHangs) return never();
      const listed = [
        ...mailboxes.values(),
        ...Array.from({ length: crowd }, (_value, index) => ({
          path: `Folder ${index}`,
          specialUse: undefined,
        })),
      ];
      return listed.map((entry) => ({
        path: entry.path,
        pathAsListed: entry.path,
        name: entry.path,
        delimiter: "/",
        parent: [],
        parentPath: "",
        // A stated attribute is among the flags, as a server lists it.
        flags: new Set<string>(entry.specialUse === undefined ? [] : [entry.specialUse]),
        ...(entry.specialUse === undefined ? {} : { specialUse: entry.specialUse }),
        listed: true,
        subscribed: true,
      }));
    },
    async status(path: string, query: { readonly uidNext?: boolean; readonly uidValidity?: boolean }) {
      if (query.uidNext !== true || query.uidValidity !== true || Object.keys(query).length !== 2) {
        throw new Error("only STATUS (UIDNEXT UIDVALIDITY) is modelled");
      }
      statuses.push(path);
      wire.push(`status ${path}`);
      if (statusHangs) return never();
      if (options.statusThrows === true) {
        throw Object.assign(new Error(`Mailbox doesn't exist: ${path}`), { code: "NotFound" });
      }
      const target = mailboxes.get(path);
      if (options.refuseStatus === true || target === undefined) return false as const;
      const stale = staleStatus.get(path);
      if (stale !== undefined) return { path, ...stale };
      return { path, uidNext: target.uidNext, uidValidity: target.uidValidity };
    },
    mailboxCreate: forbid("create"),
    mailboxSubscribe: forbid("subscribe"),
    messageFlagsAdd: forbid("store"),
    messageFlagsRemove: forbid("store"),
    messageMove: forbid("move"),
  };

  return {
    client: client as unknown as ImapSessionClient,
    locks,
    fetches,
    searches,
    statuses,
    wire,
    forbidden,
    /** From now on the server never answers a STATUS. */
    hangStatus() {
      statusHangs = true;
    },
    /** From now on the server never answers a LIST. */
    hangList() {
      listHangs = true;
    },
    get bccReads() {
      return counters.bccReads;
    },
    get lists() {
      return counters.lists;
    },
    /** Sessions that examined this mailbox: each is a login on the wire. */
    sessionsOf(path: string) {
      return locks.filter((lock) => lock.path === path).length;
    },
    addSent,
    allowExamine() {
      refuseExamine = false;
    },
    /** The next lock finds the connection gone; the one after it does not. */
    dropNextExamine() {
      dropNextExamine = true;
    },
    /** Every fetch whose answer would hold this letter kills its session. */
    failFetchOf(
      uid: number | null,
      how: { readonly code?: string; readonly before?: () => void } = {},
    ) {
      unreadable = uid === null ? null : { uid, ...how };
    },
    failSearch(fails = true) {
      searchFails = fails;
    },
    /** Every search answers these UIDs, whatever the folder holds. */
    searchAnswers(uids: readonly number[] | null) {
      searchAnswer = uids;
    },
    /** LIST names this many folders more, none of them with a role. */
    crowd(count: number) {
      crowd = count;
    },
    /** From now on STATUS answers what the folder holds at this moment. */
    freezeStatus(path: string) {
      const mailbox = mailboxes.get(path)!;
      staleStatus.set(path, { uidNext: mailbox.uidNext, uidValidity: mailbox.uidValidity });
    },
    /** Another client sends `count` more letters. */
    append(path: string, count: number) {
      const mailbox = mailboxes.get(path)!;
      for (let index = 0; index < count; index += 1) {
        mailbox.uids.push(mailbox.uidNext);
        mailbox.uidNext += 1;
      }
    },
    expunge(path: string, uids: readonly number[]) {
      const mailbox = mailboxes.get(path)!;
      mailbox.uids = mailbox.uids.filter((uid) => !uids.includes(uid));
    },
    /** The server rebuilt the mailbox: a new UIDVALIDITY and new UIDs. */
    renumber(path: string, uidValidity: bigint, uids: readonly number[]) {
      const mailbox = mailboxes.get(path)!;
      mailbox.uidValidity = uidValidity;
      mailbox.uids = [...uids];
      mailbox.uidNext = Math.max(0, ...uids) + 1;
    },
  };
}

function providerFor(
  server: ReturnType<typeof serverFixture>,
  now?: () => number,
  /** What the session says it has left of its deadline, when a test says. */
  remainingMs?: () => number,
) {
  const opened = { count: 0 };
  const sessions = {
    async withSession<T>(
      _account: StoredImapMailAccount,
      _signal: AbortSignal,
      operation: (
        client: ImapSessionClient,
        session?: { remainingMs(): number },
      ) => Promise<T>,
    ): Promise<T> {
      opened.count += 1;
      return remainingMs === undefined
        ? operation(server.client)
        : operation(server.client, { remainingMs });
    },
  };
  return {
    provider: new ImapMailSyncAdapter(accountFixture(), sessions, now === undefined ? {} : { now }),
    opened,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function accountFixture(): StoredImapMailAccount {
  return Object.freeze({
    account: Object.freeze({
      accountId: ACCOUNT_ID,
      emailAddress: "reader@example.test",
      endpoint: Object.freeze({
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit" as const,
      }),
      username: "reader@example.test",
      credentialRef: Object.freeze({
        id: "credential-r11111111111111111111111111111111",
        version: 1,
      }),
      transportBindingRef: Object.freeze({
        id: "binding-r11111111111111111111111111111111",
        version: 1,
      }),
      connectedAt: 1,
    }),
    providerKind: "imap",
    displayName: null,
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
  });
}
