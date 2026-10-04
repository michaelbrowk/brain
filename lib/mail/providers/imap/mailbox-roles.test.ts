import { describe, expect, it } from "vitest";

import {
  isInboxPath,
  isSupportedMailboxList,
  MAX_LISTED_MAILBOXES,
  selectImapMailboxPath,
} from "./sync-adapter";

describe("IMAP mailbox role discovery", () => {
  it("prefers the stated SPECIAL-USE attribute over any name", () => {
    const mailboxes = [
      { path: "Archive", name: "Archive", delimiter: "/" },
      { path: "Stuff/Old", name: "Old", delimiter: "/", specialUse: "\\Archive" },
    ];

    expect(selectImapMailboxPath("archive", mailboxes)).toBe("Stuff/Old");
  });

  it("reads XLIST-style attributes for trash and junk", () => {
    const mailboxes = [
      { path: "INBOX.Bin", name: "Bin", delimiter: ".", specialUse: "\\Trash" },
      { path: "INBOX.Nonsense", name: "Nonsense", delimiter: ".", specialUse: "\\Junk" },
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
        { path: "Saved", name: "Saved", delimiter: "|", specialUse: "\\Archive" },
      ]),
    ).toBe("Saved");
  });

  it("ranks a named Archive above an all-mail view", () => {
    const mailboxes = [
      { path: "All Mail", name: "All Mail", delimiter: "/", specialUse: "\\All" },
      { path: "Archive", name: "Archive", delimiter: "/" },
    ];

    expect(selectImapMailboxPath("archive", mailboxes)).toBe("Archive");
  });

  it("accepts an all-mail view when the server offers no archive at all", () => {
    const mailboxes = [
      { path: "[Gmail]/All Mail", name: "All Mail", delimiter: "/", specialUse: "\\All" },
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
        { path: "INBOX", name: "INBOX", specialUse: "\\Archive" },
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
        { path: "Outgoing", name: "Outgoing", delimiter: "/", specialUse: "\\Sent" },
      ]),
    ).toBe("Outgoing");
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
