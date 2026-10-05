import type { FetchMessageObject, MailboxObject } from "imapflow";
import { describe, expect, it, vi } from "vitest";

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

  it("creates a top-level Archive when the server lists none, then moves into it", async () => {
    // A folder literally named Archive at the account root is where every
    // mail client looks, so inventing this one destination is not a guess.
    const server = serverFixture({
      mailboxes: [{ path: "Sent" }, { path: "Trash", specialUse: "\\Trash" }],
    });
    const { provider, opened } = providerFor(server);

    await provider.archiveThread("i77u1", signal());

    expect(
      server.commands
        .filter((command) => command.name !== "store" && command.name !== "search")
        .map((command) =>
          command.name === "move" ? `move ${command.destination}` : commandLabel(command),
        ),
    ).toEqual(["list", "create Archive", "list", "move Archive"]);
    expect(server.mailbox("INBOX").messages.has(1)).toBe(false);
    expect(server.mailbox("Archive").messages.size).toBe(1);
    expect(opened.count).toBe(1);
  });

  it("creates the Archive under the Inbox on a server that files everything there", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "INBOX.Sent" }, { path: "INBOX.Trash", specialUse: "\\Trash" }],
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());

    expect(server.commands).toContainEqual({ name: "create", path: "INBOX.Archive" });
    expect(server.mailbox("INBOX.Archive").messages.size).toBe(1);
  });

  it("treats a folder another client created first (created: false) as success and subscribes to it", async () => {
    // Another client created the folder between our LIST and our CREATE.
    // ImapFlow reports the server's ALREADYEXISTS as `created: false` and
    // subscribes only what it created itself, so this is the one case where
    // the adapter sends the SUBSCRIBE.
    const server = serverFixture({
      mailboxes: [{ path: "Sent" }],
      createAnswers: "already_exists",
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());

    expect(server.commands).toContainEqual({ name: "create", path: "Archive" });
    expect(server.commands).toContainEqual({ name: "subscribe", path: "Archive" });
    expect(server.commands.filter((command) => command.name === "list")).toHaveLength(2);
    expect(server.mailbox("Archive").messages.size).toBe(1);
  });

  it("refuses when CREATE fails, and tries CREATE once per adapter", async () => {
    const server = serverFixture({
      mailboxes: [{ path: "Sent" }],
      createAnswers: "no",
    });
    const { provider, opened } = providerFor(server);

    // The first refusal is the server declining the CREATE it was sent. The
    // second never reaches the server: LIST has answered and the one attempt
    // is spent, so the adapter refuses from what it already knows.
    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "archive_create_refused",
    });
    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "role_refused_cached",
    });

    expect(server.commands.filter((command) => command.name === "create")).toHaveLength(1);
    expect(server.commands.some((command) => command.name === "move")).toBe(false);
    expect(server.mailbox("INBOX").messages.has(1)).toBe(true);
    expect(opened.count).toBe(1);
  });

  it("archives into a folder named in the owner's language, and creates nothing", async () => {
    // A server that lists folders over XLIST has no \\Archive attribute to
    // give, and one that names its folders in the account's language lists
    // the archive as "Архив". CREATE "Archive" there is refused, so reading
    // the name is the only way the button works.
    const server = serverFixture({
      mailboxes: [{ path: "Отправленные" }, { path: "Архив" }],
      createAnswers: "no",
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());

    expect(server.commands.some((command) => command.name === "create")).toBe(false);
    expect(server.mailbox("Архив").messages.size).toBe(1);
    expect(server.mailbox("INBOX").messages.has(1)).toBe(false);
  });

  it("never moves mail into a folder whose role was only guessed from its name", async () => {
    // What ImapFlow's LIST hands back on a server that states no attribute:
    // a `Projects.Acme.Archive` with `specialUse: "\\Archive"` it guessed from
    // the leaf name, and a trash guessed the same way. The owner's Inbox mail
    // used to be archived into that project folder.
    const server = serverFixture({
      mailboxes: [
        { path: "Projects.Acme.Archive", guessedUse: "\\Archive" },
        { path: "Projects.Acme.Trash", guessedUse: "\\Trash" },
      ],
    });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());

    // No stated archive and none by name at the root, so one is created there.
    expect(server.commands).toContainEqual({ name: "create", path: "Archive" });
    expect(server.mailbox("Archive").messages.size).toBe(1);
    expect(server.mailbox("Projects.Acme.Archive").messages.size).toBe(0);
    // Trash is never invented: the role is refused, and nothing moves.
    await expect(provider.trashThread("i77u1", signal())).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
    });
    expect(server.mailbox("Projects.Acme.Trash").messages.size).toBe(0);
  });

  it("asks the server again once a remembered refusal is ten minutes old", async () => {
    let clock = 1_800_000_000_000;
    const server = serverFixture({ mailboxes: [{ path: "Sent" }], createAnswers: "no" });
    const { provider } = providerFor(server, () => clock);

    await expect(provider.archiveThread("i77u1", signal())).rejects.toMatchObject({
      reason: "archive_create_refused",
    });
    // The owner makes the folder in another client. Inside the window the
    // adapter still answers from what it knows, without a session.
    server.addMailbox("Archive");
    clock += 9 * 60_000;
    await expect(provider.archiveThread("i77u1", signal())).rejects.toMatchObject({
      reason: "role_refused_cached",
    });

    // Past it, LIST is asked again and the new folder is found.
    clock += 60_000 + 1;
    await provider.archiveThread("i77u1", signal());

    expect(server.mailbox("Archive").messages.size).toBe(1);
    expect(server.commands.filter((command) => command.name === "list")).toHaveLength(2);
  });

  it("spends a second CREATE only after the refusal has aged out", async () => {
    let clock = 1_800_000_000_000;
    const server = serverFixture({ mailboxes: [{ path: "Sent" }], createAnswers: "no" });
    const { provider } = providerFor(server, () => clock);

    await expect(provider.archiveThread("i77u1", signal())).rejects.toMatchObject({
      reason: "archive_create_refused",
    });
    clock += 10 * 60_000 + 1;
    await expect(provider.archiveThread("i77u1", signal())).rejects.toMatchObject({
      reason: "archive_create_refused",
    });

    expect(server.commands.filter((command) => command.name === "create")).toHaveLength(2);
  });

  it("refuses, after one CREATE and two LISTs, when the created folder never shows up", async () => {
    // A server that says OK to the CREATE and then hides the folder from LIST
    // is not a server this adapter can archive into. Without the once-per-adapter
    // flag the fresh LIST would lead to another CREATE, and that to another
    // LIST, with nothing to stop it.
    const server = serverFixture({
      mailboxes: [{ path: "Sent" }],
      hideCreated: true,
    });
    const { provider } = providerFor(server);

    // The CREATE was accepted, so this is not a refused CREATE: the second
    // LIST names no archive and the one attempt is already spent.
    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "no_mailbox_for_role",
    });

    expect(server.commands.filter((command) => command.name === "create")).toHaveLength(1);
    expect(server.commands.filter((command) => command.name === "list")).toHaveLength(2);
    expect(server.commands.some((command) => command.name === "move")).toBe(false);
    expect(server.mailbox("INBOX").messages.has(1)).toBe(true);
  });

  it("writes one mail_imap_archive_create record per CREATE, naming how the server answered", async () => {
    // The 409 alone cannot say whether the adapter ever asked for the folder.
    // This record is the other half of that diagnosis: it exists only when a
    // CREATE went out, and it says what came back.
    for (const [createAnswers, outcome] of [
      ["created", "created"],
      ["already_exists", "already_there"],
      ["no", "refused"],
    ] as const) {
      const server = serverFixture({
        mailboxes: [{ path: "Sent" }],
        createAnswers,
      });
      const { provider } = providerFor(server);
      const written = captureStderr();
      try {
        await provider.archiveThread("i77u1", signal()).catch(() => undefined);
      } finally {
        written.restore();
      }

      expect(written.records()).toEqual([
        { event: "mail_imap_archive_create", accountId: ACCOUNT_ID, reason: outcome },
      ]);
    }
  });

  it("writes no mail_imap_archive_create record when no CREATE was sent", async () => {
    const server = serverFixture({ mailboxes: [{ path: "Sent" }] });
    const { provider } = providerFor(server);
    const written = captureStderr();
    try {
      await provider.trashThread("i77u1", signal()).catch(() => undefined);
    } finally {
      written.restore();
    }

    expect(written.records()).toEqual([]);
  });

  it("treats a throttled CREATE as unavailable, not as a refusal", async () => {
    // A tagged NO that asks the client to wait is the server's mood, not its
    // verdict on the folder; read as a refusal it would burn the one CREATE
    // this adapter gets and refuse the account until a restart.
    const server = serverFixture({
      mailboxes: [{ path: "Sent" }],
      createAnswers: "throttle",
    });
    const { provider, opened } = providerFor(server);

    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_unavailable" });
    await provider.archiveThread("i77u1", signal());

    expect(opened.count).toBe(2);
    expect(server.commands.filter((command) => command.name === "create")).toHaveLength(2);
    expect(server.mailbox("Archive").messages.size).toBe(1);
  });

  it("reports a session that died under CREATE as unavailable and tries again next time", async () => {
    // No answer is not a refusal. The adapter is long-lived, so a 409 here
    // would refuse the account from cache until a restart over a socket that
    // happened to close; the next session asks LIST again and CREATEs again.
    const server = serverFixture({
      mailboxes: [{ path: "Sent" }],
      createAnswers: "drop",
    });
    const { provider, opened } = providerFor(server);

    await expect(
      provider.archiveThread("i77u1", signal()),
    ).rejects.toMatchObject({ code: "mail_provider_unavailable" });
    expect(server.mailbox("INBOX").messages.has(1)).toBe(true);

    await provider.archiveThread("i77u1", signal());

    expect(opened.count).toBe(2);
    expect(server.commands.filter((command) => command.name === "create")).toHaveLength(2);
    expect(server.mailbox("Archive").messages.size).toBe(1);
  });

  it("still refuses trash on a server without a trash folder, and creates nothing", async () => {
    const server = serverFixture({ mailboxes: [{ path: "Sent" }] });
    const { provider } = providerFor(server);

    await expect(
      provider.trashThread("i77u1", signal()),
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "no_mailbox_for_role",
    });

    expect(server.commands.some((command) => command.name === "create")).toBe(false);
    expect(server.commands.some((command) => command.name === "move")).toBe(false);
    expect(server.mailbox("INBOX").messages.has(1)).toBe(true);
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
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "move_capability_missing",
    });

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
      provider.trashThread("i77u1", signal()),
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "no_mailbox_for_role",
    });
    expect(opened.count).toBe(1);

    // LIST has already answered for this account. Connecting again to say the
    // same no is a login per thread for a whole section Done.
    await expect(
      provider.trashThread("i77u1", signal()),
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "role_refused_cached",
    });
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
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "move_answered_no",
    });

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
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "flag_not_permanent",
    });

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
    ).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "mailbox_read_only",
    });

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
    // mail client creates an Archive, so that is where one is created instead.
    const server = serverFixture({ mailboxes: [{ path: "Projects.2019.Archive" }] });
    const { provider } = providerFor(server);

    await provider.archiveThread("i77u1", signal());

    expect(server.commands).toContainEqual({ name: "create", path: "Archive" });
    expect(server.mailbox("Projects.2019.Archive").messages.size).toBe(0);
    expect(server.mailbox("Archive").messages.size).toBe(1);
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

describe("IMAP batch archive", () => {
  const ids = (count: number) => Array.from({ length: count }, (_value, index) => `i77u${index + 1}`);
  const batch = (threadIds: readonly string[], read = true) => ({
    threads: threadIds.map((threadId) => ({ threadId, messages: null })),
    read,
    cursor: null,
  });

  it("flags and moves fifteen threads on one session: one STORE, one MOVE", async () => {
    const server = serverFixture({
      inboxCount: 15,
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const { provider, opened } = providerFor(server);
    const uids = Array.from({ length: 15 }, (_value, index) => index + 1);

    const outcomes = await provider.archiveThreads(batch(ids(15)), signal());

    // The per-thread path is two sessions a thread: thirty logins.
    expect(opened.count).toBe(1);
    expect(server.commands).toEqual([
      { name: "list" },
      { name: "store", mailbox: "INBOX", uids, flags: ["\\Seen"], add: true },
      { name: "move", mailbox: "INBOX", uids, destination: "Archive" },
    ]);
    expect(server.mailbox("INBOX").messages.size).toBe(0);
    expect([...server.mailbox("Archive").messages.values()].every((m) => m.flags.has("\\Seen"))).toBe(
      true,
    );
    expect([...outcomes.keys()]).toEqual(ids(15));
    expect(outcomes.get("i77u3")).toMatchObject({
      status: "done",
      markedRead: true,
      thread: { inInbox: false, thread: { threadId: "i77u3", unread: false } },
    });
    // The handle is kept: the take-back of one thread finds it in Archive.
    await provider.unarchiveThread("i77u3", signal());
    expect(server.mailbox("INBOX").messages.size).toBe(1);
  });

  it("sends no STORE without `read`, or when every message is already seen", async () => {
    const unread = serverFixture({ inboxCount: 2, mailboxes: [{ path: "Archive", specialUse: "\\Archive" }] });
    await providerFor(unread).provider.archiveThreads(batch(ids(2), false), signal());
    const seen = serverFixture({
      inboxCount: 2,
      inboxFlags: ["\\Seen"],
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const outcomes = await providerFor(seen).provider.archiveThreads(batch(ids(2)), signal());

    for (const server of [unread, seen]) {
      expect(server.commands.map((command) => command.name)).toEqual(["list", "move"]);
    }
    expect(outcomes.get("i77u1")).toMatchObject({ status: "done", markedRead: false });
  });

  it("refuses the whole batch, before any flag, on an account with no archive to move into", async () => {
    const server = serverFixture({ inboxCount: 3, createAnswers: "no" });
    const { provider, opened } = providerFor(server);

    await expect(provider.archiveThreads(batch(ids(3)), signal())).rejects.toMatchObject({
      code: "mail_provider_mutation_unsupported",
      reason: "archive_create_refused",
    });
    expect(server.commands.some((command) => command.name === "store")).toBe(false);
    // The refusal is remembered, and the next batch opens no session for it.
    await expect(provider.archiveThreads(batch(ids(3)), signal())).rejects.toMatchObject({
      reason: "role_refused_cached",
    });
    expect(opened.count).toBe(1);
  });

  it("takes the flag back when the server refuses the MOVE", async () => {
    const server = serverFixture({
      inboxCount: 2,
      refuseMove: true,
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });

    await expect(
      providerFor(server).provider.archiveThreads(batch(ids(2)), signal()),
    ).rejects.toMatchObject({ code: "mail_provider_mutation_unsupported", reason: "move_answered_no" });
    expect(server.commands.at(-1)).toEqual({
      name: "store",
      mailbox: "INBOX",
      uids: [1, 2],
      flags: ["\\Seen"],
      add: false,
    });
    expect([...server.mailbox("INBOX").messages.values()].some((m) => m.flags.has("\\Seen"))).toBe(
      false,
    );
  });

  it("reports stale a message COPYUID does not name, and one gone before the batch", async () => {
    const server = serverFixture({
      inboxCount: 4,
      vanishBeforeMove: 2,
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    server.mailbox("INBOX").messages.delete(4);

    const outcomes = await providerFor(server).provider.archiveThreads(batch(ids(4)), signal());

    expect([...outcomes].map(([threadId, outcome]) => [threadId, outcome.status])).toEqual([
      ["i77u4", "stale"],
      ["i77u1", "done"],
      ["i77u2", "stale"],
      ["i77u3", "done"],
    ]);
  });

  it("finds each moved message by Message-ID on a server without UIDPLUS, in the same session", async () => {
    const server = serverFixture({
      inboxCount: 2,
      uidplus: false,
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const { provider, opened } = providerFor(server);

    const outcomes = await provider.archiveThreads(batch(ids(2)), signal());

    expect(opened.count).toBe(1);
    expect(server.commands.filter((command) => command.name === "search")).toHaveLength(2);
    expect(outcomes.get("i77u2")).toMatchObject({ status: "done", thread: { inInbox: false } });
    await provider.unarchiveThread("i77u2", signal());
    expect([...server.mailbox("INBOX").messages.values()].map((m) => m.messageId)).toEqual([
      "<message-2@example.test>",
    ]);
  });

  it("leaves a thread it has already moved to the per-thread path", async () => {
    const server = serverFixture({
      inboxCount: 2,
      mailboxes: [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const { provider } = providerFor(server);
    await provider.archiveThread("i77u1", signal());

    const outcomes = await provider.archiveThreads(batch(ids(2)), signal());

    expect([...outcomes.keys()]).toEqual(["i77u2"]);
  });
});

type FakeCommand =
  | { readonly name: "list" }
  | { readonly name: "create"; readonly path: string }
  | { readonly name: "subscribe"; readonly path: string }
  | { readonly name: "search"; readonly mailbox: string; readonly messageId: string }
  | {
      readonly name: "store";
      readonly mailbox: string;
      readonly uid: number;
      readonly flags: readonly string[];
      readonly add: boolean;
    }
  | {
      readonly name: "store";
      readonly mailbox: string;
      readonly uids: readonly number[];
      readonly flags: readonly string[];
      readonly add: boolean;
    }
  | {
      readonly name: "move";
      readonly mailbox: string;
      readonly uid: number;
      readonly destination: string;
    }
  | {
      readonly name: "move";
      readonly mailbox: string;
      readonly uids: readonly number[];
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
  readonly guessedUse?: string;
  uidValidity: bigint;
  uidNext: number;
  readonly messages: Map<number, FakeMessage>;
}

interface FakeServer {
  readonly commands: FakeCommand[];
  readonly locks: { readonly path: string; readonly readOnly: boolean }[];
  readonly client: ImapSessionClient;
  mailbox(path: string): FakeMailbox;
  /** Another client (a webmail, a phone) makes a folder behind the adapter's back. */
  addMailbox(path: string): void;
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
    /** A SPECIAL-USE or XLIST attribute the server states for the folder. */
    readonly specialUse?: string;
    /** A role ImapFlow guessed from the folder's name; the server states none. */
    readonly guessedUse?: string;
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
  /**
   * What CREATE answers. `already_exists` is the ALREADYEXISTS a server gives
   * when another client made the folder first, which ImapFlow hands back as
   * `created: false`; the folder is there from then on either way. `no` is a
   * refusal, as an ACL or a quota would give, in the shape ImapFlow gives a
   * tagged NO. `drop` is a session that dies under the first CREATE with no
   * answer at all, ImapFlow's `NoConnection`; the next session finds the
   * server well.
   */
  readonly createAnswers?: "created" | "already_exists" | "no" | "drop" | "throttle";
  /** CREATE answers OK, and LIST still does not show the folder afterwards. */
  readonly hideCreated?: boolean;
  /** How many messages the Inbox holds, at UIDs 1 to n. One by default. */
  readonly inboxCount?: number;
  /** This Inbox UID is expunged by another client just before a MOVE. */
  readonly vanishBeforeMove?: number;
}): FakeServer {
  const uidplus = options?.uidplus ?? true;
  const capabilities = new Map<string, boolean | number>([["IMAP4rev1", true]]);
  if (options?.move !== false) capabilities.set("MOVE", true);
  if (uidplus) capabilities.set("UIDPLUS", true);
  const mailboxes = new Map<string, FakeMailbox>();
  const inboxCount = options?.inboxCount ?? 1;
  mailboxes.set("INBOX", {
    path: "INBOX",
    uidValidity: UID_VALIDITY,
    uidNext: inboxCount + 1,
    messages: new Map(
      Array.from({ length: inboxCount }, (_value, index) => [
        index + 1,
        {
          uid: index + 1,
          flags: new Set(options?.inboxFlags ?? []),
          messageId: `<message-${index + 1}@example.test>`,
          internalDate: new Date(1_700_000_000_000 + index),
        },
      ]),
    ),
  });
  for (const [index, entry] of (options?.mailboxes ?? []).entries()) {
    const seeded = entry.messageIds ?? [];
    mailboxes.set(entry.path, {
      path: entry.path,
      ...(entry.specialUse === undefined ? {} : { specialUse: entry.specialUse }),
      ...(entry.guessedUse === undefined ? {} : { guessedUse: entry.guessedUse }),
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
          // As ImapFlow lists it: a stated attribute is among the flags and
          // repeated as `specialUse`; a guessed one is in `specialUse` alone.
          flags: new Set<string>(entry.specialUse === undefined ? [] : [entry.specialUse]),
          ...(entry.specialUse === undefined && entry.guessedUse === undefined
            ? {}
            : { specialUse: entry.specialUse ?? entry.guessedUse }),
          listed: true,
          subscribed: true,
        }));
    },
    async mailboxCreate(path: string) {
      commands.push({ name: "create", path });
      const answer = options?.createAnswers ?? "created";
      if (answer === "no") {
        throw Object.assign(new Error("Command failed"), {
          response: "NO [CANNOT] Permission denied",
          responseStatus: "NO",
          serverResponseCode: "CANNOT",
        });
      }
      if (
        answer === "drop" &&
        commands.filter((command) => command.name === "create").length === 1
      ) {
        throw Object.assign(new Error("Connection not available"), {
          code: "NoConnection",
        });
      }
      if (
        answer === "throttle" &&
        commands.filter((command) => command.name === "create").length === 1
      ) {
        // ImapFlow's shape for a tagged NO that says "wait": the server did
        // answer, but not about the folder.
        throw Object.assign(new Error("Too many requests, wait 5 seconds"), {
          code: "ETHROTTLE",
          response: { command: "NO" },
          responseStatus: "NO",
          throttleReset: 5000,
        });
      }
      if (!mailboxes.has(path) && options?.hideCreated !== true) {
        mailboxes.set(path, {
          path,
          uidValidity: BigInt(900 + mailboxes.size),
          uidNext: 1,
          messages: new Map(),
        });
      }
      return { path, created: answer === "created" };
    },
    async mailboxSubscribe(path: string) {
      commands.push({ name: "subscribe", path });
      return true;
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
      commands.push(
        range.length === 1
          ? { name: "move", mailbox: source.path, uid: range[0]!, destination }
          : { name: "move", mailbox: source.path, uids: [...range], destination },
      );
      if (options?.dropDuringMove === true) throw new Error("socket closed");
      if (options?.refuseMove === true) return false as const;
      // Another client expunges this one between the batch's FETCH and its MOVE.
      if (options?.vanishBeforeMove !== undefined) {
        source.messages.delete(options.vanishBeforeMove);
      }
      const target = require(destination);
      const uidMap = new Map<number, number>();
      for (const uid of range) {
        const message = source.messages.get(uid);
        if (message === undefined) continue;
        source.messages.delete(uid);
        const nextUid = target.uidNext;
        target.uidNext += 1;
        target.messages.set(nextUid, { ...message, uid: nextUid });
        uidMap.set(uid, nextUid);
      }
      if (uidMap.size === 0) return false as const;
      return {
        path: source.path,
        destination: target.path,
        ...(uidplus ? { uidValidity: target.uidValidity, uidMap } : {}),
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
    commands.push(
      range.length === 1
        ? { name: "store", mailbox: mailbox.path, uid: range[0]!, flags: [...flags], add }
        : { name: "store", mailbox: mailbox.path, uids: [...range], flags: [...flags], add },
    );
    if (options?.refuseStore === true) return false;
    for (const uid of range) {
      const message = mailbox.messages.get(uid);
      // RFC 3501: UID STORE against a UID that is no longer there is a silent
      // success, so the caller learns nothing from the command itself.
      if (message === undefined) continue;
      for (const flag of flags) {
        if (add) message.flags.add(flag);
        else message.flags.delete(flag);
      }
    }
    return true;
  }

  return {
    commands,
    locks,
    client: client as unknown as ImapSessionClient,
    mailbox: require,
    addMailbox(path: string) {
      mailboxes.set(path, {
        path,
        uidValidity: BigInt(900 + mailboxes.size),
        uidNext: 1,
        messages: new Map(),
      });
    },
  };
}

/** `list`, `create Archive`, `subscribe Archive`: the wire order in one line. */
function commandLabel(command: FakeCommand): string {
  return "path" in command ? `${command.name} ${command.path}` : command.name;
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

function providerFor(server: FakeServer, now?: () => number) {
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
    provider: new ImapMailSyncAdapter(
      accountFixture(),
      sessions,
      now === undefined ? {} : { now },
    ),
    opened,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** The mail log writes projected records to stderr, one JSON line each. */
function captureStderr() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
  return {
    records: () =>
      lines
        .filter((line) => line.includes("mail_imap_archive_create"))
        .map((line) => JSON.parse(line) as unknown),
    restore: () => spy.mockRestore(),
  };
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
