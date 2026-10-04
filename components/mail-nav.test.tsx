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

/** A pointer event of one kind at one place. jsdom's `MouseEvent` stands in
 *  for `PointerEvent` in this file, so the kind of pointer is put on it. */
function pointer(
  type: "pointermove" | "pointerover",
  clientX: number,
  clientY: number,
  pointerType = "mouse",
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
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

  /* THE ROWS LIVE IN A SCROLLER, and a scroller clips. In a short window the
     arrow keys walk rows the browser has to scroll to, and two things went
     wrong with the row it brought in. The global ring stands 2px outside its
     element, which is outside the scroller, so it drew as one bar across the
     row's top or bottom. And the row was scrolled flush to the scroller's
     edge, which is where the fade is: 20px of a 32px row dissolved at the
     bottom, 12px at the top. jsdom measures neither, so this holds the two
     declarations that fix them, and `e2e/mail-shots.spec.ts` measures the
     result in a 1024x420 and an 844x390 window. */
  it("keeps the keyboard's row whole inside the scroller", async () => {
    await act(async () =>
      root.render(
        <MailNav {...defaultProps()} accounts={[gmailAccount, imapAccount]} />,
      ),
    );
    await open();

    expect(rows()).toHaveLength(14);
    for (const item of rows()) {
      // the ring inside the row, where nothing clips it
      expect(item.classList.contains("focus-inset")).toBe(true);
    }
    const scroller = rows()[0].closest(".edge-fade");
    // the fade's own two sizes, kept clear when focus scrolls a row in
    expect(scroller?.classList.contains("scroll-pt-3")).toBe(true);
    expect(scroller?.classList.contains("scroll-pb-5")).toBe(true);
  });

  /* THE RING BELONGS TO THE KEYS. Radix focuses the row under the pointer,
     and `html[data-kbd]` clears only on a pointer DOWN, so after one arrow key
     the ring followed the mouse from row to row: a full inset ring on whatever
     the pointer was resting on, which says "the keyboard is here" about a row
     the keyboard is not on. The menu says which of the two moved focus last
     (`data-key-ring`), and globals.css draws the ring only for the keys. */
  it("says whether the keys or the pointer moved focus last", async () => {
    await act(async () => root.render(<MailNav {...defaultProps()} />));
    await open();
    const menu = document.body.querySelector<HTMLElement>(".brain-menu");
    if (!menu) throw new Error("Menu is not open");
    const press = (key: string) =>
      act(async () => {
        rows()[0].dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
    const move = (clientX: number, clientY: number, pointerType = "mouse") =>
      act(async () => {
        rows()[1].dispatchEvent(pointer("pointermove", clientX, clientY, pointerType));
      });

    // Opened by a click: the pointer has it.
    expect(menu.dataset.keyRing).toBe("pointer");

    // A modifier on its own moves nothing, so it claims nothing, and that is
    // every key that only changes what another key means.
    for (const key of [
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "AltGraph",
      "CapsLock",
      "NumLock",
      "ScrollLock",
      "Fn",
      "FnLock",
    ]) {
      await press(key);
      expect(menu.dataset.keyRing, key).toBe("pointer");
    }
    await press("ArrowDown");
    expect(menu.dataset.keyRing).toBe("keys");

    // An arrow key that scrolls the list slides a row under a resting
    // pointer, and the browser reports that as a move to where the pointer
    // already was. Only a move that goes somewhere takes the ring back.
    await move(40, 80);
    await move(40, 80);
    expect(menu.dataset.keyRing).toBe("keys");
    await move(41, 80);
    expect(menu.dataset.keyRing).toBe("pointer");

    await press("End");
    expect(menu.dataset.keyRing).toBe("keys");

    // Radix moves focus for a mouse and for nothing else, so a pen or a
    // finger passing over the menu has not taken the focus anywhere and
    // does not take the ring off the keyboard's row.
    await move(60, 90, "pen");
    await move(70, 95, "touch");
    expect(menu.dataset.keyRing).toBe("keys");
    // Nor did they leave a place behind for the mouse to be measured from.
    await move(70, 95);
    await move(72, 95);
    expect(menu.dataset.keyRing).toBe("pointer");
  });

  it("takes a mouse coming into the menu as a move, from its first event", async () => {
    await act(async () => root.render(<MailNav {...defaultProps()} />));
    await open();
    const menu = document.body.querySelector<HTMLElement>(".brain-menu");
    if (!menu) throw new Error("Menu is not open");
    await act(async () => {
      rows()[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    expect(menu.dataset.keyRing).toBe("keys");

    // A click opened this menu, so the pointer was on the trigger, outside
    // it. The first event it sent from inside used to be spent on learning
    // where it was, and the ring stayed under a pointer already on a row.
    // A pen coming in is still nobody's move.
    await act(async () => {
      rows()[1].dispatchEvent(pointer("pointerover", 40, 80, "pen"));
    });
    expect(menu.dataset.keyRing).toBe("keys");
    await act(async () => {
      rows()[1].dispatchEvent(pointer("pointerover", 40, 80));
    });
    expect(menu.dataset.keyRing).toBe("pointer");
  });

  it("forgets where the pointer was when the menu opens again", async () => {
    await act(async () => root.render(<MailNav {...defaultProps()} />));
    await open();
    await act(async () => {
      rows()[1].dispatchEvent(pointer("pointermove", 40, 80));
      rows()[1].dispatchEvent(pointer("pointermove", 50, 90));
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(document.body.querySelector(".brain-menu")).toBeNull();

    await open();
    const menu = document.body.querySelector<HTMLElement>(".brain-menu");
    if (!menu) throw new Error("Menu is not open");
    await act(async () => {
      rows()[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    // A move the menu saw no entry for (the list slid under a pointer that
    // has been resting somewhere else since the last time) has nothing from
    // this opening to be measured against, and a place from the last one
    // would call it a move.
    await act(async () => {
      rows()[1].dispatchEvent(pointer("pointermove", 60, 100));
    });
    expect(menu.dataset.keyRing).toBe("keys");
  });

  it("opens on the keys when the keyboard opened it", async () => {
    document.documentElement.dataset.kbd = "true";
    try {
      await act(async () => root.render(<MailNav {...defaultProps()} />));
      await open();
      const menu = document.body.querySelector<HTMLElement>(".brain-menu");
      expect(menu?.dataset.keyRing).toBe("keys");

      // It may have opened under a pointer that was resting there. The
      // browser reports that as the pointer coming in, with nobody having
      // moved it, so the first entry only notes the place.
      await act(async () => {
        rows()[1].dispatchEvent(pointer("pointerover", 40, 80));
        rows()[1].dispatchEvent(pointer("pointermove", 40, 80));
      });
      expect(menu?.dataset.keyRing).toBe("keys");
      // From there on it is measured like any pointer: a move to another
      // place is one, and so is coming in a second time.
      await act(async () => {
        rows()[1].dispatchEvent(pointer("pointermove", 41, 80));
      });
      expect(menu?.dataset.keyRing).toBe("pointer");
      await act(async () => {
        rows()[0].dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
      });
      expect(menu?.dataset.keyRing).toBe("keys");
      await act(async () => {
        rows()[2].dispatchEvent(pointer("pointerover", 41, 80));
      });
      expect(menu?.dataset.keyRing).toBe("pointer");
    } finally {
      delete document.documentElement.dataset.kbd;
    }
  });
});
