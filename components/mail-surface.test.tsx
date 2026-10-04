// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it as vitestIt, vi } from "vitest";
import { emitMailCommand } from "./mail-commands";
import { accountWords } from "./mail-row";
import {
  MAIL_EVENT_DEBOUNCE_MS,
  MAIL_SAFETY_REFRESH_MS,
  MailSurface,
  UNIFIED_FANOUT_LIMIT,
} from "./mail-surface";
import { MAIL_CHANGED_EVENT, type BrainMailEvent } from "@/lib/mail/mail-events";
import { resetSectionDone } from "./mail-section-done";
import { SMART_UNDO_MS } from "./shell/helpers";
import type { ToastOptions } from "./ui/primitives";

// Animation playback is not under test — assert structure and props. The real
// AnimatePresence keeps exiting subtrees mounted through their exit animation,
// which jsdom never advances, so the mock renders children directly.
vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({ reducedMotion: false });
});

/** The centre's seam, doubled: what it decides is `notifications-client`'s
 *  business and pinned there. What belongs here is that Mail registers with it
 *  once on the mount, whichever way Mail was opened, and unregisters when it
 *  goes. */
const closeMailCentreRead = vi.fn();
const markMailCentreRead = vi.fn(() => closeMailCentreRead);
vi.mock("./notifications-read", () => ({
  markMailCentreRead: () => markMailCentreRead(),
}));
import {
  clearOpenThreadRequest,
  defaultMailSurfaceClient,
  MAIL_MUTATION_TIMEOUT_MS,
  MailApiError,
  pendingOpenThread,
  requestOpenThread,
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
  newSender: false,
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
    getSenderScreenState: vi.fn().mockResolvedValue(SENDER_STATE),
    setSenderScreenEnabled: vi.fn().mockResolvedValue(SENDER_STATE),
    decideSender: vi.fn().mockResolvedValue({
      apiVersion: 1,
      decisionId: DECISION_ID,
      archived: [],
      pending: false,
    }),
    undoSenderDecision: vi
      .fn()
      .mockResolvedValue({ apiVersion: 1, restored: [], pending: false }),
    listBlockedSenders: vi.fn().mockResolvedValue({ apiVersion: 1, blocked: [] }),
    ...overrides,
  };
}

const DECISION_ID = `decision-a${"0".repeat(30)}ab`;

const SENDER_STATE = {
  apiVersion: 1,
  enabled: true,
  enabledAt: 1_600_000_000_000,
  backfillComplete: true,
  domainScopeRefused: ["gmail.example"],
} as const;

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

/** What the shell dispatches for each SSE `mail` event. */
async function mailEvent(detail: BrainMailEvent) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(MAIL_CHANGED_EVENT, { detail }));
  });
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

/** Taken when the file loads, before any case fakes the clock: a teardown
 *  bound that has to run while a case's fake timers are still installed. */
const realSetTimeout = globalThis.setTimeout;

/**
 * THE CASE STILL RUNNING AFTER ITS TIMEOUT. Vitest fails a case that runs
 * past its timeout and moves on, but the case's body keeps going, and it is
 * usually inside an `act`: until that `act` ends every later one nests inside
 * it and never flushes, so every case after it fails on a tree that never
 * rendered. Each case's body is kept here, and the teardown lets it end (on
 * the real clock, and not for ever) before it takes the tree.
 */
let caseBody: Promise<unknown> = Promise.resolve();
const it = Object.assign(
  (name: string, body: () => unknown, timeout?: number) =>
    vitestIt(
      name,
      () => {
        const run = Promise.resolve().then(body);
        caseBody = run;
        return run;
      },
      timeout,
    ),
  // The table cases are short and synchronous in their setup; they keep
  // vitest's own `each`, bound to the API it reads its context from.
  { each: vitestIt.each.bind(vitestIt) },
);

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
    // All of it runs even when the case before failed or timed out with work
    // still out. A teardown that stopped at its first throw left fake timers,
    // a mounted tree and portals behind, and every later case in the file
    // then failed on the leftovers in a millisecond instead of on its own.
    await Promise.race([
      caseBody.catch(() => undefined),
      new Promise((resolve) => realSetTimeout(resolve, 5_000)),
    ]);
    try {
      await act(async () => root.unmount());
    } finally {
      // A section's Done keeps its holds and its queue for the page, which
      // in this file is every case: one case's holds would hide the next
      // case's rows.
      resetSectionDone();
      vi.clearAllTimers();
      vi.useRealTimers();
      host.remove();
      // Menus, dialogs and toasts portal onto the body, outside the host.
      document.body.replaceChildren();
      document.body.removeAttribute("style");
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
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

  /** An index still building answers a search in part, and the results are
   *  read again a quarter second later until it is built. Those re-reads are
   *  the list's own business: no skeleton stands in for one, and one that
   *  fails says so as the typed search would. */
  describe("the re-read of an index still building", () => {
    const building: MailSearchThreadPage = {
      ...searchThreadPage("inbox"),
      indexStatus: "building",
    };

    async function searchLunch(client: MailSurfaceClient) {
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await setInput(
        document.body.querySelector('input[aria-label="Search mail"]') as HTMLInputElement,
        "Lunch",
      );
      await act(async () => vi.advanceTimersByTimeAsync(180));
      await settle();
    }

    async function quarterSecond() {
      await act(async () => vi.advanceTimersByTimeAsync(250));
      await settle();
    }

    it("keeps the results on screen and goes on until the index is built", async () => {
      vi.useFakeTimers();
      const second = deferred<MailSearchThreadPage>();
      const searchThreads = vi
        .fn()
        .mockResolvedValueOnce(building)
        .mockImplementationOnce(() => second.promise)
        .mockResolvedValueOnce(building)
        .mockResolvedValue(searchThreadPage("inbox"));
      await searchLunch(makeClient({ searchThreads }));
      expect(document.body.textContent).toContain("Indexing cached mail");

      await quarterSecond();
      expect(searchThreads).toHaveBeenCalledTimes(2);
      // The re-read is out, and the results it will replace stay.
      expect(document.body.textContent).toContain("Lunch this Friday?");

      await act(async () => second.resolve(building));
      await settle();
      await quarterSecond();
      expect(searchThreads).toHaveBeenCalledTimes(3);
      await quarterSecond();
      expect(searchThreads).toHaveBeenCalledTimes(4);
      expect(document.body.textContent).not.toContain("Indexing cached mail");

      // Built: nothing is left to re-read.
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      await settle();
      expect(searchThreads).toHaveBeenCalledTimes(4);
    });

    it("says the Inbox couldn't load when a re-read fails", async () => {
      vi.useFakeTimers();
      const searchThreads = vi
        .fn()
        .mockResolvedValueOnce(building)
        .mockRejectedValueOnce(new Error("offline"));
      await searchLunch(makeClient({ searchThreads }));

      await quarterSecond();
      expect(searchThreads).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("Inbox couldn’t load");
    });
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

    await act(async () => vi.advanceTimersByTimeAsync(MAIL_SAFETY_REFRESH_MS));
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
            // A type the reader cannot preview, so it stays the download chip.
            filename: "report.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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
    const download = document.body.querySelector('a[download="report.docx"]') as HTMLAnchorElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("script-src 'none'");
    expect(download.getAttribute("href")).toBe(
      `/api/mail/attachments/attachment-a33333333333333333333333333333333?accountId=${accountA.accountId}`,
    );
    expect(document.body.textContent).toContain("2 KB");
  });

  it("hands the window to an attachment viewer, and the list keys go quiet under it", async () => {
    // The picture's download answers only by being aborted: this test is
    // about the window, and a tile still waiting stays a tile. It honours the
    // abort so the slot it holds in the shared gate comes back afterwards.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    const client = makeClient({
      requestMessageContent: vi.fn().mockResolvedValue({
        ...readyContent,
        attachments: [
          {
            attachmentId: "attachment-a44444444444444444444444444444444",
            filename: "photo.png",
            mimeType: "image/png",
            disposition: "attachment",
            contentId: null,
            bytes: 2_048,
          },
        ],
      }),
    });
    const onSheetOpenChange = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface
          client={client}
          onOpenSettings={() => {}}
          onSheetOpenChange={onSheetOpenChange}
        />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(false);

    await click(findButton("photo.png, 2 KB"));
    expect(document.body.querySelector('[role="dialog"] h2')?.textContent).toBe("photo.png");
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(true);

    // `u` would mark the letter under the picture unread, and `e` archive it.
    vi.mocked(client.updateThread).mockClear();
    for (const key of ["u", "e", "s"]) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
      });
    }
    await settle();
    expect(client.updateThread).not.toHaveBeenCalled();

    await click(findButton("Close"));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(false);

    // And the guard lets go with the viewer: `e` archives again.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", cancelable: true }));
    });
    await settle();
    expect(client.updateThread).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "thread-1", archive: true }),
    );
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

    expect(
      document.body.querySelector('[role="dialog"][aria-label="Forward"]'),
    ).not.toBeNull();
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

  it("moves the letter to another account from the From menu, keeping the fields and deleting the old draft", async () => {
    vi.useFakeTimers();
    const client = makeClient({
      loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount(accountA);
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement,
      "ben@example.test",
    );
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Moving house",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    expect(client.createDraft).toHaveBeenCalledTimes(1);
    const first = vi.mocked(client.createDraft).mock.calls[0]?.[0];
    expect(first?.accountId).toBe(accountA.accountId);

    const trigger = document.body.querySelector<HTMLButtonElement>(
      '.brain-compose-from button[aria-label^="From:"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await settle();
    const row = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.includes(accountB.emailAddress),
    );
    expect(row).toBeDefined();
    await click(row!);
    await settle();

    // The old draft leaves the provider, so Drafts never lists a letter the
    // writer moved; the new one is created in the other account with what was
    // typed, and the sheet shows the same words under the new From.
    expect(client.deleteDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: first?.draftId, accountId: accountA.accountId }),
    );
    await vi.waitFor(() => expect(client.createDraft).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.createDraft).mock.calls[1]?.[0]).toMatchObject({
      accountId: accountB.accountId,
      to: "ben@example.test",
      text: "Moving house",
    });
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Moving house");
    expect(
      document.body.querySelector(".brain-compose-from")?.textContent,
    ).toContain(accountB.emailAddress);
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

  /** A letter shown from All Mail, or any folder but Inbox, Spam and Trash,
   *  had no way back to the Inbox. The client here is server truth: Archive
   *  and Move to Inbox change what the next read and the next Inbox list
   *  say. */
  describe("Move to Inbox", () => {
    function inboxTruthClient(overrides: Partial<MailSurfaceClient> = {}) {
      let inInbox = false;
      const updateThread = vi.fn().mockImplementation(async (input) => {
        if ("archive" in input) inInbox = !input.archive;
      });
      const letter = (): MailThreadDetail => ({
        ...detail,
        messages: detail.messages.map((message) => ({ ...message, inInbox })),
      });
      const client = makeClient({
        updateThread,
        listThreads: vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve({
            ...threadPage,
            items: inInbox && accountId === thread.accountId ? [thread] : [],
          }),
        ),
        searchThreads: vi.fn().mockImplementation(({ mailboxId }) =>
          Promise.resolve(
            searchThreadPage(
              mailboxId,
              inInbox || mailboxId !== "inbox" ? [thread] : [],
            ),
          ),
        ),
        readThread: vi.fn().mockImplementation(() => Promise.resolve(letter())),
        readMailboxThread: vi
          .fn()
          .mockImplementation(() => Promise.resolve(letter())),
        ...overrides,
      });
      return { client, updateThread };
    }

    function readerButtons(): string[] {
      const reader = document.body.querySelector(
        'section[aria-label="Message reader"]',
      );
      return [...(reader?.querySelectorAll("button") ?? [])].map(
        (button) => button.textContent?.trim() ?? "",
      );
    }

    function threadList(): string {
      return (
        document.body.querySelector('section[aria-label="Mailbox"]')?.textContent ?? ""
      );
    }

    type Pill = ToastOptions & { onAction: () => Promise<unknown> };

    function readerButton(label: string): HTMLButtonElement {
      const reader = document.body.querySelector(
        'section[aria-label="Message reader"]',
      );
      const found = [...(reader?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === label,
      );
      if (!(found instanceof HTMLButtonElement)) {
        throw new Error(`No reader button: ${label}`);
      }
      return found;
    }

    async function movedFromAllMail(
      client: MailSurfaceClient,
      accounts: readonly PublicMailAccount[] = [accountA],
      onToast = vi.fn(),
    ) {
      vi.mocked(client.loadAccounts).mockResolvedValue([...accounts]);
      await act(async () =>
        root.render(
          <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
        ),
      );
      await settle();
      await enterSingleAccount();
      await goTo("All Mail");
      await click(findButton("Lunch this Friday?"));
      expect(readerButtons()).toContain("Move to Inbox");
      await click(findButton("Move to Inbox"));
      const [title, pill] = onToast.mock.calls.at(-1)!;
      expect(title).toBe("Moved to Inbox");
      return pill as Pill;
    }

    it("moves the letter back with an Undo that archives it again", async () => {
      const { client, updateThread } = inboxTruthClient();
      const pill = await movedFromAllMail(client);

      expect(updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        archive: false,
      });
      expect(pill).toMatchObject({
        icon: "inbox-linear",
        actionLabel: "Undo",
        durationMs: SMART_UNDO_MS,
      });
      // In the Inbox now: the letter stays open, and its way out is the
      // Inbox's own.
      expect(readerButtons()).not.toContain("Move to Inbox");
      expect(readerButtons()).toContain("Archive");
      expect(
        document.body.querySelector('section[aria-label="Message reader"]')
          ?.textContent,
      ).toContain("Lunch this Friday?");

      await act(async () => {
        await pill.onAction();
      });
      await settle();

      expect(updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        archive: true,
      });
      // Out of the Inbox again, and the reader on it says so.
      expect(readerButtons()).toContain("Move to Inbox");
    });

    it("refuses Undo while another mail action is still going out", async () => {
      const star = deferred<void>();
      const { client, updateThread } = inboxTruthClient();
      const settled = updateThread.getMockImplementation()!;
      updateThread.mockImplementation((input) =>
        "starred" in input ? star.promise : settled(input),
      );
      const pill = await movedFromAllMail(client);
      await act(async () => {
        findButton("More mail actions").dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      await settle();
      await click(findMenuItem("Star"));

      // The pill keeps standing and its press can be made again.
      expect(pill.onAction()).toBe(false);
      expect(updateThread).not.toHaveBeenCalledWith(
        expect.objectContaining({ archive: true }),
      );
      await act(async () => star.resolve());
    });

    it("archives the letter again from the strip, and the strip offers the way back", async () => {
      const { client, updateThread } = inboxTruthClient();
      const onToast = vi.fn();
      await movedFromAllMail(client, [accountA], onToast);

      await click(readerButton("Archive"));
      await settle();

      expect(updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        archive: true,
      });
      expect(onToast).toHaveBeenLastCalledWith("Conversation archived");
      // All Mail still lists it, so the reader stays on it.
      expect(
        document.body.querySelector('section[aria-label="Message reader"]')
          ?.textContent,
      ).toContain("Lunch this Friday?");
      expect(readerButtons()).toContain("Move to Inbox");
      expect(readerButtons()).not.toContain("Archive");
    });

    it("moves the letter once for a held e, not back and forth with the key repeat", async () => {
      const { client, updateThread } = inboxTruthClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("All Mail");
      await click(findButton("Lunch this Friday?"));

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", cancelable: true }));
      });
      await settle();
      // The key is still down: the repeats that follow are not presses.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "e", repeat: true, cancelable: true }),
        );
      });
      await settle();

      expect(updateThread.mock.calls.map(([input]) => input.archive)).toEqual([false]);
    });

    it("runs Move to Inbox from e where the letter is out of the Inbox", async () => {
      const { client, updateThread } = inboxTruthClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("All Mail");
      await click(findButton("Lunch this Friday?"));

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", cancelable: true }));
      });
      await settle();

      expect(updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        archive: false,
      });

      // In the Inbox now, and the same key takes it out again.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", cancelable: true }));
      });
      await settle();

      expect(updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
        archive: true,
      });
      expect(readerButtons()).toContain("Move to Inbox");
    });

    it("takes the row out of the Inbox the reader went to when Undo is pressed there", async () => {
      const { client } = inboxTruthClient();
      const pill = await movedFromAllMail(client);
      await goTo("Inbox");
      expect(threadList()).toContain("Lunch this Friday?");

      await act(async () => {
        await pill.onAction();
      });
      await settle();

      expect(threadList()).not.toContain("Lunch this Friday?");
    });

    it("takes the row out of All inboxes when Undo is pressed there", async () => {
      const { client } = inboxTruthClient();
      const pill = await movedFromAllMail(client, [accountA, accountB]);
      await goTo("All inboxes");
      // The letter is read, so it stands in the Seen bundle rather than as a
      // row of its own: the column's one thread is it.
      expect(threadList()).not.toContain("Inbox zero");

      await act(async () => {
        await pill.onAction();
      });
      await settle();

      expect(threadList()).toContain("Inbox zero");
    });

    it("lets go of the unread-first hold when Undo closes the letter it held", async () => {
      // The letter came back to the Inbox unread and was opened there under
      // Unread first, so its read held the row in place. Undo takes it out
      // and closes it, and the hold goes with it: the next letter opened is
      // not a hold to settle.
      let inInbox = false;
      let unread = false;
      const other = {
        ...thread,
        threadId: "thread-other",
        subject: "Another letter",
        lastMessageAt: thread.lastMessageAt - 1_000,
      };
      const moved = () => ({ ...thread, unread });
      const letterFor = (threadId: string): MailThreadDetail => ({
        ...detail,
        thread: threadId === other.threadId ? other : moved(),
        messages: detail.messages.map((message) => ({
          ...message,
          threadId,
          inInbox: threadId === other.threadId || inInbox,
        })),
      });
      const updateThread = vi.fn().mockImplementation(async (input) => {
        if ("archive" in input) inInbox = !input.archive;
        if ("read" in input) unread = !input.read;
      });
      const listThreads = vi.fn().mockImplementation(({ accountId }) =>
        Promise.resolve({
          ...threadPage,
          items:
            accountId === thread.accountId
              ? [...(inInbox ? [moved()] : []), other]
              : [],
        }),
      );
      const client = makeClient({
        updateThread,
        listThreads,
        listMailboxThreads: vi
          .fn()
          .mockImplementation(({ mailboxId }) =>
            Promise.resolve(mailboxThreadPage(mailboxId, [moved(), other])),
          ),
        readThread: vi
          .fn()
          .mockImplementation(({ threadId }) => Promise.resolve(letterFor(threadId))),
        readMailboxThread: vi
          .fn()
          .mockImplementation(({ threadId }) => Promise.resolve(letterFor(threadId))),
      });
      const onToast = vi.fn();
      await act(async () =>
        root.render(
          <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
        ),
      );
      await settle();
      await enterSingleAccount();
      await goTo("All Mail");
      await click(rowButton("Lunch this Friday?"));
      await click(readerButton("Move to Inbox"));
      const pill = onToast.mock.calls.at(-1)![1] as Pill;
      await click(readerButton("Mark unread"));
      expect(unread).toBe(true);

      await goTo("Inbox");
      await act(async () => {
        findButton("Sort: Date").dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      await settle();
      await click(findMenuItem("Unread first"));
      await click(rowButton("Lunch this Friday?"));
      await settle();
      expect(unread).toBe(false);

      await act(async () => {
        await pill.onAction();
      });
      await settle();
      expect(
        document.body.querySelector('section[aria-label="Message reader"]')
          ?.textContent,
      ).toContain("Choose a message");
      const reads = listThreads.mock.calls.length;

      await click(rowButton("Another letter"));
      await settle();
      expect(listThreads.mock.calls.length).toBe(reads);
    });

    it("takes a letter from deep in All inboxes out when Undo is pressed there", async () => {
      // The letter sits past page one of its account's stream. Page one's
      // re-read keeps a deep stream's older rows, so only taking the row out
      // takes it off the column.
      let inInbox = false;
      const letter = { ...thread, lastMessageAt: 1_000 };
      const newer = Array.from({ length: 50 }, (_value, index) => ({
        ...thread,
        threadId: `newer-${index}`,
        subject: `Newer ${index}`,
        unread: true,
        lastMessageAt: 1_700_000_000_000 - index,
      }));
      const updateThread = vi.fn().mockImplementation(async (input) => {
        if ("archive" in input) inInbox = !input.archive;
      });
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        updateThread,
        listThreads: vi.fn().mockImplementation(({ accountId, cursor }) =>
          Promise.resolve(
            accountId !== accountA.accountId
              ? { ...threadPage, items: [], nextCursor: null }
              : cursor
                ? { ...threadPage, items: inInbox ? [letter] : [], nextCursor: null }
                : { ...threadPage, items: newer, nextCursor: "a-page-2" },
          ),
        ),
        listMailboxThreads: vi
          .fn()
          .mockImplementation(({ mailboxId }) =>
            Promise.resolve({ ...mailboxThreadPage(mailboxId), items: [letter] }),
          ),
        readMailboxThread: vi.fn().mockImplementation(() =>
          Promise.resolve({
            ...detail,
            thread: letter,
            messages: detail.messages.map((message) => ({ ...message, inInbox })),
          }),
        ),
      });
      const onToast = vi.fn();
      await act(async () =>
        root.render(
          <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
        ),
      );
      await settle();
      await enterSingleAccount();
      await goTo("All Mail");
      await click(findButton("Lunch this Friday?"));
      await click(findButton("Move to Inbox"));
      const pill = onToast.mock.calls.at(-1)![1] as Pill;

      await goTo("All inboxes");
      await click(findButton("Load more"));
      // The letter is read, so it is Seen's one thread.
      expect(document.body.textContent).toContain("1 thread, nothing unread");

      await act(async () => {
        await pill.onAction();
      });
      await settle();
      await settle();

      expect(updateThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ archive: true }),
      );
      expect(document.body.textContent).not.toContain("1 thread, nothing unread");
    });

    function rowButton(subject: string): HTMLButtonElement {
      const row = [
        ...document.body.querySelectorAll('section[aria-label="Mailbox"] button'),
      ].find((candidate) => candidate.textContent?.includes(subject));
      if (!(row instanceof HTMLButtonElement)) throw new Error(`No row: ${subject}`);
      return row;
    }

    it("closes the letter open in the Inbox when Undo takes it out again", async () => {
      const { client } = inboxTruthClient();
      const pill = await movedFromAllMail(client);
      await goTo("Inbox");
      await click(rowButton("Lunch this Friday?"));
      expect(readerButtons()).toContain("Archive");

      await act(async () => {
        await pill.onAction();
      });
      await settle();

      // As Archive leaves it: the letter is gone from the folder on screen,
      // and so is the reader that showed it there.
      expect(threadList()).not.toContain("Lunch this Friday?");
      expect(
        document.body.querySelector('section[aria-label="Message reader"]')
          ?.textContent,
      ).toContain("Choose a message");
    });

    it("re-reads an Inbox that was still loading when Undo landed", async () => {
      const { client } = inboxTruthClient();
      const pill = await movedFromAllMail(client);
      // The Inbox is read while the letter is in it, and the answer lands
      // only after Undo took it out again.
      const listThreads = vi.mocked(client.listThreads);
      const read = listThreads.getMockImplementation()!;
      const landing = deferred<void>();
      listThreads.mockImplementationOnce(async (input, signal) => {
        const page = await read(input, signal);
        await landing.promise;
        return page;
      });
      await goTo("Inbox");

      await act(async () => {
        await pill.onAction();
      });
      await settle();
      await act(async () => landing.resolve());
      await settle();
      await settle();

      expect(threadList()).not.toContain("Lunch this Friday?");
    });

    it("searches the Inbox again when Undo lands on its results", async () => {
      const { client } = inboxTruthClient();
      const pill = await movedFromAllMail(client);
      await goTo("Inbox");
      await setInput(
        document.body.querySelector('input[aria-label="Search mail"]') as HTMLInputElement,
        "Lunch",
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
      await settle();
      expect(threadList()).toContain("Lunch this Friday?");

      await act(async () => {
        await pill.onAction();
      });
      await settle();

      expect(threadList()).not.toContain("Lunch this Friday?");
    });

    /** The Inbox's search results, with the letter Move to Inbox put there. */
    async function searchedInbox(client: MailSurfaceClient) {
      const pill = await movedFromAllMail(client);
      await goTo("Inbox");
      await setInput(
        document.body.querySelector('input[aria-label="Search mail"]') as HTMLInputElement,
        "Lunch",
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
      await settle();
      expect(threadList()).toContain("Lunch this Friday?");
      return pill;
    }

    it("keeps the results on screen while the quiet search after Undo is out", async () => {
      const { client } = inboxTruthClient();
      const pill = await searchedInbox(client);
      const again = deferred<MailSearchThreadPage>();
      vi.mocked(client.searchThreads).mockImplementationOnce(() => again.promise);

      await act(async () => {
        await pill.onAction();
      });
      await settle();

      // Nobody asked to watch this search run: no skeleton stands in for it.
      expect(threadList()).toContain("Lunch this Friday?");
      await act(async () => again.resolve(searchThreadPage("inbox", [])));
      await settle();
      expect(threadList()).not.toContain("Lunch this Friday?");
    });

    it("keeps re-reading an index still building when the quiet search after Undo fails", async () => {
      // The Inbox's index is still building, so its results are re-read in the
      // background every quarter second. Undo's quiet search starts while one
      // of those reads is out, which drops that read's answer, and then fails.
      // The re-reads have to go on until the index is built.
      const { client } = inboxTruthClient();
      let calls = 0;
      const background = deferred<MailSearchThreadPage>();
      const results = (
        mailboxId: MailSystemMailbox,
        indexStatus: MailSearchThreadPage["indexStatus"],
      ): MailSearchThreadPage => ({
        ...searchThreadPage(mailboxId, [thread]),
        indexStatus,
      });
      vi.mocked(client.searchThreads).mockImplementation(({ mailboxId }) => {
        calls += 1;
        if (calls === 2) return background.promise;
        if (calls === 3) return Promise.reject(new Error("offline"));
        return Promise.resolve(results(mailboxId, calls < 5 ? "building" : "ready"));
      });
      const pill = await searchedInbox(client);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
      await settle();
      expect(calls).toBe(2);
      expect(threadList()).toContain("Indexing cached mail");

      await act(async () => {
        await pill.onAction();
      });
      await settle();
      expect(calls).toBe(3);
      await act(async () => background.resolve(results("inbox", "building")));
      await settle();
      for (let step = 0; step < 10; step += 1) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
        await settle();
      }

      expect(calls).toBeGreaterThanOrEqual(5);
      expect(threadList()).not.toContain("Indexing cached mail");
    });

    it("keeps the results when the quiet search after Undo fails", async () => {
      const { client } = inboxTruthClient();
      const pill = await searchedInbox(client);
      vi.mocked(client.searchThreads).mockRejectedValueOnce(new Error("offline"));

      await act(async () => {
        await pill.onAction();
      });
      await settle();

      // A quiet refresh that fails leaves the list usable, as the unsearched
      // list's does.
      expect(threadList()).not.toContain("couldn’t load");
      expect(threadList()).toContain("Lunch this Friday?");
    });
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

  it("keeps a single account's loaded depth when a mail event refreshes page one", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const deep = {
      ...thread,
      threadId: "thread-deep",
      subject: "Deep row from page two",
      lastMessageAt: 1_600_000_000_000,
    };
    const arrived = {
      ...thread,
      threadId: "thread-arrived",
      subject: "A letter that just arrived",
      lastMessageAt: 1_700_000_100_000,
    };
    let landed = false;
    const listThreads = vi.fn().mockImplementation((input) =>
      Promise.resolve(
        input.cursor === "cursor-1"
          ? { ...threadPage, items: [deep], nextCursor: null }
          : {
              ...threadPage,
              items: landed ? [arrived, thread] : [thread],
              nextCursor: "cursor-1",
            },
      ),
    );
    const client = makeClient({ listThreads });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Load more"));
    expect(document.body.textContent).toContain("Deep row from page two");

    // The echo of the owner's own action, or a sync that brought a letter.
    landed = true;
    await mailEvent({
      kind: "mail",
      changeKind: "mutation",
      accountId: accountA.accountId,
      mailboxIds: ["inbox", "all", "sent", "starred", "spam", "trash"],
    });
    await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
    await settle();
    expect(listThreads).toHaveBeenCalledTimes(3);
    // Each row once, in the server's order: the fresh head, then what was
    // loaded below it.
    const list = document.body.querySelector('section[aria-label="Mailbox"]') as HTMLElement;
    expect(
      list.textContent?.match(/A letter that just arrived|Lunch this Friday\?|Deep row from page two/g),
    ).toEqual(["A letter that just arrived", "Lunch this Friday?", "Deep row from page two"]);
    // Loaded to the end, it stays at the end: no Load more comes back.
    expect(() => findButton("Load more")).toThrow();
  });

  it("reads again once the list's own load lands when a mail event came while it was out", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const first = deferred<MailThreadPage>();
    let calls = 0;
    const listThreads = vi.fn().mockImplementation(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve(threadPage);
    });
    const client = makeClient({ listThreads });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    expect(listThreads).toHaveBeenCalledTimes(1);
    // The mount's read left before the letter; the event arrives while it is out.
    await mailEvent({
      kind: "mail",
      changeKind: "sync",
      accountId: accountA.accountId,
      mailboxIds: ["inbox", "all"],
    });
    await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
    await act(async () => first.resolve(threadPage));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await settle();
    expect(listThreads).toHaveBeenCalledTimes(2);
  });

  it("runs one more read after the one out when an event arrives during it, never two at once", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const second = deferred<MailThreadPage>();
    let calls = 0;
    const listThreads = vi.fn().mockImplementation(() => {
      calls += 1;
      return calls === 2 ? second.promise : Promise.resolve(threadPage);
    });
    const client = makeClient({ listThreads });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    const event = {
      kind: "mail",
      changeKind: "sync",
      accountId: accountA.accountId,
      mailboxIds: ["inbox"],
    } as const;
    await mailEvent(event);
    await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
    expect(listThreads).toHaveBeenCalledTimes(2);
    await mailEvent(event);
    await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
    expect(listThreads).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(threadPage));
    await settle();
    expect(listThreads).toHaveBeenCalledTimes(3);
  });

  it("reads the list once a mail action that held it lands, when an event came during the action", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const pendingUpdate = deferred<void>();
    const client = makeClient({
      updateThread: vi.fn().mockImplementation(() => pendingUpdate.promise),
    });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    await click(findButton("Mark unread"));
    const before = vi.mocked(client.listThreads).mock.calls.length;
    await mailEvent({
      kind: "mail",
      changeKind: "sync",
      accountId: accountA.accountId,
      mailboxIds: ["inbox"],
    });
    await act(async () => vi.advanceTimersByTimeAsync(3 * MAIL_EVENT_DEBOUNCE_MS));
    expect(vi.mocked(client.listThreads).mock.calls.length).toBe(before);
    await act(async () => pendingUpdate.resolve());
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
    await settle();
    // The action reads page one once of its own; the event's read follows it
    // once the lock lets go, and only once.
    expect(vi.mocked(client.listThreads).mock.calls.length - before).toBe(2);
  });

  it("brings the open letter up to date when the tab comes back, and on the safety net", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const readThread = vi.fn().mockResolvedValue(detail);
    const client = makeClient({ readThread });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    expect(readThread).toHaveBeenCalledTimes(1);

    // A reply lands while the tab is hidden, and its event is let pass.
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await mailEvent({
      kind: "mail",
      changeKind: "sync",
      accountId: accountA.accountId,
      mailboxIds: ["inbox", "all"],
    });
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(readThread).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(MAIL_SAFETY_REFRESH_MS));
    await settle();
    expect(readThread).toHaveBeenCalledTimes(3);
  });

  describe("a refresh folded into a list loaded past page one", () => {
    /** Row `n` of a numbered list, newest first. */
    function row(n: number, lastMessageAt = 1_700_000_000_000 - n * 1_000) {
      return {
        ...thread,
        threadId: `row-${String(n).padStart(2, "0")}`,
        subject: `Row ${String(n).padStart(2, "0")}`,
        lastMessageAt,
      };
    }
    const inboxEvent = {
      kind: "mail",
      changeKind: "sync",
      accountId: accountA.accountId,
      mailboxIds: ["inbox", "all"],
    } as const;
    /** The rows on screen, in the order drawn. Every one exactly once. */
    function shownRows(): number[] {
      return (document.body.textContent?.match(/Row \d\d/g) ?? []).map((text) =>
        Number(text.slice(-2)),
      );
    }

    it("keeps the rows between when a deep thread moves to the head", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let answered = false;
      const listThreads = vi.fn().mockImplementation((input) => {
        if (input.cursor === "c1") {
          return Promise.resolve({
            ...threadPage,
            items: [4, 5, 6, 7].map((n) => row(n)),
            nextCursor: "c2",
          });
        }
        if (input.cursor === "c2") {
          return Promise.resolve({ ...threadPage, items: [row(8)], nextCursor: null });
        }
        return Promise.resolve(
          answered
            ? {
                ...threadPage,
                items: [row(6, 1_800_000_000_000), row(1), row(2)],
                nextCursor: "cX",
              }
            : { ...threadPage, items: [1, 2, 3].map((n) => row(n)), nextCursor: "c1" },
        );
      });
      const client = makeClient({ listThreads });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await click(findButton("Load more"));
      expect(shownRows()).toEqual([1, 2, 3, 4, 5, 6, 7]);

      // Row 06, on page two, is answered: the server's list is now
      // 06 01 02 03 04 05 07 | 08.
      answered = true;
      await mailEvent(inboxEvent);
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      await settle();
      expect(shownRows()).toEqual([6, 1, 2, 3, 4, 5, 7]);

      await click(findButton("Load more"));
      expect(shownRows()).toEqual([6, 1, 2, 3, 4, 5, 7, 8]);
    });

    it("walks on from a mailbox's fresh cursor instead of keeping one a sync has made stale", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      // The cache's rule: a mailbox cursor carries the snapshot's history id,
      // and any history advance makes it stale, which the service answers
      // with 409 mail_sync_in_progress.
      let history = 1;
      const all = Array.from({ length: 9 }, (_value, index) => row(index + 1));
      const listMailboxThreads = vi.fn().mockImplementation(({ mailboxId, cursor }) => {
        let offset = 0;
        if (cursor) {
          const [at, position] = String(cursor).split(":");
          if (Number(at) !== history) {
            return Promise.reject(new MailApiError(409, "mail_sync_in_progress"));
          }
          offset = Number(position);
        }
        const items = all.slice(offset, offset + 3);
        const end = offset + items.length;
        return Promise.resolve({
          ...mailboxThreadPage(mailboxId, items),
          nextCursor: end < all.length ? `${history}:${end}` : null,
        });
      });
      const onToast = vi.fn();
      const client = makeClient({ listMailboxThreads });
      await act(async () =>
        root.render(
          <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
        ),
      );
      await settle();
      await enterSingleAccount();
      await goTo("Sent");
      await settle();
      await click(findButton("Load more"));
      expect(shownRows()).toEqual([1, 2, 3, 4, 5, 6]);

      // The owner sends a letter: the sync advances history and names Sent.
      history = 2;
      await mailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: accountA.accountId,
        mailboxIds: ["sent", "all"],
      });
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      await settle();
      await click(findButton("Load more"));
      await settle();

      expect(onToast).not.toHaveBeenCalledWith("More messages couldn’t load.");
      expect(shownRows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      // The cursor the sync made stale is never asked for again.
      const cursors = listMailboxThreads.mock.calls.map(([input]) => input.cursor ?? "p1");
      expect(cursors.filter((cursor) => cursor === "1:6")).toEqual([]);
    });

    it("heals a Load more the service calls stale by reading page one again and walking on", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let history = 1;
      const all = Array.from({ length: 9 }, (_value, index) => row(index + 1));
      const listMailboxThreads = vi.fn().mockImplementation(({ mailboxId, cursor }) => {
        let offset = 0;
        if (cursor) {
          const [at, position] = String(cursor).split(":");
          if (Number(at) !== history) {
            return Promise.reject(new MailApiError(409, "mail_sync_in_progress"));
          }
          offset = Number(position);
        }
        const items = all.slice(offset, offset + 3);
        const end = offset + items.length;
        return Promise.resolve({
          ...mailboxThreadPage(mailboxId, items),
          nextCursor: end < all.length ? `${history}:${end}` : null,
        });
      });
      const onToast = vi.fn();
      const client = makeClient({ listMailboxThreads });
      await act(async () =>
        root.render(
          <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
        ),
      );
      await settle();
      await enterSingleAccount();
      await goTo("Sent");
      await settle();
      await click(findButton("Load more"));
      // A sync moves history with no event for this tab to hear.
      history = 2;
      await click(findButton("Load more"));
      await settle();

      expect(onToast).not.toHaveBeenCalled();
      expect(shownRows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("lets a deep letter read under the Unread view go when the hold releases", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const unread = new Map(
        Array.from({ length: 6 }, (_value, index) => [`pu-${index + 1}`, true]),
      );
      const rows = () =>
        Array.from({ length: 6 }, (_value, index) => ({
          ...thread,
          threadId: `pu-${index + 1}`,
          subject: `Unread ${index + 1}`,
          lastMessageAt: 1_700_000_000_000 - index * 1_000,
          unread: unread.get(`pu-${index + 1}`)!,
        }));
      const listThreads = vi.fn().mockImplementation((input) => {
        let items = rows();
        if (input.view === "unread") items = items.filter((item) => item.unread);
        const offset = input.cursor ? Number(String(input.cursor).slice(1)) : 0;
        return Promise.resolve({
          ...threadPage,
          items: items.slice(offset, offset + 3),
          nextCursor: offset + 3 < items.length ? `k${offset + 3}` : null,
        });
      });
      const readThread = vi.fn().mockImplementation(({ threadId }) =>
        Promise.resolve({
          ...detail,
          thread: rows().find((item) => item.threadId === threadId)!,
          messages: [],
        }),
      );
      const updateThread = vi.fn().mockImplementation(async (input) => {
        if ("read" in input) unread.set(input.threadId, input.read !== true);
      });
      const client = makeClient({ listThreads, readThread, updateThread });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("Unread");
      await settle();
      await click(findButton("Load more"));
      await click(findButton("Unread 5"));
      await settle();
      expect(updateThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "pu-5", read: true }),
      );
      // Moving on releases the hold: the read letter leaves the Unread view.
      await click(findButton("Unread 1"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      const list = document.body.querySelector('section[aria-label="Mailbox"]') as HTMLElement;
      expect(list.textContent).not.toContain("Unread 5");
      expect(list.textContent).toContain("Unread 6");
    });

    it("reads again once a Load more that was out fails, when its epoch dropped the refresh", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let arrived = false;
      const refresh = deferred<MailThreadPage>();
      const more = deferred<MailThreadPage>();
      let refreshHeld = false;
      const listThreads = vi.fn().mockImplementation((input) => {
        if (input.cursor) return more.promise;
        if (arrived && !refreshHeld) {
          refreshHeld = true;
          return refresh.promise;
        }
        return Promise.resolve({
          ...threadPage,
          items: arrived ? [row(0, 1_800_000_000_000), row(1)] : [row(1)],
          nextCursor: "c1",
        });
      });
      const client = makeClient({ listThreads });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      arrived = true;
      await mailEvent(inboxEvent);
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      // The owner reaches the end while the event's read is out.
      await act(async () => findButton("Load more").click());
      await act(async () =>
        refresh.resolve({
          ...threadPage,
          items: [row(0, 1_800_000_000_000), row(1)],
          nextCursor: "c1",
        }),
      );
      await settle();
      // Dropped, and the Load more is still out: nothing is read beside it.
      const beside = listThreads.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(listThreads.mock.calls.length).toBe(beside);

      // The Load more fails and changes nothing on screen; its landing is
      // what wakes the read the refresh still owes.
      await act(async () => more.resolve(Promise.reject(new Error("offline"))));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      expect(listThreads.mock.calls.length).toBe(beside + 1);
      expect(shownRows()).toEqual([0, 1]);
    });

    it("never reads page one beside a mailbox Load more that is out", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let arrived = false;
      const refresh = deferred<MailMailboxThreadPage>();
      const more = deferred<MailMailboxThreadPage>();
      let refreshHeld = false;
      const listMailboxThreads = vi.fn().mockImplementation(({ mailboxId, cursor }) => {
        if (cursor) return more.promise;
        if (arrived && !refreshHeld) {
          refreshHeld = true;
          return refresh.promise;
        }
        return Promise.resolve({
          ...mailboxThreadPage(
            mailboxId,
            arrived ? [row(0, 1_800_000_000_000), row(1)] : [row(1)],
          ),
          nextCursor: "c1",
        });
      });
      const client = makeClient({ listMailboxThreads });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("Sent");
      await settle();

      arrived = true;
      await mailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: accountA.accountId,
        mailboxIds: ["sent"],
      });
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      await act(async () => findButton("Load more").click());
      await act(async () =>
        refresh.resolve({
          ...mailboxThreadPage("sent", [row(0, 1_800_000_000_000), row(1)]),
          nextCursor: "c1",
        }),
      );
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      const beside = listMailboxThreads.mock.calls.length;

      await act(async () =>
        more.resolve({ ...mailboxThreadPage("sent", [row(2)]), nextCursor: null }),
      );
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      // The Load more kept its page, and the owed read followed it.
      expect(listMailboxThreads.mock.calls.length).toBe(beside + 1);
      expect(shownRows()).toEqual([0, 1, 2]);
    });
  });

  /* A single account's list against a cache whose cursors behave like
     message-cache.ts: keyset by the sort key, an Inbox cursor bound to the
     generation only, a mailbox cursor bound to generation and history, and a
     mismatch answered 409 mail_sync_in_progress. The review's round-3 probes,
     A to O, each a case here under its letter. */
  describe("a single account's list folded, walked and healed", () => {
    type FakeRow = {
      readonly n: number;
      readonly id: string;
      at: number;
      unread: boolean;
      boxes: Set<string>;
    };
    const pad = (n: number) => String(n).padStart(3, "0");
    function fakeRow(
      n: number,
      boxes: string[],
      options: { at?: number; unread?: boolean } = {},
    ): FakeRow {
      return {
        n,
        id: `r-${pad(n)}`,
        at: options.at ?? 1_700_000_000_000 - n * 1_000,
        unread: options.unread ?? false,
        boxes: new Set(boxes),
      };
    }
    function toItem(row: FakeRow): MailThreadListItem {
      return {
        ...thread,
        accountId: accountA.accountId,
        threadId: row.id,
        subject: `Row ${pad(row.n)}`,
        lastMessageAt: row.at,
        unread: row.unread,
      } as MailThreadListItem;
    }
    type Key = readonly (number | string)[];
    const keyOf = (sort: string, row: FakeRow): Key =>
      sort === "unread" ? [row.unread ? 1 : 0, row.at, row.id] : [row.at, row.id];
    /** All-descending lexicographic order: negative when `a` sorts first. */
    function cmpKey(a: Key, b: Key): number {
      for (let index = 0; index < a.length; index += 1) {
        if (a[index]! > b[index]!) return -1;
        if (a[index]! < b[index]!) return 1;
      }
      return 0;
    }
    function fakeCache(rows: FakeRow[], pageSize?: number) {
      const state = { rows, generation: 1, history: 1, latency: 0, bumpAfterRead: false };
      const reads: string[] = [];
      const answer = (box: string, input: Record<string, unknown>) => {
        const limit = pageSize ?? (input.limit as number);
        const view = (input.view as string | undefined) ?? null;
        const sort = (input.sort as string | undefined) ?? "date";
        let key: Key | null = null;
        if (typeof input.cursor === "string") {
          const cursor = JSON.parse(input.cursor) as {
            g: number;
            h: number | null;
            box: string;
            view: string | null;
            sort: string;
            key: Key;
          };
          if (
            cursor.g !== state.generation ||
            (box !== "inbox" && cursor.h !== state.history) ||
            cursor.box !== box ||
            cursor.view !== view ||
            cursor.sort !== sort
          ) {
            reads.push(`${box}:STALE`);
            throw new MailApiError(409, "mail_sync_in_progress");
          }
          key = cursor.key;
        }
        reads.push(`${box}:${key === null ? "p1" : String(key.at(-1))}`);
        let items = state.rows
          .filter((row) => row.boxes.has(box))
          .filter((row) => view !== "unread" || row.unread)
          .sort((a, b) => cmpKey(keyOf(sort, a), keyOf(sort, b)));
        if (key !== null) items = items.filter((row) => cmpKey(keyOf(sort, row), key!) > 0);
        const slice = items.slice(0, limit);
        const tail = slice.at(-1);
        const nextCursor =
          items.length > limit && tail
            ? JSON.stringify({
                g: state.generation,
                h: box === "inbox" ? null : state.history,
                box,
                view,
                sort,
                key: keyOf(sort, tail),
              })
            : null;
        if (state.bumpAfterRead && box !== "inbox") state.history += 1;
        return { items: slice.map(toItem), nextCursor };
      };
      const later = <T,>(work: () => T): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const run = () => {
            try {
              resolve(work());
            } catch (error) {
              reject(error);
            }
          };
          if (state.latency > 0) setTimeout(run, state.latency);
          else run();
        });
      const listThreads = vi.fn().mockImplementation((input: Record<string, unknown>) =>
        later(() => {
          const { items, nextCursor } = answer("inbox", input);
          return { ...threadPage, items, nextCursor } as MailThreadPage;
        }),
      );
      const listMailboxThreads = vi.fn().mockImplementation((input: Record<string, unknown>) =>
        later(() => {
          const box = input.mailboxId as MailSystemMailbox;
          const { items, nextCursor } = answer(box, input);
          return { ...mailboxThreadPage(box, items), nextCursor } as MailMailboxThreadPage;
        }),
      );
      const find = (id: string) => state.rows.find((row) => row.id === id)!;
      const readAny = vi.fn().mockImplementation(({ threadId }: { threadId: string }) =>
        Promise.resolve({ ...detail, thread: toItem(find(threadId)), messages: [] }),
      );
      const updateThread = vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
        const row = find(input.threadId as string);
        if ("read" in input) row.unread = input.read !== true;
      });
      return { state, reads, listThreads, listMailboxThreads, readAny, updateThread, find };
    }
    function listed(): number[] {
      const list = document.body.querySelector('section[aria-label="Mailbox"]');
      return (list?.textContent?.match(/Row \d{3}/g) ?? []).map((text) =>
        Number(text.slice(-3)),
      );
    }
    function loadMoreShown(): boolean {
      try {
        findButton("Load more");
        return true;
      } catch {
        return false;
      }
    }
    async function eventFor(mailboxIds: MailSystemMailbox[]) {
      await mailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: accountA.accountId,
        mailboxIds,
      });
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      await settle();
    }
    async function mountWith(
      cache: ReturnType<typeof fakeCache>,
      onToast?: (title: string, options?: ToastOptions) => void,
    ) {
      const client = makeClient({
        listThreads: cache.listThreads,
        listMailboxThreads: cache.listMailboxThreads,
        readThread: cache.readAny,
        readMailboxThread: cache.readAny,
        updateThread: cache.updateThread,
      });
      await act(async () =>
        root.render(
          <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
        ),
      );
      await settle();
      await enterSingleAccount();
      return client;
    }
    async function press() {
      await click(findButton("Load more"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
    }
    async function sortUnreadFirst() {
      await act(async () => {
        findButton("Sort: Date").dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      await settle();
      await click(findMenuItem("Unread first"));
      await settle();
    }
    const range = (a: number, b: number) =>
      Array.from({ length: b - a + 1 }, (_value, index) => a + index);

    /** Set when a case is over, so a long loop a timeout cut short stops at
     *  its next step, and the file's teardown, which waits for the case's
     *  body to end, does not wait out the whole loop. */
    let finished = { current: false };
    beforeEach(() => {
      finished = { current: false };
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    });
    afterEach(() => {
      finished.current = true;
    });

    it("A: a row archived elsewhere off page one does not come back below the fresh window (Inbox)", async () => {
      const cache = fakeCache(range(1, 6).map((n) => fakeRow(n, ["inbox", "all"])), 3);
      await mountWith(cache);
      expect(listed()).toEqual([1, 2, 3]);
      // Row 1 archived on the phone: the server's Inbox is 2 3 4 | 5 6.
      cache.find("r-001").boxes.delete("inbox");
      await eventFor(["inbox", "all"]);
      expect(listed()).toEqual([2, 3, 4]);
      await press();
      expect(listed()).toEqual([2, 3, 4, 5, 6]);
    });

    it("A2: no ghost survives later refreshes (Inbox)", async () => {
      const cache = fakeCache(range(1, 8).map((n) => fakeRow(n, ["inbox", "all"])), 3);
      await mountWith(cache);
      cache.find("r-001").boxes.delete("inbox");
      for (let index = 0; index < 4; index += 1) await eventFor(["inbox", "all"]);
      expect(listed()).not.toContain(1);
    });

    it("A3: a letter read on the phone leaves the Unread view", async () => {
      const cache = fakeCache(
        range(1, 6).map((n) => fakeRow(n, ["inbox", "all"], { unread: true })),
        3,
      );
      await mountWith(cache);
      await goTo("Unread");
      await settle();
      expect(listed()).toEqual([1, 2, 3]);
      cache.find("r-002").unread = false;
      await eventFor(["inbox", "all"]);
      expect(listed()).toEqual([1, 3, 4]);
    });

    it("A (none held): a fresh window with no row the list holds stands alone", async () => {
      const cache = fakeCache(range(1, 9).map((n) => fakeRow(n, ["inbox", "all"])), 3);
      await mountWith(cache);
      expect(listed()).toEqual([1, 2, 3]);
      for (const n of [1, 2, 3]) cache.find(`r-${pad(n)}`).boxes.delete("inbox");
      await eventFor(["inbox", "all"]);
      expect(listed()).toEqual([4, 5, 6]);
    });

    it("B: the heal of a stale Sent cursor does not bring a deleted row back", async () => {
      const onToast = vi.fn();
      const cache = fakeCache(range(1, 6).map((n) => fakeRow(n, ["sent", "all"])), 3);
      await mountWith(cache, onToast);
      await goTo("Sent");
      await settle();
      expect(listed()).toEqual([1, 2, 3]);
      // Row 1 deleted elsewhere; history moves; no event reaches this tab.
      cache.find("r-001").boxes.delete("sent");
      cache.state.history += 1;
      await press();
      expect(listed()).toEqual([2, 3, 4, 5, 6]);
      expect(onToast).not.toHaveBeenCalled();
    });

    it("C: every press after a refresh adds rows (Starred, 50-row pages)", async () => {
      const cache = fakeCache(range(1, 250).map((n) => fakeRow(n, ["starred", "all"])));
      await mountWith(cache);
      await goTo("Starred");
      await settle();
      await press();
      await press();
      await press();
      expect(listed().length).toBe(200);
      // An old letter starred on the phone joins Starred at its date, between
      // rows 60 and 61. History moves and Starred is named.
      cache.state.rows.push(
        fakeRow(999, ["starred", "all"], { at: 1_700_000_000_000 - 60_500 }),
      );
      cache.state.history += 1;
      await eventFor(["starred"]);
      const added: number[] = [];
      while (loadMoreShown()) {
        const before = listed().length;
        await press();
        added.push(listed().length - before);
      }
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((count) => count > 0)).toBe(true);
      expect(new Set(listed()).size).toBe(listed().length);
    });

    it("D: a press after a held letter's patch adds rows (Sent, unread-first)", async () => {
      const cache = fakeCache(
        range(1, 200).map((n) => fakeRow(n, ["sent", "all"], { unread: n === 1 })),
      );
      await mountWith(cache);
      await goTo("Sent");
      await settle();
      await sortUnreadFirst();
      await press();
      await press();
      expect(listed().length).toBe(150);
      cache.state.history += 1;
      await eventFor(["sent"]);
      // Row 1 is unread: opening it reads it, holds it and patches its row.
      await click(findButton("Row 001"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      expect(cache.updateThread).toHaveBeenCalled();
      const before = listed().length;
      await press();
      expect(listed().length).toBeGreaterThan(before);
    });

    it("E: a deep letter marked unread again stays in the Unread view when the hold releases", async () => {
      const cache = fakeCache(
        range(1, 6).map((n) => fakeRow(n, ["inbox", "all"], { unread: true })),
        3,
      );
      await mountWith(cache);
      await goTo("Unread");
      await settle();
      await press();
      expect(listed()).toEqual([1, 2, 3, 4, 5, 6]);
      await click(findButton("Row 005"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      expect(cache.find("r-005").unread).toBe(false);
      // The owner marks it unread again, then closes the letter.
      const reader = document.body.querySelector('section[aria-label="Message reader"]');
      const markUnread = [...(reader?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Mark unread",
      ) as HTMLButtonElement;
      await click(markUnread);
      await settle();
      expect(cache.find("r-005").unread).toBe(true);
      await click(findButton("Back to Inbox"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      expect(listed()).toContain(5);
    });

    it("F: under unread-first a deep letter read and released stays in the list (Inbox)", async () => {
      const T = 1_700_000_000_000;
      // Unread 1..4 at 100 90 80 70, read 5..8 at 95 60 40 30.
      const spec: [number, number, boolean][] = [
        [1, 100, true],
        [2, 90, true],
        [3, 80, true],
        [4, 70, true],
        [5, 95, false],
        [6, 60, false],
        [7, 40, false],
        [8, 30, false],
      ];
      const cache = fakeCache(
        spec.map(([n, at, unread]) =>
          fakeRow(n, ["inbox", "all"], { at: T + at * 1_000, unread }),
        ),
        3,
      );
      await mountWith(cache);
      await sortUnreadFirst();
      expect(listed()).toEqual([1, 2, 3]);
      await press();
      expect(listed()).toEqual([1, 2, 3, 4, 5, 6]);
      await click(findButton("Row 004"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      expect(cache.find("r-004").unread).toBe(false);
      await click(findButton("Back to Inbox"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      if (loadMoreShown()) await press();
      expect(listed()).toContain(4);
    });

    it("G: an Inbox Load more after a full resync heals (new generation)", async () => {
      const onToast = vi.fn();
      const cache = fakeCache(range(1, 12).map((n) => fakeRow(n, ["inbox", "all"])), 3);
      await mountWith(cache, onToast);
      await press();
      // A letter arrives: the refresh keeps the old Inbox cursor.
      cache.state.rows.push(fakeRow(0, ["inbox", "all"], { at: 1_800_000_000_000 }));
      await eventFor(["inbox", "all"]);
      expect(listed()).toEqual([0, 1, 2, 3, 4, 5, 6]);
      cache.state.generation += 1;
      await press();
      expect(onToast).not.toHaveBeenCalled();
      expect(listed()).toEqual(range(0, 8));
      await press();
      expect(listed()).toEqual(range(0, 11));
    });

    it("H: a sync that keeps moving costs each press at most three reads", async () => {
      const onToast = vi.fn();
      const cache = fakeCache(range(1, 9).map((n) => fakeRow(n, ["sent", "all"])), 3);
      await mountWith(cache, onToast);
      await goTo("Sent");
      await settle();
      cache.state.bumpAfterRead = true;
      const perPress: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        const before = cache.reads.length;
        await press();
        perPress.push(cache.reads.length - before);
      }
      const settled = cache.reads.length;
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(Math.max(...perPress)).toBeLessThanOrEqual(3);
      expect(cache.reads.length).toBe(settled);
    });

    it("I: a sync inside the walk says so once, keeps nothing twice, and the next press heals", async () => {
      const onToast = vi.fn();
      const cache = fakeCache(range(1, 250).map((n) => fakeRow(n, ["sent", "all"])));
      await mountWith(cache, onToast);
      await goTo("Sent");
      await settle();
      await press();
      await press();
      await press();
      expect(listed().length).toBe(200);
      cache.state.history += 1;
      await eventFor(["sent"]);
      const answer = cache.listMailboxThreads.getMockImplementation()!;
      let reads = 0;
      cache.listMailboxThreads.mockImplementation((input: Record<string, unknown>) => {
        reads += 1;
        const out = answer(input);
        if (reads === 1) cache.state.history += 1;
        return out;
      });
      await press();
      // The walk's own cursor went stale under it: one toast (accepted), and
      // nothing on screen twice.
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(new Set(listed()).size).toBe(listed().length);
      cache.listMailboxThreads.mockImplementation(answer);
      await press();
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(listed()).toEqual(range(1, 250));
    });

    for (const [latency, period] of [
      [150, 1_000],
      [60, 1_000],
      [60, 3_000],
    ] as const) {
      /* Everything runs on the fake clock in 100 ms steps: eight simulated
         seconds, four presses two seconds apart, over a list kept to 300
         rows. The runner's own speed only decides how long the steps take,
         and the explicit timeout leaves a slow runner room for them. */
      it(`J: every press is served with events every ${period} ms and ${latency} ms reads (50-row pages)`, async () => {
        const cache = fakeCache(range(1, 300).map((n) => fakeRow(n, ["sent", "all"])));
        await mountWith(cache);
        await goTo("Sent");
        await settle();
        await press();
        expect(listed().length).toBe(100);
        cache.state.history += 1;
        await eventFor(["sent"]);
        cache.state.latency = latency;
        let presses = 0;
        let served = 0;
        let waiting: number | null = null;
        for (let t = 0; t < 8_000; t += 100) {
          if (finished.current) return;
          if (t % period === 0) {
            await mailEvent({
              kind: "mail",
              changeKind: "sync",
              accountId: accountA.accountId,
              mailboxIds: ["sent"],
            });
          }
          if (t % 2_000 === 100) {
            if (waiting !== null && listed().length > waiting) served += 1;
            waiting = null;
            let button: HTMLButtonElement | null = null;
            try {
              button = findButton("Load more");
            } catch {
              // at the end
            }
            if (button) {
              presses += 1;
              waiting = listed().length;
              await act(async () => button!.click());
            }
          }
          await act(async () => vi.advanceTimersByTimeAsync(100));
        }
        if (waiting !== null && listed().length > waiting) served += 1;
        expect(presses).toBe(4);
        expect(served).toBe(presses);
        expect(new Set(listed()).size).toBe(listed().length);
      }, 20_000);
    }

    it("K: a walk over repeated cursors ends and stays bounded", async () => {
      // Twelve rows, so the list is not loaded to the end after two presses
      // and the refresh leaves it a cursor to walk from.
      const cache = fakeCache(range(1, 12).map((n) => fakeRow(n, ["sent", "all"])), 3);
      await mountWith(cache);
      await goTo("Sent");
      await settle();
      await press();
      await press();
      cache.state.history += 1;
      await eventFor(["sent"]);
      const answer = cache.listMailboxThreads.getMockImplementation()!;
      let loops = 0;
      cache.listMailboxThreads.mockImplementation(async (input: Record<string, unknown>) => {
        if (typeof input.cursor !== "string") return answer(input);
        loops += 1;
        return {
          ...mailboxThreadPage("sent", [toItem(cache.find("r-004"))]),
          nextCursor: loops % 2 === 0 ? "loop-a" : "loop-b",
        };
      });
      await press();
      expect(loops).toBeLessThanOrEqual(3);
    });

    it("K (cap): a walk over pages of known rows stops at the list's depth plus one", async () => {
      const cache = fakeCache(range(1, 12).map((n) => fakeRow(n, ["sent", "all"])), 3);
      await mountWith(cache);
      await goTo("Sent");
      await settle();
      await press();
      await press();
      expect(listed()).toEqual(range(1, 9));
      cache.state.history += 1;
      await eventFor(["sent"]);
      const answer = cache.listMailboxThreads.getMockImplementation()!;
      let walked = 0;
      cache.listMailboxThreads.mockImplementation(async (input: Record<string, unknown>) => {
        if (typeof input.cursor !== "string") return answer(input);
        walked += 1;
        // Every page brings a row the list holds, under a cursor never seen.
        return {
          ...mailboxThreadPage("sent", [toItem(cache.find("r-004"))]),
          nextCursor: walked < 40 ? `walk-${walked}` : null,
        };
      });
      await press();
      // Nine rows are one 50-row page deep: two reads, not forty.
      expect(walked).toBe(2);
    });

    it("L: when fewer pages remain than the list is deep, the walk ends at the end", async () => {
      const cache = fakeCache(range(1, 9).map((n) => fakeRow(n, ["sent", "all"])), 3);
      await mountWith(cache);
      await goTo("Sent");
      await settle();
      await press();
      await press();
      for (const n of [6, 7, 8, 9]) cache.find(`r-${pad(n)}`).boxes.delete("sent");
      cache.state.history += 1;
      await eventFor(["sent"]);
      if (loadMoreShown()) await press();
      expect(loadMoreShown()).toBe(false);
      expect(new Set(listed()).size).toBe(listed().length);
    });

    it("M: a heal while an event refresh is out lands both, each row once", async () => {
      const onToast = vi.fn();
      const cache = fakeCache(range(1, 250).map((n) => fakeRow(n, ["sent", "all"])));
      await mountWith(cache, onToast);
      await goTo("Sent");
      await settle();
      await press();
      await press();
      expect(listed().length).toBe(150);
      cache.state.latency = 100;
      // A new letter sent; history moves; the event's refresh goes out ...
      cache.state.rows.push(fakeRow(0, ["sent", "all"], { at: 1_800_000_000_000 }));
      cache.state.history += 1;
      await mailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: accountA.accountId,
        mailboxIds: ["sent"],
      });
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS + 10));
      // ... and the owner presses Load more on the stale cursor while it is out.
      await act(async () => findButton("Load more").click());
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      await settle();
      const shown = listed();
      expect(new Set(shown).size).toBe(shown.length);
      expect(shown[0]).toBe(0);
      expect(shown.length).toBe(200);
    });

    it("M (seen): a row that moved between the heal's reads is on screen once", async () => {
      const cache = fakeCache(range(1, 12).map((n) => fakeRow(n, ["sent", "all"])), 3);
      await mountWith(cache);
      await goTo("Sent");
      await settle();
      await press();
      expect(listed()).toEqual(range(1, 6));
      // A letter lands at the head, history moves, and no event arrives.
      const moved = fakeRow(0, ["sent", "all"], { at: 1_800_000_000_000 });
      cache.state.rows.push(moved);
      cache.state.history += 1;
      const answer = cache.listMailboxThreads.getMockImplementation()!;
      cache.listMailboxThreads.mockImplementation(async (input: Record<string, unknown>) => {
        const out = await answer(input);
        // After the heal's page one, the new letter's date moves down among
        // rows the walk is about to read.
        if (typeof input.cursor !== "string") moved.at = 1_700_000_000_000 - 4_500;
        return out;
      });
      await press();
      expect(listed().filter((n) => n === 0)).toHaveLength(1);
      expect(new Set(listed()).size).toBe(listed().length);
    });

    it("N: a Sent list loaded to the end keeps no Load more after a refresh", async () => {
      const cache = fakeCache(range(1, 200).map((n) => fakeRow(n, ["sent", "all"])));
      await mountWith(cache);
      await goTo("Sent");
      await settle();
      for (let index = 0; index < 3; index += 1) await press();
      expect(listed().length).toBe(200);
      expect(loadMoreShown()).toBe(false);
      cache.state.history += 1;
      await eventFor(["sent"]);
      expect(loadMoreShown()).toBe(false);
    });

    it("O: a Load more heal keeps the held open letter where it stood (Sent, unread-first)", async () => {
      const cache = fakeCache(
        range(1, 9).map((n) => fakeRow(n, ["sent", "all"], { unread: n === 2 })),
        3,
      );
      await mountWith(cache);
      await goTo("Sent");
      await settle();
      await sortUnreadFirst();
      expect(listed()).toEqual([2, 1, 3]);
      await click(findButton("Row 002"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      expect(cache.find("r-002").unread).toBe(false);
      // The read's own sync moves history; no event reaches this tab yet.
      cache.state.history += 1;
      await press();
      expect(listed().indexOf(2)).toBe(0);
    });

    it("E (owed): a release that had to wait still lets the read letter go when it runs", async () => {
      const cache = fakeCache(
        range(1, 9).map((n) => fakeRow(n, ["inbox", "all"], { unread: true })),
        3,
      );
      await mountWith(cache);
      await goTo("Unread");
      await settle();
      await press();
      expect(listed()).toEqual(range(1, 6));
      await click(findButton("Row 005"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      expect(cache.find("r-005").unread).toBe(false);

      // A slow Load more is out when the letter is closed, so the release's
      // read waits; an event's read waits behind it too, owing no release of
      // its own.
      cache.state.latency = 1_000;
      await act(async () => findButton("Load more").click());
      await click(findButton("Back to Inbox"));
      await mailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: accountA.accountId,
        mailboxIds: ["inbox"],
      });
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      for (let step = 0; step < 4; step += 1) {
        await act(async () => vi.advanceTimersByTimeAsync(1_000));
        await settle();
      }
      expect(listed()).not.toContain(5);
      expect(listed()).toContain(9);
    });
  });

  it("refreshes page one once a burst of mail events for the list on screen settles", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    expect(client.listThreads).toHaveBeenCalledTimes(1);

    // Another account's change, another mailbox's and a ready body are not
    // this list's news.
    await mailEvent({
      kind: "mail",
      changeKind: "sync",
      accountId: accountB.accountId,
      mailboxIds: ["inbox"],
    });
    await mailEvent({
      kind: "mail",
      changeKind: "sync",
      accountId: accountA.accountId,
      mailboxIds: ["sent"],
    });
    await mailEvent({
      kind: "mail",
      changeKind: "content_ready",
      accountId: accountA.accountId,
      mailboxIds: [],
      messageIds: ["message-9"],
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(client.listThreads).toHaveBeenCalledTimes(1);

    await mailEvent({
      kind: "mail",
      changeKind: "sync",
      accountId: accountA.accountId,
      mailboxIds: ["inbox"],
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await mailEvent({
      kind: "mail",
      changeKind: "mutation",
      accountId: accountA.accountId,
      mailboxIds: ["inbox", "all"],
    });
    await act(async () => vi.advanceTimersByTimeAsync(399));
    expect(client.listThreads).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(client.listThreads).toHaveBeenCalledTimes(2);
    const [input] = vi.mocked(client.listThreads).mock.calls.at(-1)!;
    expect(input).toMatchObject({ accountId: accountA.accountId, limit: 50 });
    expect(input).not.toHaveProperty("cursor");
  });

  it("keeps a five-minute safety net instead of a tick every minute, and refreshes once on a reset", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const client = makeClient();
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();

    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000 - 1));
    await settle();
    expect(client.listThreads).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(client.listThreads).toHaveBeenCalledTimes(2);

    // The stream reconnected, or the loop lost its place: what is on screen
    // is read again once.
    await mailEvent({ kind: "mail", changeKind: "reset" });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await settle();
    expect(client.listThreads).toHaveBeenCalledTimes(3);
  });

  it("re-reads the open letter when its mailbox changed, and leaves it when the read fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const reply = {
      ...detail.messages[0]!,
      messageId: "message-2",
      from: { name: "Casey Lin", address: "casey@example.test" },
      sentAt: 1_700_000_100_000,
    };
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce({ ...detail, messages: [...detail.messages, reply] })
      .mockRejectedValueOnce(new Error("gone"));
    const client = makeClient({ readThread });
    await act(async () =>
      root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("Lunch this Friday?"));
    expect(readThread).toHaveBeenCalledTimes(1);

    await mailEvent({
      kind: "mail",
      changeKind: "sync",
      accountId: accountA.accountId,
      mailboxIds: ["inbox", "all"],
    });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await settle();
    expect(readThread).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Casey Lin");

    await mailEvent({
      kind: "mail",
      changeKind: "mutation",
      accountId: accountA.accountId,
      mailboxIds: ["inbox"],
    });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await settle();
    expect(readThread).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("Casey Lin");
  });

  it("fetches the body once the change feed says it is ready instead of waiting for the next poll", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const fetching = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "fetching" as const,
    };
    const getMessageContent = vi
      .fn()
      .mockResolvedValueOnce(fetching)
      .mockResolvedValue({ ...readyContent, textBody: "The body the feed announced." });
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
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await settle();
    expect(getMessageContent).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(100));
    // Another message's body is not this one's.
    await mailEvent({
      kind: "mail",
      changeKind: "content_ready",
      accountId: accountA.accountId,
      mailboxIds: [],
      messageIds: ["message-9"],
    });
    await settle();
    expect(getMessageContent).toHaveBeenCalledTimes(1);
    await mailEvent({
      kind: "mail",
      changeKind: "content_ready",
      accountId: accountA.accountId,
      mailboxIds: [],
      messageIds: ["message-9", "message-1"],
    });
    await settle();

    // Before the 300 ms poll would have asked.
    expect(getMessageContent).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("The body the feed announced.");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(getMessageContent).toHaveBeenCalledTimes(2);
  });

  it("asks at once after a read that was out when the body was announced", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const fetching = {
      apiVersion: 1 as const,
      accountId: accountA.accountId,
      messageId: "message-1",
      state: "fetching" as const,
    };
    const secondRead = deferred<MailMessageContent>();
    const getMessageContent = vi
      .fn()
      .mockResolvedValueOnce(fetching)
      .mockReturnValueOnce(secondRead.promise)
      .mockResolvedValue({ ...readyContent, textBody: "Announced while a read was out." });
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
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await settle();
    expect(getMessageContent).toHaveBeenCalledTimes(2);

    // The event lands while the second read is out, and that read answers
    // from before the commit.
    await mailEvent({
      kind: "mail",
      changeKind: "content_ready",
      accountId: accountA.accountId,
      mailboxIds: [],
      messageIds: ["message-1"],
    });
    await act(async () => secondRead.resolve(fetching));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await settle();

    // Not the 600 ms backoff: the next read goes straight out.
    expect(getMessageContent).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("Announced while a read was out.");
  });

  it("does not take another account's ready body for this message's", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
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
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await settle();
    expect(getMessageContent).toHaveBeenCalledTimes(1);

    // Message ids are the provider's, and two accounts can share one.
    await mailEvent({
      kind: "mail",
      changeKind: "content_ready",
      accountId: accountB.accountId,
      mailboxIds: [],
      messageIds: ["message-1"],
    });
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await settle();
    expect(getMessageContent).toHaveBeenCalledTimes(1);
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
      await vi.advanceTimersByTimeAsync(MAIL_SAFETY_REFRESH_MS);
    });
    await settle();
    expect(client.listThreads).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    // A hidden tab reads nothing, not on the net and not on an event: the
    // return to the tab reads it all once.
    await mailEvent({
      kind: "mail",
      changeKind: "sync",
      accountId: accountA.accountId,
      mailboxIds: ["inbox"],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * MAIL_SAFETY_REFRESH_MS);
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
      // From is the envelope's first row, label and value in their own spans.
      expect(
        document.body.querySelector(".brain-compose-from")?.textContent,
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
    // Autosave is silent: only a failure speaks.
    expect(document.body.textContent).not.toContain("Not saved");
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
    expect(document.body.textContent).not.toContain("Not saved");
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
    expect(document.body.textContent).not.toContain("Not saved");
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
    const onToast = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
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
    await settle();
    await act(async () => {
      discardPill(onToast).onExpire?.();
    });
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

    // The composer is a portal at the body, not a child of its surface's
    // host: the recovering surface's sheet is the last dialog standing.
    const recoverySheet = () =>
      [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
    await vi.waitFor(() => {
      const textarea = recoverySheet()?.querySelector("textarea");
      expect(textarea?.value).toBe(largeFinalBody);
    });
    expect(recoverySheet()?.textContent).toContain("Recovered after Brain closed");

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

  // DISCARD WITHOUT A MODAL. The trash takes the sheet down at once and a
  // pill offers the way back; the provider delete is parked behind that pill
  // and goes out only when the way back is gone: the window ran out, the page
  // is unloading, or the writer opened another message. Undo brings the same
  // draft back (same draftId, revision and text) and nothing is ever deleted.

  /** The pill the surface posted for the discard, with its two callbacks. */
  function discardPill(onToast: ReturnType<typeof vi.fn>): ToastOptions {
    const call = onToast.mock.calls.find(([title]) => title === "Draft discarded");
    if (!call) throw new Error("no Draft discarded pill was posted");
    return call[1] as ToastOptions;
  }

  /** A composer with a saved draft ("Never mind", created after the autosave
   *  pause) whose trash was just pressed. */
  async function parkedDiscard(client: MailSurfaceClient) {
    const onToast = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
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
    expect(client.createDraft).toHaveBeenCalledTimes(1);
    const draftId = vi.mocked(client.createDraft).mock.calls[0]?.[0].draftId as string;
    await click(findButton("Discard draft"));
    await settle();
    return { onToast, draftId };
  }

  it("takes the sheet down at the trash and parks the delete behind Undo", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { onToast } = await parkedDiscard(client);

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(client.deleteDraft).not.toHaveBeenCalled();
    const pill = discardPill(onToast);
    expect(pill).toMatchObject({
      icon: "trash-bin-trash-linear",
      actionLabel: "Undo",
      durationMs: SMART_UNDO_MS,
      id: "mail-draft-discard",
    });
    expect(typeof pill.onAction).toBe("function");
    expect(typeof pill.onExpire).toBe("function");
  });

  it("Undo brings the same draft back, and no delete ever goes out", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { onToast, draftId } = await parkedDiscard(client);
    const pill = discardPill(onToast);

    await act(async () => {
      pill.onAction?.();
    });
    await settle();
    const textarea = document.body.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Never mind");
    // The same draft, not a new one: the next edit patches the draft that was
    // created, at the revision it reached, and nothing is created again.
    await setInput(textarea, "Never mind, again");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    expect(client.createDraft).toHaveBeenCalledTimes(1);
    // The create carried the empty fields and the first patch the text, so
    // the draft stood at revision 1 when it was parked; the next edit names
    // that revision.
    expect(client.patchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId,
        expectedRevision: 1,
        patch: expect.objectContaining({ text: "Never mind, again" }),
      }),
    );
    // A stale window closing over a restored draft deletes nothing.
    await act(async () => {
      pill.onExpire?.();
    });
    await settle();
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });

  it("lets the delete go once the window closes, exactly once", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { onToast, draftId } = await parkedDiscard(client);
    const pill = discardPill(onToast);

    await act(async () => {
      pill.onExpire?.();
    });
    await settle();
    await settle();
    expect(client.deleteDraft).toHaveBeenCalledTimes(1);
    expect(client.deleteDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId, expectedRevision: 1 }),
    );
    expect(window.localStorage.length).toBe(0);

    // Nothing reaches a settled discard twice: not a second expiry, not a
    // late Undo.
    await act(async () => {
      pill.onExpire?.();
      pill.onAction?.();
    });
    await settle();
    expect(client.deleteDraft).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("parks a local-only draft too, and Undo gets its text back with nothing created or deleted", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const onToast = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
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
    await settle();
    expect(document.body.querySelector("textarea")).toBeNull();
    const first = discardPill(onToast);
    await act(async () => {
      first.onAction?.();
    });
    await settle();
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Local only draft");
    expect(client.createDraft).not.toHaveBeenCalled();

    // Discarded again and left to expire: no draft was ever on the server, so
    // nothing is created to be deleted, and the local copy goes.
    onToast.mockClear();
    await click(findButton("Discard draft"));
    await settle();
    await act(async () => {
      discardPill(onToast).onExpire?.();
    });
    await settle();
    expect(client.createDraft).not.toHaveBeenCalled();
    expect(client.deleteDraft).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("an empty composer leaves at the trash without a pill", async () => {
    const client = makeClient();
    const onToast = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    await click(findButton("Discard draft"));
    await settle();

    expect(document.body.querySelector("textarea")).toBeNull();
    expect(onToast).not.toHaveBeenCalled();
    expect(client.createDraft).not.toHaveBeenCalled();
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });

  it("opening another message lets a parked discard go and spends its pill", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { onToast, draftId } = await parkedDiscard(client);
    onToast.mockClear();

    await click(findButton("New message"));
    await settle();
    expect(client.deleteDraft).toHaveBeenCalledTimes(1);
    expect(client.deleteDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId }),
    );
    // The pill is said again under its id with no way back: the same
    // sentence, now without an Undo that could do nothing.
    const respoken = onToast.mock.calls.find(([title]) => title === "Draft discarded");
    expect(respoken?.[1]).toMatchObject({ id: "mail-draft-discard" });
    expect((respoken?.[1] as ToastOptions | undefined)?.actionLabel).toBeUndefined();
    expect(document.body.querySelector("textarea")).not.toBeNull();
  });

  it("lets a parked discard go when its account vanishes, and the pill loses its Undo", async () => {
    // Undo after the account is gone would restore a composer with no
    // account to draw it for: `sheetOpen` true, the shell inert, nothing on
    // top. So the accounts load flushes a parcel whose account left, and the
    // pill is said again without a way back.
    vi.useFakeTimers();
    const loadAccounts = vi
      .fn()
      .mockResolvedValueOnce([accountA, accountB])
      .mockResolvedValueOnce([accountB]);
    const client = makeClient({ loadAccounts });
    const onToast = vi.fn();
    const onSheetOpenChange = vi.fn();
    const surface = (refreshToken: number) => (
      <MailSurface
        client={client}
        onOpenSettings={() => {}}
        onToast={onToast}
        onSheetOpenChange={onSheetOpenChange}
        refreshToken={refreshToken}
      />
    );
    await act(async () => root.render(surface(0)));
    await settle();
    await enterSingleAccount(accountA);
    await click(findButton("New message"));
    await setInput(
      document.body.querySelector("textarea") as HTMLTextAreaElement,
      "Never mind",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    const draftId = vi.mocked(client.createDraft).mock.calls[0]?.[0].draftId as string;
    await click(findButton("Discard draft"));
    await settle();
    const pill = discardPill(onToast);
    onToast.mockClear();

    await act(async () => root.render(surface(1)));
    await settle();
    await settle();
    expect(client.deleteDraft).toHaveBeenCalledTimes(1);
    expect(client.deleteDraft).toHaveBeenCalledWith(expect.objectContaining({ draftId }));
    const respoken = onToast.mock.calls.find(([title]) => title === "Draft discarded");
    expect(respoken?.[1]).toMatchObject({ id: "mail-draft-discard" });
    expect((respoken?.[1] as ToastOptions | undefined)?.actionLabel).toBeUndefined();

    // A late press on the old pill brings nothing back and refuses the press
    // rather than spending a pill that was already replaced.
    await act(async () => {
      expect(pill.onAction?.()).toBe(false);
    });
    await settle();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(onSheetOpenChange.mock.calls.at(-1)?.[0]).toBe(false);
    expect(client.deleteDraft).toHaveBeenCalledTimes(1);
  });

  it("flushes a parked discard with keepalive when the page starts unloading, and the pill loses its Undo", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { onToast, draftId } = await parkedDiscard(client);
    onToast.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await settle();
    expect(client.deleteDraft).toHaveBeenCalledTimes(1);
    expect(client.deleteDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId }),
      undefined,
      { keepalive: true },
    );
    // The page may come back from the back-forward cache with this DOM: the
    // pill it shows must not offer an Undo whose delete already went out.
    const respoken = onToast.mock.calls.find(([title]) => title === "Draft discarded");
    expect(respoken?.[1]).toMatchObject({ id: "mail-draft-discard" });
    expect((respoken?.[1] as ToastOptions | undefined)?.actionLabel).toBeUndefined();
  });

  it("lets a parked discard go when the page is restored from the back-forward cache", async () => {
    // Back inside the window: the DOM returns as it was left, pill and all,
    // and a parcel still parked (no pagehide reached it) would be a dead Undo
    // the moment its window expires in a page that had frozen timers.
    vi.useFakeTimers();
    const client = makeClient();
    const { onToast, draftId } = await parkedDiscard(client);
    onToast.mockClear();

    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });
    await settle();
    expect(client.deleteDraft).toHaveBeenCalledTimes(1);
    expect(client.deleteDraft).toHaveBeenCalledWith(expect.objectContaining({ draftId }));
    const respoken = onToast.mock.calls.find(([title]) => title === "Draft discarded");
    expect(respoken?.[1]).toMatchObject({ id: "mail-draft-discard" });
    expect((respoken?.[1] as ToastOptions | undefined)?.actionLabel).toBeUndefined();

    // A plain load's pageshow touches nothing.
    onToast.mockClear();
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    });
    await settle();
    expect(onToast).not.toHaveBeenCalled();
    expect(client.deleteDraft).toHaveBeenCalledTimes(1);
  });

  it("lets a parked discard go when the Mail surface unmounts, and the pill loses its Undo", async () => {
    // A route change inside Brain takes the surface that could bring the
    // sheet back with it. `visibilitychange: hidden` deliberately does NOT
    // do this: an OS tab discard inside the window keeps the draft and the
    // way back, and a parked delete behind an in-flight autosave at unload
    // may not leave, the same limit the autosave itself has.
    vi.useFakeTimers();
    const client = makeClient();
    const { onToast, draftId } = await parkedDiscard(client);
    onToast.mockClear();

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(client.deleteDraft).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();

    await act(async () => root.render(<div>Home</div>));
    await settle();
    expect(client.deleteDraft).toHaveBeenCalledTimes(1);
    expect(client.deleteDraft).toHaveBeenCalledWith(expect.objectContaining({ draftId }));
    const respoken = onToast.mock.calls.find(([title]) => title === "Draft discarded");
    expect(respoken?.[1]).toMatchObject({ id: "mail-draft-discard" });
    expect((respoken?.[1] as ToastOptions | undefined)?.actionLabel).toBeUndefined();
  });

  it("re-arms the autosave Undo brings back on its own pause rather than firing it", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const onToast = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
    );
    await settle();
    await enterSingleAccount();
    await click(findButton("New message"));
    const textarea = () => document.body.querySelector("textarea") as HTMLTextAreaElement;
    await setInput(textarea(), "Saved first");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    expect(client.createDraft).toHaveBeenCalledTimes(1);
    // A newer edit still inside the pause when the trash is pressed.
    await setInput(textarea(), "Saved first, then more");
    await click(findButton("Discard draft"));
    await settle();
    await act(async () => {
      discardPill(onToast).onAction?.();
    });
    await settle();
    expect(textarea().value).toBe("Saved first, then more");
    // Nothing fired at the press of Undo; the pause runs again from here.
    expect(client.patchDraft).not.toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ text: "Saved first, then more" }) }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(699);
    });
    expect(client.patchDraft).not.toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ text: "Saved first, then more" }) }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    await settle();
    expect(client.patchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ text: "Saved first, then more" }) }),
    );
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });

  it("resuming the draft that was just discarded is its Undo", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { onToast, draftId } = await parkedDiscard(client);
    // The delete has not gone out, so Drafts still lists it. Opening that row
    // must not delete the draft on the way in and then fail to find it.
    vi.mocked(client.listDrafts).mockResolvedValue([
      {
        draftId,
        accountId: accountA.accountId,
        revision: 0,
        state: "editing",
        intent: { kind: "compose" },
        subject: "",
        updatedAt: 1_700_000_000_000,
      },
    ]);

    await goTo("Drafts");
    await settle();
    const row = document.body.querySelector(
      '[aria-label="Saved drafts"] [role="listitem"] button.brain-mail-row',
    );
    expect(row).not.toBeNull();
    await click(row as HTMLButtonElement);
    await settle();
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Never mind");
    expect(client.deleteDraft).not.toHaveBeenCalled();
    // The pill's own callbacks are spent with it.
    await act(async () => {
      discardPill(onToast).onExpire?.();
    });
    await settle();
    expect(client.deleteDraft).not.toHaveBeenCalled();
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
    const onToast = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
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
    await settle();
    // The window closes; only now does the parked delete go out.
    await act(async () => {
      discardPill(onToast).onExpire?.();
    });
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
    const onToast = vi.fn();
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
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
    await settle();
    await act(async () => {
      discardPill(onToast).onExpire?.();
    });
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

  it("says in the slot that sending is not available for an account that can compose but not send", async () => {
    // An account that stores drafts but has no transport: a custom domain
    // whose SMTP is not set up. New message is not offered for it, but a
    // saved draft still resumes, and the press on Send has to be answered on
    // the sheet, in the slot, not in a pill under it.
    const draftsOnly: PublicMailAccount = {
      ...accountA,
      capabilities: { ...gmailCapabilities, send: false },
    };
    const savedDraftId = "draft-55555555-5555-4555-8555-555555555555";
    const listDrafts = vi.fn().mockResolvedValue([
      {
        draftId: savedDraftId,
        accountId: draftsOnly.accountId,
        revision: 2,
        state: "editing",
        intent: { kind: "compose" },
        subject: "No transport yet",
        updatedAt: 1_700_000_000_000,
      },
    ]);
    const getDraft = vi.fn().mockResolvedValue({
      draftId: savedDraftId,
      accountId: draftsOnly.accountId,
      revision: 2,
      state: "editing",
      intent: { kind: "compose" },
      to: "friend@example.test",
      cc: "",
      bcc: "",
      subject: "No transport yet",
      text: "Written before the transport was.",
      updatedAt: 1_700_000_000_000,
    });
    const onToast = vi.fn();
    const client = makeClient({
      loadAccounts: vi.fn().mockResolvedValue([draftsOnly]),
      listDrafts,
      getDraft,
    });
    await act(async () =>
      root.render(
        <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
      ),
    );
    await settle();
    await enterSingleAccount(draftsOnly);
    await goTo("Drafts");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("No transport yet"),
    );
    await click(findButton("No transport yet"));
    await vi.waitFor(() => expect(getDraft).toHaveBeenCalledTimes(1));

    await click(findButton("Send"));
    await settle();
    const alert = document.body.querySelector('.brain-compose-slot [role="alert"]');
    expect(alert?.textContent).toBe("Sending isn’t available for this account yet.");
    expect(client.sendDraft).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    // The sheet stays up with the letter as it was, Send live for a later try.
    expect(
      (document.body.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("Written before the transport was.");
    expect(findButton("Send").getAttribute("aria-busy")).toBeNull();
    expect(onToast).not.toHaveBeenCalled();
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
      await vi.advanceTimersByTimeAsync(MAIL_SAFETY_REFRESH_MS);
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
      await vi.advanceTimersByTimeAsync(MAIL_SAFETY_REFRESH_MS);
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

    it.each([
      ["Archive", true, "Move to Inbox", ["Conversation archived"]],
      [
        "Move to Inbox",
        false,
        "Archive",
        [
          "Moved to Inbox",
          expect.objectContaining({
            actionLabel: "Undo",
            durationMs: SMART_UNDO_MS,
          }),
        ],
      ],
    ] as const)(
      "keeps the held letter in place when %s runs on it in All Mail",
      async (label, startsInInbox, wayBack, toast) => {
        // All Mail lists the letter either way, so the move in or out of the
        // Inbox takes the held path a star takes: under Unread first, the row
        // the reader opened stays where it was until the selection moves on.
        const unreadById = new Map([
          [firstUnread.threadId, true],
          [secondUnread.threadId, true],
        ]);
        let inInbox = startsInInbox;
        const items = () =>
          [firstUnread, secondUnread].map((item) => ({
            ...item,
            unread: unreadById.get(item.threadId)!,
          }));
        const listMailboxThreads = vi.fn().mockImplementation((input) => {
          let pageItems = items();
          if (input.sort === "unread") {
            pageItems = [...pageItems].sort(
              (a, b) => Number(b.unread) - Number(a.unread),
            );
          }
          return Promise.resolve({
            ...mailboxThreadPage(input.mailboxId),
            items: pageItems,
          });
        });
        const readMailboxThread = vi.fn().mockImplementation(({ threadId }) =>
          Promise.resolve({
            ...detail,
            thread: items().find((item) => item.threadId === threadId)!,
            messages: detail.messages.map((message) => ({
              ...message,
              threadId,
              inInbox,
            })),
          }),
        );
        const updateThread = vi.fn().mockImplementation(async (input) => {
          if ("read" in input) unreadById.set(input.threadId, input.read !== true);
          if ("archive" in input) inInbox = !input.archive;
        });
        const client = makeClient({
          listMailboxThreads,
          readMailboxThread,
          updateThread,
        });
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
          ),
        );
        await settle();
        await enterSingleAccount();
        await goTo("All Mail");
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
        const rows = () =>
          [...mailboxList().querySelectorAll('[role="list"] button')].map(
            (button) => button.textContent ?? "",
          );
        await click(findButton("First unread"));
        await settle();
        expect(rows()[0]).toContain("First unread");
        const reads = listMailboxThreads.mock.calls.length;

        const reader = () =>
          document.body.querySelector('section[aria-label="Message reader"]');
        const action = [...(reader()?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent?.trim() === label,
        ) as HTMLButtonElement;
        await click(action);
        await settle();

        expect(updateThread).toHaveBeenLastCalledWith(
          expect.objectContaining({ archive: startsInInbox }),
        );
        // No refetch re-sorted the list under the reader.
        expect(listMailboxThreads.mock.calls.length).toBe(reads);
        expect(rows()[0]).toContain("First unread");
        // The reader stays on the letter and offers the move back.
        expect(reader()?.textContent).toContain("First unread");
        expect(
          [...(reader()?.querySelectorAll("button") ?? [])].map(
            (button) => button.textContent?.trim(),
          ),
        ).toContain(wayBack);
        // The same sentence as the unheld path, Move to Inbox's Undo included.
        expect(onToast).toHaveBeenLastCalledWith(...toast);
      },
    );

    it("takes the held letter's row out of the Inbox when Archive runs on it there", async () => {
      // In the Inbox, Archive moves the letter out of the folder on screen, so
      // it is not held: the row leaves and the reader closes, unread first or
      // not.
      const unreadById = new Map([
        [firstUnread.threadId, true],
        [secondUnread.threadId, true],
      ]);
      const archived = new Set<string>();
      const items = () =>
        [firstUnread, secondUnread]
          .filter((item) => !archived.has(item.threadId))
          .map((item) => ({ ...item, unread: unreadById.get(item.threadId)! }));
      const listThreads = vi.fn().mockImplementation((input) => {
        let pageItems = items();
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
          thread: [firstUnread, secondUnread].find(
            (item) => item.threadId === threadId,
          )!,
          messages: detail.messages.map((message) => ({ ...message, threadId })),
        }),
      );
      const updateThread = vi.fn().mockImplementation(async (input) => {
        if ("read" in input) unreadById.set(input.threadId, input.read !== true);
        if ("archive" in input && input.archive) archived.add(input.threadId);
      });
      const client = makeClient({ listThreads, readThread, updateThread });
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
      await click(findButton("First unread"));
      await settle();
      expect(updateThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ read: true }),
      );

      const reader = () =>
        document.body.querySelector('section[aria-label="Message reader"]');
      const archive = [...(reader()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Archive",
      ) as HTMLButtonElement;
      await click(archive);
      await settle();

      expect(updateThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ archive: true }),
      );
      expect(mailboxList().textContent).not.toContain("First unread");
      expect(reader()?.textContent).toContain("Choose a message");
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
        document.body.querySelector('[role="dialog"][aria-label="New message"]'),
      ).not.toBeNull();

      await pressKey("j");
      expect(client.readThread).not.toHaveBeenCalled();

      await pressKey("Escape");
      expect(
        document.body.querySelector('[role="dialog"][aria-label="New message"]'),
      ).toBeNull();
    });

    it("leaves the reader alone when a layer above has already answered Escape", async () => {
      // One pane: the panes do not fit, so Escape's next branch would close
      // the reader.
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      const client = keyboardClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await pressKey("j");
      expect(client.readThread).toHaveBeenCalledTimes(1);
      expect(document.body.querySelector(".brain-mail-reader-head")).not.toBeNull();
      await pressKey("c");
      expect(
        document.body.querySelector('[role="dialog"][aria-label="New message"]'),
      ).not.toBeNull();

      // Escape at the document, where the sheet's own layer answers it and
      // marks it handled before it reaches mail's window listener.
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      await settle();
      expect(
        document.body.querySelector('[role="dialog"][aria-label="New message"]'),
      ).toBeNull();
      expect(document.body.querySelector(".brain-mail-reader-head")).not.toBeNull();
      expect(client.readThread).toHaveBeenCalledTimes(1);
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
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
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
        document.body.querySelector('[role="dialog"][aria-label="New message"]'),
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
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();

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

    /** Seven connected accounts, each with one thread of its own. */
    function manyAccounts(): readonly PublicMailAccount[] {
      return Array.from({ length: 7 }, (_, index) => ({
        ...accountA,
        accountId: `account-a${String(index + 1).repeat(32)}`,
        emailAddress: `person-${index + 1}@example.test`,
      }));
    }

    /* The threads spread over the three sections so none of them bundles and
       every row is on screen as itself. Expanding a section instead would be
       an assertion that writes to sessionStorage, and the next test would
       mount into it. */
    const MANY_CATEGORIES = ["people", "notification", "newsletter"] as const;

    /** A listThreads that hands back its resolver instead of settling. */
    function heldPages(
      many: readonly PublicMailAccount[],
      held: Array<() => void>,
      counts: { inFlight: number; peak: number },
    ) {
      return vi.fn().mockImplementation(({ accountId }: { accountId: string }) => {
        counts.inFlight += 1;
        counts.peak = Math.max(counts.peak, counts.inFlight);
        const seat = many.findIndex((account) => account.accountId === accountId);
        return new Promise((resolve) => {
          held.push(() => {
            counts.inFlight -= 1;
            resolve(
              pageOf([
                unifiedThread({
                  accountId,
                  threadId: `thread ${accountId}`,
                  category: MANY_CATEGORIES[seat % MANY_CATEGORIES.length]!,
                }),
              ]),
            );
          });
        });
      });
    }

    /* THE MERGE IS GENERIC IN THE ACCOUNT COUNT, THE MACHINE IS NOT. Opening
       All inboxes on seven accounts would put seven page-1 requests on one
       shared vCPU in the same instant, and every one of them lands in the same
       mail service. The queue holds the peak where three accounts held it,
       and the accounts waiting their turn read as pending, never as empty and
       never as failed. */
    it("bounds the page-1 fan-out and still merges every account", async () => {
      const many = manyAccounts();
      // Without more accounts than slots there is no queue to assert on.
      expect(many.length).toBeGreaterThan(UNIFIED_FANOUT_LIMIT);
      const held: Array<() => void> = [];
      const counts = { inFlight: 0, peak: 0 };
      const listThreads = heldPages(many, held, counts);
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue(many),
        listThreads,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      expect(listThreads).toHaveBeenCalledTimes(UNIFIED_FANOUT_LIMIT);
      expect(
        document.body.querySelector('[aria-label="Loading all inboxes"]'),
      ).not.toBeNull();
      expect(document.body.textContent).not.toContain("couldn’t load");
      expect(document.body.textContent).not.toContain("Inbox zero");

      while (held.length > 0) {
        const wave = held.splice(0);
        await act(async () => wave.forEach((release) => release()));
        await settle();
      }

      expect(counts.peak).toBe(UNIFIED_FANOUT_LIMIT);
      expect(listThreads).toHaveBeenCalledTimes(many.length);
      const list = document.body.querySelector(
        '[aria-label="All inboxes threads"]',
      ) as HTMLElement;
      for (const account of many) {
        expect(list.textContent).toContain(`thread ${account.accountId}`);
      }
    });

    /* A queued request is a request that has not been made yet, so a failure
       in the wave ahead of it has to free its slot rather than hold it. */
    it("gives a failed account's slot to the next one in the queue", async () => {
      const many = manyAccounts();
      expect(many.length).toBeGreaterThan(UNIFIED_FANOUT_LIMIT);
      const held: Array<() => void> = [];
      const counts = { inFlight: 0, peak: 0 };
      const pages = heldPages(many, held, counts);
      const listThreads = vi
        .fn()
        .mockImplementation((input: { accountId: string }) => {
          if (input.accountId === many[0]!.accountId) {
            counts.inFlight += 1;
            counts.peak = Math.max(counts.peak, counts.inFlight);
            counts.inFlight -= 1;
            return Promise.reject(new Error("outage"));
          }
          return pages(input);
        });
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue(many),
        listThreads,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      // The first wave is three; the failure released one of them, so a fourth
      // account is already asking while the other two are still out.
      expect(listThreads).toHaveBeenCalledTimes(UNIFIED_FANOUT_LIMIT + 1);

      while (held.length > 0) {
        const wave = held.splice(0);
        await act(async () => wave.forEach((release) => release()));
        await settle();
      }

      expect(counts.peak).toBe(UNIFIED_FANOUT_LIMIT);
      expect(listThreads).toHaveBeenCalledTimes(many.length);
      expect(document.body.textContent).toContain(
        `${many[0]!.emailAddress} couldn’t load`,
      );
      const list = document.body.querySelector(
        '[aria-label="All inboxes threads"]',
      ) as HTMLElement;
      for (const account of many.slice(1)) {
        expect(list.textContent).toContain(`thread ${account.accountId}`);
      }
      expect(list.textContent).not.toContain(`thread ${many[0]!.accountId}`);
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

    /** A SYNC HOLDING THE ACCOUNT IS NOT AN OUTAGE. The service answers a list
     *  read with 409 `mail_sync_in_progress` while a sync moves the account's
     *  cache under it, and a second later the same account answers. The red
     *  row and its Try again were the reader's to press for a wait the
     *  surface can take on its own. */
    describe("a stream a sync is holding", () => {
      const itemA = unifiedThread({
        accountId: accountA.accountId,
        threadId: "Healthy thread",
      });
      const itemB = unifiedThread({
        accountId: accountB.accountId,
        threadId: "Recovered thread",
      });
      const held = () => new MailApiError(409, "mail_sync_in_progress");

      function pageOneCalls(
        listThreads: ReturnType<typeof vi.fn>,
        accountId: string,
      ): number {
        return listThreads.mock.calls.filter(
          ([input]) => input.accountId === accountId && !input.cursor,
        ).length;
      }

      async function wait(ms: number) {
        await act(async () => vi.advanceTimersByTimeAsync(ms));
        await settle();
      }

      it("is read again quietly and joins the merge when the sync lets go", async () => {
        vi.useFakeTimers();
        let holds = 2;
        const listThreads = vi.fn().mockImplementation(({ accountId }) => {
          if (accountId === accountB.accountId && holds > 0) {
            holds -= 1;
            return Promise.reject(held());
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

        // The other account merges at once, and the held one says nothing.
        expect(document.body.textContent).toContain("Healthy thread");
        expect(document.body.textContent).not.toContain("couldn’t load");
        expect(pageOneCalls(listThreads, accountB.accountId)).toBe(1);

        await wait(1_499);
        expect(pageOneCalls(listThreads, accountB.accountId)).toBe(1);
        await wait(1);
        expect(pageOneCalls(listThreads, accountB.accountId)).toBe(2);
        expect(document.body.textContent).not.toContain("couldn’t load");

        await wait(1_500);
        expect(pageOneCalls(listThreads, accountB.accountId)).toBe(3);
        expect(document.body.textContent).toContain("Recovered thread");
        expect(document.body.textContent).not.toContain("couldn’t load");

        // Answered: nothing is left scheduled to ask again.
        await wait(10_000);
        expect(pageOneCalls(listThreads, accountB.accountId)).toBe(3);
      });

      it("reports the stream after three quiet reads the sync still holds", async () => {
        vi.useFakeTimers();
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          accountId === accountB.accountId
            ? Promise.reject(held())
            : Promise.resolve(pageOf([itemA])),
        );
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
        });
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await settle();

        await wait(1_500);
        await wait(1_500);
        expect(pageOneCalls(listThreads, accountB.accountId)).toBe(3);
        expect(document.body.textContent).not.toContain("couldn’t load");

        await wait(1_500);
        expect(pageOneCalls(listThreads, accountB.accountId)).toBe(4);
        expect(document.body.textContent).toContain(
          `${accountB.emailAddress} couldn’t load`,
        );

        await wait(10_000);
        expect(pageOneCalls(listThreads, accountB.accountId)).toBe(4);
      });

      it("reads page one again when a sync holds a Load more", async () => {
        vi.useFakeTimers();
        const deepA = [
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "A newest",
            lastMessageAt: 1_700_000_000_900,
          }),
        ];
        const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) => {
          if (cursor) return Promise.reject(held());
          return Promise.resolve(
            accountId === accountA.accountId
              ? pageOf(deepA, "cursor-a")
              : pageOf([itemB]),
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
        expect(listThreads).toHaveBeenLastCalledWith({
          accountId: accountA.accountId,
          cursor: "cursor-a",
          limit: 50,
        });
        expect(document.body.textContent).not.toContain("couldn’t load");

        // The cursor is from before the sync, so the same page is not asked
        // again: the stream's first page is, as Try again would.
        await wait(1_500);
        expect(listThreads.mock.lastCall?.[0]).toEqual({
          accountId: accountA.accountId,
          limit: 50,
        });
        expect(document.body.textContent).toContain("A newest");
        expect(document.body.textContent).not.toContain("couldn’t load");

        // Page one was all the stream had, so page one's cursor is the one
        // Load more goes on from.
        await click(findButton("Load more"));
        expect(listThreads).toHaveBeenLastCalledWith({
          accountId: accountA.accountId,
          cursor: "cursor-a",
          limit: 50,
        });
      });

      const deepRows = Array.from({ length: 150 }, (_value, index) =>
        unifiedThread({
          accountId: accountA.accountId,
          threadId: `A row ${String(index).padStart(3, "0")}`,
          lastMessageAt: 1_700_000_900_000 - index * 1_000,
          unread: false,
        }),
      );

      /** A letter the stream never saw, filed by the new snapshot among rows
       *  it did see: only the walk's middle page carries it, so a walk that
       *  kept only its last page loses it. */
      const arrivedDeep = unifiedThread({
        accountId: accountA.accountId,
        threadId: "A arrived deep",
        lastMessageAt: 1_700_000_900_000 - 75_500,
      });

      /** A letter the stream loaded read, marked unread elsewhere since: the
       *  walk re-reads it, and its fresh copy is the one that counts. */
      const unreadSince = { ...deepRows[60]!, unread: true };

      const secondSnapshot: Readonly<
        Record<string, MailThreadPage | Promise<MailThreadPage>>
      > = {
        "s2-page-2": pageOf(
          [
            ...deepRows.slice(50, 60),
            unreadSince,
            ...deepRows.slice(61, 76),
            arrivedDeep,
            ...deepRows.slice(76, 100),
          ],
          "s2-page-3",
        ),
        "s2-page-3": pageOf(deepRows.slice(100, 150)),
      };

      /** A stream two pages deep whose third page a sync (or an outage) held.
       *  The re-read hands back page one of the new snapshot and its cursor,
       *  and the stream's hundred rows stay. Keeping the lost cursor's null
       *  stopped the account paging until a reload. `pages` is the new
       *  snapshot past its first page, by cursor. */
      function deepStreamClient(
        third: () => Error,
        pages: Readonly<
          Record<string, MailThreadPage | Promise<MailThreadPage>>
        > = secondSnapshot,
      ) {
        let snapshot = 1;
        let failed = false;
        const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) => {
          if (accountId === accountB.accountId) {
            return Promise.resolve(
              pageOf([
                unifiedThread({
                  accountId: accountB.accountId,
                  threadId: "B only",
                  lastMessageAt: 1_600_000_000_000,
                }),
              ]),
            );
          }
          if (!cursor) {
            return Promise.resolve(
              pageOf(deepRows.slice(0, 50), `s${snapshot}-page-2`),
            );
          }
          if (cursor === "s1-page-2") {
            return Promise.resolve(pageOf(deepRows.slice(50, 100), "s1-page-3"));
          }
          if (cursor === "s1-page-3" && !failed) {
            failed = true;
            snapshot = 2;
            return Promise.reject(third());
          }
          if (cursor in pages) return Promise.resolve(pages[cursor]!);
          return Promise.reject(new Error(`unexpected cursor ${cursor}`));
        });
        return { listThreads };
      }

      function cursorsAsked(listThreads: ReturnType<typeof vi.fn>): string[] {
        return listThreads.mock.calls
          .map(([input]) => input.cursor)
          .filter((cursor): cursor is string => typeof cursor === "string");
      }

      it("pages on past its loaded rows after a sync holds a deep Load more", async () => {
        vi.useFakeTimers();
        const { listThreads } = deepStreamClient(held);
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
        });
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await settle();
        await click(findButton("Load more"));
        await click(findButton("Load more"));
        expect(cursorsAsked(listThreads)).toEqual(["s1-page-2", "s1-page-3"]);

        await wait(1_500);
        expect(document.body.textContent).not.toContain("couldn’t load");

        // One press walks the new snapshot from its page two past the
        // hundredth row, where the rows the stream has not seen begin.
        await click(findButton("Load more"));
        expect(cursorsAsked(listThreads)).toEqual([
          "s1-page-2",
          "s1-page-3",
          "s2-page-2",
          "s2-page-3",
        ]);
        // Every page the walk crossed counts, not only the one it ended on.
        expect(document.body.textContent).toContain("A arrived deep");
        // The account ran out, so nothing is left to ask for.
        expect(() => findButton("Load more")).toThrow();
      });

      it("pages on past its loaded rows after Try again heals a deep Load more", async () => {
        const { listThreads } = deepStreamClient(() => new Error("outage"));
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
        });
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await settle();
        await click(findButton("Load more"));
        await click(findButton("Load more"));
        expect(document.body.textContent).toContain(
          `${accountA.emailAddress} couldn’t load`,
        );

        await click(findButton("Try again"));
        expect(document.body.textContent).not.toContain("couldn’t load");
        expect(document.body.textContent).not.toContain(unreadSince.subject);

        await click(findButton("Load more"));
        expect(cursorsAsked(listThreads)).toEqual([
          "s1-page-2",
          "s1-page-3",
          "s2-page-2",
          "s2-page-3",
        ]);
        expect(document.body.textContent).toContain("A arrived deep");
        // Unread again, so it stands as a row of its own rather than in Seen.
        expect(document.body.textContent).toContain(unreadSince.subject);
        expect(() => findButton("Load more")).toThrow();
      });

      /** The column scrolled to its end. Every observer the list makes reports
       *  its sentinel in view as soon as it observes it, the way a real one
       *  does, and none reports once disconnected. Nothing here presses the
       *  sr-only Load more, so what pages is what scrolling does. `view` lets
       *  a test bring the end into view later. */
      function sentinelInView(view: { inView: boolean } = { inView: true }) {
        vi.stubGlobal(
          "IntersectionObserver",
          class {
            private readonly targets = new Set<Element>();
            constructor(private readonly callback: IntersectionObserverCallback) {}
            observe(target: Element) {
              this.targets.add(target);
              queueMicrotask(() => {
                if (!this.targets.has(target)) return;
                this.callback(
                  [{ target, isIntersecting: view.inView } as IntersectionObserverEntry],
                  this as unknown as IntersectionObserver,
                );
              });
            }
            unobserve(target: Element) {
              this.targets.delete(target);
            }
            disconnect() {
              this.targets.clear();
            }
            takeRecords() {
              return [];
            }
          },
        );
      }

      async function until(ok: () => boolean, what: string) {
        for (let round = 0; round < 60; round += 1) {
          if (ok()) return;
          await settle();
        }
        throw new Error(`not reached: ${what}`);
      }

      it("scrolls on past its loaded rows after a sync holds a deep page", async () => {
        vi.useFakeTimers();
        sentinelInView();
        const { listThreads } = deepStreamClient(held);
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
        });
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await until(
          () => cursorsAsked(listThreads).length === 2,
          "scrolling reaches the held page",
        );
        expect(cursorsAsked(listThreads)).toEqual(["s1-page-2", "s1-page-3"]);

        // The quiet re-read heals the stream with exactly the rows it had,
        // and the sentinel still in view asks for what comes after them.
        await wait(1_500);
        await until(
          () => cursorsAsked(listThreads).length === 4,
          "scrolling goes on after the heal",
        );
        expect(cursorsAsked(listThreads)).toEqual([
          "s1-page-2",
          "s1-page-3",
          "s2-page-2",
          "s2-page-3",
        ]);
        await until(
          () => document.body.textContent?.includes("A arrived deep") ?? false,
          "every page the walk crossed lands",
        );
      });

      it("scrolls on past its loaded rows after Try again heals a deep page", async () => {
        sentinelInView();
        const { listThreads } = deepStreamClient(() => new Error("outage"));
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
        });
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await until(
          () =>
            document.body.textContent?.includes(
              `${accountA.emailAddress} couldn’t load`,
            ) ?? false,
          "scrolling reaches the page that fails",
        );
        expect(cursorsAsked(listThreads)).toEqual(["s1-page-2", "s1-page-3"]);

        await click(findButton("Try again"));
        await until(
          () => cursorsAsked(listThreads).length === 4,
          "scrolling goes on after Try again",
        );
        expect(cursorsAsked(listThreads)).toEqual([
          "s1-page-2",
          "s1-page-3",
          "s2-page-2",
          "s2-page-3",
        ]);
        await until(
          () => document.body.textContent?.includes("A arrived deep") ?? false,
          "every page the walk crossed lands",
        );
      });

      /** A deep stream that failed and was healed by Try again, so its next
       *  Load more is a walk from the new snapshot's page two. */
      async function healedByTryAgain(
        listThreads: ReturnType<typeof deepStreamClient>["listThreads"],
      ) {
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
        });
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await settle();
        await click(findButton("Load more"));
        await click(findButton("Load more"));
        await click(findButton("Try again"));
        expect(cursorsAsked(listThreads)).toEqual(["s1-page-2", "s1-page-3"]);
      }

      it("walks no further than the stream's depth and a page more on one press", async () => {
        // A snapshot whose pages keep landing inside the rows the stream
        // holds. A hundred rows are two pages; one more covers what moved.
        const inside = (next: string) => pageOf(deepRows.slice(50, 100), next);
        const { listThreads } = deepStreamClient(() => new Error("outage"), {
          "s2-page-2": inside("s2-page-3"),
          "s2-page-3": inside("s2-page-4"),
          "s2-page-4": inside("s2-page-5"),
          "s2-page-5": inside("s2-page-6"),
          "s2-page-6": pageOf(deepRows.slice(100, 150)),
        });
        await healedByTryAgain(listThreads);

        await click(findButton("Load more"));
        expect(cursorsAsked(listThreads).slice(2)).toEqual([
          "s2-page-2",
          "s2-page-3",
          "s2-page-4",
        ]);

        // The walk stopped short of the stream's last row, so the next press
        // walks on from where it stopped rather than appending out of order.
        await click(findButton("Load more"));
        expect(cursorsAsked(listThreads).slice(5)).toEqual([
          "s2-page-5",
          "s2-page-6",
        ]);
        expect(() => findButton("Load more")).toThrow();
      });

      it("stops walking at a cursor it has already read", async () => {
        const inside = (next: string) => pageOf(deepRows.slice(50, 100), next);
        const { listThreads } = deepStreamClient(() => new Error("outage"), {
          "s2-page-2": inside("s2-page-3"),
          "s2-page-3": inside("s2-page-2"),
        });
        await healedByTryAgain(listThreads);

        await click(findButton("Load more"));
        expect(cursorsAsked(listThreads).slice(2)).toEqual([
          "s2-page-2",
          "s2-page-3",
        ]);
        // Following it again only reads the same pages again: the stream
        // stops paging rather than asking for them on every press.
        expect(() => findButton("Load more")).toThrow();
      });

      it("stops walking once the reader leaves All inboxes", async () => {
        const pageTwo = deferred<MailThreadPage>();
        const { listThreads } = deepStreamClient(() => new Error("outage"), {
          ...secondSnapshot,
          "s2-page-2": pageTwo.promise,
        });
        await healedByTryAgain(listThreads);
        await click(findButton("Load more"));
        expect(cursorsAsked(listThreads).at(-1)).toBe("s2-page-2");

        await enterSingleAccount(accountA);
        await act(async () => pageTwo.resolve(await secondSnapshot["s2-page-2"]!));
        await settle();

        expect(cursorsAsked(listThreads)).not.toContain("s2-page-3");
      });

      it("stops walking once the safety refresh moves the column on", async () => {
        vi.useFakeTimers();
        const pageTwo = deferred<MailThreadPage>();
        const { listThreads } = deepStreamClient(held, {
          ...secondSnapshot,
          "s2-page-2": pageTwo.promise,
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
        await click(findButton("Load more"));
        await wait(1_500);
        await click(findButton("Load more"));
        expect(cursorsAsked(listThreads).at(-1)).toBe("s2-page-2");

        // Still in All inboxes, but the refresh re-read page one under the
        // walk, whose answer is dropped: the pages after it are not read.
        await wait(MAIL_SAFETY_REFRESH_MS);
        await act(async () => pageTwo.resolve(await secondSnapshot["s2-page-2"]!));
        await settle();

        expect(cursorsAsked(listThreads)).not.toContain("s2-page-3");
      });

      /** A deep account whose page two the test answers by hand: the first
       *  read of it waits on `pageTwo`, any later one answers at once. */
      function pageTwoByHand(
        pageTwo: Promise<MailThreadPage>,
        top?: MailThreadListItem,
      ) {
        let pageTwoReads = 0;
        return vi.fn().mockImplementation(({ accountId, cursor }) => {
          if (accountId === accountB.accountId) {
            return Promise.resolve(
              pageOf([
                unifiedThread({
                  accountId: accountB.accountId,
                  threadId: "B only",
                  lastMessageAt: 1_600_000_000_000,
                }),
              ]),
            );
          }
          if (!cursor) {
            return Promise.resolve(
              pageOf(
                top ? [top, ...deepRows.slice(0, 49)] : deepRows.slice(0, 50),
                "p2",
              ),
            );
          }
          if (cursor === "p2") {
            pageTwoReads += 1;
            return pageTwoReads === 1
              ? pageTwo
              : Promise.resolve(pageOf(deepRows.slice(50, 100)));
          }
          return Promise.reject(new Error(`unexpected cursor ${cursor}`));
        });
      }

      it("asks the scrolled-to end only once while its page is on the way", async () => {
        sentinelInView();
        const pageTwo = deferred<MailThreadPage>();
        const listThreads = pageTwoByHand(pageTwo.promise);
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
        });
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await until(() => cursorsAsked(listThreads).length === 1, "the end asks p2");

        // Every render makes the list a new observer, which reports the end
        // in view again; the rows have not moved, so it asks for nothing.
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await settle();
        await settle();
        expect(cursorsAsked(listThreads)).toEqual(["p2"]);
      });

      it("asks again after a mail event's refresh drops a page on the way", async () => {
        vi.useFakeTimers();
        sentinelInView();
        const pageTwo = deferred<MailThreadPage>();
        const listThreads = pageTwoByHand(pageTwo.promise);
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
        });
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await until(() => cursorsAsked(listThreads).length === 1, "the end asks p2");

        // The refresh a mail event brings moves the column's epoch, and the
        // page that lands after it is dropped without a row. The end is still
        // in view.
        await mailEvent({
          kind: "mail",
          changeKind: "sync",
          accountId: accountA.accountId,
          mailboxIds: ["inbox"],
        });
        await wait(MAIL_EVENT_DEBOUNCE_MS);
        expect(pageOneCalls(listThreads, accountA.accountId)).toBe(2);
        await act(async () => pageTwo.resolve(pageOf(deepRows.slice(50, 100))));
        await settle();

        await until(() => cursorsAsked(listThreads).length === 2, "the end asks again");
        expect(cursorsAsked(listThreads)).toEqual(["p2", "p2"]);
      });

      it("asks again after opening a letter drops a page on the way", async () => {
        sentinelInView();
        const top = unifiedThread({
          accountId: accountA.accountId,
          threadId: "A unread top",
          lastMessageAt: 1_700_000_999_000,
          unread: true,
        });
        const pageTwo = deferred<MailThreadPage>();
        const listThreads = pageTwoByHand(pageTwo.promise, top);
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
          updateThread,
          readThread: vi.fn().mockResolvedValue({
            ...detail,
            thread: top,
            messages: detail.messages.map((message) => ({
              ...message,
              threadId: top.threadId,
            })),
          }),
        });
        await act(async () =>
          root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
        );
        await until(() => cursorsAsked(listThreads).length === 1, "the end asks p2");

        // Opening an unread letter reads it, and that mutation moves the
        // column's epoch under the page still on the way.
        await click(findButton("A unread top"));
        await until(() => updateThread.mock.calls.length === 1, "the letter is read");
        await act(async () => pageTwo.resolve(pageOf(deepRows.slice(50, 100))));
        await settle();

        await until(() => cursorsAsked(listThreads).length === 2, "the end asks again");
      });

      const newsletters = Array.from({ length: 5 }, (_value, index) =>
        unifiedThread({
          accountId: accountA.accountId,
          threadId: `Letter ${index}`,
          category: "newsletter",
          lastMessageAt: 1_700_000_999_000 - index,
        }),
      );

      /** Two unread letters at the head of a deep account. Opening one sends
       *  its read flag, which is a mail action that takes the lock: the one
       *  left that does, now that a section's Done holds none. */
      const unreadTop = unifiedThread({
        accountId: accountA.accountId,
        threadId: "A unread top",
        lastMessageAt: 1_700_001_000_000,
        unread: true,
      });
      const unreadNext = unifiedThread({
        accountId: accountA.accountId,
        threadId: "A unread next",
        lastMessageAt: 1_700_000_999_500,
        unread: true,
      });
      const openedLetter = () =>
        vi.fn().mockImplementation(({ threadId }) => {
          const opened = threadId === unreadNext.threadId ? unreadNext : unreadTop;
          return Promise.resolve({
            ...detail,
            thread: opened,
            messages: detail.messages.map((message) => ({
              ...message,
              threadId: opened.threadId,
            })),
          });
        });

      it("asks once a mail action that refused the end lets go", async () => {
        // The end comes into view while an opened letter's read flag is
        // still going out. Load more is refused under its lock, and the end
        // is still in view after.
        const view = { inView: false };
        sentinelInView(view);
        const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) => {
          if (accountId === accountB.accountId) return Promise.resolve(pageOf([]));
          if (!cursor) {
            return Promise.resolve(
              pageOf([unreadTop, ...deepRows.slice(0, 49)], "p2"),
            );
          }
          return Promise.resolve(pageOf(deepRows.slice(49, 99)));
        });
        const readTop = deferred<void>();
        const updateThread = vi.fn().mockImplementation(() => readTop.promise);
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
          updateThread,
          readThread: openedLetter(),
        });
        const noSettings = () => {};
        const surface = () => (
          <MailSurface client={client} onOpenSettings={noSettings} />
        );
        await act(async () => root.render(surface()));
        await settle();
        expect(cursorsAsked(listThreads)).toEqual([]);

        await click(findButton("A unread top"));
        await until(() => updateThread.mock.calls.length === 1, "the letter is read");
        // The column draws again with its end in view and the lock held.
        view.inView = true;
        await act(async () => root.render(surface()));
        await settle();
        expect(cursorsAsked(listThreads)).toEqual([]);

        await act(async () => readTop.resolve());
        await until(() => cursorsAsked(listThreads).length === 1, "the end asks p2");
      });

      it("serves a refused Load more once, not after every later mail action", async () => {
        // One read flag refuses the end while it is out and the end is asked
        // for once it lets go. Opening another letter later reads it, which
        // is a mail action of its own: nothing was refused under that one, so
        // it asks for nothing.
        const view = { inView: false };
        sentinelInView(view);
        const pageThree = deferred<MailThreadPage>();
        const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) => {
          if (accountId === accountB.accountId) return Promise.resolve(pageOf([]));
          if (!cursor) {
            return Promise.resolve(
              pageOf([unreadTop, unreadNext, ...deepRows.slice(0, 48)], "p2"),
            );
          }
          if (cursor === "p2") {
            return Promise.resolve(pageOf(deepRows.slice(48, 98), "p3"));
          }
          return pageThree.promise;
        });
        const readTop = deferred<void>();
        const readNext = deferred<void>();
        const updateThread = vi.fn().mockImplementation((input) =>
          input.threadId === unreadTop.threadId ? readTop.promise : readNext.promise,
        );
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
          updateThread,
          readThread: openedLetter(),
        });
        const noSettings = () => {};
        const surface = () => (
          <MailSurface client={client} onOpenSettings={noSettings} />
        );
        await act(async () => root.render(surface()));
        await settle();

        await click(findButton("A unread top"));
        await until(() => updateThread.mock.calls.length === 1, "the letter is read");
        view.inView = true;
        await act(async () => root.render(surface()));
        await settle();
        expect(cursorsAsked(listThreads)).toEqual([]);
        await act(async () => readTop.resolve());
        await until(() => cursorsAsked(listThreads).length === 2, "the end pages on");
        expect(cursorsAsked(listThreads)).toEqual(["p2", "p3"]);

        // Page three is still out. Reading the other letter is the next
        // action, and it holds the lock across a render of its own.
        await click(findButton("A unread next"));
        await until(
          () =>
            updateThread.mock.calls.some(
              ([input]) =>
                input.threadId === unreadNext.threadId && input.read === true,
            ),
          "the other letter is read",
        );
        await settle();
        await act(async () => readNext.resolve());
        await settle();
        await settle();
        expect(cursorsAsked(listThreads)).toEqual(["p2", "p3"]);
      });

      it("serves the end at the press when Done shortens the column, with nothing refused", async () => {
        // Done used to take the lock, so the end it brought into view was
        // refused until the whole run let go. The press holds no lock now:
        // it sends nothing and hides the rows.
        sentinelInView();
        const pageTwo = deferred<MailThreadPage>();
        let pageTwoReads = 0;
        const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) => {
          if (accountId === accountB.accountId) {
            return Promise.resolve(
              pageOf([
                unifiedThread({
                  accountId: accountB.accountId,
                  threadId: "B only",
                  lastMessageAt: 1_600_000_000_000,
                }),
              ]),
            );
          }
          if (!cursor) {
            return Promise.resolve(
              pageOf([...newsletters, ...deepRows.slice(0, 45)], "p2"),
            );
          }
          pageTwoReads += 1;
          return pageTwoReads === 1
            ? pageTwo.promise
            : Promise.resolve(pageOf(deepRows.slice(45, 95)));
        });
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const client = makeClient({
          loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
          listThreads,
          updateThread,
        });
        await act(async () =>
          root.render(
            <MailSurface client={client} onOpenSettings={() => {}} onToast={vi.fn()} />,
          ),
        );
        await until(() => cursorsAsked(listThreads).length === 1, "the end asks p2");

        // The column got five rows shorter with its end in view, so the end
        // asks again, and is answered: no lock stands in its way. The page
        // that was already out is the older ask and is let go, as any Load
        // more a newer one overtakes is.
        await click(findButton("Done — archive all 5 in Newsletters"));
        expect(cursorsAsked(listThreads)).toEqual(["p2", "p2"]);
        await act(async () => pageTwo.resolve(pageOf(deepRows.slice(45, 95))));
        await settle();
        await settle();
        // The page landed in the column, under a Newsletters that stays gone.
        expect(document.body.textContent).toContain("95 threads, nothing unread");
        expect(
          document.body.querySelector('section[aria-label="Newsletters"]'),
        ).toBeNull();
        expect(cursorsAsked(listThreads)).toEqual(["p2", "p2"]);
        expect(updateThread).not.toHaveBeenCalled();
      });

      /** Scrolling with the end in view against a five-page account whose
       *  pages answer 200 ms after they are asked, the way a real server
       *  staggers them. Each case moves the column's epoch under a page that
       *  is on the way, so that page's answer is dropped and asked again: once,
       *  not every time the next Load more drops the one before it. */
      describe("with answers that take their time", () => {
        const later = <T,>(value: T, ms = 200) =>
          new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

        /** Account A's page `n` (2 to 5) of a five-page stream. */
        function deepPage(n: number): MailThreadPage {
          const rows = Array.from({ length: 50 }, (_value, index) =>
            unifiedThread({
              accountId: accountA.accountId,
              threadId: `deep ${n}-${index}`,
              lastMessageAt: 1_700_000_900_000 - ((n - 1) * 50 + index) * 1_000,
              unread: false,
            }),
          );
          return pageOf(rows, n < 5 ? `p${n + 1}` : null);
        }

        const bOnly = unifiedThread({
          accountId: accountB.accountId,
          threadId: "B only",
          lastMessageAt: 1_600_000_000_000,
        });

        /** Account A answers its pages late; the first read of page two waits
         *  on `pageTwo`. `answerB` answers B's page-one reads by count. */
        function slowClient(
          pageTwo: Promise<MailThreadPage> | null,
          answerB: (read: number) => Promise<MailThreadPage>,
        ) {
          let bReads = 0;
          let pageTwoReads = 0;
          return vi.fn().mockImplementation(({ accountId, cursor }) => {
            if (accountId === accountB.accountId) {
              bReads += 1;
              return answerB(bReads);
            }
            if (!cursor) return Promise.resolve(pageOf(deepRows.slice(0, 50), "p2"));
            if (cursor === "p2" && pageTwo !== null) {
              pageTwoReads += 1;
              if (pageTwoReads === 1) return pageTwo;
            }
            return later(deepPage(Number(cursor.slice(1))));
          });
        }

        async function tenSeconds() {
          for (let step = 0; step < 100; step += 1) await wait(100);
        }

        it("asks for a dropped page once when a mail event brings new mail", async () => {
          vi.useFakeTimers();
          sentinelInView();
          const pageTwo = deferred<MailThreadPage>();
          const listThreads = slowClient(pageTwo.promise, (read) =>
            Promise.resolve(
              pageOf(
                read === 1
                  ? [bOnly]
                  : [
                      unifiedThread({
                        accountId: accountB.accountId,
                        threadId: "B arrived",
                        lastMessageAt: 1_700_001_000_000,
                      }),
                      bOnly,
                    ],
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
          await until(() => cursorsAsked(listThreads).length === 1, "the end asks p2");
          // B's letter arrives: only B's page one is read, and the column's
          // epoch still moves under A's page two.
          await mailEvent({
            kind: "mail",
            changeKind: "sync",
            accountId: accountB.accountId,
            mailboxIds: ["inbox"],
          });
          await wait(MAIL_EVENT_DEBOUNCE_MS);
          await wait(100);
          await act(async () => pageTwo.resolve(deepPage(2)));
          await settle();
          await tenSeconds();

          expect(cursorsAsked(listThreads)).toEqual(["p2", "p2", "p3", "p4", "p5"]);
        });

        it("asks for a dropped page once when a held account heals", async () => {
          vi.useFakeTimers();
          sentinelInView();
          const pageTwo = deferred<MailThreadPage>();
          const listThreads = slowClient(pageTwo.promise, (read) =>
            read === 1 ? Promise.reject(held()) : Promise.resolve(pageOf([bOnly])),
          );
          const client = makeClient({
            loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
            listThreads,
          });
          await act(async () =>
            root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
          );
          await until(() => cursorsAsked(listThreads).length === 1, "the end asks p2");
          await wait(1_500);
          await wait(100);
          await act(async () => pageTwo.resolve(deepPage(2)));
          await settle();
          await tenSeconds();

          expect(cursorsAsked(listThreads)).toEqual(["p2", "p2", "p3", "p4", "p5"]);
        });

        it("asks for a dropped page once when Load more is pressed while it is on the way", async () => {
          vi.useFakeTimers();
          sentinelInView();
          const listThreads = slowClient(null, () => Promise.resolve(pageOf([bOnly])));
          const client = makeClient({
            loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
            listThreads,
          });
          await act(async () =>
            root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
          );
          await until(() => cursorsAsked(listThreads).length === 1, "the end asks p2");
          await wait(100);
          await click(findButton("Load more"));
          await tenSeconds();

          expect(cursorsAsked(listThreads)).toEqual(["p2", "p2", "p3", "p4", "p5"]);
        });
      });
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

      /** The pill Done posted last, as the shell holds it: the sentence with
       *  its Undo, its window and what to do when the window closes. */
      function donePill(onToast: ReturnType<typeof vi.fn>): ToastOptions {
        const call = [...onToast.mock.calls]
          .reverse()
          .find(
            ([, options]) =>
              (options as ToastOptions | undefined)?.id === "mail-section-done" &&
              (options as ToastOptions | undefined)?.actionLabel === "Undo",
          );
        if (!call) throw new Error("Done posted no pill");
        return call[1] as ToastOptions;
      }

      /** The window ran out with the Undo unpressed. The shell owns the
       *  window and says so through `onExpire`, which is where the commit
       *  begins. */
      async function closeWindow(onToast: ReturnType<typeof vi.fn>) {
        const pill = donePill(onToast);
        await act(async () => pill.onExpire?.());
        await drain();
      }

      function threadsList(): string {
        return (
          document.body.querySelector('[aria-label="All inboxes threads"]')
            ?.textContent ?? ""
        );
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

      it("takes a bundled section whole once its window closes: archive first, then read", async () => {
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
        // The section is gone and the way back is on screen. Nothing has
        // been sent: the archives wait behind the pill's window.
        expect(
          document.body.querySelector('section[aria-label="Newsletters"]'),
        ).toBeNull();
        expect(updateThread).not.toHaveBeenCalled();

        await closeWindow(onToast);
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
        // Success is silent: the one sentence was said at the press, and the
        // pill that said it is already gone.
        expect(onToast).toHaveBeenCalledTimes(1);
        expect(onToast).toHaveBeenCalledWith(
          "Newsletters cleared",
          expect.objectContaining({
            subtitle: "8 threads out of your inbox",
            actionLabel: "Undo",
          }),
        );
      });

      it("sends at the press when there is no pill to offer the way back in", async () => {
        // No toast channel, no Undo, and so no window to wait out: the
        // protection Done defers for is not there to defer for.
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
        await drain();
        expect(updateThread).toHaveBeenCalledTimes(1);

        // Leaving All inboxes does not stop it. The run used to end at the
        // switch and leave the rest of the section in the inbox.
        await enterSingleAccount();
        await act(async () => firstMutation.resolve());
        await drain();
        expect(updateThread.mock.calls.map((call) => call[0].threadId)).toEqual(
          ["bulk-1", "bulk-1", "bulk-2", "bulk-2", "bulk-3", "bulk-3"],
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
        await closeWindow(onToast);

        // The failed thread was never marked read either: a failed archive
        // leaves it exactly as it stood, unread and in its section.
        expect(
          updateThread.mock.calls.filter(
            (call) => call[0].threadId === "bulk-2",
          ),
        ).toHaveLength(1);
        expect(threadsList()).toContain("bulk-2");
        expect(threadsList()).not.toContain("bulk-1");
        expect(threadsList()).not.toContain("bulk-3");
        // One report, when the run has landed, and no way back on it: the
        // window closed before the first request went out.
        expect(onToast).toHaveBeenCalledTimes(2);
        expect(onToast).toHaveBeenLastCalledWith(
          "People partly cleared",
          expect.objectContaining({ subtitle: "2 archived, 1 stayed put" }),
        );
        expect(onToast.mock.calls.at(-1)?.[1]?.actionLabel).toBeUndefined();
        expect(onToast.mock.calls.at(-1)?.[1]?.onAction).toBeUndefined();
      });

      it("empties the column at the press with the ring already counting, and sends nothing inside the window", async () => {
        // The owner met this as a pill that stood for half a minute with no
        // ring while every other mail action was refused. The press now arms
        // the window every other Undo in Brain uses, at once, and the
        // requests wait behind it.
        const items = [1, 2, 3, 4].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `bulk-${index}`,
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

        await click(findButton("Done — archive all 4 in People"));
        await drain();

        expect(
          document.body.querySelector('section[aria-label="People"]'),
        ).toBeNull();
        // A real window from the press: the shell draws the ring wherever
        // there is a deadline, and `null` was the pill with none.
        expect(onToast).toHaveBeenCalledTimes(1);
        expect(onToast).toHaveBeenCalledWith(
          "People cleared",
          expect.objectContaining({
            icon: "check-linear",
            subtitle: "4 threads out of your inbox",
            actionLabel: "Undo",
            durationMs: SMART_UNDO_MS,
          }),
        );
        expect(donePill(onToast).pendingLabel).toBeUndefined();
        expect(updateThread).not.toHaveBeenCalled();

        await closeWindow(onToast);
        expect(updateThread).toHaveBeenCalledTimes(8);
        // Nothing is said a second time when everything went.
        expect(onToast).toHaveBeenCalledTimes(1);
      });

      it("Undo inside the window puts the rows back with no request at all", async () => {
        const items = [1, 2, 3].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `bulk-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(pageOf(accountId === accountA.accountId ? items : [])),
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
        const reads = listThreads.mock.calls.length;

        await click(findButton("Done — archive all 3 in People"));
        expect(threadsList()).not.toContain("bulk-1");
        const pill = donePill(onToast);

        // The press is taken and spent on the spot: there is no loop to stop
        // and nothing to reverse, so it answers neither `false` nor a promise.
        let answer: unknown;
        await act(async () => {
          answer = pill.onAction?.();
        });
        await drain();
        expect(answer).toBeUndefined();
        expect(threadsList()).toContain("bulk-1");
        expect(threadsList()).toContain("bulk-2");
        expect(threadsList()).toContain("bulk-3");
        expect(findButton("Done — archive all 3 in People")).toBeTruthy();
        expect(updateThread).not.toHaveBeenCalled();
        expect(listThreads).toHaveBeenCalledTimes(reads);
        expect(onToast).toHaveBeenCalledTimes(1);

        // A pill that outlives its Undo has nothing left to send or to give
        // back: the window closing on it is not a commit, and a second press
        // is refused.
        await act(async () => pill.onExpire?.());
        await drain();
        expect(updateThread).not.toHaveBeenCalled();
        expect(pill.onAction?.()).toBe(false);
      });

      it("keeps the rows out through a list read made inside the window", async () => {
        vi.useFakeTimers();
        const items = [1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `bulk-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const updateThread = vi.fn().mockResolvedValue(undefined);
        // The server has been told nothing, so every read still lists them.
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(pageOf(accountId === accountA.accountId ? items : [])),
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
        const reads = listThreads.mock.calls.length;

        await click(findButton("Done — archive all 2 in People"));
        await mailEvent({
          kind: "mail",
          changeKind: "sync",
          accountId: accountA.accountId,
          mailboxIds: ["inbox"],
        });
        await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
        await drain();

        expect(listThreads.mock.calls.length).toBeGreaterThan(reads);
        expect(threadsList()).not.toContain("bulk-1");
        expect(threadsList()).not.toContain("bulk-2");
        expect(updateThread).not.toHaveBeenCalled();

        // And Undo still brings them back, from the streams that never
        // dropped them.
        await act(async () => {
          donePill(onToast).onAction?.();
        });
        await drain();
        expect(threadsList()).toContain("bulk-1");
        expect(threadsList()).toContain("bulk-2");
      });

      it("says nothing more through a long run, and lets another mail action through it", async () => {
        // Forty read threads under Done, the scale a busy Seen section
        // reaches. The run used to hold the mail lock from the press to the
        // last request, and every other action answered "Finish the current
        // mail action first" for minutes.
        const person = unifiedThread({
          accountId: accountA.accountId,
          threadId: "p-1",
          lastMessageAt: 1_700_000_001_000,
        });
        const seen = Array.from({ length: 40 }, (_value, index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `seen-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const items = [person, ...seen];
        // One thread in the middle holds the queue, which is what a real
        // custom-domain mutation does: its own connect, authenticate and
        // logout with no pool behind it.
        const midRun = deferred<void>();
        const updateThread = vi
          .fn()
          .mockImplementation(({ threadId }: { threadId: string }) =>
            threadId === "seen-19" ? midRun.promise : Promise.resolve(undefined),
          );
        const readThread = vi.fn().mockResolvedValue({
          ...detail,
          thread: person,
          messages: detail.messages.map((message) => ({
            ...message,
            threadId: person.threadId,
          })),
        });
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

        await click(findButton("Done — archive all 40 in Seen"));
        expect(onToast).toHaveBeenCalledTimes(1);
        expect(onToast).toHaveBeenCalledWith(
          "Seen cleared",
          expect.objectContaining({
            subtitle: "40 threads out of your inbox",
            actionLabel: "Undo",
            durationMs: SMART_UNDO_MS,
          }),
        );

        // The window closes and the queue runs: twenty threads in and stuck
        // on the twentieth.
        await closeWindow(onToast);
        expect(updateThread).toHaveBeenCalledTimes(20);
        expect(onToast).toHaveBeenCalledTimes(1);

        // Opening the unread People letter reads it, and E archives it, both
        // while the queue is still out on its twentieth request.
        await click(findButton("p-1"));
        await drain();
        const forPerson = () =>
          updateThread.mock.calls
            .map((call) => call[0] as Record<string, unknown>)
            .filter((input) => input.threadId === "p-1");
        expect(forPerson()).toEqual([
          { accountId: accountA.accountId, threadId: "p-1", read: true },
        ]);
        await act(async () => {
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "e", cancelable: true }),
          );
        });
        await drain();
        expect(forPerson()).toEqual([
          { accountId: accountA.accountId, threadId: "p-1", read: true },
          { accountId: accountA.accountId, threadId: "p-1", archive: true },
        ]);
        expect(threadsList()).not.toContain("p-1");
        expect(
          onToast.mock.calls.filter(([, options]) => options?.urgent === true),
        ).toEqual([]);

        await act(async () => midRun.resolve());
        await drain();
        expect(
          updateThread.mock.calls.filter((call) =>
            String(call[0].threadId).startsWith("seen-"),
          ),
        ).toHaveLength(40);
        // Everything went, so Done never spoke again: nothing after the
        // press-time pill reports on the section.
        expect(
          onToast.mock.calls.filter(([title]) => String(title).includes("Seen")),
        ).toHaveLength(1);
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
        expect(threadsList()).not.toContain("bulk-1");
        await closeWindow(onToast);

        // The rows that could not leave are back in the column, and one
        // report says why.
        expect(updateThread).toHaveBeenCalledTimes(1);
        expect(threadsList()).toContain("bulk-1");
        expect(threadsList()).toContain("bulk-3");
        expect(findButton("Done — archive all 3 in People")).toBeTruthy();
        expect(onToast).toHaveBeenCalledTimes(2);
        expect(onToast).toHaveBeenLastCalledWith(
          "Couldn’t clear People",
          expect.objectContaining({
            icon: "danger-triangle-linear",
            subtitle: "3 threads stayed put, that account has no folder for it",
          }),
        );
        expect(onToast.mock.calls.at(-1)?.[1]?.actionLabel).toBeUndefined();
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
        await closeWindow(onToast);

        // One refusal closes A. B's thread still goes out, because its server
        // never said anything of the kind.
        expect(
          updateThread.mock.calls.filter(
            (call) => call[0].accountId === accountA.accountId,
          ),
        ).toHaveLength(1);
        expect(threadsList()).toContain("bulk-1");
        expect(threadsList()).not.toContain("bulk-2");
        expect(threadsList()).toContain("bulk-3");
        expect(onToast).toHaveBeenLastCalledWith(
          "People partly cleared",
          expect.objectContaining({
            subtitle:
              "1 archived, 2 stayed put, that account has no folder for it",
          }),
        );
        expect(onToast.mock.calls.at(-1)?.[1]?.actionLabel).toBeUndefined();
      });

      it("holds an archived row out against a read that left before the archive, and lets a later read speak", async () => {
        vi.useFakeTimers();
        const items = [1, 2, 3].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `bulk-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const updateThread = vi.fn().mockResolvedValue(undefined);
        // What account A's next page-one reads answer, in order.
        const answers: Array<Promise<MailThreadPage>> = [];
        const listThreads = vi.fn().mockImplementation(({ accountId }) => {
          if (accountId !== accountA.accountId) return Promise.resolve(pageOf([]));
          return answers.shift() ?? Promise.resolve(pageOf(items));
        });
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
        const readAgain = async () => {
          await mailEvent({
            kind: "mail",
            changeKind: "sync",
            accountId: accountA.accountId,
            mailboxIds: ["inbox"],
          });
          await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
          await drain();
        };

        await click(findButton("Done — archive all 3 in Seen"));
        // A read leaves while the window is still open, and stays out.
        const early = deferred<MailThreadPage>();
        answers.push(early.promise);
        await readAgain();

        await closeWindow(onToast);
        expect(updateThread).toHaveBeenCalledTimes(3);

        // It answers after the archives did, with what the server held when
        // it was asked: all three. The hold keeps them out of the column.
        await act(async () => early.resolve(pageOf(items)));
        await drain();
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();

        // The next read to land is the other account's. It began after the
        // archives, and it says nothing about these rows: the hold stands.
        await mailEvent({
          kind: "mail",
          changeKind: "sync",
          accountId: accountB.accountId,
          mailboxIds: ["inbox"],
        });
        await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
        await drain();
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();

        // Account A's own read, begun after the archives, lists none of
        // them: the hold ends on it and the rows are swept from the stream.
        answers.push(Promise.resolve(pageOf([])));
        await readAgain();
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();

        // One comes back by hand, Move to Inbox, and the next read lists it.
        // The hold is over, so the row shows.
        answers.push(Promise.resolve(pageOf([items[1]!])));
        await readAgain();
        expect(threadsList()).toContain("1 thread, nothing unread");
      });

      const timedOut = () =>
        new DOMException("mail mutation unanswered after 15000ms", "TimeoutError");

      it("a mutation the clock gave up on closes its account for the run, and its rows come back", async () => {
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
        await closeWindow(onToast);

        expect(updateThread.mock.calls.map((call) => call[0])).toEqual([
          { accountId: accountA.accountId, threadId: "a-0", archive: true },
          { accountId: accountA.accountId, threadId: "a-1", archive: true },
          { accountId: accountB.accountId, threadId: "b-0", archive: true },
        ]);
        expect(onToast).toHaveBeenLastCalledWith(
          "Seen partly cleared",
          expect.objectContaining({
            subtitle: "2 archived, 2 stayed put, that account stopped answering",
          }),
        );
        expect(onToast.mock.calls.at(-1)?.[1]?.actionLabel).toBeUndefined();
        // Seen keeps the two that stayed (a-1, a-2); the two that left are
        // out. The section is collapsed, so it is the count that says so.
        expect(threadsList()).toContain("2 threads, nothing unread");
      });

      it("sends everything still unsent with keepalive when the page starts unloading, and the pill loses its Undo", async () => {
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
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

        await click(findButton("Done — archive all 3 in Seen"));
        const pill = donePill(onToast);
        onToast.mockClear();

        // Inside the window. A queue that awaited its way through the three
        // would be cut at the first request, so they leave in the handler,
        // bounded and allowed to outlive the tab.
        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
        expect(updateThread.mock.calls).toEqual([
          [
            { accountId: accountA.accountId, threadId: "a-0", archive: true },
            undefined,
            { keepalive: true },
          ],
          [
            { accountId: accountA.accountId, threadId: "a-1", archive: true },
            undefined,
            { keepalive: true },
          ],
          [
            { accountId: accountA.accountId, threadId: "a-2", archive: true },
            undefined,
            { keepalive: true },
          ],
        ]);
        await drain();

        // The page may come back from the back-forward cache with this DOM:
        // the pill it shows must not offer an Undo over archives already out.
        expect(onToast).toHaveBeenCalledTimes(1);
        expect(onToast).toHaveBeenCalledWith(
          "Seen cleared",
          expect.objectContaining({
            id: "mail-section-done",
            subtitle: "3 threads out of your inbox",
          }),
        );
        expect(onToast.mock.calls[0]?.[1]?.actionLabel).toBeUndefined();
        expect(pill.onAction?.()).toBe(false);
        expect(updateThread).toHaveBeenCalledTimes(3);
      });

      it("lets a waiting Done go when the Mail surface unmounts, and the pill loses its Undo", async () => {
        const items = [0, 1].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
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

        await click(findButton("Done — archive all 2 in Seen"));
        onToast.mockClear();

        // A route change inside Brain takes the column that could show the
        // rows again with it, so the archives go out now, one after the
        // other. Every request a Done makes may outlive the page.
        await act(async () => root.render(<div>Home</div>));
        await drain();
        expect(updateThread.mock.calls).toEqual([
          [
            { accountId: accountA.accountId, threadId: "a-0", archive: true },
            undefined,
            { keepalive: true },
          ],
          [
            { accountId: accountA.accountId, threadId: "a-1", archive: true },
            undefined,
            { keepalive: true },
          ],
        ]);
        expect(onToast).toHaveBeenCalledWith(
          "Seen cleared",
          expect.objectContaining({ id: "mail-section-done" }),
        );
        expect(onToast.mock.calls[0]?.[1]?.actionLabel).toBeUndefined();
      });

      it("a run the reader walked out of keeps sending, and the Inbox they walked into never shows its rows", async () => {
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        // The server lists a thread until its archive has answered.
        const archived = new Set<string>();
        const midRun = deferred<void>();
        const updateThread = vi
          .fn()
          .mockImplementation(async ({ threadId }: { threadId: string }) => {
            if (threadId === "a-1") await midRun.promise;
            archived.add(threadId);
          });
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(
            pageOf(
              accountId === accountA.accountId
                ? items.filter((item) => !archived.has(item.threadId))
                : [],
            ),
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
        await closeWindow(onToast);
        expect(updateThread).toHaveBeenCalledTimes(2);

        // Out of All inboxes and into account A while a-1 is still in
        // flight. The single list loads at once, and the server still lists
        // the one in flight and the one not yet sent: neither is drawn.
        await enterSingleAccount(accountA);
        await drain();
        const single = () =>
          document.body.querySelector('section[aria-label="Mailbox"]')
            ?.textContent ?? "";
        expect(navTrigger()?.getAttribute("aria-label")).toContain("Inbox");
        for (const id of ["a-0", "a-1", "a-2"]) {
          expect(single()).not.toContain(id);
        }

        await act(async () => midRun.resolve());
        await drain();
        // The run went on to its end, and with everything gone it has
        // nothing to report.
        expect(updateThread.mock.calls.map((call) => call[0].threadId)).toEqual([
          "a-0",
          "a-1",
          "a-2",
        ]);
        expect(onToast).toHaveBeenCalledTimes(1);
        for (const id of ["a-0", "a-1", "a-2"]) {
          expect(single()).not.toContain(id);
        }
      });

      it("a letter opened while the lock is held is marked read once the lock lifts", async () => {
        const people = unifiedThread({
          accountId: accountA.accountId,
          threadId: "p-1",
          lastMessageAt: 1_700_000_000_000,
        });
        const other = unifiedThread({
          accountId: accountA.accountId,
          threadId: "p-2",
          lastMessageAt: 1_700_000_000_000 - 1,
        });
        const items = [people, other];
        // Done holds no lock any more, so the holder here is the action that
        // still does: the read flag an opened letter sends.
        const firstRead = deferred<void>();
        const updateThread = vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) =>
            input.threadId === "p-2" ? firstRead.promise : Promise.resolve(undefined),
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

        await click(findButton("p-2"));
        await drain();
        expect(updateThread).toHaveBeenCalledTimes(1);
        // Open the other unread letter while that read flag holds the lock.
        await click(findButton("p-1"));
        await drain();
        const readFlags = () =>
          updateThread.mock.calls.filter(
            (call) => call[0].threadId === "p-1" && call[0].read === true,
          );
        // Not yet: the lock is held and the mark-read is not spent for it.
        expect(readFlags()).toHaveLength(0);

        await act(async () => firstRead.resolve());
        await drain();
        // The lock lifted and the open letter is read, once.
        expect(readFlags()).toHaveLength(1);
      });

      const stale = () => new MailApiError(409, "mail_thread_stale");

      it("a thread that changed on the server under Done is named and kept out", async () => {
        // `mail_thread_stale`: the service says the letter is no longer what
        // the list said — moved by another client, or its mailbox re-keyed.
        // It did not "stay put": it is not where the column had it, so it is
        // not put back.
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
        await closeWindow(onToast);
        expect(onToast).toHaveBeenLastCalledWith(
          "Seen partly cleared",
          expect.objectContaining({
            subtitle: "2 archived, 1 changed on the server",
          }),
        );
        expect(onToast.mock.calls.at(-1)?.[1]?.actionLabel).toBeUndefined();
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();
      });

      it("reads the list no more than once per change while fifteen threads go out", async () => {
        // Every mutation the queue sends comes back as a mail event, and an
        // event is a page-one read. Thirty of them must not become a storm:
        // a burst is one read, and a slow run is at most one read a change.
        vi.useFakeTimers();
        const items = Array.from({ length: 15 }, (_value, index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `nl-${index}`,
            category: "newsletter",
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const archived = new Set<string>();
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(
            pageOf(
              accountId === accountA.accountId
                ? items.filter((item) => !archived.has(item.threadId))
                : [],
            ),
          ),
        );
        // A mutation answers a quarter of a second after it is asked, and the
        // service says so on the change feed, the way #126 has it.
        const updateThread = vi.fn().mockImplementation(
          (input: { threadId: string; archive?: boolean }) =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                if (input.archive === true) archived.add(input.threadId);
                window.dispatchEvent(
                  new CustomEvent(MAIL_CHANGED_EVENT, {
                    detail: {
                      kind: "mail",
                      changeKind: "sync",
                      accountId: accountA.accountId,
                      mailboxIds: ["inbox"],
                    } satisfies BrainMailEvent,
                  }),
                );
                resolve();
              }, 250);
            }),
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

        await click(findButton("Done — archive all 15 in Newsletters"));
        const before = listThreads.mock.calls.length;
        const pill = donePill(onToast);
        await act(async () => pill.onExpire?.());

        // Thirty mutations a quarter of a second apart, and then the last
        // event's own debounce. A row that came back at any step would show
        // as a Newsletters section again.
        for (let step = 0; step < 34; step += 1) {
          await act(async () => vi.advanceTimersByTimeAsync(250));
          expect(
            document.body.querySelector('section[aria-label="Newsletters"]'),
          ).toBeNull();
        }
        await drain();
        expect(updateThread).toHaveBeenCalledTimes(30);
        // Events 250ms apart keep pushing the 400ms debounce on, so the whole
        // run is read once, when it goes quiet. One change, one read, is the
        // ceiling whatever the spacing.
        const reads = listThreads.mock.calls.length - before;
        expect(reads).toBeGreaterThanOrEqual(1);
        expect(reads).toBeLessThanOrEqual(2);
        expect(onToast).toHaveBeenCalledTimes(1);
      });

      it("a second Done commits the first at once and opens a window of its own", async () => {
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
        const first = donePill(onToast);
        expect(updateThread).not.toHaveBeenCalled();

        // The second press is not refused. It lets the first go, which is
        // one pill and one way back at a time, and takes the pill under the
        // same id.
        await click(findButton("Done — archive all 1 in Notifications"));
        expect(updateThread.mock.calls.map((call) => call[0])).toEqual([
          { accountId: accountA.accountId, threadId: "p-1", archive: true },
        ]);
        expect(
          document.body.querySelector('section[aria-label="Notifications"]'),
        ).toBeNull();
        expect(onToast).toHaveBeenLastCalledWith(
          "Notifications cleared",
          expect.objectContaining({
            subtitle: "1 thread out of your inbox",
            actionLabel: "Undo",
            durationMs: SMART_UNDO_MS,
            id: "mail-section-done",
          }),
        );
        expect(
          onToast.mock.calls.filter(([, options]) => options?.urgent === true),
        ).toEqual([]);
        // The first Done's way back went with its commit.
        expect(first.onAction?.()).toBe(false);

        // The second window is its own: its Undo works while the first is
        // still sending, and its thread never goes out.
        const second = donePill(onToast);
        await act(async () => {
          second.onAction?.();
        });
        await act(async () => firstArchive.resolve());
        await drain();
        expect(updateThread.mock.calls.map((call) => call[0].threadId)).toEqual([
          "p-1",
          "p-1",
          "p-2",
          "p-2",
        ]);
        expect(
          document.body.querySelector('section[aria-label="Notifications"]'),
        ).not.toBeNull();
        expect(
          document.body.querySelector('section[aria-label="People"]'),
        ).toBeNull();
      });

      it("closes the letter a Done takes, and walks and counts as if its rows were gone", async () => {
        const people = [1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `p-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const notes = [1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `n-${index}`,
            category: "notification",
            lastMessageAt: 1_600_000_000_000 - index,
          }),
        );
        const items = [...people, ...notes];
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const readThread = vi.fn().mockImplementation(({ threadId }) =>
          Promise.resolve({
            ...detail,
            thread: items.find((item) => item.threadId === threadId),
          }),
        );
        const onToast = vi.fn();
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        });
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

        // The reader holds one of the letters Done is about to take.
        await click(findButton("p-1"));
        await drain();
        const open = () =>
          document.body
            .querySelector('[aria-label="All inboxes threads"] [aria-current="true"]')
            ?.textContent ?? null;
        expect(open()).toContain("p-1");
        updateThread.mockClear();

        await click(findButton("Done — archive all 2 in People"));
        expect(open()).toBeNull();
        expect(
          document.body.querySelector('section[aria-label="People"]'),
        ).toBeNull();
        // The sections that stay still count what they hold.
        expect(findButton("Done — archive all 2 in Notifications")).toBeTruthy();

        // J lands on the first row that is drawn, never on a hidden one the
        // stream still holds above it.
        await act(async () => {
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "j", cancelable: true }),
          );
        });
        await drain();
        expect(open()).toContain("n-1");
        expect(readThread.mock.calls.at(-1)?.[0]).toMatchObject({ threadId: "n-1" });
        expect(
          updateThread.mock.calls.filter((call) =>
            String(call[0].threadId).startsWith("p-"),
          ),
        ).toEqual([]);
      });

      /** What the queue sent, without the account: `{ threadId, archive }`,
       *  with `keepalive` named where the request carried it. */
      const sent = (updateThread: ReturnType<typeof vi.fn>) =>
        updateThread.mock.calls.map((call) => {
          const rest: Record<string, unknown> = Object.fromEntries(
            Object.entries(call[0] as Record<string, unknown>).filter(
              ([name]) => name !== "accountId",
            ),
          );
          return (call[2] as { keepalive?: boolean } | undefined)?.keepalive
            ? { ...rest, keepalive: true }
            : rest;
        });

      const detailOf = (items: readonly MailThreadListItem[]) =>
        vi.fn().mockImplementation(({ threadId }: { threadId: string }) => {
          const opened = items.find((item) => item.threadId === threadId) ?? items[0]!;
          return Promise.resolve({
            ...detail,
            thread: opened,
            messages: detail.messages.map((message) => ({
              ...message,
              threadId: opened.threadId,
            })),
          });
        });

      const openRow = () =>
        document.body
          .querySelector('[aria-label="All inboxes threads"] [aria-current="true"]')
          ?.textContent ?? null;

      it("takes a letter someone asked for out of a waiting Done, and opens it", async () => {
        const items = [1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `p-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const readThread = detailOf(items);
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(pageOf(accountId === accountA.accountId ? items : [])),
        );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread, readThread, listThreads })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();
        await click(findButton("Done — archive all 2 in People"));
        const reads = listThreads.mock.calls.length;

        // A notification pressed for a letter that just left the column. The
        // press names the letter, and that outranks the Done: it comes out
        // of the run, back into the column, and opens where the reader is.
        await act(async () => {
          requestOpenThread(accountA.accountId, "p-1");
        });
        await drain();
        expect(pendingOpenThread()).toBeNull();
        expect(readThread.mock.calls.map((call) => call[0].threadId)).toEqual(["p-1"]);
        expect(openRow()).toContain("p-1");
        expect(threadsList()).not.toContain("p-2");
        expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: All inboxes");
        expect(listThreads).toHaveBeenCalledTimes(reads);

        // The window closes on what the run still holds: the other letter.
        // The one that was opened is read, as any opened letter is, and
        // never archived.
        await closeWindow(onToast);
        expect(sent(updateThread).filter((mutation) => "archive" in mutation)).toEqual([
          { threadId: "p-2", archive: true, keepalive: true },
        ]);
        expect(threadsList()).toContain("p-1");
        expect(onToast).toHaveBeenCalledTimes(1);
      });

      it("takes a letter someone asked for out of a run the queue has not sent it for", async () => {
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const first = deferred<void>();
        const updateThread = vi
          .fn()
          .mockReturnValueOnce(first.promise)
          .mockResolvedValue(undefined);
        const readThread = detailOf(items);
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
        await click(findButton("Done — archive all 3 in Seen"));
        await closeWindow(onToast);
        expect(sent(updateThread)).toHaveLength(1);

        await act(async () => {
          requestOpenThread(accountA.accountId, "a-2");
        });
        await drain();
        expect(readThread.mock.calls.map((call) => call[0].threadId)).toEqual(["a-2"]);
        // Taken out is not a failure: the run has nothing to report for it.
        await act(async () => first.resolve());
        await drain();
        expect(sent(updateThread).map((mutation) => mutation.threadId)).toEqual([
          "a-0",
          "a-1",
        ]);
        expect(threadsList()).toContain("1 thread, nothing unread");
        expect(onToast).toHaveBeenCalledTimes(1);
      });

      it("follows a request for a letter Done has already archived to the mailbox it names", async () => {
        // The palette found the letter in All Mail. Its archive has answered
        // and its hold stands until the Inbox is read again, with the row
        // still in the stream under it. That row is not a row of the column:
        // opening it there would open a letter the list does not draw.
        const items = [
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "a-0",
            unread: false,
            lastMessageAt: 1_700_000_000_000,
          }),
        ];
        const archived = new Set<string>();
        const updateThread = vi
          .fn()
          .mockImplementation(async ({ threadId }: { threadId: string }) => {
            archived.add(threadId);
          });
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(
            pageOf(
              accountId === accountA.accountId
                ? items.filter((item) => !archived.has(item.threadId))
                : [],
            ),
          ),
        );
        const readMailboxThread = vi.fn().mockResolvedValue({ ...detail, thread: items[0] });
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { updateThread, listThreads, readMailboxThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();
        await click(findButton("Done — archive all 1 in Seen"));
        await closeWindow(onToast);
        expect(sent(updateThread)).toHaveLength(1);

        await act(async () => {
          requestOpenThread(accountA.accountId, "a-0", "all");
        });
        await drain();
        expect(navTrigger()?.getAttribute("aria-label")).toContain("All Mail");
        expect(readMailboxThread).toHaveBeenCalledWith(
          expect.objectContaining({ mailboxId: "all", threadId: "a-0" }),
        );
      });

      it("does not archive a letter that got a reply inside the window, and says so", async () => {
        vi.useFakeTimers();
        const original = unifiedThread({
          accountId: accountA.accountId,
          threadId: "p-1",
          messageCount: 1,
          lastMessageAt: 1_700_000_000_000,
        });
        const other = unifiedThread({
          accountId: accountA.accountId,
          threadId: "p-2",
          messageCount: 1,
          lastMessageAt: 1_699_999_999_000,
        });
        let server: MailThreadListItem[] = [original, other];
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(pageOf(accountId === accountA.accountId ? server : [])),
        );
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(server, { updateThread, listThreads })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();
        await click(findButton("Done — archive all 2 in People"));

        // A reply lands on the server inside the window. A provider's archive
        // acts on every message the thread has when it is called, so sending
        // the press-time snapshot would file the reply away, read, unseen.
        server = [
          { ...original, messageCount: 2, lastMessageAt: 1_700_000_060_000 },
          other,
        ];
        await mailEvent({
          kind: "mail",
          changeKind: "sync",
          accountId: accountA.accountId,
          mailboxIds: ["inbox"],
        });
        await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
        await drain();
        expect(updateThread).not.toHaveBeenCalled();

        await closeWindow(onToast);
        expect(sent(updateThread)).toEqual([
          { threadId: "p-2", archive: true, keepalive: true },
          { threadId: "p-2", read: true, keepalive: true },
        ]);
        // The letter with the reply is back in the column, unread, and the
        // one report counts it. It stands five seconds: long enough to read,
        // with no Undo to wait for and no pill id to take from a later Done.
        expect(threadsList()).toContain("p-1");
        expect(threadsList()).not.toContain("p-2");
        expect(onToast).toHaveBeenCalledTimes(2);
        expect(onToast).toHaveBeenLastCalledWith("People partly cleared", {
          icon: "check-linear",
          subtitle: "1 archived, 1 got new mail and stayed",
          durationMs: 5_000,
        });
      });

      it("keeps its holds and its queue through a trip out of Mail, and sends each thread once", async () => {
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        // The server lists a thread until its archive has answered.
        const archived = new Set<string>();
        const first = deferred<void>();
        const updateThread = vi
          .fn()
          .mockImplementation(async ({ threadId }: { threadId: string }) => {
            if (threadId === "a-0") await first.promise;
            archived.add(threadId);
          });
        const listThreads = vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(
            pageOf(
              accountId === accountA.accountId
                ? items.filter((item) => !archived.has(item.threadId))
                : [],
            ),
          ),
        );
        const onToast = vi.fn();
        const client = unifiedClient(items, { updateThread, listThreads });
        const noSettings = () => {};
        const surface = () => (
          <MailSurface client={client} onOpenSettings={noSettings} onToast={onToast} />
        );
        await act(async () => root.render(surface()));
        await settle();
        await click(findButton("Done — archive all 3 in Seen"));

        // Out of Mail inside the window: the run goes to the queue, and its
        // first archive is still out when the reader comes back.
        await act(async () => root.render(<div>Home</div>));
        await drain();
        expect(sent(updateThread).map((mutation) => mutation.threadId)).toEqual(["a-0"]);
        await act(async () => root.render(surface()));
        await drain();

        // A new mount, a fresh list that still names all three, and the same
        // holds: the section is not drawn, so there is no second Done to
        // press over it and no second queue to send the three again.
        expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: All inboxes");
        expect(listThreads.mock.calls.at(-1)?.[0]).toMatchObject({
          accountId: expect.any(String),
        });
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();

        await act(async () => first.resolve());
        await drain();
        expect(sent(updateThread).map((mutation) => mutation.threadId)).toEqual([
          "a-0",
          "a-1",
          "a-2",
        ]);
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();
        expect(
          onToast.mock.calls.filter(([, options]) => options?.actionLabel === undefined),
        ).toHaveLength(1);
      });

      it("sends the unsent tail when the tab closes after the reader has left Mail", async () => {
        const items = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `a-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const first = deferred<void>();
        const updateThread = vi
          .fn()
          .mockReturnValueOnce(first.promise)
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
        await click(findButton("Done — archive all 3 in Seen"));
        await act(async () => root.render(<div>Home</div>));
        await drain();
        expect(sent(updateThread)).toHaveLength(1);

        // No Mail surface is mounted to hear the page leave. The queue hears
        // it itself, and what it had not reached leaves in that task.
        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
        expect(sent(updateThread)).toEqual([
          { threadId: "a-0", archive: true, keepalive: true },
          { threadId: "a-1", archive: true, keepalive: true },
          { threadId: "a-2", archive: true, keepalive: true },
        ]);
        await act(async () => first.resolve());
        await drain();
      });

      it("sends every request so it can outlive the page, the one in flight at pagehide included", async () => {
        const items = [1, 2, 3].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `p-${index}`,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const first = deferred<void>();
        const updateThread = vi
          .fn()
          .mockReturnValueOnce(first.promise)
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
        await closeWindow(onToast);
        // Mid-run: one archive out, sent the ordinary way a moment ago, and
        // it too would be cut with the document without `keepalive`.
        expect(sent(updateThread)).toEqual([
          { threadId: "p-1", archive: true, keepalive: true },
        ]);

        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
        // Every archive is out in the handler. The read flags follow their
        // archives' answers, which a page that is really leaving may never
        // see: best effort until the mutations go as one batch.
        expect(sent(updateThread)).toEqual([
          { threadId: "p-1", archive: true, keepalive: true },
          { threadId: "p-2", archive: true, keepalive: true },
          { threadId: "p-3", archive: true, keepalive: true },
        ]);
        await act(async () => first.resolve());
        await drain();
        expect(
          sent(updateThread).filter((mutation) => "read" in mutation),
        ).toEqual([
          { threadId: "p-2", read: true, keepalive: true },
          { threadId: "p-3", read: true, keepalive: true },
          { threadId: "p-1", read: true, keepalive: true },
        ]);
      });

      it("ends a hold on its own account's read, not on another account's that landed first", async () => {
        vi.useFakeTimers();
        const accountC: PublicMailAccount = {
          ...accountA,
          accountId: "account-c0123456789abcdef0123456789abcdef",
          emailAddress: "c@example.test",
        };
        const accountD: PublicMailAccount = {
          ...accountA,
          accountId: "account-d0123456789abcdef0123456789abcdef",
          emailAddress: "d@example.test",
        };
        const x = unifiedThread({
          accountId: accountA.accountId,
          threadId: "x-1",
          unread: false,
          lastMessageAt: 1_700_000_000_000,
        });
        const archive = deferred<void>();
        const updateThread = vi.fn().mockReturnValue(archive.promise);
        const held = new Map<string, ReturnType<typeof deferred<void>>>();
        let hold = false;
        let listed: MailThreadListItem[] = [x];
        const listThreads = vi.fn().mockImplementation(({ accountId }) => {
          // What the server holds when the read is ASKED: a read that left
          // before the archive answers with the thread still in it.
          const page = pageOf(accountId === accountA.accountId ? [...listed] : []);
          if (!hold || accountId === accountD.accountId) return Promise.resolve(page);
          const wait = deferred<void>();
          held.set(accountId, wait);
          return wait.promise.then(() => page);
        });
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={makeClient({
                loadAccounts: vi
                  .fn()
                  .mockResolvedValue([accountA, accountB, accountC, accountD]),
                listThreads,
                updateThread,
              })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();
        await drain();
        await click(findButton("Done — archive all 1 in Seen"));
        await closeWindow(onToast);
        expect(sent(updateThread)).toHaveLength(1);

        // One refresh of every account, three at a time: A, B and C leave in
        // the first wave, before the archive has answered.
        hold = true;
        const before = listThreads.mock.calls.length;
        await mailEvent({ kind: "mail", changeKind: "reset" });
        await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
        await drain();
        expect(listThreads.mock.calls.length - before).toBe(UNIFIED_FANOUT_LIMIT);

        // The archive answers. Then B answers, which lets D's read begin, and
        // D's read lands at once: begun after the archive, and about another
        // account.
        listed = [];
        await act(async () => archive.resolve());
        await drain();
        await act(async () => held.get(accountB.accountId)?.resolve());
        await drain();
        expect(listThreads.mock.calls.length - before).toBe(4);

        // A's own read, the one that left before the archive, lands last and
        // lists the thread. The hold has to be standing still.
        await act(async () => held.get(accountC.accountId)?.resolve());
        await act(async () => held.get(accountA.accountId)?.resolve());
        await drain();
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();
        expect(threadsList()).not.toContain("x-1");
      });

      it("takes an archived row out of an account's own deep list as its hold ends", async () => {
        vi.useFakeTimers();
        // Fifty unread letters fill page one in both lists. The three read
        // ones Done takes sit below it, where a page-one read never reaches
        // and the fold keeps whatever the list holds.
        const pageOne = Array.from({ length: 50 }, (_value, index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `top-${String(index).padStart(2, "0")}`,
            lastMessageAt: 1_700_000_100_000 - index * 1_000,
          }),
        );
        const deep = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `deep-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const archived = new Set<string>();
        const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) =>
          Promise.resolve(
            accountId !== accountA.accountId
              ? pageOf([])
              : cursor
                ? pageOf(deep.filter((item) => !archived.has(item.threadId)))
                : pageOf(pageOne, "cursor-deep"),
          ),
        );
        const updateThread = vi
          .fn()
          .mockImplementation(async ({ threadId }: { threadId: string }) => {
            archived.add(threadId);
          });
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(pageOne, { updateThread, listThreads })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();
        await click(findButton("Load more"));
        await drain();
        await click(findButton("Done — archive all 3 in Seen"));

        // Into the account's own Inbox inside the window, and down to the
        // page the three are on: held, so not drawn.
        await enterSingleAccount(accountA);
        await drain();
        await click(findButton("Load more"));
        await drain();
        const single = () =>
          document.body.querySelector('section[aria-label="Mailbox"]')
            ?.textContent ?? "";
        expect(single()).toContain("top-49");
        expect(single()).not.toContain("deep-0");

        await closeWindow(onToast);
        expect(sent(updateThread)).toHaveLength(3);
        // The read their own events bring is page one, begun after them. It
        // ends the holds, and the rows below it leave the list with them.
        await mailEvent({
          kind: "mail",
          changeKind: "sync",
          accountId: accountA.accountId,
          mailboxIds: ["inbox"],
        });
        await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
        await drain();
        expect(listThreads.mock.calls.at(-1)?.[0]?.cursor).toBeUndefined();
        expect(single()).toContain("top-49");
        expect(single()).not.toContain("deep-0");
        expect(single()).not.toContain("deep-2");
      });

      it.each([
        [
          "a session that ended",
          () => new MailApiError(401, null),
          "3 threads stayed put, you were signed out",
          1,
        ],
        [
          "a connection that dropped",
          () => new TypeError("Failed to fetch"),
          "3 threads stayed put, no connection to the server",
          1,
        ],
        [
          // Too many requests is a bad minute for one thread: the next is
          // still tried, and there is no reason to give for the account.
          "a rate limit",
          () => new MailApiError(429, "mail_rate_limited"),
          "3 threads stayed put",
          3,
        ],
      ] as const)(
        "reads %s for what it says about the rest of the run",
        async (_what, failure, subtitle, attempts) => {
          const items = [1, 2, 3].map((index) =>
            unifiedThread({
              accountId: accountA.accountId,
              threadId: `bulk-${index}`,
              lastMessageAt: 1_700_000_000_000 - index,
            }),
          );
          const updateThread = vi.fn().mockImplementation(() => Promise.reject(failure()));
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
          await closeWindow(onToast);
          expect(updateThread).toHaveBeenCalledTimes(attempts);
          expect(onToast).toHaveBeenLastCalledWith("Couldn’t clear People", {
            icon: "danger-triangle-linear",
            subtitle,
            durationMs: 5_000,
          });
          expect(threadsList()).toContain("bulk-3");
        },
      );

      describe("the column's motion", () => {
        type Played = {
          readonly node: HTMLElement;
          readonly keyframes: Keyframe[];
          readonly options: KeyframeAnimationOptions;
        };
        let played: Played[];

        beforeEach(() => {
          played = [];
          Object.defineProperty(HTMLElement.prototype, "animate", {
            configurable: true,
            writable: true,
            value: function animate(
              this: HTMLElement,
              keyframes: Keyframe[],
              options: KeyframeAnimationOptions,
            ) {
              played.push({ node: this, keyframes, options });
              return { finished: new Promise(() => {}), cancel: () => {} };
            },
          });
        });
        afterEach(() => {
          delete (HTMLElement.prototype as { animate?: unknown }).animate;
        });

        const ghosts = () =>
          [...document.body.querySelectorAll<HTMLElement>(".brain-mail-list > *")].filter(
            (element) => element.getAttribute("aria-hidden") === "true" && element.inert,
          );

        async function mountWith(
          items: readonly MailThreadListItem[],
          onToast: (title: string, options?: ToastOptions) => void,
        ) {
          await act(async () =>
            root.render(
              <MailSurface
                client={mixedClient(items, {
                  updateThread: vi.fn().mockResolvedValue(undefined),
                })}
                onOpenSettings={() => {}}
                onToast={onToast}
              />,
            ),
          );
          await settle();
        }

        it("lets the whole section go on a fade at the press, and brings it back rising on Undo", async () => {
          const items = [1, 2].map((index) =>
            unifiedThread({
              accountId: accountA.accountId,
              threadId: `p-${index}`,
              lastMessageAt: 1_700_000_000_000 - index,
            }),
          );
          const onToast = vi.fn();
          await mountWith(items, onToast);

          await click(findButton("Done — archive all 2 in People"));
          // The section unmounted whole, so what fades is a copy of its last
          // frame, header and rows in one piece.
          expect(ghosts()).toHaveLength(1);
          expect(ghosts()[0]!.textContent).toContain("People");
          expect(ghosts()[0]!.textContent).toContain("p-1");
          const fade = played.find((each) => each.node === ghosts()[0]);
          expect(fade?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
          expect(fade?.options.duration).toBe(120);

          played.length = 0;
          await act(async () => {
            donePill(onToast).onAction?.();
          });
          await drain();
          // Back as one piece too, the 4px a row rises entering the list.
          const section = document.body.querySelector<HTMLElement>(
            'section[aria-label="People"]',
          );
          expect(section).not.toBeNull();
          const rise = played.filter((each) => each.node === section);
          expect(rise).toHaveLength(1);
          expect(rise[0]!.keyframes).toEqual([
            { opacity: 0, transform: "translateY(4px)" },
            { opacity: 1, transform: "none" },
          ]);
          expect(rise[0]!.options.duration).toBe(120);
          // Its rows do not rise a second time inside it.
          expect(
            played.filter((each) => each.node.dataset.flip?.startsWith("row:")),
          ).toEqual([]);
        });

        it("fades only the rows that go when part of the section stays, and raises only those on Undo", async () => {
          const items = [
            unifiedThread({
              accountId: accountA.accountId,
              threadId: "gmail-1",
              lastMessageAt: 1_700_000_000_000,
            }),
            unifiedThread({
              accountId: imapAccount.accountId,
              threadId: "imap-1",
              lastMessageAt: 1_600_000_000_000,
            }),
          ];
          const onToast = vi.fn();
          await mountWith(items, onToast);

          await click(findButton("Done — archive 1 of 2 in People"));
          expect(ghosts()).toHaveLength(1);
          expect(ghosts()[0]!.textContent).toContain("gmail-1");
          expect(ghosts()[0]!.textContent).not.toContain("imap-1");

          played.length = 0;
          await act(async () => {
            donePill(onToast).onAction?.();
          });
          await drain();
          const risen = played.filter(
            (each) => each.keyframes[0]?.transform === "translateY(4px)",
          );
          expect(risen.map((each) => each.node.dataset.flip)).toEqual([
            `row:${accountA.accountId}:gmail-1`,
          ]);
        });
      });

      it("counts an account's Inbox badge without the letters Done is holding out", async () => {
        const items = [
          ...[1, 2].map((index) =>
            unifiedThread({
              accountId: accountA.accountId,
              threadId: `nl-${index}`,
              category: "newsletter",
              lastMessageAt: 1_700_000_000_000 - index,
            }),
          ),
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "p-1",
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

        await click(findButton("Done — archive all 2 in Newsletters"));
        // Into the account's own Inbox inside the window: the server lists
        // three unread letters, and the column and its badge hold one.
        await enterSingleAccount(accountA);
        await drain();
        const single = () =>
          document.body.querySelector('section[aria-label="Mailbox"]')
            ?.textContent ?? "";
        expect(single()).toContain("p-1");
        expect(single()).not.toContain("nl-1");
        await openNav();
        expect(navItem("Inbox")?.querySelector(".tree-row-count")?.textContent).toBe("1");
        await closeNav();

        // Undo from there puts them back in this list too.
        await act(async () => {
          donePill(onToast).onAction?.();
        });
        await drain();
        expect(single()).toContain("nl-1");
        expect(single()).toContain("nl-2");
        expect(updateThread).not.toHaveBeenCalled();
      });

      it("walks an account's own Inbox past the letters Done is holding out", async () => {
        const items = [
          ...[1, 2].map((index) =>
            unifiedThread({
              accountId: accountA.accountId,
              threadId: `nl-${index}`,
              category: "newsletter",
              lastMessageAt: 1_700_000_000_000 - index,
            }),
          ),
          unifiedThread({
            accountId: accountA.accountId,
            threadId: "p-1",
            unread: false,
            lastMessageAt: 1_600_000_000_000,
          }),
        ];
        const readThread = detailOf(items);
        const onToast = vi.fn();
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        });
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(items, { readThread })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();
        await click(findButton("Done — archive all 2 in Newsletters"));
        await enterSingleAccount(accountA);
        await drain();

        // The list this account's Inbox holds starts with the two held
        // letters. J lands on the first row that is drawn.
        await act(async () => {
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "j", cancelable: true }),
          );
        });
        await drain();
        expect(readThread).toHaveBeenCalledTimes(1);
        expect(readThread.mock.calls[0]?.[0]).toMatchObject({ threadId: "p-1" });
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
        await closeWindow(onToast);
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
        const section = () =>
          document.body.querySelector('section[aria-label="Newsletters"]');
        // The two Gmail threads leave at the press; the three IMAP rows are
        // never hidden and never sent.
        expect(section()).not.toBeNull();
        expect(section()?.textContent).toContain("imap-1");
        expect(section()?.textContent).not.toContain("gmail-1");
        // And the rows that stayed are accounted for, in the same breath as
        // the ones that went. Silence here never corrects itself.
        expect(onToast).toHaveBeenCalledWith(
          "Newsletters partly cleared",
          expect.objectContaining({
            subtitle: "2 threads out of your inbox, 3 can’t leave",
            actionLabel: "Undo",
            durationMs: SMART_UNDO_MS,
          }),
        );

        await closeWindow(onToast);
        expect(updateThread.mock.calls.map((call) => call[0].threadId)).toEqual([
          "gmail-1",
          "gmail-1",
          "gmail-2",
          "gmail-2",
        ]);
        expect(section()?.textContent).toContain("imap-1");
        expect(section()?.textContent).not.toContain("gmail-1");
        expect(onToast).toHaveBeenCalledTimes(1);
      });

      it("names the rows an account could never move in the report of a run that fell short", async () => {
        const items = [
          ...[1, 2].map((index) =>
            unifiedThread({
              accountId: accountA.accountId,
              threadId: `gmail-${index}`,
              category: "newsletter",
              lastMessageAt: 1_700_000_000_000 - index,
            }),
          ),
          unifiedThread({
            accountId: imapAccount.accountId,
            threadId: "imap-1",
            category: "newsletter",
            lastMessageAt: 1_600_000_000_000,
          }),
        ];
        const updateThread = vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) =>
            input.threadId === "gmail-2"
              ? Promise.reject(new Error("provider said no"))
              : Promise.resolve(undefined),
          );
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

        await click(findButton("Done — archive 2 of 3 in Newsletters"));
        await closeWindow(onToast);
        expect(onToast).toHaveBeenLastCalledWith(
          "Newsletters partly cleared",
          expect.objectContaining({
            subtitle: "1 archived, 1 stayed put, 1 can’t leave",
          }),
        );
        const section = document.body.querySelector(
          'section[aria-label="Newsletters"]',
        );
        expect(section?.textContent).toContain("gmail-2");
        expect(section?.textContent).not.toContain("gmail-1");
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

      it("takes an archived row out of a deep stream, so the page-one read after it cannot bring it back", async () => {
        vi.useFakeTimers();
        // Fifty unread letters fill page one. The three read ones Done will
        // take sit below it, brought in by Load more, where a page-one read
        // never reaches and the fold keeps whatever the stream holds.
        const pageOne = Array.from({ length: 50 }, (_value, index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `top-${String(index).padStart(2, "0")}`,
            lastMessageAt: 1_700_000_100_000 - index * 1_000,
          }),
        );
        const deep = [0, 1, 2].map((index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `deep-${index}`,
            unread: false,
            lastMessageAt: 1_700_000_000_000 - index,
          }),
        );
        const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) =>
          Promise.resolve(
            accountId !== accountA.accountId
              ? pageOf([])
              : cursor
                ? pageOf(deep)
                : pageOf(pageOne, "cursor-deep"),
          ),
        );
        const updateThread = vi.fn().mockResolvedValue(undefined);
        const onToast = vi.fn();
        await act(async () =>
          root.render(
            <MailSurface
              client={unifiedClient(pageOne, { updateThread, listThreads })}
              onOpenSettings={() => {}}
              onToast={onToast}
            />,
          ),
        );
        await settle();
        await click(findButton("Load more"));
        await drain();

        await click(findButton("Done — archive all 3 in Seen"));
        await closeWindow(onToast);
        expect(updateThread).toHaveBeenCalledTimes(3);

        // The read the archives' own events bring is begun after them. It
        // ends the hold, and lists page one only.
        await mailEvent({
          kind: "mail",
          changeKind: "sync",
          accountId: accountA.accountId,
          mailboxIds: ["inbox"],
        });
        await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
        await drain();
        expect(listThreads.mock.calls.at(-1)?.[0]?.cursor).toBeUndefined();
        expect(
          document.body.querySelector('section[aria-label="Seen"]'),
        ).toBeNull();
        expect(threadsList()).not.toContain("deep-0");
      });

      it("Undo puts each letter back where its own read state has it", async () => {
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
        expect(threadsList()).not.toContain("still-unread");

        await act(async () => {
          donePill(onToast).onAction?.();
        });
        await drain();

        // Nothing was sent either way, so there is no read flag to give
        // back: the unread one is under People again, and the one the reader
        // had already opened is under Seen (bundled, so the digest counts it
        // rather than naming it). The letter Done closed stays closed.
        expect(updateThread).not.toHaveBeenCalled();
        const list = document.body.querySelector(
          '[aria-label="All inboxes threads"]',
        );
        expect(
          list?.querySelector('section[aria-label="People"]')?.textContent,
        ).toContain("still-unread");
        expect(
          list?.querySelector('section[aria-label="Seen"]')?.textContent,
        ).toContain("1 thread, nothing unread");
        expect(onToast).toHaveBeenCalledTimes(1);
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
        await vi.advanceTimersByTimeAsync(MAIL_SAFETY_REFRESH_MS);
      });
      await settle();
      const lastCall = listThreads.mock.calls.at(-1)?.[0];
      expect(lastCall?.cursor).toBeUndefined();
      // The refreshed page-1 window replaced the head; the deep tail stays.
      expect(document.body.textContent).toContain("depth-tail");
      expect(document.body.textContent).toContain("depth-49");
    });

    it("refreshes only the account a mail event names, keeping loaded depth and the scroll", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      // Which sections are open outlives a mount (sessionStorage); start shut.
      window.sessionStorage.clear();
      let arrived = false;
      const pageOne = () =>
        Array.from({ length: 50 }, (_value, index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `depth-${String(index).padStart(2, "0")}`,
            lastMessageAt: 1_700_000_100_000 - index * 1_000,
          }),
        );
      const fresh = unifiedThread({
        accountId: accountA.accountId,
        threadId: "just-arrived",
        lastMessageAt: 1_700_000_200_000,
      });
      const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) =>
        Promise.resolve(
          accountId !== accountA.accountId
            ? pageOf([])
            : cursor
              ? pageOf([
                  unifiedThread({
                    accountId: accountA.accountId,
                    threadId: "depth-tail",
                    lastMessageAt: 1_700_000_000_000,
                  }),
                ])
              : pageOf(arrived ? [fresh, ...pageOne()] : pageOne(), "cursor-deep"),
        ),
      );
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
      // The same scroller, not a new one: a rebuild would put it back at the top.
      const scroller = document.body.querySelector<HTMLElement>(".brain-mail-scroll")!;
      scroller.scrollTop = 480;
      const before = listThreads.mock.calls.length;

      arrived = true;
      await mailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: accountA.accountId,
        mailboxIds: ["inbox", "all"],
      });
      await act(async () => vi.advanceTimersByTimeAsync(400));
      await settle();

      const asked = listThreads.mock.calls.slice(before).map(([input]) => input);
      expect(asked).toEqual([
        expect.objectContaining({ accountId: accountA.accountId }),
      ]);
      expect(asked[0]).not.toHaveProperty("cursor");
      expect(document.body.textContent).toContain("just-arrived");
      expect(document.body.textContent).toContain("depth-tail");
      expect(document.body.querySelector(".brain-mail-scroll")).toBe(scroller);
      expect(scroller.scrollTop).toBe(480);
    });

    it("reads the account again when a Load more's landing dropped a mail event's refresh", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      window.sessionStorage.clear();
      const pageOne = () =>
        Array.from({ length: 50 }, (_value, index) =>
          unifiedThread({
            accountId: accountA.accountId,
            threadId: `depth-${String(index).padStart(2, "0")}`,
            lastMessageAt: 1_700_000_100_000 - index * 1_000,
          }),
        );
      const fresh = unifiedThread({
        accountId: accountA.accountId,
        threadId: "just-arrived",
        lastMessageAt: 1_700_000_200_000,
      });
      let arrived = false;
      let heldOnce = false;
      const refreshRead = deferred<MailThreadPage>();
      const listThreads = vi.fn().mockImplementation(({ accountId, cursor }) => {
        if (accountId !== accountA.accountId) return Promise.resolve(pageOf([]));
        if (cursor) {
          return Promise.resolve(
            pageOf([
              unifiedThread({
                accountId: accountA.accountId,
                threadId: "depth-tail",
                lastMessageAt: 1_700_000_000_000,
              }),
            ]),
          );
        }
        if (arrived && !heldOnce) {
          heldOnce = true;
          return refreshRead.promise;
        }
        return Promise.resolve(
          pageOf(arrived ? [fresh, ...pageOne()] : pageOne(), "cursor-deep"),
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
      await click(findButton("Show all 50 in People"));

      arrived = true;
      await mailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: accountA.accountId,
        mailboxIds: ["inbox", "all"],
      });
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      await settle();
      // The event's page-one read is out; the owner reaches the end.
      await click(findButton("Load more"));
      expect(document.body.textContent).toContain("depth-tail");
      await act(async () =>
        refreshRead.resolve(pageOf([fresh, ...pageOne()], "cursor-deep")),
      );
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();

      expect(document.body.textContent).toContain("just-arrived");
      expect(document.body.textContent).toContain("depth-tail");
      expect(document.body.textContent?.match(/depth-tail/g)).toHaveLength(1);
    });

    it("reads every account whose event came while All inboxes was still loading", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      window.sessionStorage.clear();
      const firstA = deferred<MailThreadPage>();
      let aReads = 0;
      const listThreads = vi.fn().mockImplementation(({ accountId }) => {
        if (accountId === accountA.accountId) {
          aReads += 1;
          if (aReads === 1) return firstA.promise;
        }
        return Promise.resolve(pageOf([]));
      });
      const client = makeClient({
        listThreads,
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      const reads = (accountId: string) =>
        listThreads.mock.calls.filter(([input]) => input.accountId === accountId).length;
      expect(reads(accountA.accountId)).toBe(1);
      const bBefore = reads(accountB.accountId);

      // Both events land while the merge's first read is out: both step aside.
      for (const accountId of [accountA.accountId, accountB.accountId]) {
        await mailEvent({ kind: "mail", changeKind: "sync", accountId, mailboxIds: ["inbox"] });
      }
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      expect(reads(accountA.accountId)).toBe(1);
      expect(reads(accountB.accountId)).toBe(bBefore);

      await act(async () => firstA.resolve(pageOf([])));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await settle();
      // One read each, for both: neither account's owed read replaced the other's.
      expect(reads(accountA.accountId)).toBe(2);
      expect(reads(accountB.accountId)).toBe(bBefore + 1);
    });

    it("reads another account's event once the read out for the first lands, never beside it", async () => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      window.sessionStorage.clear();
      const aRead = deferred<MailThreadPage>();
      let armed = false;
      const listThreads = vi.fn().mockImplementation(({ accountId }) =>
        armed && accountId === accountA.accountId ? aRead.promise : Promise.resolve(pageOf([])),
      );
      const client = makeClient({
        listThreads,
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      armed = true;
      const bCalls = () =>
        listThreads.mock.calls.filter(([input]) => input.accountId === accountB.accountId)
          .length;
      await mailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: accountA.accountId,
        mailboxIds: ["inbox"],
      });
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      const bBefore = bCalls();
      await mailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: accountB.accountId,
        mailboxIds: ["inbox"],
      });
      await act(async () => vi.advanceTimersByTimeAsync(MAIL_EVENT_DEBOUNCE_MS));
      expect(bCalls()).toBe(bBefore);
      await act(async () => aRead.resolve(pageOf([])));
      await settle();
      expect(bCalls()).toBe(bBefore + 1);
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

  /** NEW SENDERS. A first letter from a stranger waits first in the column
   *  for one decision, and the column shows the decision before the service's
   *  next list read does, with a way back in the toast. */
  describe("new senders", () => {
    const lena = { name: "Lena Okafor", address: "lena@okafor.example" };
    const mika = { name: "Mika Okafor", address: "mika@okafor.example" };

    function waiting(
      threadId: string,
      from = lena,
      overrides: Partial<MailThreadListItem> = {},
    ): MailThreadListItem {
      return {
        ...thread,
        threadId,
        subject: `Subject ${threadId}`,
        unread: true,
        // Someone else is listed first: the decision is about the first From.
        participants: [{ name: "Priya Raman", address: "priya@example.test" }],
        newSender: true,
        newSenderFrom: from,
        lastMessageAt: 1_700_000_000_500,
        ...overrides,
      };
    }

    function friend(threadId: string): MailThreadListItem {
      return {
        ...thread,
        threadId,
        subject: `Subject ${threadId}`,
        unread: true,
        participants: [{ name: "Tomas Lindqvist", address: "tomas@example.test" }],
      };
    }

    function page(items: readonly MailThreadListItem[]): MailThreadPage {
      return {
        apiVersion: 1,
        items,
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
      };
    }

    async function mount(
      items: readonly MailThreadListItem[],
      overrides: Partial<MailSurfaceClient> = {},
      accounts: readonly PublicMailAccount[] = [accountA, accountB],
    ) {
      const onToast = vi.fn<(title: string, options?: ToastOptions) => void>();
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue(accounts),
        listThreads: vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(page(accountId === accountA.accountId ? items : [])),
        ),
        readThread: vi.fn().mockImplementation(({ threadId }) =>
          Promise.resolve({
            ...detail,
            thread: items.find((item) => item.threadId === threadId) ?? thread,
          }),
        ),
        ...overrides,
      });
      await act(async () =>
        root.render(
          <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
        ),
      );
      await settle();
      return { client, onToast };
    }

    function section(label: string): HTMLElement | null {
      return document.body.querySelector(`section[aria-label="${label}"]`);
    }

    function toastFor(
      onToast: ReturnType<typeof vi.fn>,
      title: string,
    ): ToastOptions | undefined {
      const call = onToast.mock.calls.find((entry) => entry[0] === title);
      return call?.[1] as ToastOptions | undefined;
    }

    async function openLetter(subject: string) {
      const row = [...document.body.querySelectorAll("button.brain-mail-row")].find(
        (candidate) => candidate.textContent?.includes(subject),
      );
      if (!(row instanceof HTMLButtonElement)) throw new Error(`No row for ${subject}`);
      await click(row);
      await settle();
    }

    it("waits first in All inboxes and accepts in place, with an Undo that puts it back", async () => {
      const { client, onToast } = await mount([waiting("lena-1"), friend("friend-1")]);

      const waitingGroup = section("New senders");
      expect(waitingGroup?.textContent).toContain("Lena Okafor");
      expect(waitingGroup?.textContent).toContain("okafor.example");
      expect(section("People")?.textContent).not.toContain("Subject lena-1");

      await click(findButton("Accept Lena Okafor"));
      await settle();

      expect(client.decideSender).toHaveBeenCalledWith({
        address: "lena@okafor.example",
        scope: "address",
        decision: "accept",
      });
      // The last decided row takes the header with it.
      expect(section("New senders")).toBeNull();
      expect(section("People")?.textContent).toContain("Subject lena-1");
      const toast = toastFor(onToast, "Accepted Lena Okafor");
      expect(toast).toMatchObject({
        icon: "user-check-rounded-linear",
        subtitle: "In People. Next ones come straight in.",
        actionLabel: "Undo",
        durationMs: SMART_UNDO_MS,
      });

      await act(async () => {
        await toast!.onAction!();
      });
      await settle();
      expect(client.undoSenderDecision).toHaveBeenCalledWith({ decisionId: DECISION_ID });
      expect(section("New senders")?.textContent).toContain("Subject lena-1");
      expect(section("People")?.textContent ?? "").not.toContain("Subject lena-1");
    });

    it("blocks out of the column and brings the letter back on Undo", async () => {
      const { client, onToast } = await mount([waiting("lena-1"), friend("friend-1")]);

      await click(findButton("Block Lena Okafor"));
      await settle();

      expect(client.decideSender).toHaveBeenCalledWith({
        address: "lena@okafor.example",
        scope: "address",
        decision: "block",
      });
      expect(document.body.textContent).not.toContain("Subject lena-1");
      const toast = toastFor(onToast, "Blocked Lena Okafor");
      expect(toast).toMatchObject({
        icon: "user-block-rounded-linear",
        subtitle: "Next letters go to Blocked too.",
        actionLabel: "Undo",
        durationMs: SMART_UNDO_MS,
      });

      await act(async () => {
        await toast!.onAction!();
      });
      await settle();
      expect(client.undoSenderDecision).toHaveBeenCalledWith({ decisionId: DECISION_ID });
      expect(section("New senders")?.textContent).toContain("Subject lena-1");
    });

    it("rolls a refused decision back and says so at once", async () => {
      const { onToast } = await mount([waiting("lena-1")], {
        decideSender: vi
          .fn()
          .mockRejectedValue(new MailApiError(503, "mail_senders_unavailable")),
      });

      await click(findButton("Accept Lena Okafor"));
      await settle();

      expect(section("New senders")?.textContent).toContain("Subject lena-1");
      expect(onToast).toHaveBeenCalledWith("Couldn’t accept Lena Okafor. Try again.", {
        urgent: true,
      });
      expect(toastFor(onToast, "Accepted Lena Okafor")).toBeUndefined();
    });

    it("says nothing when an Undo finds its decision already replaced or gone", async () => {
      for (const failure of [
        new MailApiError(409, "mail_sender_decision_changed"),
        new MailApiError(404, "mail_sender_decision_not_found"),
      ]) {
        const { onToast } = await mount([waiting("lena-1")], {
          undoSenderDecision: vi.fn().mockRejectedValue(failure),
        });
        await click(findButton("Accept Lena Okafor"));
        await settle();
        const before = onToast.mock.calls.length;
        await act(async () => {
          await toastFor(onToast, "Accepted Lena Okafor")!.onAction!();
        });
        await settle();
        expect(onToast.mock.calls.length).toBe(before);
        await act(async () => root.unmount());
        root = createRoot(host);
      }
    });

    it("swaps the reader's pill for the decision, and gives Reply back once it is made", async () => {
      const { client } = await mount([waiting("lena-1"), waiting("mika-1", mika)]);
      await openLetter("Subject lena-1");

      const reader = document.body.querySelector('section[aria-label="Message reader"]')!;
      expect(reader.textContent).toContain("first letter from this sender");
      const pillWords = () =>
        [...reader.querySelectorAll(".toolbar-pill button")].map(
          (button) => button.textContent?.trim() ?? "",
        );
      expect(pillWords()).toContain("Block");
      expect(pillWords()).toContain("Accept");
      expect(pillWords()).not.toContain("Reply");
      expect(pillWords()).not.toContain("Archive");

      const everyone = [...reader.querySelectorAll('[role="radio"]')].find((radio) =>
        radio.textContent?.includes("Everyone at okafor.example"),
      ) as HTMLElement;
      expect(
        [...reader.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent),
      ).toEqual(["Only this address", "Everyone at okafor.example"]);
      await click(everyone);
      expect(pillWords()).toContain("Accept 2 senders");

      await click(findButton("Accept 2 senders"));
      await settle();
      expect(client.decideSender).toHaveBeenCalledWith({
        address: "lena@okafor.example",
        scope: "domain",
        decision: "accept",
      });
      expect(pillWords()).toContain("Reply");
      expect(pillWords()).toContain("Archive");
      expect(reader.textContent).not.toContain("first letter from this sender");
    });

    it("names the domain and wears the group glyph for everyone at it", async () => {
      const { onToast } = await mount([waiting("lena-1"), waiting("mika-1", mika)]);
      await openLetter("Subject lena-1");
      const everyone = [...document.body.querySelectorAll('[role="radio"]')].find((radio) =>
        radio.textContent?.includes("Everyone at"),
      ) as HTMLElement;
      await click(everyone);
      const readerBlock = [
        ...document.body.querySelectorAll(
          'section[aria-label="Message reader"] .toolbar-pill button',
        ),
      ].find((button) => button.textContent?.trim() === "Block") as HTMLButtonElement;
      await click(readerBlock);
      await settle();
      expect(toastFor(onToast, "Blocked okafor.example")).toMatchObject({
        icon: "users-group-rounded-linear",
        subtitle: "Next letters go to Blocked too.",
      });
      expect(document.body.textContent).not.toContain("Subject mika-1");
    });

    it("offers no domain for a provider everyone shares", async () => {
      const shared = { name: "Sam Rivera", address: "sam@gmail.example" };
      await mount([waiting("sam-1", shared)]);
      await openLetter("Subject sam-1");
      expect(document.body.querySelector('[role="radio"]')).toBeNull();
      expect(findButton("Accept")).toBeTruthy();
    });

    it("takes a and b for the open letter's sender", async () => {
      const { client } = await mount([waiting("lena-1"), friend("friend-1")]);
      await openLetter("Subject lena-1");
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
      });
      await settle();
      expect(client.decideSender).toHaveBeenCalledWith({
        address: "lena@okafor.example",
        scope: "address",
        decision: "block",
      });
    });

    it("stands first in a lone account's Inbox, with the rest as a group under it", async () => {
      await mount([waiting("lena-1"), friend("friend-1")], {}, [accountA]);
      const groups = [...document.body.querySelectorAll('[role="list"] > section')].map(
        (group) => group.getAttribute("aria-label"),
      );
      expect(groups).toEqual(["New senders", "Inbox"]);
      expect(section("Inbox")?.textContent).toContain("Subject friend-1");
      expect(section("Inbox")?.textContent).not.toContain("Subject lena-1");
    });

    it("decides for the letter on screen once j has moved the reader on, not the row pressed before", async () => {
      const { client } = await mount([waiting("lena-1"), waiting("mika-1", mika)]);
      const order = [...document.body.querySelectorAll("button.brain-mail-row")].map((b) =>
        b.textContent?.includes("Subject mika-1") ? "mika" : b.textContent?.includes("Subject lena-1") ? "lena" : "?",
      );
      expect(order).toEqual(["mika", "lena"]);
      await openLetter("Subject mika-1");
      // A mouse click in Chrome leaves focus on the row button it pressed.
      const mikaRow = [...document.body.querySelectorAll("button.brain-mail-row")].find((b) =>
        b.textContent?.includes("Subject mika-1"),
      ) as HTMLButtonElement;
      mikaRow.focus();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
      });
      await settle();
      const reader = document.body.querySelector('section[aria-label="Message reader"]')!;
      expect(reader.textContent).toContain("Subject lena-1");
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
      });
      await settle();
      expect(client.decideSender).toHaveBeenCalledTimes(1);
      expect(client.decideSender).toHaveBeenCalledWith({
        address: "lena@okafor.example",
        scope: "address",
        decision: "block",
      });
    });

    it("hides what a block archived in the Inbox, and nowhere else", async () => {
      const blocked = waiting("lena-1");
      const { client } = await mount([blocked, friend("friend-1")], {
        decideSender: vi.fn().mockResolvedValue({
          apiVersion: 1,
          decisionId: DECISION_ID,
          archived: [{ accountId: accountA.accountId, threadId: "lena-1" }],
          pending: false,
        }),
        listMailboxThreads: vi.fn().mockImplementation(({ mailboxId }) =>
          Promise.resolve(
            mailboxThreadPage(
              mailboxId,
              mailboxId === "all"
                ? [{ ...friend("lena-1"), subject: "Subject lena-1" }, friend("other-1")]
                : [],
            ),
          ),
        ),
      }, [accountA]);
      await click(findButton("Block Lena Okafor"));
      await settle();
      expect(document.body.textContent).not.toContain("Subject lena-1");
      await goTo("All Mail");
      await settle();
      expect(client.listMailboxThreads).toHaveBeenCalled();
      expect(document.body.textContent).toContain("Subject other-1");
      expect(document.body.textContent).toContain("Subject lena-1");
      // The keys walk the same list the column draws there.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
      });
      await settle();
      expect(client.readMailboxThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ mailboxId: "all", threadId: "lena-1" }),
      );
    });

    it("lets a block's archive show again once a list read that began after it has landed", async () => {
      let items: MailThreadListItem[] = [waiting("lena-1"), friend("friend-1")];
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await mount([], {
        listThreads: vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(page(accountId === accountA.accountId ? items : [])),
        ),
        decideSender: vi.fn().mockResolvedValue({
          apiVersion: 1,
          decisionId: DECISION_ID,
          archived: [{ accountId: accountA.accountId, threadId: "friend-1" }],
          pending: false,
        }),
      });
      await click(findButton("Block Lena Okafor"));
      await settle();
      expect(document.body.textContent).not.toContain("Subject friend-1");
      // The owner moved it back elsewhere: the next Inbox read lists it, and
      // the column believes the read over the block's old answer.
      items = [friend("friend-1")];
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      await settle();
      visibility.mockRestore();
      expect(document.body.textContent).toContain("Subject friend-1");
    });

    it("re-reads the list after an Undo that went through, and after one already undone or replaced", async () => {
      for (const failure of [
        null,
        new MailApiError(404, "mail_sender_decision_not_found"),
        new MailApiError(409, "mail_sender_decision_changed"),
      ]) {
        for (const verdict of ["Accept", "Block"] as const) {
          const { client, onToast } = await mount([waiting("lena-1")], {
            undoSenderDecision:
              failure === null
                ? vi.fn().mockResolvedValue({ apiVersion: 1, restored: [], pending: false })
                : vi.fn().mockRejectedValue(failure),
          });
          await click(findButton(`${verdict} Lena Okafor`));
          await settle();
          const reads = (client.listThreads as ReturnType<typeof vi.fn>).mock.calls.length;
          await act(async () => {
            await toastFor(
              onToast,
              verdict === "Accept" ? "Accepted Lena Okafor" : "Blocked Lena Okafor",
            )!.onAction!();
          });
          await settle();
          expect(
            (client.listThreads as ReturnType<typeof vi.fn>).mock.calls.length,
          ).toBeGreaterThan(reads);
          await act(async () => root.unmount());
          root = createRoot(host);
        }
      }
    });

    it("puts a blocked row back at the Undo press, before any read returns", async () => {
      let items: MailThreadListItem[] | null = [waiting("lena-1"), friend("friend-1")];
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const { onToast } = await mount([], {
        listThreads: vi.fn().mockImplementation(({ accountId }) =>
          items === null
            ? new Promise(() => {})
            : Promise.resolve(page(accountId === accountA.accountId ? items : [])),
        ),
      });
      await click(findButton("Block Lena Okafor"));
      await settle();
      // The service archived it, and a read that lands says so.
      items = [friend("friend-1")];
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      await settle();
      visibility.mockRestore();
      // From here on no read answers at all.
      items = null;
      await act(async () => {
        await toastFor(onToast, "Blocked Lena Okafor")!.onAction!();
      });
      await settle();
      expect(section("New senders")?.textContent).toContain("Subject lena-1");
    });

    it("undoes an Accept after a refresh and puts the row back under New senders", async () => {
      let items: MailThreadListItem[] = [waiting("lena-1"), friend("friend-1")];
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const { onToast, client } = await mount([], {
        listThreads: vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(page(accountId === accountA.accountId ? items : [])),
        ),
      });
      await click(findButton("Accept Lena Okafor"));
      await settle();
      // The service now knows Lena: the next list read no longer flags her.
      items = [
        { ...friend("lena-1"), subject: "Subject lena-1", participants: waiting("lena-1").participants },
        friend("friend-1"),
      ];
      const before = (client.listThreads as ReturnType<typeof vi.fn>).mock.calls.length;
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      await settle();
      expect((client.listThreads as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
      expect(section("People")?.textContent).toContain("Subject lena-1");
      // Undo, and no read answers after it: the row goes back at the press.
      (client.listThreads as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {}),
      );
      await act(async () => {
        await toastFor(onToast, "Accepted Lena Okafor")!.onAction!();
      });
      await settle();
      visibility.mockRestore();
      expect(section("New senders")?.textContent ?? "").toContain("Subject lena-1");
      expect(section("People")?.textContent ?? "").not.toContain("Subject lena-1");
    });

    it("leaves the letter keys alone while a menu is open", async () => {
      const { client } = await mount([waiting("lena-1"), friend("friend-1")]);
      await openLetter("Subject lena-1");
      await openNav();
      const target = (document.activeElement as HTMLElement) ?? document.body;
      expect(target.closest('[role="menu"]')).not.toBeNull();
      for (const key of ["a", "b", "e", "u", "s", "j", "k"]) {
        await act(async () => {
          target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        });
      }
      await settle();
      expect(client.decideSender).not.toHaveBeenCalled();
      expect(client.updateThread).not.toHaveBeenCalledWith(
        expect.objectContaining({ archive: true }),
      );
      expect(client.updateThread).not.toHaveBeenCalledWith(
        expect.objectContaining({ starred: true }),
      );
      expect(
        document.body.querySelector('section[aria-label="Message reader"]')?.textContent,
      ).toContain("Subject lena-1");
    });

    it("leaves the letter keys alone while a menu is open, whatever element the key reaches", async () => {
      const { client } = await mount([waiting("lena-1"), friend("friend-1")]);
      await openLetter("Subject lena-1");
      await openNav();
      expect(document.querySelector('[role="menu"][data-state="open"]')).not.toBeNull();
      for (const key of ["a", "b"]) {
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        });
      }
      await settle();
      expect(client.decideSender).not.toHaveBeenCalled();
    });

    it("hands focus to the same control on the next waiting row, else the next row, else the list", async () => {
      await mount([waiting("lena-1"), waiting("mika-1", mika), friend("friend-1")]);
      // mika-1 stands first, lena-1 under it.
      const accept = findButton("Accept Mika Okafor");
      accept.focus();
      await click(accept);
      await settle();
      expect(document.activeElement).toBe(findButton("Accept Lena Okafor"));

      const block = findButton("Block Lena Okafor");
      block.focus();
      await click(block);
      await settle();
      // Nobody waits any more: the next row the column holds takes it.
      const active = document.activeElement as HTMLElement;
      expect(active).not.toBe(document.body);
      expect(active.closest('section[aria-label="Mailbox"]')).not.toBeNull();
    });

    it("decides the letter on screen while its messages are still loading", async () => {
      const { client } = await mount([waiting("lena-1"), friend("friend-1")], {
        readThread: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      await openLetter("Subject lena-1");
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
      });
      await settle();
      expect(client.decideSender).toHaveBeenCalledWith({
        address: "lena@okafor.example",
        scope: "address",
        decision: "block",
      });
    });

    it("keeps the reach chosen for a letter still loading, and B decides with it", async () => {
      const { client } = await mount([waiting("lena-1"), waiting("mika-1", mika)], {
        readThread: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      await openLetter("Subject lena-1");
      const everyone = [
        ...document.body.querySelectorAll(
          'section[aria-label="Message reader"] [role="radio"]',
        ),
      ].find((radio) => radio.textContent?.includes("Everyone at okafor.example"));
      expect(everyone).toBeTruthy();
      await click(everyone as HTMLElement);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
      });
      await settle();
      expect(client.decideSender).toHaveBeenCalledWith({
        address: "lena@okafor.example",
        scope: "domain",
        decision: "block",
      });
    });

    it("decides the focused row when no letter is open", async () => {
      const { client } = await mount([waiting("lena-1"), waiting("mika-1", mika)]);
      findButton("Accept Lena Okafor").focus();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
      });
      await settle();
      expect(client.decideSender).toHaveBeenCalledWith({
        address: "lena@okafor.example",
        scope: "address",
        decision: "block",
      });
    });

    it("closes the letter a Block from the reader takes away", async () => {
      await mount([waiting("lena-1"), friend("friend-1")]);
      await openLetter("Subject lena-1");
      const readerBlock = [
        ...document.body.querySelectorAll(
          'section[aria-label="Message reader"] .toolbar-pill button',
        ),
      ].find((button) => button.textContent?.trim() === "Block") as HTMLButtonElement;
      await click(readerBlock);
      await settle();
      const reader = document.body.querySelector('section[aria-label="Message reader"]');
      expect(reader?.textContent).toContain("Choose a message");
    });

    it("reads a plain Accept when only one sender waits at the domain", async () => {
      await mount([waiting("lena-1"), friend("friend-1")]);
      await openLetter("Subject lena-1");
      const everyone = [...document.body.querySelectorAll('[role="radio"]')].find((radio) =>
        radio.textContent?.includes("Everyone at okafor.example"),
      ) as HTMLElement;
      await click(everyone);
      const words = [
        ...document.body.querySelectorAll(
          'section[aria-label="Message reader"] .toolbar-pill button',
        ),
      ].map((button) => button.textContent?.trim());
      expect(words).toContain("Accept");
      expect(words.some((word) => word?.startsWith("Accept 1"))).toBe(false);
    });

    it("counts every sender a domain Accept takes in its toast", async () => {
      const { onToast } = await mount([waiting("lena-1"), waiting("mika-1", mika)]);
      await openLetter("Subject lena-1");
      const everyone = [...document.body.querySelectorAll('[role="radio"]')].find((radio) =>
        radio.textContent?.includes("Everyone at okafor.example"),
      ) as HTMLElement;
      await click(everyone);
      await click(findButton("Accept 2 senders"));
      await settle();
      expect(toastFor(onToast, "Accepted okafor.example")).toMatchObject({
        icon: "users-group-rounded-linear",
        subtitle: "2 senders in. Next ones come straight in.",
      });
    });

    it("names the Inbox group only while someone waits above it", async () => {
      await mount([friend("friend-1"), friend("friend-2")], {}, [accountA]);
      const rows = document.body.querySelector('[data-flip="section:inbox"]')!;
      expect(rows).not.toBeNull();
      expect(rows.getAttribute("aria-label")).toBeNull();
      expect(rows.classList.contains("brain-mail-section")).toBe(false);
    });

    it("keeps the rest of a lone Inbox mounted when the last waiting row is decided", async () => {
      await mount([waiting("lena-1"), friend("friend-1"), friend("friend-2")], {}, [accountA]);
      const before = [...document.body.querySelectorAll('[role="listitem"]')].find((el) =>
        el.textContent?.includes("Subject friend-1"),
      )!;
      expect(before).toBeTruthy();
      await click(findButton("Accept Lena Okafor"));
      await settle();
      const after = [...document.body.querySelectorAll('[role="listitem"]')].find((el) =>
        el.textContent?.includes("Subject friend-1"),
      )!;
      expect(after).toBe(before);
      expect(before.isConnected).toBe(true);
    });

    it("waits for an Undo still going out before deciding the same sender again", async () => {
      const undo = deferred<{ apiVersion: 1; restored: []; pending: false }>();
      const { client, onToast } = await mount([waiting("lena-1")], {
        undoSenderDecision: vi.fn().mockReturnValue(undo.promise),
      });
      await click(findButton("Accept Lena Okafor"));
      await settle();
      let undone: Promise<unknown> = Promise.resolve();
      await act(async () => {
        undone = toastFor(onToast, "Accepted Lena Okafor")!.onAction!() as Promise<unknown>;
      });
      await settle();
      // The row is back at the press; the DELETE has not answered.
      await click(findButton("Accept Lena Okafor"));
      await settle();
      expect(client.decideSender).toHaveBeenCalledTimes(1);
      await act(async () => {
        undo.resolve({ apiVersion: 1, restored: [], pending: false });
        await undone;
      });
      await settle();
      expect(client.decideSender).toHaveBeenCalledTimes(2);
      expect(section("People")?.textContent).toContain("Subject lena-1");
    });

    it("decides once for a held key", async () => {
      const { client } = await mount([waiting("lena-1"), waiting("mika-1", mika)]);
      await openLetter("Subject mika-1");
      const lenaAccept = findButton("Accept Lena Okafor");
      lenaAccept.focus();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      });
      await settle();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, repeat: true }));
      });
      await settle();
      expect(client.decideSender).toHaveBeenCalledTimes(1);
    });

    it("decides once for a key held on a row, though the focus moves on to the next", async () => {
      const { client } = await mount([waiting("lena-1"), waiting("mika-1", mika)]);
      findButton("Accept Mika Okafor").focus();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      });
      await settle();
      // The focus is on Lena's Accept now; the repeat must not take her too.
      expect(document.activeElement).toBe(findButton("Accept Lena Okafor"));
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, repeat: true }));
      });
      await settle();
      expect(client.decideSender).toHaveBeenCalledTimes(1);
    });

    // Lena's other letter: not waiting (it is not a first letter), so only a
    // block's `archived` answer takes it out of the column.
    function lenaOther(threadId: string, at: number): MailThreadListItem {
      return {
        ...thread,
        threadId,
        subject: `Subject ${threadId}`,
        unread: true,
        participants: [lena],
        lastMessageAt: at,
      };
    }
    function filler(index: number): MailThreadListItem {
      return {
        ...thread,
        threadId: `seen-${index}`,
        subject: `Subject seen-${index}`,
        unread: false,
        lastMessageAt: 1_700_000_000_400 - index * 1000,
      };
    }
    const blockAnswer = {
      apiVersion: 1 as const,
      decisionId: DECISION_ID,
      archived: [
        { accountId: accountA.accountId, threadId: "lena-1" },
        { accountId: accountA.accountId, threadId: "lena-old" },
      ],
      pending: false,
    };

    it("keeps the archive out when a read begun before the block answered lands after it", async () => {
      const items = [
        waiting("lena-1"),
        lenaOther("lena-old", 1_690_000_000_000),
        friend("friend-1"),
      ];
      const late = deferred<MailThreadPage>();
      let hold = false;
      const decision = deferred<typeof blockAnswer>();
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await mount(
        [],
        {
          listThreads: vi
            .fn()
            .mockImplementation(({ accountId }) =>
              accountId === accountA.accountId && hold
                ? late.promise
                : Promise.resolve(page(accountId === accountA.accountId ? items : [])),
            ),
          decideSender: vi.fn().mockReturnValue(decision.promise),
        },
        [accountA],
      );
      await click(findButton("Block Lena Okafor"));
      await settle();
      hold = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      await act(async () => {
        decision.resolve(blockAnswer);
      });
      await settle();
      expect(document.body.textContent).not.toContain("Subject lena-old");
      // The read left before the archive and says the letter is still there.
      await act(async () => {
        late.resolve(page(items));
      });
      await settle();
      visibility.mockRestore();
      expect(document.body.textContent).not.toContain("Subject lena-old");
    });

    it("keeps the archive out while a read begun after the answer has not landed", async () => {
      const items = [
        waiting("lena-1"),
        lenaOther("lena-old", 1_690_000_000_000),
        friend("friend-1"),
      ];
      let hold = false;
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await mount([], {
        listThreads: vi
          .fn()
          .mockImplementation(({ accountId }) =>
            hold
              ? new Promise(() => {})
              : Promise.resolve(page(accountId === accountA.accountId ? items : [])),
          ),
        decideSender: vi.fn().mockResolvedValue(blockAnswer),
      });
      await click(findButton("Block Lena Okafor"));
      await settle();
      hold = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      visibility.mockRestore();
      expect(document.body.textContent).not.toContain("Subject lena-old");
    });

    it("keeps one account's archive out when another account's read lands", async () => {
      const items = [
        waiting("lena-1"),
        lenaOther("lena-old", 1_690_000_000_000),
        friend("friend-1"),
      ];
      let hold = false;
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await mount([], {
        listThreads: vi.fn().mockImplementation(({ accountId }) => {
          if (accountId !== accountA.accountId) return Promise.resolve(page([]));
          return hold ? new Promise(() => {}) : Promise.resolve(page(items));
        }),
        decideSender: vi.fn().mockResolvedValue(blockAnswer),
      });
      await click(findButton("Block Lena Okafor"));
      await settle();
      hold = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      await settle();
      visibility.mockRestore();
      expect(document.body.textContent).not.toContain("Subject lena-old");
    });

    it("skips a letter the block archived when j walks a lone Inbox", async () => {
      const { client } = await mount(
        [waiting("lena-1"), lenaOther("lena-old", 1_700_000_000_300), friend("friend-1")],
        { decideSender: vi.fn().mockResolvedValue(blockAnswer) },
        [accountA],
      );
      await click(findButton("Block Lena Okafor"));
      await settle();
      expect(document.body.textContent).not.toContain("Subject lena-old");
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
      });
      await settle();
      expect(client.readThread).not.toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "lena-old" }),
      );
    });

    it("hands focus to the column when the last waiting row goes and nothing else is left", async () => {
      await mount([waiting("lena-1")]);
      const accept = findButton("Accept Lena Okafor");
      accept.focus();
      await click(accept);
      await settle();
      expect((document.activeElement as HTMLElement).classList.contains("brain-mail-list")).toBe(
        true,
      );
    });

    it("puts a refreshed row back under New senders when an Accept is undone in a lone Inbox", async () => {
      let items: MailThreadListItem[] = [waiting("lena-1"), friend("friend-1")];
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const { onToast, client } = await mount(
        [],
        { listThreads: vi.fn().mockImplementation(() => Promise.resolve(page(items))) },
        [accountA],
      );
      await click(findButton("Accept Lena Okafor"));
      await settle();
      items = [
        { ...friend("lena-1"), participants: waiting("lena-1").participants },
        friend("friend-1"),
      ];
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      await settle();
      (client.listThreads as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {}),
      );
      await act(async () => {
        await toastFor(onToast, "Accepted Lena Okafor")!.onAction!();
      });
      await settle();
      visibility.mockRestore();
      expect(section("New senders")?.textContent ?? "").toContain("Subject lena-1");
    });

    it("keeps a blocked letter out of a deep All inboxes stream after the page-one refresh", async () => {
      const deep = [
        waiting("lena-1"),
        ...Array.from({ length: 58 }, (_, index) => filler(index)),
        lenaOther("lena-old", 1_600_000_000_000),
      ];
      let items: MailThreadListItem[] = deep;
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await mount([], {
        listThreads: vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(page(accountId === accountA.accountId ? items : [])),
        ),
        decideSender: vi.fn().mockResolvedValue(blockAnswer),
      });
      expect(document.body.textContent).toContain("Subject lena-old");
      await click(findButton("Block Lena Okafor"));
      await settle();
      expect(document.body.textContent).not.toContain("Subject lena-old");
      // The service archived both. The tick reads page one only (50 rows):
      // lena-old was never on it, and the deep stream keeps its older tail.
      items = deep
        .filter((item) => item.threadId !== "lena-1" && item.threadId !== "lena-old")
        .slice(0, 50);
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      await settle();
      visibility.mockRestore();
      expect(document.body.textContent).not.toContain("Subject lena-old");
    });

    it("keeps a blocked letter out when a lone Inbox loads more after the block", async () => {
      const first = [
        waiting("lena-1"),
        friend("friend-1"),
        lenaOther("lena-old", 1_690_000_000_000),
      ];
      const older = { ...friend("friend-9"), lastMessageAt: 1_600_000_000_000 };
      await mount(
        [],
        {
          listThreads: vi
            .fn()
            .mockImplementation(({ cursor }) =>
              Promise.resolve(cursor ? page([older]) : { ...page(first), nextCursor: "cursor-2" }),
            ),
          decideSender: vi.fn().mockResolvedValue(blockAnswer),
        },
        [accountA],
      );
      expect(document.body.textContent).toContain("Subject lena-old");
      await click(findButton("Block Lena Okafor"));
      await settle();
      expect(document.body.textContent).not.toContain("Subject lena-old");
      await click(findButton("Load more"));
      await settle();
      expect(document.body.textContent).toContain("Subject friend-9");
      expect(document.body.textContent).not.toContain("Subject lena-old");
    });

    it.each([
      ["the merged Inboxes", [accountA, accountB]],
      ["a lone Inbox", [accountA]],
    ] as const)("takes a marked letter out of %s and shows it once a read clears the mark", async (_, accounts) => {
      let items: MailThreadListItem[] = [
        { ...friend("held"), senderBlocked: true },
        friend("friend-1"),
      ];
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await mount(
        [],
        {
          listThreads: vi
            .fn()
            .mockImplementation(({ accountId }) =>
              Promise.resolve(page(accountId === accountA.accountId ? items : [])),
            ),
        },
        accounts,
      );
      expect(document.body.textContent).toContain("Subject friend-1");
      expect(document.body.textContent).not.toContain("Subject held");
      items = [friend("held"), friend("friend-1")];
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      await settle();
      visibility.mockRestore();
      expect(document.body.textContent).toContain("Subject held");
    });

    it("keeps a blocked letter the request did not archive out after the next read", async () => {
      let items: MailThreadListItem[] = [waiting("lena-1"), friend("friend-1")];
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await mount([], {
        listThreads: vi.fn().mockImplementation(({ accountId }) =>
          Promise.resolve(page(accountId === accountA.accountId ? items : [])),
        ),
        decideSender: vi.fn().mockResolvedValue({
          apiVersion: 1,
          decisionId: DECISION_ID,
          archived: [],
          pending: true,
        }),
      });
      await click(findButton("Block Lena Okafor"));
      await settle();
      expect(document.body.textContent).not.toContain("Subject lena-1");
      // The service no longer flags her (she is decided) and marks the thread
      // blocked until the scheduler's archive lands.
      const blockedItem: MailThreadListItem = {
        ...friend("lena-1"),
        participants: [lena],
        newSender: false,
        senderBlocked: true,
      };
      items = [blockedItem, friend("friend-1")];
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      await settle();
      visibility.mockRestore();
      expect(document.body.textContent).not.toContain("Subject lena-1");
    });

    it("says an Undo nobody answered failed, and then sends the next decision about that sender", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        // The client's deadline (`MAIL_MUTATION_TIMEOUT_MS`) is what ends a
        // DELETE nobody answers; this is how it ends it.
        const { client, onToast } = await mount([waiting("lena-1")], {
          undoSenderDecision: vi.fn().mockImplementation(
            () =>
              new Promise((_resolve, reject) => {
                setTimeout(
                  () => reject(new DOMException("unanswered", "TimeoutError")),
                  MAIL_MUTATION_TIMEOUT_MS,
                );
              }),
          ),
        });
        await click(findButton("Accept Lena Okafor"));
        await settle();
        await act(async () => {
          void toastFor(onToast, "Accepted Lena Okafor")!.onAction!();
        });
        await settle();
        await click(findButton("Accept Lena Okafor"));
        await settle();
        expect(client.decideSender).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MAIL_MUTATION_TIMEOUT_MS);
        });
        await settle();
        expect(onToast).toHaveBeenCalledWith("Couldn’t undo. Try again.", { urgent: true });
        expect(client.decideSender).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    /** Lena's first letter open from All Mail, blocked with the reader's
     *  Block. */
    async function blockFromAllMail(overrides: Partial<MailSurfaceClient> = {}) {
      const lenaAll = waiting("lena-1");
      const mounted = await mount(
        [friend("friend-1")],
        {
          listMailboxThreads: vi
            .fn()
            .mockImplementation(({ mailboxId }) =>
              Promise.resolve(
                mailboxThreadPage(
                  mailboxId,
                  mailboxId === "all" ? [lenaAll, friend("other-1")] : [],
                ),
              ),
            ),
          readMailboxThread: vi
            .fn()
            .mockImplementation(() => Promise.resolve({ ...detail, thread: lenaAll })),
          decideSender: vi.fn().mockResolvedValue({
            apiVersion: 1,
            decisionId: DECISION_ID,
            archived: [{ accountId: accountA.accountId, threadId: "lena-1" }],
            pending: false,
          }),
          ...overrides,
        },
        [accountA],
      );
      await goTo("All Mail");
      await settle();
      await openLetter("Subject lena-1");
      const readerBlock = [
        ...document.body.querySelectorAll(
          'section[aria-label="Message reader"] .toolbar-pill button',
        ),
      ].find((button) => button.textContent?.trim() === "Block") as HTMLButtonElement;
      expect(readerBlock).toBeTruthy();
      await click(readerBlock);
      await settle();
      return mounted;
    }

    it("leaves the reader on the letter when an Undo of a Block in All Mail fails", async () => {
      const { onToast } = await blockFromAllMail({
        undoSenderDecision: vi
          .fn()
          .mockRejectedValue(new MailApiError(503, "mail_senders_unavailable")),
      });
      await act(async () => {
        await toastFor(onToast, "Blocked Lena Okafor")!.onAction!();
      });
      await settle();
      expect(onToast).toHaveBeenCalledWith("Couldn’t undo. Try again.", { urgent: true });
      expect(
        document.body.querySelector('section[aria-label="Message reader"]')?.textContent,
      ).not.toContain("Choose a message");
    });

    it("leaves the letter listed, and the reader on it, after a Block made from All Mail", async () => {
      await blockFromAllMail();
      const list = document.body.querySelector('section[aria-label="Mailbox"]')!;
      expect(list.textContent).toContain("Subject lena-1");
      expect(
        document.body.querySelector('section[aria-label="Message reader"]')?.textContent,
      ).not.toContain("Choose a message");
    });

    it("draws no leaving ghost over a row a Block in All Mail leaves where it stands", async () => {
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        writable: true,
        value: vi.fn(() => ({ finished: new Promise(() => {}), cancel: () => {} })),
      });
      try {
        await blockFromAllMail();
        const copies = [
          ...document.body.querySelectorAll('section[aria-label="Mailbox"] *'),
        ].filter(
          (element) =>
            element.getAttribute("aria-hidden") === "true" &&
            element.textContent?.includes("Subject lena-1"),
        );
        expect(copies).toEqual([]);
      } finally {
        delete (HTMLElement.prototype as { animate?: unknown }).animate;
      }
    });
  });

  /** OPENING MAIL ANSWERS THE BELL'S MAIL ROW. The centre holds one row for
   *  new mail, "10 new messages", and Mail being open is what reads it —
   *  whichever way Mail was opened, which is why the call is on the mount and
   *  not on the press. */
  describe("the bell's mail row", () => {
    beforeEach(() => {
      markMailCentreRead.mockClear();
      closeMailCentreRead.mockClear();
    });

    it("is registered once when Mail mounts, and released when it goes", async () => {
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      expect(markMailCentreRead).toHaveBeenCalledTimes(1);
      expect(closeMailCentreRead).not.toHaveBeenCalled();

      // A re-render is not a second opening of Mail.
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      expect(markMailCentreRead).toHaveBeenCalledTimes(1);
      expect(closeMailCentreRead).not.toHaveBeenCalled();

      // And leaving Mail ends it, so a row that opens afterwards stays unread.
      await act(async () => root.render(<></>));
      await settle();
      expect(closeMailCentreRead).toHaveBeenCalledTimes(1);
    });
  });

  /** A THREAD ASKED FOR FROM OUTSIDE MAIL.
   *
   *  The notification centre is a menu in the sidebar, on whatever surface the
   *  reader is on, and an `agent-action` row in it opens a letter. It cannot
   *  hand this component a list item, because Mail has not mounted when the row
   *  is pressed and the row holds an id pair. It leaves the pair in
   *  `mail-surface-client` and the surface answers it here: in the account the
   *  letter belongs to, with the thread selected, and the request taken back
   *  off.
   */
  describe("a thread asked for from outside Mail", () => {
    const other: MailThreadListItem = {
      ...thread,
      accountId: accountB.accountId,
      threadId: "thread-b",
      subject: "The other address",
    };

    function pageFor(accountId: string): MailThreadPage {
      return {
        apiVersion: 1,
        items: accountId === accountB.accountId ? [other] : [thread],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
      };
    }

    function detailFor(
      item: MailThreadListItem,
      inInbox = true,
    ): MailThreadDetail {
      return {
        ...detail,
        thread: item,
        messages: detail.messages.map((message) => ({
          ...message,
          threadId: item.threadId,
          inInbox,
        })),
      };
    }

    /** The request is answered across several commits (a list load, sometimes
     *  an account switch and its load), so the wait is on the outcome rather
     *  than on a fixed number of microtask rounds. */
    async function until(ok: () => boolean, what: string) {
      for (let round = 0; round < 60; round += 1) {
        if (ok()) return;
        await settle();
      }
      throw new Error(`not reached: ${what}`);
    }

    afterEach(() => {
      clearOpenThreadRequest();
    });

    it("opens a thread the loaded list already holds", async () => {
      // Pressed before Mail exists, which is the real order: the centre writes
      // the request and the shell then opens the surface.
      requestOpenThread(accountA.accountId, thread.threadId);
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await until(
        () => vi.mocked(client.readThread).mock.calls.length > 0,
        "the thread is read",
      );
      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
      });
      // The point of the in-list branch is the read it avoids: a fallback
      // fetch reaches readThread twice for the same press, and only this
      // count tells the two paths apart.
      expect(client.readThread).toHaveBeenCalledTimes(1);
      expect(pendingOpenThread()).toBeNull();
    });

    it("switches to the letter's own account and opens it there", async () => {
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads: vi
          .fn()
          .mockImplementation(({ accountId }: { accountId: string }) =>
            Promise.resolve(pageFor(accountId)),
          ),
        readThread: vi.fn().mockResolvedValue({ ...detail, thread: other }),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount(accountA);
      expect(document.body.textContent).toContain("Lunch this Friday?");

      await act(async () => {
        requestOpenThread(accountB.accountId, other.threadId);
      });
      await until(
        () => vi.mocked(client.readThread).mock.calls.length > 0,
        "the other account's thread is read",
      );

      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountB.accountId,
        threadId: other.threadId,
      });
      // The column moved with it: the letter would have nowhere to stand in
      // the account it is not in.
      expect(document.body.textContent).toContain("The other address");
      // The account it left behind is gone from the column, not covered by
      // the one that arrived.
      expect(document.body.textContent).not.toContain("Lunch this Friday?");
      expect(pendingOpenThread()).toBeNull();
    });

    it("fetches a thread the loaded page does not hold", async () => {
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      await act(async () => {
        requestOpenThread(accountA.accountId, "thread-elsewhere");
      });
      await until(
        () =>
          vi
            .mocked(client.readThread)
            .mock.calls.some(([input]) => input.threadId === "thread-elsewhere"),
        "the thread outside the page is read",
      );
      expect(pendingOpenThread()).toBeNull();
    });

    it("leaves the list standing when the thread is nowhere to be found", async () => {
      const onToast = vi.fn();
      const client = makeClient({
        readThread: vi.fn().mockRejectedValue(new MailApiError(404, "not_found")),
      });
      await act(async () =>
        root.render(
          <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
        ),
      );
      await settle();
      await enterSingleAccount();

      await act(async () => {
        requestOpenThread(accountA.accountId, "thread-gone");
      });
      await until(() => pendingOpenThread() === null, "the request is dropped");
      // A row that cannot be opened is not an error to report to whoever
      // pressed it: Mail is open, at the list it was going to show anyway.
      expect(document.body.textContent).toContain("Lunch this Friday?");
      expect(onToast).not.toHaveBeenCalled();
    });

    it.each([
      [404, "mail_thread_not_found"],
      [503, "mail_sync_unavailable"],
      [409, "mail_sync_in_progress"],
    ])(
      "says so once when the mailbox the search named cannot give the letter (%i)",
      async (status, code) => {
        // The palette's row was on screen a moment ago and the reader chose
        // it. A pick that silently lands on "Choose a message" reads as a
        // press that did nothing, which is how this bug was found.
        const onToast = vi.fn();
        const client = makeClient({
          readThread: vi
            .fn()
            .mockRejectedValue(new MailApiError(404, "mail_thread_not_found")),
          readMailboxThread: vi
            .fn()
            .mockRejectedValue(new MailApiError(status, code)),
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

        await act(async () => {
          requestOpenThread(accountA.accountId, "thread-gone", "all");
        });
        await until(() => pendingOpenThread() === null, "the request is dropped");
        await settle();

        expect(onToast).toHaveBeenCalledTimes(1);
        expect(onToast).toHaveBeenCalledWith("Couldn’t open that letter.");
        expect(reader()?.textContent).toContain("Choose a message");
      },
    );

    it("moves the column back to Inbox with an empty query and opens the letter from Sent", async () => {
      vi.useFakeTimers();
      const sentThread = {
        ...thread,
        threadId: "thread-sent",
        subject: "Sent project update",
        unread: false,
      };
      const listMailboxThreads = vi.fn().mockImplementation(({ mailboxId }) =>
        Promise.resolve(
          mailboxThreadPage(mailboxId, mailboxId === "sent" ? [sentThread] : []),
        ),
      );
      // The search over Sent finds only the sent letter: the one the request
      // names is in the Inbox and nowhere on screen, which is the case.
      const searchThreads = vi
        .fn()
        .mockResolvedValue(searchThreadPage("sent", [sentThread]));
      const client = makeClient({ listMailboxThreads, searchThreads });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("Sent");
      expect(document.body.textContent).toContain("Sent project update");
      const input = document.body.querySelector(
        'input[aria-label="Search mail"]',
      ) as HTMLInputElement;
      await setInput(input, "project");
      await act(async () => vi.advanceTimersByTimeAsync(250));
      await settle();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Sent");

      // The palette's pick: a letter of the Inbox, named while the reader
      // stands on Sent over a search.
      await act(async () => {
        requestOpenThread(accountA.accountId, thread.threadId);
      });
      // The clock is fake here for the search debounce above, so the wait
      // advances it as well as the microtasks the other cases settle on.
      for (let round = 0; round < 60; round += 1) {
        if (vi.mocked(client.readThread).mock.calls.length > 0) break;
        await act(async () => vi.advanceTimersByTimeAsync(20));
        await settle();
      }
      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
      });
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
      expect(
        (document.body.querySelector('input[aria-label="Search mail"]') as HTMLInputElement)
          .value,
      ).toBe("");
      expect(pendingOpenThread()).toBeNull();
    });

    it("stays on the letter it was last asked for when an abandoned request's fetch resolves late", async () => {
      const abandonedFetch = deferred<MailThreadDetail>();
      const secondFetch = deferred<MailThreadDetail>();
      const abandoned: MailThreadListItem = {
        ...thread,
        threadId: "thread-abandoned",
        subject: "The abandoned letter",
      };
      const second: MailThreadListItem = {
        ...thread,
        threadId: "thread-second",
        subject: "The second letter",
      };
      const readThread = vi
        .fn()
        .mockImplementation(({ threadId }: { threadId: string }) => {
          if (threadId === "thread-abandoned") return abandonedFetch.promise;
          if (threadId === "thread-second") return secondFetch.promise;
          return Promise.resolve(detail);
        });
      const client = makeClient({ readThread });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();

      // Pressed first, for a letter the loaded page does not hold: the
      // fallback fetch starts and hangs.
      await act(async () => {
        requestOpenThread(accountA.accountId, "thread-abandoned");
      });
      await settle();
      // Pressed second, before the first answers: the slot now holds this
      // one, and its own fetch starts too.
      await act(async () => {
        requestOpenThread(accountA.accountId, "thread-second");
      });
      await settle();

      // The second press answers first: the reader opens it.
      await act(async () => {
        secondFetch.resolve(detailFor(second));
        await secondFetch.promise;
      });
      await settle();
      expect(document.body.textContent).toContain("The second letter");

      // The abandoned fetch lands after: it must not move the reader off
      // the letter they asked for since.
      await act(async () => {
        abandonedFetch.resolve(detailFor(abandoned));
        await abandonedFetch.promise;
      });
      await settle();

      expect(document.body.textContent).toContain("The second letter");
      expect(document.body.textContent).not.toContain("The abandoned letter");
    });

    it("opens a thread the unified list already holds, without switching accounts", async () => {
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads: vi
          .fn()
          .mockImplementation(({ accountId }: { accountId: string }) =>
            Promise.resolve(pageFor(accountId)),
          ),
        readThread: vi.fn().mockResolvedValue(detailFor(other)),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: All inboxes");

      await act(async () => {
        requestOpenThread(accountB.accountId, other.threadId);
      });
      await until(
        () => vi.mocked(client.readThread).mock.calls.length > 0,
        "the unified thread is read",
      );

      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountB.accountId,
        threadId: other.threadId,
      });
      // The point of the unified branch is the read it avoids too.
      expect(client.readThread).toHaveBeenCalledTimes(1);
      // Answered without a switch: All inboxes is still the destination.
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: All inboxes");
      expect(document.body.textContent).toContain("The other address");
      expect(pendingOpenThread()).toBeNull();
    });

    it("brings a same-account request back to Inbox when the reader is off it", async () => {
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("Sent");

      await act(async () => {
        requestOpenThread(accountA.accountId, "thread-elsewhere");
      });
      await until(() => pendingOpenThread() === null, "the request is answered");

      // The press named a letter, so the column moves to Inbox and the
      // letter, not in the page, is fetched from there.
      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: "thread-elsewhere",
      });
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
    });

    it("brings a cross-account request back to Inbox and then across", async () => {
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads: vi
          .fn()
          .mockImplementation(({ accountId }: { accountId: string }) =>
            Promise.resolve(pageFor(accountId)),
          ),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount(accountA);
      await goTo("Sent");

      await act(async () => {
        requestOpenThread(accountB.accountId, other.threadId);
      });
      await until(() => pendingOpenThread() === null, "the request is answered");

      // Inbox first, then the other account's own Inbox, where the letter is
      // in the page: one switch, one read.
      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountB.accountId,
        threadId: other.threadId,
      });
      expect(client.readThread).toHaveBeenCalledTimes(1);
      expect(navTrigger()?.getAttribute("aria-label")).toContain("Inbox");
      expect(document.body.textContent).toContain("The other address");
    });

    /** The palette searches each account's widest mailbox, All Mail on Gmail,
     *  so a pick can name a letter archived long ago. The Inbox read answers
     *  404 for it, and a request that only knew Inbox opened nothing. The
     *  request now carries the mailbox the search used, and the column goes
     *  there. */
    const archived: MailThreadListItem = {
      ...thread,
      threadId: "thread-archived",
      subject: "The archived letter",
    };

    function reader(): HTMLElement | null {
      return document.body.querySelector('section[aria-label="Message reader"]');
    }

    function readerButtons(): string[] {
      return [...(reader()?.querySelectorAll("button") ?? [])].map(
        (button) => button.textContent?.trim() ?? "",
      );
    }

    it("opens a letter found outside Inbox in the mailbox the search used", async () => {
      const readMailboxThread = vi
        .fn()
        .mockResolvedValue(detailFor(archived, false));
      const client = makeClient({
        readThread: vi
          .fn()
          .mockRejectedValue(new MailApiError(404, "mail_thread_not_found")),
        readMailboxThread,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");

      await act(async () => {
        requestOpenThread(accountA.accountId, archived.threadId, "all");
      });
      await until(() => pendingOpenThread() === null, "the request is answered");
      await until(
        () => reader()?.textContent?.includes("The archived letter") === true,
        "the reader opens the archived letter",
      );

      expect(readMailboxThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        mailboxId: "all",
        threadId: archived.threadId,
      });
      expect(client.readThread).not.toHaveBeenCalledWith(
        expect.objectContaining({ threadId: archived.threadId }),
      );
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: All Mail");
      // All Mail's reader: a letter already out of Inbox has no Archive, and
      // its way back instead.
      expect(readerButtons()).not.toContain("Archive");
      expect(readerButtons()).toContain("Move to Inbox");
    });

    /** A letter the palette opens from deep in All Mail is not on that
     *  mailbox's first page, and the refetch after an action read its absence
     *  there as the letter having left: the reader closed on "Choose a
     *  message". Only an action that moves the letter may close it. The client
     *  is server truth: a mutation changes what the next read returns. */
    function deepLetterClient(initial: { unread: boolean }) {
      let unread = initial.unread;
      let starred = false;
      const updateThread = vi.fn().mockImplementation(async (input) => {
        if ("read" in input) unread = !input.read;
        if ("starred" in input) starred = input.starred;
      });
      const client = makeClient({
        readThread: vi
          .fn()
          .mockRejectedValue(new MailApiError(404, "mail_thread_not_found")),
        readMailboxThread: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(detailFor({ ...archived, unread, starred })),
          ),
        updateThread,
      });
      return { client, updateThread };
    }

    async function openDeepLetter(client: MailSurfaceClient) {
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await act(async () => {
        requestOpenThread(accountA.accountId, archived.threadId, "all");
      });
      await until(() => pendingOpenThread() === null, "the request is answered");
      await until(
        () => reader()?.textContent?.includes("The archived letter") === true,
        "the reader opens the archived letter",
      );
    }

    async function openMoreActions() {
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
    }

    it("keeps an unread letter from deep in All Mail open once it is read", async () => {
      const { client, updateThread } = deepLetterClient({ unread: true });
      await openDeepLetter(client);
      await until(
        () => updateThread.mock.calls.length > 0,
        "the letter is read on open",
      );
      await settle();

      expect(updateThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: archived.threadId,
        read: true,
      });
      expect(reader()?.textContent).toContain("The archived letter");
      expect(reader()?.textContent).not.toContain("Choose a message");
      // Read, and the header offers the reverse.
      expect(readerButtons()).toContain("Mark unread");
    });

    it("keeps a letter from deep in All Mail open and starred after Star", async () => {
      const { client, updateThread } = deepLetterClient({ unread: false });
      await openDeepLetter(client);
      expect(updateThread).not.toHaveBeenCalled();

      await openMoreActions();
      await click(findMenuItem("Star"));
      await settle();

      expect(updateThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: archived.threadId,
        starred: true,
      });
      expect(reader()?.textContent).toContain("The archived letter");
      await openMoreActions();
      expect(findMenuItem("Remove star")).toBeInstanceOf(HTMLElement);
    });

    it("keeps a letter from deep in All Mail open once it is moved to the Inbox", async () => {
      // Moving it to the Inbox leaves it in All Mail, so its absence from the
      // refetched first page is not a sign that it went anywhere.
      let inInbox = false;
      const updateThread = vi.fn().mockImplementation(async (input) => {
        if ("archive" in input) inInbox = !input.archive;
      });
      const client = makeClient({
        readThread: vi
          .fn()
          .mockRejectedValue(new MailApiError(404, "mail_thread_not_found")),
        readMailboxThread: vi.fn().mockImplementation(() => {
          const letter = detailFor(archived);
          return Promise.resolve({
            ...letter,
            messages: letter.messages.map((message) => ({ ...message, inInbox })),
          });
        }),
        updateThread,
      });
      await openDeepLetter(client);
      expect(readerButtons()).toContain("Move to Inbox");

      await click(findButton("Move to Inbox"));
      await settle();

      expect(updateThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: archived.threadId,
        archive: false,
      });
      expect(reader()?.textContent).toContain("The archived letter");
      expect(reader()?.textContent).not.toContain("Choose a message");
      expect(readerButtons()).not.toContain("Move to Inbox");
      expect(readerButtons()).toContain("Archive");

      // Archived again it is still in All Mail, and still not on its first
      // page: the reader stays on it and offers the way back once more.
      const archive = [...(reader()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Archive",
      ) as HTMLButtonElement;
      await click(archive);
      await settle();

      expect(updateThread).toHaveBeenLastCalledWith({
        accountId: accountA.accountId,
        threadId: archived.threadId,
        archive: true,
      });
      expect(reader()?.textContent).toContain("The archived letter");
      expect(readerButtons()).toContain("Move to Inbox");
      expect(readerButtons()).not.toContain("Archive");
    });

    it("opens a letter the search found in All Mail from Inbox when Inbox holds it", async () => {
      // Pressed before Mail exists, so the request is in hand while the Inbox
      // page is still loading. Most of what the palette finds in All Mail is
      // in Inbox too, and Inbox is where the letter keeps its Archive: the
      // column waits for that page before it moves anywhere.
      requestOpenThread(accountA.accountId, thread.threadId, "all");
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();

      await until(
        () => vi.mocked(client.readThread).mock.calls.length > 0,
        "the thread is read from Inbox",
      );
      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
      });
      expect(client.listMailboxThreads).not.toHaveBeenCalled();
      expect(client.readMailboxThread).not.toHaveBeenCalled();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
      expect(pendingOpenThread()).toBeNull();
    });

    /** From another folder of the same account, or over a search, the column
     *  goes to Inbox first as well, and follows the letter to All Mail only
     *  when Inbox does not hold it: the same letter opens in the same place
     *  whichever folder the reader happened to be standing on. */
    function inboxFirstClient() {
      return makeClient({
        // Sent and the search hold nothing; All Mail holds the letter too, so
        // a column that skipped Inbox would open it there.
        listMailboxThreads: vi.fn().mockImplementation(({ mailboxId }) =>
          Promise.resolve(mailboxThreadPage(mailboxId, mailboxId === "all" ? [thread] : [])),
        ),
        searchThreads: vi
          .fn()
          .mockImplementation(({ mailboxId }) =>
            Promise.resolve(searchThreadPage(mailboxId, [])),
          ),
      });
    }

    it("looks in Inbox before All Mail when the request arrives on Sent", async () => {
      const client = inboxFirstClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("Sent");

      await act(async () => {
        requestOpenThread(accountA.accountId, thread.threadId, "all");
      });
      await until(() => pendingOpenThread() === null, "the request is answered");
      await settle();

      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
      });
      expect(client.readMailboxThread).not.toHaveBeenCalled();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
    });

    it("looks in Inbox before All Mail when the request arrives over a search", async () => {
      vi.useFakeTimers();
      const client = inboxFirstClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      const input = document.body.querySelector(
        'input[aria-label="Search mail"]',
      ) as HTMLInputElement;
      await setInput(input, "nothing here");
      await act(async () => vi.advanceTimersByTimeAsync(250));
      await settle();
      expect(client.searchThreads).toHaveBeenCalled();

      await act(async () => {
        requestOpenThread(accountA.accountId, thread.threadId, "all");
      });
      for (let round = 0; round < 60; round += 1) {
        if (vi.mocked(client.readThread).mock.calls.length > 0) break;
        await act(async () => vi.advanceTimersByTimeAsync(20));
        await settle();
      }

      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
      });
      expect(client.readMailboxThread).not.toHaveBeenCalled();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
      expect(
        (document.body.querySelector('input[aria-label="Search mail"]') as HTMLInputElement)
          .value,
      ).toBe("");
    });

    it("opens a letter found outside Inbox from All inboxes too", async () => {
      const archivedB: MailThreadListItem = {
        ...archived,
        accountId: accountB.accountId,
      };
      const readMailboxThread = vi.fn().mockResolvedValue(detailFor(archivedB));
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads: vi
          .fn()
          .mockImplementation(({ accountId }: { accountId: string }) =>
            Promise.resolve(pageFor(accountId)),
          ),
        readThread: vi
          .fn()
          .mockRejectedValue(new MailApiError(404, "mail_thread_not_found")),
        readMailboxThread,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: All inboxes");

      await act(async () => {
        requestOpenThread(accountB.accountId, archivedB.threadId, "all");
      });
      await until(() => pendingOpenThread() === null, "the request is answered");
      await until(
        () => reader()?.textContent?.includes("The archived letter") === true,
        "the reader opens the archived letter",
      );

      expect(readMailboxThread).toHaveBeenCalledWith({
        accountId: accountB.accountId,
        mailboxId: "all",
        threadId: archivedB.threadId,
      });
      expect(client.readThread).not.toHaveBeenCalled();
      expect(navTrigger()?.getAttribute("aria-label")).toContain("All Mail");
    });

    it("takes a cross-account request to the other account's mailbox from a folder", async () => {
      // Sent resets to Inbox before the switch, the switch lands on the other
      // account's Inbox, and the move to All Mail after it is that account's
      // own: two moves for one request, neither of them a loop.
      const archivedB: MailThreadListItem = {
        ...archived,
        accountId: accountB.accountId,
      };
      const readMailboxThread = vi.fn().mockResolvedValue(detailFor(archivedB));
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([accountA, accountB]),
        listThreads: vi
          .fn()
          .mockImplementation(({ accountId }: { accountId: string }) =>
            Promise.resolve(pageFor(accountId)),
          ),
        readMailboxThread,
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount(accountA);
      await goTo("Sent");

      await act(async () => {
        requestOpenThread(accountB.accountId, archivedB.threadId, "all");
      });
      await until(() => pendingOpenThread() === null, "the request is answered");
      await until(
        () => reader()?.textContent?.includes("The archived letter") === true,
        "the reader opens the archived letter",
      );

      expect(readMailboxThread).toHaveBeenCalledWith({
        accountId: accountB.accountId,
        mailboxId: "all",
        threadId: archivedB.threadId,
      });
      expect(navTrigger()?.getAttribute("aria-label")).toContain("All Mail");
    });

    it("still lands a request that names no mailbox on Inbox", async () => {
      // The notification centre names no mailbox: its letters are new mail.
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("All Mail");

      await act(async () => {
        requestOpenThread(accountA.accountId, "thread-elsewhere");
      });
      await until(() => pendingOpenThread() === null, "the request is answered");

      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: "thread-elsewhere",
      });
      expect(client.readMailboxThread).not.toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread-elsewhere" }),
      );
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
    });

    /** A letter in the list on screen is not yet the answer. All Mail holds
     *  most of the Inbox too, and a notification's letter found there opened
     *  in All Mail only because All Mail was the folder showing. The list
     *  counts when it is the mailbox the request named, or the Inbox every
     *  request looks in first. */
    it("opens a notification's letter in Inbox even when All Mail on screen lists it", async () => {
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("All Mail");
      expect(document.body.textContent).toContain("Lunch this Friday?");

      await act(async () => {
        requestOpenThread(accountA.accountId, thread.threadId);
      });
      await until(() => pendingOpenThread() === null, "the request is answered");
      await until(
        () => vi.mocked(client.readThread).mock.calls.length > 0,
        "the letter is read from Inbox",
      );

      expect(client.readThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        threadId: thread.threadId,
      });
      expect(client.readMailboxThread).not.toHaveBeenCalled();
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
      expect(readerButtons()).toContain("Archive");
    });

    it("does not answer from the folder the column just left for Inbox", async () => {
      // The letter left Inbox since the notification was written. The reset
      // moves the column to Inbox while All Mail's rows are still the list in
      // hand, and those rows are not Inbox's: opening from them read the
      // letter from Inbox and put "Message couldn't load" on screen.
      const onToast = vi.fn();
      const client = makeClient({
        listThreads: vi.fn().mockResolvedValue({ ...threadPage, items: [] }),
        readThread: vi
          .fn()
          .mockRejectedValue(new MailApiError(404, "mail_thread_not_found")),
      });
      await act(async () =>
        root.render(
          <MailSurface client={client} onOpenSettings={() => {}} onToast={onToast} />,
        ),
      );
      await settle();
      await enterSingleAccount();
      await goTo("All Mail");
      expect(document.body.textContent).toContain("Lunch this Friday?");

      await act(async () => {
        requestOpenThread(accountA.accountId, thread.threadId);
      });
      await until(() => pendingOpenThread() === null, "the request is dropped");
      await settle();

      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: Inbox");
      expect(reader()?.textContent).toContain("Choose a message");
      expect(reader()?.textContent).not.toContain("couldn’t load");
      expect(onToast).not.toHaveBeenCalled();
    });

    it("opens a palette pick in All Mail when All Mail on screen lists it", async () => {
      const client = makeClient();
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount();
      await goTo("All Mail");
      const listReads = vi.mocked(client.listMailboxThreads).mock.calls.length;

      await act(async () => {
        requestOpenThread(accountA.accountId, thread.threadId, "all");
      });
      await until(
        () => vi.mocked(client.readMailboxThread).mock.calls.length > 0,
        "the letter is read from All Mail",
      );

      expect(client.readMailboxThread).toHaveBeenCalledWith({
        accountId: accountA.accountId,
        mailboxId: "all",
        threadId: thread.threadId,
      });
      expect(client.readThread).not.toHaveBeenCalled();
      // Answered from the list in hand: the column did not move to look.
      expect(client.listMailboxThreads).toHaveBeenCalledTimes(listReads);
      expect(navTrigger()?.getAttribute("aria-label")).toBe("Mailbox: All Mail");
      expect(pendingOpenThread()).toBeNull();
    });

    it("answers in Inbox when the account has no such mailbox", async () => {
      const client = makeClient({
        loadAccounts: vi.fn().mockResolvedValue([imapAccount]),
      });
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      await enterSingleAccount(imapAccount);

      await act(async () => {
        requestOpenThread(imapAccount.accountId, "thread-elsewhere", "all");
      });
      await until(() => pendingOpenThread() === null, "the request is answered");

      expect(client.readThread).toHaveBeenCalledWith({
        accountId: imapAccount.accountId,
        threadId: "thread-elsewhere",
      });
      expect(client.readMailboxThread).not.toHaveBeenCalled();
    });

    it("clears an unanswered request when the Mail surface unmounts", async () => {
      const client = makeClient({
        loadAccounts: vi
          .fn()
          .mockReturnValue(new Promise<PublicMailAccount[]>(() => {})),
      });
      requestOpenThread(accountA.accountId, "thread-elsewhere");
      await act(async () =>
        root.render(<MailSurface client={client} onOpenSettings={() => {}} />),
      );
      await settle();
      expect(pendingOpenThread()).not.toBeNull();

      await act(async () => root.render(<div>Home</div>));

      expect(pendingOpenThread()).toBeNull();
    });

    it("keeps the request through StrictMode's rehearsed unmount at mount", async () => {
      // `next dev` mounts every effect, unmounts it and mounts it again, and
      // the unmount clear ran on that rehearsal: a press from the palette or
      // the centre lost its letter on every development mount, and no browser
      // test had opened one from outside Mail to see it.
      requestOpenThread(accountA.accountId, thread.threadId);
      const client = makeClient();
      await act(async () =>
        root.render(
          <StrictMode>
            <MailSurface client={client} onOpenSettings={() => {}} />
          </StrictMode>,
        ),
      );
      await settle();
      await enterSingleAccount();

      await until(
        () => vi.mocked(client.readThread).mock.calls.length > 0,
        "the thread is read under StrictMode",
      );
      expect(pendingOpenThread()).toBeNull();

      // And a real unmount still takes an unanswered request with it.
      requestOpenThread(accountA.accountId, "thread-later");
      await act(async () => root.render(<div>Home</div>));
      await settle();
      expect(pendingOpenThread()).toBeNull();
    });
  });
});
