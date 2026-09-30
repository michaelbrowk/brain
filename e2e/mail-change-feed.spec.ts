import { expect, test, type Page, type Route } from "playwright/test";

/*
  THE CHANGE FEED, END TO END IN THE BROWSER. The mail service and Brain's
  loop are not in this run, so the spec stands in for the one thing they hand
  a tab: the `mail` event on /api/events. The stream is held until the spec
  says what it carries, then answered once with a reconnect delay of an hour,
  so nothing but that event can explain what the tab does next. The Mail
  routes are the fake client, as in mail-client.spec.ts.
*/

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

const thread = {
  accountId: account.accountId,
  threadId: "thread-1",
  subject: "Lunch this Friday?",
  participants: [{ name: "Ben Johnson", address: "ben@example.test" }],
  snippet: "12PM sounds great to me.",
  lastMessageAt: 1_700_000_000_000,
  messageCount: 1,
  unread: false,
  starred: false,
  hasAttachments: false,
  listMessage: false,
  sizeBytes: 0,
  category: "people",
  newSender: false,
} as const;

const arrival = {
  ...thread,
  threadId: "thread-arrived",
  subject: "The letter that just arrived",
  participants: [{ name: "Casey Lin", address: "casey@example.test" }],
  lastMessageAt: 1_700_000_100_000,
  unread: true,
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
      snippet: "Preview while the body loads",
      textBody: null,
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
        candidate.url().endsWith("/api/auth") && candidate.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

/** Holds the tab's event stream until `send` names what it carries. */
async function holdEventStream(page: Page) {
  let answer: (body: string) => void = () => {};
  const body = new Promise<string>((resolve) => {
    answer = resolve;
  });
  await page.route("**/api/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: await body,
    });
  });
  return {
    send(event: unknown) {
      answer(
        "retry: 3600000\n\n" +
          'id: 0\nevent: ready\ndata: {"sequence":0}\n\n' +
          `event: mail\ndata: ${JSON.stringify(event)}\n\n`,
      );
    },
  };
}

async function installMailRoutes(
  page: Page,
  content: (method: string) => unknown,
) {
  const state = { arrived: false, threadLists: 0, contentReads: 0 };
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account] }),
  );
  await page.route(/\/api\/mail\/threads\?.*$/, (route) => {
    state.threadLists += 1;
    return fulfill(route, {
      apiVersion: 1,
      items: state.arrived ? [arrival, thread] : [thread],
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    });
  });
  await page.route(/\/api\/mail\/threads\/thread-1(?:\?.*)?$/, (route) =>
    fulfill(route, detail),
  );
  await page.route(/\/api\/mail\/message-content\/message-1(?:\?.*)?$/, (route) => {
    if (route.request().method() === "GET") state.contentReads += 1;
    return fulfill(route, content(route.request().method()));
  });
  await page.route("**/api/mail/drafts**", (route) =>
    fulfill(route, { apiVersion: 1, drafts: [] }),
  );
  await page.route("**/api/mail/senders/state", (route) =>
    fulfill(route, {
      apiVersion: 1,
      enabled: false,
      enabledAt: null,
      backfillComplete: false,
      domainScopeRefused: [],
    }),
  );
  return state;
}

test("a letter the service reports reaches the list within a second, without a poll", async ({
  page,
}) => {
  await login(page);
  const stream = await holdEventStream(page);
  const state = await installMailRoutes(page, () => ({}));
  await page.goto("/mail");
  await expect(page.getByText(thread.subject, { exact: true })).toBeVisible();
  const before = state.threadLists;

  state.arrived = true;
  stream.send({
    kind: "mail",
    changeKind: "sync",
    accountId: account.accountId,
    mailboxIds: ["inbox", "all"],
  });

  await expect(page.getByText(arrival.subject, { exact: true })).toBeVisible({
    timeout: 1_500,
  });
  // One read of page one for the event, and nothing on a timer.
  expect(state.threadLists).toBe(before + 1);
});

test("the reader shows a body the moment the service says it is ready", async ({ page }) => {
  await login(page);
  const stream = await holdEventStream(page);
  let bodyReady = false;
  const state = await installMailRoutes(page, () =>
    bodyReady
      ? {
          apiVersion: 1,
          accountId: account.accountId,
          messageId: "message-1",
          state: "ready",
          textBody: "The body the service announced.",
          htmlBody: null,
          attachments: [],
        }
      : {
          apiVersion: 1,
          accountId: account.accountId,
          messageId: "message-1",
          state: "fetching",
        },
  );
  await page.goto("/mail");
  await page.getByText(thread.subject, { exact: true }).click();

  // The reader's own polls run at 0, 0.3, 0.9 and 2.1 seconds and then wait
  // 2.4 seconds more. The event lands right after the fourth.
  await expect.poll(() => state.contentReads, { timeout: 5_000 }).toBe(4);
  bodyReady = true;
  stream.send({
    kind: "mail",
    changeKind: "content_ready",
    accountId: account.accountId,
    mailboxIds: [],
    messageIds: ["message-1"],
  });

  await expect(page.getByText("The body the service announced.")).toBeVisible({
    timeout: 1_500,
  });
  expect(state.contentReads).toBe(5);
});
