import { createRequire } from "node:module";
import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import {
  createSecureContext,
  createServer as createTlsServer,
  TLSSocket,
  type Server as TlsServer,
} from "node:tls";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailDnsResolverPort, ValidatedMailDialTarget } from "../ports";
import {
  ImapMailSyncAdapter,
  resolveImapMailboxRole,
  selectImapMailboxPath,
} from "../providers/imap/sync-adapter";
import type { MultiMailAccountStore } from "./account-store";
import type { StoredImapMailAccount } from "./account-types";
import type { MailSentScanResult } from "./senders";
import { MailImapIdleSupervisor } from "./imap-idle";
import {
  ImapFlowCredentialVerifier,
  ImapFlowReadSessionFactory,
} from "./imapflow-adapter";

const require = createRequire(import.meta.url);
const testTls = require("imapflow/test/fixtures/test-tls.js") as {
  readonly cert: string;
  readonly key: string;
};
const servers: Array<NetServer | TlsServer> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("ImapFlow verifier against a real fake IMAP server", () => {
  it("authenticates over implicit TLS and proves the observed peer", async () => {
    const commands: string[] = [];
    const server = createTlsServer(testTls, (socket) => {
      serveAuthenticatedImap(socket, commands);
    });
    const port = await listen(server);

    await expect(verifierFor(port, "implicit").verify(requestFor(port, "implicit")))
      .resolves.toBeUndefined();

    expect(commandNames(commands)).toEqual([
      "CAPABILITY",
      "LOGIN",
      "CAPABILITY",
      "LIST",
    ]);
    expect(commands.find((line) => line.includes("LOGIN"))).toContain(
      "test-only-password",
    );
  });

  it("never sends credentials before a required STARTTLS upgrade", async () => {
    const plaintextCommands: string[] = [];
    const encryptedCommands: string[] = [];
    const secureContext = createSecureContext(testTls);
    const server = createNetServer((socket) => {
      serveStartTlsImap(
        socket,
        secureContext,
        plaintextCommands,
        encryptedCommands,
      );
    });
    const port = await listen(server);

    await expect(verifierFor(port, "starttls").verify(requestFor(port, "starttls")))
      .resolves.toBeUndefined();

    expect(commandNames(plaintextCommands)).toEqual(["CAPABILITY", "STARTTLS"]);
    expect(plaintextCommands.join("\n")).not.toContain("test-only-password");
    expect(commandNames(encryptedCommands)).toEqual([
      "CAPABILITY",
      "LOGIN",
      "CAPABILITY",
      "LIST",
    ]);
  });
});

describe("IMAP IDLE against a real ImapFlow session", () => {
  it("examines INBOX, idles, and leaves IDLE with DONE and one pass on EXISTS", async () => {
    const commands: string[] = [];
    let session: TLSSocket | undefined;
    const server = createTlsServer(testTls, (socket) => {
      session = socket;
      serveIdleImap(socket, commands);
    });
    const port = await listen(server);
    const passes: string[] = [];
    const events: unknown[] = [];
    const account = imapAccountFor(port);
    const supervisor = new MailImapIdleSupervisor({
      connector: new ImapFlowReadSessionFactory({
        dns: { resolve: async () => [targetFor(port, "implicit")] },
        store: storeFor(account),
        createClient: () => {
          throw new Error("no read session in this test");
        },
        createIdleClient: (options: ImapFlowOptions) =>
          new ImapFlow({ ...options, tls: { ...options.tls, ca: testTls.cert } }),
      }),
      onChange: (accountId) => passes.push(accountId),
      onEvent: (record) => events.push(record),
    });
    supervisor.start();
    const accountId = account.account.accountId;

    try {
      supervisor.afterSync(accountId);
      await vi.waitFor(() => expect(passes).toEqual([accountId]));
      supervisor.afterSync(accountId);
      await vi.waitFor(() => expect(commandNames(commands).at(-1)).toBe("IDLE"));

      session?.write("* 5 EXISTS\r\n");
      await vi.waitFor(() => expect(passes).toEqual([accountId, accountId]));
      supervisor.afterSync(accountId);
      await vi.waitFor(() =>
        expect(commandNames(commands).filter((name) => name === "IDLE")).toHaveLength(2),
      );
    } finally {
      await supervisor.stop();
    }

    // DONE is the one untagged line the client sends.
    const names = commands.map((line) =>
      line === "DONE" ? "DONE" : commandNames([line])[0],
    );
    // Read-only from start to end: EXAMINE, never SELECT, and nothing that
    // stores a flag, moves or expunges. LIST and LSUB are how ImapFlow finds
    // the path it opens.
    expect(
      names
        .slice(names.indexOf("LOGIN"))
        .filter((name) => !["CAPABILITY", "LIST", "LSUB"].includes(name ?? "")),
    ).toEqual(["LOGIN", "EXAMINE", "IDLE", "DONE", "NOOP", "IDLE"]);
    expect(commands.find((line) => line.includes("EXAMINE"))).toMatch(/EXAMINE "?INBOX"?/);
    expect(events).toEqual([{ event: "mail_imap_idle_connected", accountId }]);
  });
});

describe("the Sent-folder scan against a real ImapFlow session", () => {
  it("examines the Sent mailbox and fetches envelopes only, and nothing that writes", async () => {
    const person = imapAddress("Person", "person", "example.test");
    const { adapter, commands } = await sentScanAdapter({
      capability: "IMAP4rev1 SPECIAL-USE",
      folders: [{ flags: "\\HasNoChildren \\Sent", path: "Outgoing" }],
      exists: 2,
      uidNext: 13,
      fetch: () =>
        `* 1 FETCH (UID 11 ENVELOPE ${imapEnvelope({
          from: person,
          to: imapAddress("Lena", "lena", "example.org"),
          cc: imapAddress("Boss", "boss", "example.org"),
          bcc: imapAddress("Hidden", "hidden", "example.org"),
        })})\r\n` +
        `* 2 FETCH (UID 12 ENVELOPE ${imapEnvelope({
          from: imapAddress("Person", "alias", "example.test"),
          to: `${imapAddress("Team", "team", "example.org")} ${imapAddress("Lena", "LENA", "Example.org")}`,
        })})\r\n`,
    });

    const result = await adapter.scanSentEnvelopes(
      { cursor: null },
      new AbortController().signal,
    );

    expect(result).toEqual({
      status: "scanned",
      cursor: "s1_77_12_0_0_0",
      envelopes: [
        { from: "person@example.test", recipients: ["lena@example.org", "boss@example.org"] },
        { from: "alias@example.test", recipients: ["team@example.org", "lena@example.org"] },
      ],
      envelopeCount: 2,
      skippedCount: 0,
      skipReason: null,
      restart: null,
      hasMore: false,
    });
    const names = commandNames(commands);
    // LIST and LSUB are how ImapFlow reads the folders; the rest is the scan.
    expect(
      names
        .slice(names.indexOf("LOGIN"))
        .filter((name) => !["CAPABILITY", "LIST", "LSUB"].includes(name)),
    ).toEqual(["LOGIN", "EXAMINE", "FETCH"]);
    expect(commands.find((line) => line.includes("EXAMINE"))).toMatch(/EXAMINE "?Outgoing"?$/);
    // The whole fetch: two sequence numbers, UID and ENVELOPE. No BODY, no
    // RFC822, no FLAGS, and no item that could set \Seen.
    expect(commands.find((line) => line.includes("FETCH"))).toMatch(
      /^\S+ FETCH 1:2 \(UID ENVELOPE\)$/,
    );
  });
});

describe("what the Sent-folder scan survives on a real ImapFlow session", () => {
  const person = imapAddress("Person", "person", "example.test");
  const letter = (uid: number, to: string, bcc?: string) => ({
    uid,
    envelope: imapEnvelope({
      from: person,
      to: imapAddress("To", to, "example.org"),
      ...(bcc === undefined ? {} : { bcc }),
    }),
  });

  it("passes over a letter whose envelope is longer than the session's line limit, and reads the others", async () => {
    // A Bcc blast: the adapter never reads Bcc, and the server sends it all
    // the same, 2,600 addresses on one line past the session's 64 KiB.
    const blast = Array.from({ length: 2_600 }, (_value, index) =>
      imapAddress("X", `recipient${index}`, "example.org"),
    ).join(" ");
    const { adapter, commands } = await sentScanAdapter({
      capability: "IMAP4rev1 SPECIAL-USE",
      folders: [{ flags: "\\HasNoChildren \\Sent", path: "Sent" }],
      uidNext: 14,
      messages: [letter(11, "a"), letter(12, "b", blast), letter(13, "c")],
    });

    const outcomes: MailSentScanResult[] = [];
    let cursor: string | null = null;
    for (let window = 0; window < 8; window += 1) {
      const result = await adapter.scanSentEnvelopes({ cursor }, new AbortController().signal);
      outcomes.push(result);
      if (result.status !== "scanned") continue;
      cursor = result.cursor;
      if (!result.hasMore) break;
    }

    // The batch of three fails and is asked for again a letter at a time,
    // newest first: the third is read, the second is the one, the first is read.
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "batch_failed",
      "scanned",
      "scanned",
      "scanned",
    ]);
    const read = outcomes.flatMap((outcome) =>
      outcome.status === "scanned" ? outcome.envelopes.flatMap((entry) => entry.recipients) : [],
    );
    expect(read.sort()).toEqual(["a@example.org", "c@example.org"]);
    expect(outcomes[2]).toMatchObject({
      skippedCount: 1,
      skipReason: "envelope_line_too_long",
      envelopeCount: 0,
    });
    expect(cursor).toBe("s1_77_13_0_0_0");
    // No range was asked for twice.
    const fetches = commands.filter((line) => / FETCH /.test(line)).map((line) => line.split(" ")[2]);
    expect(fetches).toEqual(["1:3", "3:3", "2:2", "1:1"]);
  });

  it("reads a new letter on the next scan when its first fetch lost the socket", async () => {
    const options: FakeImapOptions = {
      capability: "IMAP4rev1 SPECIAL-USE",
      folders: [{ flags: "\\HasNoChildren \\Sent", path: "Sent" }],
      uidNext: 13,
      messages: [letter(11, "a"), letter(12, "b")],
    };
    const { adapter } = await sentScanAdapter(options);
    const signal = new AbortController().signal;
    const first = await adapter.scanSentEnvelopes({ cursor: null }, signal);
    if (first.status !== "scanned") throw new Error("the first scan read nothing");

    options.messages = [letter(11, "a"), letter(12, "b"), letter(13, "newfriend")];
    options.uidNext = 14;
    options.dropFetches = 1;
    await expect(
      adapter.scanSentEnvelopes({ cursor: first.cursor }, signal),
    ).resolves.toEqual({ status: "batch_failed" });
    await expect(
      adapter.scanSentEnvelopes({ cursor: first.cursor }, signal),
    ).resolves.toMatchObject({
      status: "scanned",
      envelopes: [{ from: "person@example.test", recipients: ["newfriend@example.org"] }],
      skippedCount: 0,
      cursor: "s1_77_13_0_0_0",
    });
  });

  it("steps over a FETCH the server sends about another client's flag change", async () => {
    const { adapter } = await sentScanAdapter({
      capability: "IMAP4rev1 SPECIAL-USE",
      folders: [{ flags: "\\HasNoChildren \\Sent", path: "Sent" }],
      uidNext: 13,
      messages: [letter(11, "a"), letter(12, "b")],
      unsolicited: "* 2 FETCH (FLAGS (\\Seen))\r\n",
    });

    await expect(
      adapter.scanSentEnvelopes({ cursor: null }, new AbortController().signal),
    ).resolves.toMatchObject({ status: "scanned", envelopeCount: 2, hasMore: false });
  });

  it("asks the Sent folder's STATUS on the sync's own session, and logs in for a scan only when there is something to read", async () => {
    const options: FakeImapOptions = {
      capability: "IMAP4rev1 SPECIAL-USE",
      folders: [{ flags: "\\HasNoChildren \\Sent", path: "Sent" }],
      uidNext: 13,
      messages: [letter(11, "a"), letter(12, "b")],
    };
    const { adapter, commands } = await sentScanAdapter(options);
    const signal = new AbortController().signal;
    const logins = () => commandNames(commands).filter((name) => name === "LOGIN").length;
    const syncPass = (anchor: string) =>
      adapter.listChanges({ startHistoryId: anchor, pageToken: null, maxItems: 5 }, signal);

    const anchor = await adapter.getSyncAnchor(signal);
    const first = await adapter.scanSentEnvelopes({ cursor: null }, signal);
    if (first.status !== "scanned") throw new Error("the first scan read nothing");
    expect(logins()).toBe(2);

    // Five windows of a quiet account: five logins, all of them the sync's.
    for (let window = 0; window < 5; window += 1) {
      await syncPass(anchor);
      await expect(
        adapter.scanSentEnvelopes({ cursor: first.cursor }, signal),
      ).resolves.toEqual({ status: "unchanged" });
    }
    expect(logins()).toBe(7);
    expect(
      commands.filter((line) => / STATUS /.test(line)).map((line) => line.replace(/^\S+ /, "")),
    ).toEqual(Array.from({ length: 5 }, () => "STATUS Sent (UIDNEXT UIDVALIDITY)"));
    // The folder itself was opened once, by the first scan.
    expect(commands.filter((line) => / EXAMINE "?Sent"?$/.test(line))).toHaveLength(1);

    // A letter is sent from another client.
    options.messages = [letter(11, "a"), letter(12, "b"), letter(13, "c")];
    options.uidNext = 14;
    await syncPass(anchor);
    await expect(
      adapter.scanSentEnvelopes({ cursor: first.cursor }, signal),
    ).resolves.toMatchObject({
      status: "scanned",
      envelopes: [{ from: "person@example.test", recipients: ["c@example.org"] }],
      cursor: "s1_77_13_0_0_0",
    });
    expect(logins()).toBe(9);
  });

  it("returns the Inbox page of a sync whose Sent STATUS the server never answers, and does not ask again", async () => {
    const options: FakeImapOptions = {
      capability: "IMAP4rev1 SPECIAL-USE",
      folders: [{ flags: "\\HasNoChildren \\Sent", path: "Sent" }],
      uidNext: 13,
      messages: [letter(11, "a"), letter(12, "b")],
    };
    // A session of two seconds: shorter than the wait the STATUS would get
    // on its own, so the wait has to fit what the session has left.
    const { adapter, commands } = await sentScanAdapter(options, 2_000);
    const signal = new AbortController().signal;
    const anchor = await adapter.getSyncAnchor(signal);
    await adapter.scanSentEnvelopes({ cursor: null }, signal);
    const syncPass = () =>
      adapter.listChanges({ startHistoryId: anchor, pageToken: null, maxItems: 5 }, signal);

    options.statusHangs = true;
    const started = Date.now();
    await expect(syncPass()).resolves.toMatchObject({ changedThreadIds: [] });
    // Inside the session's deadline, with the margin it keeps to close in.
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(syncPass()).resolves.toMatchObject({ changedThreadIds: [] });

    // Asked once, on the sync's session and after its Inbox work; the sync
    // that followed did not ask.
    const names = commandNames(commands);
    expect(names.filter((name) => name === "STATUS")).toHaveLength(1);
    expect(names.lastIndexOf("EXAMINE", names.indexOf("STATUS"))).toBeGreaterThan(-1);
    expect(commands[names.lastIndexOf("EXAMINE", names.indexOf("STATUS"))]).toMatch(
      / EXAMINE "?INBOX"?$/,
    );
  });

  it("returns the Inbox page when the Inbox took most of the session and the Sent STATUS hangs", async () => {
    const options: FakeImapOptions = {
      capability: "IMAP4rev1 SPECIAL-USE",
      folders: [{ flags: "\\HasNoChildren \\Sent", path: "Sent" }],
      uidNext: 13,
      messages: [letter(11, "a"), letter(12, "b")],
    };
    const { adapter } = await sentScanAdapter(options, 3_000);
    const signal = new AbortController().signal;
    const anchor = await adapter.getSyncAnchor(signal);
    await adapter.scanSentEnvelopes({ cursor: null }, signal);

    // Two of the session's three seconds go on the Inbox. The STATUS wait is
    // what is left then, less the margin, and not what was left at login.
    options.inboxDelayMs = 2_000;
    options.statusHangs = true;
    await expect(
      adapter.listChanges({ startHistoryId: anchor, pageToken: null, maxItems: 5 }, signal),
    ).resolves.toMatchObject({ changedThreadIds: [] });
  }, 10_000);

  it("asks which UIDs exist before it fetches mail far above the cursor", async () => {
    const { adapter, commands } = await sentScanAdapter({
      capability: "IMAP4rev1 SPECIAL-USE",
      folders: [{ flags: "\\HasNoChildren \\Sent", path: "Sent" }],
      uidNext: 200_001,
      messages: [letter(11, "a"), letter(12, "b"), letter(200_000, "c")],
    });

    const result = await adapter.scanSentEnvelopes(
      { cursor: "s1_77_12_0_0_0" },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: "scanned",
      cursor: "s1_77_200000_0_0_0",
      envelopes: [{ from: "person@example.test", recipients: ["c@example.org"] }],
      hasMore: false,
    });
    const names = commandNames(commands);
    expect(
      names
        .slice(names.indexOf("LOGIN"))
        .filter((name) => !["CAPABILITY", "LIST", "LSUB"].includes(name)),
    ).toEqual(["LOGIN", "EXAMINE", "UID", "UID"]);
    expect(commands.filter((line) => / UID /.test(line)).map((line) => line.replace(/^\S+ /, ""))).toEqual([
      "UID SEARCH UID 13:*",
      "UID FETCH 200000:200000 (UID ENVELOPE)",
    ]);
  });
});

/*
  ImapFlow's LIST hands back a `specialUse` it guessed from the folder's leaf
  name when no folder carries the flag. These run its real `list()` against a
  server with and without SPECIAL-USE, because a hand-written fixture cannot
  say what ImapFlow puts in an entry.
*/
describe("mailbox roles against a real ImapFlow LIST", () => {
  it("names no role from a folder ImapFlow guessed by its leaf name, on a server without SPECIAL-USE", async () => {
    const { client } = await connectedImapFlow({
      capability: "IMAP4rev1",
      folders: [
        { flags: "\\HasNoChildren", path: "Projects/Acme/Archive" },
        { flags: "\\HasNoChildren", path: "Projects/Acme/Sent" },
        { flags: "\\HasNoChildren", path: "Projects/Acme/Trash" },
        { flags: "\\HasNoChildren", path: "Projects/Acme/Junk" },
        { flags: "\\HasNoChildren", path: "Sent Mail" },
      ],
    });
    const listed = await client.list();
    client.close();

    // What ImapFlow itself says about them: a role for each, from the name.
    expect(
      listed
        .filter((entry) => entry.path.startsWith("Projects/"))
        .map((entry) => entry.specialUse),
    ).toEqual(expect.arrayContaining(["\\Archive", "\\Sent", "\\Trash", "\\Junk"]));
    for (const role of ["archive", "sent", "trash", "junk"] as const) {
      expect(selectImapMailboxPath(role, listed)).toBeNull();
    }
  });

  it("takes each role from the attribute a SPECIAL-USE server states, wherever the folder sits", async () => {
    const { client } = await connectedImapFlow({
      capability: "IMAP4rev1 SPECIAL-USE",
      folders: [
        { flags: "\\HasNoChildren \\Archive", path: "Stuff/Old" },
        { flags: "\\HasNoChildren \\Sent", path: "Outgoing" },
        { flags: "\\HasNoChildren \\Trash", path: "Stuff/Bin" },
        { flags: "\\HasNoChildren \\Junk", path: "Stuff/Nonsense" },
        // Names a guess would have picked first.
        { flags: "\\HasNoChildren", path: "Projects/Acme/Archive" },
        { flags: "\\HasNoChildren", path: "Projects/Acme/Sent" },
      ],
    });
    const listed = await client.list();
    client.close();

    expect(selectImapMailboxPath("archive", listed)).toBe("Stuff/Old");
    expect(selectImapMailboxPath("sent", listed)).toBe("Outgoing");
    expect(selectImapMailboxPath("trash", listed)).toBe("Stuff/Bin");
    expect(selectImapMailboxPath("junk", listed)).toBe("Stuff/Nonsense");
  });

  it("still finds a role by the name a mail client gives it at the root, without SPECIAL-USE", async () => {
    const { client } = await connectedImapFlow({
      capability: "IMAP4rev1",
      folders: [
        { flags: "\\HasNoChildren", path: "Archive" },
        { flags: "\\HasNoChildren", path: "Sent" },
        { flags: "\\HasNoChildren", path: "Trash" },
        { flags: "\\HasNoChildren", path: "Spam" },
        { flags: "\\HasNoChildren", path: "Projects/Acme/Sent" },
      ],
    });
    const listed = await client.list();
    client.close();

    expect(selectImapMailboxPath("archive", listed)).toBe("Archive");
    expect(selectImapMailboxPath("sent", listed)).toBe("Sent");
    expect(selectImapMailboxPath("trash", listed)).toBe("Trash");
    expect(selectImapMailboxPath("junk", listed)).toBe("Spam");
  });

  /*
    What a real LIST answer resolves to, role by role. The first three are
    mailboxes whose server states no attribute and names its folders in the
    account's language: before the guess was dropped ImapFlow found them, and
    the name tiers have to find them now.
  */
  const rolesOf = async (capability: string, folders: readonly (string | FakeImapFolder)[]) => {
    const { client, commands } = await connectedImapFlow({
      capability,
      folders: folders.map((folder) =>
        typeof folder === "string" ? { flags: "\\HasNoChildren", path: folder } : folder,
      ),
    });
    const listed = await client.list();
    client.close();
    return {
      // The folders themselves are listed over XLIST where that is all the
      // server offers; the delimiter probe before it is always a LIST.
      command: commandNames(commands).includes("XLIST") ? "XLIST" : "LIST",
      roles: Object.fromEntries(
        (["archive", "trash", "junk", "sent"] as const).map((role) => [
          role,
          selectImapMailboxPath(role, listed),
        ]),
      ),
    };
  };

  it("resolves a German, a Russian and a French mailbox at the root on a server without SPECIAL-USE", async () => {
    expect(
      (
        await rolesOf("IMAP4rev1", [
          "Gesendete Elemente",
          "Gelöschte Elemente",
          "Junk-E-Mail",
          "Archiv",
          "Entwürfe",
        ])
      ).roles,
    ).toEqual({
      archive: "Archiv",
      trash: "Gelöschte Elemente",
      junk: "Junk-E-Mail",
      sent: "Gesendete Elemente",
    });
    expect(
      (await rolesOf("IMAP4rev1", ["Отправленные", "Удаленные", "Спам", "Архив", "Черновики"]))
        .roles,
    ).toEqual({ archive: "Архив", trash: "Удаленные", junk: "Спам", sent: "Отправленные" });
    expect(
      (
        await rolesOf("IMAP4rev1", [
          "Éléments envoyés",
          "Éléments supprimés",
          "Courrier indésirable",
          "Archive",
          "Brouillons",
        ])
      ).roles,
    ).toEqual({
      archive: "Archive",
      trash: "Éléments supprimés",
      junk: "Courrier indésirable",
      sent: "Éléments envoyés",
    });
  });

  it("resolves nothing from names nested under a prefix that is not the Inbox", async () => {
    expect(
      (await rolesOf("IMAP4rev1", ["Mail/Sent", "Mail/Trash", "Mail/Junk", "Mail/Archive"])).roles,
    ).toEqual({ archive: null, trash: null, junk: null, sent: null });
  });

  it("refuses a role two root folders answer to by name", async () => {
    expect(
      (
        await rolesOf("IMAP4rev1", [
          "Trash",
          "Gelöschte Elemente",
          "Spam",
          "Junk-E-Mail",
          "Sent",
          "Gesendete Elemente",
          "Archive",
        ])
      ).roles,
    ).toEqual({ archive: "Archive", trash: null, junk: null, sent: null });
  });

  it("hands the Sent copy ImapFlow's own pick among two root Sent folders, and no pick from elsewhere", async () => {
    const pick = async (paths: readonly string[]) => {
      const { client } = await connectedImapFlow({
        capability: "IMAP4rev1",
        folders: paths.map((path) => ({ flags: "\\HasNoChildren", path })),
      });
      const listed = await client.list();
      client.close();
      const resolved = resolveImapMailboxRole("sent", listed);
      return {
        path: resolved.path,
        tied: resolved.tied.map((entry) => entry.path).sort(),
        guessed: listed.find((entry) => entry.specialUse === "\\Sent")?.path ?? null,
      };
    };

    await expect(pick(["Sent Messages", "Sent Items"])).resolves.toEqual({
      path: null,
      tied: ["Sent Items", "Sent Messages"],
      guessed: "Sent Items",
    });
    // ImapFlow's pick is the first path in alphabetical order, here a
    // project folder the tie does not hold.
    await expect(pick(["Sent Items", "Sent Messages", "Projects/Clients/Sent"])).resolves.toEqual({
      path: null,
      tied: ["Sent Items", "Sent Messages"],
      guessed: "Projects/Clients/Sent",
    });
  });

  it("takes \\Spam and \\AllMail as the attributes an XLIST server states them", async () => {
    const answer = await rolesOf("IMAP4rev1 XLIST", [
      { flags: "\\HasNoChildren \\Sent", path: "Отправленные" },
      { flags: "\\HasNoChildren \\Trash", path: "Удаленные" },
      { flags: "\\HasNoChildren \\Spam", path: "Нежелательная почта" },
      { flags: "\\HasNoChildren \\AllMail", path: "Вся почта" },
    ]);

    expect(answer.command).toBe("XLIST");
    expect(answer.roles).toEqual({
      archive: "Вся почта",
      trash: "Удаленные",
      junk: "Нежелательная почта",
      sent: "Отправленные",
    });
  });

  it("does not read a Sent folder three levels down, two that answer to the name, or another user's", async () => {
    for (const { capability, folders } of [
      {
        capability: "IMAP4rev1",
        folders: [
          { flags: "\\HasNoChildren", path: "Sent Mail" },
          { flags: "\\HasNoChildren", path: "Projects/Clients/Sent" },
        ],
      },
      {
        capability: "IMAP4rev1",
        folders: [
          { flags: "\\HasNoChildren", path: "Sent Items" },
          { flags: "\\HasNoChildren", path: "Sent" },
        ],
      },
      {
        capability: "IMAP4rev1 SPECIAL-USE",
        folders: [{ flags: "\\HasNoChildren", path: "Shared/boss/Gesendete Elemente" }],
      },
    ]) {
      const { adapter, commands } = await sentScanAdapter({ capability, folders });

      await expect(
        adapter.scanSentEnvelopes({ cursor: null }, new AbortController().signal),
      ).resolves.toEqual({ status: "unavailable", reason: "no_sent_mailbox" });
      expect(commandNames(commands)).not.toContain("EXAMINE");
    }
  });
});

interface FakeImapFolder {
  readonly flags: string;
  readonly path: string;
}

/**
 * One folder beside an empty INBOX. `uidNext` and `messages` are read at each
 * command, so a test can let a letter arrive between two sessions.
 */
interface FakeImapOptions {
  readonly capability: string;
  readonly folders: readonly FakeImapFolder[];
  readonly exists?: number;
  uidNext?: number;
  readonly uidValidity?: number;
  /** The untagged lines a FETCH or UID FETCH answers with. */
  readonly fetch?: (line: string) => string;
  /**
   * The folder's letters, lowest UID first. A fetch answers the ones its
   * sequence or UID range names, and a UID search the UIDs its range names.
   */
  messages?: readonly { readonly uid: number; readonly envelope: string }[];
  /** Sent ahead of every fetch answer, as a server reports another client. */
  readonly unsolicited?: string;
  /** This many fetches lose their socket instead of being answered. */
  dropFetches?: number;
  /** STATUS is never answered, as a server that stalls on it. */
  statusHangs?: boolean;
  /** How long the Inbox's EXAMINE takes to answer, as a slow server's. */
  inboxDelayMs?: number;
}

const imapAddress = (name: string, local: string, domain: string) =>
  `("${name}" NIL "${local}" "${domain}")`;

/** An ENVELOPE: date, subject, from, sender, reply-to, to, cc, bcc, in-reply-to, message-id. */
function imapEnvelope(fields: {
  readonly from: string;
  readonly sender?: string;
  readonly to: string;
  readonly cc?: string;
  readonly bcc?: string;
}): string {
  const from = `(${fields.from})`;
  const sender = fields.sender === undefined ? from : `(${fields.sender})`;
  return `("Mon, 01 Jan 2024 10:00:00 +0000" "Subject" ${from} ${sender} ${from} (${fields.to}) ${
    fields.cc === undefined ? "NIL" : `(${fields.cc})`
  } ${fields.bcc === undefined ? "NIL" : `(${fields.bcc})`} NIL "<id@example.test>")`;
}

function serveSentImap(socket: TLSSocket, commands: string[], options: FakeImapOptions): void {
  socket.once("error", () => undefined);
  socket.write("* OK fake IMAP ready\r\n");
  attachLineReader(socket, commands, (tag, command) => {
    const line = commands.at(-1) ?? "";
    if (command === "CAPABILITY") {
      socket.write(`* CAPABILITY ${options.capability}\r\n${tag} OK CAPABILITY completed\r\n`);
      return;
    }
    if (command === "LOGIN") {
      socket.write(`${tag} OK LOGIN completed\r\n`);
      return;
    }
    if (command === "LIST" || command === "LSUB" || command === "XLIST") {
      let entries: string;
      if (line.includes("*")) {
        entries = `* ${command} (\\HasNoChildren) "/" INBOX\r\n`;
        for (const folder of options.folders) {
          entries += `* ${command} (${folder.flags}) "/" "${folder.path}"\r\n`;
        }
      } else {
        const hit = options.folders.find((folder) => line.includes(folder.path));
        entries = hit
          ? `* ${command} (${hit.flags}) "/" "${hit.path}"\r\n`
          : line.includes("INBOX")
            ? `* ${command} (\\HasNoChildren) "/" INBOX\r\n`
            : `* ${command} (\\Noselect) "/" ""\r\n`;
      }
      socket.write(`${entries}${tag} OK ${command} completed\r\n`);
      return;
    }
    if (command === "EXAMINE" && / EXAMINE "?INBOX"?$/.test(line)) {
      const answer =
        "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n" +
        "* 0 EXISTS\r\n" +
        "* OK [UIDVALIDITY 55] UIDs valid\r\n" +
        "* OK [UIDNEXT 1] Predicted next UID\r\n" +
        `${tag} OK [READ-ONLY] EXAMINE completed\r\n`;
      if (options.inboxDelayMs === undefined) socket.write(answer);
      else {
        setTimeout(() => {
          if (!socket.destroyed) socket.write(answer);
        }, options.inboxDelayMs);
      }
      return;
    }
    if (command === "STATUS") {
      if (options.statusHangs === true) return;
      socket.write(
        `* STATUS ${line.split(" ")[2]} (UIDNEXT ${options.uidNext ?? 1} UIDVALIDITY ${
          options.uidValidity ?? 77
        })\r\n${tag} OK STATUS completed\r\n`,
      );
      return;
    }
    if (command === "EXAMINE") {
      socket.write(
        "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n" +
          "* OK [PERMANENTFLAGS ()] No permanent flags permitted\r\n" +
          `* ${options.exists ?? options.messages?.length ?? 0} EXISTS\r\n` +
          `* OK [UIDVALIDITY ${options.uidValidity ?? 77}] UIDs valid\r\n` +
          `* OK [UIDNEXT ${options.uidNext ?? 1}] Predicted next UID\r\n` +
          `${tag} OK [READ-ONLY] EXAMINE completed\r\n`,
      );
      return;
    }
    const byUid = command === "UID";
    const messages = options.messages ?? [];
    // `a:b`, `a` or `a:*`, against sequence numbers or UIDs.
    const named = (set: string) => {
      const [low, high = low] = set.split(":");
      const from = Number(low);
      const to = high === "*" ? Number.MAX_SAFE_INTEGER : Number(high);
      return messages
        .map((message, index) => ({ ...message, seq: index + 1 }))
        .filter((message) => {
          const position = byUid ? message.uid : message.seq;
          return position >= from && position <= to;
        });
    };
    if (byUid && / UID SEARCH UID /i.test(line)) {
      const hits = named(line.split(" ").at(-1)!).map((message) => message.uid);
      socket.write(`* SEARCH ${hits.join(" ")}\r\n${tag} OK SEARCH completed\r\n`);
      return;
    }
    if (command === "FETCH" || (byUid && / UID FETCH /i.test(line))) {
      if ((options.dropFetches ?? 0) > 0) {
        options.dropFetches = (options.dropFetches ?? 0) - 1;
        socket.destroy();
        return;
      }
      const answer =
        options.fetch?.(line) ??
        named(line.split(" ")[byUid ? 3 : 2]!)
          .map((message) => `* ${message.seq} FETCH (UID ${message.uid} ENVELOPE ${message.envelope})\r\n`)
          .join("");
      socket.write(`${options.unsolicited ?? ""}${answer}${tag} OK FETCH completed\r\n`);
      return;
    }
    socket.write(`${tag} BAD unsupported test command\r\n`);
  });
}

/** An ImapMailSyncAdapter over real ImapFlow sessions to a fake server. */
async function sentScanAdapter(options: FakeImapOptions, operationTimeoutMs?: number) {
  const commands: string[] = [];
  const server = createTlsServer(testTls, (socket) => {
    serveSentImap(socket, commands, options);
  });
  const port = await listen(server);
  const account = imapAccountFor(port);
  const adapter = new ImapMailSyncAdapter(
    account,
    new ImapFlowReadSessionFactory({
      dns: { resolve: async () => [targetFor(port, "implicit")] },
      store: storeFor(account),
      createClient: (clientOptions: ImapFlowOptions) =>
        new ImapFlow({ ...clientOptions, tls: { ...clientOptions.tls, ca: testTls.cert } }),
      ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
    }),
  );
  return { adapter, commands };
}

/** A bare ImapFlow client, logged in to the same fake server. */
async function connectedImapFlow(options: FakeImapOptions) {
  const commands: string[] = [];
  const server = createTlsServer(testTls, (socket) => {
    serveSentImap(socket, commands, options);
  });
  const port = await listen(server);
  const client = new ImapFlow({
    host: "127.0.0.1",
    port,
    secure: true,
    auth: { user: "person@example.test", pass: "test-only-password" },
    tls: { ca: testTls.cert, servername: "localhost" },
    logger: false,
  });
  client.on("error", () => undefined);
  await client.connect();
  return { client, commands };
}

function serveIdleImap(socket: TLSSocket, commands: string[]): void {
  socket.once("error", () => undefined);
  socket.write("* OK fake IMAP ready\r\n");
  let idleTag: string | null = null;
  attachLineReader(socket, commands, (tag, command) => {
    if (tag.toUpperCase() === "DONE" && idleTag !== null) {
      socket.write(`${idleTag} OK IDLE terminated\r\n`);
      idleTag = null;
      return;
    }
    if (command === "CAPABILITY") {
      socket.write(
        `* CAPABILITY IMAP4rev1 IDLE\r\n${tag} OK CAPABILITY completed\r\n`,
      );
      return;
    }
    if (command === "LOGIN") {
      socket.write(`${tag} OK LOGIN completed\r\n`);
      return;
    }
    // ImapFlow resolves the path it opens through LIST and LSUB first.
    if (command === "LIST" || command === "LSUB") {
      const entry = commands.at(-1)?.includes("INBOX")
        ? `* ${command} (\\HasNoChildren) "/" INBOX\r\n`
        : `* ${command} (\\Noselect) "/" ""\r\n`;
      socket.write(`${entry}${tag} OK ${command} completed\r\n`);
      return;
    }
    if (command === "EXAMINE") {
      socket.write(
        "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n" +
          "* OK [PERMANENTFLAGS ()] No permanent flags permitted\r\n" +
          "* 4 EXISTS\r\n" +
          "* OK [UIDVALIDITY 77] UIDs valid\r\n" +
          "* OK [UIDNEXT 5] Predicted next UID\r\n" +
          `${tag} OK [READ-ONLY] EXAMINE completed\r\n`,
      );
      return;
    }
    if (command === "IDLE") {
      idleTag = tag;
      socket.write("+ idling\r\n");
      return;
    }
    if (command === "NOOP") {
      socket.write(`${tag} OK NOOP completed\r\n`);
      return;
    }
    if (command === "LOGOUT") {
      socket.end(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
      return;
    }
    socket.write(`${tag} BAD unsupported test command\r\n`);
  });
}

function imapAccountFor(port: number): StoredImapMailAccount {
  return Object.freeze({
    account: Object.freeze({
      accountId: "account-a11111111111111111111111111111111",
      emailAddress: "person@example.test",
      endpoint: Object.freeze({ hostname: "localhost", port, tls: "implicit" as const }),
      username: "person@example.test",
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

function storeFor(stored: StoredImapMailAccount): MultiMailAccountStore {
  return {
    localSchemaVersion: 2,
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    countAccounts: vi.fn().mockResolvedValue(1),
    listAccounts: vi.fn().mockResolvedValue([stored]),
    readAccount: vi.fn().mockResolvedValue(stored),
    loadProvisionedAccount: vi.fn(async () => ({
      stored,
      password: Buffer.from("test-only-password"),
    })),
    save: vi.fn().mockResolvedValue(undefined),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    loadGmailCredential: vi.fn().mockResolvedValue(null),
    deleteAccount: vi.fn().mockResolvedValue(true),
  };
}

function verifierFor(port: number, tls: "implicit" | "starttls") {
  const target = targetFor(port, tls);
  const dns: MailDnsResolverPort = { resolve: async () => [target] };
  return new ImapFlowCredentialVerifier({
    dns,
    createClient: (options: ImapFlowOptions) =>
      new ImapFlow({
        ...options,
        tls: { ...options.tls, ca: testTls.cert },
      }),
  });
}

function requestFor(port: number, tls: "implicit" | "starttls") {
  return {
    endpoint: { hostname: "localhost", port, tls },
    username: "person@example.test",
    password: Buffer.from("test-only-password"),
    deadlineAt: Date.now() + 5_000,
    signal: new AbortController().signal,
  };
}

function targetFor(
  port: number,
  tls: "implicit" | "starttls",
): ValidatedMailDialTarget {
  const now = Date.now();
  return {
    protocol: "imap",
    hostname: "localhost",
    port,
    tls,
    address: "127.0.0.1",
    family: 4,
    resolutionId: "dns-fake-imap",
    resolvedAt: now,
    expiresAt: now + 5_000,
  };
}

function serveStartTlsImap(
  socket: Socket,
  secureContext: ReturnType<typeof createSecureContext>,
  plaintextCommands: string[],
  encryptedCommands: string[],
): void {
  socket.write("* OK fake IMAP ready\r\n");
  attachLineReader(socket, plaintextCommands, (tag, command) => {
    if (command === "CAPABILITY") {
      socket.write(
        `* CAPABILITY IMAP4rev1 STARTTLS\r\n${tag} OK CAPABILITY completed\r\n`,
      );
      return;
    }
    if (command !== "STARTTLS") {
      socket.write(`${tag} BAD TLS required\r\n`);
      return;
    }
    socket.write(`${tag} OK Begin TLS negotiation\r\n`, () => {
      socket.removeAllListeners("data");
      const tlsSocket = new TLSSocket(socket, {
        isServer: true,
        secureContext,
      });
      tlsSocket.once("error", () => undefined);
      serveAuthenticatedImap(tlsSocket, encryptedCommands, false);
    });
  });
}

function serveAuthenticatedImap(
  socket: Socket | TLSSocket,
  commands: string[],
  greet = true,
): void {
  socket.once("error", () => undefined);
  if (greet) socket.write("* OK fake IMAP ready\r\n");
  attachLineReader(socket, commands, (tag, command) => {
    if (command === "CAPABILITY") {
      socket.write(
        `* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`,
      );
      return;
    }
    if (command === "LOGIN") {
      socket.write(`${tag} OK LOGIN completed\r\n`);
      return;
    }
    if (command === "NAMESPACE") {
      socket.write(
        `* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`,
      );
      return;
    }
    if (command === "LIST") {
      socket.write(
        `* LIST (\\Noselect) "/" ""\r\n${tag} OK LIST completed\r\n`,
      );
      return;
    }
    socket.write(`${tag} BAD unsupported test command\r\n`);
  });
}

function attachLineReader(
  socket: Socket | TLSSocket,
  commands: string[],
  respond: (tag: string, command: string) => void,
): void {
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\r\n")) {
      const separator = buffered.indexOf("\r\n");
      const line = buffered.slice(0, separator);
      buffered = buffered.slice(separator + 2);
      if (line.length === 0) continue;
      commands.push(line);
      const [tag = "", command = ""] = line.split(/\s+/, 3);
      respond(tag, command.toUpperCase());
    }
  });
}

function commandNames(lines: readonly string[]): string[] {
  return lines.map((line) => line.split(/\s+/, 3)[1]?.toUpperCase() ?? "");
}

async function listen(server: NetServer | TlsServer): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake IMAP server has no TCP port");
  }
  return address.port;
}

function closeServer(server: NetServer | TlsServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
