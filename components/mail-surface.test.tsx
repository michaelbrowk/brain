// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitMailCommand } from "./mail-commands";
import { accountWords } from "./mail-row";
import { MailSurface } from "./mail-surface";
import type { ToastOptions } from "./ui/primitives";

// Animation playback is not under test — assert structure and props. The real
// AnimatePresence keeps exiting subtrees mounted through their exit animation,
// which jsdom never advances, so the mock renders children directly.
vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({ reducedMotion: false });
});
import {
  defaultMailSurfaceClient,
  MailApiError,
} from "./mail-surface-client";
import type {
  MailContentAttachmentDto,
  MailMessageContent,
} from "@/lib/mail/content-types";
import type {
  MailDraftSendResult,
  MailMailboxThreadPage,
  MailSearchThreadPage,
  MailSurfaceClient,
  MailSystemMailbox,
  MailThreadDetail,
  MailThreadListItem,
  MailThreadPage,
  PublicMailAccount,
} from "./mail-surface-client";

const gmailCapabilities = {
  mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
  listThreads: true,
  sync: true,
  headerPreview: true,
  messageBodies: true,
  threadMutations: true,
  compose: true,
  send: true,
  reply: true,
} as const;

const imapCapabilities = {
  mailboxes: ["inbox"],
  listThreads: true,
  sync: true,
  headerPreview: true,
  messageBodies: false,
  threadMutations: false,
  compose: false,
  send: false,
  reply: false,
} as const;

const accountA: PublicMailAccount = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  emailAddress: "person@example.test",
  displayName: "Personal",
  status: "connected",
  connectedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerKind: "gmail",
  capabilities: gmailCapabilities,
};

const accountB: PublicMailAccount = {
  accountId: "account-affffffffffffffffffffffffffffffff",
  emailAddress: "person@gmail.test",
  displayName: null,
  status: "connected",
  connectedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerKind: "gmail",
  capabilities: gmailCapabilities,
};

const imapAccount: PublicMailAccount = {
  ...accountA,
  providerKind: "imap",
  capabilities: imapCapabilities,
  imap: {
    hostname: "imap.example.test",
    port: 993,
    tls: "implicit",
    username: "person@example.test",
  },
};

/** A custom domain that also carries an SMTP transport, so it can send. */
const smtpImapAccount: PublicMailAccount = {
  ...imapAccount,
  capabilities: {
    ...imapCapabilities,
    compose: true,
    send: true,
    reply: true,
  },
  smtp: {
    hostname: "smtp.example.test",
    port: 465,
    tls: "implicit",
    username: "person@example.test",
  },
};

// Read by default: opening an unread thread auto-marks it read, so tests
// about other flows use a read thread to keep that mutation out of their
// call counts. The "auto-read on open" block owns the unread scenarios.
const thread = {
  accountId: accountA.accountId,
  threadId: "thread-1",
  subject: "Lunch this Friday?",
  participants: [{ name: "Ben Johnson", address: "ben@example.test" }],
  snippet: "12PM sounds great to me.",
  lastMessageAt: 1_700_000_000_000,
  messageCount: 2,
  unread: false,
  starred: false,
  hasAttachments: false,
  listMessage: false,
  sizeBytes: 0,
  category: "people",
} as const;

const threadPage: MailThreadPage = {
  apiVersion: 1,
  items: [thread],
  nextCursor: null,
  sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
};

function mailboxThreadPage(
  mailboxId: MailSystemMailbox,
  items: MailMailboxThreadPage["items"] = [thread],
): MailMailboxThreadPage {
  return {
    apiVersion: 1,
    mailboxId,
    items,
    nextCursor: null,
    availability: {
      status: "available",
      lastSuccessfulAt: 1_700_000_000_000,
      windowTruncated: false,
    },
  };
}

function searchThreadPage(
  mailboxId: MailSystemMailbox,
  items: MailSearchThreadPage["items"] = [thread],
): MailSearchThreadPage {
  return {
    apiVersion: 1,
    mailboxId,
    scope: "headers_and_previews",
    items,
    nextCursor: null,
    availability: {
      status: "available",
      lastSuccessfulAt: 1_700_000_000_000,
      windowTruncated: false,
    },
    indexStatus: "ready",
    resultsTruncated: false,
  };
}

const detail: MailThreadDetail = {
  apiVersion: 1,
  thread,
  messages: [
    {
      accountId: accountA.accountId,
      messageId: "message-1",
      threadId: thread.threadId,
      from: { name: "Ben Johnson", address: "ben@example.test" },
      replyTo: [],
      to: [{ name: "Personal", address: accountA.emailAddress }],
      cc: [],
      subject: thread.subject,
      sentAt: 1_700_000_000_000,
      unread: true,
      inInbox: true,
      snippet: "Safe preview",
      textBody: "Lunch at 12PM sounds great to me.",
      htmlBody: '<img src="https://tracker.example.test/pixel">',
      hasAttachments: false,
    },
  ],
};

const readyContent = {
  apiVersion: 1,
  accountId: accountA.accountId,
  messageId: "message-1",
  state: "ready" as const,
  textBody: "Lunch at 12PM sounds great to me.",
  htmlBody: null,
  attachments: [],
};

function makeClient(overrides: Partial<MailSurfaceClient> = {}): MailSurfaceClient {
  return {
    loadAccounts: vi.fn().mockResolvedValue([accountA]),
    listThreads: vi.fn().mockResolvedValue(threadPage),
    listMailboxThreads: vi
      .fn()
      .mockImplementation(({ mailboxId }) =>
        Promise.resolve(mailboxThreadPage(mailboxId)),
      ),
    searchThreads: vi
      .fn()
      .mockImplementation(({ mailboxId }) =>
        Promise.resolve(searchThreadPage(mailboxId)),
      ),
    readThread: vi.fn().mockResolvedValue(detail),
    readMailboxThread: vi.fn().mockResolvedValue(detail),
    getMessageContent: vi.fn().mockResolvedValue(readyContent),
    requestMessageContent: vi.fn().mockResolvedValue(readyContent),
    sync: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({
      apiVersion: 1,
      operationId: "operation-1",
      created: true,
      status: "queued",
    }),
    createDraft: vi.fn().mockImplementation((input) =>
      Promise.resolve({
        draftId: input.draftId,
        accountId: input.accountId,
        revision: 0,
        state: "editing",
        intent: input.intent,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
        updatedAt: 1_700_000_000_000,
      }),
    ),
    listDrafts: vi.fn().mockResolvedValue([]),
    getDraft: vi.fn().mockImplementation((input) =>
      Promise.resolve({
        draftId: input.draftId,
        accountId: input.accountId,
        revision: 1,
        state: "editing",
        intent: { kind: "compose" },
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        text: "",
        updatedAt: 1_700_000_000_000,
      }),
    ),
    patchDraft: vi.fn().mockImplementation((input) =>
      Promise.resolve({
        replayed: false,
        appliedRevision: input.expectedRevision + 1,
      }),
    ),
    deleteDraft: vi.fn().mockResolvedValue({ replayed: false }),
    sendDraft: vi.fn().mockImplementation((input) =>
      Promise.resolve({
        replayed: false,
        appliedRevision: input.expectedRevision + 1,
        operationId: input.sendOperationId,
        created: true,
        status: "sent",
      }),
    ),
    getSendOperation: vi.fn().mockImplementation((operationId) =>
      Promise.resolve({
        apiVersion: 1,
        operationId,
        status: "sent",
      }),
    ),
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function verifiedInlineHeaders(bytes: number, filename: string) {
  return {
    "Content-Type": "image/png",
    "Content-Length": String(bytes),
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy":
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
  };
}

function inlineContentAttachment(
  suffix: string,
  contentId: string,
  bytes: number,
): MailContentAttachmentDto {
  return {
    attachmentId: `attachment-a${suffix.repeat(32)}`,
    filename: `${contentId}.png`,
    mimeType: "image/png",
    disposition: "inline",
    contentId,
    bytes,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Radix's FocusScope dispatches its unmount-auto-focus event from a
 *  `setTimeout(…, 0)`, so `returnFocus` lands a macrotask after the dialog
 *  closes — `settle` only flushes microtasks and would race it. */
async function settleFocus() {
  await settle();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findButton(name: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim().includes(name) || candidate.getAttribute("aria-label") === name,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`);
  return button;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

/** Answers Brain's own confirmation, which replaced two `window.confirm`s.
 *  `action` is the destructive button's label; "Cancel" is the way out. */
async function confirmSystemDialog(action: string) {
  const dialog = document.body.querySelector('[role="alertdialog"]');
  if (!dialog) throw new Error("No confirmation dialog is open");
  // Scoped to the dialog on purpose: the control that OPENED it wears the
  // same word, and a global search would press it again.
  const button = [...dialog.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === action,
  );
  if (!button) throw new Error(`No "${action}" in the confirmation`);
  await click(button);
}

/** The word the nav trigger appends to the destination — resolved by the
 *  same function the merged rows use, so the expectation cannot drift from
 *  the component. */
function accountWordFor(
  target: PublicMailAccount,
  connected: readonly PublicMailAccount[],
): string | undefined {
  return accountWords(connected.map((account) => account.emailAddress)).get(
    target.emailAddress,
  );
}

/** THE ONE CONTROL THAT OWNS MAIL NAVIGATION. It names the destination the
 *  column stands at and opens the single menu where accounts, mailboxes,
 *  smart views and Drafts all lie in one list — so every navigation these
 *  tests make goes through it, and there is no second door to check. */
function navTrigger(): HTMLButtonElement | null {
  const found = document.body.querySelector('button[aria-label^="Mailbox: "]');
  return found instanceof HTMLButtonElement ? found : null;
}

async function openNav() {
  const trigger = navTrigger();
  if (!trigger) throw new Error("Mail nav trigger not found");
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
  await settle();
}

async function closeNav() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await settle();
}

/** A row of the nav menu, matched on its LABEL rather than the whole row:
 *  Inbox carries an unread count and Drafts a failed-send one. */
function navItem(label: string): HTMLElement | null {
  const found = [
    ...document.body.querySelectorAll('[role="menuitemradio"]'),
  ].find(
    (candidate) => candidate.querySelector("span")?.textContent?.trim() === label,
  );
  return found instanceof HTMLElement ? found : null;
}

/** Go somewhere — a mailbox, a smart view, Drafts, an account, All inboxes.
 *  One door for every one of them, which is the point of the control. */
async function goTo(label: string) {
  await openNav();
  const item = navItem(label);
  if (!item) throw new Error(`Nav destination not found: ${label}`);
  await click(item);
}

/** Every destination the menu is offering right now, in order. */
function navDestinations(): readonly string[] {
  return [...document.body.querySelectorAll('[role="menuitemradio"]')].map(
    (item) => item.querySelector("span")?.textContent?.trim() ?? "",
  );
}

/** The menu's block labels — `Smart`, `Accounts` — in order. A block is
 *  drawn only where the mode has one, so which labels are up is a fact. */
function navLabels(): readonly string[] {
  return [...document.body.querySelectorAll(".brain-menu-label")].map(
    (label) => label.textContent?.trim() ?? "",
  );
}

/**
 * The surface mounts into the unified All-inboxes mode by default. Tests that
 * exercise single-account behavior switch through the Accounts block of the
 * nav menu, the way the reader does. No-ops when the surface is not up or the
 * account is not offered (removed account, failed accounts load).
 */
async function enterSingleAccount(target: PublicMailAccount = accountA) {
  const trigger = navTrigger();
  if (!trigger) return;
  // A lone account is already in its Inbox — the merge, and the Accounts
  // block that leaves it, exist only with a second account (§13). The trigger
  // says which case this is without a menu: the account word after the comma
  // is appended only where a second account exists. Opening a menu only to
  // close it again would also hand focus back to the trigger a beat later
  // (Radix), a stray move inside a keyboard test.
  const label = trigger.getAttribute("aria-label") ?? "";
  if (label !== "Mailbox: All inboxes" && !label.includes(",")) return;
  await openNav();
  const row = [
    ...document.body.querySelectorAll('[role="menuitemradio"]'),
  ].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === `Open ${target.emailAddress}`,
  );
  if (!(row instanceof HTMLElement)) {
    await closeNav();
    return;
  }
  await click(row);
}

/** The toolbar's failed-send alarm, which is not the nav menu's Drafts row:
 *  it exists only while there is a failed send to report. */
function draftsAlarm(label: string): HTMLButtonElement | null {
  const button = document.body.querySelector(
    `section[aria-label="Mailbox"] button[aria-label="${label}"]`,
  );
  return button instanceof HTMLButtonElement ? button : null;
}

function findMenuItem(name: string): HTMLElement {
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(item instanceof HTMLElement)) throw new Error(`Menu item not found: ${name}`);
  return item;
}

async function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("MailSurface", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("PointerEvent", MouseEvent);
    window.history.replaceState({}, "", "/mail");
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads Inbox and exposes the supported system folders", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    // The control names the DESTINATION, never the display name — the label
    // a reader typed into settings is not the address the column stands at,
    // and the full address is one press away in the Accounts block.
    expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
    expect(document.body.textContent).toContain("Inbox");
    expect(document.body.textContent).toContain("Ben Johnson");
    // The thread count is a chip beside the sender — never a bare tabular
    // run left of the date, where two tabular runs read as one number.
    const row = [...document.body.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Lunch this Friday?"),
    );
    expect(row?.querySelector(".brain-mail-count")?.textContent).toBe("2");
    expect(document.body.textContent).toContain("Lunch this Friday?");
    // The folders are named where a reader goes to change one, and nowhere
    // else: the column's head says where it stands, the menu says where it
    // could stand instead.
    // Drafts IS a destination and stands in the same block, between Sent and
    // All Mail — it holds the column the way a folder does. It is still not a
    // mailbox: nothing asks the service for a "drafts" folder.
    await openNav();
    expect(navDestinations().slice(0, 7)).toEqual([
      "Inbox",
      "Starred",
      "Sent",
      "Drafts",
      "All Mail",
      "Spam",
      "Trash",
    ]);
    await closeNav();
    expect(client.listThreads).toHaveBeenCalledWith(
      { accountId: accountA.accountId, limit: 50 },
      expect.any(AbortSignal),
    );
  });

  it("starts the first sync automatically and shows its first visible page", async () => {
    const firstPage: MailThreadPage = {
      apiVersion: 1,
      items: [],
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: null },
    };
    const listThreads = vi
      .fn()
      // A lone account mounts straight into its Inbox: one page-1 load, then
      // the refresh the first sync triggers.
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(threadPage);
    const client = makeClient({ listThreads });

    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await settle();

    expect(client.sync).toHaveBeenCalledWith(
      { accountId: accountA.accountId },
      expect.any(AbortSignal),
    );
    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Lunch this Friday?");
  });

  it("searches the selected mailbox after a short debounce and reports bounded indexing", async () => {
    vi.useFakeTimers();
    const searchThreads = vi
      .fn()
      .mockResolvedValueOnce({
        ...searchThreadPage("inbox"),
        indexStatus: "building",
        resultsTruncated: true,
      })
      .mockResolvedValueOnce(searchThreadPage("inbox"));
    const client = makeClient({ searchThreads });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    const input = document.body.querySelector(
      'input[aria-label="Search mail"]',
    ) as HTMLInputElement;
    expect(input.className).toContain("text-[16px]");
    await setInput(input, "Lunch");
    expect(searchThreads).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(180));
    await settle();

    expect(searchThreads).toHaveBeenCalledWith(
      {
        accountId: accountA.accountId,
        mailboxId: "inbox",
        query: "Lunch",
        limit: 50,
      },
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).toContain(
      "Indexing cached mail — results are partial",
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await settle();
    expect(searchThreads).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "Searching cached headers and previews",
    );
  });

  it("rejects server-invalid search text before the network without reporting an outage", async () => {
    vi.useFakeTimers();
    const searchThreads = vi.fn().mockResolvedValue(searchThreadPage("inbox"));
    const client = makeClient({ searchThreads });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    const input = document.body.querySelector(
      'input[aria-label="Search mail"]',
    ) as HTMLInputElement;

    for (const invalid of [
      "é".repeat(129),
      Array.from({ length: 13 }, (_, index) => `term${index}`).join(" "),
      "a".repeat(65),
      "🙂 !!!",
    ]) {
      await setInput(input, invalid);
      await act(async () => vi.advanceTimersByTimeAsync(200));
      await settle();
      expect(document.body.textContent).toContain("Search needs different words");
      expect(document.body.textContent).not.toContain("Inbox couldn’t load");
    }
    expect(searchThreads).not.toHaveBeenCalled();
  });

  it("does not let a late search or silent refresh replace the active query", async () => {
    vi.useFakeTimers();
    const oldSearch = deferred<MailSearchThreadPage>();
    const oldThread = { ...thread, threadId: "old-search", subject: "Old search" };
    const newThread = { ...thread, threadId: "new-search", subject: "New search" };
    const searchThreads = vi.fn().mockImplementation(({ query }) =>
      query === "old"
        ? oldSearch.promise
        : Promise.resolve(searchThreadPage("inbox", [newThread])),
    );
    const listThreads = vi.fn().mockResolvedValue(threadPage);
    const client = makeClient({ searchThreads, listThreads });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    const input = document.body.querySelector(
      'input[aria-label="Search mail"]',
    ) as HTMLInputElement;

    await setInput(input, "old");
    await act(async () => vi.advanceTimersByTimeAsync(180));
    await setInput(input, "new");
    await act(async () => vi.advanceTimersByTimeAsync(180));
    await settle();
    expect(document.body.textContent).toContain("New search");

    await act(async () => oldSearch.resolve(searchThreadPage("inbox", [oldThread])));
    await settle();
    expect(document.body.textContent).toContain("New search");
    expect(document.body.textContent).not.toContain("Old search");

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await settle();
    // One page-1 load on mount (a lone account opens its own Inbox) — and none
    // from the silent tick while a query is active.
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("New search");
  });

  it("paginates search without duplicating threads", async () => {
    vi.useFakeTimers();
    const nextThread = { ...thread, threadId: "search-next", subject: "Next match" };
    const searchThreads = vi
      .fn()
      .mockResolvedValueOnce({
        ...searchThreadPage("inbox"),
        nextCursor: "search-cursor",
      })
      .mockResolvedValueOnce(searchThreadPage("inbox", [thread, nextThread]));
    const client = makeClient({ searchThreads });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await setInput(
      document.body.querySelector('input[aria-label="Search mail"]') as HTMLInputElement,
      "match",
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    await settle();
    await click(findButton("Load more"));

    expect(searchThreads).toHaveBeenLastCalledWith({
      accountId: accountA.accountId,
      mailboxId: "inbox",
      query: "match",
      cursor: "search-cursor",
      limit: 50,
    });
    expect(document.body.textContent).toContain("Next match");
    expect(document.body.querySelectorAll('[role="listitem"]')).toHaveLength(2);
  });

  it("requests isolated content and renders its sanitized text instead of thread HTML", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(document.body.textContent).toContain("Lunch at 12PM sounds great to me.");
    expect(document.body.querySelector('img[src*="tracker.example"]')).toBeNull();
    expect(client.requestMessageContent).toHaveBeenCalledWith(
      { accountId: accountA.accountId, messageId: "message-1" },
      expect.any(AbortSignal),
    );
    expect(client.readThread).toHaveBeenCalledWith({
      accountId: accountA.accountId,
      threadId: thread.threadId,
    });
  });

  it("keeps an IMAP account in truthful Inbox header-preview mode", async () => {
    const client = makeClient({
      loadAccounts: vi.fn().mockResolvedValue([imapAccount]),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    expect(document.querySelector('[aria-label="New message"]')).toBeNull();
    expect(document.querySelector('[aria-label="Drafts"]')).toBeNull();
    // The account's capabilities name one mailbox and no compose, so its
    // block is Inbox alone — the same menu, shorter, never a second design.
    // And it is the only account, so there is no Accounts block either.
    expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
    await openNav();
    expect(navDestinations()).toEqual([
      "Inbox",
      "Unread",
      "Lists",
      "People",
      "Attachments",
    ]);
    expect(navLabels()).toEqual(["Smart"]);
    await closeNav();

    await click(findButton("Lunch this Friday?"));

    expect(document.body.textContent).toContain("Safe preview");
    expect(document.body.textContent).toContain("Header preview only.");
    expect(document.body.textContent).not.toContain(
      "Lunch at 12PM sounds great to me.",
    );
    expect(document.querySelector('[aria-label="More mail actions"]')).toBeNull();
    expect(
      [...document.body.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Reply",
      ),
    ).toBe(false);
    expect(client.requestMessageContent).not.toHaveBeenCalled();
    expect(client.getMessageContent).not.toHaveBeenCalled();
    expect(client.updateThread).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("bounds full-message workflows across a long thread to two", async () => {
    vi.useFakeTimers();
    const messages = Array.from({ length: 5 }, (_value, index) => ({
      ...detail.messages[0]!,
      messageId: `message-${index + 1}`,
      sentAt: 1_700_000_000_000 + index,
    }));
    const releases: Array<() => void> = [];
    const requests: Array<{
      readonly messageId: string;
      readonly signal: AbortSignal;
    }> = [];
    let active = 0;
    let maximum = 0;
    const requestMessageContent = vi.fn(
      (
        input: { readonly accountId: string; readonly messageId: string },
        signal: AbortSignal,
      ) =>
        new Promise<MailMessageContent>((resolve) => {
          active++;
          maximum = Math.max(maximum, active);
          requests.push({ messageId: input.messageId, signal });
          releases.push(() => {
            active--;
            resolve({ ...readyContent, apiVersion: 1, messageId: input.messageId });
          });
        }),
    );
    const client = makeClient({
      readThread: vi.fn().mockResolvedValue({ ...detail, messages }),
      requestMessageContent,
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(requestMessageContent).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.messageId)).toEqual([
      "message-5",
      "message-4",
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    releases.splice(0).forEach((release) => release());
    await settle();
    expect(requestMessageContent).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(requests.slice(2).every((request) => !request.signal.aborted)).toBe(true);

    releases.splice(0).forEach((release) => release());
    await settle();
    expect(requestMessageContent).toHaveBeenCalledTimes(5);
    releases.splice(0).forEach((release) => release());
    await settle();

    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("polls the content endpoint after a queued request", async () => {
    vi.useFakeTimers();
    const fetching = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "fetching" as const,
    };
    const getMessageContent = vi.fn().mockResolvedValue(readyContent);
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue(fetching),
      getMessageContent,
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();

    expect(getMessageContent).toHaveBeenCalledWith(
      { accountId: accountA.accountId, messageId: "message-1" },
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).toContain("Lunch at 12PM sounds great to me.");
  });

  it("keeps polling a transient worker retry until the message becomes ready", async () => {
    vi.useFakeTimers();
    const fetching = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "fetching" as const,
    };
    const transient = { ...fetching, state: "transient" as const };
    const getMessageContent = vi
      .fn()
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(readyContent);
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue(fetching),
      getMessageContent,
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await settle();

    expect(getMessageContent).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("Message content couldn’t load.");
    expect(document.body.textContent).toContain("Lunch at 12PM sounds great to me.");
  });

  it("asks again after a run of transient polls instead of waiting out the deadline", async () => {
    vi.useFakeTimers();
    const fetching = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "fetching" as const,
    };
    const transient = { ...fetching, state: "transient" as const };
    const retried = { ...readyContent, textBody: "Full body after the retry." };
    const requestMessageContent = vi
      .fn()
      .mockResolvedValueOnce(fetching)
      .mockResolvedValueOnce(retried);
    const getMessageContent = vi.fn().mockResolvedValue(transient);
    const client = makeClient({ requestMessageContent, getMessageContent });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    // three transient polls at 0, 300 and 900ms, then the re-ask at 2.1s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await settle();

    expect(requestMessageContent).toHaveBeenCalledTimes(2);
    expect(getMessageContent).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("Full body after the retry.");
    expect(document.body.textContent).not.toContain("Message content couldn’t load.");
  });

  it("polls until the content deadline and leaves a retryable safe preview", async () => {
    vi.useFakeTimers();
    const fetching = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "fetching" as const,
    };
    const getMessageContent = vi.fn().mockResolvedValue(fetching);
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue(fetching),
      getMessageContent,
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(document.body.textContent).toContain("Lunch at 12PM sounds great to me.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await settle();

    expect(document.body.textContent).not.toContain("Message content couldn’t load.");
    expect(getMessageContent.mock.calls.length).toBeGreaterThan(6);
    // Still inside the 30-second budget: the safe preview stays error-free.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    await settle();
    expect(document.body.textContent).not.toContain("Message content couldn’t load.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();

    expect(document.body.textContent).toContain("Message content couldn’t load.");
    expect(findButton("Try again").disabled).toBe(false);
    expect(document.body.textContent).toContain("Lunch at 12PM sounds great to me.");
  });

  it("decodes the provider snippet it shows while the body is still loading", async () => {
    const client = makeClient({
      readThread: vi.fn().mockResolvedValue({
        ...detail,
        messages: [
          {
            ...detail.messages[0]!,
            textBody: null,
            snippet: "Don&#39;t forget [image] the 2pm &amp; the invoice",
          },
        ],
      }),
      requestMessageContent: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(document.body.textContent).toContain(
      "Don't forget the 2pm & the invoice",
    );
    expect(document.body.textContent).not.toContain("&#39;");
  });

  it("asks again when the content entry is no longer being fetched", async () => {
    vi.useFakeTimers();
    const fetching = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "fetching" as const,
    };
    const dropped = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "not_requested" as const,
    };
    const requestMessageContent = vi
      .fn()
      .mockResolvedValueOnce(fetching)
      .mockResolvedValue(readyContent);
    const getMessageContent = vi.fn().mockResolvedValue(dropped);
    const client = makeClient({ requestMessageContent, getMessageContent });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle();

    // Polling a dropped entry would have shown the preview until the 30s
    // deadline; a second request enqueues the work that makes it ready.
    expect(requestMessageContent).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Lunch at 12PM sounds great to me.");
    expect(document.body.textContent).not.toContain("Message content couldn’t load.");
  });

  it("pauses content polling while the tab is hidden", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const fetching = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "fetching" as const,
    };
    const getMessageContent = vi.fn().mockResolvedValue(readyContent);
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue(fetching),
      getMessageContent,
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    visibility.mockReturnValue("hidden");
    await click(findButton("Lunch this Friday?"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(getMessageContent).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(getMessageContent).toHaveBeenCalledTimes(1);
  });

  it("keeps a safe cached text body while enhanced content is pending and after it fails", async () => {
    let rejectContent: (reason?: unknown) => void = () => {};
    const pendingContent = new Promise<never>((_resolve, reject) => {
      rejectContent = reject;
    });
    const client = makeClient({
      requestMessageContent: vi.fn().mockReturnValue(pendingContent),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(document.body.textContent).toContain("Lunch at 12PM sounds great to me.");
    await act(async () => rejectContent(new Error("content unavailable")));
    await settle();
    expect(document.body.textContent).toContain("Message content couldn’t load.");
    expect(document.body.textContent).toContain("Lunch at 12PM sounds great to me.");
  });

  it.each([
    ["quoted-printable", "=E2=80=8C =C2=A0 encoded preview"],
    ["base64", "QUFB".repeat(64)],
  ])("uses the provider snippet instead of a raw %s fallback", async (_label, textBody) => {
    let rejectContent: (reason?: unknown) => void = () => {};
    const pendingContent = new Promise<never>((_resolve, reject) => {
      rejectContent = reject;
    });
    const client = makeClient({
      readThread: vi.fn().mockResolvedValue({
        ...detail,
        messages: [{ ...detail.messages[0]!, textBody }],
      }),
      requestMessageContent: vi.fn().mockReturnValue(pendingContent),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(document.body.textContent).toContain("Safe preview");
    expect(document.body.textContent).not.toContain(textBody);
    await act(async () => rejectContent(new Error("content unavailable")));
    await settle();
    expect(document.body.textContent).toContain("Safe preview");
    expect(document.body.textContent).not.toContain(textBody);
  });

  it("prefers the sanitized HTML alternative over a malformed plain-text part", async () => {
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        textBody: "=E2=80=8C malformed fallback",
        htmlBody: "<p>Decoded newsletter</p>",
      }),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    const frame = document.body.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.srcdoc).toContain("Decoded newsletter");
    expect(document.body.textContent).not.toContain("=E2=80=8C malformed fallback");
  });

  it("uses a clean plain alternative when the HTML decoder had replacement characters", async () => {
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        textBody: "Readable plain message",
        htmlBody: "<p>Damaged \ufffd\ufffd HTML</p>",
      }),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(document.body.querySelector("iframe")).toBeNull();
    expect(document.body.textContent).toContain("Readable plain message");
    expect(document.body.textContent).not.toContain("Damaged");
  });

  it("uses readable plain text when sanitized HTML has no visible content", async () => {
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        textBody: "Readable plain message",
        htmlBody: "<div><span>&nbsp;</span></div>",
      }),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(document.body.querySelector("iframe")).toBeNull();
    expect(document.body.textContent).toContain("Readable plain message");
  });

  it("falls back to the provider preview when ready text is malformed", async () => {
    const client = makeClient({
      readThread: vi.fn().mockResolvedValue({
        ...detail,
        messages: [{ ...detail.messages[0]!, textBody: null }],
      }),
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        textBody: "=ZZ hello \ufffd",
        htmlBody: null,
      }),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(document.body.textContent).toContain("Safe preview");
    expect(document.body.textContent).not.toContain("=ZZ hello");
  });

  it("falls back to the provider preview when ready HTML is still transfer-encoded", async () => {
    const client = makeClient({
      readThread: vi.fn().mockResolvedValue({
        ...detail,
        messages: [{ ...detail.messages[0]!, textBody: null }],
      }),
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        textBody: null,
        htmlBody: "<p>=CD=8F =E2=80=8C =C2=A0</p>",
      }),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    expect(document.body.querySelector("iframe")).toBeNull();
    expect(document.body.textContent).toContain("Safe preview");
    expect(document.body.textContent).not.toContain("=CD=8F");
  });

  it("renders a short HTML-only reply instead of treating it as empty", async () => {
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        textBody: null,
        htmlBody: "<p>OK</p>",
      }),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    const frame = document.body.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.srcdoc).toContain("<p>OK</p>");
  });

  it.each([
    ["both alternatives are damaged", "Damaged \ufffd plain"],
    ["plain text is still quoted-printable", "=E2=80=8C encoded plain"],
  ])("keeps sanitized HTML when %s", async (_label, textBody) => {
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        textBody,
        htmlBody: "<p>Preferred \ufffd HTML</p>",
      }),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    const frame = document.body.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.srcdoc).toContain("Preferred \ufffd HTML");
    expect(document.body.textContent).not.toContain(textBody);
  });

  it("keeps HTML-only mail in a no-script sandbox and uses the attachment proxy", async () => {
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        textBody: null,
        htmlBody: "<p>HTML-only mail</p>",
        attachments: [
          {
            attachmentId: "attachment-a33333333333333333333333333333333",
            filename: "report.pdf",
            mimeType: "application/pdf",
            disposition: "attachment",
            contentId: null,
            bytes: 1_536,
          },
        ],
      }),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    const frame = document.body.querySelector("iframe") as HTMLIFrameElement;
    const download = document.body.querySelector('a[download="report.pdf"]') as HTMLAnchorElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("script-src 'none'");
    expect(download.getAttribute("href")).toBe(
      `/api/mail/attachments/attachment-a33333333333333333333333333333333?accountId=${accountA.accountId}`,
    );
    expect(document.body.textContent).toContain("2 KB");
  });

  it("loads a verified CID through the parent proxy and revokes its blob URL", async () => {
    const bytes = Buffer.from("verified png bytes");
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:https://brain.test/verified-logo");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    const request = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(bytes.byteLength),
          "Content-Disposition":
            `attachment; filename="logo.png"; filename*=UTF-8''logo.png`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Security-Policy":
            "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
        },
      }),
    );
    vi.stubGlobal("fetch", request);
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        textBody: null,
        htmlBody: '<img data-brain-cid="logo@example.test" alt="Logo">',
        attachments: [
          {
            attachmentId: "attachment-a33333333333333333333333333333333",
            filename: "logo.png",
            mimeType: "image/png",
            disposition: "inline",
            contentId: "logo@example.test",
            bytes: bytes.byteLength,
          },
        ],
      }),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const frame = document.body.querySelector("iframe") as HTMLIFrameElement;
    expect(request).toHaveBeenCalledWith(
      `/api/mail/attachments/attachment-a33333333333333333333333333333333?accountId=${accountA.accountId}`,
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }),
    );
    expect(frame.srcdoc).toContain('src="blob:https://brain.test/verified-logo"');
    expect(frame.srcdoc).not.toContain("/api/mail/attachments/");

    await click(findButton("Back to Inbox"));
    expect(revokeObjectURL).toHaveBeenCalledWith(
      "blob:https://brain.test/verified-logo",
    );
  });

  it("revokes completed CID blobs and aborts remaining work when content switches", async () => {
    const bytes = Buffer.from("verified png bytes");
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:https://brain.test/first-inline");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    let pendingSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("attachment-a333")) {
          return Promise.resolve(
            new Response(bytes, {
              status: 200,
              headers: verifiedInlineHeaders(bytes.byteLength, "first.png"),
            }),
          );
        }
        if (url.includes("attachment-a444")) {
          return Promise.resolve(
            new Response(bytes, {
              status: 200,
              headers: {
                ...verifiedInlineHeaders(bytes.byteLength, "broken.png"),
                "Cross-Origin-Resource-Policy": "cross-origin",
              },
            }),
          );
        }
        pendingSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          pendingSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const otherThread = {
      ...thread,
      threadId: "thread-2",
      subject: "Second conversation",
      lastMessageAt: thread.lastMessageAt + 1,
    };
    const cidContent: Extract<MailMessageContent, { state: "ready" }> = {
      ...readyContent,
      apiVersion: 1,
      textBody: null,
      htmlBody: [
        '<img data-brain-cid="first@example.test" alt="First">',
        '<img data-brain-cid="broken@example.test" alt="Broken">',
        '<img data-brain-cid="pending@example.test" alt="Pending">',
      ].join(""),
      attachments: [
        inlineContentAttachment("3", "first@example.test", bytes.byteLength),
        inlineContentAttachment("4", "broken@example.test", bytes.byteLength),
        inlineContentAttachment("5", "pending@example.test", bytes.byteLength),
      ],
    };
    const secondContent: Extract<MailMessageContent, { state: "ready" }> = {
      ...readyContent,
      apiVersion: 1,
      messageId: "message-2",
      textBody: "Second body",
    };
    const client = makeClient({
      listThreads: vi.fn().mockResolvedValue({
        ...threadPage,
        items: [thread, otherThread],
      }),
      readThread: vi.fn(({ threadId }) =>
        Promise.resolve(
          threadId === thread.threadId
            ? detail
            : {
                ...detail,
                thread: otherThread,
                messages: [
                  {
                    ...detail.messages[0]!,
                    messageId: "message-2",
                    threadId: otherThread.threadId,
                    subject: otherThread.subject,
                  },
                ],
              },
        ),
      ),
      requestMessageContent: vi.fn(({ messageId }) =>
        Promise.resolve(
          messageId === "message-1"
            ? cidContent
            : secondContent,
        ),
      ),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(pendingSignal?.aborted).toBe(false);

    await click(findButton("Second conversation"));

    expect(pendingSignal?.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith(
      "blob:https://brain.test/first-inline",
    );
    expect(document.body.textContent).toContain("Second body");
  });

  it("cancels a content request when the reader closes", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetching = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "fetching" as const,
    };
    const getMessageContent = vi.fn().mockResolvedValue(fetching);
    const client = makeClient({
      requestMessageContent: vi.fn((_input, requestSignal: AbortSignal) => {
        signal = requestSignal;
        return Promise.resolve(fetching);
      }),
      getMessageContent,
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(signal?.aborted).toBe(false);
    expect(getMessageContent).toHaveBeenCalledTimes(1);
    await click(findButton("Back to Inbox"));
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(getMessageContent).toHaveBeenCalledTimes(1);
  });

  it("prefills a reply, creates its durable draft, and sends it atomically", async () => {
    const client = makeClient();
    const onToast = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await click(findButton("Reply"));

    await vi.waitFor(() =>
      expect(client.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: accountA.accountId,
          draftId: expect.stringMatching(/^draft-/),
          intent: { kind: "reply", sourceMessageId: "message-1" },
          to: "ben@example.test",
          subject: "Re: Lunch this Friday?",
        }),
      ),
    );
    const to = document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement;
    const subject = [...document.body.querySelectorAll("input")].find(
      (input) => input.placeholder === "Subject",
    ) as HTMLInputElement;
    expect(to.value).toBe("ben@example.test");
    expect(subject.value).toBe("Re: Lunch this Friday?");
    await setInput(document.body.querySelector("textarea") as HTMLTextAreaElement, "See you there.");
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(client.sendDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: accountA.accountId,
          draftId: expect.stringMatching(/^draft-/),
          mutationId: expect.stringMatching(/^draft-mutation-/),
          expectedRevision: expect.any(Number),
          sendOperationId: expect.stringMatching(/^send-/),
          sendIdempotencyKey: expect.any(String),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("Message sent"),
    );
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("uses Reply-To and builds Reply all without self or duplicate recipients", async () => {
    const replyAllDetail: MailThreadDetail = {
      ...detail,
      messages: [
        {
          ...detail.messages[0]!,
          replyTo: [{ name: "Team replies", address: "reply@example.test" }],
          to: [
            { name: "Personal", address: accountA.emailAddress },
            { name: "Alex", address: "alex@example.test" },
          ],
          cc: [
            { name: "Duplicate", address: "REPLY@example.test" },
            { name: "Casey", address: "casey@example.test" },
          ],
        },
      ],
    };
    const client = makeClient({ readThread: vi.fn().mockResolvedValue(replyAllDetail) });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await act(async () => {
      findButton("More mail actions").dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await settle();
    await click(findMenuItem("Reply all"));

    const inputs = [...document.body.querySelectorAll("input")];
    expect((inputs.find((input) => input.autocomplete === "email") as HTMLInputElement).value)
      .toBe("reply@example.test, alex@example.test");
    const ccLabel = [...document.body.querySelectorAll("label")].find(
      (label) => label.textContent?.trim() === "Cc",
    ) as HTMLLabelElement;
    expect((document.getElementById(ccLabel.htmlFor) as HTMLInputElement).value).toBe(
      "casey@example.test",
    );
    await setInput(document.body.querySelector("textarea") as HTMLTextAreaElement, "Replying.");
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(client.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: { kind: "reply_all", sourceMessageId: "message-1" },
          to: "reply@example.test, alex@example.test",
          cc: "casey@example.test",
        }),
      ),
    );
    await vi.waitFor(() => expect(client.sendDraft).toHaveBeenCalled());
  });

  it("forwards as a new plain-text message and states that attachments are omitted", async () => {
    const attachedDetail: MailThreadDetail = {
      ...detail,
      messages: [{ ...detail.messages[0]!, hasAttachments: true }],
    };
    const client = makeClient({ readThread: vi.fn().mockResolvedValue(attachedDetail) });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await act(async () => {
      findButton("More mail actions").dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await settle();
    await click(findMenuItem("Forward"));

    expect(document.body.querySelector('form[aria-label="Forward"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Original attachments aren’t included.");
    const to = document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement;
    const subject = [...document.body.querySelectorAll("input")].find(
      (input) => input.placeholder === "Subject",
    ) as HTMLInputElement;
    const text = document.body.querySelector("textarea") as HTMLTextAreaElement;
    expect(subject.value).toBe("Fwd: Lunch this Friday?");
    expect(text.value).toContain("---------- Forwarded message ----------");
    expect(text.value).toContain("Lunch at 12PM sounds great to me.");
    await setInput(to, "reader@example.test");
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(client.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: { kind: "forward", sourceMessageId: "message-1" },
          subject: "Fwd: Lunch this Friday?",
        }),
      ),
    );
    await vi.waitFor(() => expect(client.sendDraft).toHaveBeenCalled());
  });

  it("switches accounts and reloads that account instead of mixing rows", async () => {
    const listThreads = vi.fn().mockImplementation(({ accountId }) =>
      Promise.resolve({
        ...threadPage,
        items:
          accountId === accountA.accountId
            ? [thread]
            : [
                {
                  ...thread,
                  accountId: accountB.accountId,
                  threadId: "thread-gmail",
                  subject: "Google account mail",
                },
              ],
      }),
    );
    const client = makeClient({
      loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
      listThreads,
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    await enterSingleAccount(accountB);

    expect(document.body.textContent).toContain("Google account mail");
    expect(document.body.textContent).not.toContain("Lunch this Friday?");
    expect(listThreads).toHaveBeenLastCalledWith(
      { accountId: accountB.accountId, limit: 50 },
      expect.any(AbortSignal),
    );
  });

  it("autosaves and closes the open draft when the account switches", async () => {
    const client = makeClient({
      loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Keep this draft",
    );

    await enterSingleAccount(accountB);

    // A durable draft is never discarded on a switch and never asks to.
    // Leaving takes the draft with it and asks nothing — the confirmation
    // belongs to Discard, which deletes, not to a close that keeps.
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(navTrigger()?.getAttribute("aria-label")).toBe(
      `Mailbox: Inbox, ${accountWordFor(accountB, [accountA, accountB])}`,
    );
    await vi.waitFor(() =>
      expect(client.patchDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({ text: "Keep this draft" }),
        }),
      ),
    );
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });

  it("keeps an open draft mounted while the account list refreshes", async () => {
    const refreshedAccounts = deferred<readonly PublicMailAccount[]>();
    const loadAccounts = vi
      .fn()
      .mockResolvedValueOnce([accountA, accountB])
      .mockReturnValueOnce(refreshedAccounts.promise);
    const client = makeClient({ loadAccounts });
    await act(async () =>
      root.render(
        <MailSurface
          client={client}
          onOpenSettings={() => {}}
          refreshToken={0}
        />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Keep this refresh-safe draft",
    );

    await act(async () =>
      root.render(
        <MailSurface
          client={client}
          onOpenSettings={() => {}}
          refreshToken={1}
        />,
      ),
    );
    await settle();
    await enterSingleAccount();
    expect((document.body.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "Keep this refresh-safe draft",
    );

    await act(async () => refreshedAccounts.resolve([accountA, accountB]));
    await settle();
    expect((document.body.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "Keep this refresh-safe draft",
    );
  });

  it("discards every local trace of an open draft when its account is removed", async () => {
    const loadAccounts = vi
      .fn()
      .mockResolvedValueOnce([accountA, accountB])
      .mockResolvedValueOnce([accountB]);
    const client = makeClient({ loadAccounts });
    await act(async () =>
      root.render(
        <MailSurface
          client={client}
          onOpenSettings={() => {}}
          refreshToken={0}
        />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Draft from Personal",
    );

    await act(async () =>
      root.render(
        <MailSurface
          client={client}
          onOpenSettings={() => {}}
          refreshToken={1}
        />,
      ),
    );
    await settle();
    await enterSingleAccount(accountB);

    // Leaving takes the draft with it and asks nothing — the confirmation
    // belongs to Discard, which deletes, not to a close that keeps.
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.body.querySelector("textarea")).toBeNull();
    // One account left, so the merge closes and the column is that account's
    // Inbox: no word on the trigger, and no Accounts block in the menu — the
    // removed account's only remaining trace would have been a row there.
    expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
    await openNav();
    expect(navDestinations()).not.toContain(accountA.emailAddress);
    expect(navDestinations()).not.toContain("All inboxes");
    expect(navLabels()).not.toContain("Accounts");
    await closeNav();
    expect(client.createDraft).not.toHaveBeenCalled();
    expect(client.patchDraft).not.toHaveBeenCalled();
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith("brain:mail:draft-recovery:v1:")) continue;
      const raw = window.localStorage.getItem(key);
      expect(raw).not.toContain(accountA.accountId);
      expect(raw).not.toContain("Draft from Personal");
    }
  });

  it("does not let an old explicit sync replace a newly selected folder", async () => {
    const pendingSync = deferred<void>();
    const sentThread = {
      ...thread,
      threadId: "thread-sent",
      subject: "Sent after switch",
      unread: false,
    };
    const listThreads = vi.fn().mockResolvedValue(threadPage);
    const client = makeClient({
      listThreads,
      sync: vi.fn().mockReturnValue(pendingSync.promise),
      listMailboxThreads: vi.fn().mockImplementation(({ mailboxId }) =>
        Promise.resolve(mailboxThreadPage(mailboxId, [sentThread])),
      ),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    await click(findButton("Sync mail"));
    await goTo("Sent");
    expect(document.body.textContent).toContain("Sent after switch");

    await act(async () => pendingSync.resolve());
    await settle();
    expect(document.body.textContent).toContain("Sent after switch");
    expect(document.body.querySelector('[aria-label="Loading mail folder"]')).toBeNull();
    // The mount's one load; none for the sent folder.
    expect(listThreads).toHaveBeenCalledTimes(1);
  });

  it("ignores pagination from an older list snapshot after sync refreshes it", async () => {
    const pendingMore = deferred<MailThreadPage>();
    const initialPage: MailThreadPage = { ...threadPage, nextCursor: "cursor-1" };
    const refreshedThread = {
      ...thread,
      threadId: "thread-refreshed",
      subject: "Fresh after sync",
    };
    const staleThread = {
      ...thread,
      threadId: "thread-stale-page",
      subject: "Stale pagination result",
    };
    const listThreads = vi.fn().mockImplementation((input) => {
      if (input.cursor === "cursor-1") return pendingMore.promise;
      // Call 1 is the unified mount, call 2 the single-account load — both
      // see the initial page; the post-sync refetch sees the refreshed one.
      return Promise.resolve(
        listThreads.mock.calls.length <= 2
          ? initialPage
          : { ...threadPage, items: [refreshedThread] },
      );
    });
    const client = makeClient({ listThreads });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    await click(findButton("Load more"));
    await click(findButton("Sync mail"));
    expect(document.body.textContent).toContain("Fresh after sync");

    await act(async () =>
      pendingMore.resolve({ ...threadPage, items: [staleThread] }),
    );
    await settle();
    expect(document.body.textContent).toContain("Fresh after sync");
    expect(document.body.textContent).not.toContain("Stale pagination result");
  });

  it("replies to the recipient of a sent message instead of the sender account", async () => {
    const sentThread = {
      ...thread,
      threadId: "thread-sent-reply",
      subject: "Sent project update",
      participants: [{ name: "Ben Johnson", address: "ben@example.test" }],
      unread: false,
    };
    const sentDetail: MailThreadDetail = {
      ...detail,
      thread: sentThread,
      messages: [
        {
          ...detail.messages[0]!,
          messageId: "message-sent",
          threadId: sentThread.threadId,
          from: { name: "Personal alias", address: "alias@example.test" },
          to: [{ name: "Ben Johnson", address: "ben@example.test" }],
          unread: false,
          inInbox: false,
        },
      ],
    };
    const client = makeClient({
      listMailboxThreads: vi
        .fn()
        .mockResolvedValue(mailboxThreadPage("sent", [sentThread])),
      readMailboxThread: vi.fn().mockResolvedValue(sentDetail),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await goTo("Sent");
    await click(findButton("Sent project update"));
    await click(findButton("Reply"));

    expect(
      (document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement)
        .value,
    ).toBe("ben@example.test");
  });

  it("skips a Gmail tagged self recipient and replies to the Cc correspondent", async () => {
    const gmailAccount = { ...accountB, emailAddress: "me@gmail.com" };
    const sentThread = {
      ...thread,
      accountId: gmailAccount.accountId,
      threadId: "thread-gmail-tagged-self",
      subject: "Tagged self recipient",
      participants: [{ name: "Alex", address: "alex@example.test" }],
      unread: false,
    };
    const sentDetail: MailThreadDetail = {
      ...detail,
      thread: sentThread,
      messages: [
        {
          ...detail.messages[0]!,
          accountId: gmailAccount.accountId,
          messageId: "message-gmail-tagged-self",
          threadId: sentThread.threadId,
          from: { name: "Me", address: "me@gmail.com" },
          to: [{ name: "Me tagged", address: "m.e+tag@googlemail.com" }],
          cc: [{ name: "Alex", address: "alex@example.test" }],
          unread: false,
          inInbox: false,
        },
      ],
    };
    const client = makeClient({
      loadAccounts: vi.fn().mockResolvedValue([gmailAccount]),
      listMailboxThreads: vi
        .fn()
        .mockResolvedValue(mailboxThreadPage("sent", [sentThread])),
      readMailboxThread: vi.fn().mockResolvedValue(sentDetail),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount(gmailAccount);
    await goTo("Sent");
    await click(findButton("Tagged self recipient"));
    await click(findButton("Reply"));

    expect(
      (document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement)
        .value,
    ).toBe("alex@example.test");
  });

  it("fails closed when a sent Gmail message has no correspondent", async () => {
    const gmailAccount = { ...accountB, emailAddress: "me@gmail.com" };
    const sentThread = {
      ...thread,
      accountId: gmailAccount.accountId,
      threadId: "thread-gmail-self-only",
      subject: "Self only",
      participants: [],
      unread: false,
    };
    const sentDetail: MailThreadDetail = {
      ...detail,
      thread: sentThread,
      messages: [
        {
          ...detail.messages[0]!,
          accountId: gmailAccount.accountId,
          messageId: "message-gmail-self-only",
          threadId: sentThread.threadId,
          from: { name: "Me", address: "me@gmail.com" },
          to: [{ name: "Me tagged", address: "m.e+tag@googlemail.com" }],
          cc: [],
          unread: false,
          inInbox: false,
        },
      ],
    };
    const client = makeClient({
      loadAccounts: vi.fn().mockResolvedValue([gmailAccount]),
      listMailboxThreads: vi
        .fn()
        .mockResolvedValue(mailboxThreadPage("sent", [sentThread])),
      readMailboxThread: vi.fn().mockResolvedValue(sentDetail),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount(gmailAccount);
    await goTo("Sent");
    await click(findButton("Self only"));
    await click(findButton("Reply"));

    expect(
      (document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("switches system folders and reads a thread through that mailbox snapshot", async () => {
    const sentThread = {
      ...thread,
      threadId: "thread-sent",
      subject: "Sent project update",
      unread: false,
    };
    const sentDetail = {
      ...detail,
      thread: sentThread,
      messages: detail.messages.map((message) => ({
        ...message,
        threadId: sentThread.threadId,
      })),
    };
    const listMailboxThreads = vi.fn().mockImplementation(({ mailboxId }) =>
      Promise.resolve(
        mailboxThreadPage(mailboxId, mailboxId === "sent" ? [sentThread] : []),
      ),
    );
    const readMailboxThread = vi.fn().mockResolvedValue(sentDetail);
    const client = makeClient({ listMailboxThreads, readMailboxThread });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    await goTo("Sent");

    expect(document.body.textContent).toContain("Sent project update");
    expect(listMailboxThreads).toHaveBeenCalledWith(
      { accountId: accountA.accountId, mailboxId: "sent", limit: 50 },
      expect.any(AbortSignal),
    );
    await click(findButton("Sent project update"));
    expect(readMailboxThread).toHaveBeenCalledWith({
      accountId: accountA.accountId,
      mailboxId: "sent",
      threadId: sentThread.threadId,
    });
  });

  it("shows a quiet preparing state while a hidden folder hydrates", async () => {
    const client = makeClient({
      listMailboxThreads: vi.fn().mockImplementation(({ mailboxId }) =>
        Promise.resolve({
          ...mailboxThreadPage(mailboxId, []),
          availability: {
            status: "unavailable" as const,
            reason: "mailbox_uninitialized" as const,
            lastSuccessfulAt: null,
            windowTruncated: null,
          },
        }),
      ),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    await goTo("Spam");

    expect(document.body.textContent).toContain("Spam is preparing");
    expect(document.body.textContent).toContain(
      "Brain is fetching this folder in the background.",
    );
  });

  it("runs mailbox-aware restore and star actions only after server confirmation", async () => {
    let starred = false;
    const updateThread = vi.fn().mockImplementation(async (input) => {
      if ("starred" in input) starred = input.starred;
    });
    const onToast = vi.fn();
    const client = makeClient({
      updateThread,
      listThreads: vi.fn().mockImplementation(() =>
        Promise.resolve({
          ...threadPage,
          items: [{ ...thread, starred }],
        }),
      ),
      readThread: vi.fn().mockImplementation(() =>
        Promise.resolve({
          ...detail,
          thread: { ...thread, starred },
        }),
      ),
    });
    await act(async () =>
      root.render(
        <MailSurface
          client={client}
          onOpenSettings={() => {}}
          onToast={onToast}
        />,
      ),
    );
    await settle();
    await enterSingleAccount();

    await click(findButton("Lunch this Friday?"));
    await act(async () => {
      findButton("More mail actions").dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await settle();
    await click(findMenuItem("Star"));
    expect(updateThread).toHaveBeenLastCalledWith({
      accountId: accountA.accountId,
      threadId: thread.threadId,
      starred: true,
    });
    expect(onToast).toHaveBeenCalledWith("Conversation starred");

    await click(findButton("Back to Inbox"));
    await goTo("Trash");
    await click(findButton("Lunch this Friday?"));
    await click(findButton("Restore"));

    expect(updateThread).toHaveBeenLastCalledWith({
      accountId: accountA.accountId,
      threadId: thread.threadId,
      restore: true,
    });
    expect(document.body.textContent).toContain("Lunch this Friday?");
    expect(onToast).toHaveBeenCalledWith("Conversation restored");
  });

  it("uses the confirmed thread label for Star and blocks duplicate actions", async () => {
    const starredThread = { ...thread, starred: true };
    const pendingMutation = deferred<void>();
    let starred = true;
    const updateThread = vi.fn().mockImplementation(async (input) => {
      if ("starred" in input) {
        await pendingMutation.promise;
        starred = input.starred;
      }
    });
    const client = makeClient({
      listThreads: vi.fn().mockImplementation(() =>
        Promise.resolve({
          ...threadPage,
          items: [{ ...starredThread, starred }],
        }),
      ),
      readThread: vi.fn().mockImplementation(() =>
        Promise.resolve({
          ...detail,
          thread: { ...starredThread, starred },
        }),
      ),
      updateThread,
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await act(async () => {
      findButton("More mail actions").dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await settle();
    const removeStar = findMenuItem("Remove star");
    await act(async () => {
      removeStar.click();
      removeStar.click();
    });
    expect(updateThread).toHaveBeenCalledTimes(1);
    expect(updateThread).toHaveBeenCalledWith({
      accountId: accountA.accountId,
      threadId: thread.threadId,
      starred: false,
    });

    await act(async () => pendingMutation.resolve());
    await settle();
    expect(updateThread).toHaveBeenCalledTimes(1);
  });

  it("ignores a completed mutation after another thread becomes current", async () => {
    const pendingMutation = deferred<void>();
    const secondThread = {
      ...thread,
      threadId: "thread-2",
      subject: "Second conversation",
    };
    const secondDetail: MailThreadDetail = {
      ...detail,
      thread: secondThread,
      messages: detail.messages.map((message) => ({
        ...message,
        messageId: "message-2",
        threadId: secondThread.threadId,
      })),
    };
    const listThreads = vi.fn().mockResolvedValue({
      ...threadPage,
      items: [thread, secondThread],
    });
    const client = makeClient({
      listThreads,
      readThread: vi.fn().mockImplementation(({ threadId }) =>
        Promise.resolve(threadId === secondThread.threadId ? secondDetail : detail),
      ),
      updateThread: vi.fn().mockReturnValue(pendingMutation.promise),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await act(async () => findButton("Archive").click());
    await click(findButton("Second conversation"));

    await act(async () => pendingMutation.resolve());
    await settle();
    expect(
      document.body.querySelector('section[aria-label="Message reader"] h1')
        ?.textContent,
    ).toBe("Second conversation");
    // The mount's one load; the stale mutation adds none.
    expect(listThreads).toHaveBeenCalledTimes(1);
  });

  it("syncs the selected account and refreshes its list", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Sync mail"));

    expect(client.sync).toHaveBeenCalledWith({ accountId: accountA.accountId });
    expect(client.listThreads).toHaveBeenCalledTimes(2);
  });

  it("refreshes silently while visible and pauses network work while hidden", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    // The mount's one load — a lone account opens its own Inbox.
    expect(client.listThreads).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await settle();
    expect(client.listThreads).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(client.listThreads).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(client.listThreads).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("Lunch this Friday?");
  });

  it("archives only after the server confirms the mutation", async () => {
    let archived = false;
    const client = makeClient({
      updateThread: vi.fn().mockImplementation(async () => {
        archived = true;
      }),
      listThreads: vi.fn().mockImplementation(() =>
        Promise.resolve({
          ...threadPage,
          items: archived ? [] : [thread],
        }),
      ),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await click(findButton("Archive"));

    expect(client.updateThread).toHaveBeenCalledWith({
      accountId: accountA.accountId,
      threadId: thread.threadId,
      archive: true,
    });
    expect(document.body.textContent).not.toContain("Lunch this Friday?");
  });

  it("blocks a duplicate retry when delivery status is unknown", async () => {
    const client = makeClient({
      sendDraft: vi.fn().mockImplementation((input) =>
        Promise.resolve({
          replayed: false,
          appliedRevision: input.expectedRevision + 1,
          operationId: input.sendOperationId,
          created: true,
          status: "delivery_unknown",
        }),
      ),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    const to = document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement;
    await setInput(to, "friend@example.test");
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Delivery status is unknown"),
    );
    expect(findButton("Send").disabled).toBe(true);
  });

  it.each([
    "queued",
    "sending",
    "failed",
    "delivery_unknown",
    "sent",
  ] as const)(
    "does not let a late %s send result mutate a replacement composer",
    async (status) => {
      const pendingSend = deferred<MailDraftSendResult>();
      const onToast = vi.fn();
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        sendDraft: vi.fn().mockReturnValue(pendingSend.promise),
      });
      await act(async () =>
        root.render(
          <MailSurface
            client={client}
            onOpenSettings={() => {}}
            onToast={onToast}
          />,
        ),
      );
      await settle();
      await enterSingleAccount();
      await click(findButton("New message"));
      await setInput(
        document.body.querySelector(
          'input[autocomplete="email"]',
        ) as HTMLInputElement,
        "first@example.test",
      );
      await click(findButton("Send"));
      await click(
        document.body.querySelector(
          'button[aria-label="Close draft"]',
        ) as HTMLButtonElement,
      );
      await click(findButton("New message"));
      await setInput(
        document.body.querySelector("textarea") as HTMLTextAreaElement,
        "Replacement account A draft",
      );

      await act(async () =>
        pendingSend.resolve({
          replayed: false,
          appliedRevision: 2,
          operationId: "send-11111111-1111-4111-8111-111111111111",
          created: true,
          status,
        }),
      );
      await settle();

      expect((document.body.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
        "Replacement account A draft",
      );
      // From is meta on the fields now, label and value in their own spans.
      expect(
        document.body.querySelector(".brain-composer-from")?.textContent,
      ).toBe("FromPersonal");
      expect(onToast).not.toHaveBeenCalled();
    },
  );

  it("hands the draft to the durable outbox when the send is queued", async () => {
    const onToast = vi.fn();
    const client = makeClient({
      sendDraft: vi.fn().mockImplementation((input) =>
        Promise.resolve({
          replayed: false,
          appliedRevision: input.expectedRevision + 1,
          operationId: input.sendOperationId,
          created: false,
          status: "sending",
        }),
      ),
    });
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Keep this body",
    );
    await click(findButton("Send"));

    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith("Message queued"));
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });

  it("reports a queued send that ends failed and raises the Drafts badge", async () => {
    vi.useFakeTimers();
    const onToast = vi.fn();
    let polls = 0;
    const getSendOperation = vi.fn().mockImplementation((operationId: string) => {
      polls += 1;
      return Promise.resolve({
        apiVersion: 1,
        operationId,
        status: polls === 1 ? "sending" : "failed",
      });
    });
    const listDrafts = vi.fn().mockResolvedValue([
      {
        draftId: "draft-88888888-8888-4888-8888-888888888888",
        accountId: accountA.accountId,
        revision: 6,
        state: "failed" as const,
        intent: { kind: "compose" as const },
        subject: "Never arrived",
        updatedAt: 1_700_000_000_000,
      },
    ]);
    const client = makeClient({
      sendDraft: vi.fn().mockImplementation((input) =>
        Promise.resolve({
          replayed: false,
          appliedRevision: input.expectedRevision + 1,
          operationId: input.sendOperationId,
          created: true,
          status: "queued",
        }),
      ),
      getSendOperation,
      listDrafts,
    });
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await click(findButton("Send"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onToast).toHaveBeenCalledWith("Message queued");

    // First poll after 5s still reports an in-flight submission.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();
    expect(getSendOperation).toHaveBeenCalledTimes(1);
    expect(onToast).not.toHaveBeenCalledWith("Message didn’t send. It’s in Drafts.");

    // The next poll learns the terminal failure and tells the writer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await settle();
    expect(onToast).toHaveBeenCalledWith("Message didn’t send. It’s in Drafts.");

    const drafts = findButton("Drafts, 1 didn’t send");
    expect(drafts.textContent).toContain("1");
  });

  it("stops watching a queued send once the operation reports sent", async () => {
    vi.useFakeTimers();
    const onToast = vi.fn();
    let polls = 0;
    const getSendOperation = vi.fn().mockImplementation((operationId: string) => {
      polls += 1;
      return Promise.resolve({
        apiVersion: 1,
        operationId,
        status: polls === 1 ? "queued" : "sent",
      });
    });
    const client = makeClient({
      sendDraft: vi.fn().mockImplementation((input) =>
        Promise.resolve({
          replayed: false,
          appliedRevision: input.expectedRevision + 1,
          operationId: input.sendOperationId,
          created: true,
          status: "queued",
        }),
      ),
      getSendOperation,
    });
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await click(findButton("Send"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onToast).toHaveBeenCalledWith("Message queued");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await settle();
    expect(onToast).toHaveBeenCalledWith("Message sent");

    // Terminal means done — later ticks must not keep reading the operation.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    await settle();
    expect(getSendOperation).toHaveBeenCalledTimes(2);
  });

  it("never sends stale server content when the final draft save fails", async () => {
    const client = makeClient({
      patchDraft: vi.fn().mockRejectedValue(new Error("save unavailable")),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "This exact text must be durable before send",
    );
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Couldn’t save this draft"),
    );
    expect(client.sendDraft).not.toHaveBeenCalled();
    expect(findButton("Send").disabled).toBe(false);
  });

  it("blocks a second send when the transport loses the first response", async () => {
    const client = makeClient({
      sendDraft: vi.fn().mockRejectedValue(new Error("response lost")),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Couldn’t confirm delivery"),
    );
    expect(client.sendDraft).toHaveBeenCalledTimes(1);
    expect(findButton("Send").disabled).toBe(true);
  });

  it("keeps a failed draft and retries with a fresh send operation", async () => {
    const sendDraft = vi
      .fn()
      .mockImplementationOnce((input) =>
        Promise.resolve({
          replayed: false,
          appliedRevision: input.expectedRevision + 1,
          operationId: input.sendOperationId,
          created: true,
          status: "failed",
        }),
      )
      .mockImplementationOnce((input) =>
        Promise.resolve({
          replayed: false,
          appliedRevision: input.expectedRevision + 1,
          operationId: input.sendOperationId,
          created: true,
          status: "sent",
        }),
      );
    const getDraft = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        draftId: input.draftId,
        accountId: input.accountId,
        revision: 5,
        state: "failed",
        intent: { kind: "compose" },
        to: "friend@example.test",
        cc: "",
        bcc: "",
        subject: "Still here",
        text: "Keep this body",
        updatedAt: 1_700_000_000_000,
      }),
    );
    const client = makeClient({ sendDraft, getDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await setInput(
      document.body.querySelector('input[placeholder="Subject"]') as HTMLInputElement,
      "Still here",
    );
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Keep this body",
    );
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Message wasn’t sent"),
    );
    expect(
      (document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement).value,
    ).toBe("friend@example.test");
    expect((document.body.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "Keep this body",
    );

    await click(findButton("Send"));
    await vi.waitFor(() => expect(sendDraft).toHaveBeenCalledTimes(2));
    const first = sendDraft.mock.calls[0][0];
    const second = sendDraft.mock.calls[1][0];
    expect(second.sendOperationId).not.toBe(first.sendOperationId);
    // The retry re-reads the draft revision the failed attempt advanced to.
    expect(second.expectedRevision).toBe(5);
    await vi.waitFor(() =>
      expect(document.body.querySelector("textarea")).toBeNull(),
    );
  });

  it("creates a durable draft on compose and autosaves edits after a pause", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await settle();
    // A blank compose creates no draft until the writer types.
    expect(client.createDraft).not.toHaveBeenCalled();

    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Draft in progress",
    );
    expect(client.createDraft).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    expect(client.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: accountA.accountId,
        draftId: expect.stringMatching(/^draft-/),
        intent: { kind: "compose" },
      }),
    );
    expect(client.patchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: expect.stringMatching(/^draft-/),
        expectedRevision: 0,
        mutationId: expect.stringMatching(/^draft-mutation-/),
        patch: expect.objectContaining({ text: "Draft in progress" }),
      }),
    );
    expect(document.body.textContent).toContain("Saved");
  });

  it("retries a failed autosave without losing the edit or changing its mutation", async () => {
    vi.useFakeTimers();
    const patchDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary save failure"))
      .mockImplementation((input) =>
        Promise.resolve({
          replayed: false,
          appliedRevision: input.expectedRevision + 1,
        }),
      );
    const client = makeClient({ patchDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Keep this exact edit",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();

    expect(document.body.textContent).toContain("Not saved");
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Keep this exact edit");
    const firstMutationId = patchDraft.mock.calls[0]?.[0]?.mutationId;

    await click(findButton("Retry"));

    await vi.waitFor(() => expect(patchDraft).toHaveBeenCalledTimes(2));
    expect(patchDraft.mock.calls[1]?.[0]).toMatchObject({
      mutationId: firstMutationId,
      patch: expect.objectContaining({ text: "Keep this exact edit" }),
    });
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Keep this exact edit");
    expect(document.body.textContent).toContain("Saved");
  });

  it("replays a response-lost mutation before saving a newer edit", async () => {
    vi.useFakeTimers();
    let rejectFirstPatch!: (reason: Error) => void;
    const firstPatch = new Promise<never>((_resolve, reject) => {
      rejectFirstPatch = reject;
    });
    let firstMutationId: string | undefined;
    const patchDraft = vi.fn().mockImplementation((input) => {
      if (patchDraft.mock.calls.length === 1) {
        firstMutationId = input.mutationId;
        return firstPatch;
      }
      if (patchDraft.mock.calls.length === 2) {
        if (
          input.mutationId !== firstMutationId ||
          input.expectedRevision !== 0 ||
          input.patch.text !== "First applied edit"
        ) {
          return Promise.reject(
            new MailApiError(409, "mail_draft_revision_conflict"),
          );
        }
        return Promise.resolve({ replayed: true, appliedRevision: 1 });
      }
      return Promise.resolve({ replayed: false, appliedRevision: 2 });
    });
    const client = makeClient({ patchDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "First applied edit",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    expect(patchDraft).toHaveBeenCalledTimes(1);

    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Newer unsaved edit",
    );
    await act(async () => rejectFirstPatch(new Error("response lost")));
    await settle();
    expect(document.body.textContent).toContain("Not saved");

    await click(findButton("Retry"));
    await settle();

    expect(patchDraft).toHaveBeenCalledTimes(3);
    expect(patchDraft.mock.calls[1]?.[0]).toMatchObject({
      mutationId: firstMutationId,
      expectedRevision: 0,
      patch: expect.objectContaining({ text: "First applied edit" }),
    });
    expect(patchDraft.mock.calls[2]?.[0]).toMatchObject({
      expectedRevision: 1,
      patch: expect.objectContaining({ text: "Newer unsaved edit" }),
    });
    expect(patchDraft.mock.calls[2]?.[0]?.mutationId).not.toBe(firstMutationId);
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Newer unsaved edit");
    expect(document.body.textContent).toContain("Saved");
  });

  it("reconciles a response-lost autosave before discarding its draft", async () => {
    vi.useFakeTimers();
    let rejectFirstPatch!: (reason: Error) => void;
    const firstPatch = new Promise<never>((_resolve, reject) => {
      rejectFirstPatch = reject;
    });
    const patchDraft = vi
      .fn()
      .mockReturnValueOnce(firstPatch)
      .mockResolvedValueOnce({ replayed: true, appliedRevision: 1 });
    const pendingDelete = deferred<{ replayed: boolean }>();
    const deleteDraft = vi.fn().mockReturnValue(pendingDelete.promise);
    const client = makeClient({ patchDraft, deleteDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Applied before response loss",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    const firstMutationId = patchDraft.mock.calls[0]?.[0]?.mutationId;

    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Newer edit to discard",
    );
    await act(async () => rejectFirstPatch(new Error("response lost")));
    await settle();
    expect(document.body.textContent).toContain("Not saved");

    await click(findButton("Discard draft"));
    await confirmSystemDialog("Discard");
    await vi.waitFor(() => expect(deleteDraft).toHaveBeenCalledTimes(1));

    expect(patchDraft).toHaveBeenCalledTimes(2);
    expect(patchDraft.mock.calls[1]?.[0]).toMatchObject({
      mutationId: firstMutationId,
      expectedRevision: 0,
      patch: expect.objectContaining({ text: "Applied before response loss" }),
    });
    expect(
      patchDraft.mock.calls.some(
        ([input]) => input.patch.text === "Newer edit to discard",
      ),
    ).toBe(false);
    expect(deleteDraft).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(document.body.querySelector("textarea")).toBeNull();

    const recoveryKey = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    ).find((key) => key?.startsWith("brain:mail:draft-recovery:v1:"));
    expect(recoveryKey).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(recoveryKey!) ?? "{}").fields.text).toBe(
      "Newer edit to discard",
    );

    await act(async () => pendingDelete.resolve({ replayed: false }));
    await settle();
    expect(window.localStorage.getItem(recoveryKey!)).toBeNull();
  });

  it("never persists a blank compose that is closed", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await settle();
    await click(
      document.body.querySelector(
        'button[aria-label="Close draft"]',
      ) as HTMLButtonElement,
    );
    await settle();

    expect(client.createDraft).not.toHaveBeenCalled();
    expect(client.deleteDraft).not.toHaveBeenCalled();
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("keeps a started draft when the composer closes", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Unfinished thought",
    );
    await click(
      document.body.querySelector(
        'button[aria-label="Close draft"]',
      ) as HTMLButtonElement,
    );

    await vi.waitFor(() =>
      expect(client.patchDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({ text: "Unfinished thought" }),
        }),
      ),
    );
    expect(client.deleteDraft).not.toHaveBeenCalled();
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("flushes the last debounced edit when the Mail surface unmounts", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Persist before leaving Mail",
    );

    await act(async () => root.render(<div>Home</div>));

    await vi.waitFor(() =>
      expect(client.patchDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({ text: "Persist before leaving Mail" }),
        }),
      ),
    );
  });

  it("uses a keepalive write for the last edit when the page starts unloading", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Saved baseline",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    expect(client.createDraft).toHaveBeenCalled();
    vi.mocked(client.patchDraft).mockClear();

    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Final edit before tab close",
    );
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await settle();

    expect(client.patchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ text: "Final edit before tab close" }),
      }),
      undefined,
      { keepalive: true },
    );
  });

  it("recovers a large final edit after an autosave conflict and page close", async () => {
    vi.useFakeTimers();
    const firstPatch = deferred<{
      replayed: boolean;
      appliedRevision: number;
    }>();
    const largeFinalBody = `Newest recovery ${"x".repeat(70_000)}`;
    const patchDraft = vi.fn().mockImplementation((input) => {
      if (input.patch.text === "Older in-flight edit") return firstPatch.promise;
      return Promise.reject(new Error("revision conflict"));
    });
    const client = makeClient({ patchDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Older in-flight edit",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    expect(patchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        patch: expect.objectContaining({ text: "Older in-flight edit" }),
      }),
    );
    const firstMutationId = patchDraft.mock.calls[0]?.[0]?.mutationId;

    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      largeFinalBody,
    );
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await settle();
    expect(patchDraft.mock.calls[1]).toEqual([
      expect.objectContaining({
        mutationId: firstMutationId,
        expectedRevision: 0,
        patch: expect.objectContaining({ text: "Older in-flight edit" }),
      }),
      undefined,
      { keepalive: true },
    ]);

    firstPatch.resolve({ replayed: false, appliedRevision: 1 });
    await settle();

    const recoveryHost = document.createElement("div");
    document.body.appendChild(recoveryHost);
    const recoveryRoot = createRoot(recoveryHost);
    const recoveryClient = makeClient();
    await act(async () =>
      recoveryRoot.render(
        <MailSurface client={recoveryClient} onOpenSettings={() => {}} />,
      ),
    );
    await settle();

    await vi.waitFor(() => {
      const textarea = recoveryHost.querySelector("textarea");
      expect(textarea?.value).toBe(largeFinalBody);
    });
    expect(recoveryHost.textContent).toContain("Recovered after Brain closed");

    await act(async () => recoveryRoot.unmount());
    recoveryHost.remove();
  });

  it("keeps the original recovery when copying it to a new draft exceeds storage quota", async () => {
    const oldDraftId = "draft-11111111-1111-4111-8111-111111111111";
    const oldRecoveryKey = `brain:mail:draft-recovery:v1:${oldDraftId}`;
    const recoveredText = `Only durable copy ${"x".repeat(70_000)}`;
    window.localStorage.setItem(
      oldRecoveryKey,
      JSON.stringify({
        version: 1,
        draftId: oldDraftId,
        accountId: accountA.accountId,
        intent: { kind: "compose" },
        fields: {
          to: "",
          cc: "",
          bcc: "",
          subject: "Quota recovery",
          text: recoveredText,
        },
        updatedAt: Date.now(),
      }),
    );
    const originalSetItem = window.localStorage.setItem.bind(
      window.localStorage,
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      if (
        String(key).startsWith("brain:mail:draft-recovery:v1:") &&
        key !== oldRecoveryKey
      ) {
        throw new Error("quota exceeded");
      }
      originalSetItem(String(key), String(value));
    });
    const client = makeClient({
      createDraft: vi.fn().mockRejectedValue(new Error("offline")),
    });

    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();

    // Recovery fires on the unified default mount itself.
    await vi.waitFor(() => {
      const textarea = document.body.querySelector("textarea");
      expect(textarea?.value).toBe(recoveredText);
    });
    expect(window.localStorage.getItem(oldRecoveryKey)).not.toBeNull();
  });

  it("clears recovery content only for mail accounts that were removed", async () => {
    const activeDraftId = "draft-22222222-2222-4222-8222-222222222222";
    const removedDraftId = "draft-33333333-3333-4333-8333-333333333333";
    const activeKey = `brain:mail:draft-recovery:v1:${activeDraftId}`;
    const removedKey = `brain:mail:draft-recovery:v1:${removedDraftId}`;
    const recovery = (
      draftId: string,
      accountId: string,
      text: string,
    ) =>
      JSON.stringify({
        version: 1,
        draftId,
        accountId,
        intent: { kind: "compose" },
        fields: { to: "", cc: "", bcc: "", subject: "", text },
        updatedAt: Date.now(),
      });
    window.localStorage.setItem(
      activeKey,
      recovery(activeDraftId, accountA.accountId, ""),
    );
    window.localStorage.setItem(
      removedKey,
      recovery(removedDraftId, accountB.accountId, "Sensitive removed draft"),
    );

    const client = makeClient({
      loadAccounts: vi.fn().mockResolvedValue([accountA]),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();

    expect(window.localStorage.getItem(activeKey)).not.toBeNull();
    expect(window.localStorage.getItem(removedKey)).toBeNull();
  });

  it("discards a saved draft when the writer taps discard", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Never mind",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    expect(client.createDraft).toHaveBeenCalled();

    await click(findButton("Discard draft"));
    await confirmSystemDialog("Discard");
    await settle();
    await settle();

    expect(client.deleteDraft).toHaveBeenCalled();
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("discards a local-only draft before its first autosave", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Local only draft",
    );
    expect(client.createDraft).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(1);

    await click(findButton("Discard draft"));
    await confirmSystemDialog("Discard");
    await settle();

    expect(client.createDraft).not.toHaveBeenCalled();
    expect(client.deleteDraft).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("replays a response-lost create before discarding its server draft", async () => {
    vi.useFakeTimers();
    let rejectFirstCreate!: (reason: Error) => void;
    const firstCreate = new Promise<never>((_resolve, reject) => {
      rejectFirstCreate = reject;
    });
    const createDraft = vi
      .fn()
      .mockReturnValueOnce(firstCreate)
      .mockImplementation((input) =>
        Promise.resolve({
          ...input,
          revision: 0,
          state: "editing" as const,
          updatedAt: 1_700_000_000_000,
        }),
      );
    const client = makeClient({ createDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Create response was lost",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    const firstCreateInput = createDraft.mock.calls[0]?.[0];
    await act(async () => rejectFirstCreate(new Error("response lost")));
    await settle();

    await click(findButton("Discard draft"));
    await confirmSystemDialog("Discard");
    await vi.waitFor(() => expect(client.deleteDraft).toHaveBeenCalledTimes(1));

    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(createDraft.mock.calls[1]?.[0]).toEqual(firstCreateInput);
    expect(client.patchDraft).not.toHaveBeenCalled();
    expect(client.deleteDraft).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 0 }),
    );
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps recovery when a response-lost create cannot be reconciled", async () => {
    vi.useFakeTimers();
    let rejectFirstCreate!: (reason: Error) => void;
    const firstCreate = new Promise<never>((_resolve, reject) => {
      rejectFirstCreate = reject;
    });
    const createDraft = vi
      .fn()
      .mockReturnValueOnce(firstCreate)
      .mockRejectedValueOnce(new Error("replay unavailable"));
    const client = makeClient({ createDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Only recovery copy",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    await act(async () => rejectFirstCreate(new Error("response lost")));
    await settle();

    await click(findButton("Discard draft"));
    await confirmSystemDialog("Discard");
    await vi.waitFor(() => expect(createDraft).toHaveBeenCalledTimes(2));

    expect(client.deleteDraft).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(1);
    const recovery = JSON.parse(window.localStorage.getItem(window.localStorage.key(0)!) ?? "{}");
    expect(recovery.fields.text).toBe("Only recovery copy");
  });

  it("opens the Drafts list and resumes a saved draft", async () => {
    const savedDraftId = "draft-11111111-1111-4111-8111-111111111111";
    const listDrafts = vi.fn().mockResolvedValue([
      {
        draftId: savedDraftId,
        accountId: accountA.accountId,
        revision: 4,
        state: "editing",
        intent: { kind: "compose" },
        subject: "Saved subject",
        updatedAt: 1_700_000_000_000,
      },
    ]);
    const getDraft = vi.fn().mockResolvedValue({
      draftId: savedDraftId,
      accountId: accountA.accountId,
      revision: 4,
      state: "editing",
      intent: { kind: "compose" },
      to: "saved@example.test",
      cc: "",
      bcc: "",
      subject: "Saved subject",
      text: "Saved body",
      updatedAt: 1_700_000_000_000,
    });
    const client = makeClient({ listDrafts, getDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await goTo("Drafts");

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Saved subject"),
    );
    expect(listDrafts.mock.calls[0]?.[0]).toBe(accountA.accountId);
    await click(findButton("Saved subject"));

    await vi.waitFor(() =>
      expect(getDraft).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        draftId: savedDraftId,
      }),
    );
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Saved body");
    expect(
      (document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement)
        .value,
    ).toBe("saved@example.test");
  });

  it("does not let a slow draft resume replace a newer draft", async () => {
    const slowDraftId = "draft-33333333-3333-4333-8333-333333333333";
    const newerDraftId = "draft-44444444-4444-4444-8444-444444444444";
    const pendingDraft = deferred<
      Awaited<ReturnType<MailSurfaceClient["getDraft"]>>
    >();
    const listDrafts = vi.fn().mockResolvedValue([
      {
        draftId: slowDraftId,
        accountId: accountA.accountId,
        revision: 4,
        state: "editing",
        intent: { kind: "compose" as const },
        subject: "Slow saved subject",
        updatedAt: 1_700_000_000_000,
      },
      {
        draftId: newerDraftId,
        accountId: accountA.accountId,
        revision: 5,
        state: "editing",
        intent: { kind: "compose" as const },
        subject: "Newer saved subject",
        updatedAt: 1_700_000_000_001,
      },
    ]);
    const client = makeClient({
      listDrafts,
      getDraft: vi.fn().mockImplementation(({ draftId }) =>
        draftId === slowDraftId
          ? pendingDraft.promise
          : Promise.resolve({
              draftId: newerDraftId,
              accountId: accountA.accountId,
              revision: 5,
              state: "editing" as const,
              intent: { kind: "compose" as const },
              to: "new@example.test",
              cc: "",
              bcc: "",
              subject: "Newer saved subject",
              text: "Newer resumed body",
              updatedAt: 1_700_000_000_001,
            }),
      ),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await goTo("Drafts");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Slow saved subject"),
    );

    await act(async () => findButton("Slow saved subject").click());
    await settle();
    await click(findButton("Newer saved subject"));
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Newer resumed body");

    pendingDraft.resolve({
      draftId: slowDraftId,
      accountId: accountA.accountId,
      revision: 4,
      state: "editing",
      intent: { kind: "compose" },
      to: "old@example.test",
      cc: "",
      bcc: "",
      subject: "Slow saved subject",
      text: "Stale resumed body",
      updatedAt: 1_700_000_000_000,
    });
    await settle();

    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Newer resumed body");
    expect(document.body.textContent).not.toContain("Stale resumed body");
  });

  it("deletes a draft from the Drafts list", async () => {
    const savedDraftId = "draft-22222222-2222-4222-8222-222222222222";
    const summary = {
      draftId: savedDraftId,
      accountId: accountA.accountId,
      revision: 4,
      state: "editing" as const,
      intent: { kind: "compose" as const },
      subject: "Removable draft",
      updatedAt: 1_700_000_000_000,
    };
    const listDrafts = vi
      .fn()
      .mockResolvedValueOnce([summary])
      .mockResolvedValue([]);
    const client = makeClient({ listDrafts });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await goTo("Drafts");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Removable draft"),
    );
    await click(findButton("Delete draft Removable draft"));

    // Brain's own question, and it names what leaves.
    expect(document.body.textContent).toContain("Delete this draft?");
    expect(document.body.textContent).toContain(
      "“Removable draft” will be removed from Drafts",
    );
    await confirmSystemDialog("Delete draft");

    await vi.waitFor(() =>
      expect(client.deleteDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: accountA.accountId,
          draftId: savedDraftId,
          expectedRevision: 4,
          mutationId: expect.stringMatching(/^draft-mutation-/),
        }),
      ),
    );
  });

  it("keeps a saved draft when deletion is not confirmed", async () => {
    const summary = {
      draftId: "draft-22222222-2222-4222-8222-222222222222",
      accountId: accountA.accountId,
      revision: 4,
      state: "editing" as const,
      intent: { kind: "compose" as const },
      subject: "Keep this draft",
      updatedAt: 1_700_000_000_000,
    };
    const client = makeClient({
      listDrafts: vi.fn().mockResolvedValue([summary]),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await goTo("Drafts");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Keep this draft"),
    );

    await click(findButton("Delete draft Keep this draft"));
    // Cancel is the way out, and it is the button Enter lands on.
    await confirmSystemDialog("Cancel");

    expect(client.deleteDraft).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Keep this draft");
  });

  it("answers Esc as Cancel and hands focus back to the row it came from", async () => {
    // The native dialog gave these away for free and they have to be paid for
    // explicitly: Esc is the way out, Cancel is the default path, and focus
    // goes back to the button the press came from.
    const summary = {
      draftId: "draft-33333333-3333-4333-8333-333333333333",
      accountId: accountA.accountId,
      revision: 2,
      state: "editing" as const,
      intent: { kind: "compose" as const },
      subject: "Escapable draft",
      updatedAt: 1_700_000_000_000,
    };
    const client = makeClient({
      listDrafts: vi.fn().mockResolvedValue([summary]),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await goTo("Drafts");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Escapable draft"),
    );

    const invoker = findButton("Delete draft Escapable draft");
    await click(invoker);
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    // Cancel holds focus when the dialog opens, so Enter cannot delete.
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(client.deleteDraft).not.toHaveBeenCalled();
    await settleFocus();
    expect(document.activeElement).toBe(invoker);
  });

  it("names the draft it is about to discard, and keeps it on Cancel", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector(
        'input[placeholder="Subject"]',
      ) as HTMLInputElement,
      "Half a thought",
    );
    await click(findButton("Discard draft"));

    expect(document.body.textContent).toContain("Discard this draft?");
    expect(document.body.textContent).toContain(
      "“Half a thought” will be deleted from Drafts",
    );
    await confirmSystemDialog("Cancel");

    // Still writing, and nothing was deleted: Discard deletes, Close keeps,
    // and the question belongs to the one that cannot be taken back.
    expect(client.deleteDraft).not.toHaveBeenCalled();
    expect(
      (
        document.body.querySelector(
          'input[placeholder="Subject"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("Half a thought");
  });

  it("answers Esc as Cancel on the composer's question too, and returns focus", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector(
        'input[placeholder="Subject"]',
      ) as HTMLInputElement,
      "Still writing",
    );

    const invoker = findButton("Discard draft");
    await click(invoker);
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    // Cancel holds focus, so Enter can never be the destructive answer.
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(client.deleteDraft).not.toHaveBeenCalled();
    // Cancel leaves the composer exactly as it was, focus included.
    await settleFocus();
    expect(document.activeElement).toBe(invoker);
    expect(
      (
        document.body.querySelector(
          'input[placeholder="Subject"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("Still writing");
  });

  it("stacks a draft row's two lines instead of laying them side by side", async () => {
    const summary = {
      draftId: "draft-44444444-4444-4444-8444-444444444444",
      accountId: accountA.accountId,
      revision: 1,
      state: "editing" as const,
      intent: { kind: "compose" as const },
      subject: "Two-line draft",
      updatedAt: 1_700_000_000_000,
    };
    const client = makeClient({
      listDrafts: vi.fn().mockResolvedValue([summary]),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await goTo("Drafts");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Two-line draft"),
    );

    // `.brain-mail-row` is a flex ROW for the mailbox's rail-avatar-text
    // geometry, and a draft has none of it: a title over a status, which side
    // by side reads as one clipped sentence.
    const row = document.body.querySelector(
      '[aria-label="Drafts"] .brain-mail-row',
    );
    expect(row?.className).toContain("flex-col");
    expect(row?.className).toContain("justify-center");
  });

  it("keeps Send live when the service refuses the request outright", async () => {
    const client = makeClient({
      sendDraft: vi
        .fn()
        .mockRejectedValue(new MailApiError(400, "mail_draft_request_invalid")),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test; other@example.test",
    );
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("This message wasn’t accepted"),
    );
    // Nothing reached the atomic handoff, so blocking the writer out of their
    // own draft would be a lie about delivery.
    expect(findButton("Send").disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Check Sent");
  });

  it("still blocks a resend when the send identity is already taken", async () => {
    const client = makeClient({
      sendDraft: vi
        .fn()
        .mockRejectedValue(
          new MailApiError(409, "mail_draft_idempotency_conflict"),
        ),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("may already be on its way"),
    );
    expect(findButton("Send").disabled).toBe(true);
  });

  it("reloads the draft and unblocks Send after a revision conflict", async () => {
    const getDraft = vi.fn().mockResolvedValue({
      draftId: "draft-55555555-5555-4555-8555-555555555555",
      accountId: accountA.accountId,
      revision: 9,
      state: "editing",
      intent: { kind: "compose" },
      // Identical to what the composer holds, so the retry sends straight from
      // the reloaded revision instead of autosaving once more first.
      to: "friend@example.test",
      cc: "",
      bcc: "",
      subject: "",
      text: "",
      updatedAt: 1_700_000_000_000,
    });
    const sendDraft = vi
      .fn()
      .mockRejectedValueOnce(
        new MailApiError(409, "mail_draft_revision_conflict"),
      )
      .mockImplementation((input) =>
        Promise.resolve({
          replayed: false,
          appliedRevision: input.expectedRevision + 1,
          operationId: input.sendOperationId,
          created: true,
          status: "queued",
        }),
      );
    const client = makeClient({ sendDraft, getDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Brain loaded the newest version"),
    );
    expect(getDraft).toHaveBeenCalledTimes(1);
    expect(findButton("Send").disabled).toBe(false);

    await click(findButton("Send"));

    await vi.waitFor(() => expect(sendDraft).toHaveBeenCalledTimes(2));
    // The retry has to carry the revision getDraft returned, not the stale one
    // the conflicting attempt used.
    const staleRevision = sendDraft.mock.calls[0]?.[0]?.expectedRevision;
    expect(sendDraft.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 9 });
    expect(staleRevision).not.toBe(9);
  });

  it("preserves an ambiguous draft and offers no discard control", async () => {
    // `appliedRevision` is fixed when the draft enters `submitting`. Reaching a
    // terminal outbox status bumps it once more through the drafts trigger, so
    // the send result is always one behind. See the store's own proof in
    // lib/mail/service/outbound-store.test.ts ("maps failed and
    // delivery-unknown outbox transitions back to drafts"): a send answering
    // appliedRevision 1 leaves the draft at revision 2.
    let submittingRevision = -1;
    let terminalRevision = -1;
    const sendDraft = vi.fn().mockImplementation((input) => {
      submittingRevision = input.expectedRevision + 1;
      terminalRevision = submittingRevision + 1;
      return Promise.resolve({
        replayed: false,
        appliedRevision: submittingRevision,
        operationId: input.sendOperationId,
        created: true,
        status: "delivery_unknown",
      });
    });
    const getDraft = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        draftId: input.draftId,
        accountId: input.accountId,
        revision: terminalRevision,
        state: "delivery_unknown",
        intent: { kind: "compose" },
        to: "friend@example.test",
        cc: "",
        bcc: "",
        subject: "",
        text: "Ambiguous body",
        updatedAt: 1_700_000_000_000,
      }),
    );
    const client = makeClient({ sendDraft, getDraft });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Ambiguous body",
    );
    await click(findButton("Send"));

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Delivery status is unknown"),
    );
    expect(getDraft).toHaveBeenCalledTimes(1);
    // The writer must still see exactly what they tried to send.
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Ambiguous body");

    expect(
      document.body.querySelector('button[aria-label="Discard draft"]'),
    ).toBeNull();
    expect(client.deleteDraft).not.toHaveBeenCalled();
    // The service revision still advanced, but Brain must retain this evidence
    // instead of exposing a destructive action for an ambiguous delivery.
    expect(terminalRevision).not.toBe(submittingRevision);
  });

  it("lists every draft the writer still owns and hides sent tombstones", async () => {
    const summary = (
      index: number,
      state: "editing" | "submitting" | "failed" | "delivery_unknown" | "sent",
      subject: string,
    ) => ({
      draftId: `draft-6666666${index}-6666-4666-8666-666666666666`,
      accountId: accountA.accountId,
      revision: 4,
      state,
      intent: { kind: "compose" as const },
      subject,
      updatedAt: 1_700_000_000_000,
    });
    const listDrafts = vi
      .fn()
      .mockResolvedValue([
        summary(1, "editing", "Still writing"),
        summary(2, "submitting", "On its way"),
        summary(3, "failed", "Bounced back"),
        summary(4, "delivery_unknown", "Unclear ending"),
        summary(5, "sent", "Already gone"),
      ]);
    const client = makeClient({ listDrafts });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await goTo("Drafts");

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Still writing"),
    );
    expect(
      document.body.querySelectorAll('[aria-label="Saved drafts"] [role="listitem"]'),
    ).toHaveLength(4);
    expect(document.body.textContent).toContain("On its way");
    expect(document.body.textContent).toContain("Unclear ending");
    expect(document.body.textContent).not.toContain("Already gone");
    expect(document.body.textContent).not.toContain("No saved drafts");

    // Each row says what Brain actually knows.
    expect(document.body.textContent).toContain("Sending");
    expect(document.body.textContent).toContain("Didn’t send");
    expect(document.body.textContent).toContain("Delivery unknown");
  });

  /* THE ALARM, AND ONLY THE ALARM. Drafts is reached through the nav menu, so
     the toolbar icon is not a door — it is the one thing the menu cannot do,
     which is shout. It arrives with the first failed send and leaves with the
     last, and the count on the menu row reports the same number. */
  it("raises the toolbar alarm only once a send has failed", async () => {
    vi.useFakeTimers();
    const listDrafts = vi.fn().mockResolvedValue([
      {
        draftId: "draft-99999999-9999-4999-8999-999999999999",
        accountId: accountA.accountId,
        revision: 3,
        state: "failed" as const,
        intent: { kind: "compose" as const },
        subject: "Bounced back",
        updatedAt: 1_700_000_000_000,
      },
    ]);
    const client = makeClient({ listDrafts });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    // Until the refresh reads the outbox there is nothing to report, so
    // there is no control at all.
    expect(draftsAlarm("Drafts")).toBeNull();
    expect(draftsAlarm("Drafts, 1 didn’t send")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await settle();

    const drafts = draftsAlarm("Drafts, 1 didn’t send");
    expect(drafts?.textContent).toContain("1");
    // and the menu row carries the same number
    await openNav();
    expect(navItem("Drafts")?.textContent).toContain("1");
    await closeNav();
  });

  /* AN IN-FLIGHT SEND IS NOT A REASON — it corrects itself. The toolbar stays
     empty and the menu row says it in words. */
  it("keeps the toolbar empty while a draft is still submitting", async () => {
    vi.useFakeTimers();
    const listDrafts = vi.fn().mockResolvedValue([
      {
        draftId: "draft-99999999-9999-4999-8999-999999999999",
        accountId: accountA.accountId,
        revision: 3,
        state: "submitting" as const,
        intent: { kind: "compose" as const },
        subject: "On its way",
        updatedAt: 1_700_000_000_000,
      },
    ]);
    const client = makeClient({ listDrafts });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await settle();

    expect(draftsAlarm("Drafts, sending")).toBeNull();

    await openNav();
    const row = navItem("Drafts");
    expect(row?.getAttribute("aria-label")).toBe("Drafts, sending");
    expect(row?.querySelector(".tree-row-count")).toBeNull();
    expect(row?.querySelector("span[aria-hidden]")).not.toBeNull();
    await closeNav();
  });

  it.each(["submitting", "delivery_unknown"] as const)(
    "offers no reopen or delete control for a %s draft",
    async (state) => {
      const listDrafts = vi.fn().mockResolvedValue([
        {
          draftId: "draft-77777777-7777-4777-8777-777777777777",
          accountId: accountA.accountId,
          revision: 4,
          state,
          intent: { kind: "compose" as const },
          subject: "Frozen draft",
          updatedAt: 1_700_000_000_000,
        },
      ]);
      const client = makeClient({ listDrafts });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("Drafts");

      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("Frozen draft"),
      );
      // The service refuses both mutations for these states, so no control may
      // promise one.
      const controls = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Saved drafts"] button',
        ),
      );
      expect(controls).toHaveLength(0);
      expect(client.getDraft).not.toHaveBeenCalled();
    },
  );

  it("keeps Mail open with a useful zero-account state", async () => {
    const client = makeClient({ loadAccounts: vi.fn().mockResolvedValue([]) });
    const onOpenSettings = vi.fn();
    const onAccountStatusChange = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface
          client={client}
          onOpenSettings={onOpenSettings}
          onAccountStatusChange={onAccountStatusChange}
        />,
      ),
    );
    await settle();
    await enterSingleAccount();

    expect(document.body.textContent).toContain("Connect Gmail or a custom-domain mailbox");
    await click(findButton("Connect account"));
    expect(onOpenSettings).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
    expect(onAccountStatusChange).toHaveBeenCalledWith(false);
  });

  it("reports a Google OAuth outcome once and removes it from the URL", async () => {
    window.history.replaceState({}, "", "/mail?gmail=connected&keep=1");
    const onToast = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface client={makeClient()} onOpenSettings={() => {}} onToast={onToast} />,
      ),
    );
    await settle();
    await enterSingleAccount();

    expect(onToast).toHaveBeenCalledWith("Google account connected");
    expect(window.location.pathname).toBe("/mail");
    expect(window.location.search).toBe("?keep=1");
  });

  it("keeps a manual sync batch within the proven backend wall-clock bound", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        apiVersion: 1,
        status: "idle",
        changedCount: 20,
        hasMore: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await defaultMailSurfaceClient.sync({ accountId: accountA.accountId });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mail/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ accountId: accountA.accountId, maxItems: 20 }),
      }),
    );
  });

  it("keeps browser search terms out of the URL and rejects dishonest truncation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(searchThreadPage("inbox")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultMailSurfaceClient.searchThreads({
        accountId: accountA.accountId,
        mailboxId: "inbox",
        query: "PRIVATE private project!!!",
        limit: 25,
      }),
    ).resolves.toMatchObject({ scope: "headers_and_previews" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mail/search",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({
          accountId: accountA.accountId,
          mailboxId: "inbox",
          query: "private project",
          limit: 25,
        }),
      }),
    );

    fetchMock.mockClear();
    for (const query of [
      "é".repeat(129),
      Array.from({ length: 13 }, (_, index) => `term${index}`).join(" "),
      "a".repeat(65),
      "🙂 !!!",
    ]) {
      await expect(
        defaultMailSurfaceClient.searchThreads({
          accountId: accountA.accountId,
          mailboxId: "inbox",
          query,
        }),
      ).rejects.toThrow("invalid mail search query");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      response({
        ...searchThreadPage("inbox", []),
        availability: {
          status: "available",
          lastSuccessfulAt: 1,
          windowTruncated: true,
        },
        resultsTruncated: false,
      }),
    );
    await expect(
      defaultMailSurfaceClient.searchThreads({
        accountId: accountA.accountId,
        mailboxId: "inbox",
        query: "private",
      }),
    ).rejects.toThrow("invalid mail search thread list");
  });

  it("rejects account responses containing provider secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 3,
          accounts: [{ ...accountB, googleSubject: "SECRET subject" }],
        }),
      ),
    );
    await act(async () => root.render(<MailSurface onOpenSettings={() => {}} />));
    await settle();

    expect(document.body.textContent).toContain("Mail couldn’t load");
    expect(document.body.textContent).not.toContain("SECRET");
  });

  it("explains that the mail service is not running", async () => {
    // Without the mail container every mail route answers 503 with this code.
    // That is a missing service, not a broken one, so the page says what to
    // add rather than that something failed.
    const client = makeClient({
      loadAccounts: vi
        .fn()
        .mockRejectedValue(new MailApiError(503, "mail_service_unavailable")),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();

    expect(host.textContent).toContain("Mail isn’t running");
    expect(host.textContent).toContain("second container");
    expect(host.textContent).not.toContain("Mail couldn’t load");
    expect(findButton("Try again")).toBeInstanceOf(HTMLButtonElement);
    expect(
      host.querySelector('a[href="https://github.com/michaelbrowk/brain#install"]')
        ?.textContent,
    ).toBe("How to add it");
  });

  it("refuses locally to submit an address the service would reject", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test, nonsense",
    );
    await click(findButton("Send"));

    expect(document.body.textContent).toContain(
      "To \u201cnonsense\u201d is not an email address.",
    );
    expect(client.sendDraft).not.toHaveBeenCalled();
  });

  it("sends a draft addressed only by blind copy", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await click(findButton("Cc Bcc"));
    const bccLabel = [...document.body.querySelectorAll("label")].find(
      (label) => label.textContent?.trim() === "Bcc",
    ) as HTMLLabelElement;
    await setInput(
      document.getElementById(bccLabel.htmlFor) as HTMLInputElement,
      "friend@example.test",
    );
    await settle();
    await click(findButton("Send"));

    await vi.waitFor(() => expect(client.sendDraft).toHaveBeenCalled());
  });

  it("lets a custom-domain IMAP account with SMTP compose and send", async () => {
    const client = makeClient({
      loadAccounts: vi.fn().mockResolvedValue([smtpImapAccount]),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "friend@example.test",
    );
    await settle();
    await click(findButton("Send"));

    await vi.waitFor(() => expect(client.sendDraft).toHaveBeenCalled());
  });

  it("selects a smart view from the nav menu, passes it on, and clears the reader", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    expect(
      document.body.querySelector('section[aria-label="Message reader"] h1')
        ?.textContent,
    ).toBe("Lunch this Friday?");

    await goTo("Unread");

    expect(client.listThreads).toHaveBeenLastCalledWith(
      { accountId: accountA.accountId, limit: 50, view: "unread" },
      expect.any(AbortSignal),
    );
    // The check is on the row the trigger names — one destination, marked
    // once, in the only place navigation lives.
    await openNav();
    expect(navItem("Unread")?.getAttribute("aria-checked")).toBe("true");
    expect(navItem("Inbox")?.getAttribute("aria-checked")).toBe("false");
    await closeNav();
    // The reader dropped back to idle — a view change is a navigation.
    expect(document.body.textContent).toContain("Choose a message");

    // Attachments reads All Mail on a Gmail account.
    await goTo("Attachments");
    expect(client.listMailboxThreads).toHaveBeenLastCalledWith(
      {
        accountId: accountA.accountId,
        mailboxId: "all",
        limit: 50,
        view: "attachments",
      },
      expect.any(AbortSignal),
    );

    // A plain mailbox from the same menu resets the view.
    await goTo("Inbox");
    expect(client.listThreads).toHaveBeenLastCalledWith(
      { accountId: accountA.accountId, limit: 50 },
      expect.any(AbortSignal),
    );
  });

  it("changes sort from the header menu, keeps the reader, and persists per mailbox", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));

    await act(async () => {
      findButton("Sort: Date").dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await settle();
    await click(findMenuItem("Size"));

    expect(client.listThreads).toHaveBeenLastCalledWith(
      { accountId: accountA.accountId, limit: 50, sort: "size" },
      expect.any(AbortSignal),
    );
    // Only the list reorders — the open conversation stays.
    expect(
      document.body.querySelector('section[aria-label="Message reader"] h1')
        ?.textContent,
    ).toBe("Lunch this Friday?");
    expect(
      window.localStorage.getItem(
        `brain:mail:sort:v1:${accountA.accountId}:inbox`,
      ),
    ).toBe("size");

    // Sent has its own preference; Inbox restores the stored one on return.
    await goTo("Sent");
    expect(client.listMailboxThreads).toHaveBeenLastCalledWith(
      { accountId: accountA.accountId, mailboxId: "sent", limit: 50 },
      expect.any(AbortSignal),
    );
    await goTo("Inbox");
    expect(client.listThreads).toHaveBeenLastCalledWith(
      { accountId: accountA.accountId, limit: 50, sort: "size" },
      expect.any(AbortSignal),
    );
  });

  it("disables sorting while a search query is active", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    const input = document.body.querySelector(
      'input[aria-label="Search mail"]',
    ) as HTMLInputElement;
    await setInput(input, "Lunch");
    await act(async () => vi.advanceTimersByTimeAsync(180));
    await settle();

    const sortButton = findButton("Sort: Date");
    expect(sortButton.disabled).toBe(true);
    expect(sortButton.getAttribute("aria-disabled")).toBe("true");
    // v2 IconButton: the disabled look (opacity .4, no pointer events) lives
    // on `.icon-btn:disabled` in globals.css, not in a utility class.
    expect(sortButton.className).toContain("icon-btn");
  });

/* PRESSING THE PLACE YOU CAME FROM IS THE WAY BACK. Drafts is a destination
     now, so the head draws no Back button — and the menu row that leads home
     has to cost what Back cost, which was one flag. Choosing a DIFFERENT
     destination still rebuilds the column, query and all; choosing the one it
     was standing on returns to it untouched. */
  it("returns from Drafts to the destination it came from without resetting it", async () => {
    vi.useFakeTimers();
    const searchThreads = vi
      .fn()
      .mockResolvedValue(searchThreadPage("inbox"));
    const listThreads = vi.fn().mockResolvedValue(threadPage);
    const client = makeClient({ searchThreads, listThreads });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    // D1 — a smart view with a query standing in it
    await goTo("Unread");
    const input = document.body.querySelector(
      'input[aria-label="Search mail"]',
    ) as HTMLInputElement;
    await setInput(input, "invoice");
    await act(async () => vi.advanceTimersByTimeAsync(180));
    await settle();
    expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Unread");
    expect(
      (
        document.body.querySelector(
          'input[aria-label="Search mail"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("invoice");
    const loadsBefore = listThreads.mock.calls.length;

    // D2 — Drafts takes the column
    await goTo("Drafts");
    expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Drafts");

    // D3 — and the row it came from hands it straight back: the query is
    // still there, and nothing was re-fetched to put it there.
    await goTo("Unread");
    expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Unread");
    expect(
      (
        document.body.querySelector(
          'input[aria-label="Search mail"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("invoice");
    expect(listThreads.mock.calls.length).toBe(loadsBefore);

    // A different destination is not a return, and still costs the reset.
    await goTo("Drafts");
    await goTo("Sent");
    expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Sent");
    expect(
      document.body.querySelector('input[aria-label="Search mail"]'),
    ).toHaveProperty("value", "");
  });

    it("reaches a smart view from the nav menu and drops it again", async () => {
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    await goTo("Unread");
    // the trigger names the view, not the mailbox under it
    expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Unread");
    expect(client.listThreads).toHaveBeenLastCalledWith(
      { accountId: accountA.accountId, limit: 50, view: "unread" },
      expect.any(AbortSignal),
    );

    // A plain folder choice drops the view again.
    await goTo("Inbox");
    expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
    expect(client.listThreads).toHaveBeenLastCalledWith(
      { accountId: accountA.accountId, limit: 50 },
      expect.any(AbortSignal),
    );
  });

  it("names a conversation that changed on the server, and does not ask for another try", async () => {
    const onToast = vi.fn();
    const client = makeClient({
      updateThread: vi
        .fn()
        .mockRejectedValue(new MailApiError(409, "mail_thread_stale")),
    });
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await click(findButton("Archive"));
    // The service's `mail_thread_stale`: the letter is no longer what the
    // list said. It used to arrive as "unavailable" and be answered with
    // "Try again", which could never have helped.
    expect(onToast).toHaveBeenLastCalledWith(
      "That conversation changed on the server. Refresh Mail to see it.",
    );
  });

  describe("auto-read on open", () => {
    const unreadThread = { ...thread, unread: true } as const;

    /** Server-truth mock: PATCH {read} flips what later reads return. */
    function autoReadClient() {
      let unread = true;
      const listThreads = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ...threadPage,
          items: [{ ...unreadThread, unread }],
        }),
      );
      const readThread = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ...detail,
          thread: { ...unreadThread, unread },
        }),
      );
      const updateThread = vi.fn().mockImplementation(async (input) => {
        if ("read" in input) unread = !input.read;
      });
      const client = makeClient({ listThreads, readThread, updateThread });
      return {
        client,
        updateThread,
        markUnread: () => {
          unread = true;
        },
      };
    }

    it("marks an unread thread read once through the button's mutation path", async () => {
      const { client, updateThread } = autoReadClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await click(findButton("Lunch this Friday?"));
      expect(updateThread).toHaveBeenCalledTimes(1);
      expect(updateThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        read: true,
      });
      // The header toggle now offers the reverse action.
      expect(findButton("Mark unread")).toBeDefined();

      // Re-renders while the same open stays current never re-fire.
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      expect(updateThread).toHaveBeenCalledTimes(1);
    });

    it("retries on a fresh open after the reader closes", async () => {
      const { client, updateThread, markUnread } = autoReadClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await click(findButton("Lunch this Friday?"));
      expect(updateThread).toHaveBeenCalledTimes(1);

      await click(findButton("Back to Inbox"));
      markUnread();
      await click(findButton("Lunch this Friday?"));
      expect(updateThread).toHaveBeenCalledTimes(2);
      expect(updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        read: true,
      });
    });

    it("does not fire when the thread is already read", async () => {
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await click(findButton("Lunch this Friday?"));
      expect(client.updateThread).not.toHaveBeenCalled();
      expect(findButton("Mark unread")).toBeDefined();
    });

    it("does not fire for an account without thread mutations", async () => {
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([imapAccount]),
        listThreads: vi.fn().mockResolvedValue({
          ...threadPage,
          items: [unreadThread],
        }),
        readThread: vi.fn().mockResolvedValue({
          ...detail,
          thread: unreadThread,
        }),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await click(findButton("Lunch this Friday?"));
      expect(client.updateThread).not.toHaveBeenCalled();
    });
  });

  describe("sticky open in the unread view and unread-first sort", () => {
    const firstUnread = {
      ...thread,
      threadId: "unread-1",
      subject: "First unread",
      unread: true,
      lastMessageAt: 1_700_000_000_900,
    } as const;
    const secondUnread = {
      ...thread,
      threadId: "unread-2",
      subject: "Second unread",
      unread: true,
      lastMessageAt: 1_700_000_000_800,
    } as const;

    /**
     * Server truth: PATCH {read} flips the flag; the unread view filters read
     * threads out server-side; the unread-first sort floats unread rows.
     */
    function stickyClient() {
      const unreadById = new Map([
        [firstUnread.threadId, true],
        [secondUnread.threadId, true],
      ]);
      const items = () =>
        [firstUnread, secondUnread].map((item) => ({
          ...item,
          unread: unreadById.get(item.threadId)!,
        }));
      const listThreads = vi.fn().mockImplementation((input) => {
        let pageItems = items();
        if (input.view === "unread") {
          pageItems = pageItems.filter((item) => item.unread);
        }
        if (input.sort === "unread") {
          pageItems = [...pageItems].sort(
            (a, b) => Number(b.unread) - Number(a.unread),
          );
        }
        return Promise.resolve({ ...threadPage, items: pageItems });
      });
      const readThread = vi.fn().mockImplementation(({ threadId }) =>
        Promise.resolve({
          ...detail,
          thread: items().find((item) => item.threadId === threadId)!,
          messages: [],
        }),
      );
      const updateThread = vi.fn().mockImplementation(async (input) => {
        if ("read" in input) unreadById.set(input.threadId, input.read !== true);
      });
      return {
        client: makeClient({ listThreads, readThread, updateThread }),
        listThreads,
        updateThread,
      };
    }

    async function enterUnreadView() {
      await goTo("Unread");
    }

    function mailboxList(): HTMLElement {
      return document.body.querySelector(
        'section[aria-label="Mailbox"]',
      ) as HTMLElement;
    }

    it("keeps the open letter listed in the unread view until the selection moves on", async () => {
      const { client, listThreads, updateThread } = stickyClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await enterUnreadView();
      const loadsAfterView = listThreads.mock.calls.length;

      await click(findButton("First unread"));
      await settle();
      // The PATCH fired on open — server truth is immediate…
      expect(updateThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: firstUnread.threadId,
        read: true,
      });
      // …but the page-1 refetch is suppressed: the letter stays listed and
      // the reader stays open on it.
      expect(listThreads.mock.calls.length).toBe(loadsAfterView);
      expect(mailboxList().textContent).toContain("First unread");
      expect(
        document.body.querySelector('section[aria-label="Message reader"] h1')
          ?.textContent,
      ).toBe("First unread");

      // Moving on releases the hold: one silent refetch settles the read
      // letter out of the unread view while the next open letter stays.
      await click(findButton("Second unread"));
      await settle();
      expect(listThreads.mock.calls.length).toBe(loadsAfterView + 1);
      expect(listThreads).toHaveBeenLastCalledWith(
        { accountId: accountA.accountId, limit: 50, view: "unread" },
        expect.any(AbortSignal),
      );
      expect(mailboxList().textContent).not.toContain("First unread");
      expect(mailboxList().textContent).toContain("Second unread");
    });

    it("releases the hold in the unread view when the reader closes", async () => {
      const { client, listThreads } = stickyClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await enterUnreadView();

      await click(findButton("First unread"));
      await settle();
      const loadsWhileOpen = listThreads.mock.calls.length;
      expect(mailboxList().textContent).toContain("First unread");

      await click(findButton("Back to Inbox"));
      expect(listThreads.mock.calls.length).toBe(loadsWhileOpen + 1);
      expect(mailboxList().textContent).not.toContain("First unread");
      expect(mailboxList().textContent).toContain("Second unread");
    });

    it("keeps the open letter's position under unread-first sort until release", async () => {
      const { client, listThreads } = stickyClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await act(async () => {
        findButton("Sort: Date").dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
      });
      await settle();
      await click(findMenuItem("Unread first"));
      expect(listThreads).toHaveBeenLastCalledWith(
        { accountId: accountA.accountId, limit: 50, sort: "unread" },
        expect.any(AbortSignal),
      );
      const loadsAfterSort = listThreads.mock.calls.length;
      const rows = () =>
        [...mailboxList().querySelectorAll('[role="list"] button')].map(
          (button) => button.textContent ?? "",
        );

      await click(findButton("First unread"));
      await settle();
      // Suppressed refetch: no re-sort while the letter is open — it keeps
      // the position it had when it was selected.
      expect(listThreads.mock.calls.length).toBe(loadsAfterSort);
      expect(rows()[0]).toContain("First unread");

      await click(findButton("Back to Inbox"));
      // Release refetches under the same sort: the read letter settles down.
      expect(listThreads.mock.calls.length).toBe(loadsAfterSort + 1);
      expect(listThreads).toHaveBeenLastCalledWith(
        { accountId: accountA.accountId, limit: 50, sort: "unread" },
        expect.any(AbortSignal),
      );
      expect(rows()[0]).toContain("Second unread");
      expect(rows()[1]).toContain("First unread");
    });
  });

  describe("keyboard layer", () => {
    // The j/k throttle releases on requestAnimationFrame. Real frames made
    // this timing-dependent: on a slow CI runner a genuine frame could fire
    // between two synchronous presses and legitimately release the throttle
    // (one flake on the hosted gate). Frames now fire only when a test
    // flushes them.
    let rafQueue: FrameRequestCallback[] = [];
    let rafId = 0;
    beforeEach(() => {
      rafQueue = [];
      vi.stubGlobal(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
          rafQueue.push(callback);
          rafId += 1;
          return rafId;
        },
      );
      vi.stubGlobal("cancelAnimationFrame", () => {});
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const secondThread = {
      ...thread,
      threadId: "thread-2",
      subject: "Second subject",
      unread: false,
      starred: true,
    } as const;

    const twoThreadPage: MailThreadPage = {
      apiVersion: 1,
      items: [thread, secondThread],
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    };

    const secondDetail: MailThreadDetail = {
      apiVersion: 1,
      thread: secondThread,
      messages: [],
    };

    function keyboardClient(overrides: Partial<MailSurfaceClient> = {}) {
      return makeClient({
        listThreads: vi.fn().mockResolvedValue(twoThreadPage),
        readThread: vi
          .fn()
          .mockImplementation(({ threadId }) =>
            Promise.resolve(
              threadId === secondThread.threadId ? secondDetail : detail,
            ),
          ),
        ...overrides,
      });
    }

    async function pressKey(key: string, init: KeyboardEventInit = {}) {
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, cancelable: true, ...init }),
        );
      });
      await settle();
    }

    /** Deterministically release the j/k throttle: run every queued frame. */
    async function nextFrame() {
      await act(async () => {
        const callbacks = rafQueue;
        rafQueue = [];
        for (const callback of callbacks) callback(performance.now());
      });
      await settle();
    }

    function activeThreadRow(): string | null {
      const row = document.body.querySelector(
        'section[aria-label="Mailbox"] button[aria-current="true"]',
      );
      return row?.textContent ?? null;
    }

    it("walks the list with j/k, selecting the first thread when none is open", async () => {
      const client = keyboardClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await pressKey("j");
      expect(client.readThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
      });
      expect(activeThreadRow()).toContain(thread.subject);

      // A same-frame repeat is swallowed by the rAF throttle.
      await pressKey("j");
      expect(client.readThread).toHaveBeenCalledTimes(1);

      await nextFrame();
      await pressKey("j");
      expect(client.readThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: secondThread.threadId,
      });
      expect(activeThreadRow()).toContain(secondThread.subject);

      // Last row: forward stays put.
      await nextFrame();
      await pressKey("ArrowDown");
      expect(client.readThread).toHaveBeenCalledTimes(2);

      await nextFrame();
      await pressKey("k");
      expect(client.readThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
      });
    });

    it("Enter hands focus to the reader scroll pane", async () => {
      const client = keyboardClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      // No thread open: nothing to focus.
      await pressKey("Enter");
      expect(
        document.body.querySelector("[data-mail-reader-scroll]"),
      ).toBeNull();

      await pressKey("j");
      await pressKey("Enter");
      const pane = document.body.querySelector<HTMLElement>(
        "[data-mail-reader-scroll]",
      );
      expect(pane).not.toBeNull();
      expect(document.activeElement).toBe(pane);
    });

    it("e archives in Inbox, u toggles read, s toggles star", async () => {
      const client = keyboardClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await pressKey("j");
      await pressKey("e");
      expect(client.updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        archive: true,
      });

      // The thread is already read (auto-read owns the unread case), so the
      // toggle marks it unread.
      await pressKey("u");
      expect(client.updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        read: false,
      });

      await pressKey("s");
      expect(client.updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        starred: true,
      });
    });

    it("e is a no-op in a folder without a direct action", async () => {
      const client = keyboardClient({
        readMailboxThread: vi.fn().mockResolvedValue(secondDetail),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await goTo("Sent");
      await pressKey("j");
      await pressKey("e");
      expect(client.updateThread).not.toHaveBeenCalled();
    });

    it("c opens the composer, which then swallows everything except Escape", async () => {
      const client = keyboardClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await pressKey("c");
      expect(
        document.body.querySelector('form[aria-label="New message"]'),
      ).not.toBeNull();

      await pressKey("j");
      expect(client.readThread).not.toHaveBeenCalled();

      await pressKey("Escape");
      expect(
        document.body.querySelector('form[aria-label="New message"]'),
      ).toBeNull();
    });

    it("c is a no-op when the account cannot compose", async () => {
      const client = keyboardClient({
        loadAccounts: vi.fn().mockResolvedValue([imapAccount]),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await pressKey("c");
      expect(document.body.querySelector("form[aria-label]")).toBeNull();
    });

    it("/ focuses the search input and Escape then clears the query", async () => {
      const client = keyboardClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await pressKey("/");
      const search = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Search mail"]',
      );
      expect(search).not.toBeNull();
      expect(document.activeElement).toBe(search);

      search!.blur();
      await setInput(search!, "Lunch");
      await settle();
      await pressKey("Escape");
      expect(search!.value).toBe("");

      // Nothing left to close: Escape falls through untouched.
      await pressKey("Escape");
      expect(search!.value).toBe("");
    });

    it("Escape returns from the reader to the list on a mobile viewport", async () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
      const client = keyboardClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await pressKey("j");
      expect(
        document.body.querySelector("[data-mail-reader-scroll]"),
      ).not.toBeNull();

      await pressKey("Escape");
      expect(
        document.body.querySelector("[data-mail-reader-scroll]"),
      ).toBeNull();
      expect(activeThreadRow()).toBeNull();
    });

    it("ignores modifier chords and keys typed into fields", async () => {
      const client = keyboardClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await pressKey("j", { metaKey: true });
      await pressKey("j", { ctrlKey: true });
      await pressKey("j", { altKey: true });
      expect(client.readThread).not.toHaveBeenCalled();

      const search = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Search mail"]',
      )!;
      await act(async () => {
        search.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "j",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await settle();
      expect(client.readThread).not.toHaveBeenCalled();
    });
  });

  describe("palette command bus", () => {
    async function emit(command: Parameters<typeof emitMailCommand>[0]) {
      await act(async () => {
        emitMailCommand(command);
      });
      await settle();
    }

    it("routes goto commands through the same handlers the nav menu uses", async () => {
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await emit("goto-lists");
      expect(client.listThreads).toHaveBeenLastCalledWith(
        { accountId: accountA.accountId, limit: 50, view: "lists" },
        expect.any(AbortSignal),
      );

      // Attachments prefers All Mail when the account has it — rail parity.
      await emit("goto-attachments");
      expect(client.listMailboxThreads).toHaveBeenLastCalledWith(
        {
          accountId: accountA.accountId,
          limit: 50,
          view: "attachments",
          mailboxId: "all",
        },
        expect.any(AbortSignal),
      );

      await emit("goto-starred");
      expect(client.listMailboxThreads).toHaveBeenLastCalledWith(
        { accountId: accountA.accountId, limit: 50, mailboxId: "starred" },
        expect.any(AbortSignal),
      );

      await emit("goto-inbox");
      expect(client.listThreads).toHaveBeenLastCalledWith(
        { accountId: accountA.accountId, limit: 50 },
        expect.any(AbortSignal),
      );

      await emit("goto-drafts");
      expect(
        document.body.querySelector('section[aria-label="Drafts"]'),
      ).not.toBeNull();

      await emit("compose");
      expect(
        document.body.querySelector('form[aria-label="New message"]'),
      ).not.toBeNull();
    });

    it("gates commands on the account capabilities", async () => {
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([imapAccount]),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await emit("compose");
      expect(document.body.querySelector("form[aria-label]")).toBeNull();

      await emit("goto-drafts");
      expect(
        document.body.querySelector('section[aria-label="Drafts"]'),
      ).toBeNull();

      await emit("goto-starred");
      expect(client.listMailboxThreads).not.toHaveBeenCalled();
    });
  });
  describe("unified inbox", () => {
    function unifiedThread(
      overrides: Partial<MailThreadListItem> & {
        readonly accountId: string;
        readonly threadId: string;
      },
    ): MailThreadListItem {
      return {
        ...thread,
        subject: overrides.threadId,
        participants: [{ name: "Sender", address: "sender@example.test" }],
        unread: true,
        ...overrides,
      };
    }

    function pageOf(
      items: readonly MailThreadListItem[],
      nextCursor: string | null = null,
    ): MailThreadPage {
      return {
        apiVersion: 1,
        items,
        nextCursor,
        sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
      };
    }

    /* THE MODE DOES NOT CHANGE THE OBJECT — it takes out of it what the mode
       does not have. All inboxes has one mailbox and no smart views, so the
       destinations block and the Smart block are simply not there and the
       menu is the Accounts label with its rows. Same control, same place,
       fewer blocks. */
    it("mounts into All inboxes, and its menu is the Accounts block alone", async () => {
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      expect(navTrigger()?.getAttribute("aria-label")).toBe(
        "Mailbox: All inboxes",
      );
      await openNav();
      expect(navDestinations()).toEqual([
        "All inboxes",
        accountA.emailAddress,
        accountB.emailAddress,
      ]);
      expect(navItem("All inboxes")?.getAttribute("aria-checked")).toBe("true");
      expect(document.body.textContent).not.toContain("Smart");
      await closeNav();
      // Unified hides single-account list chrome entirely.
      expect(
        document.body.querySelector('input[aria-label="Search mail"]'),
      ).toBeNull();
      expect(document.body.querySelector('[aria-label^="Sort:"]')).toBeNull();
    });

    /* THE MERGE NEEDS SOMETHING TO MERGE. A lone account is the first screen
       a new user sees, and it used to open into All inboxes — one inbox
       merged with nothing, and a menu whose only block was Accounts with two
       rows in it. It opens into its own Inbox now, and the menu draws no
       Accounts block: its two rows would be a merge the surface never enters
       and the address the reader is already at, and a block of one row is
       not a block. */
    it("mounts a lone account into its Inbox, and draws no Accounts block", async () => {
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
      expect(
        document.body.querySelector('[aria-label="All inboxes threads"]'),
      ).toBeNull();
      // one load, for the one account — no merge was ever started
      expect(client.listThreads).toHaveBeenCalledTimes(1);
      expect(client.listThreads).toHaveBeenLastCalledWith(
        { accountId: accountA.accountId, limit: 50 },
        expect.any(AbortSignal),
      );
      await openNav();
      expect(navDestinations()).not.toContain("All inboxes");
      expect(navDestinations()).not.toContain(accountA.emailAddress);
      expect(navLabels()).toEqual(["Smart"]);
      await closeNav();
      // and the single-account chrome is up, since this IS the single account
      expect(
        document.body.querySelector('input[aria-label="Search mail"]'),
      ).not.toBeNull();
    });

    it("opens the merge once a second account connects, without a reload", async () => {
      const loadAccounts = vi
        .fn()
        .mockResolvedValueOnce([accountA])
        .mockResolvedValueOnce([accountA, accountB])
        .mockResolvedValueOnce([accountA]);
      const client = makeClient({ loadAccounts });
      const mount = (refreshToken: number) =>
        act(async () =>
          root.render(
            <MailSurface
              client={client}
              onOpenSettings={() => {}}
              refreshToken={refreshToken}
            />,
          ),
        );
      await mount(0);
      await settle();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");

      // The second account arrives on a refresh — Settings connected it. The
      // column stays where it was, the trigger takes the word that now
      // distinguishes the account, and the block appears with All inboxes in
      // it.
      await mount(1);
      await settle();
      expect(navTrigger()?.getAttribute("aria-label")).toBe(
        `Mailbox: Inbox, ${accountWordFor(accountA, [accountA, accountB])}`,
      );
      await openNav();
      expect(navLabels()).toEqual(["Smart", "Accounts"]);
      expect(navDestinations().slice(-3)).toEqual([
        "All inboxes",
        accountA.emailAddress,
        accountB.emailAddress,
      ]);
      await closeNav();
      await goTo("All inboxes");
      expect(navTrigger()?.getAttribute("aria-label")).toBe(
        "Mailbox: All inboxes",
      );

      // and the merge closes the moment it has nothing to merge again
      await mount(2);
      await settle();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
      await openNav();
      expect(navLabels()).toEqual(["Smart"]);
      await closeNav();
    });

    /* The palette's goto-* commands leave the merge before they route. A lone
       account was never in it, so they route straight through — and nothing
       tries to enter a merge that does not exist. */
    it("routes the palette straight through for a lone account", async () => {
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      const emit = async (command: "goto-starred" | "goto-inbox" | "goto-drafts") => {
        await act(async () => emitMailCommand(command));
        await settle();
      };

      await emit("goto-starred");
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Starred");
      await emit("goto-drafts");
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Drafts");
      await emit("goto-inbox");
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
      expect(
        document.body.querySelector('[aria-label="All inboxes threads"]'),
      ).toBeNull();
      // the mount's load and the return to Inbox — no merge in between
      expect(client.listThreads).toHaveBeenCalledTimes(2);
    });

    it("loads every eligible account in parallel and sections both streams", async () => {
      const itemA = unifiedThread({
        accountId: accountA.accountId,
        threadId: "People from A",
        lastMessageAt: 1_700_000_000_900,
      });
      const itemB = unifiedThread({
        accountId: accountB.accountId,
        threadId: "People from B",
        lastMessageAt: 1_700_000_000_800,
      });
      const noteB = unifiedThread({
        accountId: accountB.accountId,
        threadId: "Notification from B",
        category: "notification",
        lastMessageAt: 1_700_000_000_700,
      });
      const seenA = unifiedThread({
        accountId: accountA.accountId,
        threadId: "Seen from A",
        unread: false,
        lastMessageAt: 1_700_000_000_600,
      });
      const listThreads = vi.fn().mockImplementation(({ accountId }) =>
        Promise.resolve(
          pageOf(
            accountId === accountA.accountId ? [itemA, seenA] : [itemB, noteB],
          ),
        ),
      );
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      expect(listThreads).toHaveBeenCalledWith(
        { accountId: accountA.accountId, limit: 50 },
        expect.any(AbortSignal),
      );
      expect(listThreads).toHaveBeenCalledWith(
        { accountId: accountB.accountId, limit: 50 },
        expect.any(AbortSignal),
      );

      const list = document.body.querySelector(
        '[aria-label="All inboxes threads"]',
      ) as HTMLElement;
      expect(list.textContent).toContain("People");
      expect(list.textContent).toContain("Notifications");
      expect(list.textContent).toContain("People from A");
      expect(list.textContent).toContain("People from B");
      expect(list.textContent).toContain("Notification from B");
      // Two accounts contribute People rows, so their sub-headers render.
      expect(list.textContent).toContain(accountA.emailAddress);
      expect(list.textContent).toContain(accountB.emailAddress);
      // Seen stays collapsed: the count shows, the row does not.
      expect(list.textContent).toContain("Seen");
      expect(list.textContent).not.toContain("Seen from A");
    });

    it("degrades one failing account to an inline notice with per-account retry", async () => {
      const itemA = unifiedThread({
        accountId: accountA.accountId,
        threadId: "Healthy thread",
      });
      const itemB = unifiedThread({
        accountId: accountB.accountId,
        threadId: "Recovered thread",
      });
      let failB = true;
      const listThreads = vi.fn().mockImplementation(({ accountId }) => {
        if (accountId === accountB.accountId && failB) {
          return Promise.reject(new Error("outage"));
        }
        return Promise.resolve(
          pageOf(accountId === accountA.accountId ? [itemA] : [itemB]),
        );
      });
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      expect(document.body.textContent).toContain("Healthy thread");
      expect(document.body.textContent).toContain(
        `${accountB.emailAddress} couldn’t load`,
      );

      failB = false;
      await click(findButton("Try again"));
      expect(listThreads).toHaveBeenLastCalledWith({
        accountId: accountB.accountId,
        limit: 50,
      });
      expect(document.body.textContent).toContain("Recovered thread");
      expect(document.body.textContent).not.toContain("couldn’t load");
    });

    it("fetches only the starved stream on Load more", async () => {
      const deepA = [
        unifiedThread({
          accountId: accountA.accountId,
          threadId: "A newest",
          lastMessageAt: 1_700_000_000_900,
        }),
        unifiedThread({
          accountId: accountA.accountId,
          threadId: "A horizon",
          lastMessageAt: 1_700_000_000_500,
        }),
      ];
      const deepB = [
        unifiedThread({
          accountId: accountB.accountId,
          threadId: "B newest",
          lastMessageAt: 1_700_000_000_800,
        }),
        unifiedThread({
          accountId: accountB.accountId,
          threadId: "B deep",
          lastMessageAt: 1_700_000_000_100,
        }),
      ];
      const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) => {
        if (cursor) {
          return Promise.resolve(
            pageOf([
              unifiedThread({
                accountId: accountA.accountId,
                threadId: "A page two",
                lastMessageAt: 1_700_000_000_400,
              }),
            ]),
          );
        }
        return Promise.resolve(
          accountId === accountA.accountId
            ? pageOf(deepA, "cursor-a")
            : pageOf(deepB, "cursor-b"),
        );
      });
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      await click(findButton("Load more"));
      // Stream A holds the newest horizon, so only its page 2 is fetched.
      expect(listThreads).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        cursor: "cursor-a",
        limit: 50,
      });
      const cursorCalls = listThreads.mock.calls.filter(
        (call) => call[0].cursor,
      );
      expect(cursorCalls).toHaveLength(1);
      expect(document.body.textContent).toContain("A page two");
    });

    it("patches mutations locally with the item's own accountId", async () => {
      const itemB = unifiedThread({
        accountId: accountB.accountId,
        threadId: "thread-b-1",
        subject: "Mail from B",
      });
      const detailB: MailThreadDetail = {
        ...detail,
        thread: itemB,
        messages: [
          {
            ...detail.messages[0]!,
            accountId: accountB.accountId,
            threadId: itemB.threadId,
            subject: itemB.subject,
          },
        ],
      };
      const listThreads = vi.fn().mockImplementation(({ accountId }) =>
        Promise.resolve(pageOf(accountId === accountB.accountId ? [itemB] : [])),
      );
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads,
        readThread: vi.fn().mockResolvedValue(detailB),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      const loadsBeforeOpen = listThreads.mock.calls.length;

      await click(findButton("Mail from B"));
      await settle();
      // Auto-read routes through the unified mutation with B's accountId…
      expect(client.updateThread).toHaveBeenCalledWith({
        accountId: accountB.accountId,
        threadId: itemB.threadId,
        read: true,
      });
      // …and the list is patched locally, never refetched.
      expect(listThreads.mock.calls.length).toBe(loadsBeforeOpen);
      expect(client.readThread).toHaveBeenCalledTimes(1);
      // The open letter stays put in People while it is read — it settles
      // into Seen only when the reader moves on, never mid-read.
      const list = document.body.querySelector(
        '[aria-label="All inboxes threads"]',
      ) as HTMLElement;
      expect(
        list.querySelector('section[aria-label="People"]')?.textContent,
      ).toContain("Mail from B");
      expect(list.querySelector('section[aria-label="Seen"]')).toBeNull();

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
      });
      await settle();
      expect(client.updateThread).toHaveBeenLastCalledWith({
        accountId: accountB.accountId,
        threadId: itemB.threadId,
        starred: true,
      });
      expect(listThreads.mock.calls.length).toBe(loadsBeforeOpen);
    });

    it("holds the open letter in People and settles it to Seen on the next selection", async () => {
      const first = unifiedThread({
        accountId: accountA.accountId,
        threadId: "first-unified",
        subject: "First unified",
        lastMessageAt: 1_700_000_000_900,
      });
      const second = unifiedThread({
        accountId: accountA.accountId,
        threadId: "second-unified",
        subject: "Second unified",
        lastMessageAt: 1_700_000_000_800,
      });
      const listThreads = vi.fn().mockImplementation(({ accountId }) =>
        Promise.resolve(
          pageOf(accountId === accountA.accountId ? [first, second] : []),
        ),
      );
      const readThread = vi.fn().mockImplementation(({ threadId }) =>
        Promise.resolve({
          ...detail,
          thread: threadId === first.threadId ? first : second,
          messages: [],
        }),
      );
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads,
        readThread,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      const list = () =>
        document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        ) as HTMLElement;

      await click(findButton("First unified"));
      await settle();
      // The PATCH fired on open — server truth is immediate…
      expect(client.updateThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: first.threadId,
        read: true,
      });
      // …but the letter keeps its captured People placement while it is open.
      expect(
        list().querySelector('section[aria-label="People"]')?.textContent,
      ).toContain("First unified");
      expect(list().querySelector('section[aria-label="Seen"]')).toBeNull();

      // The next selection replaces the capture: the previous letter settles
      // into Seen, the newly opened one holds its own place.
      await click(findButton("Second unified"));
      await settle();
      const people = list().querySelector('section[aria-label="People"]');
      expect(people?.textContent).not.toContain("First unified");
      expect(people?.textContent).toContain("Second unified");
      expect(list().querySelector('section[aria-label="Seen"]')).not.toBeNull();
    });

    it("settles the open letter to Seen when the reader closes", async () => {
      const only = unifiedThread({
        accountId: accountA.accountId,
        threadId: "only-unified",
        subject: "Only unified",
      });
      const listThreads = vi.fn().mockImplementation(({ accountId }) =>
        Promise.resolve(pageOf(accountId === accountA.accountId ? [only] : [])),
      );
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads,
        readThread: vi
          .fn()
          .mockResolvedValue({ ...detail, thread: only, messages: [] }),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      const list = () =>
        document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        ) as HTMLElement;

      await click(findButton("Only unified"));
      await settle();
      expect(
        list().querySelector('section[aria-label="People"]')?.textContent,
      ).toContain("Only unified");
      expect(list().querySelector('section[aria-label="Seen"]')).toBeNull();

      await click(findButton("Back to Inbox"));
      expect(list().querySelector('section[aria-label="People"]')).toBeNull();
      expect(list().querySelector('section[aria-label="Seen"]')).not.toBeNull();
      // No refetch was needed to settle — derivation reverted to live state.
      expect(
        listThreads.mock.calls.filter(
          (call) => call[0].accountId === accountA.accountId,
        ),
      ).toHaveLength(1);
    });

    describe("Done clears a whole section", () => {
      /**
       * Sixteen sequential mutations do not settle in three microtask flushes.
       * `drain` runs `settle` until the loop has had room to finish — no
       * timers, so it stays deterministic.
       */
      async function drain(rounds = 40) {
        for (let index = 0; index < rounds; index += 1) await settle();
      }

      function unifiedClient(
        items: readonly MailThreadListItem[],
        overrides: Partial<MailSurfaceClient>,
      ) {
        return makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads: vi.fn().mockImplementation(({ accountId }) =>
            Promise.resolve(
              pageOf(accountId === accountA.accountId ? items : []),
            ),
          ),
          ...overrides,
        });
      }

      it("takes a bundled section whole — archive first, then read", async () => {
        const items = Array.from({ length: 8 }, (_value, index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `nl-${index}`,
            category: "newsletter",
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        // Eight newsletters bundle into one digest row. Done acts on the
        // pile, not on what the ring is showing.
        expect(
          document.body.querySelectorAll(
            'section[aria-label="Newsletters"] [role="listitem"]',
          ).length,
        ).toBe(1);

        await click(findButton("Done — archive all 8 in Newsletters"));
        await drain();

        expect(updateThread).toHaveBeenCalledTimes(16);
        expect(
          updateThread.mock.calls.filter((call) => call[0].archive === true),
        ).toHaveLength(8);
        expect(
          updateThread.mock.calls.filter((call) => call[0].read === true),
        ).toHaveLength(8);
        // Archive is not read — the two mutations are both sent, and archive
        // leads, because that is the one that can fail without moving a thread.
        expect(updateThread.mock.calls[0]?.[0]).toMatchObject({
          threadId: "nl-0",
          archive: true,
        });
        expect(updateThread.mock.calls[1]?.[0]).toMatchObject({
          threadId: "nl-0",
          read: true,
        });
        expect(
          document.body.querySelector('section[aria-label="Newsletters"]'),
        ).toBeNull();
        expect(onToast).toHaveBeenCalledWith(
          "Newsletters cleared",
          expect.objectContaining({
            subtitle: "8 threads out of your inbox",
            actionLabel: "Undo",
          }),
        );
      });

      it("aborts when the mode changes mid-flight, finishing only the item in hand", async () => {
        const items = [1, 2, 3].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `bulk-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const firstMutation = deferred<void>();
        const updateThread = vi
          .fn()
          .mockReturnValueOnce(firstMutation.promise)
          .mockResolvedValue(undefined);
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
            />,
          ),
        );
        await settle();

        await act(async () => {
          findButton("Done — archive all 3 in People").click();
        });
        expect(updateThread).toHaveBeenCalledTimes(1);

        // Leaving unified mode bumps the epoch. The thread whose archive is
        // already in flight still gets its read flag — an archived letter left
        // unread would be a half-state nobody asked for — and nothing after it
        // is started.
        await enterSingleAccount();
        await act(async () => firstMutation.resolve());
        await drain();
        expect(updateThread.mock.calls.map((call) => call[0].threadId)).toEqual(
          ["bulk-1", "bulk-1"],
        );
      });

      it("keeps going past a failure and leaves that thread where it was", async () => {
        const items = [1, 2, 3].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `bulk-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const updateThread = vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) =>
            input.threadId === "bulk-2" && input.archive === true
              ? Promise.reject(new Error("provider said no"))
              : Promise.resolve(undefined),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 3 in People"));
        await drain();

        // The failed thread was never marked read either: a failed archive
        // leaves it exactly as it stood, unread and in its section.
        expect(
          updateThread.mock.calls.filter(
            (call) => call[0].threadId === "bulk-2",
          ),
        ).toHaveLength(1);
        const list = document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        );
        expect(list?.textContent).toContain("bulk-2");
        expect(list?.textContent).not.toContain("bulk-1");
        expect(list?.textContent).not.toContain("bulk-3");
        expect(onToast).toHaveBeenCalledWith(
          "People partly cleared",
          expect.objectContaining({
            subtitle: "2 archived, 1 stayed put",
            actionLabel: "Undo",
          }),
        );
      });

      it("empties the column at the press, before the first request lands", async () => {
        // The undo window opens with the gesture, not half a minute after it:
        // the whole point of an always-drawn destructive control is that the
        // way back is there while the reader is still looking at what changed.
        const items = [1, 2, 3, 4].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `bulk-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const firstArchive = deferred<void>();
        const updateThread = vi
          .fn()
          .mockReturnValueOnce(firstArchive.promise)
          .mockResolvedValue(undefined);
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 4 in People"));

        // One request is in flight and none has landed, and the section is
        // already gone with its Undo on screen.
        expect(updateThread).toHaveBeenCalledTimes(1);
        expect(
          document.body.querySelector('section[aria-label="People"]'),
        ).toBeNull();
        // The press-time pill has no window at all: it stands until the loop
        // reports. A duration here would have to be guessed from the count,
        // and the ring drawn over it would be counting down a deadline that
        // does not exist yet.
        expect(onToast).toHaveBeenCalledWith(
          "People cleared",
          expect.objectContaining({
            subtitle: "4 threads out of your inbox",
            actionLabel: "Undo",
            durationMs: null,
          }),
        );

        await act(async () => firstArchive.resolve());
        await drain();
        expect(updateThread).toHaveBeenCalledTimes(8);
        // Same sentence, same pill, ordinary window — counted from where the
        // work ended rather than from a press that may be a minute old.
        expect(onToast).toHaveBeenLastCalledWith(
          "People cleared",
          expect.objectContaining({
            subtitle: "4 threads out of your inbox",
            actionLabel: "Undo",
            durationMs: 10_000,
          }),
        );
      });

      it("holds the pill through a long run and counts only from the end", async () => {
        // Forty read threads under Done — the scale a busy Seen section
        // reaches. The window used to be predicted from that count — ten
        // seconds plus six a thread — so this press armed 250 seconds, the
        // ring crawled, and the pill read as frozen. There is no number here
        // now. The pill stands with no window until the last request lands,
        // and the ordinary ten seconds are counted from there.
        const items = Array.from({ length: 40 }, (_value, index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `seen-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        // One thread in the middle holds the loop, which is what a real
        // custom-domain mutation does: its own connect, authenticate and
        // logout with no pool behind it.
        const midRun = deferred<void>();
        const updateThread = vi
          .fn()
          .mockImplementation(({ threadId }: { threadId: string }) =>
            threadId === "seen-19" ? midRun.promise : Promise.resolve(undefined),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 40 in Seen"));
        // The press: the section is gone, the way back is on screen, and the
        // pill carries no window for the ring to draw.
        expect(onToast).toHaveBeenCalledTimes(1);
        expect(onToast).toHaveBeenCalledWith(
          "Seen cleared",
          expect.objectContaining({
            subtitle: "40 threads out of your inbox",
            actionLabel: "Undo",
            durationMs: null,
          }),
        );

        // Twenty threads in and stuck on the twentieth. The pill has not been
        // said a second time, so nothing has taken it and nothing has started
        // counting it down — the Undo posted at the press is still the one
        // standing over work that is still going out.
        await drain();
        expect(updateThread).toHaveBeenCalledTimes(20);
        expect(onToast).toHaveBeenCalledTimes(1);

        await act(async () => midRun.resolve());
        await drain();
        expect(updateThread).toHaveBeenCalledTimes(40);
        // The loop landed, and only now is there a deadline to count: the same
        // sentence under the same id, with the plain window measured from the
        // end of the work rather than from a press four minutes old.
        expect(onToast).toHaveBeenCalledTimes(2);
        expect(onToast).toHaveBeenLastCalledWith(
          "Seen cleared",
          expect.objectContaining({
            subtitle: "40 threads out of your inbox",
            actionLabel: "Undo",
            durationMs: 10_000,
          }),
        );
      });

      it("stops an account at its first refusal and says why", async () => {
        const items = [1, 2, 3].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `bulk-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        // 409: the account's server has no folder to archive into. It answers
        // the same for every other thread on it, and each answer costs a full
        // connect and authenticate.
        const updateThread = vi
          .fn()
          .mockRejectedValue(
            new MailApiError(409, "mail_thread_mutation_unsupported"),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 3 in People"));
        await drain();

        expect(updateThread).toHaveBeenCalledTimes(1);
        const list = document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        );
        expect(list?.textContent).toContain("bulk-1");
        expect(list?.textContent).toContain("bulk-3");
        expect(onToast).toHaveBeenLastCalledWith(
          "Couldn’t clear People",
          expect.objectContaining({
            subtitle: "3 threads stayed put, that account has no folder for it",
          }),
        );
      });

      it("keeps going for the other account when one of them refuses", async () => {
        const items = [
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "bulk-1",
            lastMessageAt: 1_700_000_000_000,
          }),
          unifiedThread({
            accountId: accountB.accountId,
            threadId: "bulk-2",
            lastMessageAt: 1_700_000_000_000 - 1,
          }),
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "bulk-3",
            lastMessageAt: 1_700_000_000_000 - 2,
          }),
        ];
        const updateThread = vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) =>
            input.accountId === accountA.accountId
              ? Promise.reject(
                  new MailApiError(409, "mail_thread_mutation_unsupported"),
                )
              : Promise.resolve(undefined),
          );
        const onToast = vi.fn();
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads: vi.fn().mockImplementation(({ accountId }) =>
            Promise.resolve(
              pageOf(items.filter((item) => item.accountId === accountId)),
            ),
          ),
          updateThread,
        });
        await act(async () =>
          root.render(
            <MailSurface
              client={client}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 3 in People"));
        await drain();

        // One refusal closes A. B's thread still goes out, because its server
        // never said anything of the kind.
        expect(
          updateThread.mock.calls.filter(
            (call) => call[0].accountId === accountA.accountId,
          ),
        ).toHaveLength(1);
        expect(onToast).toHaveBeenLastCalledWith(
          "People partly cleared",
          expect.objectContaining({
            subtitle:
              "1 archived, 2 stayed put, that account has no folder for it",
          }),
        );
      });

      it("Undo during the loop stops it and puts back what never left", async () => {
        const items = [1, 2, 3].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `bulk-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const firstArchive = deferred<void>();
        const updateThread = vi
          .fn()
          .mockReturnValueOnce(firstArchive.promise)
          .mockResolvedValue(undefined);
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 3 in People"));
        const undo = onToast.mock.calls.at(-1)?.[1]?.onAction as
          | (() => boolean | void | Promise<unknown>)
          | undefined;
        // Taken, but not spent yet: the answer is the run's own settling, and
        // the shell keeps the pill up until it lands.
        expect(undo?.()).toBeInstanceOf(Promise);
        await act(async () => firstArchive.resolve());
        await drain();

        // The thread already in flight is archived, marked read and then put
        // back; the two still queued never go out at all, which is the
        // cheapest possible reversal and the reason Undo is worth offering
        // while the loop is still running.
        expect(updateThread.mock.calls.map((call) => call[0])).toEqual([
          {
            accountId: accountA.accountId,
            threadId: "bulk-1",
            archive: true,
          },
          { accountId: accountA.accountId, threadId: "bulk-1", read: true },
          {
            accountId: accountA.accountId,
            threadId: "bulk-1",
            archive: false,
          },
          { accountId: accountA.accountId, threadId: "bulk-1", read: false },
        ]);
        const list = document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        );
        expect(list?.textContent).toContain("bulk-1");
        expect(list?.textContent).toContain("bulk-2");
        expect(list?.textContent).toContain("bulk-3");
        // One thread was restored: the other two never left, so they are not
        // counted as brought back. "3 restored" here was a lie the old copy
        // told by adding what stayed to what moved.
        expect(onToast).toHaveBeenLastCalledWith(
          "Back in your inbox",
          expect.objectContaining({ subtitle: "1 thread restored" }),
        );
      });

      /** A deferred with both ends, for a request the clock has to end. */
      function settleable<T>() {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<T>((next, fail) => {
          resolve = next;
          reject = fail;
        });
        return { promise, resolve, reject };
      }

      const timedOut = () =>
        new DOMException("mail mutation unanswered after 15000ms", "TimeoutError");

      it("a mutation the clock gave up on closes its account for the run and frees the lock", async () => {
        // Three read threads on A and one on B. A's second archive is never
        // answered: the client's deadline turns that into a timeout, which
        // is not a bad minute — the next request to that account would sit
        // just as long — so A is closed for the run, the third thread stays
        // put untried, and B still goes.
        const items = [
          ...[0, 1, 2].map((index) =>
            unifiedThread({
              accountId: accountA.accountId,
              threadId: `a-${index}`,
              unread: false,
              lastMessageAt: 1_700_000_000_000 - index,
            }),
          ),
          unifiedThread({
            accountId: accountB.accountId,
            threadId: "b-0",
            unread: false,
            lastMessageAt: 1_700_000_000_000 - 3,
          }),
        ];
        const updateThread = vi
          .fn()
          .mockImplementation(({ threadId }: { threadId: string }) =>
            threadId === "a-1"
              ? Promise.reject(timedOut())
              : Promise.resolve(undefined),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, {
                updateThread,
                listThreads: vi.fn().mockImplementation(({ accountId }) =>
                  Promise.resolve(
                    pageOf(items.filter((item) => item.accountId === accountId)),
                  ),
                ),
              })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 4 in Seen"));
        await drain();

        expect(updateThread.mock.calls.map((call) => call[0])).toEqual([
          { accountId: accountA.accountId, threadId: "a-0", archive: true },
          { accountId: accountA.accountId, threadId: "a-1", archive: true },
          { accountId: accountB.accountId, threadId: "b-0", archive: true },
        ]);
        expect(onToast).toHaveBeenLastCalledWith(
          "Seen partly cleared",
          expect.objectContaining({
            subtitle: "2 archived, 2 stayed put, that account stopped answering",
            actionLabel: "Undo",
            durationMs: 10_000,
          }),
        );
        // Seen keeps the two that stayed (a-1, a-2); the two that left are
        // out. The section is collapsed, so it is the count that says so.
        const list = document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        );
        expect(list?.textContent).toContain("2 threads, nothing unread");

        // The lock went with the run. Undo is not refused, and it reverses
        // exactly the two that left.
        const undo = onToast.mock.calls.at(-1)?.[1]?.onAction as
          | (() => boolean | void | Promise<unknown>)
          | undefined;
        updateThread.mockClear();
        updateThread.mockResolvedValue(undefined);
        expect(undo?.()).not.toBe(false);
        await drain();
        expect(updateThread.mock.calls.map((call) => call[0])).toEqual([
          { accountId: accountA.accountId, threadId: "a-0", archive: false },
          { accountId: accountB.accountId, threadId: "b-0", archive: false },
        ]);
        expect(onToast).toHaveBeenLastCalledWith(
          "Back in your inbox",
          expect.objectContaining({ subtitle: "2 threads restored" }),
        );
      });

      it("Undo waits out a request the clock has to end, then restores only what left", async () => {
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const stuck = settleable<void>();
        const updateThread = vi
          .fn()
          .mockImplementation(({ threadId }: { threadId: string }) =>
            threadId === "a-1" ? stuck.promise : Promise.resolve(undefined),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 3 in Seen"));
        await drain();
        expect(updateThread).toHaveBeenCalledTimes(2);
        const undo = onToast.mock.calls.at(-1)?.[1]?.onAction as
          | (() => boolean | void | Promise<unknown>)
          | undefined;

        // Undo, with the second archive hanging. The press is taken — and
        // not answered: the pill's promise is open until the run settles,
        // which it cannot while a request it sent is unanswered.
        const taken = undo?.();
        expect(taken).toBeInstanceOf(Promise);
        let settled = false;
        void (taken as Promise<unknown>).then(() => {
          settled = true;
        });
        await drain();
        expect(settled).toBe(false);
        expect(updateThread).toHaveBeenCalledTimes(2);
        // Nothing has been reversed and nothing has been said: the rows
        // that never left are back, the one that did is still out.
        expect(onToast).toHaveBeenCalledTimes(1);

        // The clock ends the request. The run settles, the pill is spent,
        // and the reversal reaches exactly the one thread that left.
        await act(async () => stuck.reject(timedOut()));
        await drain();
        expect(settled).toBe(true);
        expect(updateThread.mock.calls.map((call) => call[0])).toEqual([
          { accountId: accountA.accountId, threadId: "a-0", archive: true },
          { accountId: accountA.accountId, threadId: "a-1", archive: true },
          { accountId: accountA.accountId, threadId: "a-0", archive: false },
        ]);
        const list = document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        );
        expect(list?.textContent).toContain("3 threads, nothing unread");
        expect(onToast).toHaveBeenLastCalledWith(
          "Back in your inbox",
          expect.objectContaining({ subtitle: "1 thread restored" }),
        );
      });

      it("a run the reader walked out of names the switch, and refreshes the list they walked into", async () => {
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const midRun = deferred<void>();
        const updateThread = vi
          .fn()
          .mockImplementation(({ threadId }: { threadId: string }) =>
            threadId === "a-1" ? midRun.promise : Promise.resolve(undefined),
          );
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(
            pageOf(accountId === accountA.accountId ? items : []),
          ),
        );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread, listThreads })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 3 in Seen"));
        await drain();
        expect(updateThread).toHaveBeenCalledTimes(2);

        // Out of All inboxes and into account A while a-1 is still in
        // flight. The single list loads at once — with a-1 still in it,
        // because the server has not archived it yet.
        await enterSingleAccount(accountA);
        await drain();
        const loadsOfA = () =>
          listThreads.mock.calls.filter(
            (call) => call[0].accountId === accountA.accountId,
          ).length;
        const loadedOnSwitch = loadsOfA();
        expect(loadedOnSwitch).toBeGreaterThan(1);

        await act(async () => midRun.resolve());
        await drain();
        // The loop stopped at the switch: a-2 never went. The report says
        // why the count is short instead of leaving "stayed put" to imply a
        // refusal that never happened.
        expect(updateThread).toHaveBeenCalledTimes(2);
        expect(onToast).toHaveBeenLastCalledWith(
          "Seen partly cleared",
          expect.objectContaining({
            subtitle:
              "2 archived, 1 stayed put, stopped when you left All inboxes",
            durationMs: 10_000,
          }),
        );
        // And the list the reader is looking at is asked again, so the row
        // whose archive landed after the switch does not sit there for the
        // next minute.
        expect(loadsOfA()).toBe(loadedOnSwitch + 1);
      });

      it("a letter opened while the lock is held is marked read once the lock lifts", async () => {
        const people = unifiedThread({
          accountId: accountA.accountId,
          threadId: "p-1",
          lastMessageAt: 1_700_000_000_000,
        });
        const seen = [1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `s-${index}`,
            unread: false,
            lastMessageAt: 1_600_000_000_000 - index,
          }),
        );
        const items = [people, ...seen];
        const firstArchive = deferred<void>();
        const updateThread = vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) =>
            input.threadId === "s-1" && input.archive === true
              ? firstArchive.promise
              : Promise.resolve(undefined),
          );
        const readThread = vi.fn().mockImplementation(({ threadId }) =>
          Promise.resolve({
            ...detail,
            thread: items.find((item) => item.threadId === threadId),
          }),
        );
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread, readThread })}
              onOpenSettings={() => {}}
              onToast={() => {}}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 2 in Seen"));
        // Open the unread People letter while Seen's loop holds the lock.
        await click(findButton("p-1"));
        await drain();
        expect(readThread).toHaveBeenCalled();
        const readFlags = () =>
          updateThread.mock.calls.filter(
            (call) => call[0].threadId === "p-1" && call[0].read === true,
          );
        // Not yet: the lock is held and the mark-read is not spent for it.
        expect(readFlags()).toHaveLength(0);

        await act(async () => firstArchive.resolve());
        await drain();
        // The lock lifted and the open letter is read, once.
        expect(readFlags()).toHaveLength(1);
      });

      const stale = () => new MailApiError(409, "mail_thread_stale");

      it("a thread that changed on the server under Done is named, kept out, and not undone", async () => {
        // `mail_thread_stale`: the service says the letter is no longer what
        // the list said — moved by another client, or its mailbox re-keyed.
        // It did not "stay put": it is not where the column had it, so it is
        // not put back, and there is nothing of ours on it to reverse.
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const updateThread = vi
          .fn()
          .mockImplementation(({ threadId }: { threadId: string }) =>
            threadId === "a-1" ? Promise.reject(stale()) : Promise.resolve(undefined),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 3 in Seen"));
        await drain();
        expect(onToast).toHaveBeenLastCalledWith(
          "Seen partly cleared",
          expect.objectContaining({
            subtitle: "2 archived, 1 changed on the server",
            actionLabel: "Undo",
            durationMs: 10_000,
          }),
        );
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();

        const undo = onToast.mock.calls.at(-1)?.[1]?.onAction as
          | (() => boolean | void | Promise<unknown>)
          | undefined;
        updateThread.mockClear();
        updateThread.mockResolvedValue(undefined);
        expect(undo?.()).not.toBe(false);
        await drain();
        expect(updateThread.mock.calls.map((call) => call[0])).toEqual([
          { accountId: accountA.accountId, threadId: "a-0", archive: false },
          { accountId: accountA.accountId, threadId: "a-2", archive: false },
        ]);
        expect(onToast).toHaveBeenLastCalledWith(
          "Back in your inbox",
          expect.objectContaining({ subtitle: "2 threads restored" }),
        );
      });

      it("Undo names what changed on the server instead of calling it archived", async () => {
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const updateThread = vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) =>
            input.threadId === "a-1" && input.archive === false
              ? Promise.reject(stale())
              : Promise.resolve(undefined),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 3 in Seen"));
        await drain();
        const undo = onToast.mock.calls.at(-1)?.[1]?.onAction as
          | (() => boolean | void | Promise<unknown>)
          | undefined;
        expect(undo?.()).not.toBe(false);
        await drain();

        // Two came back. The third is not "still archived" — the server said
        // it is not the letter we archived any more — so it is neither
        // counted as archived nor left on the column as if it were back.
        expect(onToast).toHaveBeenLastCalledWith(
          "Put back 2 of 3",
          expect.objectContaining({ subtitle: "1 changed on the server" }),
        );
        const list = document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        );
        expect(list?.textContent).toContain("2 threads, nothing unread");
      });

      it("an Undo the server no longer recognises says so, without asking for another try", async () => {
        const items = [0, 1].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const updateThread = vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) =>
            input.archive === false ? Promise.reject(stale()) : Promise.resolve(undefined),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 2 in Seen"));
        await drain();
        const undo = onToast.mock.calls.at(-1)?.[1]?.onAction as
          | (() => boolean | void | Promise<unknown>)
          | undefined;
        expect(undo?.()).not.toBe(false);
        await drain();
        // "Try again" would be a lie: the letters changed under the archive,
        // and a second press meets the same answer.
        expect(onToast).toHaveBeenLastCalledWith(
          "Couldn’t put anything back",
          expect.objectContaining({
            subtitle: "Your mail changed on the server. Refresh Mail to see it.",
          }),
        );
      });

      it("Undo says it is working under the pill it took, and reports when the work lands", async () => {
        // Maya's measurement on a slow provider: press Undo and the rows come
        // back at once, then ten seconds of no pill at all until the report.
        // Half the mechanism said "working", the other half said nothing.
        // Mirror of Done: a pill with no window under the same id while the
        // way back goes out, replaced by the report when the last request
        // lands.
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const unarchives: Array<{ resolve: () => void }> = [];
        const updateThread = vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) => {
            if (input.archive !== false) return Promise.resolve(undefined);
            const gate = settleable<void>();
            unarchives.push({ resolve: () => gate.resolve() });
            return gate.promise;
          });
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 3 in Seen"));
        await drain();
        const report = onToast.mock.calls.at(-1)?.[1] as ToastOptions;
        expect(report.id).toBeDefined();
        const undo = report.onAction as
          | (() => boolean | void | Promise<unknown>)
          | undefined;
        expect(undo?.()).toBeInstanceOf(Promise);
        await drain();

        // The rows are back and the first un-archive is out. The pill says
        // so under the same id, with no window and no way back of its own.
        expect(unarchives).toHaveLength(1);
        expect(onToast).toHaveBeenLastCalledWith(
          "Putting back…",
          expect.objectContaining({
            subtitle: "3 threads on the way back",
            durationMs: null,
            id: report.id,
          }),
        );
        expect(onToast.mock.calls.at(-1)?.[1]?.actionLabel).toBeUndefined();
        const spoken = onToast.mock.calls.length;

        // Nothing more is said while the requests go out one by one.
        await act(async () => unarchives[0]!.resolve());
        await drain();
        expect(unarchives).toHaveLength(2);
        expect(onToast).toHaveBeenCalledTimes(spoken);

        await act(async () => unarchives[1]!.resolve());
        await drain();
        await act(async () => unarchives[2]!.resolve());
        await drain();
        // The report takes the pill: same id, an ordinary window.
        expect(onToast).toHaveBeenLastCalledWith(
          "Back in your inbox",
          expect.objectContaining({ subtitle: "3 threads restored", id: report.id }),
        );
        expect(onToast.mock.calls.at(-1)?.[1]?.durationMs).not.toBeNull();
      });

      it("says so when a second Done arrives while the first is still going", async () => {
        const items = [
          ...[1, 2].map((index) =>
            unifiedThread({
              accountId: accountA.accountId,
              threadId: `p-${index}`,
              lastMessageAt: 1_700_000_000_000 - index,
            }),
          ),
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "n-1",
            category: "notification",
            lastMessageAt: 1_600_000_000_000,
          }),
        ];
        const firstArchive = deferred<void>();
        const updateThread = vi
          .fn()
          .mockReturnValueOnce(firstArchive.promise)
          .mockResolvedValue(undefined);
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 2 in People"));
        await click(findButton("Done — archive all 1 in Notifications"));
        // Silence was the old answer, while the sibling undo has always
        // refused the same condition in words.
        // A refusal answers the gesture that made it, so it speaks at
        // once on its own pill rather than queueing behind the undo it is
        // competing with.
        expect(onToast).toHaveBeenLastCalledWith(
          "Finish the current mail action first",
          { urgent: true },
        );
        expect(
          document.body.querySelector('section[aria-label="Notifications"]'),
        ).not.toBeNull();

        await act(async () => firstArchive.resolve());
        await drain();
      });

      it("an Undo the lock refuses is not spent", async () => {
        const items = [
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "p-1",
            lastMessageAt: 1_700_000_000_000,
          }),
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "n-1",
            category: "notification",
            lastMessageAt: 1_600_000_000_000,
          }),
        ];
        const secondArchive = deferred<void>();
        const updateThread = vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) =>
            input.threadId === "n-1" && input.archive === true
              ? secondArchive.promise
              : Promise.resolve(undefined),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 1 in People"));
        await drain();
        const undo = onToast.mock.calls.at(-1)?.[1]?.onAction as
          | (() => boolean | void)
          | undefined;

        // Notifications takes the lock and parks on its first archive.
        await click(findButton("Done — archive all 1 in Notifications"));
        updateThread.mockClear();
        // The shell dismisses the pill only when the action says it took the
        // press. Refused, the way back is still on screen.
        expect(undo?.()).toBe(false);
        await drain();
        expect(updateThread).not.toHaveBeenCalled();

        await act(async () => secondArchive.resolve());
        await drain();
        // And it still works once the lock is free.
        expect(undo?.()).toBeInstanceOf(Promise);
        await drain();
        expect(
          updateThread.mock.calls.filter((call) => call[0].archive === false),
        ).toHaveLength(1);
      });

      it("gives Seen its own Done, and sends no read flag with it", async () => {
        const items = [
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "read-1",
            unread: false,
            lastMessageAt: 1_700_000_000_000,
          }),
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "read-2",
            unread: false,
            lastMessageAt: 1_600_000_000_000,
          }),
        ];
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        await click(findButton("Done — archive all 2 in Seen"));
        await drain();
        expect(updateThread.mock.calls.map((call) => call[0])).toEqual([
          { accountId: accountA.accountId, threadId: "read-1", archive: true },
          { accountId: accountA.accountId, threadId: "read-2", archive: true },
        ]);
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();
        expect(onToast).toHaveBeenCalledWith(
          "Seen cleared",
          expect.objectContaining({ subtitle: "2 threads out of your inbox" }),
        );
      });

      /** A merged pair of mixed capability: one Gmail mailbox and one IMAP
       *  one. IMAP cannot mutate threads, so Done can never move its rows. */
      const imapAccount: PublicMailAccount = {
        ...accountB,
        providerKind: "imap",
        capabilities: imapCapabilities,
        imap: {
          hostname: "imap.example.test",
          port: 993,
          tls: "implicit",
          username: "person@gmail.test",
        },
      };

      function mixedClient(
        items: readonly MailThreadListItem[],
        overrides: Partial<MailSurfaceClient> = {},
      ) {
        return makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, imapAccount]),
          listThreads: vi
            .fn()
            .mockImplementation(({ accountId }) =>
              Promise.resolve(
                pageOf(items.filter((entry) => entry.accountId === accountId)),
              ),
            ),
          ...overrides,
        });
      }

      it("names what stayed behind on an account that cannot archive", async () => {
        const items = [
          ...[1, 2].map((index) =>
            unifiedThread({
              accountId: accountA.accountId,
              threadId: `gmail-${index}`,
              category: "newsletter",
              lastMessageAt: 1_700_000_000_000 - index,
            }),
          ),
          ...[1, 2, 3].map((index) =>
            unifiedThread({
              accountId: imapAccount.accountId,
              threadId: `imap-${index}`,
              category: "newsletter",
              lastMessageAt: 1_600_000_000_000 - index,
            }),
          ),
        ];
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={mixedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        // The label promises only what it can keep.
        await click(findButton("Done — archive 2 of 5 in Newsletters"));
        await drain();

        // The two Gmail threads leave; the three IMAP rows are never touched
        // and never sent.
        expect(updateThread.mock.calls.map((call) => call[0].threadId)).toEqual([
          "gmail-1",
          "gmail-1",
          "gmail-2",
          "gmail-2",
        ]);
        const section = document.body.querySelector(
          'section[aria-label="Newsletters"]',
        );
        expect(section).not.toBeNull();
        expect(section?.textContent).toContain("imap-1");
        expect(section?.textContent).not.toContain("gmail-1");
        // And the rows that stayed are accounted for, in the same breath as
        // the ones that went. Silence here never corrects itself.
        expect(onToast).toHaveBeenCalledWith(
          "Newsletters partly cleared",
          expect.objectContaining({
            subtitle: "2 threads out of your inbox, 3 can’t leave",
            actionLabel: "Undo",
          }),
        );
      });

      it("draws no Done on a section it could archive nothing in", async () => {
        const items = [1, 2].map((index) =>
          unifiedThread({
            accountId: imapAccount.accountId,
            threadId: `imap-${index}`,
            category: "notification",
            lastMessageAt: 1_600_000_000_000 - index,
          }),
        );
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={mixedClient(items, { updateThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        // An always-drawn destructive control that silently does nothing is
        // the thing this removes. The surface keeps a spoken refusal behind
        // it for the race where capabilities change under a rendered button,
        // which no press can reach from here.
        expect(
          [...document.body.querySelectorAll("button")].filter((candidate) =>
            candidate.getAttribute("aria-label")?.startsWith("Done — "),
          ),
        ).toHaveLength(0);
      });

      it("undo restores exactly what moved, and only re-flags what it read", async () => {
        const items = [
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "open-one",
            lastMessageAt: 1_700_000_000_002,
          }),
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "still-unread",
            lastMessageAt: 1_700_000_000_001,
          }),
        ];
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const readThread = vi
          .fn()
          .mockImplementation(({ threadId }: { threadId: string }) =>
            Promise.resolve({
              ...detail,
              thread:
                items.find((entry) => entry.threadId === threadId) ?? items[0],
              messages: [],
            }),
          );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread, readThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();

        // Opening a letter marks it read while the sticky capture keeps it in
        // People, so Done meets one thread whose read state it did not change.
        await click(findButton("open-one"));
        await drain();
        updateThread.mockClear();

        await click(findButton("Done — archive all 2 in People"));
        await drain();
        expect(
          document.body.querySelector('[aria-label="All inboxes threads"]')
            ?.textContent ?? "",
        ).not.toContain("still-unread");

        const undo = onToast.mock.calls.at(-1)?.[1]?.onAction as
          | (() => void)
          | undefined;
        expect(undo).toBeTypeOf("function");
        updateThread.mockClear();
        await act(async () => undo?.());
        await drain();

        expect(updateThread.mock.calls.map((call) => call[0])).toEqual([
          {
            accountId: accountA.accountId,
            threadId: "open-one",
            archive: false,
          },
          {
            accountId: accountA.accountId,
            threadId: "still-unread",
            archive: false,
          },
          {
            accountId: accountA.accountId,
            threadId: "still-unread",
            read: false,
          },
        ]);
        // Both are back in the inbox, each in the section its own read state
        // puts it in — the unread one under People, the one the reader had
        // already opened under Seen (bundled, so the digest counts it rather
        // than naming it).
        const list = document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        );
        expect(
          list?.querySelector('section[aria-label="People"]')?.textContent,
        ).toContain("still-unread");
        expect(
          list?.querySelector('section[aria-label="Seen"]')?.textContent,
        ).toContain("1 thread, nothing unread");
        expect(onToast).toHaveBeenLastCalledWith(
          "Back in your inbox",
          expect.objectContaining({ subtitle: "2 threads restored" }),
        );
      });
    });

    it("reconciles page-1 on the silent tick without dropping loaded depth", async () => {
      vi.useFakeTimers();
      const pageOne = Array.from({ length: 50 }, (_value, index) =>
        unifiedThread({
          accountId: accountA.accountId,
          threadId: `depth-${String(index).padStart(2, "0")}`,
          lastMessageAt: 1_700_000_100_000 - index * 1_000,
        }),
      );
      const pageTwo = [
        unifiedThread({
          accountId: accountA.accountId,
          threadId: "depth-tail",
          lastMessageAt: 1_700_000_000_000,
        }),
      ];
      const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) =>
        Promise.resolve(
          accountId !== accountA.accountId
            ? pageOf([])
            : cursor
              ? pageOf(pageTwo)
              : pageOf(pageOne, "cursor-deep"),
        ),
      );
      // the merge exists only with a second account in it; B contributes
      // nothing to the column
      const client = makeClient({
        listThreads,
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      await click(findButton("Show all 50 in People"));
      await click(findButton("Load more"));
      expect(document.body.textContent).toContain("depth-tail");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await settle();
      const lastCall = listThreads.mock.calls.at(-1)?.[0];
      expect(lastCall?.cursor).toBeUndefined();
      // The refreshed page-1 window replaced the head; the deep tail stays.
      expect(document.body.textContent).toContain("depth-tail");
      expect(document.body.textContent).toContain("depth-49");
    });

    it("keeps all→single→all epochs isolated", async () => {
      const staleUnified = deferred<MailThreadPage>();
      let firstCall = true;
      const listThreads = vi.fn().mockImplementation(({ accountId }) => {
        // B is here so the merge exists at all, and contributes nothing
        if (accountId === accountB.accountId) return Promise.resolve(pageOf([]));
        if (firstCall) {
          firstCall = false;
          return staleUnified.promise;
        }
        return Promise.resolve(
          pageOf([
            unifiedThread({
              accountId: accountA.accountId,
              threadId: "Fresh thread",
            }),
          ]),
        );
      });
      const client = makeClient({
        listThreads,
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      await enterSingleAccount();
      await act(async () =>
        staleUnified.resolve(
          pageOf([
            unifiedThread({
              accountId: accountA.accountId,
              threadId: "Stale unified thread",
            }),
          ]),
        ),
      );
      await settle();
      expect(document.body.textContent).not.toContain("Stale unified thread");
      expect(document.body.textContent).toContain("Fresh thread");

      const callsBeforeReturn = listThreads.mock.calls.length;
      await goTo("All inboxes");
      // one page-1 per account in the merge
      expect(listThreads.mock.calls.length).toBe(callsBeforeReturn + 2);
      expect(document.body.textContent).toContain("Fresh thread");
      expect(document.body.textContent).not.toContain("Stale unified thread");
    });

    it("gives the reader the open thread's account capabilities", async () => {
      const readOnlyB: PublicMailAccount = {
        ...imapAccount,
        accountId: accountB.accountId,
        emailAddress: accountB.emailAddress,
      };
      const itemA = unifiedThread({
        accountId: accountA.accountId,
        threadId: "thread-full",
        subject: "Full-capability mail",
        lastMessageAt: 1_700_000_000_900,
        unread: false,
      });
      const itemB = unifiedThread({
        accountId: accountB.accountId,
        threadId: "thread-limited",
        subject: "Header-only mail",
        lastMessageAt: 1_700_000_000_800,
        unread: false,
      });
      const listThreads = vi.fn().mockImplementation(({ accountId }) =>
        Promise.resolve(
          pageOf(accountId === accountA.accountId ? [itemA] : [itemB]),
        ),
      );
      const readThread = vi.fn().mockImplementation(({ accountId, threadId }) =>
        Promise.resolve({
          ...detail,
          thread: accountId === accountA.accountId ? itemA : itemB,
          messages: [
            {
              ...detail.messages[0]!,
              accountId,
              threadId,
            },
          ],
        }),
      );
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, readOnlyB]),
        listThreads,
        readThread,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      // Both threads are read, so they live under Seen — the header chevron
      // is the one way in.
      await click(findButton("Show all 2 in Seen"));

      const archiveButton = () =>
        [...document.body.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === "Archive",
        );

      await click(findButton("Header-only mail"));
      expect(archiveButton()).toBeUndefined();
      expect(
        document.body.querySelector('[aria-label="More mail actions"]'),
      ).toBeNull();
      expect(client.updateThread).not.toHaveBeenCalled();

      await click(findButton("Full-capability mail"));
      expect(archiveButton()).not.toBeUndefined();
    });
  });
});
