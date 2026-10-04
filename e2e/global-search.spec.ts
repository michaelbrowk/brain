// Global search: the palette's Mail and Tasks groups, proved in a browser
// because the arrow keys, the latch into Mail and the task row's scroll are
// only real there. The mail service is mocked at the route, as every mail
// spec mocks it; the task and the page are seeded through the real API.
//
// EVERY TEST IN THIS FILE IS `@release`, for the reason e2e/tasks.spec.ts
// states at its head: ci.yml and release.yml both run `--grep @release`, and
// an untagged test here would run in the weekly job and nowhere else.
import { expect, test, type Page, type Route } from "playwright/test";

import { freshNotes } from "./fresh-notes";
import { openPalette } from "./open-palette";

freshNotes();

const account = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  emailAddress: "person@example.test",
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
} as const;

// Read already, so opening it fires no auto-read PATCH this spec would have
// to answer.
const thread = {
  accountId: account.accountId,
  threadId: "thread-1",
  subject: "Quarterly launch review",
  participants: [
    { name: "Personal", address: account.emailAddress },
    { name: "Ben Johnson", address: "ben@example.test" },
  ],
  snippet: "Cached quarterly preview match",
  lastMessageAt: 1_700_000_000_000,
  messageCount: 1,
  unread: false,
  starred: false,
  hasAttachments: false,
  listMessage: false,
  sizeBytes: 1200,
  category: "people",
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
      to: [{ name: "Personal", address: account.emailAddress }],
      cc: [],
      subject: thread.subject,
      sentAt: 1_700_000_000_000,
      unread: false,
      inInbox: true,
      snippet: thread.snippet,
      textBody: "The quarterly launch review is on Friday.",
      htmlBody: null,
      hasAttachments: false,
    },
  ],
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

async function browserJson(
  page: Page,
  requestPath: string,
  init: { method?: string; body?: unknown } = {},
) {
  return page.evaluate(
    async ({ target, requestInit }) => {
      const response = await fetch(target, {
        method: requestInit.method,
        headers:
          requestInit.body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body:
          requestInit.body === undefined ? undefined : JSON.stringify(requestInit.body),
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    },
    { target: requestPath, requestInit: init },
  );
}

function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The mail service, at the route: one account, one Inbox letter, and the
 *  search-all route the palette asks. The counters are what the tests read:
 *  how many times the palette asked, and which thread Mail then fetched. */
async function installMailRoutes(page: Page) {
  const counters = { searchAll: 0, threadReads: [] as string[] };
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
    if (route.request().method() === "GET") counters.threadReads.push(route.request().url());
    return fulfill(route, route.request().method() === "PATCH" ? { apiVersion: 1, thread } : detail);
  });
  await page.route(/\/api\/mail\/threads\?.*$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      items: [thread],
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    }),
  );
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false }),
  );
  await page.route(/\/api\/mail\/message-content\/message-1(?:\?.*)?$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      accountId: account.accountId,
      messageId: "message-1",
      state: "ready",
      textBody: detail.messages[0].textBody,
      htmlBody: null,
      attachments: [],
    }),
  );
  await page.route("**/api/mail/drafts**", (route) =>
    fulfill(route, { apiVersion: 1, drafts: [] }),
  );
  await page.route("**/api/mail/search/all", (route) => {
    counters.searchAll += 1;
    return fulfill(route, {
      apiVersion: 1,
      threads: [thread],
      accounts: [
        {
          accountId: account.accountId,
          emailAddress: account.emailAddress,
          mailboxId: "all",
          availability: {
            status: "available",
            lastSuccessfulAt: 1_700_000_000_000,
            windowTruncated: false,
          },
          indexStatus: "ready",
          resultsTruncated: false,
        },
      ],
      indexBuilding: false,
      truncated: false,
    });
  });
  return counters;
}

async function setModule(page: Page, moduleName: "mail" | "tasks", on: boolean) {
  const answer = await browserJson(page, "/api/settings/modules", {
    method: "PUT",
    body: { [moduleName]: on },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

function heading(page: Page, name: string) {
  return page.locator("[cmdk-group-heading]", { hasText: new RegExp(`^${name}$`) });
}

function selectedOption(page: Page) {
  return page.getByRole("option", { selected: true });
}

test("@release the palette searches pages, mail and tasks in one list and opens each", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // `useNamedTask` takes the `?task=` off the URL the moment it has answered
  // it, so the entry is recorded as it is written rather than read afterwards.
  await page.addInitScript(() => {
    const pushed: string[] = [];
    (window as unknown as { __pushed: string[] }).__pushed = pushed;
    const original = history.pushState.bind(history);
    history.pushState = (state, title, url) => {
      pushed.push(String(url));
      return original(state, title, url);
    };
  });
  await login(page);

  const created = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Quarterly planning note", markdown: "A plan." },
  });
  expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
  const seeded = await browserJson(page, "/api/tasks", {
    method: "POST",
    body: { title: "Quarterly plants", when: localToday() },
  });
  expect(seeded.ok, JSON.stringify(seeded.body)).toBeTruthy();
  const taskId = (seeded.body as { task: { id: string } }).task.id;

  const counters = await installMailRoutes(page);
  await page.goto("/");

  await openPalette(page);
  const palette = page.getByRole("combobox", { name: "Search and commands" });
  await palette.fill("quarterly");
  await expect(heading(page, "Pages")).toBeVisible();
  await expect(heading(page, "Mail")).toBeVisible();
  await expect(heading(page, "Tasks")).toBeVisible();
  await expect(page.getByRole("option", { name: /Quarterly planning note/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Quarterly launch review/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Quarterly plants/ })).toBeVisible();
  expect(counters.searchAll).toBeGreaterThanOrEqual(1);

  // The cursor starts on the page row and the arrows walk it down through the
  // groups, into Mail: cmdk owns the walk, the rows only have to be its items.
  await expect(selectedOption(page)).toContainText("Quarterly planning note");
  for (let step = 0; step < 12; step += 1) {
    if ((await selectedOption(page).textContent())?.includes("Quarterly launch review")) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(selectedOption(page)).toContainText("Quarterly launch review");
  await page.keyboard.press("Enter");

  // Mail is up, and the latch made it fetch the letter the row named.
  await expect(page).toHaveURL("/mail");
  await expect(page.locator('button[aria-label^="Mailbox: "]')).toBeVisible();
  await expect
    .poll(() => counters.threadReads.some((url) => url.includes("/api/mail/threads/thread-1")))
    .toBe(true);

  await openPalette(page);
  await palette.fill("quarterly plants");
  await page.getByRole("option", { name: /Quarterly plants/ }).click();

  await expect(page).toHaveURL(/^[^?]*\/tasks(\?.*)?$/);
  const pushed = await page.evaluate(
    () => (window as unknown as { __pushed: string[] }).__pushed,
  );
  expect(pushed).toContain(`/tasks?task=${taskId}`);
  await expect(
    page.locator(`.brain-task-row-item[data-task-id="${taskId}"] .brain-task-row[data-selected]`),
  ).toBeVisible();
});

test("@release a paused Mail has no group and the palette asks the mail route for nothing", async ({
  page,
}) => {
  await login(page);
  const seeded = await browserJson(page, "/api/tasks", {
    method: "POST",
    body: { title: "Quarterly plants", when: localToday() },
  });
  expect(seeded.ok, JSON.stringify(seeded.body)).toBeTruthy();
  const counters = await installMailRoutes(page);
  await page.goto("/");
  // The sidebar's row, not Home's mail block, which draws a "Mail" button of
  // its own once the mocked account answers.
  const mailRow = page
    .getByRole("complementary")
    .getByRole("button", { name: "Mail", exact: true });
  await expect(mailRow).toBeVisible();

  await setModule(page, "mail", false);
  try {
    // The server reads the switch on the next paint; the live event that
    // takes the row away with no reload is e2e/modules.spec.ts's to prove.
    await page.goto("/");
    await expect(mailRow).toHaveCount(0);
    await openPalette(page);
    await page.getByRole("combobox", { name: "Search and commands" }).fill("quarterly");
    await expect(heading(page, "Tasks")).toBeVisible();
    await expect(heading(page, "Mail")).toHaveCount(0);
    expect(counters.searchAll).toBe(0);
    await page.keyboard.press("Escape");
  } finally {
    await setModule(page, "mail", true);
  }
});

test("@release a letter the palette found outside Inbox opens in the mailbox its search read", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  await installMailRoutes(page);

  // Gmail's search reads All Mail, so it finds a letter archived long ago,
  // and the Inbox read answers 404 for it, as production's nginx showed. The
  // mailbox read is where it is. Routes registered later win, so these stand
  // over the shared ones for this test only.
  const archived = {
    ...thread,
    threadId: "thread-archived",
    subject: "Quarterly insurance renewal",
    snippet: "Your policy renews next month",
  };
  const archivedDetail = {
    ...detail,
    thread: archived,
    messages: [
      {
        ...detail.messages[0],
        messageId: "message-archived",
        threadId: archived.threadId,
        subject: archived.subject,
        inInbox: false,
        snippet: archived.snippet,
        textBody: "Your insurance policy renews on the first of next month.",
      },
    ],
  };
  const reads = { inbox: 0, mailbox: 0 };
  const fulfill = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route(/\/api\/mail\/threads\/thread-archived(?:\?.*)?$/, (route) => {
    reads.inbox += 1;
    return fulfill(route, { apiVersion: 1, error: { code: "mail_thread_not_found" } }, 404);
  });
  await page.route(/\/api\/mail\/mailboxes\/all\/threads\?.*$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      mailboxId: "all",
      items: [thread],
      nextCursor: null,
      availability: {
        status: "available",
        lastSuccessfulAt: 1_700_000_000_000,
        windowTruncated: false,
      },
    }),
  );
  await page.route(/\/api\/mail\/mailboxes\/all\/threads\/thread-archived(?:\?.*)?$/, (route) => {
    reads.mailbox += 1;
    return fulfill(route, archivedDetail);
  });
  await page.route(/\/api\/mail\/message-content\/message-archived(?:\?.*)?$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      accountId: account.accountId,
      messageId: "message-archived",
      state: "ready",
      textBody: archivedDetail.messages[0].textBody,
      htmlBody: null,
      attachments: [],
    }),
  );
  await page.route("**/api/mail/search/all", (route) =>
    fulfill(route, {
      apiVersion: 1,
      threads: [archived],
      accounts: [
        {
          accountId: account.accountId,
          emailAddress: account.emailAddress,
          mailboxId: "all",
          availability: {
            status: "available",
            lastSuccessfulAt: 1_700_000_000_000,
            windowTruncated: false,
          },
          indexStatus: "ready",
          resultsTruncated: false,
        },
      ],
      indexBuilding: false,
      truncated: false,
    }),
  );
  await page.goto("/");

  await openPalette(page);
  await page.getByRole("combobox", { name: "Search and commands" }).fill("insurance");
  await page.getByRole("option", { name: /Quarterly insurance renewal/ }).click();

  // Mail stands in All Mail, where the search found the letter, and the
  // reader has it open: the pick no longer ends on "Choose a message".
  await expect(page).toHaveURL("/mail");
  await expect(page.locator('button[aria-label^="Mailbox: "]')).toHaveAttribute(
    "aria-label",
    "Mailbox: All Mail",
  );
  const reader = page.locator('section[aria-label="Message reader"]');
  await expect(reader).toContainText("Quarterly insurance renewal");
  await expect(reader).not.toContainText("Choose a message");
  // Out of the Inbox, so its way back is the strip's one action.
  await expect(
    reader.getByRole("button", { name: "Move to Inbox", exact: true }),
  ).toBeVisible();
  expect(reads.mailbox).toBeGreaterThanOrEqual(1);
  expect(reads.inbox).toBe(0);
});

test("@release the palette names a mailbox it could not search, and drops the line once it can", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  await installMailRoutes(page);
  // The first minutes after the mail service restarts: the account answers,
  // with no rows and the cache's own word for why. Registered after the
  // shared routes, so this one answers.
  let synced = false;
  const asked: string[] = [];
  await page.route("**/api/mail/search/all", (route) => {
    asked.push((route.request().postDataJSON() as { query: string }).query);
    return route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        apiVersion: 1,
        threads: synced ? [thread] : [],
        accounts: [
          {
            accountId: account.accountId,
            emailAddress: account.emailAddress,
            mailboxId: "all",
            availability: synced
              ? {
                  status: "available",
                  lastSuccessfulAt: 1_700_000_000_000,
                  windowTruncated: false,
                }
              : {
                  status: "unavailable",
                  reason: "global_syncing",
                  lastSuccessfulAt: null,
                  windowTruncated: null,
                },
            indexStatus: "ready",
            // The service's own rule: a mailbox it could not read answers a
            // page that is short of the whole, and the route folds that in.
            resultsTruncated: !synced,
          },
        ],
        indexBuilding: false,
        truncated: !synced,
      }),
    });
  });
  await page.goto("/");

  await openPalette(page);
  const palette = page.getByRole("combobox", { name: "Search and commands" });
  // Nothing else in a fresh notes folder answers this word, so without the
  // line the palette would say "No results" for a mailbox it never read.
  await palette.fill("zzquarterly");
  const mailGroup = page.locator("[cmdk-group]", { has: heading(page, "Mail") });
  await expect(mailGroup.getByRole("status")).toHaveText(
    `${account.emailAddress} is still syncing. Some letters may be missing.`,
  );
  await expect(page.getByText(/No results for/)).toHaveCount(0);

  // The mailbox finishes and the change feed says so. The palette asks the
  // query on screen again by itself, and the line is gone with nothing typed.
  synced = true;
  const before = asked.length;
  await page.evaluate(
    ({ accountId }) =>
      window.dispatchEvent(
        new CustomEvent("brain:mail-changed", {
          detail: { kind: "mail", changeKind: "sync", accountId, mailboxIds: ["inbox"] },
        }),
      ),
    { accountId: account.accountId },
  );
  await expect(page.getByRole("option", { name: /Quarterly launch review/ })).toBeVisible();
  await expect(mailGroup.getByRole("status")).toHaveCount(0);
  expect(asked.slice(before)).toContain("zzquarterly");
  await expect(palette).toHaveValue("zzquarterly");
  await page.keyboard.press("Escape");
});
