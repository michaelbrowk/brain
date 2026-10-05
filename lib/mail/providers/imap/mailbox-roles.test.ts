import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  archiveCreatePath,
  isInboxPath,
  isSupportedMailboxList,
  MAX_LISTED_MAILBOXES,
  selectImapMailboxPath,
} from "./sync-adapter";

// ImapFlow's own lists of localized folder names, read from the package so
// that an upgrade that adds a name fails the test that compares them.
const imapFlowSpecialUse = createRequire(import.meta.url)("imapflow/lib/special-use.js") as {
  readonly names: Readonly<Record<string, readonly string[]>>;
};

describe("IMAP mailbox role discovery", () => {
  it("prefers the stated SPECIAL-USE attribute over any name", () => {
    const mailboxes = [
      { path: "Archive", name: "Archive", delimiter: "/" },
      { path: "Stuff/Old", name: "Old", delimiter: "/", flags: new Set(["\\Archive"]) },
    ];

    expect(selectImapMailboxPath("archive", mailboxes)).toBe("Stuff/Old");
  });

  it("reads XLIST-style attributes for trash and junk", () => {
    const mailboxes = [
      { path: "INBOX.Bin", name: "Bin", delimiter: ".", flags: new Set(["\\Trash"]) },
      { path: "INBOX.Nonsense", name: "Nonsense", delimiter: ".", flags: new Set(["\\Junk"]) },
    ];

    expect(selectImapMailboxPath("trash", mailboxes)).toBe("INBOX.Bin");
    expect(selectImapMailboxPath("junk", mailboxes)).toBe("INBOX.Nonsense");
  });

  it("falls back to a well-known name directly under the Inbox", () => {
    const mailboxes = [
      { path: "INBOX.Sent", name: "Sent", delimiter: "." },
      { path: "INBOX.Archives", name: "Archives", delimiter: "." },
      { path: "INBOX.Deleted Items", name: "Deleted Items", delimiter: "." },
      { path: "INBOX.Spam", name: "Spam", delimiter: "." },
    ];

    expect(selectImapMailboxPath("archive", mailboxes)).toBe("INBOX.Archives");
    expect(selectImapMailboxPath("trash", mailboxes)).toBe("INBOX.Deleted Items");
    expect(selectImapMailboxPath("junk", mailboxes)).toBe("INBOX.Spam");
  });

  it("matches names case-insensitively and derives the leaf from the delimiter", () => {
    const mailboxes = [{ path: "INBOX/ARCHIVE", delimiter: "/" }];

    expect(selectImapMailboxPath("archive", mailboxes)).toBe("INBOX/ARCHIVE");
  });

  /*
    Until 0.20.3 a server that states no attribute had its trash, junk and
    sent folders found by ImapFlow's guess, from some forty, thirty and a
    hundred localized names. The guess is gone, so the name tiers have to
    know those names themselves, or a German, Russian or French mailbox loses
    its trash and spam buttons. They hold ImapFlow's own lists, under the
    rule the guess never had: at the root or directly under the Inbox, and
    only when exactly one folder answers.
  */
  it("knows every name ImapFlow knows for trash, junk and sent, where a mail client puts the folder", () => {
    for (const [role, attribute] of [
      ["trash", "\\Trash"],
      ["junk", "\\Junk"],
      ["sent", "\\Sent"],
    ] as const) {
      const names = [...new Set(imapFlowSpecialUse.names[attribute])];
      expect(names.length).toBeGreaterThan(30);
      for (const name of names) {
        expect(selectImapMailboxPath(role, [{ path: name, name, delimiter: "/" }]), name).toBe(name);
        expect(
          selectImapMailboxPath(role, [{ path: `INBOX.${name}`, name, delimiter: "." }]),
          name,
        ).toBe(`INBOX.${name}`);
        // Nested deeper, or under another user's tree, it is somebody
        // else's folder.
        expect(
          selectImapMailboxPath(role, [{ path: `Projects/Acme/${name}`, name, delimiter: "/" }]),
          name,
        ).toBeNull();
      }
    }
  });

  it("finds the folders of a German, a Russian and a French mailbox that states no attribute", () => {
    const roles = (names: readonly string[]) => {
      const listed = names.map((name) => ({ path: name, name, delimiter: "/" }));
      return Object.fromEntries(
        (["archive", "trash", "junk", "sent"] as const).map((role) => [
          role,
          selectImapMailboxPath(role, listed),
        ]),
      );
    };

    expect(
      roles(["Gesendete Elemente", "Gelöschte Elemente", "Junk-E-Mail", "Archiv", "Entwürfe"]),
    ).toEqual({
      archive: "Archiv",
      trash: "Gelöschte Elemente",
      junk: "Junk-E-Mail",
      sent: "Gesendete Elemente",
    });
    expect(roles(["Отправленные", "Удаленные", "Спам", "Архив", "Черновики"])).toEqual({
      archive: "Архив",
      trash: "Удаленные",
      junk: "Спам",
      sent: "Отправленные",
    });
    expect(
      roles(["Éléments envoyés", "Éléments supprimés", "Courrier indésirable", "Archive", "Brouillons"]),
    ).toEqual({
      archive: "Archive",
      trash: "Éléments supprimés",
      junk: "Courrier indésirable",
      sent: "Éléments envoyés",
    });
  });

  it("refuses two localized folders that answer to one role, as it does two English ones", () => {
    expect(
      selectImapMailboxPath("trash", [
        { path: "Papierkorb", delimiter: "/" },
        { path: "Gelöschte Elemente", delimiter: "/" },
        { path: "Trash", delimiter: "/" },
      ]),
    ).toBeNull();
    expect(
      selectImapMailboxPath("junk", [
        { path: "Spam", delimiter: "/" },
        { path: "Courrier indésirable", delimiter: "/" },
      ]),
    ).toBeNull();
    expect(
      selectImapMailboxPath("sent", [
        { path: "Gesendete Elemente", delimiter: "/" },
        { path: "Sent", delimiter: "/" },
      ]),
    ).toBeNull();
  });

  it("reads a name through the left-to-right marks and padding some clients put around it", () => {
    expect(
      selectImapMailboxPath("trash", [
        { path: "‎العناصر المحذوفة‎", name: " ‎العناصر المحذوفة‎", delimiter: "/" },
      ]),
    ).toBe("‎العناصر المحذوفة‎");
  });

  it("reads a name a server lists in decomposed form, or with a Turkish capital dotted I", () => {
    // The accent as a combining mark after the letter, as a server that
    // stores names the way the macOS file system writes them lists them.
    const decomposed = "Envoye\u0301s";
    expect(
      selectImapMailboxPath("sent", [{ path: decomposed, name: decomposed, delimiter: "/" }]),
    ).toBe(decomposed);
    // "İ" lowercases to "i" and a combining dot above, which no list holds.
    expect(
      selectImapMailboxPath("trash", [
        { path: "SİLİNMİŞ ÖĞELER", name: "SİLİNMİŞ ÖĞELER", delimiter: "/" },
      ]),
    ).toBe("SİLİNMİŞ ÖĞELER");
  });

  it("takes the older attributes a server may state for junk and all mail", () => {
    // What XLIST servers and some SPECIAL-USE ones list instead of \Junk and
    // \All. They are the server's own word, like the standard ones.
    const mailboxes = [
      { path: "Спам", delimiter: "/", flags: new Set(["\\HasNoChildren", "\\Spam"]) },
      { path: "Вся почта", delimiter: "/", flags: new Set(["\\HasNoChildren", "\\AllMail"]) },
    ];

    expect(selectImapMailboxPath("junk", mailboxes)).toBe("Спам");
    expect(selectImapMailboxPath("archive", mailboxes)).toBe("Вся почта");
    // The standard attribute and a named Archive still come first.
    expect(
      selectImapMailboxPath("junk", [
        { path: "Old spam", delimiter: "/", flags: new Set(["\\Spam"]) },
        { path: "Bulk", delimiter: "/", flags: new Set(["\\Junk"]) },
      ]),
    ).toBe("Bulk");
    expect(
      selectImapMailboxPath("archive", [
        ...mailboxes,
        { path: "Архив", delimiter: "/" },
      ]),
    ).toBe("Архив");
    // And a stated \Spam shows where the server keeps its role folders.
    expect(
      archiveCreatePath([{ path: "INBOX.Spam", delimiter: ".", flags: new Set(["\\Spam"]) }]),
    ).toBe("INBOX.Archive");
  });

  /*
    Without SPECIAL-USE a name is all there is, and a leaf called Archive
    three levels down a project tree is a folder about something else. The
    places a mail client creates an Archive are the account root and, on a
    server that files everything beneath it, the Inbox's own children. A
    `Projects/2019/Archive` used to win here and become the destination for
    the owner's incoming mail.
  */
  it("does not take a well-known name nested deeper than the Inbox", () => {
    expect(
      selectImapMailboxPath("archive", [
        { path: "Projects/2019/Archive", delimiter: "/" },
      ]),
    ).toBeNull();
    expect(
      selectImapMailboxPath("trash", [
        { path: "INBOX.Old.Trash", name: "Trash", delimiter: "." },
      ]),
    ).toBeNull();
  });

  it("refuses when two folders answer to the name, whatever the order", () => {
    // Choosing one — shortest path, first listed — is a guess about which of
    // the owner's folders should receive mail. The server named neither.
    const twice = [
      { path: "Archive", name: "Archive", delimiter: "/" },
      { path: "INBOX/Archives", name: "Archives", delimiter: "/" },
    ];

    expect(selectImapMailboxPath("archive", twice)).toBeNull();
    expect(selectImapMailboxPath("archive", [...twice].reverse())).toBeNull();
  });

  it("still refuses a name it does not know", () => {
    expect(
      selectImapMailboxPath("archive", [{ path: "Old stuff", delimiter: "/" }]),
    ).toBeNull();
  });

  it("takes the archive under the name a localized server gives it", () => {
    for (const name of [
      "Архив",
      "Архів",
      "Archiv",
      "Archivio",
      "Archivo",
      "Arquivo",
      "Archiwum",
      "Arşiv",
      "Archief",
      "Arkiv",
    ]) {
      expect(
        selectImapMailboxPath("archive", [
          { path: "Sent", name: "Sent", delimiter: "|" },
          { path: name, name, delimiter: "|" },
        ]),
      ).toBe(name);
    }
  });

  it("keeps the stated attribute above a localized name", () => {
    expect(
      selectImapMailboxPath("archive", [
        { path: "Архив", name: "Архив", delimiter: "|" },
        { path: "Saved", name: "Saved", delimiter: "|", flags: new Set(["\\Archive"]) },
      ]),
    ).toBe("Saved");
  });

  it("ranks a named Archive above an all-mail view", () => {
    const mailboxes = [
      { path: "All Mail", name: "All Mail", delimiter: "/", flags: new Set(["\\All"]) },
      { path: "Archive", name: "Archive", delimiter: "/" },
    ];

    expect(selectImapMailboxPath("archive", mailboxes)).toBe("Archive");
  });

  it("accepts an all-mail view when the server offers no archive at all", () => {
    const mailboxes = [
      { path: "[Gmail]/All Mail", name: "All Mail", delimiter: "/", flags: new Set(["\\All"]) },
    ];

    expect(selectImapMailboxPath("archive", mailboxes)).toBe("[Gmail]/All Mail");
  });

  it("returns null when the server advertises and names nothing", () => {
    const mailboxes = [
      { path: "INBOX.Sent", name: "Sent", delimiter: "." },
      { path: "INBOX.Drafts", name: "Drafts", delimiter: "." },
    ];

    expect(selectImapMailboxPath("archive", mailboxes)).toBeNull();
    expect(selectImapMailboxPath("trash", mailboxes)).toBeNull();
    expect(selectImapMailboxPath("junk", mailboxes)).toBeNull();
  });

  it("never treats the Inbox itself as a destination", () => {
    expect(
      selectImapMailboxPath("archive", [
        { path: "INBOX", name: "INBOX", flags: new Set(["\\Archive"]) },
      ]),
    ).toBeNull();
    expect(isInboxPath("inbox")).toBe(true);
    expect(isInboxPath("INBOX.Archive")).toBe(false);
  });

  it("skips mailboxes the server says cannot hold messages", () => {
    const mailboxes = [
      {
        path: "Archive",
        name: "Archive",
        delimiter: "/",
        flags: new Set(["\\Noselect", "\\HasChildren"]),
      },
      { path: "INBOX/Archive", name: "Archive", delimiter: "/" },
    ];

    expect(selectImapMailboxPath("archive", mailboxes)).toBe("INBOX/Archive");
  });

  it("takes a top-level name on a server that lists no hierarchy", () => {
    expect(selectImapMailboxPath("archive", [{ path: "Archive" }])).toBe("Archive");
  });

  /*
    The Sent mailbox is only ever read: the new-senders screen learns from its
    envelopes whom the owner wrote to. It is found the way the archive is, the
    stated attribute first and then the name a mail client gives the folder.
  */
  it("finds the Sent mailbox by its stated attribute before any name", () => {
    expect(
      selectImapMailboxPath("sent", [
        { path: "Sent", name: "Sent", delimiter: "/" },
        { path: "Outgoing", name: "Outgoing", delimiter: "/", flags: new Set(["\\Sent"]) },
      ]),
    ).toBe("Outgoing");
  });

  /*
    ImapFlow's LIST answers each entry with a `specialUse` of its own, and
    where no folder carries the flag it guesses one from the leaf name: some
    ninety localized names, at any depth, the first that matches. That guess
    used to be read as the server's word, so a `Projects/Acme/Archive` became
    the archive and a `Projects/Clients/Sent` was read as the owner's sent
    mail. Only an attribute in the entry's own flags is the server's.
  */
  it("takes a role from the server's own attribute and never from a specialUse somebody guessed", () => {
    const guessed = [
      {
        path: "Projects/Acme/Archive",
        name: "Archive",
        delimiter: "/",
        flags: new Set(["\\HasNoChildren"]),
        specialUse: "\\Archive",
        specialUseSource: "name",
      },
      {
        path: "Projects/Acme/Sent",
        name: "Sent",
        delimiter: "/",
        flags: new Set(["\\HasNoChildren"]),
        specialUse: "\\Sent",
        specialUseSource: "name",
      },
      {
        path: "Projects/Acme/Trash",
        name: "Trash",
        delimiter: "/",
        flags: new Set(["\\HasNoChildren"]),
        specialUse: "\\Trash",
        specialUseSource: "name",
      },
      {
        path: "Shared/boss/Junk",
        name: "Junk",
        delimiter: "/",
        flags: new Set<string>(),
        specialUse: "\\Junk",
        specialUseSource: "name",
      },
    ];

    for (const role of ["archive", "sent", "trash", "junk"] as const) {
      expect(selectImapMailboxPath(role, guessed)).toBeNull();
    }
    // The same names where a mail client puts them still answer, by name.
    expect(
      selectImapMailboxPath("trash", [
        ...guessed,
        { path: "Trash", name: "Trash", delimiter: "/", flags: new Set<string>() },
      ]),
    ).toBe("Trash");
  });

  it("reads the stated attribute whatever its letter case, among the folder's other flags", () => {
    expect(
      selectImapMailboxPath("sent", [
        {
          path: "Outgoing",
          name: "Outgoing",
          delimiter: "/",
          flags: new Set(["\\HasNoChildren", "\\SENT"]),
        },
      ]),
    ).toBe("Outgoing");
  });

  it("anchors a created Archive on stated attributes only", () => {
    // A guessed \Trash on a folder whose name says nothing tells nothing
    // about where this server keeps its role folders; a stated one under the
    // Inbox does.
    expect(
      archiveCreatePath([
        {
          path: "INBOX.Old stuff",
          delimiter: ".",
          flags: new Set(["\\Trash"]),
        },
      ]),
    ).toBe("INBOX.Archive");
    expect(
      archiveCreatePath([
        {
          path: "INBOX.Old stuff",
          delimiter: ".",
          flags: new Set<string>(),
          specialUse: "\\Trash",
        } as { path: string },
      ]),
    ).toBe("Archive");
  });

  it("finds the Sent mailbox under the name a localized server gives it", () => {
    for (const name of [
      "Sent",
      "Sent Items",
      "Sent Messages",
      "Отправленные",
      "Надіслані",
      "Gesendet",
      "Envoyés",
      "Enviados",
      "Inviati",
      "Wysłane",
      "Gönderilmiş Öğeler",
      "Verzonden",
      "Skickat",
    ]) {
      expect(
        selectImapMailboxPath("sent", [
          { path: "Archive", name: "Archive", delimiter: "|" },
          { path: name, name, delimiter: "|" },
        ]),
      ).toBe(name);
      expect(
        selectImapMailboxPath("sent", [
          { path: `INBOX.${name}`, name, delimiter: "." },
        ]),
      ).toBe(`INBOX.${name}`);
    }
  });

  it("names no Sent mailbox when the server lists none, two, or one out of place", () => {
    expect(
      selectImapMailboxPath("sent", [
        { path: "Archive", name: "Archive", delimiter: "/" },
        { path: "Drafts", name: "Drafts", delimiter: "/" },
      ]),
    ).toBeNull();
    expect(
      selectImapMailboxPath("sent", [
        { path: "Sent", name: "Sent", delimiter: "/" },
        { path: "Sent Items", name: "Sent Items", delimiter: "/" },
      ]),
    ).toBeNull();
    expect(
      selectImapMailboxPath("sent", [
        { path: "Projects/2019/Sent", name: "Sent", delimiter: "/" },
      ]),
    ).toBeNull();
    expect(
      selectImapMailboxPath("sent", [
        { path: "Sent", name: "Sent", delimiter: "/", flags: new Set(["\\Noselect"]) },
      ]),
    ).toBeNull();
  });

  it("rejects a mailbox list longer than the documented budget", () => {
    const oversized = Array.from({ length: MAX_LISTED_MAILBOXES + 1 }, (_value, index) => ({
      path: `Folder${index}`,
    }));

    expect(isSupportedMailboxList(oversized)).toBe(false);
    expect(isSupportedMailboxList([{ path: "Archive" }])).toBe(true);
    expect(isSupportedMailboxList("not a list")).toBe(false);
  });
});
