import { expect, test, type Page, type Route } from "playwright/test";

import {
  validateMailDraftCreateInput,
  validateMailDraftMutationInput,
} from "../lib/mail/draft-codec";
import type { MailDraftDto, MailDraftMutationInput } from "../lib/mail/draft-types";
import { MAIL_MUTATION_TIMEOUT_MS } from "../components/mail-surface-client";

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

const account = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  emailAddress: "person@example.test",
  displayName: "Personal",
  status: "connected",
  connectedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerKind: "gmail",
  capabilities: gmailCapabilities,
} as const;

const imapAccount = {
  ...account,
  providerKind: "imap",
  capabilities: {
    // Inbox-only listing, but a full set of thread mutations: STORE for flags
    // and a MOVE into a discovered mailbox for archive, trash and junk.
    mailboxes: ["inbox"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: false,
    send: false,
    reply: false,
  },
  imap: {
    hostname: "imap.example.test",
    port: 993,
    tls: "implicit",
    username: "person@example.test",
  },
} as const;

const thread = {
  accountId: account.accountId,
  threadId: "thread-1",
  subject: "Lunch this Friday?",
  participants: [{ name: "Ben Johnson", address: "ben@example.test" }],
  snippet: "12PM sounds great to me.",
  lastMessageAt: 1_700_000_000_000,
  messageCount: 2,
  unread: true,
  starred: false,
  hasAttachments: true,
} as const;

const threadPage = {
  apiVersion: 1,
  items: [thread],
  nextCursor: null,
  sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
} as const;

const sentThread = {
  ...thread,
  threadId: "thread-sent",
  subject: "Project update sent",
  unread: false,
} as const;

const sentThreadPage = {
  apiVersion: 1,
  mailboxId: "sent",
  items: [sentThread],
  nextCursor: null,
  availability: {
    status: "available",
    lastSuccessfulAt: 1_700_000_000_000,
    windowTruncated: false,
  },
} as const;

const searchThread = {
  ...thread,
  threadId: "thread-search",
  subject: "Quarterly launch review",
  snippet: "Cached preview match",
} as const;

const detail = {
  apiVersion: 1,
  thread,
  messages: [
    {
      accountId: account.accountId,
      messageId: "message-1",
      threadId: thread.threadId,
      from: { name: "Ben Johnson", address: "ben@example.test" },
      replyTo: [],
      to: [
        { name: "Personal", address: account.emailAddress },
        { name: "Alex", address: "alex@example.test" },
      ],
      cc: [{ name: "Casey", address: "casey@example.test" }],
      subject: thread.subject,
      sentAt: 1_700_000_000_000,
      unread: true,
      inInbox: true,
      snippet: "Safe preview",
      textBody: "Lunch at 12PM sounds great to me.",
      htmlBody: '<img src="https://tracker.example.test/pixel">',
      hasAttachments: true,
    },
  ],
} as const;

const sentDetail = {
  ...detail,
  thread: sentThread,
  messages: detail.messages.map((message) => ({
    ...message,
    messageId: "message-sent",
    threadId: sentThread.threadId,
    subject: sentThread.subject,
    unread: false,
    inInbox: false,
    textBody: "This update was sent safely.",
  })),
} as const;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/auth") &&
        candidate.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

/** THE one control that owns mail navigation, at every width and in every
 *  mode. Its presence is also the "Mail surface is up" signal. */
function navTrigger(page: Page) {
  return page.locator('button[aria-label^="Mailbox: "]');
}

/** Go somewhere through the nav menu — a mailbox, a smart view, Drafts, an
 *  account, All inboxes. One door for all of them, which is the point. */
async function goTo(page: Page, name: string | RegExp) {
  await navTrigger(page).click();
  await page.getByRole("menuitemradio", { name }).click();
}

/**
 * A lone account opens straight into its Inbox — the merge exists only where
 * there is a second account to merge, and the nav menu draws no Accounts
 * block for one address (§13). With two or more, mail mounts into All inboxes
 * and specs that want one account switch through the Accounts block, the way
 * the reader does.
 */
async function enterSingleAccount(
  page: Page,
  target: { readonly accountId: string; readonly emailAddress: string } = account,
) {
  await expect(navTrigger(page)).toHaveCount(1);
  const label = await navTrigger(page).getAttribute("aria-label");
  if (label === "Mailbox: All inboxes") {
    await goTo(page, `Open ${target.emailAddress}`);
    return;
  }
  await expect(navTrigger(page)).toHaveAttribute("aria-label", "Mailbox: Inbox");
}

/** A second account, so the merged mode exists at all: its stream is empty
 *  and no spec acts on it, so every count and every row reads as before. */
const secondAccount = {
  ...account,
  // ids are `account-a` + 32 hex, the way the client validates them
  accountId: `account-a${"b".repeat(32)}`,
  emailAddress: "second@example.test",
  displayName: null,
} as const;

/** What a thread-list route answers for the account it was asked for: the
 *  spec's own items for `account`, nothing for the second. */
function forAccount<T>(route: Route, items: readonly T[]): readonly T[] {
  return new URL(route.request().url()).searchParams.get("accountId") ===
    secondAccount.accountId
    ? []
    : items;
}

/** Connects the second account over `installMailRoutes`. Later routes win in
 *  Playwright: the capabilities answer both accounts, the second's thread
 *  stream answers empty, and everything else falls back to the handler
 *  installed before. */
async function installSecondAccount(page: Page) {
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ apiVersion: 3, accounts: [account, secondAccount] }),
    }),
  );
  await page.route(/\/api\/mail\/threads\?.*$/, (route) =>
    new URL(route.request().url()).searchParams.get("accountId") ===
    secondAccount.accountId
      ? route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({
            apiVersion: 1,
            items: [],
            nextCursor: null,
            sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
          }),
        })
      : route.fallback(),
  );
}

async function installMailRoutes(
  page: Page,
  contentOverride?: {
    readonly textBody: string | null;
    readonly htmlBody: string | null;
  },
) {
  const sendRequests: Array<{
    readonly draft: MailDraftDto;
    readonly request: Extract<MailDraftMutationInput, { readonly kind: "send" }>;
  }> = [];
  const mutationBodies: unknown[] = [];
  const searchBodies: unknown[] = [];
  const threadListRequests: string[] = [];
  const drafts = new Map<string, MailDraftDto>();
  let sentThreadTrashed = false;
  // Server truth for thread-1's read state: opening the thread auto-fires
  // PATCH {read:true}, and later reads must reflect it or the client would
  // auto-read again on every refetch.
  let threadUnread = true;
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });

  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account] }),
  );
  await page.route(/\/api\/mail\/threads\/thread-1(?:\?.*)?$/, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      mutationBodies.push(body);
      if (typeof body === "object" && body !== null && "read" in body) {
        threadUnread = body.read !== true;
      }
      return fulfill(route, {
        apiVersion: 1,
        thread: { ...thread, unread: threadUnread },
      });
    }
    return fulfill(route, {
      ...detail,
      thread: { ...thread, unread: threadUnread },
    });
  });
  await page.route(/\/api\/mail\/threads\/thread-sent(?:\?.*)?$/, (route) => {
    const body = route.request().postDataJSON();
    mutationBodies.push(body);
    if (
      typeof body === "object" &&
      body !== null &&
      "trash" in body &&
      body.trash === true
    ) {
      sentThreadTrashed = true;
    }
    return fulfill(route, { apiVersion: 1, thread: sentThread });
  });
  await page.route(
    /\/api\/mail\/mailboxes\/sent\/threads\/thread-sent(?:\?.*)?$/,
    (route) => fulfill(route, sentDetail),
  );
  await page.route(/\/api\/mail\/mailboxes\/sent\/threads\?.*$/, (route) =>
    fulfill(route, {
      ...sentThreadPage,
      items: sentThreadTrashed ? [] : sentThreadPage.items,
    }),
  );
  await page.route(/\/api\/mail\/threads\?.*$/, (route) => {
    threadListRequests.push(route.request().url());
    return fulfill(route, {
      ...threadPage,
      items: [{ ...thread, unread: threadUnread }],
    });
  });
  await page.route("**/api/mail/search", (route) => {
    const body = route.request().postDataJSON();
    searchBodies.push(body);
    return fulfill(route, {
      apiVersion: 1,
      mailboxId: "inbox",
      scope: "headers_and_previews",
      items: [searchThread],
      nextCursor: null,
      availability: {
        status: "available",
        lastSuccessfulAt: 1_700_000_000_000,
        windowTruncated: false,
      },
      indexStatus: "ready",
      resultsTruncated: false,
    });
  });
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, {
      apiVersion: 1,
      status: "idle",
      changedCount: 0,
      hasMore: false,
    }),
  );
  await page.route(/\/api\/mail\/message-content\/message-1(?:\?.*)?$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      accountId: account.accountId,
      messageId: "message-1",
      state: "ready",
      textBody: contentOverride
        ? contentOverride.textBody
        : "Lunch at 12PM sounds great to me.",
      htmlBody: contentOverride ? contentOverride.htmlBody : null,
      attachments: [
        {
          attachmentId: "attachment-a0123456789abcdef0123456789abcdef",
          filename: "agenda.pdf",
          mimeType: "application/pdf",
          disposition: "attachment",
          contentId: null,
          bytes: 1_024,
        },
      ],
    }),
  );
  await page.route("**/api/mail/drafts**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/mail/drafts" && request.method() === "GET") {
      return fulfill(route, { apiVersion: 1, drafts: [] });
    }
    if (url.pathname === "/api/mail/drafts" && request.method() === "POST") {
      const input = validateMailDraftCreateInput(request.postDataJSON());
      const now = 1_700_000_000_000;
      const draft: MailDraftDto = {
        apiVersion: 1,
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
        attachments: [],
        sendOperationId: null,
        sendErrorCode: null,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
      };
      drafts.set(input.draftId, draft);
      return fulfill(route, { apiVersion: 1, created: true, draft });
    }
    const draftId = decodeURIComponent(parts.at(3) ?? "");
    const draft = drafts.get(draftId);
    if (!draft) return route.fulfill({ status: 404, body: "{}" });
    if (parts.at(4) === "send" && request.method() === "POST") {
      const input = validateMailDraftMutationInput(request.postDataJSON());
      if (
        input.kind !== "send" ||
        input.draftId !== draftId ||
        input.accountId !== draft.accountId ||
        input.expectedRevision !== draft.revision
      ) {
        return route.fulfill({ status: 409, body: "{}" });
      }
      sendRequests.push({ draft: structuredClone(draft), request: input });
      const appliedRevision = draft.revision + 1;
      drafts.set(draftId, {
        ...draft,
        revision: appliedRevision,
        state: "submitting",
        sendOperationId: input.sendOperationId,
        updatedAt: 1_700_000_000_001,
      });
      return fulfill(route, {
        apiVersion: 1,
        replayed: false,
        appliedRevision,
        operationId: input.sendOperationId,
        created: true,
        status: "queued",
      });
    }
    if (parts.length === 4 && request.method() === "PATCH") {
      const input = validateMailDraftMutationInput(request.postDataJSON());
      if (
        input.kind !== "patch" ||
        input.draftId !== draftId ||
        input.accountId !== draft.accountId ||
        input.expectedRevision !== draft.revision
      ) {
        return route.fulfill({ status: 409, body: "{}" });
      }
      const appliedRevision = draft.revision + 1;
      drafts.set(draftId, {
        ...draft,
        ...input.patch,
        revision: appliedRevision,
        updatedAt: 1_700_000_000_001,
      });
      return fulfill(route, {
        apiVersion: 1,
        replayed: false,
        appliedRevision,
        operationId: null,
      });
    }
    return route.fulfill({ status: 405, body: "{}" });
  });
  return { sendRequests, mutationBodies, searchBodies, threadListRequests };
}

async function installImapMailRoutes(page: Page) {
  const requestedContent: string[] = [];
  const mutationBodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/mail/message-content/")) {
      requestedContent.push(request.url());
    }
  });
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });

  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [imapAccount] }),
  );
  await page.route(/\/api\/mail\/threads\/thread-1(?:\?.*)?$/, (route) => {
    if (route.request().method() !== "PATCH") {
      fulfill(route, detail);
      return;
    }
    mutationBodies.push(route.request().postDataJSON());
    fulfill(route, {
      apiVersion: 1,
      thread: { ...thread, unread: false },
    });
  });
  await page.route(/\/api\/mail\/threads\?.*$/, (route) =>
    fulfill(route, threadPage),
  );
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, {
      apiVersion: 1,
      status: "idle",
      changedCount: 0,
      hasMore: false,
    }),
  );
  await page.route(/\/api\/mail\/message-content\/message-1(?:\?.*)?$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      accountId: account.accountId,
      messageId: "message-1",
      state: "ready",
      textBody: "Lunch at 12PM sounds great to me.",
      htmlBody: null,
      attachments: [],
    }),
  );
  return { requestedContent, mutationBodies };
}

test("Mail opens a conversation and queues a reply", async ({ page }) => {
  await login(page);
  const { sendRequests } = await installMailRoutes(page);
  await page.goto("/mail");
  await enterSingleAccount(page);

  // One control names where the column stands. The account is a lone one
  // here, so the word that would distinguish it is not appended.
  await expect(navTrigger(page)).toHaveAttribute("aria-label", "Mailbox: Inbox");
  await page.getByText(thread.subject, { exact: true }).click();
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();
  await expect(page.locator('img[src*="tracker.example"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("form", { name: "Reply" })).toBeVisible();
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("ben@example.test");
  await expect(page.getByPlaceholder("Subject")).toHaveValue("Re: Lunch this Friday?");
  await page.getByLabel("Message", { exact: true }).fill("See you there.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByText("Message queued", { exact: true })).toBeVisible();
  expect(sendRequests).toHaveLength(1);
  expect(sendRequests[0]?.draft).toEqual(
    expect.objectContaining({
      accountId: account.accountId,
      intent: { kind: "reply", sourceMessageId: "message-1" },
      to: "ben@example.test",
      subject: "Re: Lunch this Friday?",
      text: "See you there.",
    }),
  );
  expect(sendRequests[0]?.request).toEqual(
    expect.objectContaining({
      kind: "send",
      accountId: account.accountId,
      draftId: sendRequests[0]?.draft.draftId,
      expectedRevision: sendRequests[0]?.draft.revision,
      sendIdempotencyKey: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
      sendOperationId: expect.stringMatching(/^send-[0-9a-f-]{36}$/),
    }),
  );
});

test("Mail switches system folders and applies an action from that folder", async ({
  page,
}) => {
  await login(page);
  const { mutationBodies } = await installMailRoutes(page);
  await page.goto("/mail");
  await enterSingleAccount(page);

  await goTo(page, "Sent");
  await expect(page.getByText(sentThread.subject, { exact: true })).toBeVisible();
  await page.getByText(sentThread.subject, { exact: true }).click();
  await expect(page.getByText("This update was sent safely.")).toBeVisible();

  await page.getByRole("button", { name: "More mail actions" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();

  await expect(page.getByText(sentThread.subject, { exact: true })).toHaveCount(0);
  expect(mutationBodies).toContainEqual({
    accountId: account.accountId,
    trash: true,
  });
});

test("Mail searches cached headers and previews without putting terms in the URL", async ({
  page,
}) => {
  await login(page);
  const { searchBodies } = await installMailRoutes(page);
  await page.goto("/mail");
  await enterSingleAccount(page);

  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("Quarterly launch");
  await expect(page.getByText(searchThread.subject, { exact: true })).toBeVisible();
  expect(page.url()).toMatch(/\/mail$/);
  expect(searchBodies).toEqual([
    {
      accountId: account.accountId,
      mailboxId: "inbox",
      query: "quarterly launch",
      limit: 50,
    },
  ]);
  await expect(page.getByText("Searching cached headers and previews")).toBeVisible();
});

test("Mail opens a smart view from the nav menu and re-sorts by size", async ({
  page,
}) => {
  await login(page);
  const { threadListRequests } = await installMailRoutes(page);
  await page.goto("/mail");
  await enterSingleAccount(page);
  await expect(page.getByText(thread.subject, { exact: true })).toBeVisible();

  await goTo(page, "Lists");
  await expect
    .poll(() => threadListRequests.some((url) => url.includes("view=lists")))
    .toBe(true);
  await expect(page.getByText(thread.subject, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Sort: Date" }).click();
  await page.getByRole("menuitem", { name: "Size" }).click();
  await expect
    .poll(() =>
      threadListRequests.some(
        (url) => url.includes("view=lists") && url.includes("sort=size"),
      ),
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Sort: Size" })).toBeVisible();
  await expect(page.getByText(thread.subject, { exact: true })).toBeVisible();
});

test("Mail keyboard selects the first conversation with j and toggles read with u", async ({
  page,
}) => {
  await login(page);
  const { mutationBodies } = await installMailRoutes(page);
  await page.goto("/mail");
  await enterSingleAccount(page);
  await expect(page.getByText(thread.subject, { exact: true })).toBeVisible();

  await page.keyboard.press("j");
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();

  // Opening the unread thread marks it read automatically; wait for the
  // toggle to flip so the auto-read mutation (and its lock) has finished.
  await expect(page.getByRole("button", { name: "Mark unread" })).toBeVisible();
  expect(mutationBodies[0]).toEqual({
    accountId: account.accountId,
    read: true,
  });

  await page.keyboard.press("u");
  await expect.poll(() => mutationBodies.length).toBeGreaterThan(1);
  expect(mutationBodies).toContainEqual({
    accountId: account.accountId,
    read: false,
  });
});

/** Reads the three-pane promise off the DOM: which panes are on screen, how
 *  wide the reader's own head is, and whether its pill still sits on §4's one
 *  inset. */
async function paneGeometry(page: Page) {
  return page.evaluate(() => {
    const head = document.querySelector(".brain-mail-reader-head");
    const pill = head?.querySelector(".toolbar-pill") ?? null;
    const subject = head?.querySelector("h1") ?? null;
    const list = document.querySelector(".brain-mail-list");
    const shown = (node: Element | null) =>
      node !== null && node.getBoundingClientRect().width > 0;
    return {
      windowWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      listShown: shown(list),
      listWidth: list ? list.getBoundingClientRect().width : 0,
      readerShown: shown(head),
      pillRight: pill ? pill.getBoundingClientRect().right : null,
      subjectWidth: subject ? subject.getBoundingClientRect().width : null,
    };
  });
}

/* THREE PANES ONLY WHERE THREE PANES FIT. The switch used to sit on `md`, and
   between 768 and 1159 the layout promised a reader pane 104–236px wide: the
   action pill does not shrink, so it ran past the window — right edge 967.7 at
   900, 820 and 768 alike, clipped identically — and the subject beside it was
   squeezed to exactly 0. 1160 is where the reader's own minimum (the pill, the
   subject, the message's measure) plus the column plus the sidebar first add
   up; the arithmetic is at `--breakpoint-panes` in globals.css. Below it mail
   shows ONE pane inside the ordinary desktop shell — the sidebar is not a
   phone affordance and a 900px window is a small desktop. */
test("@release Mail shows three panes only at the width that holds them", async ({
  page,
}) => {
  await login(page);
  await installMailRoutes(page);
  await page.setViewportSize({ width: 1160, height: 900 });
  await page.goto("/mail");
  await enterSingleAccount(page);
  await page.getByText(thread.subject, { exact: true }).click();
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();
  // The pill is measured at its RESTING labels, and opening a thread marks it
  // read — until that lands the first button says "Mark read", 15px narrower
  // than the "Mark unread" the 277 comes from. Wait for the word, or every
  // figure below is read off a pill the derivation does not describe.
  await expect(page.getByRole("button", { name: "Mark unread" })).toBeVisible();

  // At the breakpoint: the column, the reader beside it, no Back — the list
  // has not gone anywhere, so nothing has to lead back to it.
  const wide = await paneGeometry(page);
  expect(wide.listShown).toBe(true);
  expect(wide.listWidth).toBe(360);
  expect(wide.readerShown).toBe(true);
  expect(wide.documentWidth).toBeLessThanOrEqual(wide.windowWidth);
  // the pill on §4's one inset, not past the window
  expect(wide.pillRight).toBeCloseTo(1160 - 12, 0);
  // and the subject at or above the floor the breakpoint was derived from:
  // 159, the caption's 157 plus 2. pillRight alone cannot catch this — the
  // pill is right-anchored and lands on the inset whether the subject beside
  // it has 165 or nothing at all.
  expect(wide.subjectWidth ?? 0).toBeGreaterThanOrEqual(159);
  await expect(page.getByRole("button", { name: "Back to Inbox" })).toBeHidden();
  // Escape belongs to the pane switch, not to the viewport: with the list on
  // screen there is nothing for it to go back to.
  await page.keyboard.press("Escape");
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();

  // One pixel below it: one pane, and the reader takes the whole of it.
  await page.setViewportSize({ width: 1159, height: 900 });
  await expect(page.getByRole("button", { name: "Back to Inbox" })).toBeVisible();
  const narrow = await paneGeometry(page);
  expect(narrow.listShown).toBe(false);
  expect(narrow.readerShown).toBe(true);
  expect(narrow.documentWidth).toBeLessThanOrEqual(narrow.windowWidth);
  expect(narrow.pillRight).toBeCloseTo(1159 - 12, 0);
  expect(narrow.subjectWidth ?? 0).toBeGreaterThan(wide.subjectWidth ?? 0);

  // 900 — the width the pill used to overflow by 68px.
  await page.setViewportSize({ width: 900, height: 900 });
  const broken = await paneGeometry(page);
  expect(broken.listShown).toBe(false);
  expect(broken.documentWidth).toBeLessThanOrEqual(broken.windowWidth);
  expect(broken.pillRight).toBeCloseTo(900 - 12, 0);
  expect(broken.subjectWidth ?? 0).toBeGreaterThanOrEqual(159);

  // Back returns to the column, which now owns the whole pane.
  await page.getByRole("button", { name: "Back to Inbox" }).click();
  const backToList = await paneGeometry(page);
  expect(backToList.listShown).toBe(true);
  expect(backToList.readerShown).toBe(false);
  expect(backToList.listWidth).toBeGreaterThan(360);
});

/* THE STRIP'S RESTING LABEL LEAVES WHERE THE SUBJECT WOULD FALL UNDER ITS
   FLOOR. The pill does not shrink, so "Mark unread" (105 of its 277) is drawn
   only where the head has room for it beside the subject's 159. That width is
   `--breakpoint-strip`, derived at the token in globals.css the way `panes`
   is — one pane inside the desktop shell, sidebar included — and it used to
   be `sm`, a phone's number: 768 promised the label and left the subject 103
   with the caption clipped under it. The line is read off :root here rather
   than copied, so the token stays the one place the number lives. */
test("@release the reader strip keeps its resting label only where the subject keeps its floor", async ({
  page,
}) => {
  await login(page);
  await installMailRoutes(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/mail");
  await enterSingleAccount(page);
  await page.getByText(thread.subject, { exact: true }).click();
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();
  const label = page.getByRole("button", { name: "Mark unread" });
  await expect(label).toBeVisible();

  const line = await page.evaluate(() =>
    Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--breakpoint-strip"),
      10,
    ),
  );
  expect(line, "--breakpoint-strip is not on :root").toBeGreaterThan(768);
  expect(line).toBeLessThan(1160);

  // At the line: one pane, the label in the pill, the subject at its floor.
  await page.setViewportSize({ width: line, height: 900 });
  await expect(label).toBeVisible();
  const atLine = await paneGeometry(page);
  expect(atLine.listShown).toBe(false);
  expect(atLine.pillRight).toBeCloseTo(line - 12, 0);
  expect(atLine.subjectWidth ?? 0).toBeGreaterThanOrEqual(159);

  // One pixel under it: the label is in the ⋯ menu, and the subject has the
  // 105 back.
  await page.setViewportSize({ width: line - 1, height: 900 });
  await expect(label).toBeHidden();
  const under = await paneGeometry(page);
  expect(under.pillRight).toBeCloseTo(line - 1 - 12, 0);
  expect(under.subjectWidth ?? 0).toBeGreaterThanOrEqual(159 + 105);

  // 768 — the tablet that had 103.
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(label).toBeHidden();
  const tablet = await paneGeometry(page);
  expect(tablet.documentWidth).toBeLessThanOrEqual(tablet.windowWidth);
  expect(tablet.pillRight).toBeCloseTo(768 - 12, 0);
  expect(tablet.subjectWidth ?? 0).toBeGreaterThanOrEqual(159);
  await page.getByRole("button", { name: "More mail actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Mark unread" })).toBeVisible();
  await page.keyboard.press("Escape");

  // A phone in portrait: the label stays in the menu, the pill sits on the 8
  // inset, and the subject lands 9 under the caption's floor — §13's known
  // gap, held at its figure so a move either way is a move someone made.
  await page.setViewportSize({ width: 390, height: 844 });
  // crossing `md` hands mail to the mobile shell, which mounts the surface
  // afresh on the column — open the thread again from there
  await page
    .locator('section[aria-label="Mailbox"]')
    .getByText(thread.subject, { exact: true })
    .click();
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();
  await expect(label).toBeHidden();
  const phone = await paneGeometry(page);
  expect(phone.documentWidth).toBeLessThanOrEqual(phone.windowWidth);
  expect(phone.pillRight).toBeCloseTo(390 - 8, 0);
  // 149.8 on a Mac, 148.9 on the Linux runner: the pill's own width takes
  // the fraction, and the fraction is the font's. The claim is the gap, not
  // the subpixel — under the 159 floor, and not collapsing further.
  const phoneSubject = phone.subjectWidth ?? 0;
  expect(phoneSubject).toBeGreaterThanOrEqual(145);
  expect(phoneSubject).toBeLessThan(159);
});

/* THE DATE AND THE TRASH SHARE A ROW, NOT A PIXEL. The delete button is
   absolute over the draft row, and the row's reserve for it was a `pr-10` on
   the row — which `.brain-mail-row`'s own padding in globals.css beat, so the
   reserve was never there: a 39-character subject put its date 16px under
   the button at 1440, and a 95-character one grew the line past the capsule
   and took the date 300px off the row. The reserve lives on the lines now,
   the lines take the row's width, and the button stands on the row's text
   rule — 8 inside the capsule at either inset. */
test("@release a draft's date never runs under its delete button", async ({
  page,
}) => {
  await login(page);
  await installMailRoutes(page);
  const savedDraft = (draftId: string, subject: string) => ({
    apiVersion: 1,
    draftId,
    accountId: account.accountId,
    revision: 3,
    state: "editing",
    intent: { kind: "compose" },
    subject,
    sendOperationId: null,
    sendErrorCode: null,
    createdAt: 1_755_000_000_000,
    updatedAt: 1_755_000_000_000,
    sentAt: null,
  });
  await page.route("**/api/mail/drafts**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/mail/drafts" || route.request().method() !== "GET") {
      return route.fallback();
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        apiVersion: 1,
        drafts: [
          savedDraft("draft-1a2b3c4d-1111-4a7b-8c9d-0e1f2a3b4c5d", "Thursday, then"),
          savedDraft(
            "draft-1a2b3c4d-2222-4a7b-8c9d-0e1f2a3b4c5d",
            "Re: Design review — glass on the mail column, the reader strip, and what the pill owes the subject",
          ),
          savedDraft(
            "draft-1a2b3c4d-3333-4a7b-8c9d-0e1f2a3b4c5d",
            "Re: Stairwell repaint — the two quotes",
          ),
        ],
      }),
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/mail");
  await enterSingleAccount(page);
  await goTo(page, /^Drafts/);
  const rows = page.locator('[aria-label="Saved drafts"] [role="listitem"]');
  await expect(rows).toHaveCount(3);

  // 1440 puts the column at 360 and the capsule at 336; 390 makes the
  // capsule the window less the phone's 8 on each side.
  for (const [width, capsuleWidth] of [
    [1440, 336],
    [390, 374],
  ] as const) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await expect(rows).toHaveCount(3);
    const geometry = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Saved drafts"] [role="listitem"]')].map(
        (item) => {
          const capsule = item
            .querySelector(".brain-mail-row, .brain-mail-row-static")!
            .getBoundingClientRect();
          const time = item.querySelector("time")!.getBoundingClientRect();
          const trash = item
            .querySelector('button[aria-label^="Delete draft"]')!
            .getBoundingClientRect();
          const title = item.querySelector<HTMLElement>(".truncate")!;
          return {
            capsuleWidth: capsule.width,
            capsuleRight: capsule.right,
            timeRight: time.right,
            trashLeft: trash.left,
            trashRight: trash.right,
            titleClipped: title.scrollWidth > title.clientWidth,
          };
        },
      ),
    );
    for (const row of geometry) {
      expect(row.capsuleWidth).toBe(capsuleWidth);
      // the date ends before the trash begins, with the row's 8 between
      expect(row.trashLeft - row.timeRight).toBeGreaterThanOrEqual(7.5);
      // the date is inside the capsule, and the trash on its text rule
      expect(row.timeRight).toBeLessThanOrEqual(row.capsuleRight);
      expect(row.capsuleRight - row.trashRight).toBeCloseTo(8, 0);
    }
    // the long subject truncates instead of pushing the date out
    expect(geometry[1]!.titleClipped).toBe(true);
    expect(geometry[0]!.titleClipped).toBe(false);
  }
});

/* ONE OWNER OF NAVIGATION — AT EVERY WIDTH, IN EVERY MODE, AND NEVER TWO OR
   NONE. This used to be a test about two owners: the head's selects hid at
   `lg` on the theory that the rail owned account and folder navigation, and
   `lg` was wrong in both directions. The rail had been hosted in the sidebar
   since 768, so 768-1023 drew both; and focus mode takes the sidebar
   off-canvas at any width, so >=1024 drew neither. The rail is gone and the
   question with it — the control lives in the head of the column it navigates
   and the shell has no say — so what is asserted now is the property itself,
   at every stop where the old arrangement could differ. */
test("@release Mail has one navigation owner at every width and in every mode", async ({
  page,
}) => {
  await login(page);
  await installMailRoutes(page);
  // The merged mode exists only with a second account to merge.
  await installSecondAccount(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/mail");

  const stops = [390, 768, 900, 1159, 1160, 1280];

  // The merged mode first: it mounts here, and it used to be the mode that
  // moved Compose between rows.
  await expect(navTrigger(page)).toHaveCount(1);
  for (const width of stops) {
    await page.setViewportSize({ width, height: 900 });
    await expect(navTrigger(page)).toHaveCount(1);
    await expect(navTrigger(page)).toHaveAttribute(
      "aria-label",
      "Mailbox: All inboxes",
    );
    await expect(page.locator("select")).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Mail folders" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New message" })).toHaveCount(1);
  }

  // and the single-account mode, at the same stops. Two accounts are
  // connected, so the trigger carries the word that tells them apart.
  await page.setViewportSize({ width: 1280, height: 900 });
  await enterSingleAccount(page);
  for (const width of stops) {
    await page.setViewportSize({ width, height: 900 });
    await expect(navTrigger(page)).toHaveCount(1);
    await expect(navTrigger(page)).toHaveAttribute(
      "aria-label",
      "Mailbox: Inbox, person",
    );
    await expect(page.locator("select")).toHaveCount(0);
  }

  // Focus mode takes the sidebar off-canvas and out of the a11y tree. It used
  // to take the only switcher with it; now it changes nothing on this surface.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.keyboard.press("Control+Backslash");
  await expect(page.locator(".brain-shell[data-sidebar-collapsed]")).toHaveCount(1);
  await expect(navTrigger(page)).toHaveCount(1);
  await expect(page.locator("select")).toHaveCount(0);
  await page.keyboard.press("Control+Backslash");
  await expect(navTrigger(page)).toHaveCount(1);

  // Drafts holds the column the way a folder does, so the control is there
  // too, naming it — and it is the way back out.
  await goTo(page, /^Drafts/);
  await expect(navTrigger(page)).toHaveCount(1);
  await expect(navTrigger(page)).toHaveAttribute(
    "aria-label",
    "Mailbox: Drafts, person",
  );
  // "Inbox" alone also matches "All inboxes", and the row carries its unread
  // count in its name — anchor on the word.
  await goTo(page, /^Inbox\b/);
  await expect(navTrigger(page)).toHaveAttribute(
    "aria-label",
    "Mailbox: Inbox, person",
  );
});

/* THE MENU IS A WAY OUT OF AN ACCOUNT, OR IT IS NOT A CONTROL. Fourteen rows
   is 534px, and the rail took the second exit with it — so a window shorter
   than the menu (a phone in landscape, an iPad split view, a short laptop
   window) used to leave the Accounts block past the foot with nothing to
   scroll, and the keyboard walked focus onto rows nobody could see. The list
   scrolls inside the material now, capped at the room Radix measures. Held at
   both stops, by pointer and by keyboard, because a row focus can reach and
   the window cannot show is worse than one it cannot reach at all. */
test("@release Mail's nav menu stays reachable in a window shorter than itself", async ({
  page,
}) => {
  await login(page);
  await installMailRoutes(page);
  // the tall menu is the one with the Accounts block, and that block exists
  // only with a second account in it
  await installSecondAccount(page);
  await page.goto("/mail");
  await page.setViewportSize({ width: 1024, height: 900 });
  await enterSingleAccount(page);

  for (const height of [420, 390]) {
    await page.setViewportSize({ width: 1024, height });
    await navTrigger(page).click();
    const menu = page.locator(".brain-menu");
    await expect(menu).toBeVisible();

    // the menu ends inside the window rather than past its foot
    const fits = await menu.evaluate(
      (node) => node.getBoundingClientRect().bottom <= window.innerHeight + 0.5,
    );
    expect(fits, `the menu runs past the foot at ${height}`).toBe(true);

    // and the last row — the other address, the only way out of this account
    // — is reachable and on screen, by pointer and by keyboard both.
    const last = page.getByRole("menuitemradio", {
      name: `Open ${secondAccount.emailAddress}`,
    });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();

    await page.keyboard.press("End");
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return null;
      const box = active.getBoundingClientRect();
      return {
        label: active.getAttribute("aria-label"),
        onScreen: box.top >= -0.5 && box.bottom <= window.innerHeight + 0.5,
      };
    });
    expect(focused?.label, `End misses the last row at ${height}`).toBe(
      `Open ${secondAccount.emailAddress}`,
    );
    expect(focused?.onScreen, `focus is off screen at ${height}`).toBe(true);

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
});

/* The pane can hold three things, and below the breakpoint only one of them is
   on screen at a time — so the reader, the composer and the keyboard all have
   to hand it back. */
test("@release Mail hands the single pane between list, reader and composer", async ({
  page,
}) => {
  await login(page);
  await installMailRoutes(page);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/mail");
  await enterSingleAccount(page);
  await expect(page.getByText(thread.subject, { exact: true })).toBeVisible();
  // Whichever control switched the account keeps focus, and a focused select
  // swallows j as type-ahead. Hand it back to the document before the
  // keyboard walks the column.
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });

  // j opens the thread the way a click does, and takes the pane with it.
  await page.keyboard.press("j");
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();
  expect((await paneGeometry(page)).listShown).toBe(false);

  // Escape is the keyboard's Back below the breakpoint.
  await page.keyboard.press("Escape");
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toHaveCount(0);
  expect((await paneGeometry(page)).listShown).toBe(true);

  // The composer is the third occupant, and it wins over the open thread.
  await page.getByText(thread.subject, { exact: true }).click();
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("form", { name: "Reply" })).toBeVisible();
  expect((await paneGeometry(page)).listShown).toBe(false);
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toHaveCount(0);

  // Closing the draft gives the pane back to the thread that was open under it,
  // and Back from there gives it to the column.
  await page.getByRole("button", { name: "Close draft" }).click();
  await expect(page.getByRole("form", { name: "Reply" })).toHaveCount(0);
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();
  expect((await paneGeometry(page)).listShown).toBe(false);
  await page.getByRole("button", { name: "Back to Inbox" }).click();
  const list = await paneGeometry(page);
  expect(list.listShown).toBe(true);
  expect(list.listWidth).toBeGreaterThan(360);
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  const marker = viewport.name === "mobile" ? "@mobile " : "";
  test(`${marker}${viewport.name} IMAP stays Inbox-only and mutates threads`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await login(page);
    const { requestedContent, mutationBodies } = await installImapMailRoutes(page);
    await page.goto("/mail");
    await enterSingleAccount(page, imapAccount);

    // The same control at both widths, saying the same thing, and no second
    // switcher of any kind at either.
    await expect(navTrigger(page)).toHaveAttribute(
      "aria-label",
      "Mailbox: Inbox",
    );
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New message" })).toHaveCount(0);

    await page.getByText(thread.subject, { exact: true }).click();
    await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();
    await expect(page.getByText(/Header preview only\./)).toHaveCount(0);
    // Sending is still off without SMTP; the mail actions are on.
    await expect(page.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More mail actions" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(1);
    // Opening the thread marks it read on its own, which is the whole point.
    await expect
      .poll(() => mutationBodies)
      .toContainEqual({ accountId: imapAccount.accountId, read: true });

    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect
      .poll(() => mutationBodies)
      .toContainEqual({ accountId: imapAccount.accountId, archive: true });
    expect(requestedContent.length).toBeGreaterThan(0);
    expect(
      requestedContent.every((url) => url.includes("/api/mail/message-content/message-1")),
    ).toBe(true);
  });
}

test("Mail builds Reply all and Forward without client-owned threading", async ({
  page,
}) => {
  await login(page);
  const { sendRequests } = await installMailRoutes(page);
  await page.goto("/mail");
  await enterSingleAccount(page);
  await page.getByText(thread.subject, { exact: true }).click();

  await page.getByRole("button", { name: "More mail actions" }).click();
  await page.getByRole("menuitem", { name: "Reply all" }).click();
  await expect(page.getByRole("form", { name: "Reply all" })).toBeVisible();
  await expect(page.getByLabel("To", { exact: true })).toHaveValue(
    "ben@example.test, alex@example.test",
  );
  await expect(page.getByLabel("Cc", { exact: true })).toHaveValue(
    "casey@example.test",
  );
  await page.getByLabel("Message", { exact: true }).fill("Replying to everyone.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sendRequests.length).toBe(1);
  expect(sendRequests[0]?.draft).toEqual(
    expect.objectContaining({
      intent: { kind: "reply_all", sourceMessageId: "message-1" },
      to: "ben@example.test, alex@example.test",
      cc: "casey@example.test",
    }),
  );

  await page.reload();
  await enterSingleAccount(page);
  await page.getByText(thread.subject, { exact: true }).click();
  await page.getByRole("button", { name: "More mail actions" }).click();
  await page.getByRole("menuitem", { name: "Forward" }).click();
  await expect(page.getByRole("form", { name: "Forward" })).toBeVisible();
  await expect(page.getByText("Original attachments aren’t included.")).toBeVisible();
  await expect(page.getByPlaceholder("Subject")).toHaveValue(
    "Fwd: Lunch this Friday?",
  );
  await expect(page.locator("textarea")).toHaveValue(/Forwarded message/);
  await page.getByLabel("To", { exact: true }).fill("reader@example.test");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sendRequests.length).toBe(2);
  expect(sendRequests[1]?.draft).toEqual(
    expect.objectContaining({
      intent: { kind: "forward", sourceMessageId: "message-1" },
      to: "reader@example.test",
    }),
  );
});

test("@mobile Mail moves from list to reader and compose without zoom triggers", async ({
  page,
}) => {
  await login(page);
  await installMailRoutes(page);

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Mail", exact: true })
    .click();
  await expect(page).toHaveURL("/mail");
  await enterSingleAccount(page);
  await expect(navTrigger(page)).toHaveAttribute("aria-label", "Mailbox: Inbox");
  await assertNoHorizontalOverflow(page);

  await page.getByText(thread.subject, { exact: true }).click();
  await expect(page.getByText("Lunch at 12PM sounds great to me.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Inbox" })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Back to Inbox" }).click();
  await page.getByRole("button", { name: "New message" }).click();
  await expect(page.getByRole("form", { name: "New message" })).toBeVisible();

  // Only rendered fields can trigger iOS focus zoom, and the nav control is a
  // BUTTON — the 16px floor is the search input's rule, not a button's, so the
  // trigger keeps Control 13 at every width and the sweep passes it by.
  const fontSizes = await page.locator(
    'select, input[aria-label="Search mail"], form input, form textarea',
  ).evaluateAll((fields) =>
    fields
      .filter((field) => field.getClientRects().length > 0)
      .map((field) => Number.parseFloat(getComputedStyle(field).fontSize)),
  );
  expect(fontSizes.length).toBeGreaterThan(1);
  expect(fontSizes.every((size) => size >= 16)).toBe(true);
  await assertNoHorizontalOverflow(page);

  const mailboxBottom = await page
    .getByRole("form", { name: "New message" })
    .evaluate((node) => node.getBoundingClientRect().bottom);
  const tabbarTop = await page
    .getByRole("navigation", { name: "Primary" })
    .evaluate((node) => node.getBoundingClientRect().top);
  expect(mailboxBottom).toBeLessThanOrEqual(tabbarTop + 1);
});

test("@mobile HTML mail grows with its content without nested scrollbars", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await installMailRoutes(page, {
    textBody: null,
    htmlBody: '<div style="width:720px;height:1100px">Tall newsletter</div>',
  });
  await page.goto("/mail");
  await enterSingleAccount(page);
  await page.getByText(thread.subject, { exact: true }).click();

  const frame = page.locator('iframe[title="Sanitized HTML message"]');
  await expect(frame).toBeVisible();
  await expect
    .poll(() => frame.evaluate((node) => node.clientHeight))
    .toBeGreaterThan(1_000);
  const metrics = await frame.evaluate((node) => {
    const iframe = node as HTMLIFrameElement;
    const document = iframe.contentDocument!;
    return {
      frameClientHeight: iframe.clientHeight,
      frameScrollHeight: document.documentElement.scrollHeight,
      frameClientWidth: document.documentElement.clientWidth,
      frameScrollWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ),
    };
  });
  expect(metrics.frameScrollHeight).toBeLessThanOrEqual(
    metrics.frameClientHeight + 1,
  );
  expect(metrics.frameScrollWidth).toBeLessThanOrEqual(metrics.frameClientWidth);
  await assertNoHorizontalOverflow(page);
});

test("@mobile pathological HTML height stays inside a bounded reader", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await installMailRoutes(page, {
    textBody: null,
    htmlBody: '<div style="height:99999px">Bounded newsletter</div>',
  });
  await page.goto("/mail");
  await enterSingleAccount(page);
  await page.getByText(thread.subject, { exact: true }).click();

  const frame = page.locator('iframe[title="Sanitized HTML message"]');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("scrolling", "yes");
  const metrics = await frame.evaluate((node) => {
    const iframe = node as HTMLIFrameElement;
    return {
      frameClientHeight: iframe.clientHeight,
      contentScrollHeight: iframe.contentDocument!.documentElement.scrollHeight,
    };
  });
  expect(metrics.frameClientHeight).toBeLessThanOrEqual(16_000);
  expect(metrics.contentScrollHeight).toBeGreaterThan(metrics.frameClientHeight);
  await assertNoHorizontalOverflow(page);
});

test("Mail unified inbox sections two accounts, and Done clears People with an undo", async ({
  page,
}) => {
  await login(page);
  const secondAccount = {
    ...account,
    accountId: "account-affffffffffffffffffffffffffffffff",
    emailAddress: "second@example.test",
    displayName: null,
  } as const;
  const threadA = {
    ...thread,
    threadId: "unified-a",
    subject: "Unified from A",
    category: "people",
    lastMessageAt: 1_700_000_000_900,
  } as const;
  const threadB = {
    ...thread,
    accountId: secondAccount.accountId,
    threadId: "unified-b",
    subject: "Unified from B",
    category: "people",
    lastMessageAt: 1_700_000_000_800,
  } as const;
  const noteB = {
    ...thread,
    accountId: secondAccount.accountId,
    threadId: "unified-note",
    subject: "Unified notification",
    category: "notification",
    lastMessageAt: 1_700_000_000_700,
  } as const;
  const patched: Array<{ url: string; body: unknown }> = [];
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account, secondAccount] }),
  );
  await page.route(/\/api\/mail\/threads\/unified-[a-z]+(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const threadId = url.pathname.split("/").at(-1);
    const target = [threadA, threadB, noteB].find(
      (candidate) => candidate.threadId === threadId,
    );
    if (route.request().method() === "PATCH") {
      patched.push({ url: url.pathname, body: route.request().postDataJSON() });
      return fulfill(route, {
        apiVersion: 1,
        thread: { ...target, unread: false },
      });
    }
    return fulfill(route, { apiVersion: 1, thread: target, messages: [] });
  });
  await page.route(/\/api\/mail\/threads\?.*$/, (route) => {
    const url = new URL(route.request().url());
    const accountId = url.searchParams.get("accountId");
    return fulfill(route, {
      apiVersion: 1,
      items:
        accountId === account.accountId ? [threadA] : [threadB, noteB],
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    });
  });
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, {
      apiVersion: 1,
      status: "idle",
      changedCount: 0,
      hasMore: false,
    }),
  );
  await page.goto("/mail");

  const list = page.locator('[aria-label="All inboxes threads"]');
  await expect(list.getByText("Unified from A", { exact: true })).toBeVisible();
  await expect(list.getByText("Unified from B", { exact: true })).toBeVisible();
  await expect(
    list.getByText("Unified notification", { exact: true }),
  ).toBeVisible();
  // Two accounts contribute People rows, so both sub-headers render.
  await expect(list.getByText(account.emailAddress)).toBeVisible();
  await expect(list.getByText(secondAccount.emailAddress)).toBeVisible();

  // Done takes the whole section out of the inbox: archive first, then the
  // read flag that archiving does not set on its own.
  await page
    .getByRole("button", { name: "Done — archive all 2 in People" })
    .click();
  await expect.poll(() => patched.length).toBe(4);
  for (const [url, accountId] of [
    ["/api/mail/threads/unified-a", account.accountId],
    ["/api/mail/threads/unified-b", secondAccount.accountId],
  ] as const) {
    expect(patched).toContainEqual({ url, body: { accountId, archive: true } });
    expect(patched).toContainEqual({ url, body: { accountId, read: true } });
  }
  await expect(list.locator('section[aria-label="People"]')).toHaveCount(0);

  // And the way back is in the same breath: Undo un-archives exactly what
  // moved and restores the unread flags Done set.
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect.poll(() => patched.length).toBe(8);
  for (const [url, accountId] of [
    ["/api/mail/threads/unified-a", account.accountId],
    ["/api/mail/threads/unified-b", secondAccount.accountId],
  ] as const) {
    expect(patched).toContainEqual({ url, body: { accountId, archive: false } });
    expect(patched).toContainEqual({ url, body: { accountId, read: false } });
  }
  await expect(list.getByText("Unified from A", { exact: true })).toBeVisible();
  await expect(list.getByText("Unified from B", { exact: true })).toBeVisible();
});

/**
 * The two pills that can be up at once, on a phone, with the longest sentence
 * Done makes. Three things were wrong at the same coordinates: the refusal was
 * placed by hand 60px over a pill measured as one line, this PR's own mixed
 * account made that pill's subtitle wrap to two, and both sat on top of the
 * mobile tab bar's middle slots for the whole ten seconds of the undo.
 */
test("@release @mobile the undo and the refusal stack clear of the tab bar at 390", async ({
  page,
}) => {
  await login(page);
  // A second account whose service withholds thread mutations. Both shipping
  // providers mutate, so this is the capability answer itself under test: the
  // surface must count and name what it cannot move, whoever reports it.
  const held = {
    ...account,
    accountId: "account-abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    emailAddress: "work@example.test",
    displayName: null,
    capabilities: { ...gmailCapabilities, threadMutations: false },
  } as const;
  // Eleven People threads Done can move and three it cannot: the mixed
  // account is what makes the subtitle long enough to wrap at 390.
  const people = [
    ...Array.from({ length: 11 }, (_, i) => ({
      ...thread,
      threadId: `stack-a${i}`,
      subject: `Gmail thread ${i}`,
      category: "people",
      lastMessageAt: 1_700_000_001_000 - i,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      ...thread,
      accountId: held.accountId,
      threadId: `stack-b${i}`,
      subject: `Held thread ${i}`,
      category: "people",
      lastMessageAt: 1_700_000_000_500 - i,
    })),
  ];
  // A second section, so the press that raises the refusal is a real one.
  const notification = {
    ...thread,
    threadId: "stack-note",
    subject: "Release 2026.8.4 is live",
    category: "notification",
    lastMessageAt: 1_700_000_000_100,
  } as const;
  let patched = 0;
  let releaseArchive: () => void = () => {};
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account, held] }),
  );
  await page.route(/\/api\/mail\/threads\/stack-[a-z0-9]+(?:\?.*)?$/, async (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
    const target = [...people, notification].find(
      (candidate) => candidate.threadId === threadId,
    );
    if (route.request().method() === "PATCH") {
      // The loop stays live while both pills are measured — a second Done
      // inside a run is exactly the refusal this test needs.
      await archiveGate;
      patched += 1;
      return fulfill(route, {
        apiVersion: 1,
        thread: { ...target, unread: false },
      });
    }
    return fulfill(route, { apiVersion: 1, thread: target, messages: [] });
  });
  await page.route(/\/api\/mail\/threads\?.*$/, (route) => {
    const url = new URL(route.request().url());
    return fulfill(route, {
      apiVersion: 1,
      items:
        url.searchParams.get("accountId") === account.accountId
          ? [...people.filter((t) => t.accountId === account.accountId), notification]
          : people.filter((t) => t.accountId === held.accountId),
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    });
  });
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, {
      apiVersion: 1,
      status: "idle",
      changedCount: 0,
      hasMore: false,
    }),
  );
  await page.goto("/mail");

  const list = page.locator('[aria-label="All inboxes threads"]');
  await expect(list.locator('section[aria-label="People"]')).toBeVisible();
  // The count is what Done can MOVE, and blocked rows change the title of the
  // very first report — the form made before a single request goes out.
  await page
    .getByRole("button", { name: "Done — archive 11 of 14 in People" })
    .click();
  const report = page.locator('[aria-live="polite"] .brain-toast');
  await expect(report).toContainText("People partly cleared");
  await expect(report).toContainText(
    "11 threads out of your inbox, 3 can’t leave",
  );

  // A second Done while the loop holds the lock: the refusal answers at once,
  // on its own pill, and the undo keeps standing under it.
  await page
    .getByRole("button", { name: "Done — archive all 1 in Notifications" })
    .click();
  const refusal = page.locator('[aria-live="assertive"] .brain-toast');
  await expect(refusal).toContainText("Finish the current mail action first");
  // both springs settled — a pill measured mid-slide is measured in flight
  await page.waitForTimeout(700);

  const geometry = await page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document
        .querySelector(selector)
        ?.getBoundingClientRect();
      if (!rect) throw new Error(`missing ${selector}`);
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const subtitle = document.querySelector<HTMLElement>(
      '[aria-live="polite"] .brain-toast .text-caption',
    );
    if (!subtitle) throw new Error("missing subtitle");
    const lineHeight = parseFloat(getComputedStyle(subtitle).lineHeight);
    const owns = (selector: string, x: number, y: number) =>
      !!document.elementFromPoint(x, y)?.closest(selector);
    const tabs = [...document.querySelectorAll("[data-mobile-tab]")].map(
      (tab) => {
        const rect = tab.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return {
          key: tab.getAttribute("data-mobile-tab") ?? "",
          ownsItsCentre: owns("[data-mobile-tab]", x, y),
          coveredByPill: owns(".brain-toast-stack", x, y),
        };
      },
    );
    const undo = document
      .querySelector('[aria-live="polite"] .brain-toast button')
      ?.getBoundingClientRect();
    if (!undo) throw new Error("missing Undo");
    return {
      stack: box(".brain-toast-stack"),
      report: box('[aria-live="polite"] .brain-toast'),
      refusal: box('[aria-live="assertive"] .brain-toast'),
      tabBar: box('nav[aria-label="Primary"]'),
      subtitleLines: Math.round(subtitle.getBoundingClientRect().height / lineHeight),
      viewportHeight: window.innerHeight,
      tabs,
      undoPressable: owns(
        ".brain-toast",
        undo.left + undo.width / 2,
        undo.top + undo.height / 2,
      ),
    };
  });

  // The state this PR added: a mixed account makes the subtitle wrap, so the
  // pill is taller than the one the old hand-placed 60 was measured against.
  expect(geometry.subtitleLines).toBeGreaterThanOrEqual(2);
  // Two pills, stacked with air between them, neither on the other.
  expect(geometry.refusal.bottom).toBeLessThanOrEqual(geometry.report.top);
  const gap = geometry.report.top - geometry.refusal.bottom;
  expect(gap).toBeGreaterThanOrEqual(7);
  expect(gap).toBeLessThanOrEqual(9);
  // The column stands on the tab bar's strip, not over it.
  expect(geometry.stack.bottom).toBeLessThanOrEqual(geometry.tabBar.top);
  // Both are reachable: the bar's five slots and the undo the pill offers.
  // Home and Mail are only checked for the pill, since in `next dev` the
  // framework's own corner indicator can own the far corners of the bar.
  expect(geometry.tabs.map((tab) => tab.key)).toEqual([
    "home",
    "search",
    "new",
    "pages",
    "mail",
  ]);
  for (const tab of geometry.tabs) expect(tab.coveredByPill).toBe(false);
  for (const key of ["search", "new", "pages"] as const) {
    expect(geometry.tabs.find((tab) => tab.key === key)?.ownsItsCentre).toBe(
      true,
    );
  }
  expect(geometry.undoPressable).toBe(true);
  await assertNoHorizontalOverflow(page);

  // The eleven leave, the three that cannot stay in the column — and with
  // nothing left for Done to move, the section stops drawing it.
  releaseArchive();
  await expect.poll(() => patched).toBe(22);
  await expect(list.getByText("Held thread 0", { exact: true })).toBeVisible();
  await expect(list.getByText("Gmail thread 0", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /in People$/ })).toHaveCount(0);
});

/**
 * The pill's lifetime is the RUN's, and the ring counts only the window that
 * follows it.
 *
 * Forty threads under Done is the press this fixes. The window used to be
 * predicted from the count — ten seconds plus six a thread — so this press
 * armed 250 seconds, the ring crawled a pixel a second, and a countdown that
 * does not visibly count reads as a pill that has hung. Nothing is predicted
 * now: no window and no ring while the loop is sending, then the plain ten
 * seconds measured from the last request. The drain is read off the ring
 * itself, because that number is the whole claim — under the old arithmetic
 * it would read 250s.
 */
test("@release the undo pill stands through a long Done and counts only from the end", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  // Read mail: forty threads in Seen, one archive apiece. Enough that the old
  // arithmetic would have armed minutes.
  const seen = Array.from({ length: 40 }, (_value, index) => ({
    ...thread,
    threadId: `seen-${index}`,
    subject: `Seen thread ${index}`,
    category: "people",
    unread: false,
    lastMessageAt: 1_700_000_000_000 - index,
  }));
  let patched = 0;
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account, secondAccount] }),
  );
  await page.route(/\/api\/mail\/threads\/seen-\d+(?:\?.*)?$/, async (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
    const target = seen.find((candidate) => candidate.threadId === threadId);
    if (route.request().method() === "PATCH") {
      // A real mutation is a round trip, and on a custom-domain account its
      // own connect and authenticate. Forty of them in sequence is the run.
      await new Promise((resolve) => setTimeout(resolve, 120));
      patched += 1;
      return fulfill(route, { apiVersion: 1, thread: target });
    }
    return fulfill(route, { apiVersion: 1, thread: target, messages: [] });
  });
  await page.route(/\/api\/mail\/threads\?.*$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      items: forAccount(route, seen),
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    }),
  );
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, {
      apiVersion: 1,
      status: "idle",
      changedCount: 0,
      hasMore: false,
    }),
  );
  await page.goto("/mail");

  const list = page.locator('[aria-label="All inboxes threads"]');
  await expect(list.locator('section[aria-label="Seen"]')).toBeVisible();
  await page.getByRole("button", { name: "Done — archive all 40 in Seen" }).click();

  const report = page.locator('[aria-live="polite"] .brain-toast');
  const ring = report.locator("[data-toast-ring]");
  const undo = report.getByRole("button", { name: "Undo" });
  await expect(report).toContainText("Seen cleared");
  await expect(report).toContainText("40 threads out of your inbox");
  // The press names no deadline, so the icon slot holds its glyph and nothing
  // else. A ring here would be counting down a window that does not exist.
  await expect(ring).toHaveCount(0);

  // Mid-run: the loop is still going out and the pill has not moved. Under the
  // old arithmetic a ring would be crawling through 250 seconds here.
  await expect.poll(() => patched, { timeout: 30_000 }).toBeGreaterThan(4);
  expect(patched).toBeLessThan(40);
  await expect(ring).toHaveCount(0);
  await expect(undo).toBeVisible();

  // The last request lands. Only now is there a deadline: the ring appears and
  // drains the plain ten seconds, and the pill goes when they are spent.
  await expect.poll(() => patched, { timeout: 30_000 }).toBe(40);
  await expect(ring).toHaveCount(1);
  await expect(report).toContainText("40 threads out of your inbox");
  const drain = await ring
    .locator("circle")
    .nth(1)
    .evaluate((node) => getComputedStyle(node).animationDuration);
  expect(drain).toBe("10s");

  // Undo, on the same slow account: forty un-archives is another five
  // seconds of requests. The rows come back at once, and a pill says the
  // way back is still going out — no window, no ring, no button — under the
  // id the press-time pill wore. It used to be silence until the report.
  await undo.click();
  await page.waitForTimeout(600);
  await expect(report).toContainText("Putting back…");
  await expect(report).toContainText("40 threads on the way back");
  await expect(ring).toHaveCount(0);
  await expect(report.getByRole("button")).toHaveCount(0);
  expect(patched).toBeLessThan(80);

  // The last request lands and the report takes the pill, with the plain
  // message window, and goes on its own.
  await expect.poll(() => patched, { timeout: 30_000 }).toBe(80);
  await expect(report).toContainText("Back in your inbox");
  await expect(report).toContainText("40 threads restored");
  await expect(report).toHaveCount(0, { timeout: 10_000 });
});

/**
 * The review's reproduction: a PATCH the server never answers. The loop sat
 * on it for good — the lock with it, so every other mail action was refused,
 * and Undo took the pill down and then waited on the same loop forever. Now
 * the client's clock ends the request, the account is closed for the run and
 * named, and an Undo pressed meanwhile holds the pill (button out of reach)
 * until the run settles, then reverses exactly what left.
 */
test("@release a mutation nobody answers cannot hold the lock, or Undo, for good", async ({
  page,
}) => {
  test.setTimeout(MAIL_MUTATION_TIMEOUT_MS + 60_000);
  await login(page);
  const seen = [0, 1, 2].map((index) => ({
    ...thread,
    threadId: `hung-${index}`,
    subject: `Hung thread ${index}`,
    category: "people",
    unread: false,
    lastMessageAt: 1_700_000_000_000 - index,
  }));
  const person = {
    ...thread,
    threadId: "hung-person",
    subject: "Still in People",
    category: "people",
    unread: true,
    lastMessageAt: 1_700_000_001_000,
  } as const;
  const all = [...seen, person];
  const patched: Array<{ readonly threadId: string; readonly body: Record<string, unknown> }> = [];
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account, secondAccount] }),
  );
  await page.route(/\/api\/mail\/threads\/hung-[a-z0-9]+(?:\?.*)?$/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const target = all.find((candidate) => candidate.threadId === threadId);
    if (route.request().method() !== "PATCH") {
      return fulfill(route, { apiVersion: 1, thread: target, messages: [] });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    patched.push({ threadId, body });
    // The second archive is never answered — not refused, not slow: gone.
    if (threadId === "hung-1" && body.archive === true) return undefined;
    return fulfill(route, { apiVersion: 1, thread: { ...target, unread: false } });
  });
  await page.route(/\/api\/mail\/threads\?.*$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      items: forAccount(route, all),
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    }),
  );
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false }),
  );
  await page.goto("/mail");

  const list = page.locator('[aria-label="All inboxes threads"]');
  await expect(list.locator('section[aria-label="Seen"]')).toBeVisible();
  await page.getByRole("button", { name: "Done — archive all 3 in Seen" }).click();

  const report = page.locator('[aria-live="polite"] .brain-toast');
  const refusal = page.locator('[aria-live="assertive"] .brain-toast');
  await expect(report).toContainText("Seen cleared");
  await expect(report).toContainText("3 threads out of your inbox");
  // The first archive landed, the second is hanging.
  await expect.poll(() => patched.length).toBe(2);
  expect(patched.map((entry) => entry.threadId)).toEqual(["hung-0", "hung-1"]);

  // The lock is held while the request is open, and says so at once.
  await page.getByRole("button", { name: "Done — archive all 1 in People" }).click();
  await expect(refusal).toContainText("Finish the current mail action first");

  // Undo, over the hanging request: taken, and not spent. The pill stands
  // with its button out of reach; a second press and ⌘Z get nothing.
  await report.getByRole("button", { name: "Undo" }).click();
  const undoing = report.getByRole("button", { name: "Undoing…" });
  await expect(undoing).toBeVisible();
  await expect(undoing).toBeDisabled();
  await expect(report).toContainText("Seen cleared");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(500);
  expect(patched.length).toBe(2);

  // The clock ends the request. The run settles, the way back runs: one
  // un-archive, for the one thread that left, and the report counts it.
  await expect
    .poll(
      () =>
        patched
          .filter((entry) => entry.body.archive === false)
          .map((entry) => entry.threadId),
      { timeout: MAIL_MUTATION_TIMEOUT_MS + 10_000 },
    )
    .toEqual(["hung-0"]);
  await expect(report).toContainText("Back in your inbox");
  await expect(report).toContainText("1 thread restored");
  await expect(report.getByRole("button", { name: "Undoing…" })).toHaveCount(0);
  // Every row is back on the column.
  await expect(list.locator('section[aria-label="Seen"]')).toContainText("3 threads");

  // And the lock went with the run: the Done that was refused now goes.
  await page.getByRole("button", { name: "Done — archive all 1 in People" }).click();
  await expect
    .poll(() => patched.filter((entry) => entry.threadId === "hung-person").map((entry) => entry.body))
    .toEqual([
      { accountId: account.accountId, archive: true },
      { accountId: account.accountId, read: true },
    ]);
});

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
}
