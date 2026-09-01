import { expect, test, type Page, type Route } from "playwright/test";

// Design audit on the Liquid Glass dev stand (/dev/glass, development only —
// the e2e server is `next dev`). Deterministic DOM checks that a static grep
// cannot make: every interactive element reacts to a real hover, no material
// nests inside another, and materialize animates opacity + scale only.
// Part of the compact release gate (@release) because the stand is where the
// component contract lives until the shell train ships it.

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

async function openStand(page: Page) {
  await login(page);
  await page.goto("/dev/glass");
  // The server HTML paints the stand long before React hydrates it — on a
  // slow CI runner a click then lands on inert markup: it "passes" but no
  // handler runs, so the live menu never opens. data-hydrated flips on the
  // stand's first post-hydration commit; the long timeout covers the dev
  // server's on-demand compile of this page.
  await expect(page.locator("[data-glass-stand][data-hydrated]")).toBeAttached({
    timeout: 30_000,
  });
  await expect(page.locator("[data-stand-components]")).toBeVisible();
  // the stand's own sticky header would sit over controls scrolled to the top
  await page.addStyleTag({ content: "[data-glass-stand] > header { visibility: hidden }" });
}

/** Computed colour signals of an element and its descendants — what a hover
 *  can change: the fill (colour or the layered tint image), the text or icon
 *  colour, an underline. */
function signals(root: Element) {
  const pick = (el: Element) => {
    const s = getComputedStyle(el);
    // the tint layer (::after on .tint-hover / fills) fades in by opacity
    const after = getComputedStyle(el, "::after");
    return [s.backgroundColor, s.backgroundImage, s.color, s.textDecorationLine, s.boxShadow, after.opacity].join("|");
  };
  return [root, ...root.querySelectorAll("*")].map(pick).join("\n");
}

test("@release every control on the stand has a distinct hover (DESIGN.md v2 → Hover)", async ({ page }) => {
  await openStand(page);
  // the REST column of every five-state grid plus the live rows; the other
  // columns carry static state attributes and would not move
  const controls = page.locator(
    [
      '[data-stand-components] [data-state-cell="rest"] :is(button, a, [role="button"])',
      '[data-stand-components] [data-live-tree] [role="button"]',
    ].join(", "),
  );
  const count = await controls.count();
  expect(count).toBeGreaterThan(12);

  const failures: string[] = [];
  for (let i = 0; i < count; i++) {
    const el = controls.nth(i);
    const label =
      (await el.getAttribute("aria-label")) ??
      (await el.getAttribute("data-measure")) ??
      (await el.innerText()).trim().slice(0, 24);
    // park the pointer away, read rest, hover, read again
    await page.mouse.move(0, 0);
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const rest = await el.evaluate(signals);
    await el.hover();
    await page.waitForTimeout(200);
    const hover = await el.evaluate(signals);
    if (rest === hover) failures.push(`#${i} ${label}`);
  }
  expect(failures, "controls whose computed colours do not change on hover").toEqual([]);
});

/** What a focus ring can be: the outline, or a field's blue box-shadow. */
function ring(el: Element) {
  const s = getComputedStyle(el);
  return {
    cls: String(el.className).split(" ")[0],
    field: el.classList.contains("field"),
    outline: s.outlineStyle,
    color: s.outlineColor,
    shadow: s.boxShadow,
    transform: s.transform,
  };
}

test("@release the ring is keyboard focus only — a pointer press is scale + tint (DESIGN.md v2 → Hover → Focus)", async ({ page }) => {
  await openStand(page);
  const html = page.locator("html");
  const blue = /rgba?\(11, 99, 209/; // --blue / --blue-ring, light theme

  // pointer held, then released: no outline, html[data-kbd] stays off
  const button = page.locator('[data-stand-components] [data-state-cell="rest"] [data-measure="btn-glass"]').first();
  await button.scrollIntoViewIfNeeded();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const pressed = await button.evaluate(ring);
  expect(pressed.outline).toBe("none");
  expect(pressed.transform).not.toBe("none"); // scale .97
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect((await button.evaluate(ring)).outline).toBe("none");
  await expect(button).toBeFocused();
  await expect(html).not.toHaveAttribute("data-kbd", /.*/);

  // Tab away and back: the ring is there
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  await expect(html).toHaveAttribute("data-kbd", "true");
  const keyboard = await button.evaluate(ring);
  expect(keyboard.outline).toBe("solid");
  expect(keyboard.color).toMatch(blue);

  // a mouse click on the next control drops it again
  const chip = page.locator('[data-stand-components] [data-state-cell="rest"] [data-measure="chip"]').first();
  await chip.click();
  await expect(chip).toBeFocused();
  await expect(html).not.toHaveAttribute("data-kbd", /.*/);
  expect((await chip.evaluate(ring)).outline).toBe("none");

  // the static ACTIVE column carries no ring anywhere — not the outline, and
  // not a field's blue box-shadow; the static FOCUS column does (the outline
  // on controls, the :focus-within box-shadow on fields)
  const active = await page
    .locator('[data-stand-components] [data-state-cell="active"] :is([data-active], .field)')
    .evaluateAll((els) => els.map((el) => {
      const s = getComputedStyle(el);
      return { cls: String(el.className).split(" ")[0], field: el.classList.contains("field"), outline: s.outlineStyle, shadow: s.boxShadow };
    }));
  expect(active.length).toBeGreaterThan(8);
  expect(active.filter((r) => r.outline !== "none").map((r) => r.cls)).toEqual([]);
  expect(active.filter((r) => r.field && blue.test(r.shadow)).map((r) => r.cls)).toEqual([]);
  const focus = await page
    .locator('[data-stand-components] [data-state-cell="focus"] [data-focus]')
    .evaluateAll((els) => els.map((el) => {
      const s = getComputedStyle(el);
      const channels = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s.boxShadow);
      const [r, g, b] = channels ? channels.slice(1).map(Number) : [0, 0, 0];
      return {
        cls: String(el.className).split(" ")[0],
        field: el.classList.contains("field"),
        invalid: !!el.querySelector('input[aria-invalid="true"]'),
        // hue rather than an exact triple: the ring is authored in oklch and
        // the sRGB it resolves to is the browser's gamut mapping to decide
        reddish: r > 150 && r - g > 60 && r - b > 60,
        outline: s.outlineStyle,
        shadow: s.boxShadow,
      };
    }));
  expect(focus.length).toBeGreaterThan(8);
  expect(focus.filter((r) => !r.field && r.outline !== "solid").map((r) => r.cls)).toEqual([]);
  expect(
    focus.filter((r) => r.field && !r.invalid && (r.outline !== "none" || !blue.test(r.shadow))).map((r) => r.cls),
  ).toEqual([]);
  // an invalid field keeps the error colour while it holds focus — blue
  // there would say the value had been accepted (DESIGN.md §8)
  const invalidFocus = focus.filter((r) => r.field && r.invalid);
  expect(invalidFocus.length).toBe(1);
  expect(invalidFocus.filter((r) => !r.reddish || blue.test(r.shadow)).map((r) => r.shadow)).toEqual([]);
});

test("@release no material nests inside another on the stand (ban #1)", async ({ page }) => {
  await openStand(page);
  // open the live menu too: a portaled popover over a pill is two siblings,
  // not a nest
  await page.locator("[data-stand-menu-trigger]").click();
  await expect(page.locator("[data-stand-menu]")).toBeVisible();
  const nested = await page.evaluate(() => {
    const blurs = (el: Element) => getComputedStyle(el).backdropFilter !== "none";
    const out: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      if (!blurs(el)) continue;
      // the scroll-edge layers are siblings of the rows by design; a row is
      // never glass
      let parent = el.parentElement;
      while (parent) {
        if (blurs(parent)) {
          out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} inside ${parent.tagName.toLowerCase()}.${String(parent.className).split(" ")[0]}`);
          break;
        }
        parent = parent.parentElement;
      }
    }
    return out;
  });
  expect(nested).toEqual([]);
  await page.keyboard.press("Escape");
});

test("@release menus and dialogs materialize on data-state without touching the blur", async ({ page }) => {
  await openStand(page);
  const keyframes = await page.evaluate(() => {
    const found: Record<string, string> = {};
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const walk = (list: CSSRuleList) => {
        for (const rule of list) {
          if (rule instanceof CSSKeyframesRule) found[rule.name] = rule.cssText;
          else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
        }
      };
      walk(rules);
    }
    return found;
  });
  for (const name of ["materialize-in", "materialize-out", "materialize-edge", "dialog-pop", "dialog-pop-out"]) {
    expect(keyframes[name], `@keyframes ${name}`).toBeTruthy();
    expect(keyframes[name]).not.toMatch(/filter/);
  }

  // the live menu: Radix data-state drives the keyframe, the edge-light
  // rides ::before, exit retraces and unmounts when it ends
  await page.locator("[data-stand-menu-trigger]").click();
  const menu = page.locator("[data-stand-menu]");
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((el) => ({
      state: el.getAttribute("data-state"),
      animation: getComputedStyle(el).animationName,
      edge: getComputedStyle(el, "::before").animationName,
      blur: getComputedStyle(el).backdropFilter !== "none",
    })),
  ).toEqual({ state: "open", animation: "materialize-in", edge: "materialize-edge", blur: true });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // the live dialog: thick material, L4 scrim, no hairline under the header
  await page.getByRole("button", { name: "Open confirm dialog" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((el) => ({
      animation: getComputedStyle(el).animationName,
      blur: getComputedStyle(el).backdropFilter !== "none",
      borderWidth: getComputedStyle(el).borderTopWidth,
      radius: getComputedStyle(el).borderTopLeftRadius,
    })),
  ).toEqual({ animation: "dialog-pop", blur: true, borderWidth: "0px", radius: "20px" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("@release scroll-edge shows only where content continues", async ({ page }) => {
  await openStand(page);
  for (const name of ["Results", "Palette results"]) {
    const fade = page.locator(`[aria-label='${name}']`);
    // the §5 and §9 demos open scrolled: both edges on
    await expect(fade).toHaveAttribute("data-scrolled", "");
    await expect(fade).toHaveAttribute("data-scroll-more", "");
    await expect.poll(() => fade.evaluate((el) => getComputedStyle(el).getPropertyValue("--edge-top"))).toBe("12px");
    await fade.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(fade).not.toHaveAttribute("data-scrolled");
    await expect(fade).toHaveAttribute("data-scroll-more", "");
    await expect.poll(() => fade.evaluate((el) => getComputedStyle(el).getPropertyValue("--edge-top"))).toBe("0px");
    await fade.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(fade).toHaveAttribute("data-scrolled", "");
    await expect(fade).not.toHaveAttribute("data-scroll-more");
    await expect.poll(() => fade.evaluate((el) => getComputedStyle(el).getPropertyValue("--edge-bottom"))).toBe("0px");
  }
});

test("@release the live palette's results scroll under the fade atom", async ({ page }) => {
  await login(page);
  // a dozen matching pages so the list outgrows a short viewport (60vh)
  await page.evaluate(async () => {
    for (let i = 1; i <= 12; i++) {
      await fetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Palette fade page ${String(i).padStart(2, "0")}`, markdown: "" }),
      });
    }
  });
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/");
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("desktop-command-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("Palette fade");
  const list = palette.locator("[cmdk-list]");
  await expect(list.locator("[cmdk-item]")).toHaveCount(12);
  // rest: nothing at the top, more below
  await expect(list).not.toHaveAttribute("data-scrolled");
  await expect(list).toHaveAttribute("data-scroll-more", "");
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // the keyboard walks the selection down and cmdk scrolls it into view (a
  // programmatic scrollTo would race cmdk's own scroll-into-view): the first
  // row dissolves under the 12px top inset instead of clipping
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown");
  await expect(list).toHaveAttribute("data-scrolled", "");
  await expect.poll(() => list.evaluate((el) => getComputedStyle(el).getPropertyValue("--edge-top"))).toBe("12px");
  expect(await list.evaluate((el) => getComputedStyle(el).maskImage)).toContain("linear-gradient");
  // the end: the bottom edge goes
  await page.keyboard.press("End");
  await expect(list).not.toHaveAttribute("data-scroll-more");
  await expect.poll(() => list.evaluate((el) => getComputedStyle(el).getPropertyValue("--edge-bottom"))).toBe("0px");
  // back at the top: nothing
  await page.keyboard.press("Home");
  await expect(list).not.toHaveAttribute("data-scrolled");
  await expect.poll(() => list.evaluate((el) => getComputedStyle(el).getPropertyValue("--edge-top"))).toBe("0px");
  await page.keyboard.press("Escape");
});

test("@release the shell keeps the backdrop budget on /p — ≤8 layers, none nested (DESIGN.md v2 → Scroll-edge, ban #1)", async ({ page }) => {
  await login(page);
  const created = await page.evaluate(async () => {
    const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: the paper is the window, the chrome floats over it.`).join("\n\n");
    const r = await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Backdrop budget", markdown: `## Section\n\n${body}` }),
    });
    return (await r.json()) as { id: string };
  });
  await page.goto(`/p/${created.id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toBeVisible();
  // scrolled, so every edge and pill the canvas can show is active
  await page.locator(".brain-page-scroll").evaluate((el) => el.scrollTo({ top: 400 }));
  await page.waitForTimeout(300);
  const audit = await page.evaluate(() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const layers: string[] = [];
    const nested: string[] = [];
    const tag = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`;
    for (const el of document.querySelectorAll("*")) {
      if (getComputedStyle(el).backdropFilter === "none") continue;
      const r = el.getBoundingClientRect();
      const inViewport = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      if (inViewport) layers.push(tag(el));
      let parent = el.parentElement;
      while (parent) {
        if (getComputedStyle(parent).backdropFilter !== "none") {
          nested.push(`${tag(el)} inside ${tag(parent)}`);
          break;
        }
        parent = parent.parentElement;
      }
    }
    return { layers, nested };
  });
  expect(audit.nested).toEqual([]);
  expect(
    audit.layers.length,
    `backdrop layers in the viewport: ${audit.layers.join(", ")}`,
  ).toBeLessThanOrEqual(8);
});

test("@release truncated labels keep their descenders", async ({ page }) => {
  await openStand(page);
  // Control is 13px with line-height 1; a truncating span needs ≥ 1.25 so
  // "g j p y q Ã‰" is not clipped by its own overflow box
  const labels = page.locator(
    [
      "[data-descenders] .tree-row-title",
      "[data-descenders] .chip .truncate",
      "[data-descenders] .brain-menu-item .truncate",
      "[data-descenders] .btn .truncate",
      "[data-state-cell='rest'] .crumb-label",
      "[data-state-cell='rest'] [data-measure='tree-row'] .tree-row-title",
    ].join(", "),
  );
  const count = await labels.count();
  expect(count).toBeGreaterThanOrEqual(7);
  for (let i = 0; i < count; i++) {
    const box = await labels.nth(i).evaluate((el) => {
      const s = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, fontSize: parseFloat(s.fontSize), overflow: s.overflow };
    });
    expect(box.overflow, `label #${i} truncates`).toBe("hidden");
    expect(box.height, `label #${i} height vs ${box.fontSize}px`).toBeGreaterThanOrEqual(box.fontSize * 1.25 - 0.5);
  }
  // the breadcrumb underline decorates the label, never the emoji
  const crumb = page.locator("[data-state-cell='hover'] .crumb-seg[data-hover]").first();
  expect(await crumb.locator(".crumb-label").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("underline");
  expect(await crumb.locator(".crumb-glyph").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
  expect(await crumb.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
});

/** P5 (Mail): glass never crosses into foreign content. The reader toolbar
 *  is pills in an opaque paper strip above the scroller, so at no scroll
 *  position may any element with a backdrop-filter intersect an iframe
 *  (DESIGN.md v2 → Materials: "Glass over foreign heavy content (HTML mail
 *  with images) is forbidden"). */
test("@release no glass intersects the mail iframe (DESIGN.md v2 → Materials)", async ({ page }) => {
  await login(page);
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
    threadId: "thread-audit",
    subject: "Tall HTML newsletter",
    participants: [{ name: "Ben Johnson", address: "ben@example.test" }],
    snippet: "Audit preview",
    lastMessageAt: 1_700_000_000_000,
    messageCount: 1,
    unread: false,
    starred: false,
    hasAttachments: false,
  } as const;
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account] }),
  );
  await page.route(/\/api\/mail\/threads\/thread-audit(?:\?.*)?$/, (route) => {
    if (route.request().method() === "PATCH") {
      return fulfill(route, { apiVersion: 1, thread });
    }
    return fulfill(route, {
      apiVersion: 1,
      thread,
      messages: [
        {
          accountId: account.accountId,
          messageId: "message-audit",
          threadId: thread.threadId,
          from: { name: "Ben Johnson", address: "ben@example.test" },
          replyTo: [],
          to: [{ name: "Personal", address: account.emailAddress }],
          cc: [],
          subject: thread.subject,
          sentAt: 1_700_000_000_000,
          unread: false,
          inInbox: true,
          snippet: "Audit preview",
          textBody: null,
          htmlBody: "<p>placeholder</p>",
          hasAttachments: false,
        },
      ],
    });
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
  await page.route(/\/api\/mail\/message-content\/message-audit(?:\?.*)?$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      accountId: account.accountId,
      messageId: "message-audit",
      state: "ready",
      textBody: null,
      htmlBody: '<div style="height:2400px">Tall newsletter body</div>',
      attachments: [],
    }),
  );

  await page.goto("/mail");
  // One account opens straight into its Inbox: nothing to switch through.
  await expect(page.locator('button[aria-label^="Mailbox: "]')).toHaveAttribute(
    "aria-label",
    "Mailbox: Inbox",
  );
  await page.getByText(thread.subject, { exact: true }).click();
  const frame = page.locator('iframe[title="Sanitized HTML message"]');
  await expect(frame).toBeVisible();
  await expect
    .poll(() => frame.evaluate((node) => node.clientHeight))
    .toBeGreaterThan(1_000);

  const auditGlassOverIframe = () =>
    page.evaluate(() => {
      const tag = (el: Element) =>
        `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`;
      // A tall message iframe keeps its whole box in the layout, so while the
      // reader is scrolled the box extends up behind the opaque paper strip
      // and a raw rect test would flag chrome nobody can see through. The rule
      // is about what a reader looks at, so each frame is clipped to every
      // scrollport above it and to the viewport before the test.
      const visible = (el: Element) => {
        const box = el.getBoundingClientRect();
        let rect = {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        };
        for (
          let node = el.parentElement;
          node;
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          if (style.overflowX === "visible" && style.overflowY === "visible") continue;
          const clip = node.getBoundingClientRect();
          rect = {
            left: Math.max(rect.left, clip.left),
            right: Math.min(rect.right, clip.right),
            top: Math.max(rect.top, clip.top),
            bottom: Math.min(rect.bottom, clip.bottom),
          };
        }
        return {
          left: Math.max(rect.left, 0),
          right: Math.min(rect.right, window.innerWidth),
          top: Math.max(rect.top, 0),
          bottom: Math.min(rect.bottom, window.innerHeight),
        };
      };
      const frames = [...document.querySelectorAll("iframe")]
        .map(visible)
        .filter((f) => f.right > f.left && f.bottom > f.top);
      const hits: string[] = [];
      // the clip must never leave the audit with nothing to test
      if (frames.length === 0) hits.push("no visible iframe");
      for (const el of document.querySelectorAll("*")) {
        if (el.tagName === "IFRAME") continue;
        if (getComputedStyle(el).backdropFilter === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        for (const f of frames) {
          if (r.left < f.right && r.right > f.left && r.top < f.bottom && r.bottom > f.top) {
            hits.push(tag(el));
            break;
          }
        }
      }
      return hits;
    });

  const scroller = page.locator("[data-mail-reader-scroll]");
  for (const position of ["top", "middle", "end"] as const) {
    await scroller.evaluate((el, where) => {
      const top =
        where === "top" ? 0 : where === "middle" ? el.scrollHeight / 2 : el.scrollHeight;
      el.scrollTo({ top });
    }, position);
    await page.waitForTimeout(150);
    expect(
      await auditGlassOverIframe(),
      `backdrop elements intersecting an iframe while scrolled to ${position}`,
    ).toEqual([]);
  }
});

/** P5-c (Mail): the composer is a thick sheet, but the writing surfaces on it
 *  are paper insets — nothing glass may sit under editable text (ban #2), and
 *  no second material may nest inside the sheet (ban #1). The sheet's own
 *  scroller keeps the edge invisible until the content runs past it. */
test("@release the mail composer writes on paper, not on glass", async ({ page }) => {
  await login(page);
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
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account] }),
  );
  await page.route(/\/api\/mail\/threads\?.*$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      items: [],
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    }),
  );
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false }),
  );

  await page.goto("/mail");
  // one account opens straight into its Inbox
  await expect(page.locator('button[aria-label^="Mailbox: "]')).toHaveAttribute(
    "aria-label",
    "Mailbox: Inbox",
  );
  await page.getByRole("button", { name: "New message" }).click();
  const sheet = page.locator(".brain-composer-sheet");
  await expect(sheet).toBeVisible();

  // ban #1 — the sheet is the only backdrop layer in the composer
  expect(
    await page.$$eval(".brain-composer-sheet *", (nodes) =>
      nodes
        .filter((node) => getComputedStyle(node).backdropFilter !== "none")
        .map((node) => String(node.className).split(" ")[0]),
    ),
  ).toEqual([]);

  // ban #2 — every writing surface is opaque paper, not the material
  const fills = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--paper)";
    document.body.append(probe);
    const paper = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const surfaces = [
      ...document.querySelectorAll(".brain-composer-field, .brain-composer-body"),
    ];
    return { paper, surfaces: surfaces.map((el) => getComputedStyle(el).backgroundColor) };
  });
  expect(fills.surfaces.length).toBeGreaterThan(1);
  for (const fill of fills.surfaces) expect(fill).toBe(fills.paper);

  // the scroll-edge is gated: a composer that fits shows no edge
  expect(
    await page.locator(".brain-composer-scroll").evaluate((el) => el.dataset.scrolled ?? null),
  ).toBeNull();
});

/** §4 (Geometry): one inset, and every floating control at the window's edge
 *  keeps it. Two surfaces put chrome at that edge — a page's [Share] and
 *  [pin │ …] on the absolute topbar layer, and mail's reader pill inside the
 *  reader pane — and they reached it by different routes, so the strip's
 *  padding drifted to the article column's 32 and stood 20px further in than
 *  every other pill in the product. The rule is the window's edge, not the
 *  owner of the box the pill happens to sit in, so the audit measures both
 *  against the window in one pass. */
test("@release chrome at the window's right edge keeps §4's one inset", async ({ page }) => {
  await login(page);
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
    threadId: "thread-inset",
    subject: "One inset",
    participants: [{ name: "Ben Johnson", address: "ben@example.test" }],
    snippet: "Audit preview",
    lastMessageAt: 1_700_000_000_000,
    messageCount: 1,
    unread: false,
    starred: false,
    hasAttachments: false,
  } as const;
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account] }),
  );
  await page.route(/\/api\/mail\/threads\/thread-inset(?:\?.*)?$/, (route) => {
    if (route.request().method() === "PATCH") return fulfill(route, { apiVersion: 1, thread });
    return fulfill(route, {
      apiVersion: 1,
      thread,
      messages: [
        {
          accountId: account.accountId,
          messageId: "message-inset",
          threadId: thread.threadId,
          from: { name: "Ben Johnson", address: "ben@example.test" },
          replyTo: [],
          to: [{ name: "Personal", address: account.emailAddress }],
          cc: [],
          subject: thread.subject,
          sentAt: 1_700_000_000_000,
          unread: false,
          inInbox: true,
          snippet: "Audit preview",
          textBody: null,
          htmlBody: "<p>placeholder</p>",
          hasAttachments: false,
        },
      ],
    });
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
  await page.route(/\/api\/mail\/message-content\/message-inset(?:\?.*)?$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      accountId: account.accountId,
      messageId: "message-inset",
      state: "ready",
      textBody: null,
      htmlBody: "<p>placeholder</p>",
      attachments: [],
    }),
  );

  /** How far the element's right edge stands off the window's. */
  const offRightEdge = async (selector: string) =>
    page.locator(selector).first().evaluate((node) => {
      return window.innerWidth - node.getBoundingClientRect().right;
    });

  const pageId = await page.evaluate(async () => {
    const response = await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Inset audit", markdown: "Paper." }),
    });
    return ((await response.json()) as { id: string }).id;
  });
  await page.goto(`/p/${pageId}`);
  const topbarActions = page.locator(".brain-topbar-desktop .brain-topbar-actions");
  await expect(topbarActions).toBeVisible();
  const onThePage = await offRightEdge(".brain-topbar-desktop .brain-topbar-actions");

  await page.goto("/mail");
  // one account opens straight into its Inbox
  await expect(page.locator('button[aria-label^="Mailbox: "]')).toHaveAttribute(
    "aria-label",
    "Mailbox: Inbox",
  );
  await page.getByText(thread.subject, { exact: true }).click();
  await expect(page.locator(".brain-mail-reader-head .toolbar-pill")).toBeVisible();
  const inMail = await offRightEdge(".brain-mail-reader-head .toolbar-pill");

  const inset = await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--inset"),
    ),
  );
  expect(inset).toBe(12);
  expect(onThePage).toBeCloseTo(inset, 0);
  expect(inMail).toBeCloseTo(inset, 0);
});
