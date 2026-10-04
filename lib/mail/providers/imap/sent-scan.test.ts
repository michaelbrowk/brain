import type { FetchMessageObject, MailboxObject } from "imapflow";
import { describe, expect, it } from "vitest";

import type { StoredImapMailAccount } from "../../service/account-types";
import type { ImapSessionClient } from "../../service/imapflow-adapter";
import type { MailSentScanResult } from "../../service/senders";
import {
  IMAP_SENT_SCAN_BATCH,
  IMAP_SENT_SCAN_FIRST_RUN_CAP,
  ImapMailSyncAdapter,
} from "./sync-adapter";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";

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

  it("hands over To and Cc as recipients and From as a sender, addresses only, and never reads Bcc", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: [7] } });
    const { provider } = providerFor(server);

    const result = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    expect(result.recipients).toEqual(["to7@example.org", "cc7@example.org"]);
    expect(result.senders).toEqual(["alias7@example.test"]);
    expect(JSON.stringify(result)).not.toContain("bcc7");
    expect(JSON.stringify(result)).not.toContain("Display Name");
    // The envelope's Bcc is an accessor in this fixture: touching it fails.
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
    expect(first.recipients).toContain(`to${total}@example.org`);
    expect(third.recipients).toContain("to1@example.org");
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
    expect(next).toMatchObject({ envelopeCount: IMAP_SENT_SCAN_BATCH, hasMore: true });
    expect(rest).toMatchObject({ envelopeCount: 2, hasMore: false });
    expect(next.recipients).toContain("to5@example.org");
    expect(next.recipients).not.toContain("to4@example.org");
  });

  it("reads a letter sent while the first walk is still going before it walks on", async () => {
    const total = IMAP_SENT_SCAN_BATCH + 10;
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, total) } });
    const { provider } = providerFor(server);
    const first = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));

    server.append("Sent", 1);
    const fresh = scanned(await provider.scanSentEnvelopes({ cursor: first.cursor }, signal()));
    const tail = scanned(await provider.scanSentEnvelopes({ cursor: fresh.cursor }, signal()));

    expect(fresh.recipients).toEqual([`to${total + 1}@example.org`, `cc${total + 1}@example.org`]);
    expect(fresh.hasMore).toBe(true);
    expect(tail).toMatchObject({ envelopeCount: 10, hasMore: false });
    expect(tail.recipients).toContain("to1@example.org");
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
    expect(second.recipients).toContain("to31@example.org");
    expect(second.recipients).toContain("to40@example.org");
    expect(second.recipients).not.toContain("to41@example.org");
    expect(second.hasMore).toBe(false);
  });

  it("starts the walk again under a new UIDVALIDITY and says that it did", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) } });
    const { provider } = providerFor(server);
    const before = scanned(await provider.scanSentEnvelopes({ cursor: null }, signal()));
    expect(before.uidValidityChanged).toBe(false);

    server.renumber("Sent", BigInt(901), [50, 51]);
    const after = scanned(await provider.scanSentEnvelopes({ cursor: before.cursor }, signal()));

    expect(after.uidValidityChanged).toBe(true);
    expect(after.envelopeCount).toBe(2);
    expect(after.recipients).toContain("to51@example.org");
    expect(after.cursor).not.toBe(before.cursor);
    // The new cursor is the new folder's: nothing more to read.
    const settled = scanned(await provider.scanSentEnvelopes({ cursor: after.cursor }, signal()));
    expect(settled).toMatchObject({ envelopeCount: 0, uidValidityChanged: false, hasMore: false });
  });

  it("begins again from a cursor it cannot read rather than failing", async () => {
    const server = serverFixture({ sent: { path: "Sent", specialUse: "\\Sent", uids: [1] } });
    const { provider } = providerFor(server);

    const result = scanned(await provider.scanSentEnvelopes({ cursor: "not-a-cursor" }, signal()));

    expect(result).toMatchObject({ envelopeCount: 1, uidValidityChanged: false });
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

  it("refuses a page with more envelopes than it asked for", async () => {
    const server = serverFixture({
      sent: { path: "Sent", specialUse: "\\Sent", uids: range(1, 3) },
      overAnswer: true,
    });
    const { provider } = providerFor(server);

    await expect(provider.scanSentEnvelopes({ cursor: null }, signal())).rejects.toMatchObject({
      code: "mail_provider_response_invalid",
    });
  });
});

type ScannedResult = Extract<MailSentScanResult, { readonly status: "scanned" }>;

function scanned(result: MailSentScanResult): ScannedResult {
  if (result.status !== "scanned") throw new Error(`the scan answered ${result.reason}`);
  return result;
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_value, index) => first + index);
}

interface FakeMailbox {
  readonly path: string;
  readonly specialUse?: string;
  uidValidity: bigint;
  uidNext: number;
  uids: number[];
}

/**
 * A stand-in for `ImapSessionClient` that holds one Sent mailbox, answers the
 * three things the scan issues (LIST, a mailbox lock, a fetch by sequence or by
 * UID) and records each, so a test can assert the wire shape. Everything that
 * would write is recorded as forbidden. Like the fixture beside it, it is
 * written from the adapter's own reading of the protocol and proves nothing
 * about a real server; `imapflow-integration.test.ts` does that part.
 */
function serverFixture(options: {
  readonly sent: { readonly path: string; readonly specialUse?: string; readonly uids: readonly number[] } | null;
  readonly refuseExamine?: boolean;
  readonly dropOnExamine?: boolean;
  /** Every fetch answers one envelope more than the range holds. */
  readonly overAnswer?: boolean;
}) {
  const mailboxes = new Map<string, FakeMailbox>();
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
  const forbidden: string[] = [];
  const counters = { bccReads: 0, lists: 0 };
  let selected: FakeMailbox | null = null;

  const envelopeOf = (uid: number): FetchMessageObject["envelope"] => {
    const envelope = {
      date: new Date(1_700_000_000_000 + uid),
      subject: "Subject",
      messageId: `<sent-${uid}@example.test>`,
      from: [{ name: "Display Name", address: `Alias${uid}@Example.test` }],
      to: [{ name: "Display Name", address: `to${uid}@example.org` }],
      cc: [{ name: "Display Name", address: `cc${uid}@example.org` }],
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
    on: () => client,
    unbind: () => {
      throw new Error("not used");
    },
    async getMailboxLock(path: string, lockOptions?: { readonly readOnly?: boolean }) {
      if (options.dropOnExamine === true) {
        throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
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
      return options.overAnswer === true
        ? [...answered, { seq: 0, uid: 1, envelope: envelopeOf(1) } as FetchMessageObject]
        : answered;
    },
    async list() {
      counters.lists += 1;
      return [...mailboxes.values()].map((entry) => ({
        path: entry.path,
        pathAsListed: entry.path,
        name: entry.path,
        delimiter: "/",
        parent: [],
        parentPath: "",
        flags: new Set<string>(),
        ...(entry.specialUse === undefined ? {} : { specialUse: entry.specialUse }),
        listed: true,
        subscribed: true,
      }));
    },
    mailboxCreate: forbid("create"),
    mailboxSubscribe: forbid("subscribe"),
    search: forbid("search"),
    messageFlagsAdd: forbid("store"),
    messageFlagsRemove: forbid("store"),
    messageMove: forbid("move"),
  };

  return {
    client: client as unknown as ImapSessionClient,
    locks,
    fetches,
    forbidden,
    get bccReads() {
      return counters.bccReads;
    },
    addSent,
    allowExamine() {
      refuseExamine = false;
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
      mailbox.uidNext = Math.max(...uids) + 1;
    },
  };
}

function providerFor(server: ReturnType<typeof serverFixture>, now?: () => number) {
  const opened = { count: 0 };
  const sessions = {
    async withSession<T>(
      _account: StoredImapMailAccount,
      _signal: AbortSignal,
      operation: (client: ImapSessionClient) => Promise<T>,
    ): Promise<T> {
      opened.count += 1;
      return operation(server.client);
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
