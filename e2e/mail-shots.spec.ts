// Owner-gate artifact capture for the mail surfaces (P5) — run on demand:
//
//   BRAIN_E2E_PORT=3039 BRAIN_DIST_DIR=.next/e2egm node scripts/e2e-dev.mjs
//   MAIL_SHOTS=1 BRAIN_E2E_PORT=3039 pnpm exec playwright test e2e/mail-shots.spec.ts
//
// Screenshots land in docs/design/mail/. Skipped everywhere else so the full
// e2e suite never rewrites the artifacts on disk.
//
// The directory it writes into is on the publication denylist
// (scripts/publication-denylist.mjs), so this repository carries none of
// these frames. Shoot them, read them, throw them away — but do not commit
// them here: the forbidden-path step of `pnpm check` refuses a tracked path
// the list names.

import { expect, test, type Page, type Route } from "playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";

const OUT = path.join(process.cwd(), "docs", "design", "mail");

test.skip(process.env.MAIL_SHOTS !== "1", "artifact capture — run with MAIL_SHOTS=1");

const ACCOUNT = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  emailAddress: "misha@example.test",
  displayName: "Personal",
  status: "connected",
  connectedAt: 1_755_000_000_000,
  createdAt: 1_755_000_000_000,
  updatedAt: 1_755_000_000_000,
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

const FILLER = [
  {
    from: { name: "Yulia Orlova", address: "yulia@example.test" },
    subject: "Storyboard for the launch film",
    snippet: "Four beats, no voiceover. The third one is the weak link and I know it.",
  },
  {
    from: { name: "Deploy bot", address: "bot@example.test" },
    subject: "Release 2026.8.4 is live",
    snippet: "Twelve commits, one migration, no rollback. Logs are quiet.",
  },
  {
    from: { name: "Karim Haddad", address: "karim@example.test" },
    subject: "Contract redlines back from legal",
    snippet: "Only clause 7 moved. They want a shorter notice period.",
  },
  {
    from: { name: "Nadia Rahman", address: "nadia@example.test" },
    subject: "Photos from the shoot",
    snippet: "Picked 40 out of 900. The evening set is the strong one.",
  },
];

const THREADS = [
  {
    threadId: "thread-1",
    subject: "Stairwell repaint — the two quotes",
    participants: [{ name: "Ben Johnson", address: "ben@example.test" }],
    snippet: "Both are in. One is cheaper, the other can start sooner.",
    lastMessageAt: 1_755_000_000_000,
    messageCount: 3,
    unread: true,
    starred: false,
    hasAttachments: true,
  },
  {
    threadId: "thread-2",
    subject: "Design review — glass on the mail column",
    participants: [{ name: "Lera Vasilyeva", address: "lera@example.test" }],
    snippet: "Pills over the list read well. The reader strip is the part I want to talk through.",
    lastMessageAt: 1_754_900_000_000,
    messageCount: 1,
    unread: true,
    starred: true,
    hasAttachments: false,
  },
  {
    threadId: "thread-3",
    subject: "Invoice 2026-08 attached",
    participants: [{ name: "Studio Accounts", address: "billing@example.test" }],
    snippet: "Attached is the August invoice. Payment terms unchanged.",
    lastMessageAt: 1_754_700_000_000,
    messageCount: 1,
    unread: false,
    starred: false,
    hasAttachments: true,
  },
  {
    threadId: "thread-4",
    subject: "Re: Lunch this Friday?",
    participants: [{ name: "Anna Petrova", address: "anna@example.test" }],
    snippet: "Works for me. The place on the corner opens at noon.",
    lastMessageAt: 1_754_500_000_000,
    messageCount: 5,
    unread: false,
    starred: false,
    hasAttachments: false,
  },
  // Filler so the column actually scrolls: the edge-blur under the pills is
  // invisible at rest and only earns its place on a list that runs past the
  // fold.
  ...Array.from({ length: 12 }, (_, index) => ({
    threadId: `thread-fill-${index}`,
    subject: FILLER[index % FILLER.length].subject,
    participants: [FILLER[index % FILLER.length].from],
    snippet: FILLER[index % FILLER.length].snippet,
    lastMessageAt: 1_754_400_000_000 - index * 86_400_000,
    messageCount: 1 + (index % 3),
    unread: false,
    starred: false,
    hasAttachments: index % 4 === 0,
  })),
].map((thread) => ({ ...thread, accountId: ACCOUNT.accountId }));

const BODY_HTML = `
<h2>The two quotes</h2>
<p>Both painters walked the stairwell on Monday and both have sent numbers
now. One is cheaper and wants eleven working days. The other cannot start for
a fortnight and then promises to be out in five.</p>
<p>What I need back is a yes to one of them and a colour. The samples are on
the third-floor landing and they look nothing alike once the stair light is
on.</p>
<p>The bike racks come off the wall either way. Either the caretaker does it
and bills us for the hour, or the three of us do it on a Saturday morning and
put them back the same day.</p>
<p>Tell me before Thursday and I will book whichever you pick.</p>
`;

const REPLY_HTML = `
<p>The cheaper one, and I would rather have the eleven days than wait a
fortnight to start. The hallway has looked like this since we moved in.</p>
<p>Warm white, not the grey. The grey turns green under the stair light after
dark, and nobody will own up to having chosen it.</p>
`;

const REPLY_2_HTML = `
<p>Fine by me. One thing from the ground floor: the carpet fitter comes the
Monday after, so the painters have to be off the stairs by the Friday or we
pay two trades to stand around.</p>
<p>I will take the racks down on Saturday if somebody holds the ladder.</p>
`;

// thread-1 is the artifact's hero and its row says "3". Three senders answer
// that: the reader has to show three articles on their hairlines, each naming
// its own sender — the whole reason the subject, not a sender, went up into
// the paper strip. One message under a "3 messages" caption read as a reader
// bug in the shot.
const MESSAGES = [
  {
    accountId: ACCOUNT.accountId,
    messageId: "message-1",
    threadId: "thread-1",
    from: { name: "Ben Johnson", address: "ben@example.test" },
    replyTo: [],
    to: [{ name: "Personal", address: ACCOUNT.emailAddress }],
    cc: [],
    subject: THREADS[0].subject,
    sentAt: 1_754_820_000_000,
    unread: false,
    inInbox: true,
    snippet: THREADS[0].snippet,
    textBody: null,
    htmlBody: BODY_HTML,
    hasAttachments: true,
  },
  {
    accountId: ACCOUNT.accountId,
    messageId: "message-2",
    threadId: "thread-1",
    from: { name: "Lera Vasilyeva", address: "lera@example.test" },
    replyTo: [],
    to: [
      { name: "Ben Johnson", address: "ben@example.test" },
      { name: "Personal", address: ACCOUNT.emailAddress },
    ],
    cc: [],
    subject: `Re: ${THREADS[0].subject}`,
    sentAt: 1_754_910_000_000,
    unread: false,
    inInbox: true,
    snippet: "The cheaper one, and warm white rather than the grey.",
    textBody: null,
    htmlBody: REPLY_HTML,
    hasAttachments: false,
  },
  {
    accountId: ACCOUNT.accountId,
    messageId: "message-3",
    threadId: "thread-1",
    from: { name: "Karim Haddad", address: "karim@example.test" },
    replyTo: [],
    to: [
      { name: "Ben Johnson", address: "ben@example.test" },
      { name: "Personal", address: ACCOUNT.emailAddress },
    ],
    cc: [{ name: "Lera Vasilyeva", address: "lera@example.test" }],
    subject: `Re: ${THREADS[0].subject}`,
    sentAt: THREADS[0].lastMessageAt,
    unread: false,
    inInbox: true,
    snippet: "Fine by me. One thing from the ground floor about the carpet.",
    textBody: null,
    htmlBody: REPLY_2_HTML,
    hasAttachments: false,
  },
] as const;

const ATTACHMENTS = [
  {
    attachmentId: "attachment-a0123456789abcdef0123456789abcde1",
    filename: "stairwell-quotes.pdf",
    mimeType: "application/pdf",
    disposition: "attachment",
    contentId: null,
    bytes: 1_183_744,
  },
  {
    attachmentId: "attachment-a0123456789abcdef0123456789abcde2",
    filename: "paint-and-materials.xlsx",
    mimeType: "application/vnd.ms-excel",
    disposition: "attachment",
    contentId: null,
    bytes: 96_512,
  },
] as const;

function fulfill(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

async function installMailRoutes(page: Page) {
  // Server truth for thread-1's read state, the way mail-client.spec.ts holds
  // it. Opening a thread marks it read, so the PATCH has to stick: the stub
  // used to answer `unread: false` and then hand the ORIGINAL thread back on
  // the next list refetch, which put the letter back to unread and the pill
  // back to "Mark read" — the narrow label, four characters and ~15px short of
  // the resting one the 277 is measured from. Every frame taken with a thread
  // open was shot in a state the product cannot hold.
  let threadUnread: boolean = THREADS[0].unread;
  const thread1 = () => ({ ...THREADS[0], unread: threadUnread });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [ACCOUNT] }),
  );
  await page.route(/\/api\/mail\/threads\/thread-1(?:\?.*)?$/, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as unknown;
      if (typeof body === "object" && body !== null && "read" in body) {
        threadUnread = (body as { read?: unknown }).read !== true;
      }
      return fulfill(route, { apiVersion: 1, thread: thread1() });
    }
    return fulfill(route, { apiVersion: 1, thread: thread1(), messages: MESSAGES });
  });
  await page.route(/\/api\/mail\/threads\?.*$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      items: THREADS.map((item) =>
        item.threadId === "thread-1" ? thread1() : item,
      ),
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_755_000_000_000 },
    }),
  );
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false }),
  );
  await page.route(/\/api\/mail\/message-content\/(message-[123])(?:\?.*)?$/, (route) => {
    const messageId = /message-content\/(message-[123])/.exec(route.request().url())?.[1];
    const message = MESSAGES.find((item) => item.messageId === messageId) ?? MESSAGES[0];
    return fulfill(route, {
      apiVersion: 1,
      accountId: ACCOUNT.accountId,
      messageId: message.messageId,
      state: "ready",
      textBody: null,
      htmlBody: message.htmlBody,
      attachments: message.hasAttachments ? ATTACHMENTS : [],
    });
  });
  // Drafts: the composer autosaves the moment it opens, so the list, the
  // create and the patch all have to answer or the artifact carries an error
  // toast instead of "Saved".
  await page.route(/\/api\/mail\/drafts\/[^/?]+(?:\?.*)?$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      appliedRevision: 2,
      operationId: null,
      replayed: false,
    }),
  );
  await page.route(/\/api\/mail\/drafts(?:\?.*)?$/, (route) => {
    if (route.request().method() === "GET") {
      return fulfill(route, { apiVersion: 1, drafts: [] });
    }
    const body = route.request().postDataJSON() as {
      draftId: string;
      accountId: string;
      intent: unknown;
      to: string;
      cc: string;
      bcc: string;
      subject: string;
      text: string;
    };
    return fulfill(route, {
      apiVersion: 1,
      created: true,
      draft: {
        apiVersion: 1,
        accountId: body.accountId,
        draftId: body.draftId,
        revision: 1,
        state: "editing",
        intent: body.intent,
        attachments: [],
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        text: body.text,
        sendOperationId: null,
        sendErrorCode: null,
        sentAt: null,
        createdAt: 1_755_000_000_000,
        updatedAt: 1_755_000_000_000,
      },
    });
  });
}

async function login(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important }";
      document.head.appendChild(style);
    });
  });
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

/** A notes page with enough body to scroll, written through the API so the
 *  frame that compares mail's chrome to notes' chrome does not spend its
 *  setup in the editor. */
async function makePage(
  page: Page,
  fields: { title: string; icon?: string; parentId?: string },
) {
  const created = await page.evaluate(async (input) => {
    const body = Array.from(
      { length: 30 },
      (_, index) =>
        `Paragraph ${index}: the paper is the window, the chrome floats over it.`,
    ).join("\n\n");
    const response = await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, markdown: body }),
    });
    return (await response.json()) as { id: string };
  }, fields);
  return created.id;
}

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(scheme === "dark");
}

/** A lone account opens straight into its Inbox (§13): nothing to switch
 *  through. MAIL_BEFORE=1 takes the path the previous commit had — the merge
 *  and its Accounts block — so a `-before-` set can be shot on that commit. */
async function openMailbox(page: Page) {
  await page.goto("/mail");
  if (process.env.MAIL_BEFORE === "1") {
    await openNav(page);
    await page
      .getByRole("menuitemradio", { name: `Open ${ACCOUNT.emailAddress}` })
      .click();
  } else {
    await expect(navTrigger(page)).toHaveAttribute("aria-label", "Mailbox: Inbox");
  }
  await expect(page.getByText(THREADS[0].subject, { exact: true })).toBeVisible();
}

/** `name-before-scheme.png` under MAIL_BEFORE=1, `name-scheme.png` otherwise —
 *  the pair a fix is shown against. */
function frame(name: string, scheme: string) {
  return path.join(
    OUT,
    process.env.MAIL_BEFORE === "1"
      ? `${name}-before-${scheme}.png`
      : `${name}-${scheme}.png`,
  );
}

/** The one control that owns mail navigation, at every width and mode. */
function navTrigger(page: Page) {
  return page.locator('button[aria-label^="Mailbox: "]');
}

async function openNav(page: Page) {
  await navTrigger(page).click();
}

for (const scheme of ["light", "dark"] as const) {
  test(`capture mail artifacts — ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installMailRoutes(page);
    await login(page);
    await setScheme(page, scheme);
    await openMailbox(page);

    // 1 — the thread list: paper column, pill toolbar floating over it, one
    // edge-blur step where the pills overlap the rows.
    await page.mouse.move(1_100, 700);
    await page.locator(".brain-mail-scroll").evaluate((el) => el.scrollTo({ top: 120 }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `thread-list-${scheme}.png`) });

    // 2 — the reader: the opaque paper strip with the action pill, the three
    // messages under it on their hairlines, each naming its own sender, and
    // the first one's attachment chips closing it.
    // Shot 1 left the list scrolled past thread-1 — the row this shot opens.
    // Without the reset the reader's strip names one thread while the column
    // beside it shows another, and the artifact reads as a reader bug.
    await page.locator(".brain-mail-scroll").evaluate((el) => el.scrollTo({ top: 0 }));
    await page.getByText(THREADS[0].subject, { exact: true }).click();
    await expect(
      page.locator('iframe[title="Sanitized HTML message"]').first(),
    ).toBeVisible();
    await expect(page.locator('iframe[title="Sanitized HTML message"]')).toHaveCount(
      MESSAGES.length,
    );
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `reader-${scheme}.png`) });

    // 3 — the composer: the thick sheet, paper fields and paper body.
    await page.getByRole("button", { name: "New message" }).click();
    const sheet = page.locator(".brain-composer-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByPlaceholder("name@example.com").fill("ben@example.test");
    await sheet.getByPlaceholder("Subject").fill("Re: the stairwell quotes");
    await sheet
      .getByPlaceholder("Write a message…")
      .fill(
        "Thursday works. I would run the beat a week early and publish the summary — the numbers hold up on their own.",
      );
    await expect(sheet.getByText("Saved", { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `composer-${scheme}.png`) });

    // 4 — the SIDEBAR while the sheet is open. It used to be the rail's
    // frame, showing Compose drop its ink fill so Send could be the surface's
    // only filled control. There is no rail and no Compose in the sidebar any
    // more, and what the frame says now is the opposite thing: nothing in the
    // panel moves, restyles or reorders when the mail surface does. The accent
    // circle is the shell's New page on every surface, and the panel holds the
    // page tree with the Mail row marked in it.
    const sidebar = page.locator(".brain-sidebar");
    const box = await sidebar.boundingBox();
    if (box) {
      await page.screenshot({
        path: path.join(OUT, `sidebar-while-composing-${scheme}.png`),
        clip: { x: 0, y: 0, width: Math.ceil(box.x + box.width + 40), height: 900 },
      });
    }

    // 5 — Cc and Bcc expanded: three stacked fields that all have to hold the
    // 32px control height (they used to collapse to their content).
    await sheet.getByRole("button", { name: "Cc Bcc" }).click();
    await expect(sheet.getByLabel("Cc", { exact: true })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `composer-copies-${scheme}.png`) });
  });
}

// The two questions mail asks. Both were `window.confirm` until the owner sent
// a screenshot of one — a system alert wearing the origin as its title, in the
// OS's own type, saying nothing about what was about to disappear. Both, both
// themes: the one that deletes a saved draft from the Drafts list, and the one
// the composer's Discard opens over the sheet.
const SAVED_DRAFT = {
  apiVersion: 1,
  draftId: "draft-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  accountId: ACCOUNT.accountId,
  revision: 3,
  state: "editing",
  intent: { kind: "compose" },
  subject: "Re: the stairwell quotes",
  sendOperationId: null,
  sendErrorCode: null,
  createdAt: 1_755_000_000_000,
  updatedAt: 1_755_000_000_000,
  sentAt: null,
} as const;

// A subject long enough to meet the delete button: the date used to run under
// it, and a longer one pushed the date off the row altogether.
const SAVED_DRAFT_LONG = {
  ...SAVED_DRAFT,
  draftId: "draft-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e",
  subject:
    "Re: Design review — glass on the mail column, the reader strip, and what the pill owes the subject",
} as const;

for (const scheme of ["light", "dark"] as const) {
  test(`capture the mail confirmations — ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installMailRoutes(page);
    // Later routes win in Playwright, so this one owns the list and hands
    // everything else back to the handler installed above.
    await page.route(/\/api\/mail\/drafts(?:\?.*)?$/, (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return fulfill(route, {
        apiVersion: 1,
        drafts: [SAVED_DRAFT, SAVED_DRAFT_LONG],
      });
    });
    await login(page);
    await setScheme(page, scheme);
    await openMailbox(page);

    // 1 — deleting a saved draft. The one mail action with no way back, so
    // the one that asks, and the question names the draft by its subject.
    // Drafts is a destination: reached through the nav menu, like every other.
    await openNav(page);
    await page.getByRole("menuitemradio", { name: /^Drafts/ }).click();
    await expect(page.getByText(SAVED_DRAFT.subject, { exact: true })).toBeVisible();
    await expect(navTrigger(page)).toHaveAttribute("aria-label", "Mailbox: Drafts");
    await page.waitForTimeout(400);
    await page.screenshot({ path: frame("drafts", scheme) });
    await page
      .getByRole("button", { name: `Delete draft ${SAVED_DRAFT.subject}` })
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(OUT, `confirm-draft-delete-${scheme}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    // and left the same way it was reached — the menu names where you came
    // from, so the column needs no Back button of its own.
    await openNav(page);
    await page.getByRole("menuitemradio", { name: /^Inbox/ }).click();
    await expect(navTrigger(page)).toHaveAttribute("aria-label", "Mailbox: Inbox");

    // 2 — the composer's Discard, over the open sheet. Closing keeps the
    // draft and asks nothing; this button deletes it, which is the whole
    // difference the text has to carry.
    await page.getByRole("button", { name: "New message" }).click();
    const sheet = page.locator(".brain-composer-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByPlaceholder("Subject").fill("Thursday, then");
    await sheet
      .getByPlaceholder("Write a message…")
      .fill("Half a thought and nowhere to put it yet.");
    await sheet.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(OUT, `confirm-discard-${scheme}.png`),
    });
  });
}

// ── The unified inbox (P5-d) ────────────────────────────────────────────────
// The default mail screen: three accounts merged into People / Notifications /
// Newsletters / Seen. The fixture has to look like a real inbox — every
// section past its 3-row preview so the expanders are in the shot, People
// contributed by more than one account so the sub-headers are, and enough
// rows overall that the column runs past the fold and the edge-blur under the
// pill has something to blur. One thread per section would prove nothing.

const UNIFIED_CAPABILITIES = {
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

const UNIFIED_ACCOUNTS = [
  {
    accountId: `account-a${"0".repeat(31)}1`,
    emailAddress: "misha@example.test",
    displayName: "Personal",
  },
  {
    accountId: `account-a${"b".repeat(32)}`,
    emailAddress: "misha@studio.example",
    displayName: "Studio",
  },
  {
    accountId: `account-a${"c".repeat(32)}`,
    emailAddress: "p.hart@work.example",
    displayName: "Work",
  },
].map((account) => ({
  ...account,
  status: "connected",
  connectedAt: 1_755_000_000_000,
  createdAt: 1_755_000_000_000,
  updatedAt: 1_755_000_000_000,
  providerKind: "gmail",
  capabilities: UNIFIED_CAPABILITIES,
}));

const HOUR = 3_600_000;
// Relative to the capture, not to a frozen epoch: a column where every row
// reads "Aug 12, 2025" is not what an inbox looks like. Today's mail shows a
// time, yesterday's a date — which is the rule the row is testing.
const NOW = Date.now();

/** account index, sender, subject, snippet, category, already read. */
type UnifiedSeedRow = readonly [
  number,
  { readonly name: string; readonly address: string },
  string,
  string | null,
  "people" | "notification" | "newsletter",
  boolean,
];

const UNIFIED_SEED: readonly UnifiedSeedRow[] = [
  // People — five, across all three accounts, so the preview cuts at three
  // and two sub-headers are visible above the fold.
  [0, { name: "Hanna Vogt", address: "hanna@example.test" }, "The bench arrives Tuesday", "They will leave it in the yard if nobody answers the door.", "people", false],
  [0, { name: "Petros Anagnos", address: "petros@example.test" }, "The shed roof needs felt", "Two sheets and a box of clout nails. I can start on Saturday.", "people", false],
  [1, { name: "Sofia Marchetti", address: "sofia@studio.example" }, "Proofs from the risograph", "The second pass is cleaner. The blue sat wrong on the first one.", "people", false],
  [1, { name: "Jonas Lind", address: "jonas@studio.example" }, "Re: the loading bay key", "It sticks. Turn it left first and the door opens without a fight.", "people", false],
  [2, { name: "Amara Diallo", address: "amara@work.example" }, "The keys are with the neighbour", "Second door on the left, and she is in after six.", "people", false],
  // Notifications — machine mail that still wants an answer.
  [0, { name: "Backup", address: "no-reply@backup.example" }, "Last night's archive is complete", "Nine minutes, no warnings. The oldest copy was rotated out.", "notification", false],
  [0, { name: "Allotment Society", address: "post@allotment.example" }, "Your plot inspection is due", "Any Saturday in September. Send a date back and we confirm it.", "notification", false],
  [1, { name: "Studio door", address: "alerts@studio.example" }, "Door left open at 19:40", "Closed again at 19:52. No alarm was raised.", "notification", false],
  [2, { name: "Parking", address: "no-reply@parking.example" }, "Permit renewal, ten days left", "Same bay, same rate. Nothing to do if you are keeping it.", "notification", false],
  // Newsletters — the pile that must never outrank a person, and the whole
  // reason a section can bundle. Fourteen of them: past the point where three
  // rows could honestly stand for the rest, so the group is one digest row
  // and the artifact shows the state the brief is about.
  [0, { name: "Kettle & Bell", address: "letters@kettle.example" }, "Issue 8 — everything in the drawer", "Six links, and a long read about shops that never advertise.", "newsletter", false],
  [0, { name: "The Slow Ferry", address: "post@slowferry.example" }, "Crossing 21", "On timetables that have not moved since the boats burned coal.", "newsletter", false],
  [1, { name: "Margins", address: "notes@margins.example" }, "Footnotes, plainly", "Why a note at the foot of a page is read and one at the side is not.", "newsletter", false],
  [2, { name: "Shelf Life", address: "hello@shelflife.example" }, "What went off this week", "Four shops, one honest list, and no recipes at all.", "newsletter", false],
  [0, { name: "Roundhouse", address: "news@roundhouse.example" }, "[Roundhouse] Three people answered your notice", "Open the board to read them. [image]", "newsletter", false],
  [0, { name: "دار الأثر", address: "news@athar.example" }, "معرض الخريف يفتح أبوابه", "الدخول مجاني في الأسبوع الأول من المعرض", "newsletter", false],
  [1, { name: "Bramble Post", address: "hello@bramble.example" }, "Bramble Post is back", null, "newsletter", false],
  [2, { name: "Kettle & Bell", address: "letters@kettle.example" }, "Issue 6 — brass, and patience", "What a repair bench keeps within arm's reach after forty years.", "newsletter", false],
  [0, { name: "The Slow Ferry", address: "post@slowferry.example" }, "Crossing 19", "The island shop that opens when the boat lands and not before.", "newsletter", false],
  [1, { name: "Margins", address: "notes@margins.example" }, "Ragged right, on purpose", "The one setting that makes a narrow column readable again.", "newsletter", false],
  [2, { name: "Shelf Life", address: "hello@shelflife.example" }, "What kept", "Jars, labels, and the drawer nobody opens until March.", "newsletter", false],
  [0, { name: "Roundhouse", address: "news@roundhouse.example" }, "[Roundhouse] The board is quiet this week", "Two notices, both about ladders.", "newsletter", false],
  [1, { name: "Bramble Post", address: "hello@bramble.example" }, "One week of listings left", "After Friday the board clears and starts again.", "newsletter", false],
  [2, { name: "دار الأثر", address: "news@athar.example" }, "ورشة الخط هذا السبت", "المقاعد محدودة والتسجيل مفتوح الآن", "newsletter", false],
  // Seen — read mail, collapsed under one line.
  [0, { name: "Rowan & Sons", address: "accounts@rowan.example" }, "Invoice for August is attached", "Terms are unchanged. The bank details sit at the bottom.", "people", true],
  [1, { name: "Jonas Lind", address: "jonas@studio.example" }, "The bay is clear until Thursday", "Park inside if it rains. Nobody downstairs will mind.", "people", true],
  [2, { name: "Amara Diallo", address: "amara@work.example" }, "Notes from the Tuesday review", "Four things, none of them urgent. The list is at the end.", "people", true],
  [0, { name: "Bike Workshop", address: "no-reply@velo.example" }, "Your service is booked", "Thursday at 09:00. Bring the second key for the lock.", "notification", true],
  [1, { name: "Plate & Press", address: "digest@plate.example" }, "Weekly digest", "This week's set, and two pulled out of the archive.", "newsletter", true],
];

const UNIFIED_THREADS = UNIFIED_SEED.map(
  ([accountIndex, from, subject, snippet, category, read], index) => ({
    accountId: UNIFIED_ACCOUNTS[accountIndex]!.accountId,
    threadId: `thread-u${index}`,
    subject,
    participants: [from],
    snippet,
    lastMessageAt: NOW - index * (HOUR / 2) - (read ? 26 * HOUR : 0),
    messageCount: index % 5 === 0 ? 3 : 1,
    unread: !read,
    starred: index === 2,
    hasAttachments: index % 6 === 0,
    listMessage: category !== "people",
    sizeBytes: 24_000 + index * 3_100,
    category,
  }),
);

/**
 * Three more people, so People crosses the line where three rows can no
 * longer honestly stand for the rest (5 → 8) and the section bundles. The
 * default fixture keeps People at five on purpose: that is the state where
 * the per-account sub-headers are visible, and one fixture cannot show both.
 */
const PEOPLE_PILE_SEED: readonly UnifiedSeedRow[] = [
  [0, { name: "Ivan Sokolov", address: "ivan@example.test" }, "The quote came back", "Two weeks longer than we planned, and about what we expected on price.", "people", false],
  [1, { name: "Maya Fischer", address: "maya@studio.example" }, "Re: the studio keys", "I left the spare set with the concierge. Ask for the envelope.", "people", false],
  [2, { name: "Omar Nasser", address: "omar@work.example" }, "Thursday, 14:00?", "Happy to move it if the review runs long. Let me know by Wednesday.", "people", false],
];

const PEOPLE_PILE_THREADS = [
  ...UNIFIED_THREADS,
  ...PEOPLE_PILE_SEED.map(
    ([accountIndex, from, subject, snippet, category, read], index) => ({
      accountId: UNIFIED_ACCOUNTS[accountIndex]!.accountId,
      threadId: `thread-p${index}`,
      subject,
      participants: [from],
      snippet,
      lastMessageAt: NOW - index * (HOUR / 3),
      messageCount: 1,
      unread: !read,
      starred: false,
      hasAttachments: false,
      listMessage: category !== "people",
      sizeBytes: 31_000 + index * 900,
      category,
    }),
  ),
];

/**
 * The pile the undo pill was measured on: forty read threads under Seen. The
 * window used to be predicted from that count — ten seconds plus six a thread
 * — so this press armed four minutes of a ring that crawled a pixel a second,
 * which is what a reader calls a frozen pill.
 */
const SEEN_PILE_THREADS = [
  ...UNIFIED_THREADS,
  ...Array.from({ length: 35 }, (_value, index) => {
    const source = UNIFIED_SEED[index % UNIFIED_SEED.length]!;
    return {
      accountId: UNIFIED_ACCOUNTS[index % UNIFIED_ACCOUNTS.length]!.accountId,
      threadId: `thread-s${index}`,
      subject: source[2],
      participants: [source[1]],
      snippet: source[3],
      lastMessageAt: NOW - 30 * HOUR - index * HOUR,
      messageCount: 1,
      unread: false,
      starred: false,
      hasAttachments: false,
      listMessage: source[4] !== "people",
      sizeBytes: 18_000 + index * 700,
      category: source[4],
    };
  }),
];

async function installUnifiedRoutes(
  page: Page,
  threads: readonly (typeof UNIFIED_THREADS)[number][] = UNIFIED_THREADS,
) {
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: UNIFIED_ACCOUNTS }),
  );
  await page.route(/\/api\/mail\/threads\?.*$/, (route) => {
    const accountId = new URL(route.request().url()).searchParams.get("accountId");
    return fulfill(route, {
      apiVersion: 1,
      items: threads.filter((thread) => thread.accountId === accountId),
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: NOW },
    });
  });
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false }),
  );
  // A thread the selected-row frame can actually open: the reader has to
  // stand beside the selected band, on the same canvas, with its message on
  // the one paper sheet left in the surface.
  await page.route(/\/api\/mail\/threads\/(thread-u\d+)(?:\?.*)?$/, (route) => {
    const threadId = /threads\/(thread-u\d+)/.exec(route.request().url())?.[1];
    const thread =
      threads.find((entry) => entry.threadId === threadId) ?? threads[0]!;
    if (route.request().method() === "PATCH") {
      return fulfill(route, { apiVersion: 1, thread: { ...thread, unread: false } });
    }
    return fulfill(route, {
      apiVersion: 1,
      thread,
      messages: [
        {
          accountId: thread.accountId,
          messageId: `message-${thread.threadId}`,
          threadId: thread.threadId,
          from: thread.participants[0],
          replyTo: [],
          to: [{ name: "Personal", address: "misha@example.test" }],
          cc: [],
          subject: thread.subject,
          sentAt: thread.lastMessageAt,
          unread: false,
          inInbox: true,
          snippet: thread.snippet,
          textBody: null,
          htmlBody: BODY_HTML,
          hasAttachments: false,
        },
      ],
    });
  });
  await page.route(/\/api\/mail\/message-content\/message-(thread-u\d+)(?:\?.*)?$/, (route) => {
    const threadId = /message-content\/message-(thread-u\d+)/.exec(
      route.request().url(),
    )?.[1];
    const thread =
      threads.find((entry) => entry.threadId === threadId) ?? threads[0]!;
    return fulfill(route, {
      apiVersion: 1,
      accountId: thread.accountId,
      messageId: `message-${thread.threadId}`,
      state: "ready",
      textBody: null,
      htmlBody: BODY_HTML,
      attachments: [],
    });
  });
  // The avatar proxy would leave the box for a favicon. Refusing it keeps the
  // artifact offline and deterministic: every row falls back to its monogram.
  await page.route("**/api/mail/sender-icon/**", (route) => route.abort());
}

for (const scheme of ["light", "dark"] as const) {
  test(`capture unified inbox artifact — ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installUnifiedRoutes(page);
    await login(page);
    await setScheme(page, scheme);

    // Mail opens in unified mode — no account is picked on the way in.
    await page.goto("/mail");
    const list = page.locator('[aria-label="All inboxes threads"]');
    await expect(list.getByText(UNIFIED_SEED[0]![2], { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Done — archive all \d+ in People$/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Show all 5 in People" })).toBeVisible();

    // Park the pointer off the column so nothing is caught mid-hover.
    await page.mouse.move(1_100, 780);
    await page.waitForTimeout(500);

    // 1 — the column at rest: two groups previewing their first three rows,
    // two bundled into a single digest row each, and the whole question of
    // this frame — whether four groups still read as four groups when the
    // only line left between them is the group boundary.
    await page.screenshot({ path: path.join(OUT, `unified-${scheme}.png`) });

    // 2 — the same column alone, at 1:1, so the digest row is legible: the
    // avatar stack, who is in the pile, and the newest subject under it.
    const column = page.locator(".brain-mail-list");
    const columnBox = await column.boundingBox();
    if (columnBox) {
      await page.screenshot({
        path: path.join(OUT, `unified-bundle-${scheme}.png`),
        clip: {
          x: Math.max(0, columnBox.x - 12),
          y: 0,
          width: columnBox.width + 24,
          height: 900,
        },
      });
    }

    // 3 — a selected row: the blue capsule inset into the column, its rim,
    // and the reader it points at standing on the same canvas beside it.
    await list.getByText(UNIFIED_SEED[0]![2], { exact: true }).click();
    await expect(
      page.locator('iframe[title="Sanitized HTML message"]').first(),
    ).toBeVisible();
    await page.mouse.move(1_100, 860);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `unified-selected-${scheme}.png`) });

    // 4 — hover beside the selection: the pointer on the row UNDER the open
    // thread. The frame the whole separator removal turns on. The two used to
    // be told apart by the hairlines above and below the selected band; with
    // those gone it is the rim, the wider tint step (ΔL .055 light / .071
    // dark) and the 4px of air between two capsules that have to do it, and
    // that can only be judged side by side, in one frame.
    await list.getByText(UNIFIED_SEED[1]![2], { exact: true }).first().hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `unified-hover-${scheme}.png`) });

    // 5 — an unbundled section, scrolled: the only state in which this column
    // runs past the fold, and therefore the only one where §7's edge-blur
    // under the pill has anything to do.
    await page.getByRole("button", { name: /Show all \d+ in Newsletters/ }).click();
    await page.mouse.move(1_100, 860);
    await page
      .locator(".brain-mail-scroll")
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(page.locator(".brain-mail-scroll[data-scrolled]")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `unified-scrolled-${scheme}.png`) });
  });
}

// People in bundle form. Every other section can be watched crossing the line
// by expanding it, but People cannot: at five threads it previews and there is
// no state in the default fixture where it bundles. It is also the section
// with the most to lose by bundling — a person's name is not a newsletter's —
// so the state needs a frame of its own rather than an argument.
for (const scheme of ["light", "dark"] as const) {
  test(`capture the People bundle — ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installUnifiedRoutes(page, PEOPLE_PILE_THREADS);
    await login(page);
    await setScheme(page, scheme);

    await page.goto("/mail");
    const list = page.locator('[aria-label="All inboxes threads"]');
    await expect(list).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Show all 8 in People" }),
    ).toBeVisible();
    await page.mouse.move(1_100, 860);
    await page.waitForTimeout(500);

    const column = page.locator(".brain-mail-list");
    const columnBox = await column.boundingBox();
    if (columnBox) {
      await page.screenshot({
        path: path.join(OUT, `unified-people-bundle-${scheme}.png`),
        clip: {
          x: Math.max(0, columnBox.x - 12),
          y: 0,
          width: columnBox.width + 24,
          height: 900,
        },
      });
    }
  });
}

// The one control on the section header that removes mail. Two things have to
// be in one frame to judge it: the header at rest, where Done is now drawn
// rather than waiting for a pointer, and the beat after it is pressed — the
// section gone from the column and the way back offered in the same breath.
for (const scheme of ["light", "dark"] as const) {
  test(`capture the section Done — ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installUnifiedRoutes(page);
    await login(page);
    await setScheme(page, scheme);

    await page.goto("/mail");
    const list = page.locator('[aria-label="All inboxes threads"]');
    await expect(list.getByText(UNIFIED_SEED[0]![2], { exact: true })).toBeVisible();
    const done = page.getByRole("button", {
      name: /^Done — archive all \d+ in Newsletters$/,
    });
    await expect(done).toBeVisible();

    // Pointer on the control itself: this is the frame that says whether a
    // control that clears a whole group reads as findable or as loud.
    await done.hover();
    await page.waitForTimeout(400);
    await done.click();
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
    await page.mouse.move(1_100, 300);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `unified-done-${scheme}.png`) });
  });
}

// What the pill does over a run that takes minutes, in two frames.
//
// Forty threads under Done is forty sequential requests, and the pill is the
// only thing on screen that knows they are happening. It carries no window
// while they go out, so the icon slot holds its glyph and nothing else — a
// ring is a promise of a deadline and there is no deadline yet. When the last
// request lands the same sentence is said again with the plain ten seconds,
// and the ring appearing is the finish line. These are the two frames that
// say whether a pill with no ring reads as standing rather than as stuck.
for (const scheme of ["light", "dark"] as const) {
  test(`capture the Done pill over a long run — ${scheme}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installUnifiedRoutes(page, SEEN_PILE_THREADS);
    // Slow every mutation to what one really costs on a custom-domain account:
    // its own connect, authenticate and logout, with no pool behind it.
    let patched = 0;
    await page.route(/\/api\/mail\/threads\/(thread-[us]\d+)(?:\?.*)?$/, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const threadId = /threads\/(thread-[us]\d+)/.exec(route.request().url())?.[1];
      const target = SEEN_PILE_THREADS.find(
        (candidate) => candidate.threadId === threadId,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      patched += 1;
      return fulfill(route, { apiVersion: 1, thread: target });
    });
    await login(page);
    await setScheme(page, scheme);

    await page.goto("/mail");
    const list = page.locator('[aria-label="All inboxes threads"]');
    await expect(list.getByText(UNIFIED_SEED[0]![2], { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Done — archive all 40 in Seen" })
      .click();

    const report = page.locator('[aria-live="polite"] .brain-toast');
    const ring = report.locator("[data-toast-ring]");
    await expect(report).toContainText("Seen cleared");
    // Off the pill, so the frame is the pill at rest rather than under a hover.
    await page.mouse.move(1_100, 200);

    // Mid-run: eighty per cent of the work still queued and no ring drawn.
    await expect.poll(() => patched, { timeout: 60_000 }).toBeGreaterThan(6);
    await expect(ring).toHaveCount(0);
    await shootPill(page, `unified-done-running-${scheme}`);

    // Settled: the ring is there and a second of it has drained.
    await expect(ring).toHaveCount(1, { timeout: 60_000 });
    await page.waitForTimeout(1_200);
    await shootPill(page, `unified-done-settled-${scheme}`);
  });
}

/** The pill on the canvas it really stands on, with room to read around it. */
async function shootPill(page: Page, name: string) {
  const stack = await page.locator(".brain-toast-stack").boundingBox();
  if (!stack) throw new Error("no toast stack");
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: {
      x: Math.max(0, stack.x - 80),
      y: Math.max(0, stack.y - 60),
      width: Math.min(1440, stack.width + 160),
      height: stack.height + 90,
    },
  });
}

// Under `prefers-contrast: more` `--hair` goes from ink 10% to ink 30%. The
// group boundary is the only line left in the column, and it rides that token,
// so the fallback triples the one thing carrying the structure — this is the
// frame that says whether a group boundary at 30% still reads as a boundary
// and not as a rule drawn across the mail.
for (const scheme of ["light", "dark"] as const) {
  test(`capture the contrast fallback — ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installUnifiedRoutes(page);
    await login(page);
    await page.emulateMedia({ colorScheme: scheme, contrast: "more" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          matchMedia("(prefers-contrast: more)").matches ? "more" : "no",
        ),
      )
      .toBe("more");

    await page.goto("/mail");
    const list = page.locator('[aria-label="All inboxes threads"]');
    await expect(list.getByText(UNIFIED_SEED[0]![2], { exact: true })).toBeVisible();
    await page.mouse.move(1_100, 860);
    await page.waitForTimeout(500);

    const column = page.locator(".brain-mail-list");
    const columnBox = await column.boundingBox();
    if (columnBox) {
      await page.screenshot({
        path: path.join(OUT, `unified-contrast-${scheme}.png`),
        clip: {
          x: Math.max(0, columnBox.x - 12),
          y: 0,
          width: columnBox.width + 24,
          height: 900,
        },
      });
    }
  });
}

// The column's own head is all the chrome this mode has, and the phone is
// where its touch targets and its one row have to be judged. A touch context,
// not a narrow desktop window — the section headers draw Done at rest
// everywhere now, so what the phone still decides is reach, not divergence.
test.describe("unified inbox on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const scheme of ["light", "dark"] as const) {
    test(`capture unified inbox artifact — mobile ${scheme}`, async ({ page }) => {
      test.setTimeout(120_000);
      await installUnifiedRoutes(page);
      await login(page);
      await setScheme(page, scheme);

      await page.goto("/mail");
      const list = page.locator('[aria-label="All inboxes threads"]');
      await expect(list.getByText(UNIFIED_SEED[0]![2], { exact: true })).toBeVisible();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `unified-mobile-${scheme}.png`) });
    });
  }
});

// ── Measurement (P5, v4) ────────────────────────────────────────────────────
// The variant was drawn at 1440×900 in Chromium with monogram avatars and its
// contrast estimated from token values. This test measures the real thing on
// the real stand — painted pixels, both themes, and the geometry below lg —
// and writes docs/design/mail/contrast.md. Same gate as the artifacts.

/**
 * Computed colours come back in whatever space the token was authored in —
 * `getComputedStyle` on an oklch value returns `lab(...)` in Chromium — so
 * the browser resolves them to sRGB for us rather than a regex pretending
 * three numbers are red, green and blue.
 */
async function resolveInk(
  page: Page,
  color: string,
): Promise<readonly [number, number, number]> {
  return page.evaluate((value: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, color);
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return (
    0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  );
}

function contrastRatio(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** oklch lightness of an sRGB pixel — the §8 hover metric. */
function oklchLightness([r, g, b]: readonly [number, number, number]): number {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

async function samplePixel(
  page: Page,
  x: number,
  y: number,
): Promise<readonly [number, number, number]> {
  const png = await page.screenshot({
    clip: { x: Math.round(x), y: Math.round(y), width: 3, height: 3 },
  });
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const acc = [0, 0, 0];
  for (let index = 0; index < 9; index += 1) {
    const offset = index * info.channels;
    acc[0] += data[offset]!;
    acc[1] += data[offset + 1]!;
    acc[2] += data[offset + 2]!;
  }
  return [acc[0]! / 9, acc[1]! / 9, acc[2]! / 9] as const;
}

const MEASURED: string[] = [];

test.describe("mail v4 measurements", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`measure the canvas ground — ${scheme}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await installUnifiedRoutes(page);
      await login(page);
      await setScheme(page, scheme);
      await page.goto("/mail");
      const list = page.locator('[aria-label="All inboxes threads"]');
      await expect(list.getByText(UNIFIED_SEED[0]![2], { exact: true })).toBeVisible();
      await page.mouse.move(1_100, 860);
      await page.waitForTimeout(400);

      const column = page.locator(".brain-mail-list");
      const columnBox = (await column.boundingBox())!;
      // The canvas the rows stand on, sampled in the 2px left of the first
      // text — no fill of our own has ever been painted there.
      const ground = await samplePixel(
        page,
        columnBox.x + 2,
        columnBox.y + 400,
      );

      const lines: string[] = [];
      lines.push(`### ${scheme}`, "");
      lines.push("| what | colour | contrast on the canvas |");
      lines.push("| --- | --- | --- |");
      const inks = await page.evaluate(() => {
        const pick = (selector: string) => {
          const node = document.querySelector(selector);
          return node === null ? null : getComputedStyle(node).color;
        };
        const row = document.querySelector(".brain-mail-row");
        const line = row?.querySelectorAll("span.text-\\[13px\\], span");
        return {
          sectionLabel: pick(".brain-mail-section-head .text-label"),
          sectionCount: pick(".brain-mail-section-head .tabular-nums"),
          sender: row === null ? null : getComputedStyle(row).color,
          time: pick(".brain-mail-row time"),
          count: pick(".brain-mail-count"),
          bundle: pick(".brain-mail-bundle .text-\\[13px\\]"),
          lineCount: line?.length ?? 0,
        };
      });
      const textNodes = await page.evaluate(() => {
        const out: { label: string; color: string }[] = [];
        const row = document.querySelector(".brain-mail-row");
        if (row) {
          const spans = [...row.querySelectorAll("span")];
          const sender = spans.find((node) =>
            node.className.includes("font-semibold"),
          );
          const subject = spans.find((node) =>
            node.className.includes("font-medium"),
          );
          const snippet = spans.find(
            (node) =>
              node.getAttribute("dir") === "auto" &&
              node.className.includes("text-ink-3"),
          );
          if (sender) out.push({ label: "sender, unread (13/600)", color: getComputedStyle(sender).color });
          if (subject) out.push({ label: "subject, unread (13/500)", color: getComputedStyle(subject).color });
          if (snippet) out.push({ label: "snippet continuation (13/400 ink-3)", color: getComputedStyle(snippet).color });
        }
        const account = document.querySelector(".brain-mail-row .max-w-\\[9ch\\]");
        if (account) out.push({ label: "account word (Caption ink-3)", color: getComputedStyle(account).color });
        return out;
      });
      for (const entry of [
        { label: "section label (Label 11/600 ink)", color: inks.sectionLabel },
        { label: "section count (Label ink-3)", color: inks.sectionCount },
        ...textNodes,
        { label: "time (Caption ink-3)", color: inks.time },
        { label: "count chip ink", color: inks.count },
        { label: "bundle senders (13/500 ink-2)", color: inks.bundle },
      ]) {
        if (!entry.color) continue;
        const rgb = await resolveInk(page, entry.color);
        lines.push(
          `| ${entry.label} | \`${entry.color}\` | ${contrastRatio(rgb, ground).toFixed(2)}:1 |`,
        );
      }
      lines.push("");
      lines.push(
        `Canvas under the column: \`rgb(${ground.map((c) => Math.round(c)).join(" ")})\`, L ${oklchLightness(ground).toFixed(3)}.`,
        "",
      );

      // Rest → hover → selected, measured off the paint rather than the token.
      const rowBox = (await page
        .locator(".brain-mail-row")
        .first()
        .boundingBox())!;
      // The row's fill is a capsule inset into the column now, so the probe
      // goes inside it: 5px off its right edge, at half height where the r14
      // corner cannot reach. Any further out and the sample is bare canvas.
      const probeX = rowBox.x + rowBox.width - 5;
      const probeY = rowBox.y + rowBox.height / 2;
      const rest = await samplePixel(page, probeX, probeY);
      await page.mouse.move(rowBox.x + 120, rowBox.y + rowBox.height / 2);
      await page.waitForTimeout(300);
      const hover = await samplePixel(page, probeX, probeY);
      await page.locator(".brain-mail-row").first().click();
      await page.mouse.move(1_100, 860);
      await page.waitForTimeout(500);
      const selected = await samplePixel(page, probeX, probeY);
      // The state the row had none of until now: the pointer ON the open
      // thread. Its fill is already the blue band, so hover there is the ink
      // tint on a layer over it — and it is the means by which a reader
      // confirms the selection, which is what lets rest→selected be a small
      // step at all.
      await page.locator(".brain-mail-row").first().hover();
      await page.waitForTimeout(300);
      const selectedHover = await samplePixel(page, probeX, probeY);
      await page.mouse.move(1_100, 860);
      await page.waitForTimeout(300);
      const restL = oklchLightness(rest);
      lines.push("| row state | pixel | L | ΔL from rest |");
      lines.push("| --- | --- | --- | --- |");
      for (const [label, pixel] of [
        ["rest", rest],
        ["hover (--blue-tint)", hover],
        ["selected (--blue-tint-2, + the rim)", selected],
        ["selected + hover (ink tint over the blue)", selectedHover],
      ] as const) {
        lines.push(
          `| ${label} | \`rgb(${pixel.map((c) => Math.round(c)).join(" ")})\` | ${oklchLightness(pixel).toFixed(3)} | ${Math.abs(oklchLightness(pixel) - restL).toFixed(3)} |`,
        );
      }
      lines.push("");
      lines.push(
        `Step hover → selected: ΔL ${Math.abs(oklchLightness(selected) - oklchLightness(hover)).toFixed(3)}. Step selected → selected+hover: ΔL ${Math.abs(oklchLightness(selectedHover) - oklchLightness(selected)).toFixed(3)} (§8 wants ≥ .03 on every hover).`,
        "",
      );

      // The rules the column keeps, off the layout rather than off the CSS:
      // the one left rule every text column starts on, and the right ones §4
      // wants to be a single 12px inset.
      const rules = await page.evaluate(() => {
        const rect = (node: Element | null | undefined) =>
          node ? node.getBoundingClientRect() : null;
        const column = rect(document.querySelector(".brain-mail-list"));
        const rows = rect(document.querySelector(".brain-mail-rows"));
        const row = rect(document.querySelector(".brain-mail-row"));
        // the second group in the column — the first draws no boundary
        const section = document.querySelectorAll(".brain-mail-section")[1];
        const boundary =
          section === undefined ? null : getComputedStyle(section, "::before");
        // the right-most object in the head's first row — the toolbar pill
        // where the column has one, the nav pill where it does not
        const pill = rect(
          document.querySelector(".brain-mail-navrow > *:last-child"),
        );
        const label = rect(
          document.querySelector(".brain-mail-section-head .text-label"),
        );
        const sender = rect(
          document.querySelector(".brain-mail-body .font-semibold"),
        );
        const bundle = document.querySelector(
          ".brain-mail-bundle:not(.brain-mail-bundle_flat)",
        );
        const bundleText = rect(bundle?.lastElementChild);
        const flat = document.querySelector(".brain-mail-bundle_flat");
        const flatRect = rect(flat);
        const flatLeft =
          flat && flatRect
            ? flatRect.left +
              Number.parseFloat(getComputedStyle(flat).paddingLeft)
            : null;
        return {
          columnLeft: column?.left ?? null,
          columnRight: column?.right ?? null,
          rowsLeft: rows?.left ?? null,
          rowsRight: rows?.right ?? null,
          rowLeft: row?.left ?? null,
          rowRight: row?.right ?? null,
          boundaryLeft: boundary === null ? null : boundary.left,
          boundaryRight: boundary === null ? null : boundary.right,
          pillRight: pill?.right ?? null,
          labelLeft: label?.left ?? null,
          senderLeft: sender?.left ?? null,
          bundleLeft: bundleText?.left ?? null,
          flatLeft,
        };
      });
      const from = (value: number | null, base: number | null) =>
        value === null || base === null ? "—" : (value - base).toFixed(1);
      lines.push("| rule | px from the column's left edge |");
      lines.push("| --- | --- |");
      lines.push(
        `| rows wrapper, left edge | ${from(rules.rowsLeft, rules.columnLeft)} |`,
        `| row capsule, left edge | ${from(rules.rowLeft, rules.columnLeft)} |`,
        `| group boundary rule | ${rules.boundaryLeft ?? "—"} |`,
        `| section label | ${from(rules.labelLeft, rules.columnLeft)} |`,
        `| row sender | ${from(rules.senderLeft, rules.columnLeft)} |`,
        `| bundle digest | ${from(rules.bundleLeft, rules.columnLeft)} |`,
        `| Seen digest | ${from(rules.flatLeft, rules.columnLeft)} |`,
        "",
      );
      lines.push("| right rule | px from the column's right edge |");
      lines.push("| --- | --- |");
      lines.push(
        `| Compose pill | ${from(rules.columnRight, rules.pillRight)} |`,
        `| rows wrapper | ${from(rules.columnRight, rules.rowsRight)} |`,
        `| row capsule | ${from(rules.columnRight, rules.rowRight)} |`,
        `| group boundary rule | ${rules.boundaryRight ?? "—"} |`,
        "",
      );

      // The reader strip against the canvas it now stands on.
      const strip = page.locator(".brain-mail-reader-head");
      const stripBox = await strip.boundingBox();
      if (stripBox) {
        const stripFill = await samplePixel(
          page,
          stripBox.x + stripBox.width - 10,
          stripBox.y + 4,
        );
        const under = await samplePixel(
          page,
          stripBox.x + stripBox.width - 10,
          stripBox.y + stripBox.height + 40,
        );
        lines.push(
          `Reader strip \`rgb(${stripFill.map((c) => Math.round(c)).join(" ")})\` (L ${oklchLightness(stripFill).toFixed(3)}) against the canvas below it \`rgb(${under.map((c) => Math.round(c)).join(" ")})\` (L ${oklchLightness(under).toFixed(3)}) — ΔL ${Math.abs(oklchLightness(stripFill) - oklchLightness(under)).toFixed(3)}.`,
          "",
        );
      }

      // The one plane left on the surface, and the ground beside it.
      const sheet = page.locator(".brain-mail-sheet").first();
      const sheetBox = await sheet.boundingBox();
      if (sheetBox) {
        const sheetFill = await samplePixel(page, sheetBox.x + 6, sheetBox.y + 6);
        const beside = await samplePixel(
          page,
          Math.max(0, sheetBox.x - 14),
          sheetBox.y + 6,
        );
        lines.push(
          `Message sheet \`rgb(${sheetFill.map((c) => Math.round(c)).join(" ")})\` against the canvas beside it \`rgb(${beside.map((c) => Math.round(c)).join(" ")})\` — ΔL ${Math.abs(oklchLightness(sheetFill) - oklchLightness(beside)).toFixed(3)}.`,
          "",
        );
      }

      MEASURED.push(lines.join("\n"));
      if (scheme === "dark") {
        await fs.writeFile(
          path.join(OUT, "contrast.md"),
          [
            "# Mail v4 — measured on the stand",
            "",
            "Chromium, 1440×900, favicon proxy refused so every avatar falls",
            "back to its monogram. Contrast is WCAG on the painted canvas, not",
            "on a token value; ΔL is oklch lightness off the same pixels.",
            "",
            ...MEASURED,
          ].join("\n"),
          "utf8",
        );
      }
    });
  }

  // At 900 the column is the WHOLE pane — below `--breakpoint-panes` mail shows
  // one pane at a time — while the sidebar is still beside it with the page
  // tree in it. The head has one mode at every width now, so what this frame
  // reads is that mode on a column at its full width: the nav pill, the
  // toolbar pill on the same inset, and the rows running under both. The
  // phone's frame of the same head is `unified-mobile-*.png`.
  test("measure the column on one pane", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 900, height: 900 });
    await installUnifiedRoutes(page);
    await login(page);
    await setScheme(page, "light");
    await page.goto("/mail");
    const list = page.locator('[aria-label="All inboxes threads"]');
    await expect(list.getByText(UNIFIED_SEED[0]![2], { exact: true })).toBeVisible();

    // One control owns navigation at this width as at every other, the head
    // floats over the rows on the column's inset, and there is exactly one
    // "New message". The group's rules hold regardless.
    await expect(page.locator("select")).toHaveCount(0);
    await expect(navTrigger(page)).toHaveCount(1);
    const compose = page.getByRole("button", { name: "New message" });
    await expect(compose).toHaveCount(1);
    const pills = (await page.locator(".brain-mail-navrow").boundingBox())!;
    const column = (await page.locator(".brain-mail-list").boundingBox())!;
    expect(Math.abs(column.x + column.width - (pills.x + pills.width))).toBeLessThanOrEqual(
      12,
    );

    // The rows are full-bleed on the column — the selected band has to be
    // able to reach the edge it points at — and the boundary rule is the one
    // thing standing on the column's inset.
    const rows = (await page.locator(".brain-mail-rows").first().boundingBox())!;
    const columnBox = (await page.locator(".brain-mail-list").boundingBox())!;
    expect(Math.abs(rows.x - columnBox.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(columnBox.x + columnBox.width - (rows.x + rows.width)),
    ).toBeLessThanOrEqual(1);
    const boundary = await page
      .locator("section.brain-mail-section")
      .nth(1)
      .evaluate((node) => {
        const style = getComputedStyle(node, "::before");
        return { left: style.left, right: style.right, height: style.height };
      });
    expect(boundary.height).toBe("1px");
    expect(boundary.left).toBe("12px");
    expect(boundary.right).toBe("12px");

    // The section label starts on the senders' left rule.
    const label = (await page
      .locator(".brain-mail-section-head .text-label")
      .first()
      .boundingBox())!;
    const sender = (await page
      .locator(".brain-mail-body .font-semibold")
      .first()
      .boundingBox())!;
    expect(Math.abs(label.x - sender.x)).toBeLessThanOrEqual(1);

    await page.mouse.move(880, 880);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, "unified-900.png") });
  });
});

// ── Where three panes stop fitting (DESIGN.md §13) ──────────────────────────
// The pane switch used to sit on `md`, which promised a reader pane 104–236px
// wide between 768 and 1159: the action pill does not shrink, so it ran past
// the window and the subject beside it went to 0. Three frames, both themes —
// the breakpoint itself, one pixel under it, and 900, the width the owner was
// looking at when he asked for the mobile layout there.
for (const scheme of ["light", "dark"] as const) {
  test(`capture the pane switch — ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1160, height: 900 });
    await installMailRoutes(page);
    await login(page);
    await setScheme(page, scheme);
    await openMailbox(page);
    await page.getByText(THREADS[0].subject, { exact: true }).click();
    await expect(
      page.locator('iframe[title="Sanitized HTML message"]').first(),
    ).toBeVisible();
    // The pill has to be at its RESTING labels before the shutter: opening the
    // thread marks it read, and until that lands the first button says "Mark
    // read" — 15px narrower than the "Mark unread" the 277 is measured from.
    await expect(page.getByRole("button", { name: "Mark unread" })).toBeVisible();
    await page.mouse.move(1_140, 860);

    // 1160 — the column, the reader beside it, the pill on §4's 12 and a
    // subject that still says something.
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `panes-three-1160-${scheme}.png`) });

    // 1159 — one pixel under it: the reader takes the whole pane, inside the
    // ordinary desktop shell, with Back where the list used to be.
    await page.setViewportSize({ width: 1159, height: 900 });
    await expect(page.getByRole("button", { name: /^Back to / })).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `panes-one-1159-${scheme}.png`) });

    // 900 — the broken width. The pill's right edge used to measure 967.7 here.
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `panes-one-900-${scheme}.png`) });

    // 768 — the tablet that left the subject 103 and clipped the caption under
    // it. Below `--breakpoint-strip` the resting label is in the ⋯ menu and
    // the subject keeps 208 (see the token in globals.css).
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: frame("strip-768", scheme) });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(400);

    // and the column that owns the same pane once Back is pressed.
    await page.getByRole("button", { name: /^Back to / }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `panes-list-900-${scheme}.png`) });
  });
}

// ── One account ─────────────────────────────────────────────────────────────
// The first screen of a new user. A lone account opens into its own Inbox and
// its menu has no Accounts block: All inboxes over one inbox is a merge of
// nothing, and a block of one row is not a block (§13). MAIL_BEFORE=1 shoots
// the screen the previous commit had — the merge, and the two-row block.
for (const scheme of ["light", "dark"] as const) {
  test(`capture the lone account — ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installMailRoutes(page);
    await login(page);
    await setScheme(page, scheme);
    await page.goto("/mail");
    await expect(navTrigger(page)).toHaveCount(1);
    await expect(page.getByText(THREADS[0].subject, { exact: true })).toBeVisible();
    await page.mouse.move(1_100, 700);
    await page.waitForTimeout(600);
    await page.screenshot({ path: frame("single-inbox", scheme) });
    await openNav(page);
    await expect(page.locator(".brain-menu")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: frame("single-menu", scheme) });
  });
}

// ── The phone (390) ─────────────────────────────────────────────────────────
// The owner reads his mail on an iPhone, and that is where he found four
// things wrong with this branch. Below the panes breakpoint the mail surface
// IS the screen, so the frames that decide it are these: the list, a message
// open, the composer, and a notes page beside them — the surface whose chrome
// mail is supposed to match. The reader comes in a PAIR, at rest and
// scrolled, because §7's scroll edge is a thing that appears: one frame can
// show it drawn, only two can show it earning that.
//
// PHONE_BEFORE=1 writes the same set under `-before-` so a fix can be shown
// against the state it replaced. Run it on the commit BEFORE the fix.
test.describe("mail on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  const slot = (name: string, scheme: string) =>
    path.join(
      OUT,
      process.env.PHONE_BEFORE === "1"
        ? `phone-${name}-before-${scheme}.png`
        : `phone-${name}-${scheme}.png`,
    );

  for (const scheme of ["light", "dark"] as const) {
    test(`capture the phone artifacts — ${scheme}`, async ({ page }) => {
      test.setTimeout(180_000);
      await installMailRoutes(page);
      await login(page);
      await setScheme(page, scheme);

      // A notes page first, while the mail surface is not up: two levels, so
      // the crumb carries a parent and stays on screen — the slot mail's
      // title pill was competing with.
      const rootId = await makePage(page, { title: "Field Guide", icon: "🌿" });
      const childId = await makePage(page, {
        title: "Seed Orders",
        icon: "🌱",
        parentId: rootId,
      });
      await page.goto(`/p/${childId}`);
      await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
        "Seed Orders",
      );
      await page.waitForTimeout(700);
      await page.screenshot({ path: slot("notes", scheme) });

      // The list: the floating head, the rows, and the tab bar under them
      // with the last row scrolled clear of it.
      await page.goto("/mail");
      await openNav(page);
      await page
        .getByRole("menuitemradio", { name: `Open ${ACCOUNT.emailAddress}` })
        .click();
      await expect(page.getByText(THREADS[0].subject, { exact: true })).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({ path: slot("list", scheme) });

      // The reader AT REST — the frame the owner sent. Nothing has scrolled,
      // so the scroller's first pixel is still in view and §7 has no edge to
      // draw. The strip above it carries no fill any more, so the canvas runs
      // from the status bar to the message in one ramp.
      await page.getByText(THREADS[0].subject, { exact: true }).click();
      await expect(
        page.locator('iframe[title="Sanitized HTML message"]').first(),
      ).toBeVisible();
      await expect(page.locator('iframe[title="Sanitized HTML message"]')).toHaveCount(
        MESSAGES.length,
      );
      const reader = page.locator("[data-mail-reader-scroll]");
      await expect.poll(() => reader.evaluate((el) => el.scrollTop)).toBe(0);
      await page.waitForTimeout(700);
      await page.screenshot({ path: slot("reader", scheme) });

      // and the same reader scrolled, where the edge has something to stand
      // for: the first message's sender has left through the scroller's top,
      // and the fade is on the line it left by.
      await reader.evaluate((el) => el.scrollTo({ top: 260 }));
      await expect(page.locator("[data-mail-reader-scroll][data-scrolled]")).toHaveCount(1);
      await page.waitForTimeout(600);
      await page.screenshot({ path: slot("reader-scrolled", scheme) });

      // The composer, keyboard down: the sheet, its paper fields, and the
      // room left under it.
      await page.getByRole("button", { name: /^Back to / }).click();
      await page.getByRole("button", { name: "New message" }).click();
      const sheet = page.locator(".brain-composer-sheet");
      await expect(sheet).toBeVisible();
      // The save stamp is `sm:flex` — below 640 the sheet does not draw it, so
      // the autosave is waited for on the wire instead of on a label.
      await Promise.all([
        page.waitForResponse(
          (response) =>
            /\/api\/mail\/drafts/.test(response.url()) &&
            response.request().method() !== "GET",
        ),
        sheet.getByPlaceholder("Subject").fill("Re: the stairwell quotes"),
      ]);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(600);
      await page.screenshot({ path: slot("composer", scheme) });
    });
  }
});

// ── The tab bar, above 390 and inside a sheet ───────────────────────────────
// Every frame in this PR was shot at 390 and the complaint came off a 440pt
// phone, so the width the owner actually holds had never been looked at. 430
// and 440 are the two that ship above it. The bar is `fit-content`, so above
// 324 it stops growing at its 308 and only the air either side changes — the
// question those frames answer is not whether it fits but whether 66px of
// canvas on each side reads as an object standing on the screen or as a
// control that has come loose from it.
//
// `[data-contained]` changed with it and had no frame at all: inside the Pages
// sheet and the search view the same bar is a plain row at the foot of that
// surface, so `fit-content` centres it in a modal instead of in the window.
//
// The block also writes `docs/design/mail/tabbar.md` — the label widths, the
// track width at each of four viewports and the gap between every adjacent
// pair of words — because §4's derivation is the whole defence of the change
// and it should be checkable against the DOM rather than against a sentence.
test.describe("the mobile tab bar", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  /** The bar's own geometry at one viewport: what the grid resolved to, what
   *  each word measures, and the gap between two words that stand side by
   *  side. Two labels centred in equal tracks leave `track - (w1 + w2) / 2`
   *  between them, so the pair to watch is the widest one, not the widest
   *  single word. */
  const measure = (page: Page) =>
    page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(
        ".brain-mobile-tabbar:not([data-contained]):not([data-hidden])",
      );
      const items = bar?.querySelector<HTMLElement>(".brain-mobile-tabbar-items");
      if (!bar || !items) throw new Error("no floating tab bar on this screen");
      const tracks = getComputedStyle(items)
        .gridTemplateColumns.split(" ")
        .map((value) => Number.parseFloat(value));
      const labels = Array.from(
        items.querySelectorAll<HTMLElement>(".brain-mobile-tab"),
      ).map((tab) => {
        const span = tab.querySelector("span:not(.brain-mobile-tab-new)");
        const box = span?.getBoundingClientRect();
        return {
          key: tab.dataset.mobileTab ?? "?",
          text: span?.textContent ?? "",
          width: box ? Math.round(box.width * 10) / 10 : null,
          left: box ? box.left : null,
          right: box ? box.right : null,
        };
      });
      const gaps: { pair: string; gap: number }[] = [];
      for (let i = 0; i < labels.length - 1; i += 1) {
        const a = labels[i];
        const b = labels[i + 1];
        if (a.right == null || b.left == null) continue;
        gaps.push({
          pair: `${a.text} → ${b.text}`,
          gap: Math.round((b.left - a.right) * 10) / 10,
        });
      }
      const box = bar.getBoundingClientRect();
      // How much of the canvas the bar leaves showing beside it: the page's
      // own text runs to the window's edge (§7 gives the canvas no band), so
      // whatever sits between the paragraph rule and the capsule is read.
      const para = document.querySelector(".brain-main p");
      const paraLeft = para?.getBoundingClientRect().left ?? null;
      return {
        window: window.innerWidth,
        barWidth: Math.round(box.width * 10) / 10,
        clearLeft: Math.round(box.left * 10) / 10,
        clearRight: Math.round((window.innerWidth - box.right) * 10) / 10,
        track: Math.round(tracks[0] * 100) / 100,
        exposed: paraLeft == null ? null : Math.round((box.left - paraLeft) * 10) / 10,
        labels,
        gaps,
      };
    });

  test("capture the tab bar above 390, contained, and its measurements", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await installMailRoutes(page);
    await login(page);

    const rootId = await makePage(page, { title: "Field Guide", icon: "🌿" });
    const childId = await makePage(page, {
      title: "Seed Orders",
      icon: "🌱",
      parentId: rootId,
    });

    const readings: Awaited<ReturnType<typeof measure>>[] = [];

    for (const scheme of ["light", "dark"] as const) {
      await setScheme(page, scheme);

      // 430 and 440 — the widths above the one every other frame was shot at
      // — and 767, the last width before the bar is display:none and the
      // sidebar takes over, where a 308 capsule has the most air it will ever
      // have. A notes page, because that is the surface the bar spends its
      // life on and the one where the canvas runs beside it.
      for (const width of [430, 440, 767] as const) {
        await page.setViewportSize({ width, height: 932 });
        await page.goto(`/p/${childId}`);
        await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
          "Seed Orders",
        );
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(OUT, `tabbar-${width}-${scheme}.png`) });
        if (scheme === "light") readings.push(await measure(page));
      }

      // Contained, at the width the rest of the set uses. The Pages sheet
      // first: the bar is in flow at the foot of a modal surface, so it takes
      // that surface's width and not the window's.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/p/${childId}`);
      await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
        "Seed Orders",
      );
      await page.locator('[data-mobile-tab="pages"]').click();
      await expect(
        page.locator(".brain-mobile-tabbar[data-contained]"),
      ).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({
        path: path.join(OUT, `tabbar-contained-pages-${scheme}.png`),
      });

      // and the search view, the other host. Escape leaves the sheet first so
      // the palette opens over the page rather than over the sheet.
      await page.keyboard.press("Escape");
      await expect(
        page.locator(".brain-mobile-tabbar[data-contained]"),
      ).toHaveCount(0);
      await page.locator('[data-mobile-tab="search"]').click();
      await expect(page.locator(".brain-palette-mobile")).toBeVisible();
      await expect(
        page.locator(".brain-mobile-tabbar[data-contained]"),
      ).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({
        path: path.join(OUT, `tabbar-contained-search-${scheme}.png`),
      });
      await page.keyboard.press("Escape");
    }

    // 390 (the width the rest of the set was shot at) and the two narrow
    // ends: 320 is the narrowest phone still in the field, and 244 is where
    // the tracks reach their 44px floor and the bar stops giving ground.
    for (const width of [390, 320, 244] as const) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/p/${childId}`);
      await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
        "Seed Orders",
      );
      await page.waitForTimeout(500);
      readings.push(await measure(page));
    }

    readings.sort((a, b) => a.window - b.window);
    const rows = readings
      .map(
        (r) =>
          `| ${r.window} | ${r.barWidth} | ${r.track} | ${r.clearLeft} | ${r.clearRight} | ${r.exposed ?? "—"} |`,
      )
      .join("\n");
    const at390 = readings.find((r) => r.window === 390);
    const labels = (at390?.labels ?? [])
      .filter((l) => l.width != null)
      .map((l) => `| ${l.text} | ${l.width} |`)
      .join("\n");
    const gaps = (at390?.gaps ?? [])
      .map((g) => `| ${g.pair} | ${g.gap} |`)
      .join("\n");

    await fs.writeFile(
      path.join(OUT, "tabbar.md"),
      `# Mobile tab bar — measured

Written by \`e2e/mail-shots.spec.ts\` (\`MAIL_SHOTS=1\`), Chromium on the SF
stack, light scheme. DESIGN.md §4 states the derivation; this is the DOM.

\`--tabbar-slot\` is 60 and the grid is \`repeat(5, minmax(44px, var(--tabbar-slot)))\`
inside \`padding: 0 4px\`, between two 8px insets, \`width: fit-content\` with
\`margin-inline: auto\`.

## Per viewport

| window | bar | track | clear left | clear right | canvas beside |
|---:|---:|---:|---:|---:|---:|
${rows}

Above 324 the bar is at its max-content 308 and only the air changes. Below
it the window sets the width: \`(window - 8 - 8 - 4 - 4) / 5\`. The tracks
reach their 44px floor at 244, and below that the bar is wider than the space
between the insets and centres back through them.

\`canvas beside\` is the gap between a notes paragraph's left rule and the
capsule's left edge — the strip of page text the bar leaves showing on each
side, which the full-width bar used to cover. Negative means the bar is still
wider than the text rule and covers the paragraph outright, which is the case
at 320 and below. See DESIGN.md §4, third bullet.

## Labels at 390 (Label 11/500)

| label | width |
|---|---:|
${labels}

The New slot carries no word — it is the 34px accent circle — so the words
that stand side by side are Home↔Search and Pages↔Mail.

## Gap between adjacent words at 390

Two labels centred in equal tracks leave \`track - (w1 + w2) / 2\` between
them.

| pair | gap |
|---|---:|
${gaps}
`,
      "utf8",
    );
  });
});

// ── One control instead of a rail (DESIGN.md §13) ───────────────────────────
// The rail is gone and the head has one mode, which moves four numbers into
// territory nobody had measured. Each test below takes one of them off the
// real render rather than off the CSS, and writes what it read to
// docs/design/mail/nav.md beside the frames.
const NAV_NOTES: string[] = [];

/** The worst 1px vertical step down a strip, read per column and over the
 *  columns that carry no text — a gradient's failure is a line ACROSS the
 *  band, and one probe column can sit on the only place it does not show.
 *  Which columns are quiet is decided by the same strip with the band's own
 *  layers suppressed, so the answer is the band's and not the picture's. */
type RawStrip = {
  readonly data: Buffer;
  readonly info: { readonly width: number; readonly height: number; readonly channels: number };
};

function worstStep(quiet: RawStrip, banded: RawStrip, quietCeiling = 3) {
  const at = (
    frame: RawStrip,
    x: number,
    y: number,
  ) => {
    const i = (y * frame.info.width + x) * frame.info.channels;
    return [frame.data[i]!, frame.data[i + 1]!, frame.data[i + 2]!];
  };
  const step = (
    frame: RawStrip,
    x: number,
    y: number,
  ) =>
    Math.max(
      ...[0, 1, 2].map((c) =>
        Math.abs(at(frame, x, y - 1)[c]! - at(frame, x, y)[c]!),
      ),
    );

  const columns: number[] = [];
  for (let x = 0; x < quiet.info.width; x += 1) {
    let worst = 0;
    for (let y = 1; y < quiet.info.height; y += 1) {
      worst = Math.max(worst, step(quiet, x, y));
    }
    if (worst <= quietCeiling) columns.push(x);
  }

  let worst = 0;
  let worstAt = [0, 0];
  for (const x of columns) {
    for (let y = 1; y < banded.info.height; y += 1) {
      const value = step(banded, x, y);
      if (value > worst) {
        worst = value;
        worstAt = [x, y];
      }
    }
  }

  return { worst, worstAt, columns: columns.length, quietCeiling };
}

/** The worst 1px step down every column of a strip. Only honest where the
 *  strip carries nothing but the gradient — see the flat-plate frame below. */
function worstStepEverywhere(frame: RawStrip) {
  const at = (x: number, y: number) => {
    const i = (y * frame.info.width + x) * frame.info.channels;
    return [frame.data[i]!, frame.data[i + 1]!, frame.data[i + 2]!];
  };
  let worst = 0;
  let worstAt = [0, 0];
  for (let x = 0; x < frame.info.width; x += 1) {
    for (let y = 1; y < frame.info.height; y += 1) {
      const value = Math.max(
        ...[0, 1, 2].map((c) => Math.abs(at(x, y - 1)[c]! - at(x, y)[c]!)),
      );
      if (value > worst) {
        worst = value;
        worstAt = [x, y];
      }
    }
  }
  return { worst, worstAt };
}

async function rawStrip(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
) {
  const shot = await page.screenshot({ clip });
  return sharp(shot).raw().toBuffer({ resolveWithObject: true });
}

test.describe("mail nav measurements", () => {
  /* RISK 1 — the 120px band. §7's formula is chrome + inset + 28, and it has
     never been asked for a two-row chrome: 80 + 12 + 28 = 120, the longest
     gradient in the product. What matters is not the average slope but the
     worst single-pixel step down it, walked column by column. */
  for (const scheme of ["light", "dark"] as const) {
    test(`measure the two-row scroll edge — ${scheme}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await installMailRoutes(page);
      await login(page);
      await setScheme(page, scheme);
      await openMailbox(page);

      const geometry = await page.evaluate(() => {
        const list = document.querySelector(".brain-mail-list") as HTMLElement;
        const scroll = document.querySelector(
          ".brain-mail-scroll",
        ) as HTMLElement;
        const edge = scroll.querySelector(
          ".edge:not([data-position='bottom'])",
        ) as HTMLElement;
        const pad = document.querySelector(
          ".brain-mail-scrollpad",
        ) as HTMLElement;
        scroll.scrollTop = 400;
        const box = list.getBoundingClientRect();
        return {
          rows: list.getAttribute("data-chrome-rows"),
          chrome: getComputedStyle(list).getPropertyValue("--mail-chrome").trim(),
          edgeHeight: edge.getBoundingClientRect().height,
          steps: edge.getAttribute("data-steps"),
          padTop: getComputedStyle(pad).paddingTop,
          scrollable: scroll.scrollHeight > scroll.clientHeight,
          left: box.left,
          top: box.top,
          width: box.width,
        };
      });
      expect(geometry.scrollable).toBe(true);
      await page.waitForTimeout(400);
      await expect(page.locator(".brain-mail-scroll[data-scrolled]")).toHaveCount(1);

      const clip = {
        x: Math.round(geometry.left),
        y: Math.round(geometry.top),
        width: Math.round(geometry.width),
        height: Math.round(geometry.edgeHeight) + 20,
      };
      // the same pixels with the band's own layers off, so the columns that
      // carry text can be told from the ones that carry only the gradient
      const suppress = await page.addStyleTag({
        content: ".brain-mail-scroll > .edge > i { opacity: 0 !important }",
      });
      await page.waitForTimeout(250);
      const quiet = await rawStrip(page, clip);
      await suppress.evaluate((node: Element) => node.remove());
      await page.waitForTimeout(400);
      const banded = await rawStrip(page, clip);

      const walk = worstStep(quiet, banded);

      /* The band over a FLAT PLATE. Reading the composite tells you what a
         reader sees but leaves the gradient's own shape mixed with the rows'
         vertical contrast and the head's own edges, and only ~20 columns are
         clear of both. So the rows and the head are hidden and the scroller
         painted one colour: what is left in the strip is the dissolve and
         nothing else, and every column can be walked. Suppressing the band's
         opacity does NOT do this — the layer also blurs what is behind it, so
         the difference of the two frames is the text's edges, not the
         gradient's. */
      const plate = await page.addStyleTag({
        content: [
          ".brain-mail-scroll { background: oklch(0.55 0 0) }",
          ".brain-mail-scrollpad > * { visibility: hidden }",
          ".brain-mail-head { visibility: hidden }",
        ].join("\n"),
      });
      await page.waitForTimeout(300);
      const flat = await rawStrip(page, clip);
      const plateWalk = worstStepEverywhere(flat);
      await plate.evaluate((node: Element) => node.remove());
      await page.waitForTimeout(300);

      NAV_NOTES.push(
        [
          `### Scroll edge, two-row head — ${scheme}`,
          "",
          `- \`data-chrome-rows\` **${geometry.rows}**, \`--mail-chrome\` **${geometry.chrome}**, scroll pad **${geometry.padTop}**`,
          `- band height **${geometry.edgeHeight}px** (§7: chrome + inset + 28), \`steps=${geometry.steps}\``,
          `- quiet columns walked (vertical step ≤ ${walk.quietCeiling}/255 with the band off): **${walk.columns}** of ${clip.width}`,
          `- **worst 1px step on the render: ${walk.worst}/255**, at column ${walk.worstAt[0]}, row ${walk.worstAt[1]} of the strip`,
          `- **worst 1px step of the dissolve alone, over a flat plate, all ${clip.width} columns: ${plateWalk.worst}/255**, at column ${plateWalk.worstAt[0]}, row ${plateWalk.worstAt[1]}`,
          "",
        ].join("\n"),
      );
      await page.screenshot({
        path: path.join(OUT, `nav-edge-${scheme}.png`),
        clip,
      });
    });
  }

  /* RISK 3 — 768 to 1159: one pane, but the ordinary desktop shell. The band
     is new on this branch and the least measured, and the column runs the
     whole pane there with a two-row head over it. What would show is a ragged
     right edge: §4 wants every right edge in the column on one inset. */
  test("measure the right edge from 768 to 1159", async ({ page }) => {
    test.setTimeout(180_000);
    await installMailRoutes(page);
    await login(page);
    await setScheme(page, "light");
    await page.setViewportSize({ width: 1024, height: 900 });
    await openMailbox(page);

    const lines = [
      "### Right edges, one pane inside the desktop shell",
      "",
      "| width | column | nav pill | toolbar pill | search | row capsule | spread |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ];
    let worstSpread = 0;
    for (const width of [768, 820, 900, 1024, 1100, 1159]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const edges = await page.evaluate(() => {
        const right = (node: Element | null) =>
          node === null ? null : node.getBoundingClientRect().right;
        return {
          column: right(document.querySelector(".brain-mail-list")),
          nav: right(document.querySelector(".brain-mail-navrow > *:first-child")),
          toolbar: right(
            document.querySelector(".brain-mail-navrow > *:last-child"),
          ),
          search: right(document.querySelector(".brain-mail-search")),
          row: right(document.querySelector(".brain-mail-row")),
        };
      });
      const rights = [edges.toolbar, edges.search, edges.row]
        .filter((value): value is number => value !== null)
        .map((value) => (edges.column ?? 0) - value);
      const spread = Math.max(...rights) - Math.min(...rights);
      worstSpread = Math.max(worstSpread, spread);
      lines.push(
        `| ${width} | ${edges.column?.toFixed(1)} | ${edges.nav?.toFixed(1)} | ${edges.toolbar?.toFixed(1)} | ${edges.search?.toFixed(1)} | ${edges.row?.toFixed(1)} | ${spread.toFixed(2)} |`,
      );
      // no horizontal overflow at any of them
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `horizontal overflow at ${width}`).toBeLessThanOrEqual(0);
      if (width === 900 || width === 768) {
        await page.screenshot({ path: path.join(OUT, `nav-pane-${width}.png`) });
      }
    }
    lines.push(
      "",
      `Worst spread between the column's right edges across the band: **${worstSpread.toFixed(2)}px**.`,
      "",
    );
    NAV_NOTES.push(lines.join("\n"));
  });

  /* RISK 4 — two tail marks on one row. The Inbox row carries the unread
     count AND the check, 6px apart on the mock. On the real render the check
     is a bare 14 glyph, not a chip, so what matters is the ink between the
     chip's edge and the first stroke of the check. */
  for (const scheme of ["light", "dark"] as const) {
    test(`measure the Inbox row's two tail marks — ${scheme}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await installMailRoutes(page);
      await login(page);
      await setScheme(page, scheme);
      await openMailbox(page);
      await openNav(page);
      const menu = page.locator(".brain-menu");
      await expect(menu).toBeVisible();
      await page.waitForTimeout(400);

      const tail = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[role="menuitemradio"]')];
        const inbox = rows.find(
          (row) => row.querySelector("span")?.textContent?.trim() === "Inbox",
        );
        if (!inbox) return null;
        const count = inbox.querySelector(".tree-row-count");
        const check = inbox.querySelector("svg:last-of-type");
        const label = inbox.querySelector("span");
        const box = (node: Element | null | undefined) =>
          node ? node.getBoundingClientRect() : null;
        const c = box(count);
        const k = box(check);
        return {
          count: count?.textContent ?? null,
          countRight: c?.right ?? null,
          checkLeft: k?.left ?? null,
          checkWidth: k?.width ?? null,
          gap: c && k ? k.left - c.right : null,
          rowRight: inbox.getBoundingClientRect().right,
          checkRight: k?.right ?? null,
          labelRight: box(label)?.right ?? null,
          menuWidth: (
            inbox.closest(".brain-menu") as HTMLElement
          ).getBoundingClientRect().width,
        };
      });
      expect(tail).not.toBeNull();
      NAV_NOTES.push(
        [
          `### Inbox row, count beside the bare check — ${scheme}`,
          "",
          `- menu **${tail!.menuWidth}px** wide`,
          `- count chip \`${tail!.count}\`, right edge ${tail!.countRight?.toFixed(1)}`,
          `- check glyph ${tail!.checkWidth}px, left edge ${tail!.checkLeft?.toFixed(1)}`,
          `- **gap between the two marks: ${tail!.gap?.toFixed(1)}px**`,
          `- check to the row's right edge: ${(tail!.rowRight - (tail!.checkRight ?? 0)).toFixed(1)}px`,
          "",
        ].join("\n"),
      );
      await menu.screenshot({ path: path.join(OUT, `nav-menu-${scheme}.png`) });
    });
  }

  /* RISK on the ceiling — §7 allows 8 backdrop layers and this head sits on
     8 with the menu open. Counted on the surface that has the most of them:
     one account (so there IS a search capsule), a thread open (so the reader
     wears its pill), and the nav menu up. */
  test("count the backdrop layers with the menu open", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installMailRoutes(page);
    await login(page);
    await setScheme(page, "light");
    await openMailbox(page);
    await page.getByText(THREADS[0].subject, { exact: true }).click();
    await expect(
      page.locator('iframe[title="Sanitized HTML message"]').first(),
    ).toBeVisible();
    await openNav(page);
    await expect(page.locator(".brain-menu")).toBeVisible();
    await page.waitForTimeout(400);

    const layers = await page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .filter((node) => {
          const style = getComputedStyle(node);
          return (
            style.backdropFilter !== "none" &&
            style.backdropFilter !== "" &&
            node.getClientRects().length > 0
          );
        })
        .map(
          (node) => String(node.className).split(" ")[0] || node.tagName.toLowerCase(),
        ),
    );
    NAV_NOTES.push(
      [
        "### Backdrop budget, single account, reader open, menu open",
        "",
        `- **${layers.length} layers** (§7's ceiling is 8)`,
        `- ${layers.join(", ")}`,
        "",
      ].join("\n"),
    );
    expect(layers.length).toBeLessThanOrEqual(8);
    await page.screenshot({ path: path.join(OUT, "nav-menu-open-1440.png") });
  });

  /* THE MENU HAS TO FIT THE WINDOW, OR IT IS NOT A WAY OUT. Fourteen rows is
     534px, and this is the only control that leaves an account — the rail
     took the second one with it. A phone in landscape is 390 tall, an iPad
     split view and a short laptop window are no taller, and there the
     Accounts block is off screen. Measured at the two viewports Maya found
     it at, by pointer and by keyboard both: a row that can be scrolled to
     but not tabbed to is still a row a keyboard reader cannot reach. */
  for (const viewport of [
    { name: "1024x420", width: 1024, height: 420 },
    { name: "844x390", width: 844, height: 390 },
  ] as const) {
    test(`measure the menu against a short window — ${viewport.name}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await installMailRoutes(page);
      await login(page);
      await setScheme(page, "light");
      await openMailbox(page);
      await openNav(page);
      await expect(page.locator(".brain-menu")).toBeVisible();
      await page.waitForTimeout(400);

      const fit = await page.evaluate(() => {
        const content = document.querySelector(".brain-menu") as HTMLElement;
        const rows = [
          ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
        ];
        const scroller = [content, ...content.querySelectorAll("*")].find(
          (node) =>
            node instanceof HTMLElement &&
            node.scrollHeight > node.clientHeight + 1 &&
            /auto|scroll/.test(getComputedStyle(node).overflowY),
        ) as HTMLElement | undefined;
        const box = content.getBoundingClientRect();
        const offscreen = rows.filter((row) => {
          const r = row.getBoundingClientRect();
          return r.bottom > window.innerHeight + 0.5 || r.top < -0.5;
        });
        return {
          menu: [Math.round(box.width), Math.round(box.height)],
          viewport: [window.innerWidth, window.innerHeight],
          rows: rows.length,
          overflowsWindow: Math.round(box.bottom - window.innerHeight),
          scroller: scroller
            ? {
                cls: String(scroller.className).split(" ")[0] || "content",
                client: Math.round(scroller.clientHeight),
                scroll: Math.round(scroller.scrollHeight),
              }
            : null,
          offscreen: offscreen.map(
            (row) => row.querySelector("span")?.textContent?.trim() ?? "",
          ),
          availableHeight: getComputedStyle(content)
            .getPropertyValue("--radix-dropdown-menu-content-available-height")
            .trim(),
        };
      });

      // The keyboard walk: Down until it stops moving, then read where it
      // stopped and whether that row is on screen. A row focus can reach but
      // the window cannot show is worse than one it cannot reach at all.
      let lastFocus = "";
      for (let press = 0; press < 24; press += 1) {
        await page.keyboard.press("ArrowDown");
        lastFocus = await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return active?.querySelector("span")?.textContent?.trim() ?? "";
        });
      }
      const focusVisible = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active) return null;
        const r = active.getBoundingClientRect();
        return r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5;
      });

      // And by pointer: roll the scroller to its end and look for the last
      // row — the address, which is the only way out of this account.
      const byPointer = await page.evaluate(() => {
        const content = document.querySelector(".brain-menu") as HTMLElement;
        const scroller = [content, ...content.querySelectorAll("*")].find(
          (node) =>
            node instanceof HTMLElement &&
            node.scrollHeight > node.clientHeight + 1 &&
            /auto|scroll/.test(getComputedStyle(node).overflowY),
        ) as HTMLElement | undefined;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        const rows = [
          ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
        ];
        const last = rows[rows.length - 1];
        if (!last) return null;
        const r = last.getBoundingClientRect();
        return {
          label: last.querySelector("span")?.textContent?.trim() ?? "",
          onScreen: r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5,
        };
      });

      // The menu is a way out of an account or it is not a control. Both
      // routes to the last row have to land on screen.
      expect(fit.overflowsWindow, "the menu runs past the window").toBeLessThanOrEqual(0);
      expect(fit.scroller, "the menu has nothing to scroll").not.toBeNull();
      expect(byPointer?.onScreen, "the last row is off screen by pointer").toBe(true);
      expect(focusVisible, "the keyboard leaves focus off screen").toBe(true);
      expect(lastFocus, "the keyboard cannot reach the last row").toBe(
        byPointer?.label,
      );

      NAV_NOTES.push(
        [
          `### The menu in a ${viewport.width}x${viewport.height} window`,
          "",
          `- menu **${fit.menu[0]}x${fit.menu[1]}**, window ${fit.viewport[0]}x${fit.viewport[1]}, ${fit.rows} rows`,
          `- \`--radix-dropdown-menu-content-available-height\`: **${fit.availableHeight || "(not consumed)"}**`,
          `- past the window's foot: **${fit.overflowsWindow}px**`,
          `- scroller: ${fit.scroller ? `\`.${fit.scroller.cls}\` ${fit.scroller.client} of ${fit.scroller.scroll}` : "**none**"}`,
          `- rows below the fold at rest: **${fit.offscreen.length}**${fit.offscreen.length > 0 ? ` — ${fit.offscreen.join(", ")}` : ""}`,
          `- rolled to the end, the last row (**${byPointer?.label}**) is on screen: **${byPointer?.onScreen}**`,
          `- after 24 × Down, focus is on **${lastFocus || "(nothing)"}**, on screen: **${focusVisible}**`,
          "",
        ].join("\n"),
      );
      await page.screenshot({
        path: path.join(OUT, `nav-menu-short-${viewport.name}.png`),
      });
    });
  }

  test.afterAll(async () => {
    if (NAV_NOTES.length === 0) return;
    await fs.writeFile(
      path.join(OUT, "nav.md"),
      [
        "# Mail nav — one control instead of a rail",
        "",
        "Measured on the stand (`MAIL_SHOTS=1 pnpm exec playwright test e2e/mail-shots.spec.ts`).",
        "Frames beside this file: `nav-edge-*.png`, `nav-menu-*.png`,",
        "`nav-pane-*.png`, `nav-unified-menu.png`, `nav-menu-open-1440.png`.",
        "",
        ...NAV_NOTES,
      ].join("\n"),
      "utf8",
    );
  });

  /* The merged mode keeps the numbers it had: one row, 36 of chrome, the same
     76 band the rail-visible column used to draw. Nothing moves there, and
     that is worth reading off the render rather than asserting from memory. */
  test("measure the one-row head in the merged mode", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installUnifiedRoutes(page);
    await login(page);
    await setScheme(page, "light");
    await page.goto("/mail");
    const list = page.locator('[aria-label="All inboxes threads"]');
    await expect(list.getByText(UNIFIED_SEED[0]![2], { exact: true })).toBeVisible();

    const geometry = await page.evaluate(() => {
      const column = document.querySelector(".brain-mail-list") as HTMLElement;
      const scroll = document.querySelector(".brain-mail-scroll") as HTMLElement;
      const edge = scroll.querySelector(
        ".edge:not([data-position='bottom'])",
      ) as HTMLElement;
      const pad = document.querySelector(".brain-mail-scrollpad") as HTMLElement;
      return {
        rows: column.getAttribute("data-chrome-rows"),
        chrome: getComputedStyle(column).getPropertyValue("--mail-chrome").trim(),
        edgeHeight: edge.getBoundingClientRect().height,
        padTop: getComputedStyle(pad).paddingTop,
        search: document.querySelector(".brain-mail-search") === null,
        compose: document.querySelectorAll('[aria-label="New message"]').length,
      };
    });
    expect(geometry.rows).toBe("1");
    expect(geometry.search).toBe(true);
    expect(geometry.compose).toBe(1);

    // Every backdrop layer on the surface with the menu open — §7's ceiling
    // is 8, and this head is at it.
    await openNav(page);
    await expect(page.locator(".brain-menu")).toBeVisible();
    await page.waitForTimeout(400);
    const layers = await page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .filter((node) => {
          const style = getComputedStyle(node);
          return (
            style.backdropFilter !== "none" &&
            style.backdropFilter !== "" &&
            node.getClientRects().length > 0
          );
        })
        .map((node) => String(node.className).split(" ")[0] || node.tagName),
    );
    NAV_NOTES.push(
      [
        "### Merged mode, one-row head",
        "",
        `- \`data-chrome-rows\` **${geometry.rows}**, \`--mail-chrome\` **${geometry.chrome}**, scroll pad **${geometry.padTop}**`,
        `- band height **${geometry.edgeHeight}px** — the number the rail-visible column already drew`,
        `- backdrop layers with the menu open: **${layers.length}** — ${layers.join(", ")}`,
        "",
      ].join("\n"),
    );
    await page.screenshot({ path: path.join(OUT, "nav-unified-menu.png") });
  });
});
