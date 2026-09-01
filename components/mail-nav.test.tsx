// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailNav } from "./mail-nav";
import { UNIFIED_ACCOUNT_ID } from "./mail-unified";
import type { PublicMailAccount } from "./mail-surface-client";

// framer-motion is mocked — the trigger is a motion.button and nothing here
// is about playback.
vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({ reducedMotion: false });
});

const gmailAccount: PublicMailAccount = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  emailAddress: "misha@example.test",
  displayName: "Personal",
  status: "connected",
  connectedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerKind: "gmail",
  capabilities: {
    mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: true,
    send: true,
    reply: true,
  },
};

/** A custom-domain account that can send: capabilities name one mailbox, so
 *  its destinations block is Inbox and Drafts — the same list, shorter. */
const imapAccount: PublicMailAccount = {
  ...gmailAccount,
  accountId: "account-affffffffffffffffffffffffffffffff",
  emailAddress: "design@studio.test",
  displayName: null,
  providerKind: "imap",
  capabilities: {
    mailboxes: ["inbox"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: true,
    send: true,
    reply: true,
  },
  imap: {
    hostname: "imap.studio.test",
    port: 993,
    tls: "implicit",
    username: "design@studio.test",
  },
};

/** No compose transport at all: no Drafts row anywhere. */
const readOnlyAccount: PublicMailAccount = {
  ...imapAccount,
  accountId: "account-b1111111111111111111111111111111",
  emailAddress: "archive@studio.test",
  capabilities: { ...imapAccount.capabilities, compose: false, send: false },
};

function defaultProps() {
  return {
    accounts: [gmailAccount] as readonly PublicMailAccount[],
    selectedAccountId: gmailAccount.accountId,
    selectedMailboxId: "inbox" as const,
    selectedView: null,
    draftsOpen: false,
    inboxUnreadCount: null,
    failedDraftCount: 0,
    submittingDraftCount: 0,
    onSelectAccount: vi.fn(),
    onSelectMailbox: vi.fn(),
    onSelectView: vi.fn(),
    onOpenDrafts: vi.fn(),
  };
}

function trigger(): HTMLButtonElement {
  const button = document.body.querySelector('button[aria-label^="Mailbox: "]');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Mail nav trigger not found");
  }
  return button;
}

async function open() {
  await act(async () => {
    trigger().dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
}

function rows(): HTMLElement[] {
  return [
    ...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
  ];
}

/** Rows by LABEL, not by whole-row text — Inbox carries a count. */
function labels(): string[] {
  return rows().map((row) => row.querySelector("span")?.textContent?.trim() ?? "");
}

function row(label: string): HTMLElement {
  const found = rows().find(
    (candidate) => candidate.querySelector("span")?.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Nav row not found: ${label}`);
  return found;
}

/** The menu's structural marks, in order — labels and separators. */
function blocks(): string[] {
  const content = document.body.querySelector(".brain-menu");
  if (!content) throw new Error("Menu is not open");
  return [
    ...content.querySelectorAll(".brain-menu-label, .brain-menu-sep"),
  ].map((child) =>
    child.classList.contains("brain-menu-sep")
      ? "—"
      : (child.textContent?.trim() ?? ""),
  );
}

describe("MailNav", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("PointerEvent", MouseEvent);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /* THREE BLOCKS, TOP TO BOTTOM: this account's destinations, then Smart,
     then Accounts. Drafts stands between Sent and All Mail because it holds
     the column the way a folder does. */
  it("lays the destinations, the smart views and the accounts in one list", async () => {
    await act(async () =>
      root.render(
        <MailNav {...defaultProps()} accounts={[gmailAccount, imapAccount]} />,
      ),
    );
    await open();

    expect(labels()).toEqual([
      "Inbox",
      "Starred",
      "Sent",
      "Drafts",
      "All Mail",
      "Spam",
      "Trash",
      "Unread",
      "Lists",
      "People",
      "Attachments",
      "All inboxes",
      gmailAccount.emailAddress,
      imapAccount.emailAddress,
    ]);
    expect(blocks()).toEqual(["—", "Smart", "—", "Accounts"]);
  });

  /* THE MODE DOES NOT CHANGE THE OBJECT, it takes out of it what the mode
     does not have. All inboxes has one mailbox and no smart views, so both
     blocks above Accounts are simply absent — and Drafts leaves with the
     block it lives in, without a guard of its own. */
  it("drops the destinations and Smart blocks in unified mode", async () => {
    await act(async () =>
      root.render(
        <MailNav
          {...defaultProps()}
          accounts={[gmailAccount, imapAccount]}
          selectedAccountId={UNIFIED_ACCOUNT_ID}
        />,
      ),
    );
    await open();

    expect(labels()).toEqual([
      "All inboxes",
      gmailAccount.emailAddress,
      imapAccount.emailAddress,
    ]);
    expect(blocks()).toEqual(["Accounts"]);
    expect(row("All inboxes").getAttribute("aria-checked")).toBe("true");
  });

  it("shortens the destinations block to what the account's capabilities name", async () => {
    await act(async () =>
      root.render(
        <MailNav
          {...defaultProps()}
          accounts={[imapAccount]}
          selectedAccountId={imapAccount.accountId}
        />,
      ),
    );
    await open();

    expect(labels()).toEqual([
      "Inbox",
      "Drafts",
      "Unread",
      "Lists",
      "People",
      "Attachments",
    ]);
  });

  it("draws no Drafts row for an account that cannot compose", async () => {
    await act(async () =>
      root.render(
        <MailNav
          {...defaultProps()}
          accounts={[readOnlyAccount]}
          selectedAccountId={readOnlyAccount.accountId}
        />,
      ),
    );
    await open();

    expect(labels()).not.toContain("Drafts");
  });

  /* TWO CHECKS, ONE PER BLOCK — the trigger's line read top to bottom: "I am
     in Inbox, at misha". */
  it("checks the destination and the account, and nothing else", async () => {
    await act(async () =>
      root.render(
        <MailNav
          {...defaultProps()}
          accounts={[gmailAccount, imapAccount]}
          selectedMailboxId="sent"
        />,
      ),
    );
    await open();

    const checked = rows()
      .filter((item) => item.getAttribute("aria-checked") === "true")
      .map((item) => item.querySelector("span")?.textContent?.trim());
    expect(checked).toEqual(["Sent", gmailAccount.emailAddress]);
  });

  it("checks Drafts while the drafts list holds the column", async () => {
    await act(async () =>
      root.render(<MailNav {...defaultProps()} draftsOpen />),
    );
    expect(trigger().getAttribute("aria-label")).toBe("Mailbox: Drafts");
    await open();

    expect(row("Drafts").getAttribute("aria-checked")).toBe("true");
    expect(row("Inbox").getAttribute("aria-checked")).toBe("false");
  });

  it("reports the right (mailbox, view) pair for every destination", async () => {
    const props = defaultProps();
    await act(async () => root.render(<MailNav {...props} />));
    await open();

    await act(async () => row("Unread").click());
    expect(props.onSelectView).toHaveBeenLastCalledWith("inbox", "unread");
    await open();
    await act(async () => row("Lists").click());
    expect(props.onSelectView).toHaveBeenLastCalledWith("inbox", "lists");
    await open();
    await act(async () => row("People").click());
    expect(props.onSelectView).toHaveBeenLastCalledWith("inbox", "people");
    await open();
    await act(async () => row("Attachments").click());
    expect(props.onSelectView).toHaveBeenLastCalledWith("all", "attachments");
    await open();
    await act(async () => row("Sent").click());
    expect(props.onSelectMailbox).toHaveBeenLastCalledWith("sent");
    await open();
    await act(async () => row("Drafts").click());
    expect(props.onOpenDrafts).toHaveBeenCalledTimes(1);
  });

  it("keeps Attachments on the inbox when the account has no All Mail", async () => {
    const props = {
      ...defaultProps(),
      accounts: [imapAccount] as readonly PublicMailAccount[],
      selectedAccountId: imapAccount.accountId,
    };
    await act(async () => root.render(<MailNav {...props} />));
    await open();

    await act(async () => row("Attachments").click());
    expect(props.onSelectView).toHaveBeenLastCalledWith("inbox", "attachments");
  });

  it("switches accounts and reaches All inboxes from the same block", async () => {
    const props = {
      ...defaultProps(),
      accounts: [gmailAccount, imapAccount] as readonly PublicMailAccount[],
    };
    await act(async () => root.render(<MailNav {...props} />));
    await open();

    await act(async () => row(imapAccount.emailAddress).click());
    expect(props.onSelectAccount).toHaveBeenLastCalledWith(
      imapAccount.accountId,
    );
    await open();
    await act(async () => row("All inboxes").click());
    expect(props.onSelectAccount).toHaveBeenLastCalledWith(UNIFIED_ACCOUNT_ID);
  });

  /* A BLOCK IS DRAWN ONLY WHERE THE MODE HAS ONE. With one account the
     Accounts block would hold a merge of one inbox, which the surface never
     enters, and the address the reader is already at — and a block of one
     row is not a block. It appears the moment a second address does. */
  it("draws no Accounts block for a single account", async () => {
    await act(async () => root.render(<MailNav {...defaultProps()} />));
    await open();

    expect(labels().at(-1)).toBe("Attachments");
    expect(labels()).not.toContain("All inboxes");
    expect(labels()).not.toContain(gmailAccount.emailAddress);
    expect(blocks()).toEqual(["—", "Smart"]);

    // a re-render with the second account is enough — no remount, no reload
    await act(async () =>
      root.render(
        <MailNav {...defaultProps()} accounts={[gmailAccount, imapAccount]} />,
      ),
    );
    expect(labels().slice(-3)).toEqual([
      "All inboxes",
      gmailAccount.emailAddress,
      imapAccount.emailAddress,
    ]);
    expect(blocks()).toEqual(["—", "Smart", "—", "Accounts"]);
  });

  /* THE COUNT STANDS ONLY ON A ROW THAT NAMES ONE MAILBOX OF ONE ACCOUNT.
     Not on All inboxes, which is not one mailbox; not on an account row,
     where it would be the loaded merge window rather than the mailbox; and
     never on the trigger, whose tail slot is the account word's. */
  it("puts the unread count on Inbox and nowhere else", async () => {
    await act(async () =>
      root.render(
        <MailNav
          {...defaultProps()}
          accounts={[gmailAccount, imapAccount]}
          inboxUnreadCount={4}
        />,
      ),
    );
    expect(trigger().textContent).not.toContain("4");
    await open();

    expect(row("Inbox").querySelector(".tree-row-count")?.textContent).toBe("4");
    for (const label of [
      "Sent",
      "All inboxes",
      gmailAccount.emailAddress,
      imapAccount.emailAddress,
    ]) {
      expect(row(label).querySelector(".tree-row-count")).toBeNull();
    }
  });

  it("hides the count when it is zero or unknown", async () => {
    await act(async () =>
      root.render(<MailNav {...defaultProps()} inboxUnreadCount={0} />),
    );
    await open();
    expect(row("Inbox").querySelector(".tree-row-count")).toBeNull();
  });

  it("carries the drafts badge and its spoken label on the Drafts row", async () => {
    await act(async () =>
      root.render(<MailNav {...defaultProps()} failedDraftCount={2} />),
    );
    await open();

    const drafts = row("Drafts");
    expect(drafts.getAttribute("aria-label")).toBe("Drafts, 2 didn’t send");
    expect(drafts.querySelector(".tree-row-count")?.textContent).toBe("2");

    // the menu stays open across the re-render — a re-render is not a press
    await act(async () =>
      root.render(<MailNav {...defaultProps()} submittingDraftCount={1} />),
    );
    expect(row("Drafts").getAttribute("aria-label")).toBe("Drafts, sending");
    expect(row("Drafts").querySelector(".tree-row-count")).toBeNull();
  });

  /* WHAT THE CONTROL SAYS AT REST. The destination first — the address moves
     rarely and the folder constantly — and the account word only where it
     says something. */
  it("names the destination, and the account only where it distinguishes one", async () => {
    const props = defaultProps();
    // one account, and it is the only one: the word would name nothing
    await act(async () => root.render(<MailNav {...props} />));
    expect(trigger().getAttribute("aria-label")).toBe("Mailbox: Inbox");

    // more than one connected: the shortest token no neighbour shares
    await act(async () =>
      root.render(
        <MailNav {...props} accounts={[gmailAccount, imapAccount]} />,
      ),
    );
    expect(trigger().getAttribute("aria-label")).toBe("Mailbox: Inbox, misha");
    expect(trigger().textContent).toContain("Inbox");
    expect(trigger().textContent).toContain("misha");

    // a smart view names itself, not the mailbox it reads
    await act(async () =>
      root.render(
        <MailNav
          {...props}
          accounts={[gmailAccount, imapAccount]}
          selectedView="unread"
        />,
      ),
    );
    expect(trigger().getAttribute("aria-label")).toBe("Mailbox: Unread, misha");

    // unified names every account at once, so no word is appended
    await act(async () =>
      root.render(
        <MailNav
          {...props}
          accounts={[gmailAccount, imapAccount]}
          selectedAccountId={UNIFIED_ACCOUNT_ID}
        />,
      ),
    );
    expect(trigger().getAttribute("aria-label")).toBe("Mailbox: All inboxes");
  });

  /* The trigger is the toolbar pill's own quiet button — no new class, no new
     material, and one backdrop layer rather than two. */
  it("rides the toolbar pill rather than a material of its own", async () => {
    await act(async () => root.render(<MailNav {...defaultProps()} />));

    const pill = trigger().closest(".toolbar-pill");
    expect(pill).not.toBeNull();
    expect(trigger().className).toContain("btn-quiet");
    expect(document.body.querySelectorAll(".toolbar-pill")).toHaveLength(1);
  });
});
