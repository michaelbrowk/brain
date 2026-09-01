import type { FetchMessageObject, MailboxObject } from "imapflow";
import { describe, expect, it } from "vitest";

import type { StoredImapMailAccount } from "../../service/account-types";
import type { ImapSessionClient } from "../../service/imapflow-adapter";
import { ImapMailSyncAdapter } from "./sync-adapter";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const UID_VALIDITY = BigInt(77);

describe("IMAP thread mutations", () => {
  it("marks a thread read with UID STORE on a writable Inbox", async () => {
    const server = serverFixture();
    const { provider } = providerFor(server);

    await provider.setThreadRead("i77u1", true, signal());

    expect(server.mailbox("INBOX").messages.get(1)?.flags.has("\\Seen")).toBe(true);
    expect(server.commands).toContainEqual({
      name: "store",
      mailbox: "INBOX",
      uid: 1,
      flags: ["\\Seen"],
      add: true,
    });
    expect(server.locks).toContainEqual({ path: "INBOX", readOnly: false });
    const refreshed = await provider.getThread("i77u1", signal());
    expect(refreshed?.thread.unread).toBe(false);
    expect(refreshed?.inInbox).toBe(true);
  });

  it("marks a thread unread again", async () => {
    const server = serverFixture({ inboxFlags: ["\\Seen"] });
    const { provider } = providerFor(server);

    await provider.setThreadRead("i77u1", false, signal());

    expect(server.mailbox("INBOX").messages.get(1)?.flags.has("\\Seen")).toBe(false);
    const refreshed = await provider.getThread("i77u1", signal());
    expect(refreshed?.thread.unread).toBe(true);
  });

  it("stars and unstars with \\Flagged", async () => {
    const server = serverFixture();
    const { provider } = providerFor(server);

    await provider.setThreadStarred("i77u1", true, signal());
    expect(server.mailbox("INBOX").messages.get(1)?.flags.has("\\Flagged")).toBe(true);
    let refreshed = await provider.getThread("i77u1", signal());
    expect(refreshed?.thread.starred).toBe(true);
    expect(refreshed?.mailboxes).toContain("starred");

    await provider.setThreadStarred("i77u1", false, signal());
    expect(server.mailbox("INBOX").messages.get(1)?.flags.has("\\Flagged")).toBe(false);
    refreshed = await provider.getThread("i77u1", signal());
    expect(refreshed?.thread.starred).toBe(false);
    expect(refreshed?.mailboxes).not.toContain("starred");
  });

  it("archives into the SPECIAL-USE Archive mailbox and keeps the thread id", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());

    expect(server.mailbox("INBOX").messages.has(1)).toBe(false);
    expect([...server.mailbox("Archive").messages.keys()]).toHaveLength(1);
    expect(server.commands).toContainEqual({
      name: "move",
      mailbox: "INBOX",
      uid: 1,
      destination: "Archive",
    });
    const refreshed = await provider.getThread("i77u1", signal());
    expect(refreshed?.thread.threadId).toBe("i77u1");
    expect(refreshed?.messages[0]?.messageId).toBe("i77u1");
    expect(refreshed?.inInbox).toBe(false);
    expect(refreshed?.mailboxes).not.toContain("inbox");
  });

  it("follows the moved message when the next mutation arrives", async () => {
    // The section Done sends archive first and mark-read second, so the second
    // mutation has to find a message that is no longer in the Inbox.
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());
    await provider.setThreadRead("i77u1", true, signal());

    const archived = [...server.mailbox("Archive").messages.values()][0];
    expect(archived?.flags.has("\\Seen")).toBe(true);
    expect(server.commands).toContainEqual({
      name: "store",
      mailbox: "Archive",
      uid: archived?.uid,
      flags: ["\\Seen"],
      add: true,
    });
  });

  it("un-archives back into the Inbox under the same thread id", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());
    await provider.unarchiveThread("i77u1", signal());

    expect(server.mailbox("Archive").messages.size).toBe(0);
    expect(server.mailbox("INBOX").messages.size).toBe(1);
    const refreshed = await provider.getThread("i77u1", signal());
    expect(refreshed?.thread.threadId).toBe("i77u1");
    expect(refreshed?.inInbox).toBe(true);
    expect(refreshed?.mailboxes).toContain("inbox");
  });

  it("trashes into the SPECIAL-USE Trash mailbox and restores from it", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "Trash", specialUse: "\\Trash" }],
    });
    const { provider } = providerFor(server);

    await provider.trashThread("i77u1", signal());
    expect(server.mailbox("Trash").messages.size).toBe(1);
    expect((await provider.getThread("i77u1", signal()))?.inInbox).toBe(false);

    await provider.restoreThread("i77u1", signal());
    expect(server.mailbox("Trash").messages.size).toBe(0);
    expect(server.mailbox("INBOX").messages.size).toBe(1);
    expect((await provider.getThread("i77u1", signal()))?.inInbox).toBe(true);
  });

  it("moves spam into the Junk mailbox and back out of it", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "Junk", specialUse: "\\Junk" }],
    });
    const { provider } = providerFor(server);

    await provider.setThreadSpam("i77u1", true, signal());
    expect(server.mailbox("Junk").messages.size).toBe(1);

    await provider.setThreadSpam("i77u1", false, signal());
    expect(server.mailbox("INBOX").messages.size).toBe(1);
  });

  it("uses a well-known folder name when the server advertises nothing", async () => {
    const server = serverFixture({ mailboxes: [{ path: "INBOX.Archive" }] });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());

    expect(server.mailbox("INBOX.Archive").messages.size).toBe(1);
  });

  it("refuses instead of guessing when the server has no archive mailbox", async () => {
    const server = serverFixture({ mailboxes: [{ path: "INBOX.Sent" }] });
    const { provider } = providerFor(server);

    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_mutation_unsupported" });

    expect(server.mailbox("INBOX").messages.has(1)).toBe(true);
    expect(server.commands.some((command) => command.name === "move")).toBe(false);
  });

  it("refuses the move when the server does not advertise MOVE", async () => {
    // ImapFlow would emulate it with COPY, \Deleted and EXPUNGE, hand back the
    // COPY's result whatever the delete did, and — with no UIDPLUS either —
    // send a bare EXPUNGE that takes every \Deleted message in the Inbox with
    // it. None of that is ours to do to the owner's mailbox.
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
      move: false,
      uidplus: false,
    });
    const { provider } = providerFor(server);

    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_mutation_unsupported" });

    expect(server.commands.some((command) => command.name === "move")).toBe(false);
    expect(server.mailbox("INBOX").messages.has(1)).toBe(true);
    expect(server.mailbox("Archive").messages.size).toBe(0);
    // Nothing was selected for writing either: the refusal comes before the
    // mailbox is touched at all.
    expect(server.locks.some((lock) => lock.readOnly === false)).toBe(false);
  });

  it("still sets flags on a server that cannot MOVE", async () => {
    // The refusal is about relocating a message. Marking one read is a STORE
    // where it already is, and that is unaffected.
    const server = serverFixture({ move: false });
    const { provider } = providerFor(server);

    await provider.setThreadRead("i77u1", true, signal());

    expect(server.mailbox("INBOX").messages.get(1)?.flags.has("\\Seen")).toBe(true);
  });

  it("does not open a session to repeat a refusal it has already made", async () => {
    const server = serverFixture({ mailboxes: [{ path: "INBOX.Sent" }] });
    const { provider, opened } = providerFor(server);

    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_mutation_unsupported" });
    expect(opened.count).toBe(1);

    // LIST has already answered for this account. Connecting again to say the
    // same no is a login per thread for a whole section Done.
    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_mutation_unsupported" });
    expect(opened.count).toBe(1);
    expect(server.commands.filter((command) => command.name === "list")).toHaveLength(1);
  });

  it("keeps no handle when two messages in the archive share the Message-ID", async () => {
    // Without UIDPLUS the Message-ID search is the only way to find the moved
    // message, and a duplicate in the destination is ordinary. Guessing one of
    // them means the next mutation writes to somebody else's letter.
    const server = serverFixture({
      mailboxes: [
        {
          path: "Archive",
          specialUse: "\\Archive",
          messageIds: ["<message-1@example.test>"],
        },
      ],
      uidplus: false,
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());
    expect(server.mailbox("Archive").messages.size).toBe(2);

    await expect(
      provider.setThreadRead("i77u1", true, signal()),
    ).rejects.toMatchObject({ code: "mail_provider_thread_stale" });
    // Neither copy was touched — not the one that was already there, and not
    // the one that just arrived.
    for (const message of server.mailbox("Archive").messages.values()) {
      expect(message.flags.has("\\Seen")).toBe(false);
    }
    expect(
      server.commands.some(
        (command) => command.name === "store" && command.mailbox === "Archive",
      ),
    ).toBe(false);
  });

  it("finds the moved message by Message-ID when the server has no UIDPLUS", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
      uidplus: false,
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());
    await provider.setThreadRead("i77u1", true, signal());

    expect(server.commands).toContainEqual({
      name: "search",
      mailbox: "Archive",
      messageId: "<message-1@example.test>",
    });
    const archived = [...server.mailbox("Archive").messages.values()][0];
    expect(archived?.flags.has("\\Seen")).toBe(true);
  });

  it("refuses, and does not ask for a retry, when the server answers NO to the move", async () => {
    // LIST named the folder and the server still declined to put a message in
    // it. That is the server's layout or its ACLs, as true tomorrow as now, so
    // it is the same refusal as having no folder at all — not an outage that a
    // second press might get past.
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
      refuseMove: true,
    });
    const { provider } = providerFor(server);

    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_mutation_unsupported" });

    expect(server.mailbox("INBOX").messages.has(1)).toBe(true);
    expect(server.mailbox("Archive").messages.size).toBe(0);
    // The thread is still addressable exactly where it was.
    expect((await provider.getThread("i77u1", signal()))?.inInbox).toBe(true);
  });

  it("still reports a session that dropped mid-MOVE as unavailable", async () => {
    // A NO is the server's answer. A socket that closed before there was one
    // is not, and the next attempt may well land.
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
      dropDuringMove: true,
    });
    const { provider } = providerFor(server);

    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_unavailable" });
  });

  it("rejects a stale thread whose message another client already removed", async () => {
    const server = serverFixture();
    server.mailbox("INBOX").messages.delete(1);
    const { provider } = providerFor(server);

    await expect(
      provider.setThreadRead("i77u1", true, signal()),
    ).rejects.toMatchObject({ code: "mail_provider_thread_stale" });
  });

  it("reports a refused STORE instead of claiming the flag was set", async () => {
    const server = serverFixture({ refuseStore: true });
    const { provider } = providerFor(server);

    await expect(
      provider.setThreadRead("i77u1", true, signal()),
    ).rejects.toMatchObject({ code: "mail_provider_unavailable" });

    expect(server.mailbox("INBOX").messages.get(1)?.flags.has("\\Seen")).toBe(false);
  });

  it("refuses a star the mailbox cannot keep, before any STORE is sent", async () => {
    // PERMANENTFLAGS without \Flagged and without \*: the server has said the
    // flag will not stick. ImapFlow answers that by returning false without
    // sending anything, which read as "unavailable" and a "Try again" that
    // could never succeed.
    const server = serverFixture({ permanentFlags: ["\\Seen", "\\Deleted"] });
    const { provider } = providerFor(server);

    await expect(
      provider.setThreadStarred("i77u1", true, signal()),
    ).rejects.toMatchObject({ code: "mail_provider_mutation_unsupported" });

    expect(server.commands.some((command) => command.name === "store")).toBe(false);
  });

  it("still marks read on a mailbox that keeps \\Seen but not \\Flagged", async () => {
    const server = serverFixture({ permanentFlags: ["\\Seen", "\\Deleted"] });
    const { provider } = providerFor(server);

    await provider.setThreadRead("i77u1", true, signal());

    expect(server.mailbox("INBOX").messages.get(1)?.flags.has("\\Seen")).toBe(true);
  });

  it("still clears a flag the mailbox cannot keep", async () => {
    // Removing a flag the server never stores is harmless, and ImapFlow sends
    // it. Only setting one it cannot keep is a promise that would be broken.
    const server = serverFixture({
      inboxFlags: ["\\Flagged"],
      permanentFlags: ["\\Seen", "\\Deleted"],
    });
    const { provider } = providerFor(server);

    await provider.setThreadStarred("i77u1", false, signal());

    expect(server.mailbox("INBOX").messages.get(1)?.flags.has("\\Flagged")).toBe(false);
  });

  it("refuses a STORE on a mailbox the server selected read-only", async () => {
    const server = serverFixture({ readOnly: true });
    const { provider } = providerFor(server);

    await expect(
      provider.setThreadRead("i77u1", true, signal()),
    ).rejects.toMatchObject({ code: "mail_provider_mutation_unsupported" });

    expect(server.commands.some((command) => command.name === "store")).toBe(false);
  });

  it("rejects a thread whose mailbox was recreated under a new UIDVALIDITY", async () => {
    const server = serverFixture();
    server.mailbox("INBOX").uidValidity = BigInt(78);
    const { provider } = providerFor(server);

    await expect(
      provider.setThreadStarred("i77u1", true, signal()),
    ).rejects.toMatchObject({ code: "mail_provider_thread_stale" });
  });

  it("refuses an undo it can no longer address instead of asking for a retry", async () => {
    // The relocation map lives in the adapter. A runtime restart between the
    // archive and the press hands the undo to a fresh adapter that believes
    // the thread is still in the Inbox at the UID its id encodes — and it is
    // not. No retry brings the handle back: the next sync rebuilds the list
    // without the moved message, and the surface has to say so.
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    await providerFor(server).provider.archiveThread("i77u1", signal());
    const { provider: restarted } = providerFor(server);

    await expect(
      restarted.unarchiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_thread_stale" });

    expect(server.mailbox("Archive").messages.size).toBe(1);
  });

  it("does not archive into a nested folder that happens to be called Archive", async () => {
    // Without SPECIAL-USE the name tier is all there is, and a leaf called
    // Archive three levels down a project tree is a folder about something
    // else. Only the account root and the Inbox's own children are places a
    // mail client creates an Archive.
    const server = serverFixture({ mailboxes: [{ path: "Projects.2019.Archive" }] });
    const { provider } = providerFor(server);

    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_mutation_unsupported" });

    expect(server.commands.some((command) => command.name === "move")).toBe(false);
    expect(server.mailbox("INBOX").messages.has(1)).toBe(true);
  });

  it("does nothing on the wire when the thread is already where it was asked to go", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());
    const movesAfterFirst = server.commands.filter(
      (command) => command.name === "move",
    ).length;
    await provider.archiveThread("i77u1", signal());

    expect(
      server.commands.filter((command) => command.name === "move"),
    ).toHaveLength(movesAfterFirst);
    expect(server.mailbox("Archive").messages.size).toBe(1);
  });

  it("reads with a read-only lock and mutates with a writable one", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const { provider } = providerFor(server);

    await provider.getThread("i77u1", signal());
    expect(server.locks).toEqual([{ path: "INBOX", readOnly: true }]);

    await provider.archiveThread("i77u1", signal());
    expect(server.locks).toContainEqual({ path: "INBOX", readOnly: false });
  });

  it("lists mailboxes once and asks again only after a move fails", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());
    await provider.unarchiveThread("i77u1", signal());
    await provider.archiveThread("i77u1", signal());

    expect(server.commands.filter((command) => command.name === "list")).toHaveLength(1);
  });
});

type FakeCommand =
  | { readonly name: "list" }
  | { readonly name: "search"; readonly mailbox: string; readonly messageId: string }
  | {
      readonly name: "store";
      readonly mailbox: string;
      readonly uid: number;
      readonly flags: readonly string[];
      readonly add: boolean;
    }
  | {
      readonly name: "move";
      readonly mailbox: string;
      readonly uid: number;
      readonly destination: string;
    };

interface FakeMessage {
  readonly uid: number;
  readonly flags: Set<string>;
  readonly messageId: string;
  readonly internalDate: Date;
}

interface FakeMailbox {
  readonly path: string;
  readonly specialUse?: string;
  uidValidity: bigint;
  uidNext: number;
  readonly messages: Map<number, FakeMessage>;
}

interface FakeServer {
  readonly commands: FakeCommand[];
  readonly locks: { readonly path: string; readonly readOnly: boolean }[];
  readonly client: ImapSessionClient;
  mailbox(path: string): FakeMailbox;
}

/**
 * A hand-written stand-in for `ImapSessionClient`, holding mailboxes, UIDs and
 * the UID change a MOVE makes. It answers only the commands this adapter issues
 * and records each one, so a test can assert the wire shape as well as the
 * outcome.
 *
 * It is not a server and it cannot falsify a claim about one. It is written
 * from the same reading of the protocol as the adapter, so it exercises the
 * adapter's logic and proves nothing about how ImapFlow or a real host behaves.
 */
function serverFixture(options?: {
  readonly mailboxes?: readonly {
    readonly path: string;
    readonly specialUse?: string;
    readonly messageIds?: readonly string[];
  }[];
  readonly inboxFlags?: readonly string[];
  /** PERMANENTFLAGS as the server states them on SELECT. Absent means any flag. */
  readonly permanentFlags?: readonly string[];
  /** The server answers every SELECT with READ-ONLY, as an ACL would. */
  readonly readOnly?: boolean;
  readonly uidplus?: boolean;
  /** Drops `MOVE` from the advertised set, as a pre-RFC-6851 host would. */
  readonly move?: boolean;
  /** The server answers the MOVE with NO. ImapFlow reports that as `false`. */
  readonly refuseMove?: boolean;
  /** The session dies under the MOVE, before any answer. */
  readonly dropDuringMove?: boolean;
  readonly refuseStore?: boolean;
}): FakeServer {
  const uidplus = options?.uidplus ?? true;
  const capabilities = new Map<string, boolean | number>([["IMAP4rev1", true]]);
  if (options?.move !== false) capabilities.set("MOVE", true);
  if (uidplus) capabilities.set("UIDPLUS", true);
  const mailboxes = new Map<string, FakeMailbox>();
  mailboxes.set("INBOX", {
    path: "INBOX",
    uidValidity: UID_VALIDITY,
    uidNext: 2,
    messages: new Map([
      [
        1,
        {
          uid: 1,
          flags: new Set(options?.inboxFlags ?? []),
          messageId: "<message-1@example.test>",
          internalDate: new Date(1_700_000_000_000),
        },
      ],
    ]),
  });
  for (const [index, entry] of (options?.mailboxes ?? []).entries()) {
    const seeded = entry.messageIds ?? [];
    mailboxes.set(entry.path, {
      path: entry.path,
      ...(entry.specialUse === undefined ? {} : { specialUse: entry.specialUse }),
      uidValidity: BigInt(500 + index),
      uidNext: seeded.length + 1,
      messages: new Map(
        seeded.map((messageId, offset) => [
          offset + 1,
          {
            uid: offset + 1,
            flags: new Set<string>(),
            messageId,
            internalDate: new Date(1_699_000_000_000 + offset),
          },
        ]),
      ),
    });
  }

  const commands: FakeCommand[] = [];
  const locks: { readonly path: string; readonly readOnly: boolean }[] = [];
  let selected: FakeMailbox | null = null;
  let selectedReadOnly = false;

  const require = (path: string): FakeMailbox => {
    const found =
      mailboxes.get(path) ??
      (path.toUpperCase() === "INBOX" ? mailboxes.get("INBOX") : undefined);
    if (!found) throw new Error(`no such mailbox ${path}`);
    return found;
  };
  const current = (): FakeMailbox => {
    if (selected === null) throw new Error("no mailbox selected");
    return selected;
  };

  const client = {
    secureConnection: true,
    authenticated: true,
    capabilities,
    get mailbox(): MailboxObject | false {
      if (selected === null) return false;
      return {
        path: selected.path,
        delimiter: ".",
        flags: new Set<string>(),
        uidValidity: selected.uidValidity,
        uidNext: selected.uidNext,
        exists: selected.messages.size,
        ...(options?.permanentFlags === undefined
          ? {}
          : { permanentFlags: new Set(options.permanentFlags) }),
        readOnly: selectedReadOnly || options?.readOnly === true,
      };
    },
    connect: async () => undefined,
    close: () => undefined,
    on: () => client,
    unbind: () => {
      throw new Error("not used");
    },
    async getMailboxLock(path: string, lockOptions?: { readonly readOnly?: boolean }) {
      const target = require(path);
      selected = target;
      selectedReadOnly = lockOptions?.readOnly === true;
      locks.push({ path: target.path, readOnly: selectedReadOnly });
      return {
        path: target.path,
        release: () => {
          selected = null;
        },
      };
    },
    async fetchAll(
      range: string | number | readonly number[],
      _query: unknown,
      fetchOptions?: { readonly uid?: boolean },
    ): Promise<FetchMessageObject[]> {
      if (fetchOptions?.uid !== true) throw new Error("sequence fetch not modelled");
      const uids =
        typeof range === "number"
          ? [range]
          : Array.isArray(range)
            ? [...range]
            : String(range).split(":").map(Number);
      return uids.flatMap((uid) => {
        const message = current().messages.get(uid);
        return message === undefined ? [] : [projected(message)];
      });
    },
    async list() {
      commands.push({ name: "list" });
      return [...mailboxes.values()]
        .filter((entry) => entry.path !== "INBOX")
        .map((entry) => ({
          path: entry.path,
          pathAsListed: entry.path,
          name: entry.path.split(".").at(-1) ?? entry.path,
          delimiter: ".",
          parent: [],
          parentPath: "",
          flags: new Set<string>(),
          ...(entry.specialUse === undefined ? {} : { specialUse: entry.specialUse }),
          listed: true,
          subscribed: true,
        }));
    },
    async search(
      query: { readonly header?: Record<string, string> },
      searchOptions?: { readonly uid?: boolean },
    ) {
      if (searchOptions?.uid !== true) throw new Error("sequence search not modelled");
      const messageId = query.header?.["message-id"] ?? "";
      commands.push({ name: "search", mailbox: current().path, messageId });
      return [...current().messages.values()]
        .filter((message) => message.messageId === messageId)
        .map((message) => message.uid);
    },
    async messageFlagsAdd(
      range: readonly number[],
      flags: string[],
      storeOptions?: { readonly uid?: boolean },
    ) {
      return store(range, flags, storeOptions, true);
    },
    async messageFlagsRemove(
      range: readonly number[],
      flags: string[],
      storeOptions?: { readonly uid?: boolean },
    ) {
      return store(range, flags, storeOptions, false);
    },
    async messageMove(
      range: readonly number[],
      destination: string,
      moveOptions?: { readonly uid?: boolean },
    ) {
      if (moveOptions?.uid !== true) throw new Error("sequence move not modelled");
      const source = current();
      const uid = range[0]!;
      commands.push({ name: "move", mailbox: source.path, uid, destination });
      if (options?.dropDuringMove === true) throw new Error("socket closed");
      if (options?.refuseMove === true) return false as const;
      const target = require(destination);
      const message = source.messages.get(uid);
      if (message === undefined) return false as const;
      source.messages.delete(uid);
      const nextUid = target.uidNext;
      target.uidNext += 1;
      target.messages.set(nextUid, { ...message, uid: nextUid });
      return {
        path: source.path,
        destination: target.path,
        ...(uidplus
          ? {
              uidValidity: target.uidValidity,
              uidMap: new Map([[uid, nextUid]]),
            }
          : {}),
      };
    },
  };

  function store(
    range: readonly number[],
    flags: readonly string[],
    storeOptions: { readonly uid?: boolean } | undefined,
    add: boolean,
  ): boolean {
    if (storeOptions?.uid !== true) throw new Error("sequence store not modelled");
    const mailbox = current();
    const uid = range[0]!;
    commands.push({ name: "store", mailbox: mailbox.path, uid, flags: [...flags], add });
    if (options?.refuseStore === true) return false;
    const message = mailbox.messages.get(uid);
    // RFC 3501: UID STORE against a UID that is no longer there is a silent
    // success, so the caller learns nothing from the command itself.
    if (message === undefined) return true;
    for (const flag of flags) {
      if (add) message.flags.add(flag);
      else message.flags.delete(flag);
    }
    return true;
  }

  return {
    commands,
    locks,
    client: client as unknown as ImapSessionClient,
    mailbox: require,
  };
}

function projected(message: FakeMessage): FetchMessageObject {
  return {
    seq: message.uid,
    uid: message.uid,
    flags: new Set(message.flags),
    internalDate: message.internalDate,
    envelope: {
      subject: "Subject",
      messageId: message.messageId,
      from: [{ name: "Sender", address: "sender@example.test" }],
      to: [{ address: "reader@example.test" }],
    },
    bodyStructure: { type: "text/plain" },
  } as FetchMessageObject;
}

function providerFor(server: FakeServer) {
  /* Every session is a TCP connect, a TLS handshake and an AUTH on the wire,
     so how many were opened is part of what a test can assert. */
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
    provider: new ImapMailSyncAdapter(accountFixture(), sessions),
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
