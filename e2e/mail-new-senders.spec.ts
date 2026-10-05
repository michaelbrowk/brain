// New senders in the browser: a first letter from a stranger waits first in
// the column, and one decision sends it to its section or out of the inbox.
// The mail service is played by route handlers that keep the decisions the
// way the service does, so a list read after a decision answers as it would.
//
// NEW_SENDERS_SHOTS_DIR=<dir> also shoots the section, the reader, the toast
// and Settings, light and dark, desktop and phone, into that directory. It is
// a local review artifact and never lands in the repository.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "playwright/test";

const capabilities = {
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

const home = {
  accountId: `account-a${"1".repeat(32)}`,
  emailAddress: "home@example.test",
  displayName: "Home",
  status: "connected",
  connectedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerKind: "gmail",
  capabilities,
} as const;

const work = {
  ...home,
  accountId: `account-a${"2".repeat(32)}`,
  emailAddress: "work@example.org",
  displayName: null,
} as const;

type Sender = { readonly name: string; readonly address: string };

type Letter = {
  readonly accountId: string;
  readonly threadId: string;
  readonly from: Sender;
  readonly subject: string;
  readonly body: string;
  readonly minutesAgo: number;
  readonly category: "people" | "notification" | "newsletter";
  readonly unread: boolean;
  /** A first letter from a stranger, gated until it is decided on. */
  readonly stranger: boolean;
};

const lena = { name: "Lena Okafor", address: "lena@okafor.example" };
const mia = { name: "Mia Aalto", address: "mia@aalto.example" };
const studio = { name: "Studio Aalto", address: "studio@aalto.example" };
const growth = { name: "Growth Weekly", address: "hello@growthly.example" };

const LETTERS: readonly Letter[] = [
  {
    accountId: home.accountId,
    threadId: "lena-lisbon",
    from: lena,
    subject: "Flat in Lisbon, 12 to 19 October",
    body: "Priya gave me your address and said you were looking for somewhere in Lisbon from the 12th to the 19th. The flat is free those dates.",
    minutesAgo: 12,
    category: "people",
    unread: true,
    stranger: true,
  },
  {
    accountId: home.accountId,
    threadId: "mia-kiln",
    from: mia,
    subject: "Kiln share, spring places",
    body: "Two shelves are free from March. Visits on Saturday mornings.",
    minutesAgo: 40,
    category: "people",
    unread: true,
    stranger: true,
  },
  {
    accountId: work.accountId,
    threadId: "studio-open",
    from: studio,
    subject: "Open studio, Saturday 11:00",
    body: "We open the studio on Saturday. Bring whoever you like.",
    minutesAgo: 55,
    category: "people",
    unread: true,
    stranger: true,
  },
  {
    accountId: work.accountId,
    threadId: "growth-hacks",
    from: growth,
    subject: "10 inbox hacks you need to try",
    body: "Number seven will surprise you.",
    minutesAgo: 70,
    category: "people",
    unread: true,
    stranger: true,
  },
  {
    accountId: home.accountId,
    threadId: "tomas-shelf",
    from: { name: "Tomas Lindqvist", address: "tomas@lindqvist.example" },
    subject: "The bookshelf is yours if you want it",
    body: "Oak, two metres, needs two people and a van.",
    minutesAgo: 90,
    category: "people",
    unread: true,
    stranger: false,
  },
  {
    accountId: work.accountId,
    threadId: "priya-notes",
    from: { name: "Priya Raman", address: "priya@raman.example" },
    subject: "Notes before Thursday",
    body: "Three questions on the onboarding flow, nothing that blocks the review.",
    minutesAgo: 120,
    category: "people",
    unread: true,
    stranger: false,
  },
  {
    accountId: home.accountId,
    threadId: "parcel-today",
    from: { name: "Parcel", address: "track@parcel.example" },
    subject: "Your parcel arrives today between 12:00 and 14:00",
    body: "No signature needed.",
    minutesAgo: 150,
    category: "notification",
    unread: true,
    stranger: false,
  },
];

type Decision = {
  readonly decisionId: string;
  readonly key: string;
  readonly scope: "address" | "domain";
  readonly decision: "accept" | "block";
  readonly decidedAt: number;
};

/** The service, as far as this spec needs it: which letters wait, which are
 *  archived by a block, and what an Undo puts back. */
class World {
  decisions: Decision[] = [];
  read = new Set<string>();
  posted: unknown[] = [];
  deleted: string[] = [];
  screenOn = true;
  private next = 1;

  private standing(from: Sender): Decision | undefined {
    const address = from.address.toLowerCase();
    const domain = address.slice(address.lastIndexOf("@") + 1);
    return (
      this.decisions.find((each) => each.scope === "address" && each.key === address) ??
      this.decisions.find((each) => each.scope === "domain" && each.key === domain)
    );
  }

  items(accountId: string) {
    return LETTERS.filter((letter) => letter.accountId === accountId)
      .filter((letter) => !letter.stranger || this.standing(letter.from)?.decision !== "block")
      .map((letter) => this.item(letter));
  }

  item(letter: Letter) {
    const waits = this.screenOn && letter.stranger && this.standing(letter.from) === undefined;
    return {
      accountId: letter.accountId,
      threadId: letter.threadId,
      subject: letter.subject,
      participants: [letter.from],
      snippet: letter.body,
      lastMessageAt: Date.now() - letter.minutesAgo * 60_000,
      messageCount: 1,
      unread: letter.unread && !this.read.has(letter.threadId),
      starred: false,
      hasAttachments: false,
      listMessage: letter.category !== "people",
      sizeBytes: 2_048,
      category: letter.category,
      newSender: waits,
      ...(waits ? { newSenderFrom: letter.from } : {}),
    };
  }

  decide(input: { address: string; scope: "address" | "domain"; decision: "accept" | "block" }) {
    this.posted.push(input);
    const address = input.address.toLowerCase();
    const key = input.scope === "domain" ? address.slice(address.lastIndexOf("@") + 1) : address;
    const decisionId = `decision-a${String(this.next++).padStart(32, "0")}`;
    this.decisions.push({ decisionId, key, scope: input.scope, decision: input.decision, decidedAt: Date.now() });
    const archived =
      input.decision === "block"
        ? LETTERS.filter((letter) => letter.stranger && this.standing(letter.from)?.decisionId === decisionId).map(
            (letter) => ({ accountId: letter.accountId, threadId: letter.threadId }),
          )
        : [];
    return { apiVersion: 1, decisionId, archived, pending: false };
  }

  undo(decisionId: string) {
    this.deleted.push(decisionId);
    this.decisions = this.decisions.filter((each) => each.decisionId !== decisionId);
    return { apiVersion: 1, restored: [], pending: false };
  }
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

async function install(page: Page, accounts: readonly (typeof home | typeof work)[] = [home, work]) {
  const world = new World();
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts }),
  );
  await page.route(/\/api\/mail\/threads\?.*$/, (route) => {
    const accountId = new URL(route.request().url()).searchParams.get("accountId") ?? "";
    return fulfill(route, {
      apiVersion: 1,
      items: world.items(accountId),
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: Date.now() - 60_000 },
    });
  });
  await page.route(/\/api\/mail\/threads\/[a-z-]+(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const threadId = url.pathname.split("/").at(-1)!;
    const letter = LETTERS.find((candidate) => candidate.threadId === threadId)!;
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { read?: boolean };
      if (body.read === true) world.read.add(threadId);
      if (body.read === false) world.read.delete(threadId);
      return fulfill(route, { apiVersion: 1, thread: world.item(letter) });
    }
    return fulfill(route, {
      apiVersion: 1,
      thread: world.item(letter),
      messages: [
        {
          accountId: letter.accountId,
          messageId: `message-${threadId}`,
          threadId,
          from: letter.from,
          replyTo: [],
          to: [{ name: null, address: letter.accountId === home.accountId ? home.emailAddress : work.emailAddress }],
          cc: [],
          subject: letter.subject,
          sentAt: Date.now() - letter.minutesAgo * 60_000,
          unread: letter.unread,
          inInbox: true,
          snippet: letter.body,
          textBody: null,
          htmlBody: null,
          hasAttachments: false,
        },
      ],
    });
  });
  await page.route(/\/api\/mail\/message-content\/[^/?]+(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const messageId = url.pathname.split("/").at(-1)!;
    const letter = LETTERS.find((candidate) => `message-${candidate.threadId}` === messageId)!;
    return fulfill(route, {
      apiVersion: 1,
      accountId: letter.accountId,
      messageId,
      state: "ready",
      textBody: `Hi,\n\n${letter.body}\n\n${letter.from.name}`,
      htmlBody: null,
      attachments: [],
    });
  });
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false }),
  );
  await page.route("**/api/mail/senders/state", (route) => {
    if (route.request().method() === "PUT") {
      world.screenOn = (route.request().postDataJSON() as { enabled: boolean }).enabled;
    }
    return fulfill(route, {
      apiVersion: 1,
      enabled: world.screenOn,
      enabledAt: world.screenOn ? 1_700_000_000_000 : null,
      backfillComplete: world.screenOn,
      domainScopeRefused: ["gmail.example"],
    });
  });
  await page.route("**/api/mail/senders/decisions", (route) =>
    fulfill(route, world.decide(route.request().postDataJSON())),
  );
  await page.route(/\/api\/mail\/senders\/decisions\/decision-a[0-9a-f]{32}(?:\?.*)?$/, (route) => {
    const decisionId = new URL(route.request().url()).pathname.split("/").at(-1)!;
    return fulfill(route, world.undo(decisionId));
  });
  await page.route("**/api/mail/senders/blocked", (route) =>
    fulfill(route, {
      apiVersion: 1,
      blocked: world.decisions
        .filter((each) => each.decision === "block")
        .map((each) => ({
          decisionId: each.decisionId,
          key: each.key,
          scope: each.scope,
          decidedAt: each.decidedAt,
          archivedCount: 1,
        })),
    }),
  );
  return world;
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

function waitingGroup(page: Page) {
  return page.locator('section[aria-label="New senders"]');
}

function peopleGroup(page: Page) {
  return page.locator('section[aria-label="People"]');
}

/** A sideways drag with a finger, the way Chromium turns touch into the
 *  pointer events framer's drag listens to. */
async function swipe(page: Page, row: ReturnType<Page["locator"]>, dx: number) {
  const box = await row.boundingBox();
  if (!box) throw new Error("row not on screen");
  const cdp = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width * 0.3;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let step = 1; step <= 12; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x0 + (dx * step) / 12, y }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("a stranger's first letter waits under New senders, Accept sends it to People and Undo brings it back", async ({
  page,
}) => {
  await login(page);
  const world = await install(page);
  await page.goto("/mail");

  await expect(waitingGroup(page).getByText("Lena Okafor")).toBeVisible();
  await expect(waitingGroup(page).getByText("okafor.example")).toBeVisible();
  await expect(peopleGroup(page).getByText("Flat in Lisbon, 12 to 19 October")).toHaveCount(0);

  await page.getByRole("button", { name: "Accept Lena Okafor" }).click();
  await expect(peopleGroup(page).getByText("Flat in Lisbon, 12 to 19 October")).toBeVisible();
  await expect(waitingGroup(page).getByText("Lena Okafor")).toHaveCount(0);
  expect(world.posted).toEqual([
    { address: "lena@okafor.example", scope: "address", decision: "accept" },
  ]);
  await expect(page.getByText("Accepted Lena Okafor")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(waitingGroup(page).getByText("Lena Okafor")).toBeVisible();
  await expect.poll(() => world.deleted.length).toBe(1);
});

/* On a phone the waiting row is the name and its two buttons. The decision
   keeps 128 of the row, and what that left of the domain was a stub of three
   or four letters, so below the column's phone breakpoint (`md`, where the
   sidebar gives way to the tab bar) the domain is not drawn at all. Held at
   the two widths either side of it. */
test("a waiting row drops the sender's domain where the column is a phone's", async ({
  page,
}) => {
  await login(page);
  await install(page);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/mail");

  const row = waitingGroup(page).locator('[role="listitem"]').filter({ hasText: "Lena Okafor" });
  await expect(row.getByText("Lena Okafor")).toBeVisible();
  await expect(row.getByText("okafor.example")).toBeVisible();

  await page.setViewportSize({ width: 767, height: 900 });
  await expect(row.getByText("Lena Okafor")).toBeVisible();
  await expect(row.getByText("okafor.example")).toBeHidden();
  await expect(row.getByRole("button", { name: "Block Lena Okafor" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Accept Lena Okafor" })).toBeVisible();
});

test("@mobile a waiting row on a phone is the name and its decision, with no domain", async ({
  page,
}) => {
  await login(page);
  await install(page);
  await page.goto("/mail");

  const row = waitingGroup(page).locator('[role="listitem"]').filter({ hasText: "Lena Okafor" });
  await expect(row.getByText("Lena Okafor")).toBeVisible();
  await expect(row.getByText("okafor.example")).toBeHidden();
  // The name has the row to itself up to the buttons: it is not cut short.
  const cut = await row
    .getByText("Lena Okafor")
    .evaluate((node) => node.scrollWidth > node.clientWidth + 0.5);
  expect(cut).toBe(false);
  await expect(row.getByRole("button", { name: "Block Lena Okafor" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Accept Lena Okafor" })).toBeVisible();
});

test("Block takes the letter out of the column and Undo puts it back", async ({ page }) => {
  await login(page);
  const world = await install(page);
  await page.goto("/mail");

  await page.getByRole("button", { name: "Block Growth Weekly" }).click();
  await expect(page.getByText("10 inbox hacks you need to try")).toHaveCount(0);
  await expect(page.getByText("Blocked Growth Weekly")).toBeVisible();
  expect(world.posted).toEqual([
    { address: "hello@growthly.example", scope: "address", decision: "block" },
  ]);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(waitingGroup(page).getByText("Growth Weekly")).toBeVisible();
  await expect.poll(() => world.deleted.length).toBe(1);
});

test("the reader decides for everyone at a domain and gives Reply back after", async ({ page }) => {
  await login(page);
  const world = await install(page);
  await page.goto("/mail");

  await waitingGroup(page).getByText("Kiln share, spring places").click();
  const reader = page.locator('section[aria-label="Message reader"]');
  await expect(reader.getByText("first letter from this sender")).toBeVisible();
  await expect(reader.getByRole("button", { name: "Reply" })).toHaveCount(0);
  await reader.getByRole("radio", { name: "Everyone at aalto.example" }).click();
  await reader.getByRole("button", { name: "Accept 2 senders" }).click();
  await expect(reader.getByRole("button", { name: "Reply" })).toBeVisible();
  expect(world.posted).toEqual([
    { address: "mia@aalto.example", scope: "domain", decision: "accept" },
  ]);
  await expect(waitingGroup(page).getByText("Studio Aalto")).toHaveCount(0);
  await expect(page.getByText("Accepted aalto.example")).toBeVisible();
});

test("b blocks the letter j moved the reader to, not the row pressed before it", async ({
  page,
}) => {
  await login(page);
  const world = await install(page);
  await page.goto("/mail");

  // A press leaves the focus on the row it pressed; j moves the reader only.
  await waitingGroup(page).getByText("Flat in Lisbon, 12 to 19 October").click();
  const reader = page.locator('section[aria-label="Message reader"]');
  await expect(reader.getByRole("heading", { name: "Flat in Lisbon, 12 to 19 October" })).toBeVisible();
  await page.keyboard.press("j");
  await expect(reader.getByRole("heading", { name: "Kiln share, spring places" })).toBeVisible();
  await page.keyboard.press("b");
  await expect.poll(() => world.posted.length).toBe(1);
  expect(world.posted[0]).toEqual({
    address: "mia@aalto.example",
    scope: "address",
    decision: "block",
  });
  await expect(waitingGroup(page).getByText("Lena Okafor")).toBeVisible();
});

test("@mobile a swipe right accepts and a swipe left blocks", async ({ page }) => {
  await login(page);
  const world = await install(page);
  await page.goto("/mail");

  const lenaRow = waitingGroup(page).locator('[role="listitem"]').filter({ hasText: "Lena Okafor" });
  await swipe(page, lenaRow, 220);
  await expect.poll(() => world.posted.length).toBe(1);
  expect(world.posted[0]).toEqual({
    address: "lena@okafor.example",
    scope: "address",
    decision: "accept",
  });
  await expect(peopleGroup(page).getByText("Flat in Lisbon, 12 to 19 October")).toBeVisible();

  const growthRow = waitingGroup(page).locator('[role="listitem"]').filter({ hasText: "Growth Weekly" });
  await swipe(page, growthRow, -220);
  await expect.poll(() => world.posted.length).toBe(2);
  expect(world.posted[1]).toEqual({
    address: "hello@growthly.example",
    scope: "address",
    decision: "block",
  });
  await expect(page.getByText("10 inbox hacks you need to try")).toHaveCount(0);
});

/* ── Frames for review, never committed ─────────────────────────────────── */

const SHOTS = process.env.NEW_SENDERS_SHOTS_DIR ?? "";

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(scheme === "dark");
}

async function shootAll(page: Page, device: "desktop" | "phone") {
  mkdirSync(SHOTS, { recursive: true });
  const frame = (name: string, scheme: string) =>
    path.join(SHOTS, `${name}-${device}-${scheme}.png`);
  for (const scheme of ["light", "dark"] as const) {
    await install(page);
    await setScheme(page, scheme);
    await page.goto("/mail");
    await expect(waitingGroup(page).getByText("Lena Okafor")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: frame("section", scheme) });

    const growthRow = waitingGroup(page)
      .locator('[role="listitem"]')
      .filter({ hasText: "Growth Weekly" });
    if (device === "phone") {
      // Held mid-swipe: the row off its place and the word under it armed.
      const box = (await growthRow.boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      const y = box.y + box.height / 2;
      const x0 = box.x + box.width * 0.6;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
      for (let step = 1; step <= 8; step += 1) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x0 - (box.width * 0.4 * step) / 8, y }],
        });
      }
      await page.waitForTimeout(200);
      await page.screenshot({ path: frame("swipe", scheme) });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x0, y }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
      await page.waitForTimeout(500);
    } else {
      await growthRow.click({ button: "right" });
      await expect(page.getByRole("menuitem", { name: "Block everyone at growthly.example" })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: frame("menu", scheme) });
      await page.keyboard.press("Escape");
    }

    await waitingGroup(page).getByText("Flat in Lisbon, 12 to 19 October").click();
    const reader = page.locator('section[aria-label="Message reader"]');
    await expect(reader.getByText("first letter from this sender")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: frame("reader", scheme) });

    const accept = reader.getByRole("button", { name: "Accept", exact: true });
    await accept.click();
    await expect(page.getByText("Accepted Lena Okafor")).toBeVisible();
    await page.waitForTimeout(700);
    await page.screenshot({ path: frame("toast", scheme) });

    // Someone blocked, so the list has a row to show.
    await page.evaluate(async () => {
      await fetch("/api/mail/senders/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: "hello@growthly.example", scope: "domain", decision: "block" }),
      });
    });
    await page.goto("/settings/mail");
    await expect(page.getByText("Screen new senders")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: frame("settings", scheme), fullPage: true });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
}

test("new senders frames on the desktop", async ({ page }) => {
  test.skip(SHOTS === "", "artifact capture — run with NEW_SENDERS_SHOTS_DIR=<dir>");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await shootAll(page, "desktop");
});

test("@mobile new senders frames on a phone", async ({ page }) => {
  test.skip(SHOTS === "", "artifact capture — run with NEW_SENDERS_SHOTS_DIR=<dir>");
  await login(page);
  await shootAll(page, "phone");
});
