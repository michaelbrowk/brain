import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "playwright/test";

interface TouchRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

async function touchRects(locator: Locator): Promise<TouchRect[]> {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const minimum = element.classList.contains("brain-touch-hit")
        ? 44
        : element.classList.contains("brain-touch-min")
          ? 24
          : 0;
      const width = Math.max(rect.width, minimum);
      const height = Math.max(rect.height, minimum);
      const left = rect.left + (rect.width - width) / 2;
      const top = rect.top + (rect.height - height) / 2;
      return { left, right: left + width, top, bottom: top + height };
    }),
  );
}

function overlaps(a: TouchRect, b: TouchRect): boolean {
  return (
    a.left < b.right - 0.5 &&
    a.right > b.left + 0.5 &&
    a.top < b.bottom - 0.5 &&
    a.bottom > b.top + 0.5
  );
}

async function realHitTarget(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    // Stay inside the painted rounded corners. A 1px corner sample can
    // correctly hit the element behind a rounded button even when the full
    // 44px control is present and clickable.
    const edgeInset = 4;
    const points = [
      ["top-left", rect.left + edgeInset, rect.top + edgeInset],
      ["top-right", rect.right - edgeInset, rect.top + edgeInset],
      ["bottom-left", rect.left + edgeInset, rect.bottom - edgeInset],
      ["bottom-right", rect.right - edgeInset, rect.bottom - edgeInset],
      ["center", rect.left + rect.width / 2, rect.top + rect.height / 2],
    ] as const;
    const hits = points.map(([point, x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return {
        point,
        owned: hit === element || (hit !== null && element.contains(hit)),
        owner: hit
          ? {
              tag: hit.tagName.toLowerCase(),
              testId: hit.getAttribute("data-testid"),
              ariaLabel: hit.getAttribute("aria-label"),
              className: hit.getAttribute("class"),
            }
          : null,
      };
    });
    return {
      width: rect.width,
      height: rect.height,
      withinViewport:
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight,
      allPointsHit: hits.every((hit) => hit.owned),
      hits,
    };
  });
}

async function expectReal44pxTarget(locator: Locator) {
  const target = await realHitTarget(locator);
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  expect(target.withinViewport).toBe(true);
  expect(
    target.hits.filter((hit) => !hit.owned),
    `Missed hit-test points: ${JSON.stringify(target.hits)}`,
  ).toEqual([]);
  expect(target.allPointsHit).toBe(true);
}

async function browserJson(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return page.evaluate(
    async ({ requestPath, requestInit }) => {
      const response = await fetch(requestPath, {
        method: requestInit.method,
        headers:
          requestInit.body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body:
          requestInit.body === undefined
            ? undefined
            : JSON.stringify(requestInit.body),
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    },
    { requestPath: path, requestInit: init },
  );
}

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
  const body = await response.text();
  expect(
    response.status(),
    `auth failed with ${response.status()}: ${body}`,
  ).toBe(200);
  // The first authenticated RSC compilation is cold on a clean CI runner.
  // Verify the auth response above, then give that navigation its own budget.
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

async function expectDialogLayerReleased(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
        htmlPointerEvents: getComputedStyle(document.documentElement)
          .pointerEvents,
        bodyInert:
          document.body.inert || document.body.hasAttribute("inert"),
        htmlInert:
          document.documentElement.inert ||
          document.documentElement.hasAttribute("inert"),
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        overlays: document.querySelectorAll(".brain-dialog-overlay").length,
      })),
    )
    .toEqual({
      bodyPointerEvents: "auto",
      htmlPointerEvents: "auto",
      bodyInert: false,
      htmlInert: false,
      dialogs: 0,
      overlays: 0,
    });
}

/** Freeze the page's timers at the moment of the call.
 *
 *  `pauseAt` refuses a time the fake clock has already gone past, and an
 *  installed clock keeps running until it is paused — so when a timer fired
 *  between reading `Date.now()` in the page and the pause arriving, the call
 *  threw "Cannot fast-forward to the past", in a different test each run. Read
 *  the clock again and pause at the later value. The fake time that closes the
 *  gap is time that really elapsed, and an unpaused clock had already fired
 *  everything due inside it, so nothing is skipped and nothing runs early. */
async function freezePageClock(page: Page) {
  await page.clock.install();
  for (let attempt = 0; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now);
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
    }
  }
}

async function settleBrowserFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function expectPlainDialogClose(button: Locator) {
  // Plain means plain: nothing drawn around the cross, not even a ring hidden
  // in CSS (DESIGN.md §10 ban 13).
  await expect(button.locator("circle")).toHaveCount(0);
  const geometry = await button.evaluate((element) => {
    const buttonStyle = getComputedStyle(element);
    // The whole drawing, not one of its two strokes: the cross is a pair of
    // diagonals and either one alone would measure the same box by accident.
    const svg = element.querySelector("svg");
    const glyphRect = svg?.firstElementChild?.getBoundingClientRect();
    return {
      button: {
        width: Number.parseFloat(buttonStyle.width),
        height: Number.parseFloat(buttonStyle.height),
      },
      strokes: element.querySelectorAll("path").length,
      glyph: glyphRect
        ? { width: glyphRect.width, height: glyphRect.height }
        : null,
    };
  });
  expect(geometry.button).toEqual({ width: 28, height: 28 });
  expect(geometry.strokes).toBe(2);
  expect(geometry.glyph).not.toBeNull();
  // Solar's bare cross reaches 5→19 of its 24 box, so at size 18 the drawing
  // is 10.5px inside a 28px button. The window is the tolerance around that,
  // not a range the glyph may wander in.
  for (const side of [geometry.glyph?.width, geometry.glyph?.height]) {
    expect(side).toBeGreaterThanOrEqual(9.5);
    expect(side).toBeLessThanOrEqual(11.5);
  }
}

async function linkClickWasPrevented(
  link: Locator,
  init: Pick<
    MouseEventInit,
    "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
  attributes: { target?: string; download?: string } = {},
) {
  return link.evaluate(
    (element, { eventInit, temporaryAttributes }) => {
      const anchor = element as HTMLAnchorElement;
      const previous = {
        target: anchor.getAttribute("target"),
        download: anchor.getAttribute("download"),
      };
      for (const [name, value] of Object.entries(temporaryAttributes)) {
        anchor.setAttribute(name, value);
      }
      let prevented: boolean | null = null;
      anchor.addEventListener(
        "click",
        (event) => {
          prevented = event.defaultPrevented;
          // Contain native navigation/tab creation after Brain's capture
          // handler has had the opportunity to preserve the affordance.
          event.preventDefault();
        },
        { once: true },
      );
      anchor.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ...eventInit,
        }),
      );
      for (const name of ["target", "download"] as const) {
        const value = previous[name];
        if (value === null) anchor.removeAttribute(name);
        else anchor.setAttribute(name, value);
      }
      // A stopped event never reached the containment listener, which means
      // Brain intercepted it during capture.
      return prevented ?? true;
    },
    { eventInit: init, temporaryAttributes: attributes },
  );
}

async function expectIconlessDialogHeader(dialog: Locator) {
  const heading = dialog.getByRole("heading").first();
  await expect(heading).toBeVisible();
  await expect(heading.locator("..").locator("svg")).toHaveCount(0);
}

function captureDialogDescriptionWarnings(page: Page) {
  const warnings: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/missing.*description|aria-describedby=\{undefined\}/i.test(text)) {
      warnings.push(text);
    }
  });
  return warnings;
}

async function waitForCommittedPageHistory(page: Page, id: string) {
  await expect
    .poll(
      async () => {
        const result = await browserJson(page, `/api/page/${id}/history`);
        const body = result.body as { history?: unknown[] } | null;
        return result.ok ? (body?.history?.length ?? 0) : 0;
      },
      { timeout: 12_000 },
    )
    .toBeGreaterThan(0);
}

async function seedSchemaV2Draft(
  page: Page,
  id: string,
  markdown: string,
  revision: string,
  operationId: string,
) {
  await page.evaluate(
    ({ pageId, draftMarkdown, draftRevision, draftOperation }) => {
      const key = `brain-draft-v2:${encodeURIComponent(pageId)}:legacy-v2-test`;
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          markdown: draftMarkdown,
          revision: draftRevision,
          operationId: draftOperation,
          updatedAt: Date.now(),
        }),
      );
    },
    {
      pageId: id,
      draftMarkdown: markdown,
      draftRevision: revision,
      draftOperation: operationId,
    },
  );
}

async function seedConflictedDraft(
  page: Page,
  id: string,
  markdown: string,
  revision: string,
  baseMarkdown: string,
  operationId: string,
) {
  await page.evaluate(
    ({ pageId, draftMarkdown, draftRevision, draftBase, draftOperation }) => {
      const key = `brain-draft-v2:${encodeURIComponent(pageId)}:conflict-test`;
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 3,
          markdown: draftMarkdown,
          revision: draftRevision,
          operationId: draftOperation,
          updatedAt: Date.now(),
          baseMarkdown: draftBase,
          conflicted: true,
        }),
      );
    },
    {
      pageId: id,
      draftMarkdown: markdown,
      draftRevision: revision,
      draftBase: baseMarkdown,
      draftOperation: operationId,
    },
  );
}

async function draftBodies(page: Page, id: string): Promise<string[]> {
  return page.evaluate((pageId) => {
    const prefix = `brain-draft-v2:${encodeURIComponent(pageId)}:`;
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(prefix))
      .map((key) => localStorage.getItem(key))
      .filter((raw): raw is string => raw !== null)
      .map((raw) => {
        try {
          const parsed = JSON.parse(raw) as { markdown?: unknown };
          return typeof parsed.markdown === "string" ? parsed.markdown : raw;
        } catch {
          return raw;
        }
      });
  }, id);
}

async function makeSaveRetriesImmediate(page: Page) {
  await page.evaluate(() => {
    const clockSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      timeout = 0,
      ...args: unknown[]
    ) => {
      // saveMarkdown retries a 503 after 1500ms. Keep Milkdown's 200ms
      // serialization frozen while letting all three network attempts finish.
      if (timeout === 1500 && typeof handler === "function") {
        queueMicrotask(() => handler(...args));
        return 0;
      }
      return clockSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  });
}

test("SVG uploads fail closed in the real app server", async ({ page }) => {
  await login(page);

  const result = await page.evaluate(async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["<svg><script>alert(1)</script></svg>"], "unsafe.svg", {
        type: "image/svg+xml",
      }),
    );
    const response = await fetch("/api/upload", { method: "POST", body: form });
    return { status: response.status, body: await response.json() };
  });

  expect(result).toMatchObject({
    status: 415,
    body: { error: "unsafe file type" },
  });
});

async function pageRefOrder(page: Page): Promise<string[]> {
  return page.locator("a.brain-page-ref").evaluateAll((elements) =>
    elements.map(
      (element) => (element as HTMLElement).dataset.pageRef ?? "",
    ),
  );
}

async function dragPageRefBefore(
  page: Page,
  sourceId: string,
  targetId: string,
) {
  const source = page.locator(
    `a.brain-page-ref[data-page-ref="${sourceId}"]`,
  );
  const target = page.locator(
    `a.brain-page-ref[data-page-ref="${targetId}"]`,
  );

  await source.hover();
  // Milkdown's block service throttles pointer movement by 200 ms.
  await page.waitForTimeout(400);

  const handle = page.locator('.brain-block-handle[data-show="true"]');
  await expect(handle).toHaveCount(1);
  const handleBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (!handleBox || !targetBox) throw new Error("Missing drag geometry");

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Cross Chromium's drag threshold, then approach the target's top edge.
  await page.mouse.move(startX + 15, startY, { steps: 5 });
  await page.mouse.move(targetX, targetBox.y + targetBox.height / 2, {
    steps: 20,
  });
  await page.mouse.move(targetX, targetBox.y + 2, { steps: 5 });
  await page.waitForTimeout(100);

  const cursor = page.locator(".brain-drop-cursor");
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toBeVisible();
  await page.mouse.up();

  // Milkdown owns one persistent cursor. A finished drag hides it through
  // plugin state; detaching it breaks every later indicator until reload.
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toBeHidden();
}

async function dragPageRefInto(
  page: Page,
  sourceId: string,
  targetId: string,
  sourceOccurrence = 0,
) {
  const source = page.locator(
    `a.brain-page-ref[data-page-ref="${sourceId}"]`,
  ).nth(sourceOccurrence);
  const target = page.locator(
    `a.brain-page-ref[data-page-ref="${targetId}"]`,
  );

  await source.hover();
  await page.waitForTimeout(400);

  const handle = page.locator('.brain-block-handle[data-show="true"]');
  await expect(handle).toHaveCount(1);
  const handleBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (!handleBox || !targetBox) throw new Error("Missing drag geometry");

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY, { steps: 5 });
  await page.mouse.move(targetX, targetY, { steps: 24 });

  await expect(target).toHaveAttribute(
    "data-page-ref-nest-target",
    "true",
  );
  await expect(page.locator(".brain-drop-cursor")).toBeHidden();
  // One pointer promises one outcome. A column lane contains the centre band of
  // every row in it, so column drop yields the band instead of drawing a second
  // indicator under the same cursor.
  await expect(page.locator(".brain-col-drop-indicator")).toHaveCount(0);
  await page.mouse.up();
  await expect(target).not.toHaveAttribute(
    "data-page-ref-nest-target",
    "true",
  );
}

async function dragPageRefTitleIntoRowWhitespace(
  page: Page,
  sourceId: string,
  targetId: string,
  reducedMotion = false,
) {
  const source = page.locator(
    `a.brain-page-ref[data-page-ref="${sourceId}"]`,
  );
  const target = page.locator(
    `a.brain-page-ref[data-page-ref="${targetId}"]`,
  );
  const targetRow = target.locator("xpath=..");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  const targetRowBox = await targetRow.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(targetRowBox).not.toBeNull();
  if (!sourceBox || !targetBox || !targetRowBox) {
    throw new Error("Missing title-drag geometry");
  }

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const targetX = Math.min(
    targetRowBox.x + targetRowBox.width - 24,
    targetBox.x + targetBox.width + 48,
  );
  const targetY = targetRowBox.y + targetRowBox.height / 2;
  expect(targetX).toBeGreaterThan(targetBox.x + targetBox.width + 8);
  expect(targetX).toBeLessThan(targetRowBox.x + targetRowBox.width - 20);

  // Match the user's recording: press the visible page title itself, not the
  // six-dot handle, then release over empty space in the target row.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY, { steps: 5 });
  await page.mouse.move(targetX, targetY, { steps: 24 });
  await expect(target).toHaveAttribute("data-page-ref-nest-target", "true");
  await expect(page.locator(".brain-drop-cursor")).toBeHidden();

  const visual = await targetRow.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      filter: style.filter,
      transform: style.transform,
      transitionDuration: style.transitionDuration,
    };
  });
  expect(["rgba(0, 0, 0, 0)", "transparent"]).toContain(
    visual.backgroundColor,
  );
  expect(visual.boxShadow).toBe("none");
  expect(visual.filter).not.toBe("none");
  if (reducedMotion) {
    expect(visual.transform).toBe("none");
    // The global accessibility reset intentionally uses 0.01ms instead of a
    // literal zero so browsers still apply the final state deterministically.
    expect(parseFloat(visual.transitionDuration)).toBeLessThanOrEqual(0.001);
  } else {
    expect(visual.transform).not.toBe("none");
  }

  await page.mouse.up();
  await expect(target).not.toHaveAttribute("data-page-ref-nest-target", "true");
}

async function attemptPageRefDragWhileFrozen(
  page: Page,
  sourceId: string,
  targetId: string,
) {
  const source = page.locator(
    `a.brain-page-ref[data-page-ref="${sourceId}"]`,
  );
  const target = page.locator(
    `a.brain-page-ref[data-page-ref="${targetId}"]`,
  );
  await source.hover();
  await page.waitForTimeout(150);
  const handle = page.locator('.brain-block-handle[data-show="true"]');
  if (!(await handle.isVisible().catch(() => false))) {
    await source.dragTo(target);
    return;
  }
  const handleBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  if (!handleBox || !targetBox) return;
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 15, handleBox.y, {
    steps: 5,
  });
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 20 },
  );
  await page.mouse.up();
}

interface E2ETreeNode {
  id: string;
  parentId: string | null;
  children: E2ETreeNode[];
}

function findE2ETreeNode(
  nodes: E2ETreeNode[],
  id: string,
): E2ETreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findE2ETreeNode(node.children, id);
    if (child) return child;
  }
  return null;
}

async function createPageRefNestingFixture(page: Page, titles: string[]) {
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Page-ref nesting fixture" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };
  const children: Array<{ id: string; title: string }> = [];
  for (const title of titles) {
    const response = await browserJson(page, "/api/page", {
      method: "POST",
      body: { parentId: parent.id, title },
    });
    expect(response.ok).toBeTruthy();
    children.push({ ...(response.body as { id: string }), title });
  }
  const current = await browserJson(page, `/api/page/${parent.id}`);
  const markdown = children
    .map((child) => `[${child.title}](/p/${child.id})`)
    .join("\n\n");
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: { markdown, rev: (current.body as { rev: string }).rev },
  });
  expect(seeded.ok).toBeTruthy();
  return { parent, children };
}

async function dragPageRefToSide(
  page: Page,
  sourceId: string,
  targetId: string,
) {
  const source = page.locator(
    `a.brain-page-ref[data-page-ref="${sourceId}"]`,
  );
  const target = page.locator(
    `a.brain-page-ref[data-page-ref="${targetId}"]`,
  );
  const targetParagraph = target.locator("xpath=..");
  await source.hover();
  await page.waitForTimeout(400);
  const handle = page.locator('.brain-block-handle[data-show="true"]');
  const handleBox = await handle.boundingBox();
  const targetBox = await targetParagraph.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (!handleBox || !targetBox) throw new Error("Missing side-drag geometry");

  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width + 15, handleBox.y, {
    steps: 5,
  });
  await page.mouse.move(
    targetBox.x + 2,
    targetBox.y + targetBox.height / 2,
    { steps: 24 },
  );
  await expect(target).not.toHaveAttribute(
    "data-page-ref-nest-target",
    "true",
  );
  await expect(page.locator(".brain-col-drop-indicator")).toBeVisible();
  await page.mouse.up();
}

async function dragBlockToPoint(
  page: Page,
  source: Locator,
  point: { x: number; y: number },
  indicatorKind: "side" | "inside",
  finish: "drop" | "cancel" = "drop",
) {
  // A completed block drag leaves a NodeSelection, which can open the floating
  // formatting toolbar over the next source. Escape dismisses that transient UI
  // just as a user clicking back into the document would.
  await page.keyboard.press("Escape");
  await source.hover();
  await page.waitForTimeout(400);

  const handle = page.locator('.brain-block-handle[data-show="true"]');
  await expect(handle).toHaveCount(1);
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();
  if (!handleBox) throw new Error("Missing block handle geometry");

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY, { steps: 5 });
  await page.mouse.move(point.x, point.y, { steps: 24 });
  await page.waitForTimeout(100);

  const indicator = page.locator(
    `.brain-col-drop-indicator[data-kind="${indicatorKind}"]`,
  );
  await expect(indicator).toBeVisible();
  if (finish === "cancel") {
    await page.keyboard.press("Escape");
    await expect(indicator).toHaveCount(0);
    const editorWrapper = page
      .getByRole("textbox", { name: "Page content" })
      .locator("xpath=ancestor::div[contains(@class, 'relative')][1]");
    await expect(editorWrapper).not.toHaveAttribute("data-col-drop");
    await page.mouse.up();
    return;
  }
  await page.mouse.up();
  await expect(indicator).toHaveCount(0);
}

test("@release login, editor autosave, navigation flush, search, and mobile layout", async ({ page }) => {
  test.setTimeout(60_000);
  const browserProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      browserProblems.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserProblems.push(error.message));

  await login(page);

  const health = await page.request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  expect(await health.json()).toMatchObject({ status: "ok" });

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "E2E note", markdown: "First draft" },
  });
  expect(
    createdResponse.ok,
    `create failed with ${createdResponse.status}: ${JSON.stringify(createdResponse.body)}`,
  ).toBeTruthy();
  const created = createdResponse.body as { id: string };
  expect(
    (
      await browserJson(page, `/api/page/${created.id}`, {
        method: "PATCH",
        body: { tags: ["retrieval"] },
      })
    ).ok,
  ).toBeTruthy();

  await page.goto(`/p/${created.id}`);
  // `/p/[id]` compiles separately from the authenticated home route. A clean
  // CI runner can spend more than the default 5s on that first cold page.
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    "E2E note",
    { timeout: 20_000 },
  );
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();

  // Exercise the real Milkdown -> Shell -> debounce -> revision queue wiring.
  await content.fill("Second draft");
  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/page/${created.id}`);
      return (read.body as { markdown?: string }).markdown;
    })
    .toBe("Second draft");

  // Leave before the 700ms debounce. Navigation must flush this exact body.
  await content.fill("Third draft");
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page).toHaveURL("/");
  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/page/${created.id}`);
      return (read.body as { markdown?: string }).markdown;
    })
    .toBe("Third draft");

  await page.goto(`/p/${created.id}`);
  await expect(page.getByRole("textbox", { name: "Page content" })).toContainText(
    "Third draft",
  );

  await page.getByRole("button", { name: "Search" }).click();
  const palette = page.getByRole("combobox", { name: "Search and commands" });
  await expect(palette).toBeVisible();
  // Search terms need not be an exact phrase, and metadata filters must scope
  // body matches instead of disabling full-text retrieval.
  await palette.fill("tag:retrieval draft Third");
  await expect(
    page.getByRole("option").filter({ hasText: "E2E note" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${created.id}`);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.setViewportSize({ width: 320, height: 568 });
  const narrowOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(narrowOverflow).toBeLessThanOrEqual(0);
  // Optimistic concurrency deliberately uses 409 as a retry signal. Chromium
  // logs the handled network response as a generic console error even when the
  // save queue recovers and every persisted-body assertion above succeeds.
  const unexpectedBrowserProblems = browserProblems.filter(
    (problem) =>
      !problem.includes(
        "Failed to load resource: the server responded with a status of 409 (Conflict)",
      ),
  );
  expect(unexpectedBrowserProblems).toEqual([]);
});

test("exact internal page links stay local without hijacking native links", async ({
  page,
}) => {
  await login(page);
  const origin = new URL(page.url()).origin;

  const createPage = async (title: string, icon?: string) => {
    const response = await browserJson(page, "/api/page", {
      method: "POST",
      body: { title, icon },
    });
    expect(response.ok).toBeTruthy();
    return response.body as { id: string; icon: string; title: string };
  };
  const parent = await createPage("Internal link contract");
  const relativeTarget = await createPage(
    "Relative link destination",
    "🧭",
  );
  const absoluteTarget = await createPage("Absolute link destination");
  const pasteTarget = await createPage("Pasted link destination");

  const currentParent = await browserJson(page, `/api/page/${parent.id}`);
  const markdown = [
    `Relative [Stale relative](/p/${relativeTarget.id}) remains inline.`,
    `Absolute [Stale absolute](${origin}/p/${absoluteTarget.id}) remains inline.`,
    `Foreign [Foreign page](https://foreign.example/p/${relativeTarget.id}) remains external.`,
    `Query [Query variant](/p/${relativeTarget.id}?view=full) remains ordinary.`,
    `Hash [Hash variant](${origin}/p/${absoluteTarget.id}#section) remains ordinary.`,
  ].join("\n\n");
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: {
      markdown,
      rev: (currentParent.body as { rev: string }).rev,
    },
  });
  expect(seeded.ok).toBeTruthy();

  const assertLinkContract = async () => {
    const relative = page.locator(
      `a.brain-page-ref[data-page-ref="${relativeTarget.id}"]`,
    );
    const absolute = page.locator(
      `a.brain-page-ref[data-page-ref="${absoluteTarget.id}"]`,
    );
    const foreign = page.getByRole("link", {
      name: "Foreign page",
      exact: true,
    });
    const query = page.getByRole("link", {
      name: "Query variant",
      exact: true,
    });
    const hash = page.getByRole("link", {
      name: "Hash variant",
      exact: true,
    });
    await expect(relative).toHaveText(
      `${relativeTarget.icon} ${relativeTarget.title}`,
    );
    await expect(relative).toHaveAttribute("href", `/p/${relativeTarget.id}`);
    await expect(relative).not.toHaveClass(/brain-internal-page-link/);
    await expect(absolute).toHaveText(`📄 ${absoluteTarget.title}`);
    await expect(absolute).toHaveAttribute("href", `/p/${absoluteTarget.id}`);
    for (const ordinary of [foreign, query, hash]) {
      await expect(ordinary).not.toHaveClass(/brain-page-ref/);
      await expect(ordinary).not.toHaveClass(/brain-internal-page-link/);
    }
    await expect(query).toHaveAttribute(
      "href",
      `/p/${relativeTarget.id}?view=full`,
    );
    await expect(hash).toHaveAttribute(
      "href",
      `${origin}/p/${absoluteTarget.id}#section`,
    );
    return { relative, absolute, ordinary: [foreign, query, hash] };
  };

  await page.goto(`/p/${parent.id}`);
  let links = await assertLinkContract();

  const plainPrimaryClick = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  for (const ordinary of links.ordinary) {
    for (const modifier of [
      { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
      { metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
      { metaKey: false, ctrlKey: false, shiftKey: true, altKey: false },
      { metaKey: false, ctrlKey: false, shiftKey: false, altKey: true },
    ]) {
      expect(
        await linkClickWasPrevented(ordinary, {
          button: 0,
          ...modifier,
        }),
      ).toBe(false);
    }
    expect(
      await linkClickWasPrevented(ordinary, {
        ...plainPrimaryClick,
        button: 1,
      }),
    ).toBe(false);
    expect(
      await linkClickWasPrevented(ordinary, plainPrimaryClick, {
        target: "_blank",
      }),
    ).toBe(false);
    expect(
      await linkClickWasPrevented(ordinary, plainPrimaryClick, {
        download: "",
      }),
    ).toBe(false);
  }

  await links.relative.click();
  await expect(page).toHaveURL(`/p/${relativeTarget.id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    "Relative link destination",
  );
  await page.goBack();
  await expect(page).toHaveURL(`/p/${parent.id}`);

  links = await assertLinkContract();
  await links.absolute.click();
  await expect(page).toHaveURL(`/p/${absoluteTarget.id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    "Absolute link destination",
  );
  await page.goBack();
  await expect(page).toHaveURL(`/p/${parent.id}`);

  const editor = page.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await editor.evaluate((element, absolutePageUrl) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", absolutePageUrl);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  }, `${origin}/p/${pasteTarget.id}`);
  const pastedRef = page.locator(
    `a.brain-page-ref[data-page-ref="${pasteTarget.id}"]`,
  );
  await expect(pastedRef).toHaveText(`📄 ${pasteTarget.title}`);
  await expect(pastedRef).toHaveAttribute("href", `/p/${pasteTarget.id}`);
  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/page/${parent.id}`);
      return (read.body as { markdown?: string }).markdown ?? "";
    })
    .toContain(`[📄 ${pasteTarget.title}](/p/${pasteTarget.id})`);
  const persisted = await browserJson(page, `/api/page/${parent.id}`);
  expect((persisted.body as { markdown: string }).markdown).not.toContain(
    `${origin}/p/${pasteTarget.id}`,
  );
  await pastedRef.click();
  await expect(page).toHaveURL(`/p/${pasteTarget.id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    pasteTarget.title,
  );
});

test("Settings dismisses and restores focus", async ({ page }) => {
  await login(page);
  // run from a page: the hub autofocuses its quick-capture field on every
  // mount, which would race the Settings-row focus this test pins down
  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Settings focus return" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  const sidebar = page.locator("aside.brain-sidebar");
  const settingsTrigger = sidebar.getByRole("button", {
    name: "Settings",
    exact: true,
  });
  const sectionList = sidebar.getByRole("navigation", {
    name: "Settings sections",
  });

  // Settings is a surface with a real URL, not a dialog. Opening it pushes
  // one history entry; the sidebar slot swaps to the section list.
  // Next's dev overlay can overlap this control; production has no such portal.
  await settingsTrigger.focus();
  await settingsTrigger.dispatchEvent("click");
  await expect(page).toHaveURL("/settings/appearance");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(sectionList).toBeVisible();
  await expect(
    sectionList.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(settingsTrigger).toHaveAttribute("aria-current", "page");

  // desktop section change rewrites in place — Back still leaves in one step
  await sectionList.getByRole("button", { name: "Data", exact: true }).click();
  await expect(page).toHaveURL("/settings/data");

  // Esc pops the one entry: the previous page returns and focus lands back
  // on the Settings row
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`/p/${created.id}`);
  await expect(sectionList).toBeHidden();
  await expect(settingsTrigger).toBeFocused();

  // browser Forward re-enters the surface at its URL; Back leaves it again
  await page.goForward();
  await expect(page).toHaveURL("/settings/data");
  await expect(sectionList).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`/p/${created.id}`);
  await expect(settingsTrigger).toBeFocused();

  // the slot's explicit way back: the "Back" row above the section
  // list shares the close semantics with Esc
  await settingsTrigger.dispatchEvent("click");
  await expect(page).toHaveURL("/settings/appearance");
  await sidebar.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(`/p/${created.id}`);
});

test("Settings opened from Search restores focus to the Search trigger", async ({
  page,
}) => {
  await login(page);

  const searchTrigger = page.getByRole("button", { name: "Search" });
  await searchTrigger.click();
  const palette = page.getByRole("combobox", { name: "Search and commands" });
  await expect(palette).toBeVisible();
  await palette.fill("Settings");
  await page.getByRole("option", { name: "Settings", exact: true }).click();

  // the palette action navigates to the surface and closes the palette
  // without restoring focus to its trigger (the destination owns focus now)
  await expect(page).toHaveURL("/settings/appearance");
  await expect(palette).toBeHidden();
  const settingsTrigger = page
    .locator("aside.brain-sidebar")
    .getByRole("button", { name: "Settings", exact: true });
  await expect(settingsTrigger).toHaveAttribute("aria-current", "page");

  // Esc leaves the surface; focus lands on the Settings row, not Search
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  await expect(settingsTrigger).toBeFocused();
});

test("@mobile coarse targets, Settings, and editor chrome fit at 390 and 320", async ({
  page,
}) => {
  await login(page);
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(
    true,
  );

  const boardResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Mobile touch board" },
  });
  expect(boardResponse.ok).toBeTruthy();
  const board = boardResponse.body as { id: string };
  expect(
    (
      await browserJson(page, `/api/page/${board.id}`, {
        method: "PATCH",
        body: { view: "board", sections: ["Backlog"] },
      })
    ).ok,
  ).toBeTruthy();

  const cardResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: board.id, title: "Touch target card" },
  });
  expect(cardResponse.ok).toBeTruthy();
  const card = cardResponse.body as { id: string };
  expect(
    (
      await browserJson(page, `/api/page/${card.id}`, {
        method: "PATCH",
        body: {
          tags: [
            "alpha-long-tag",
            "beta-long-tag",
            "gamma-long-tag",
            "delta-long-tag",
          ],
        },
      })
    ).ok,
  ).toBeTruthy();

  await page.goto(`/p/${board.id}`);
  const columnActions = page.getByRole("button", { name: "Column actions" });
  const newCard = page
    .getByRole("article")
    .getByRole("button", { name: "New", exact: true });
  await expect(columnActions).toBeVisible();
  await expect(newCard).toBeVisible();
  await expect(columnActions).not.toHaveClass(/brain-touch-hit/);
  const [columnRect] = await touchRects(columnActions);
  const [newRect] = await touchRects(newCard);
  expect(overlaps(columnRect, newRect)).toBe(false);

  const tagButtons = page.locator('button[title="Remove tag"]');
  await expect(tagButtons).toHaveCount(4);
  const tagRects = await touchRects(tagButtons);
  expect(new Set(tagRects.map((rect) => Math.round(rect.top))).size).toBeGreaterThan(
    1,
  );
  for (let i = 0; i < tagRects.length; i += 1) {
    for (let j = i + 1; j < tagRects.length; j += 1) {
      expect(overlaps(tagRects[i], tagRects[j])).toBe(false);
    }
  }

  const primaryNavigation = page.getByLabel("Primary");
  await primaryNavigation
    .getByRole("button", { name: "Pages", exact: true })
    .click();
  const mobilePages = page.getByTestId("mobile-pages-view");
  await mobilePages.getByRole("button", { name: "Settings", exact: true }).click();
  // /settings is a full-screen page of the shell, not a dialog: the root
  // list first, one section per drill-down entry
  await expect(page).toHaveURL("/settings");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const settingsRoot = page.getByTestId("mobile-settings-root");
  const settingsBack = settingsRoot.getByRole("button", {
    name: "Back",
    exact: true,
  });
  await expect(settingsRoot).toBeVisible();
  await expectReal44pxTarget(settingsBack);
  for (const label of [
    "Appearance",
    "Mail",
    "Connections",
    "Sharing",
    "Data",
    "Account",
  ]) {
    await expect(settingsRoot.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  const assertNoHorizontalOverflow = async () => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
  };
  await assertNoHorizontalOverflow();
  await settingsRoot.getByRole("button", { name: "Mail", exact: true }).click();
  await expect(page).toHaveURL("/settings/mail");
  await expect(page.getByTestId("mobile-settings-detail")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/settings");
  await expect(settingsRoot).toBeVisible();

  await page.setViewportSize({ width: 320, height: 568 });
  await assertNoHorizontalOverflow();

  await page.goBack();
  await expect(settingsRoot).toBeHidden();
  await expect(mobilePages).toBeVisible();

  await mobilePages.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settingsRoot).toBeVisible();
  await settingsRoot.getByRole("button", { name: "Back", exact: true }).click();
  await expect(settingsRoot).toBeHidden();

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
  ).toBe(true);
  await mobilePages.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settingsRoot).toBeVisible();
  const reducedMotionDurations = await settingsRoot.evaluate((element) => ({
    animation: getComputedStyle(element).animationDuration,
    transition: getComputedStyle(element).transitionDuration,
  }));
  const reducedDurationValues = ["0.01ms", "0.00001s", "1e-05s"];
  expect(reducedDurationValues).toContain(reducedMotionDurations.animation);
  expect(reducedDurationValues).toContain(reducedMotionDurations.transition);
  await page.keyboard.press("Escape");
  await expect(settingsRoot).toBeHidden();
  await expect(mobilePages).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mobilePages.getByRole("button", { name: "Editor", exact: true }).click();

  const documentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "Mobile editor chrome",
      markdown: "Toolbar selection\n\n[External link](https://example.com)",
    },
  });
  expect(documentResponse.ok).toBeTruthy();
  const documentPage = documentResponse.body as { id: string };
  const childResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: documentPage.id, title: "Nested page" },
  });
  expect(childResponse.ok).toBeTruthy();
  const child = childResponse.body as { id: string };
  const documentBefore = await browserJson(page, `/api/page/${documentPage.id}`);
  expect(
    (
      await browserJson(page, `/api/page/${documentPage.id}`, {
        method: "PUT",
        body: {
          markdown: [
            "Toolbar selection",
            "[External link](https://example.com)",
            `[Nested page](/p/${child.id})`,
          ].join("\n\n"),
          rev: (documentBefore.body as { rev: string }).rev,
        },
      })
    ).ok,
  ).toBe(true);

  await page.goto(`/p/${documentPage.id}`);
  const pageRef = page.locator("a.brain-page-ref", { hasText: "Nested page" });
  await expect(pageRef).toBeVisible();
  expect(
    await pageRef.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderBottomStyle: style.borderBottomStyle,
        borderBottomWidth: style.borderBottomWidth,
        textDecorationLine: style.textDecorationLine,
      };
    }),
  ).toEqual({
    borderBottomStyle: "none",
    borderBottomWidth: "0px",
    textDecorationLine: "none",
  });
  expect(
    await page
      .getByRole("link", { name: "External link" })
      .evaluate((element) => getComputedStyle(element).borderBottomWidth),
  ).toBe("1px");

  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  const title = page.getByRole("textbox", { name: "Page title" });
  await title.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(content).toBeFocused();
  expect(
    await content.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        focusVisible: element.matches(":focus-visible"),
        keyboardModality: document.documentElement.dataset.kbd,
        outlineStyle: style.outlineStyle,
      };
    }),
  ).toEqual({
    focusVisible: true,
    keyboardModality: "true",
    outlineStyle: "none",
  });
  await content.selectText();
  const aiAction = page.getByRole("button", { name: "AI", exact: true });
  await expect(aiAction).toBeVisible();
  const toolbarScroller = aiAction.locator("..");
  await expect(toolbarScroller).toHaveClass(/\bbrain-hscroll\b/);
  const scrollMetrics = await toolbarScroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return {
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollbarWidth: getComputedStyle(element).getPropertyValue(
        "scrollbar-width",
      ),
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(scrollMetrics.overflowX).toBe("auto");
  expect(scrollMetrics.scrollbarWidth).toBe("none");
  expect(scrollMetrics.scrollWidth).toBeGreaterThan(scrollMetrics.clientWidth);
  expect(scrollMetrics.scrollLeft).toBeGreaterThan(0);
});

test("@release page-reference blocks reorder repeatedly and persist", async ({ page }) => {
  await login(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Repeated page-ref reorder" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };

  const createChild = async (title: string) => {
    const response = await browserJson(page, "/api/page", {
      method: "POST",
      body: { parentId: parent.id, title },
    });
    expect(response.ok).toBeTruthy();
    return response.body as { id: string };
  };
  const health = await createChild("Health");
  const tone = await createChild("Tone of Voice");
  const delta = await createChild("Delta");

  const initialIds = [health.id, tone.id, delta.id];
  const initialMarkdown = initialIds
    .map(
      (id, index) =>
        `[${["Health", "Tone of Voice", "Delta"][index]}](/p/${id})`,
    )
    .join("\n\n");
  const currentParent = await browserJson(page, `/api/page/${parent.id}`);
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: {
      markdown: initialMarkdown,
      rev: (currentParent.body as { rev: string }).rev,
    },
  });
  expect(seeded.ok).toBeTruthy();

  const persistedOrder = async () => {
    const read = await browserJson(page, `/api/page/${parent.id}`);
    const markdown = (read.body as { markdown?: string }).markdown ?? "";
    return [...markdown.matchAll(/\/p\/([\w-]+)/g)].map((match) => match[1]);
  };

  await page.goto(`/p/${parent.id}`);
  await expect(page.locator("a.brain-page-ref")).toHaveCount(3);
  expect(await pageRefOrder(page)).toEqual(initialIds);

  // Delta before Health -> Delta, Health, Tone.
  await dragPageRefBefore(page, delta.id, health.id);
  const first = [delta.id, health.id, tone.id];
  await expect.poll(() => pageRefOrder(page)).toEqual(first);
  await expect.poll(persistedOrder).toEqual(first);

  // Tone before Delta, without a reload -> Tone, Delta, Health.
  await dragPageRefBefore(page, tone.id, delta.id);
  const second = [tone.id, delta.id, health.id];
  await expect.poll(() => pageRefOrder(page)).toEqual(second);
  await expect.poll(persistedOrder).toEqual(second);

  // Health before Tone, still without a reload -> original order.
  await dragPageRefBefore(page, health.id, tone.id);
  await expect.poll(() => pageRefOrder(page)).toEqual(initialIds);
  await expect.poll(persistedOrder).toEqual(initialIds);

  await page.reload();
  await expect(page.locator("a.brain-page-ref")).toHaveCount(3);
  expect(await pageRefOrder(page)).toEqual(initialIds);
});

test("@release centre-dropping a page reference nests it without Trash and failed moves stay untouched", async ({
  page,
}) => {
  await login(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Page-ref nesting parent" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };

  const createChild = async (title: string) => {
    const response = await browserJson(page, "/api/page", {
      method: "POST",
      body: { parentId: parent.id, title },
    });
    expect(response.ok).toBeTruthy();
    return response.body as { id: string };
  };
  const source = await createChild("Source page");
  const target = await createChild("Target page");
  const failedSource = await createChild("Failed source");
  const failedTarget = await createChild("Failed target");

  const initialMarkdown = [
    "Intro prose stays in place.",
    `[Source page](/p/${source.id})`,
    "## Structure",
    `[Target page](/p/${target.id})`,
    `[Failed source](/p/${failedSource.id})`,
    `[Failed target](/p/${failedTarget.id})`,
    "Tail prose stays in place.",
  ].join("\n\n");
  const currentParent = await browserJson(page, `/api/page/${parent.id}`);
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: {
      markdown: initialMarkdown,
      rev: (currentParent.body as { rev: string }).rev,
    },
  });
  expect(seeded.ok).toBeTruthy();

  await page.goto(`/p/${parent.id}`);
  await expect(page.locator("a.brain-page-ref")).toHaveCount(4);
  await dragPageRefInto(page, source.id, target.id);

  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, source.id)?.parentId;
    })
    .toBe(target.id);
  await expect
    .poll(async () => {
      const response = await browserJson(page, `/api/page/${parent.id}`);
      return (response.body as { markdown: string }).markdown;
    })
    .not.toContain(`/p/${source.id}`);
  const undoModifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${undoModifier}+z`);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);

  // The parent-body save owns the old delete behaviour. Give its post-save
  // hook time to run so this assertion proves nesting never entered Trash.
  await page.waitForTimeout(500);
  const trashAfterSuccess = await browserJson(page, "/api/trash");
  expect(
    (trashAfterSuccess.body as { trash: { id: string }[] }).trash.some(
      (entry) => entry.id === source.id,
    ),
  ).toBe(false);

  await page.route("**/api/page-ref/nest", async (route) => {
    const body = route.request().postDataJSON() as { sourceId?: string };
    if (body.sourceId === failedSource.id) {
      await route.fulfill({ status: 500, body: "move failed" });
      return;
    }
    await route.continue();
  });
  await dragPageRefInto(page, failedSource.id, failedTarget.id);

  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${failedSource.id}"]`),
  ).toHaveCount(1);
  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, failedSource.id)?.parentId;
    })
    .toBe(parent.id);
  const parentAfterFailure = await browserJson(page, `/api/page/${parent.id}`);
  expect((parentAfterFailure.body as { markdown: string }).markdown).toContain(
    `/p/${failedSource.id}`,
  );
  const trashAfterFailure = await browserJson(page, "/api/trash");
  expect(
    (trashAfterFailure.body as { trash: { id: string }[] }).trash.some(
      (entry) => entry.id === failedSource.id,
    ),
  ).toBe(false);
  await page.unroute("**/api/page-ref/nest");

  await page.reload();
  await expect(page.getByText("Intro prose stays in place.")).toBeVisible();
  await expect(page.getByText("Tail prose stays in place.")).toBeVisible();
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);

  await page
    .locator(`a.brain-page-ref[data-page-ref="${target.id}"]`)
    .click();
  await expect(page).toHaveURL(`/p/${target.id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    "Target page",
  );
  await expect(
    page.locator('.ProseMirror[contenteditable="true"]'),
  ).toBeVisible();
  // The move is visible in both canonical surfaces: the hierarchy and the
  // destination page body. This keeps a centre-to-sidebar move from creating a
  // child that exists only in navigation.
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(1);
  const targetAfterMove = await browserJson(page, `/api/page/${target.id}`);
  expect((targetAfterMove.body as { markdown: string }).markdown).toContain(
    `/p/${source.id}`,
  );
  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, source.id)?.parentId;
    })
    .toBe(target.id);
});

test("dragging a page-ref title into target-row whitespace nests and persists", async ({
  page,
}) => {
  await login(page);
  const { parent, children } = await createPageRefNestingFixture(page, [
    "Title drag source",
    "Title drag target",
  ]);
  const [source, target] = children;

  await page.goto(`/p/${parent.id}`);
  await expect(page.locator("a.brain-page-ref")).toHaveCount(2);
  await dragPageRefTitleIntoRowWhitespace(page, source.id, target.id);

  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, source.id)?.parentId;
    })
    .toBe(target.id);
  await expect
    .poll(async () => {
      const response = await browserJson(page, `/api/page/${parent.id}`);
      return (response.body as { markdown: string }).markdown;
    })
    .not.toContain(`/p/${source.id}`);

  await page.waitForTimeout(500);
  const trash = await browserJson(page, "/api/trash");
  expect(
    (trash.body as { trash: { id: string }[] }).trash.some(
      (entry) => entry.id === source.id,
    ),
  ).toBe(false);

  await page.reload();
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);
  await page
    .locator(`a.brain-page-ref[data-page-ref="${target.id}"]`)
    .click();
  await expect(page).toHaveURL(`/p/${target.id}`);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(1);
});

test("title-dropping an already nested stale ref only cleans the grandparent body", async ({
  page,
}) => {
  await login(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Stale page-ref grandparent" },
  });
  const parent = parentResponse.body as { id: string };
  const targetResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Cleanup target" },
  });
  const target = targetResponse.body as { id: string };
  const sourceResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: target.id, title: "Already nested source" },
  });
  const source = sourceResponse.body as { id: string };
  const current = await browserJson(page, `/api/page/${parent.id}`);
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: {
      markdown: [
        `[Already nested source](/p/${source.id})`,
        `[Cleanup target](/p/${target.id})`,
      ].join("\n\n"),
      rev: (current.body as { rev: string }).rev,
    },
  });
  expect(seeded.ok).toBeTruthy();
  const seededRev = (seeded.body as { rev: string }).rev;
  const treeBefore = await browserJson(page, "/api/tree");
  const targetBefore = findE2ETreeNode(
    (treeBefore.body as { tree: E2ETreeNode[] }).tree,
    target.id,
  );
  const childOrderBefore = targetBefore?.children.map((child) => child.id);

  await page.goto(`/p/${parent.id}`);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(1);
  await dragPageRefTitleIntoRowWhitespace(
    page,
    source.id,
    target.id,
    true,
  );

  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await browserJson(page, `/api/page/${parent.id}`);
      return response.body as { markdown: string; rev: string };
    })
    .toEqual(
      expect.objectContaining({
        markdown: expect.not.stringContaining(`/p/${source.id}`),
        rev: expect.not.stringMatching(seededRev),
      }),
    );
  const treeAfter = await browserJson(page, "/api/tree");
  const nextTree = (treeAfter.body as { tree: E2ETreeNode[] }).tree;
  expect(findE2ETreeNode(nextTree, source.id)?.parentId).toBe(target.id);
  expect(findE2ETreeNode(nextTree, target.id)?.children.map((child) => child.id)).toEqual(
    childOrderBefore,
  );
  const trash = await browserJson(page, "/api/trash");
  expect(
    (trash.body as { trash: { id: string }[] }).trash.some(
      (entry) => entry.id === source.id,
    ),
  ).toBe(false);

  await page.reload();
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);
  await page
    .locator(`a.brain-page-ref[data-page-ref="${target.id}"]`)
    .click();
  await expect(page).toHaveURL(`/p/${target.id}`);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(1);
});

test("stale-ref cleanup does not reconcile a shifted occurrence as success", async ({
  page,
}) => {
  await login(page);
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Stale cleanup reconciliation parent" },
  });
  const parent = parentResponse.body as { id: string };
  const targetResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Reconciliation target" },
  });
  const target = targetResponse.body as { id: string };
  const sourceResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: target.id, title: "Reconciliation source" },
  });
  const source = sourceResponse.body as { id: string };
  const staleRef = `[Reconciliation source](/p/${source.id})`;
  const targetRef = `[Reconciliation target](/p/${target.id})`;
  const current = await browserJson(page, `/api/page/${parent.id}`);
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: {
      markdown: [staleRef, targetRef].join("\n\n"),
      rev: (current.body as { rev: string }).rev,
    },
  });
  expect(seeded.ok).toBeTruthy();

  await page.goto(`/p/${parent.id}`);
  let intercepted = false;
  await page.route("**/api/page-ref/nest", async (route) => {
    intercepted = true;
    const latest = await browserJson(page, `/api/page/${parent.id}`);
    const latestBody = latest.body as {
      markdown: string;
      rev: string;
    };
    const unrelated = await browserJson(page, `/api/page/${parent.id}`, {
      method: "PUT",
      body: {
        markdown: [
          `[Inserted same-source ref](/p/${source.id})`,
          latestBody.markdown,
          "Unrelated concurrent edit",
        ].join("\n\n"),
        rev: latestBody.rev,
      },
    });
    expect(unrelated.ok).toBe(true);
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "simulated_lost_response" }),
    });
  });

  await dragPageRefTitleIntoRowWhitespace(page, source.id, target.id);
  await expect.poll(() => intercepted).toBe(true);
  await expect(page.getByText("Couldn't move. Nothing changed.")).toBeVisible();
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(2);

  const parentAfter = await browserJson(page, `/api/page/${parent.id}`);
  expect((parentAfter.body as { markdown: string }).markdown).toContain(
    staleRef,
  );
  expect((parentAfter.body as { markdown: string }).markdown).toContain(
    "Unrelated concurrent edit",
  );
  expect((parentAfter.body as { markdown: string }).markdown).toContain(
    `[Inserted same-source ref](/p/${source.id})`,
  );
  const treeAfter = await browserJson(page, "/api/tree");
  expect(
    findE2ETreeNode(
      (treeAfter.body as { tree: E2ETreeNode[] }).tree,
      source.id,
    )?.parentId,
  ).toBe(target.id);
  await page.unroute("**/api/page-ref/nest");
});

test("authored and structural child links are one canonical page-ref entity", async ({
  page,
}) => {
  await login(page);
  const authoredTitle =
    "Authored nested page with a deliberately long title that wraps on narrow screens";
  const derivedTitle =
    "Derived nested page with a deliberately long title that wraps on narrow screens";
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Canonical nested pages" },
  });
  const parent = parentResponse.body as { id: string };
  const authoredResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: authoredTitle },
  });
  const derivedResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: derivedTitle },
  });
  const authoredChild = authoredResponse.body as { id: string };
  const derivedChild = derivedResponse.body as { id: string };
  const emptyParent = await browserJson(page, `/api/page/${parent.id}`);
  const explicitRef = `[Stale authored label](/p/${authoredChild.id})`;
  expect(
    (
      await browserJson(page, `/api/page/${parent.id}`, {
        method: "PUT",
        body: {
          markdown: explicitRef,
          rev: (emptyParent.body as { rev: string }).rev,
        },
      })
    ).ok,
  ).toBe(true);

  await page.goto(`/p/${parent.id}`);
  const article = page.locator("article.brain-page-article");
  const authored = page.locator(
    `.ProseMirror a.brain-page-ref[data-page-ref="${authoredChild.id}"]`,
  );
  const derivedWrapper = page.locator("[data-derived-page-refs]");
  const derived = derivedWrapper.locator(
    `a.brain-page-ref[data-page-ref="${derivedChild.id}"]`,
  );
  await expect(authored).toHaveText(`📄 ${authoredTitle}`);
  await expect(derived).toHaveText(`📄 ${derivedTitle}`);
  await expect(derived).toHaveAttribute("href", `/p/${derivedChild.id}`);
  // One icon element in each, so a title that wraps indents under the title
  // and not under the emoji. Nothing else in either link is wrapped.
  await expect(authored.locator("span")).toHaveCount(1);
  await expect(derived.locator("span")).toHaveCount(1);
  await expect(authored.locator("span.brain-page-ref-icon")).toHaveText("📄");
  await expect(derived.locator("span.brain-page-ref-icon")).toHaveText("📄");
  await expect(article.locator('section[aria-label="Subpages"]')).toHaveCount(0);
  await expect(article.locator("[data-subpages-count]")).toHaveCount(0);
  await expect(article.getByText("Subpages", { exact: true })).toHaveCount(0);
  await expect(derivedWrapper.locator("ul, ol, li, header, h2")).toHaveCount(0);
  // The tail is ruled off and named. Still no Subpages widget — no list, no
  // heading, no count — but not document content either: while it said
  // nothing, a child the body had taken and one it had not were identical.
  await expect(derivedWrapper).toHaveCSS("border-top-width", "1px");
  await expect(
    derivedWrapper.getByText("Not in this page", { exact: true }),
  ).toHaveCount(1);

  const pageRefStyle = async (locator: Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const rowRect = element.parentElement?.getBoundingClientRect();
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        padding: [
          style.paddingTop,
          style.paddingRight,
          style.paddingBottom,
          style.paddingLeft,
        ],
        margin: [
          style.marginTop,
          style.marginRight,
          style.marginBottom,
          style.marginLeft,
        ],
        borderRadius: style.borderRadius,
        borderBottomWidth: style.borderBottomWidth,
        color: style.color,
        cursor: style.cursor,
        textDecorationLine: style.textDecorationLine,
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        linkHeight: Math.round(rect.height * 10) / 10,
        rowHeight: Math.round((rowRect?.height ?? 0) * 10) / 10,
        left: Math.round(rect.left * 10) / 10,
      };
    });
  // Read the ink tokens where the links live: the shell re-points --ink at the
  // v2 ramp, so reading them off <body> would compare against another palette.
  const ink = await article.evaluate((host) => {
    const read = (token: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      host.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    return { primary: read("--ink"), oneStepDown: read("--ink-2") };
  });
  // The two links are one entity: same type, same box, same affordance, in the
  // same column. Two things about a tail row are deliberately not the same,
  // and the rule that draws them says why (`milkdown.css`): a child the body
  // has not taken yet reads one step down in ink, and its row stands a step
  // taller because the row — not the link — carries the filing control.
  const expectOneEntity = (
    derivedStyle: Awaited<ReturnType<typeof pageRefStyle>>,
    authoredStyle: Awaited<ReturnType<typeof pageRefStyle>>,
  ) => {
    const {
      color: derivedColor,
      rowHeight: derivedRowHeight,
      ...derivedBox
    } = derivedStyle;
    const {
      color: authoredColor,
      rowHeight: authoredRowHeight,
      ...authoredBox
    } = authoredStyle;
    expect(derivedBox).toEqual(authoredBox);
    expect(authoredColor).toBe(ink.primary);
    expect(derivedColor).toBe(ink.oneStepDown);
    expect(derivedRowHeight).toBeGreaterThan(authoredRowHeight);
  };

  const authoredDesktop = await pageRefStyle(authored);
  const derivedDesktop = await pageRefStyle(derived);
  expectOneEntity(derivedDesktop, authoredDesktop);
  expect(authoredDesktop).toMatchObject({
    fontSize: "16px",
    fontWeight: "500",
    lineHeight: "24px",
    padding: ["0px", "3px", "0px", "3px"],
    margin: ["0px", "-1px", "0px", "-1px"],
    borderRadius: "4px",
    borderBottomWidth: "0px",
    cursor: "pointer",
    textDecorationLine: "none",
    whiteSpace: "nowrap",
  });

  const authoredRest = await authored.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await authored.hover();
  await page.waitForTimeout(180);
  const authoredHover = await authored.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(authoredHover).not.toBe(authoredRest);
  await derived.hover();
  await page.waitForTimeout(180);
  // The same fill, one object wider: in the tail the row takes the hover, so
  // the name and the control it reveals light up together, not separately.
  const derivedRow = derived.locator("xpath=..");
  expect(
    await derivedRow.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe(authoredHover);
  expect(
    await derived.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe(authoredRest);

  const integratedLayout = await page.evaluate(
    ({ authoredId }) => {
      const authoredParagraph = document
        .querySelector<HTMLElement>(`a[data-page-ref="${authoredId}"]`)
        ?.closest<HTMLElement>("p.brain-page-ref-only");
      const trailingBlock =
        authoredParagraph?.nextElementSibling as HTMLElement | null;
      const wrapper = document.querySelector<HTMLElement>(
        "[data-derived-page-refs]",
      );
      if (!authoredParagraph || !trailingBlock || !wrapper) return null;
      return {
        trailingBlockIsWritableParagraph: trailingBlock.matches(
          "p:not(.brain-page-ref-only)",
        ),
        trailingBlockHeight:
          Math.round(trailingBlock.getBoundingClientRect().height * 10) / 10,
        trailingBlockToDerivedGap: Math.round(
          wrapper.getBoundingClientRect().top -
            trailingBlock.getBoundingClientRect().bottom,
        ),
        overlapsTrailingBlock:
          wrapper.getBoundingClientRect().top <
          trailingBlock.getBoundingClientRect().bottom,
        derivedOwnsHandle:
          wrapper.querySelector(".brain-block-handle") !== null,
      };
    },
    { authoredId: authoredChild.id },
  );
  expect(integratedLayout).toMatchObject({
    trailingBlockIsWritableParagraph: true,
    trailingBlockToDerivedGap: 24,
    overlapsTrailingBlock: false,
    derivedOwnsHandle: false,
  });
  expect(integratedLayout?.trailingBlockHeight).toBeGreaterThanOrEqual(20);

  let parentBodyWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === `/api/page/${parent.id}`
    ) {
      parentBodyWrites += 1;
    }
  });
  await derived.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Move to trash" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove reference" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename page" });
  await expect(rename.getByLabel("Page title")).toHaveValue(derivedTitle);
  await rename.getByRole("button", { name: "Cancel" }).click();
  await expect(rename).toBeHidden();
  expect(parentBodyWrites).toBe(0);

  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 720 });
  const authoredNarrow = await pageRefStyle(authored);
  const derivedNarrow = await pageRefStyle(derived);
  expectOneEntity(derivedNarrow, authoredNarrow);
  expect(authoredNarrow).toMatchObject({
    fontSize: "16px",
    fontWeight: "500",
    lineHeight: "24px",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  });
  expect(
    await page.evaluate(
      ({ authoredId, derivedId }) => {
        const links = [authoredId, derivedId].map((id) =>
          document.querySelector<HTMLElement>(`a[data-page-ref="${id}"]`),
        );
        return {
          documentFits: document.documentElement.scrollWidth <= window.innerWidth,
          linksFit: links.every((link) => {
            const rect = link?.getBoundingClientRect();
            return !!rect && rect.left >= 0 && rect.right <= window.innerWidth;
          }),
        };
      },
      { authoredId: authoredChild.id, derivedId: derivedChild.id },
    ),
  ).toEqual({ documentFits: true, linksFit: true });

  expect(
    (
      await browserJson(page, `/api/page/${parent.id}`, {
        method: "PATCH",
        body: { smallText: true },
      })
    ).ok,
  ).toBe(true);
  await page.reload();
  // Small text is a desktop register. Under 767px the setting deliberately
  // keeps the body at 16px so iOS does not zoom a focused editable
  // (`milkdown.css`), and this test was still standing at 320px — it was
  // reading that guard and calling it the 14px register. Assert the guard
  // where we are, then measure the register on the desktop it belongs to.
  expect((await pageRefStyle(authored)).fontSize).toBe("16px");
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  const authoredSmall = await pageRefStyle(authored);
  const derivedSmall = await pageRefStyle(derived);
  expectOneEntity(derivedSmall, authoredSmall);
  expect(authoredSmall).toMatchObject({
    fontSize: "14px",
    fontWeight: "500",
    lineHeight: "21px",
    whiteSpace: "nowrap",
    overflowWrap: "break-word",
  });
  const persisted = await browserJson(page, `/api/page/${parent.id}`);
  expect((persisted.body as { markdown: string }).markdown).toBe(explicitRef);
});

test("the synthesized direct-child API nests without materializing parent refs", async ({
  page,
}) => {
  await login(page);
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Synthesized page-ref parent" },
  });
  const parent = parentResponse.body as { id: string };
  const sourceResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Synthesized source" },
  });
  const targetResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Synthesized target" },
  });
  const source = sourceResponse.body as { id: string };
  const target = targetResponse.body as { id: string };
  const before = await browserJson(page, `/api/page/${parent.id}`);
  expect((before.body as { markdown: string }).markdown).toBe("");
  const nested = await browserJson(page, "/api/page-ref/nest", {
    method: "POST",
    body: {
      sourceId: source.id,
      targetId: target.id,
      parentPageId: parent.id,
      expectedParentRev: (before.body as { rev: string }).rev,
      sourceOccurrence: null,
      sourceFingerprint: null,
      scope: "sibling",
    },
  });
  expect(nested.ok).toBe(true);

  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, source.id)?.parentId;
    })
    .toBe(target.id);
  const after = await browserJson(page, `/api/page/${parent.id}`);
  expect((after.body as { markdown: string }).markdown).toBe("");
  const targetAfter = await browserJson(page, `/api/page/${target.id}`);
  expect((targetAfter.body as { markdown: string }).markdown).toContain(
    `/p/${source.id}`,
  );
});

test("page-ref nesting serializes rapid drops and survives navigation", async ({
  page,
}) => {
  await login(page);
  const { parent, children } = await createPageRefNestingFixture(page, [
    "First source",
    "First target",
    "Second source",
    "Second target",
  ]);
  const [firstSource, firstTarget, secondSource, secondTarget] = children;
  await page.goto(`/p/${parent.id}`);
  await expect(page.locator("a.brain-page-ref")).toHaveCount(4);

  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let nestRequests = 0;
  await page.route("**/api/page-ref/nest", async (route) => {
    nestRequests += 1;
    if (nestRequests === 1) await firstMayFinish;
    await route.continue();
  });

  await dragPageRefInto(page, firstSource.id, firstTarget.id);
  const pendingEditor = page.locator(
    '.milkdown .ProseMirror[aria-label="Page content"]',
  );
  await expect(pendingEditor).toHaveAttribute("contenteditable", "false");
  await attemptPageRefDragWhileFrozen(
    page,
    secondSource.id,
    secondTarget.id,
  );
  expect(nestRequests).toBe(1);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${secondSource.id}"]`),
  ).toHaveCount(1);

  // Leave the editor while the accepted server-first composite request is in
  // flight. Navigation remains available, while a second document mutation is
  // blocked until the first result settles.
  await page
    .locator(`a.brain-page-ref[data-page-ref="${secondTarget.id}"]`)
    .click();
  await expect(page).toHaveURL(`/p/${secondTarget.id}`);
  releaseFirst();

  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, firstSource.id)?.parentId;
    })
    .toBe(firstTarget.id);
  await page.unroute("**/api/page-ref/nest");

  await page.goto(`/p/${parent.id}`);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${firstSource.id}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${secondSource.id}"]`),
  ).toHaveCount(1);
});

test("delayed failed nesting stays read-only across away/back navigation and unfreezes unchanged", async ({
  page,
}) => {
  await login(page);
  const { parent, children } = await createPageRefNestingFixture(page, [
    "Failed navigation source",
    "Failed navigation target",
  ]);
  const [source, target] = children;
  await page.goto(`/p/${parent.id}`);

  let parentBodyPuts = 0;
  await page.route(`**/api/page/${parent.id}`, async (route) => {
    if (route.request().method() === "PUT") parentBodyPuts += 1;
    await route.continue();
  });

  let releaseFailure!: () => void;
  const failureMayReturn = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/api/page-ref/nest", async (route) => {
    await failureMayReturn;
    await route.fulfill({ status: 500, body: "move failed" });
  });

  await dragPageRefInto(page, source.id, target.id);
  const editor = page.locator(
    '.milkdown .ProseMirror[aria-label="Page content"]',
  );
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(editor).toHaveAttribute("aria-busy", "true");
  await expect(
    page.locator(
      `a.brain-page-ref[data-page-ref="${source.id}"][data-page-ref-nest-pending="true"]`,
    ),
  ).toHaveCount(1);
  await page
    .locator(`a.brain-page-ref[data-page-ref="${target.id}"]`)
    .click();
  await expect(page).toHaveURL(`/p/${target.id}`);
  await page.locator(`[data-tree-page-id="${parent.id}"]`).click();
  await expect(page).toHaveURL(`/p/${parent.id}`);
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await page.keyboard.type("must not be inserted");
  await expect(editor).not.toContainText("must not be inserted");
  expect(parentBodyPuts).toBe(0);
  releaseFailure();

  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, source.id)?.parentId;
    })
    .toBe(parent.id);
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(editor).not.toHaveAttribute("aria-busy", "true");
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(1);
  const editableAfterFailure = "editable after failed nesting";
  await editor.focus();
  await page.keyboard.type(editableAfterFailure);
  await expect(editor).toContainText(editableAfterFailure);
  await expect
    .poll(async () => {
      const response = await browserJson(page, `/api/page/${parent.id}`);
      return (response.body as { markdown: string }).markdown;
    })
    .toContain(editableAfterFailure);
  expect(parentBodyPuts).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate((parentId) => {
        const prefix = `brain-draft-v2:${encodeURIComponent(parentId)}:`;
        return Object.keys(localStorage).filter((key) => key.startsWith(prefix));
      }, parent.id),
    )
    .toEqual([]);
  await page.unroute("**/api/page-ref/nest");
  await page.unroute(`**/api/page/${parent.id}`);

  const parentAfter = await browserJson(page, `/api/page/${parent.id}`);
  expect((parentAfter.body as { markdown: string }).markdown).toContain(
    `/p/${source.id}`,
  );
});

test("delayed nesting stays frozen across navigation and only the composite changes the parent", async ({
  page,
}) => {
  await login(page);
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Delayed synthesized parent" },
  });
  const parent = parentResponse.body as { id: string };
  const sourceResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Delayed synthesized source" },
  });
  const targetResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Delayed synthesized target" },
  });
  const source = sourceResponse.body as { id: string };
  const target = targetResponse.body as { id: string };
  const before = await browserJson(page, `/api/page/${parent.id}`);
  expect((before.body as { markdown: string }).markdown).toBe("");
  const initialMarkdown = [
    `[Delayed synthesized source](/p/${source.id})`,
    `[Delayed synthesized target](/p/${target.id})`,
  ].join("\n\n");
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: {
      markdown: initialMarkdown,
      rev: (before.body as { rev: string }).rev,
    },
  });
  expect(seeded.ok).toBe(true);
  await page.goto(`/p/${parent.id}`);

  let releaseSuccess!: () => void;
  const successMayReturn = new Promise<void>((resolve) => {
    releaseSuccess = resolve;
  });
  let parentBodyPuts = 0;
  await page.route(`**/api/page/${parent.id}`, async (route) => {
    if (route.request().method() === "PUT") parentBodyPuts += 1;
    await route.continue();
  });
  await page.route("**/api/page-ref/nest", async (route) => {
    await successMayReturn;
    await route.continue();
  });

  await dragPageRefInto(page, source.id, target.id);
  const editor = page.locator(
    '.milkdown .ProseMirror[aria-label="Page content"]',
  );
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(1);
  await page
    .locator(`a.brain-page-ref[data-page-ref="${target.id}"]`)
    .click();
  await expect(page).toHaveURL(`/p/${target.id}`);
  await page.locator(`[data-tree-page-id="${parent.id}"]`).click();
  await expect(page).toHaveURL(`/p/${parent.id}`);
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await page.keyboard.type("must not race the move");
  await expect(editor).not.toContainText("must not race the move");
  expect(parentBodyPuts).toBe(0);

  releaseSuccess();
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(editor).not.toHaveAttribute("aria-busy", "true");
  await expect
    .poll(async () => {
      const response = await browserJson(page, `/api/page/${parent.id}`);
      return (response.body as { markdown: string }).markdown;
    })
    .toBe(`[Delayed synthesized target](/p/${target.id})`);
  expect(parentBodyPuts).toBe(0);

  await page.unroute("**/api/page-ref/nest");
  await page.unroute(`**/api/page/${parent.id}`);
});

test("nesting removes the exact dragged duplicate page-ref occurrence", async ({
  page,
}) => {
  await login(page);
  const { parent, children } = await createPageRefNestingFixture(page, [
    "Duplicate source",
    "Duplicate target",
  ]);
  const [source, target] = children;
  const current = await browserJson(page, `/api/page/${parent.id}`);
  const duplicateFingerprint = `[Duplicate source](/p/${source.id})`;
  const uniqueProse = "Unique prose between duplicate references";
  const markdown = [
    duplicateFingerprint,
    uniqueProse,
    duplicateFingerprint,
    `[Duplicate target](/p/${target.id})`,
  ].join("\n\n");
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: { markdown, rev: (current.body as { rev: string }).rev },
  });
  expect(seeded.ok).toBeTruthy();

  let sentOccurrence: number | null | undefined;
  let sentFingerprint: string | null | undefined;
  await page.route("**/api/page-ref/nest", async (route) => {
    const body = route.request().postDataJSON() as {
      sourceOccurrence?: number | null;
      sourceFingerprint?: string | null;
    };
    sentOccurrence = body.sourceOccurrence;
    sentFingerprint = body.sourceFingerprint;
    await route.continue();
  });
  await page.goto(`/p/${parent.id}`);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(2);
  await dragPageRefInto(page, source.id, target.id, 1);

  await expect.poll(() => sentOccurrence).toBe(1);
  expect(sentFingerprint).toBe(duplicateFingerprint);
  await expect
    .poll(async () => {
      const response = await browserJson(page, `/api/page/${parent.id}`);
      return (response.body as { markdown: string }).markdown;
    })
    .toBe(
      [
        duplicateFingerprint,
        uniqueProse,
        `[Duplicate target](/p/${target.id})`,
      ].join("\n\n"),
    );
  await expect(page.getByText(uniqueProse)).toBeVisible();
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(1);

  await page.reload();
  await expect(page.getByText(uniqueProse)).toBeVisible();
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(1);
  await page.unroute("**/api/page-ref/nest");
});

/** Two lanes of page rows, written the way the "organize" action writes them:
 *  the closing fence on the line after the last row, no blank line between. */
function columnsBody(
  left: Array<{ id: string; title: string }>,
  right: Array<{ id: string; title: string }>,
) {
  const lane = (rows: Array<{ id: string; title: string }>, heading: string) =>
    [
      ":::col",
      `## ${heading}`,
      "",
      rows.map((row) => `[${row.title}](/p/${row.id})`).join("\n\n"),
      ":::",
    ].join("\n");
  return [
    "::::cols",
    lane(left, "Beds & Borders"),
    "",
    lane(right, "Trials"),
    "::::",
  ].join("\n");
}

async function seedColumnsFixture(page: Page, titles: string[]) {
  const { parent, children } = await createPageRefNestingFixture(page, titles);
  const current = await browserJson(page, `/api/page/${parent.id}`);
  const markdown = columnsBody(children.slice(0, 2), children.slice(2));
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: { markdown, rev: (current.body as { rev: string }).rev },
  });
  expect(seeded.ok).toBeTruthy();
  return { parent, children };
}

const columnLanes = (page: Page) =>
  page.locator(".ProseMirror .brain-cols > .brain-col");

async function pageMarkdown(page: Page, id: string) {
  const response = await browserJson(page, `/api/page/${id}`);
  return (response.body as { markdown: string }).markdown;
}

/** The raw line a row is stored as. The editor re-serializes a title with the
 *  page's icon, so the exact text is the document's to decide, not the test's —
 *  but the request has to name that exact line or the server refuses the move. */
function rowLine(markdown: string, id: string) {
  return (
    markdown.split("\n").find((line) => line.includes(`(/p/${id})`)) ?? null
  );
}

/** Where each row sits in the stored body, so order can be asserted without
 *  pinning the labels. */
const rowOrder = (markdown: string, ids: string[]) =>
  ids.map((id) => markdown.indexOf(`(/p/${id})`));

/** The layout itself: two lanes, still fenced, still holding the rest. */
function expectTwoLanes(markdown: string) {
  expect(markdown.startsWith("::::cols")).toBe(true);
  expect(markdown.trimEnd().endsWith("::::")).toBe(true);
  expect(markdown.split("\n").filter((line) => line === ":::col")).toHaveLength(
    2,
  );
}

// In the compact gate on purpose. The nesting bug this covers survived because
// no gate ever dragged anything inside a column: the journey was tested, the
// layout it runs on was not. A gate that stays out of columns invites it back.
//
// Everything the test touches it creates: the parent, the children, the two
// lanes and the body they sit in are all made through the API under generated
// ids, and every locator is bound to one of those ids. Nothing here reads the
// tree, a count, or any page a neighbouring test left behind, so the compact
// set and the full file exercise the same thing.
test("@release a page row nests from inside a column, in its own lane and across", async ({
  page,
}) => {
  await login(page);
  // Lane one holds the drag and the target it lands on. Lane two holds the row
  // the second half of the test drags across.
  const { parent, children } = await seedColumnsFixture(page, [
    "Archive",
    "Tomato Trial Rows",
    "Bees",
  ]);
  const [target, source, across] = children;

  let sentOccurrence: number | null | undefined;
  let sentFingerprint: string | null | undefined;
  await page.route("**/api/page-ref/nest", async (route) => {
    const body = route.request().postDataJSON() as {
      sourceOccurrence?: number | null;
      sourceFingerprint?: string | null;
    };
    sentOccurrence = body.sourceOccurrence;
    sentFingerprint = body.sourceFingerprint;
    await route.continue();
  });

  await page.goto(`/p/${parent.id}`);
  await expect(columnLanes(page)).toHaveCount(2);
  // The row the reader drags is the last one in its lane — the position the
  // Markdown scanner used to lose to the closing fence.
  await expect(
    page.locator(
      `.brain-col a.brain-page-ref[data-page-ref="${source.id}"]`,
    ),
  ).toHaveCount(1);
  const seeded = await pageMarkdown(page, parent.id);
  const sourceLine = rowLine(seeded, source.id);
  const acrossLine = rowLine(seeded, across.id);

  await dragPageRefInto(page, source.id, target.id);

  // The move names a physical row, not "there is no reference here" — the
  // synthesized request the old scanner produced for a last-in-lane row, which
  // the server accepts and which leaves the row sitting in the column.
  await expect.poll(() => sentFingerprint).toBe(sourceLine);
  expect(sentOccurrence).toBe(0);
  await expect
    .poll(() => pageMarkdown(page, parent.id))
    .not.toContain(`(/p/${source.id})`);
  // The layout survives the move, and the row left the page rather than
  // ending up in two places at once.
  expectTwoLanes(await pageMarkdown(page, parent.id));
  await expect(columnLanes(page)).toHaveCount(2);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);

  // Second half: a row in the other lane, dropped on a row in the first. A
  // whole lane is column drop's own target, so this is where the two gestures
  // want the same pixels and the centre band has to win.
  //
  // Forget the first request first, so a second one that never arrives fails
  // here instead of passing on what the first drag left in these.
  sentOccurrence = undefined;
  sentFingerprint = undefined;
  await dragPageRefInto(page, across.id, target.id);
  await expect.poll(() => sentFingerprint).toBe(acrossLine);
  expect(sentOccurrence).toBe(0);
  await expect
    .poll(() => pageMarkdown(page, parent.id))
    .not.toContain(`(/p/${across.id})`);
  const remaining = await pageMarkdown(page, parent.id);
  expect(remaining).toContain(`(/p/${target.id})`);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${across.id}"]`),
  ).toHaveCount(0);

  await page.goto(`/p/${target.id}`);
  for (const moved of [source, across]) {
    await expect(
      page.locator(`a.brain-page-ref[data-page-ref="${moved.id}"]`),
    ).toHaveCount(1);
  }
  await page.unroute("**/api/page-ref/nest");
});

test("a page row in a column keeps its edge drops and its lane", async ({
  page,
}) => {
  await login(page);
  const { parent, children } = await seedColumnsFixture(page, [
    "Archive",
    "Tomato Trial Rows",
    "Bees",
  ]);
  const [first, second, across] = children;
  await page.goto(`/p/${parent.id}`);
  await expect(columnLanes(page)).toHaveCount(2);

  // The bands above and below a row still mean "between rows", inside a column
  // exactly as at the top level: reorder, no reparenting, no lane lost.
  await dragPageRefBefore(page, second.id, first.id);
  await expect
    .poll(async () => {
      const markdown = await pageMarkdown(page, parent.id);
      const [movedAt, stayedAt] = rowOrder(markdown, [second.id, first.id]);
      return movedAt >= 0 && stayedAt >= 0 && movedAt < stayedAt;
    })
    .toBe(true);
  const reordered = await pageMarkdown(page, parent.id);
  expectTwoLanes(reordered);
  expect(reordered).toContain(`(/p/${across.id})`);
  await expect(columnLanes(page)).toHaveCount(2);
  // Both rows are still rows of this page, still in the lane they started in.
  for (const row of [second, first]) {
    await expect(
      page.locator(
        `.ProseMirror .brain-cols > .brain-col:first-child a.brain-page-ref[data-page-ref="${row.id}"]`,
      ),
    ).toHaveCount(1);
  }
});

test("page-ref nesting reconciles a lost success response", async ({ page }) => {
  await login(page);
  const { parent, children } = await createPageRefNestingFixture(page, [
    "Lost response source",
    "Lost response target",
  ]);
  const [source, target] = children;
  await page.goto(`/p/${parent.id}`);
  let serverApplied = false;
  await page.route("**/api/page-ref/nest", async (route) => {
    const response = await route.fetch();
    serverApplied = response.ok();
    await route.abort("failed");
  });

  await dragPageRefInto(page, source.id, target.id);
  await expect.poll(() => serverApplied).toBe(true);
  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, source.id)?.parentId;
    })
    .toBe(target.id);
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${source.id}"]`),
  ).toHaveCount(0);
  await page.unroute("**/api/page-ref/nest");

  const parentAfter = await browserJson(page, `/api/page/${parent.id}`);
  expect((parentAfter.body as { markdown: string }).markdown).not.toContain(
    `/p/${source.id}`,
  );
});

test("page-ref side-centre drop stays a column gesture, not nesting", async ({
  page,
}) => {
  await login(page);
  const { parent, children } = await createPageRefNestingFixture(page, [
    "Column source",
    "Column target",
  ]);
  const [source, target] = children;
  await page.goto(`/p/${parent.id}`);
  let nestRequests = 0;
  await page.route("**/api/page-ref/nest", async (route) => {
    nestRequests += 1;
    await route.continue();
  });

  await dragPageRefToSide(page, source.id, target.id);
  await expect(
    page.getByRole("textbox", { name: "Page content" }).locator(".brain-cols"),
  ).toHaveCount(1);
  expect(nestRequests).toBe(0);
  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, source.id)?.parentId;
    })
    .toBe(parent.id);
  await page.unroute("**/api/page-ref/nest");
});

test("manual divider sections match compact page-list rhythm without tightening prose", async ({
  page,
}) => {
  await login(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Manual section rhythm" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };

  const createChild = async (title: string) => {
    const response = await browserJson(page, "/api/page", {
      method: "POST",
      body: { parentId: parent.id, title },
    });
    expect(response.ok).toBeTruthy();
    return response.body as { id: string };
  };
  const first = await createChild("First compact child");
  const second = await createChild("Second compact child");

  const current = await browserJson(page, `/api/page/${parent.id}`);
  const seeded = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: {
      markdown: [
        "Prose above",
        "---",
        "Prose below",
        "---",
        "## Manual group",
        `[First compact child](/p/${first.id})`,
        `[Second compact child](/p/${second.id})`,
        "## Underlined manual group",
        "---",
        `[First compact child](/p/${first.id})`,
        `[Second compact child](/p/${second.id})`,
        `Inline [First compact child](/p/${first.id}) mention`,
      ].join("\n\n"),
      rev: (current.body as { rev: string }).rev,
    },
  });
  expect(seeded.ok).toBeTruthy();

  await page.goto(`/p/${parent.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  const standaloneRefs = content.locator(":scope > p.brain-page-ref-only");
  await expect(standaloneRefs).toHaveCount(4);

  const inlineParagraph = content
    .locator(":scope > p")
    .filter({ hasText: /^Inline/ });
  await expect(inlineParagraph).toHaveCount(1);
  await expect(inlineParagraph).not.toHaveClass(/brain-page-ref-only/);
  await expect(inlineParagraph.locator("a.brain-page-ref")).toHaveCount(1);

  const rhythm = await content.evaluate((editor) => {
    const children = Array.from(editor.children) as HTMLElement[];
    const normalDivider = children.find((child) => child.tagName === "HR");
    const heading = children.find(
      (child) =>
        child.tagName === "H2" && child.textContent === "Manual group",
    );
    const sectionDivider = heading?.previousElementSibling as HTMLElement | null;
    const firstRef = heading?.nextElementSibling as HTMLElement | null;
    const secondRef = firstRef?.nextElementSibling as HTMLElement | null;
    const underlinedHeading = children.find(
      (child) =>
        child.tagName === "H2" &&
        child.textContent === "Underlined manual group",
    );
    const underlinedDivider =
      underlinedHeading?.nextElementSibling as HTMLElement | null;
    const underlinedFirstRef =
      underlinedDivider?.nextElementSibling as HTMLElement | null;
    const proseAbove = normalDivider?.previousElementSibling as HTMLElement | null;
    const proseBelow = normalDivider?.nextElementSibling as HTMLElement | null;

    if (
      !normalDivider ||
      !heading ||
      !sectionDivider ||
      !firstRef ||
      !secondRef ||
      !underlinedHeading ||
      !underlinedDivider ||
      !underlinedFirstRef ||
      !proseAbove ||
      !proseBelow
    ) {
      throw new Error("Expected divider, heading, prose, and page-ref blocks");
    }

    const gap = (before: HTMLElement, after: HTMLElement) => {
      const beforeRect = before.getBoundingClientRect();
      const afterRect = after.getBoundingClientRect();
      return afterRect.top - beforeRect.bottom;
    };
    const normalStyle = getComputedStyle(normalDivider);
    const sectionStyle = getComputedStyle(sectionDivider);
    const headingStyle = getComputedStyle(heading);
    const firstRefStyle = getComputedStyle(firstRef);
    const secondRefStyle = getComputedStyle(secondRef);
    const underlinedDividerStyle = getComputedStyle(underlinedDivider);
    const underlinedFirstRefStyle = getComputedStyle(underlinedFirstRef);

    return {
      sectionOrder: [
        sectionDivider.tagName,
        heading.tagName,
        `${firstRef.tagName}.${firstRef.className}`,
        `${secondRef.tagName}.${secondRef.className}`,
      ],
      normalDividerMargins: {
        top: normalStyle.marginTop,
        bottom: normalStyle.marginBottom,
      },
      sectionMargins: {
        dividerTop: sectionStyle.marginTop,
        dividerBottom: sectionStyle.marginBottom,
        headingTop: headingStyle.marginTop,
        firstRefTop: firstRefStyle.marginTop,
        secondRefTop: secondRefStyle.marginTop,
      },
      underlinedSection: {
        order: [
          underlinedHeading.tagName,
          underlinedDivider.tagName,
          `${underlinedFirstRef.tagName}.${underlinedFirstRef.className}`,
        ],
        dividerTop: underlinedDividerStyle.marginTop,
        dividerBottom: underlinedDividerStyle.marginBottom,
        firstRefTop: underlinedFirstRefStyle.marginTop,
        headingToDivider: gap(underlinedHeading, underlinedDivider),
        dividerToFirstRef: gap(underlinedDivider, underlinedFirstRef),
      },
      gaps: {
        proseToDivider: gap(proseAbove, normalDivider),
        dividerToProse: gap(normalDivider, proseBelow),
        dividerToHeading: gap(sectionDivider, heading),
        headingToFirstRef: gap(heading, firstRef),
        firstToSecondRef: gap(firstRef, secondRef),
      },
    };
  });

  expect(rhythm.sectionOrder).toEqual([
    "HR",
    "H2",
    "P.brain-page-ref-only",
    "P.brain-page-ref-only",
  ]);
  expect(rhythm.normalDividerMargins).toEqual({ top: "32px", bottom: "32px" });
  expect(rhythm.sectionMargins).toEqual({
    dividerTop: "24px",
    dividerBottom: "8px",
    headingTop: "0px",
    firstRefTop: "8px",
    secondRefTop: "3px",
  });
  expect(rhythm.underlinedSection).toEqual({
    order: ["H2", "HR", "P.brain-page-ref-only"],
    dividerTop: "6px",
    dividerBottom: "8px",
    firstRefTop: "0px",
    headingToDivider: 6,
    dividerToFirstRef: 8,
  });
  expect(rhythm.gaps.proseToDivider).toBeGreaterThanOrEqual(28);
  expect(rhythm.gaps.dividerToProse).toBeGreaterThanOrEqual(28);
  expect(rhythm.gaps.dividerToHeading).toBeLessThanOrEqual(9);
  expect(rhythm.gaps.headingToFirstRef).toBeLessThanOrEqual(9);
  expect(rhythm.gaps.firstToSecondRef).toBeGreaterThanOrEqual(2.5);
  expect(rhythm.gaps.firstToSecondRef).toBeLessThanOrEqual(3.5);
});

test("long page titles wrap and Enter transfers focus to the editor", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Short title", markdown: "Body starts here" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  await page.goto(`/p/${created.id}`);
  const title = page.getByRole("textbox", { name: "Page title" });
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(title).toBeVisible();
  await expect(content).toBeVisible();

  const longTitle =
    "A long Brain title that wraps naturally instead of scrolling sideways ".repeat(
      5,
    ).trim();
  await title.fill(longTitle);
  await expect(title).toHaveValue(longTitle);
  await expect
    .poll(() =>
      title.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight);
        return textarea.getBoundingClientRect().height / lineHeight;
      }),
    )
    .toBeGreaterThan(2);

  const titleMetrics = await title.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    return {
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
      overflowY: getComputedStyle(textarea).overflowY,
    };
  });
  expect(titleMetrics.overflowY).toBe("hidden");
  expect(titleMetrics.clientHeight).toBeGreaterThanOrEqual(
    titleMetrics.scrollHeight - 1,
  );

  await title.press("Enter");
  await expect(content).toBeFocused();
  await expect(title).toHaveValue(longTitle);
});

test("an unblurred page title is recovered after a failed tab lifetime", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Original title", markdown: "Body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  const title = page.getByRole("textbox", { name: "Page title" });
  await expect(title).toHaveValue("Original title");
  // Rename it the way a reader does. `fill()` puts the field's own content
  // under a selection and inserts into it, and React rewriting the controlled
  // value between those two steps collapsed the selection — the field then
  // held the new title AND the old one, and everything after this line was
  // asserting on a string the setup itself had corrupted. Select and type.
  await title.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Recovered crash title");
  await expect(title).toHaveValue("Recovered crash title");
  await expect
    .poll(() =>
      page.evaluate((pageId) => {
        const prefix = `brain-title-draft-v1:${encodeURIComponent(pageId)}:`;
        return Object.keys(localStorage).some((key) => key.startsWith(prefix));
      }, created.id),
    )
    .toBe(true);

  // A hard tab loss can happen before blur. Reloading creates a new client id;
  // the new lifetime must recover the newest draft whose server base is still
  // unchanged.
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    "Recovered crash title",
  );

  const renameResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("textbox", { name: "Page title" }).focus();
  await page.getByRole("textbox", { name: "Page content" }).click();
  expect((await renameResponse).ok()).toBe(true);

  await expect
    .poll(() =>
      page.evaluate((pageId) => {
        const prefix = `brain-title-draft-v1:${encodeURIComponent(pageId)}:`;
        return Object.keys(localStorage).filter((key) => key.startsWith(prefix))
          .length;
      }, created.id),
    )
    .toBe(0);
  await expect
    .poll(async () => {
      const response = await browserJson(page, `/api/page/${created.id}`);
      return (response.body as { meta?: { title?: string } }).meta?.title;
    })
    .toBe("Recovered crash title");
});

test("a body conflict keeps an uncommitted title recovery draft", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Conflict title base", markdown: "Base body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  const before = await browserJson(page, `/api/page/${created.id}`);
  const stale = before.body as { rev: string };
  const remote = await browserJson(page, `/api/page/${created.id}`, {
    method: "PUT",
    body: { markdown: "Remote conflicting body", rev: stale.rev },
  });
  expect(remote.ok).toBe(true);
  await seedConflictedDraft(
    page,
    created.id,
    "Local conflicting body",
    stale.rev,
    "Base body",
    "title-conflict:1",
  );

  let titlePatches = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      new URL(request.url()).pathname === `/api/page/${created.id}`
    ) {
      titlePatches += 1;
    }
  });
  await page.goto(`/p/${created.id}`);
  await expect(page.getByText("Page changed elsewhere")).toBeVisible();

  const title = page.getByRole("textbox", { name: "Page title" });
  await title.fill("Title safe during conflict");
  await title.press("Tab");
  expect(titlePatches).toBe(0);
  await expect
    .poll(() =>
      page.evaluate((pageId) => {
        const prefix = `brain-title-draft-v1:${encodeURIComponent(pageId)}:`;
        return Object.entries(localStorage).some(([key, raw]) => {
          if (!key.startsWith(prefix)) return false;
          try {
            return (
              (JSON.parse(raw) as { title?: string }).title ===
              "Title safe during conflict"
            );
          } catch {
            return false;
          }
        });
      }, created.id),
    )
    .toBe(true);
  const persisted = await browserJson(page, `/api/page/${created.id}`);
  expect(persisted.body).toMatchObject({
    meta: { title: "Conflict title base" },
    markdown: "Remote conflicting body",
  });
});

test("page actions Export PDF invokes the browser print flow", async ({ page }) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "PDF export",
      markdown: "Printable body\n\n| One | Two |\n| --- | --- |\n| A | B |",
    },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  const stickerResponse = await browserJson(page, `/api/page/${created.id}`, {
    method: "PATCH",
    body: {
      stickers: [
        { id: "printed", x: 40, y: 190, text: "Pinned note\nSecond line" },
        { id: "empty", x: 220, y: 330, text: "" },
        {
          id: "edge",
          x: 9_999,
          y: 450,
          text: "One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine\nTen",
        },
      ],
    },
  });
  expect(stickerResponse.ok).toBeTruthy();

  await page.goto(`/p/${created.id}`);
  await expect(page.getByRole("textbox", { name: "Sticker text" })).toHaveCount(3);
  await expect(page.locator(".milkdown-table-block")).toBeVisible();
  const readPrintTokens = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        paper: style.getPropertyValue("--paper").trim(),
        ink: style.getPropertyValue("--ink").trim(),
        line: style.getPropertyValue("--line").trim(),
      };
    });
  const lightTokens = await readPrintTokens();
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  expect(await readPrintTokens()).not.toEqual(lightTokens);
  await page.evaluate(() => {
    const pageFrame = document.querySelector(".brain-page-frame") as HTMLElement;
    pageFrame.style.opacity = "0.2";
    pageFrame.style.transform = "translateY(20px)";
  });
  await page.emulateMedia({ media: "print" });
  await expect.poll(readPrintTokens).toEqual(lightTokens);

  const printMetrics = await page.evaluate(() => {
    const article = document.querySelector("article.brain-page-article") as HTMLElement;
    const pageFrame = document.querySelector(".brain-page-frame") as HTMLElement;
    const layer = document.querySelector(".brain-stickers-layer") as HTMLElement;
    const stickers = [...document.querySelectorAll<HTMLElement>(".brain-sticker")];
    const articleRect = article.getBoundingClientRect();
    return {
      articleMinHeight: Number.parseFloat(getComputedStyle(article).minHeight),
      articleWidth: articleRect.width,
      articleLeft: articleRect.left,
      articleRight: articleRect.right,
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      layerPosition: getComputedStyle(layer).position,
      pageFrameOpacity: getComputedStyle(pageFrame).opacity,
      pageFrameTransform: getComputedStyle(pageFrame).transform,
      stickers: stickers.map((sticker) => {
        const style = getComputedStyle(sticker);
        const rect = sticker.getBoundingClientRect();
        const editor = sticker.querySelector(".brain-sticker-editor") as HTMLElement;
        const chrome = sticker.querySelector(".brain-sticker-chrome") as HTMLElement;
        const text = sticker.querySelector(".brain-sticker-print-text") as HTMLElement;
        return {
          left: Number.parseFloat(style.left),
          top: Number.parseFloat(style.top),
          width: Number.parseFloat(style.width),
          rectLeft: rect.left,
          rectRight: rect.right,
          position: style.position,
          background: style.backgroundColor,
          printColorAdjust:
            style.printColorAdjust ||
            (style as CSSStyleDeclaration & { webkitPrintColorAdjust?: string })
              .webkitPrintColorAdjust,
          editorDisplay: getComputedStyle(editor).display,
          chromeDisplay: getComputedStyle(chrome).display,
          textDisplay: getComputedStyle(text).display,
          text: text.textContent,
        };
      }),
      tableHandleDisplays: [
        ...document.querySelectorAll<HTMLElement>(".milkdown-table-block .handle"),
      ].map((handle) => getComputedStyle(handle).display),
    };
  });
  expect(printMetrics.layerPosition).toBe("absolute");
  expect(printMetrics.pageFrameOpacity).toBe("1");
  expect(printMetrics.pageFrameTransform).toBe("none");
  expect(printMetrics.articleMinHeight).toBeGreaterThanOrEqual(680);
  // The collapsed table border contributes two CSS pixels; a sticker must not
  // expand the document beyond that stable baseline.
  expect(printMetrics.documentScrollWidth).toBeLessThanOrEqual(printMetrics.viewportWidth + 2);
  expect(printMetrics.articleWidth).toBeLessThanOrEqual(printMetrics.viewportWidth + 1);
  expect(printMetrics.stickers).toHaveLength(3);
  expect(printMetrics.stickers[0]).toMatchObject({
    left: 40,
    top: 190,
    width: 180,
    position: "absolute",
    editorDisplay: "none",
    chromeDisplay: "none",
    textDisplay: "block",
    text: "Pinned note\nSecond line",
    printColorAdjust: "exact",
  });
  expect(printMetrics.stickers[0]?.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(printMetrics.stickers[1]).toMatchObject({
    top: 330,
    width: 180,
    position: "absolute",
    editorDisplay: "none",
    chromeDisplay: "none",
    textDisplay: "block",
    text: "",
  });
  expect(
    Math.abs((printMetrics.stickers[2]?.rectRight ?? 0) - printMetrics.articleRight),
  ).toBeLessThanOrEqual(1);
  expect(printMetrics.stickers[2]).toMatchObject({
    top: 450,
    width: 180,
    position: "absolute",
    editorDisplay: "none",
    chromeDisplay: "none",
    textDisplay: "block",
    text: "One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine\nTen",
  });
  expect(printMetrics.tableHandleDisplays.every((display) => display === "none")).toBe(true);

  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => {
    const pageFrame = document.querySelector(".brain-page-frame") as HTMLElement;
    pageFrame.style.removeProperty("opacity");
    pageFrame.style.removeProperty("transform");
  });
  await page.evaluate(() => {
    document.body.dataset.brainPrintCalls = "0";
    Object.defineProperty(window, "print", {
      configurable: true,
      value: () => {
        const calls = Number(document.body.dataset.brainPrintCalls ?? "0");
        document.body.dataset.brainPrintCalls = String(calls + 1);
      },
    });
  });

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Export PDF" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => Number(document.body.dataset.brainPrintCalls ?? "0")),
    )
    .toBe(1);
});

test("desktop Page actions dialogs restore their exact invoker", async ({ page }) => {
  const dialogWarnings = captureDialogDescriptionWarnings(page);
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Dialog release", markdown: "Body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  await page.goto(`/p/${created.id}`);
  // The title and top bar are server-rendered before the client event handlers.
  // The editor exists only after hydration, so use it as the interaction-ready
  // boundary before exercising the touch trigger.
  await expect(page.locator(".ProseMirror")).toBeVisible();
  const actions = page.getByRole("button", { name: "Page actions" });

  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const history = page.getByRole("dialog");
  await expect(history).toBeVisible();
  const closeHistory = history.getByRole("button", {
    name: "Close version history",
  });
  await expect(closeHistory).toBeVisible();
  await expect(history).not.toHaveAttribute("aria-describedby");
  await expectIconlessDialogHeader(history);
  await expectPlainDialogClose(closeHistory);
  await closeHistory.click();
  await expect(history).toBeHidden();
  await expectDialogLayerReleased(page);
  await expect(actions).toBeFocused();

  await actions.click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: "Move page" });
  await expect(move).toBeVisible();
  await expectIconlessDialogHeader(move);
  await expectPlainDialogClose(
    move.getByRole("button", { name: "Close move dialog" }),
  );
  await page.keyboard.press("Escape");
  await expect(move).toBeHidden();
  await expectDialogLayerReleased(page);
  await expect(actions).toBeFocused();
  expect(dialogWarnings).toEqual([]);
});

test("utility dialogs share iconless headers and one plain close control", async ({
  page,
}) => {
  const dialogWarnings = captureDialogDescriptionWarnings(page);
  await login(page);

  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "/",
        code: "Slash",
        metaKey: true,
        bubbles: true,
      }),
    );
  });
  const shortcuts = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(shortcuts).not.toHaveAttribute("aria-describedby");
  await expectIconlessDialogHeader(shortcuts);
  await expect(shortcuts.getByText("App navigation and editor formatting")).toHaveCount(0);
  await expectPlainDialogClose(
    shortcuts.getByRole("button", { name: "Close shortcuts" }),
  );
  await shortcuts.getByRole("button", { name: "Close shortcuts" }).click();
  await expectDialogLayerReleased(page);

  await page.getByRole("button", { name: "Trash", exact: true }).click();
  const trash = page.getByRole("dialog", { name: "Trash" });
  await expectIconlessDialogHeader(trash);
  await expectPlainDialogClose(
    trash.getByRole("button", { name: "Close trash" }),
  );
  await trash.getByRole("button", { name: "Close trash" }).click();
  await expectDialogLayerReleased(page);

  // Settings is a surface with a URL, not a dialog — opening it must not
  // claim a dialog layer at all, and Esc leaves it through history.
  // Next's dev overlay can cover this bottom-left sidebar control; production
  // has no such portal, so dispatch to the semantic button here as elsewhere.
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .dispatchEvent("click");
  await expect(page).toHaveURL("/settings/appearance");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectDialogLayerReleased(page);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  await expectDialogLayerReleased(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Dialog chrome parent", markdown: "Body" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };
  const children: string[] = [];
  for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) {
    const childResponse = await browserJson(page, "/api/page", {
      method: "POST",
      body: { parentId: parent.id, title },
    });
    expect(childResponse.ok).toBeTruthy();
    children.push((childResponse.body as { id: string }).id);
  }
  await page.route("**/api/smart-sort", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sections: ["Keep"],
        assignments: Object.fromEntries(children.map((id) => [id, "Keep"])),
        order: children,
        count: children.length,
      }),
    });
  });
  await page.goto(`/p/${parent.id}`);
  await page.getByRole("button", { name: "Smart sort" }).click();
  const smartSort = page.getByRole("dialog", { name: "Smart sort" });
  await expectIconlessDialogHeader(smartSort);
  await expectPlainDialogClose(
    smartSort.getByRole("button", { name: "Close smart sort" }),
  );
  await smartSort.getByRole("button", { name: "Close smart sort" }).click();
  await expectDialogLayerReleased(page);
  expect(dialogWarnings).toEqual([]);
});

test("Smart sort writes a dated section in the order it previewed", async ({
  page,
}) => {
  await login(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Огород", markdown: "Body" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };

  // Created in the order a string sort leaves them: 12 мая, 13 апреля,
  // 23 июня, 9 марта. The calendar disagrees.
  const alphabetical = [
    "Запись 12 мая",
    "Запись 13 апреля",
    "Запись 23 июня",
    "Запись 9 марта",
  ];
  const byTitle = new Map<string, string>();
  for (const title of alphabetical) {
    const childResponse = await browserJson(page, "/api/page", {
      method: "POST",
      body: { parentId: parent.id, title },
    });
    expect(childResponse.ok).toBeTruthy();
    byTitle.set(title, (childResponse.body as { id: string }).id);
  }
  const newestFirst = [
    "Запись 23 июня",
    "Запись 12 мая",
    "Запись 13 апреля",
    "Запись 9 марта",
  ];

  await page.route("**/api/smart-sort", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sections: ["Записи"],
        assignments: Object.fromEntries(
          alphabetical.map((title) => [byTitle.get(title), "Записи"]),
        ),
        order: newestFirst.map((title) => byTitle.get(title)),
        count: alphabetical.length,
      }),
    });
  });

  await page.goto(`/p/${parent.id}`);
  await page.getByRole("button", { name: "Smart sort" }).click();
  const dialog = page.getByRole("dialog", { name: "Smart sort" });
  await expect(dialog.getByText("Запись 23 июня")).toBeVisible();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("dialog", { name: "Smart sort" })).toHaveCount(0);

  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/page/${parent.id}`);
      const markdown = (read.body as { markdown?: string }).markdown ?? "";
      return [...markdown.matchAll(/\[[^\]]*?(Запись [^\]]+)\]/g)].map(
        (match) => match[1],
      );
    })
    .toEqual(newestFirst);
});

test("a delayed History open cannot replace a newer Move dialog", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "History versus Move", markdown: "Initial body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  let releasePut!: () => void;
  const putGate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let markPutSeen!: () => void;
  const putSeen = new Promise<void>((resolve) => {
    markPutSeen = resolve;
  });
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    markPutSeen();
    await putGate;
    await route.continue();
  });

  const content = page.getByRole("textbox", { name: "Page content" });
  const actions = page.getByRole("button", { name: "Page actions" });
  await expect(content).toBeVisible();
  await content.fill("Pending History body");
  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await putSeen;
  // Let the first menu's own deferred callback reach openHistory and block on
  // the gated save before taking control of timers for the second menu.
  await page.waitForTimeout(50);
  // Freeze browser timers so the Move intent is selected and Radix has run
  // onCloseAutoFocus, while useDeferredMenuAction's setTimeout(0) is still
  // pending. This is the exact race where the older History continuation used
  // to win before Move invalidated it.
  await freezePageClock(page);
  await actions.click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: "Move page" });
  // Radix returns the focus from the unmount of its focus scope, and the menu
  // only unmounts once its 120ms exit keyframe has run. That is real time, and
  // the clock is paused, so nothing deferred can slip through while we wait
  // for it. fastForward(0) then executes the return-focus timer once and
  // leaves the nested dialog timer it creates queued.
  await expect(page.locator(".brain-menu")).toHaveCount(0);
  await page.clock.fastForward(0);
  await expect(actions).toBeFocused();
  await expect(move).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  releasePut();
  expect((await saved).ok()).toBe(true);
  await page.waitForTimeout(100);

  // The save has finished, but the deferred Move callback has not. History
  // must already be invalidated from the synchronous menu selection.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.clock.runFor(1);

  await expect(move).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.clock.resume();
  await expectDialogLayerReleased(page);
  await expect(actions).toBeFocused();
});

test("a delayed History open cannot replace a newer tree Rename dialog", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "History versus Rename", markdown: "Initial body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  let releasePut!: () => void;
  const putGate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let markPutSeen!: () => void;
  const putSeen = new Promise<void>((resolve) => {
    markPutSeen = resolve;
  });
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    markPutSeen();
    await putGate;
    await route.continue();
  });

  const content = page.getByRole("textbox", { name: "Page content" });
  const actions = page.getByRole("button", { name: "Page actions" });
  await expect(content).toBeVisible();
  await content.fill("Pending History body before Rename");
  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await putSeen;
  await page.waitForTimeout(50);
  await freezePageClock(page);

  const row = page.locator(`[data-tree-page-id="${created.id}"]`);
  const dots = row.getByRole("button", { name: "More actions" });
  await dots.click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename page" });
  // Same wait as the Move test above: the row menu's exit keyframe has to run
  // before Radix unmounts its focus scope and queues the return-focus timer.
  await expect(page.locator(".brain-menu")).toHaveCount(0);
  await page.clock.fastForward(0);
  await expect(dots).toBeFocused();
  await expect(rename).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  releasePut();
  expect((await saved).ok()).toBe(true);
  await page.waitForTimeout(100);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.clock.runFor(1);
  await expect(rename).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.clock.resume();
  await expectDialogLayerReleased(page);
  await expect(dots).toBeFocused();
});

test("History confirms text typed while its first save is pending", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "History follows newer draft", markdown: "Initial body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstSeen!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    markFirstSeen = resolve;
  });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let markSecondSeen!: () => void;
  const secondSeen = new Promise<void>((resolve) => {
    markSecondSeen = resolve;
  });
  let putIndex = 0;
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const index = putIndex++;
    if (index === 0) {
      markFirstSeen();
      await firstGate;
    } else if (index === 1) {
      markSecondSeen();
      await secondGate;
    }
    await route.continue();
  });

  const content = page.getByRole("textbox", { name: "Page content" });
  const actions = page.getByRole("button", { name: "Page actions" });
  const newerBody = "Text typed while the first History save waits";
  await expect(content).toBeVisible();
  await content.fill("First pending History body");
  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await firstSeen;

  await content.fill(newerBody);
  await expect
    .poll(() =>
      page.evaluate(
        ({ id, text }) => {
          const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
          return Object.entries(localStorage).some(
            ([key, value]) =>
              key.startsWith(prefix) && String(value).includes(text),
          );
        },
        { id: created.id, text: newerBody },
      ),
    )
    .toBe(true);

  const firstSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  releaseFirst();
  expect((await firstSaved).ok()).toBe(true);

  // The first PUT is confirmed, but History must stay closed while the newer
  // draft is immediately promoted into a second, bounded flush.
  await secondSeen;
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const secondSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  releaseSecond();
  expect((await secondSaved).ok()).toBe(true);

  const history = page.getByRole("dialog");
  await expect(history).toBeVisible();
  const persisted = await browserJson(page, `/api/page/${created.id}`);
  expect((persisted.body as { markdown?: string }).markdown?.trimEnd()).toBe(
    newerBody,
  );
  await history
    .getByRole("button", { name: "Close version history" })
    .click();
  await expectDialogLayerReleased(page);
  await expect(actions).toBeFocused();
});

test("History materializes in-flight edits but stays bounded at two saves", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "History bounded live edits", markdown: "Initial body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstSeen!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    markFirstSeen = resolve;
  });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let markSecondSeen!: () => void;
  const secondSeen = new Promise<void>((resolve) => {
    markSecondSeen = resolve;
  });
  let putIndex = 0;
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const index = putIndex++;
    if (index === 0) {
      markFirstSeen();
      await firstGate;
    } else if (index === 1) {
      markSecondSeen();
      await secondGate;
    }
    await route.continue();
  });

  const content = page.getByRole("textbox", { name: "Page content" });
  const actions = page.getByRole("button", { name: "Page actions" });
  const secondBody = "Typed inside the first PUT serialization window";
  const thirdBody = "Typed inside the bounded second PUT serialization window";
  await expect(content).toBeVisible();
  await content.fill("First pending History body");
  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await firstSeen;

  // Freeze Milkdown's normal 200ms markdown emission. Only openHistory's
  // explicit editor flush can discover these in-flight document changes.
  await freezePageClock(page);
  await content.fill(secondBody);

  const firstSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  releaseFirst();
  expect((await firstSaved).ok()).toBe(true);

  // The post-save synchronous serialization must promote the new body into the
  // one allowed follow-up save even though the normal listener is frozen.
  await secondSeen;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await content.fill(thirdBody);

  const secondSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  releaseSecond();
  expect((await secondSaved).ok()).toBe(true);

  // A third edit is materialized and retained, but History must abort instead
  // of growing an unbounded flush loop or opening on the second body.
  await expect
    .poll(() =>
      page.evaluate(
        ({ id, text }) => {
          const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
          return Object.entries(localStorage).some(
            ([key, value]) =>
              key.startsWith(prefix) && String(value).includes(text),
          );
        },
        { id: created.id, text: thirdBody },
      ),
    )
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const thirdSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  await page.clock.runFor(701);
  expect((await thirdSaved).ok()).toBe(true);
  const persisted = await browserJson(page, `/api/page/${created.id}`);
  expect((persisted.body as { markdown?: string }).markdown?.trimEnd()).toBe(
    thirdBody,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.clock.resume();
  await expectDialogLayerReleased(page);
});

// The test here filed an Inbox note and proved the client reconciled from the
// tree when the response was lost. The move test below already holds that
// contract for the mechanism they shared; the half that went with the Inbox
// was the meta flag, which no longer exists. What replaces it is the removal
// itself: the section has to be gone from every way in, not only the sidebar.
test("the Inbox is gone from the sidebar, the palette, and its own address", async ({
  page,
}) => {
  await login(page);

  const sidebar = page.locator(".brain-sidebar");
  await expect(
    sidebar.getByRole("button", { name: "Today thoughts" }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "Inbox", exact: true }),
  ).toHaveCount(0);

  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await palette
    .getByRole("combobox")
    .or(palette.locator("input"))
    .first()
    .fill("inbox");
  await expect(palette.getByText("Open Inbox")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expectDialogLayerReleased(page);

  // the deep link went with the surface
  const response = await page.goto("/inbox");
  expect(response?.status()).toBe(404);
});

test("a confirmed move closes before tree reconciliation finishes", async ({
  page,
}) => {
  await login(page);
  const suffix = Date.now().toString(36);
  const sourceResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: `Slow reconciliation source ${suffix}` },
  });
  const destinationResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: `Slow reconciliation destination ${suffix}` },
  });
  expect(sourceResponse.ok).toBe(true);
  expect(destinationResponse.ok).toBe(true);
  const source = sourceResponse.body as { id: string };
  const destination = destinationResponse.body as { id: string };

  await page.goto(`/p/${source.id}`);
  await expect(page.locator(".ProseMirror")).toBeVisible();

  let releaseTreeRefresh!: () => void;
  const treeRefreshGate = new Promise<void>((resolve) => {
    releaseTreeRefresh = resolve;
  });
  let markTreeRefreshStarted!: () => void;
  const treeRefreshStarted = new Promise<void>((resolve) => {
    markTreeRefreshStarted = resolve;
  });
  await page.route("**/api/tree", async (route) => {
    markTreeRefreshStarted();
    await treeRefreshGate;
    await route.continue();
  });

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: "Move page" });
  await move
    .getByLabel("Search destinations")
    .fill(`Slow reconciliation destination ${suffix}`);
  await move
    .getByRole("option", {
      name: `Slow reconciliation destination ${suffix}`,
    })
    .click();
  const moveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/move") &&
      response.request().method() === "POST",
  );
  await move.getByRole("button", { name: "Move", exact: true }).click();
  expect((await moveResponse).ok()).toBe(true);
  await treeRefreshStarted;

  // The successful mutation is enough to release the dialog. The background
  // tree request may still be slow on a large personal Brain.
  await expect(move).toBeHidden();

  releaseTreeRefresh();
  await page.unrouteAll({ behavior: "wait" });
  await expectDialogLayerReleased(page);

  const persisted = await browserJson(page, "/api/tree");
  const tree = (persisted.body as {
    tree: Array<{
      id: string;
      parentId: string | null;
      children: unknown[];
    }>;
  }).tree;
  const stack = [...tree];
  let parentId: string | null | undefined;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.id === source.id) {
      parentId = current.parentId;
      break;
    }
    stack.push(...(current.children as typeof tree));
  }
  expect(parentId).toBe(destination.id);
});

test("a page move reconciles a commit after its response is lost", async ({
  page,
}) => {
  await login(page);
  const suffix = Date.now().toString(36);
  const sourceResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: `Lost response source ${suffix}` },
  });
  const destinationResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: `Lost response destination ${suffix}` },
  });
  expect(sourceResponse.ok).toBe(true);
  expect(destinationResponse.ok).toBe(true);
  const source = sourceResponse.body as { id: string };
  const destination = destinationResponse.body as { id: string };
  await page.goto(`/p/${source.id}`);
  await expect(page.locator(".ProseMirror")).toBeVisible();

  await page.route("**/api/move", async (route) => {
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    await route.fulfill({ response: committed }).catch(() => {});
  });

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: "Move page" });
  await move
    .getByLabel("Search destinations")
    .fill(`Lost response destination ${suffix}`);
  await move
    .getByRole("option", { name: `Lost response destination ${suffix}` })
    .click();
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect(move).toBeHidden({ timeout: 10_000 });

  await expect
    .poll(async () => {
      const response = await browserJson(page, "/api/tree");
      const tree = (response.body as { tree: E2ETreeNode[] }).tree;
      return findE2ETreeNode(tree, source.id)?.parentId;
    })
    .toBe(destination.id);
  await page.unrouteAll({ behavior: "wait" });
  await expectDialogLayerReleased(page);
});

test("History preserves a live recovery draft when its first save fails", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "History first save failure", markdown: "Initial body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  let markFailureSeen!: () => void;
  const failureSeen = new Promise<void>((resolve) => {
    markFailureSeen = resolve;
  });
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    markFailureSeen();
    await failureGate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary failure" }),
    });
  });

  const content = page.getByRole("textbox", { name: "Page content" });
  const actions = page.getByRole("button", { name: "Page actions" });
  const liveBody = "Typed while the failing first History PUT was in flight";
  await expect(content).toBeVisible();
  await content.fill("First body that will fail");
  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await failureSeen;

  // Freeze Milkdown's delayed markdown emission so only History's explicit
  // post-response editor flush can preserve this newer live document.
  await freezePageClock(page);
  await makeSaveRetriesImmediate(page);
  await content.fill(liveBody);

  const failed = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT" &&
      response.status() === 503,
  );
  releaseFailure();
  expect((await failed).status()).toBe(503);

  await expect
    .poll(async () =>
      (await draftBodies(page, created.id)).some((body) =>
        body.includes(liveBody),
      ),
    )
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.clock.resume();
});

test("History preserves a third live edit when its second save fails", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "History second save failure", markdown: "Initial body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstSeen!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    markFirstSeen = resolve;
  });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let markSecondSeen!: () => void;
  const secondSeen = new Promise<void>((resolve) => {
    markSecondSeen = resolve;
  });
  let putIndex = 0;
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const index = putIndex++;
    if (index === 0) {
      markFirstSeen();
      await firstGate;
      await route.continue();
      return;
    }
    markSecondSeen();
    await secondGate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary failure" }),
    });
  });

  const content = page.getByRole("textbox", { name: "Page content" });
  const actions = page.getByRole("button", { name: "Page actions" });
  const secondBody = "Typed while the first History PUT was in flight";
  const thirdBody = "Typed while the failing second History PUT was in flight";
  await expect(content).toBeVisible();
  await content.fill("First pending History body");
  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await firstSeen;

  await freezePageClock(page);
  await makeSaveRetriesImmediate(page);
  await content.fill(secondBody);

  const firstSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  releaseFirst();
  expect((await firstSaved).ok()).toBe(true);
  await secondSeen;
  await content.fill(thirdBody);

  const secondFailed = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT" &&
      response.status() === 503,
  );
  releaseSecond();
  expect((await secondFailed).status()).toBe(503);

  await expect
    .poll(async () =>
      (await draftBodies(page, created.id)).some((body) =>
        body.includes(thirdBody),
      ),
    )
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.clock.resume();
});

test("A to B to A navigation cancels a delayed History open", async ({
  page,
}) => {
  await login(page);

  const pageAResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "History page A", markdown: "A initial" },
  });
  const pageBResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "History page B", markdown: "B initial" },
  });
  expect(pageAResponse.ok).toBeTruthy();
  expect(pageBResponse.ok).toBeTruthy();
  const pageA = pageAResponse.body as { id: string };
  const pageB = pageBResponse.body as { id: string };
  await page.goto(`/p/${pageA.id}`);

  let releasePut!: () => void;
  const putGate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let markPutSeen!: () => void;
  const putSeen = new Promise<void>((resolve) => {
    markPutSeen = resolve;
  });
  await page.route(`**/api/page/${pageA.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    markPutSeen();
    await putGate;
    await route.continue();
  });

  const content = page.getByRole("textbox", { name: "Page content" });
  const actions = page.getByRole("button", { name: "Page actions" });
  await expect(content).toBeVisible();
  await content.fill("A pending");
  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await putSeen;

  await page.locator(`[data-tree-page-id="${pageB.id}"]`).click();
  await expect(page).toHaveURL(`/p/${pageB.id}`);
  await page.locator(`[data-tree-page-id="${pageA.id}"]`).click();
  await expect(page).toHaveURL(`/p/${pageA.id}`);

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${pageA.id}`) &&
      response.request().method() === "PUT",
  );
  releasePut();
  expect((await saved).ok()).toBe(true);
  await settleBrowserFrames(page);

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await actions.click();
  await expect(
    page.getByRole("menuitem", { name: "Version history" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("only the newest delayed History request may open", async ({ page }) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Newest History request", markdown: "Initial body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstSeen!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    markFirstSeen = resolve;
  });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let markSecondSeen!: () => void;
  const secondSeen = new Promise<void>((resolve) => {
    markSecondSeen = resolve;
  });
  let putIndex = 0;
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const index = putIndex++;
    if (index === 0) {
      markFirstSeen();
      await firstGate;
    } else if (index === 1) {
      markSecondSeen();
      await secondGate;
    }
    await route.continue();
  });

  const content = page.getByRole("textbox", { name: "Page content" });
  const actions = page.getByRole("button", { name: "Page actions" });
  await expect(content).toBeVisible();
  await content.fill("First pending body");
  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await firstSeen;

  await content.fill("Second pending body");
  await page.waitForTimeout(50);
  await freezePageClock(page);
  await actions.click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  // Wait out the menu's exit keyframe in real time — the clock is paused, so
  // no deferred callback runs while we do — then run Radix's return-focus
  // timer and leave the nested deferred History callback queued. The second
  // selection must invalidate the first request synchronously, before that
  // callback gets a turn.
  await expect(page.locator(".brain-menu")).toHaveCount(0);
  await page.clock.fastForward(0);
  await expect(actions).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const firstSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  releaseFirst();
  expect((await firstSaved).ok()).toBe(true);
  await page.waitForTimeout(100);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.clock.runFor(1);
  await secondSeen;
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const secondSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${created.id}`) &&
      response.request().method() === "PUT",
  );
  releaseSecond();
  expect((await secondSaved).ok()).toBe(true);
  const history = page.getByRole("dialog");
  await expect(history).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await history
    .getByRole("button", { name: "Close version history" })
    .click();
  await page.clock.resume();
  await expectDialogLayerReleased(page);
  await expect(actions).toBeFocused();
});

test("History cannot dismiss while a successful restore is in flight", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "History restore barrier", markdown: "Before restore" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await waitForCommittedPageHistory(page, created.id);
  const first = await browserJson(page, `/api/page/${created.id}`);
  const updated = await browserJson(page, `/api/page/${created.id}`, {
    method: "PUT",
    body: {
      markdown: "After restore",
      rev: (first.body as { rev: string }).rev,
    },
  });
  expect(updated.ok).toBeTruthy();
  await expect
    .poll(async () => {
      const result = await browserJson(page, `/api/page/${created.id}/history`);
      return ((result.body as { history?: unknown[] })?.history ?? []).length;
    }, { timeout: 12_000 })
    .toBeGreaterThanOrEqual(2);

  await page.goto(`/p/${created.id}`);
  await expect(page.locator(".ProseMirror")).toContainText("After restore");
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
        return Object.keys(localStorage).some(
          (key) => key.startsWith(prefix) || key === `brain-draft-${id}`,
        );
      }, created.id),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const history = page.getByRole("dialog");
  const versions = history.locator("nav button");
  await expect.poll(() => versions.count()).toBeGreaterThanOrEqual(2);
  await versions.nth(1).click();
  await expect(history).toContainText("Before restore");

  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>((resolve) => {
    releaseRestore = resolve;
  });
  let markRestoreSeen!: () => void;
  const restoreSeen = new Promise<void>((resolve) => {
    markRestoreSeen = resolve;
  });
  await page.route(`**/api/page/${created.id}/history/*`, async (route) => {
    if (route.request().method() === "POST") {
      markRestoreSeen();
      await restoreGate;
    }
    await route.continue();
  });

  const restore = history.getByRole("button", {
    name: "Restore this version",
  });
  await restore.click();
  await restoreSeen;
  await expect(restore).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(history).toBeVisible();
  await expect(restore).toBeDisabled();

  releaseRestore();
  await expect(history).toBeHidden();
  await expect(page.locator(".ProseMirror")).toContainText("Before restore");
  await expectDialogLayerReleased(page);
});

test("mobile Page actions keep a 44px close target and restore focus @mobile", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Mobile dialog focus", markdown: "Body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  await page.goto(`/p/${created.id}`);
  // The mobile top bar is visible in the server HTML. Wait for the client-only
  // editor before tapping so this test never clicks an unhydrated trigger.
  await expect(page.locator(".ProseMirror")).toBeVisible();
  const actions = page.getByRole("button", { name: "Page actions" });
  await expect(actions).toBeVisible();
  await actions.tap();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const history = page.getByRole("dialog");
  const closeHistory = history.getByRole("button", {
    name: "Close version history",
  });
  await expectPlainDialogClose(closeHistory);
  expect(
    await closeHistory.evaluate((element) => ({
      width: getComputedStyle(element, "::before").width,
      height: getComputedStyle(element, "::before").height,
    })),
  ).toEqual({ width: "44px", height: "44px" });
  await closeHistory.click();
  await expectDialogLayerReleased(page);
  await expect(actions).toBeFocused();

  await actions.tap();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: "Move page" });
  await expect(move).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(move).toBeHidden();
  await expectDialogLayerReleased(page);
  await expect(actions).toBeFocused();
});

test("tree dots and right-click dialogs restore their exact invokers", async ({
  page,
}) => {
  const dialogWarnings = captureDialogDescriptionWarnings(page);
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Tree dialog focus", markdown: "Body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);
  // The row is present in the server-rendered tree before its Radix menu is
  // hydrated. Wait for the client editor boundary so the first click cannot be
  // lost on a cold dev server.
  await expect(
    page.locator('.ProseMirror[contenteditable="true"]'),
  ).toBeVisible();

  const row = page.locator(`[data-tree-page-id="${created.id}"]`);
  const dots = row.getByRole("button", { name: "More actions" });
  await dots.click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename page" });
  const closeRename = rename.getByRole("button", {
    name: "Close rename dialog",
  });
  await expect(rename).not.toHaveAttribute("aria-describedby");
  await expect(rename.getByText("Change the title without moving the page")).toHaveCount(0);
  await expectPlainDialogClose(closeRename);
  await closeRename.click();
  await expect(rename).toBeHidden();
  await expectDialogLayerReleased(page);
  await expect(dots).toBeFocused();

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: "Move page" });
  await expect(move).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(move).toBeHidden();
  await expectDialogLayerReleased(page);
  await expect(row).toBeFocused();
  expect(dialogWarnings).toEqual([]);
});

test("editor context dialogs return to the editor or a safe fallback", async ({
  page,
}) => {
  await login(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Editor context focus", markdown: "Body" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };
  const childResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Editor context target" },
  });
  expect(childResponse.ok).toBeTruthy();
  const child = childResponse.body as { id: string };
  const parentBefore = await browserJson(page, `/api/page/${parent.id}`);
  expect(
    (
      await browserJson(page, `/api/page/${parent.id}`, {
        method: "PUT",
        body: {
          markdown: `[Editor context target](/p/${child.id})`,
          rev: (parentBefore.body as { rev: string }).rev,
        },
      })
    ).ok,
  ).toBe(true);
  await page.goto(`/p/${parent.id}`);

  const editor = page.locator('.ProseMirror[aria-label="Page content"]');
  const pageRef = page.locator(
    `a.brain-page-ref[data-page-ref="${child.id}"]`,
  );
  await editor.focus();
  await pageRef.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename page" });
  await rename
    .getByRole("button", { name: "Close rename dialog" })
    .click();
  await expect(rename).toBeHidden();
  await expectDialogLayerReleased(page);
  await expect(editor).toBeFocused();

  await pageRef.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: "Move page" });
  await expect(move).toBeVisible();
  await editor.evaluate((element) => element.remove());
  await page.keyboard.press("Escape");
  await expect(move).toBeHidden();
  await expectDialogLayerReleased(page);
  await expect(page.getByRole("button", { name: "Page actions" })).toBeFocused();

});

test("table row and column drag glyphs stay centred in their pills", async ({ page }) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "Table handle geometry",
      markdown: "| One | Two |\n| --- | --- |\n| A | B |",
    },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  await page.goto(`/p/${created.id}`);
  await page.locator("td").first().hover({ force: true });
  const handles = page.locator(
    ".milkdown-table-block .cell-handle[data-role='col-drag-handle'], .milkdown-table-block .cell-handle[data-role='row-drag-handle']",
  );
  await expect(handles).toHaveCount(2);
  await expect
    .poll(() => handles.evaluateAll((elements) => elements.map((element) => element.dataset.show)))
    .toEqual(["true", "true"]);

  const geometry = await handles.evaluateAll((elements) =>
    elements.map((element) => {
      const handle = element as HTMLElement;
      const glyph = handle.querySelector(":scope > .milkdown-icon") as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(glyph);
      const handleRect = handle.getBoundingClientRect();
      const glyphRect = range.getBoundingClientRect();
      const glyphStyle = getComputedStyle(glyph);
      return {
        role: handle.dataset.role,
        deltaX: Math.abs(
          glyphRect.left + glyphRect.width / 2 - (handleRect.left + handleRect.width / 2),
        ),
        deltaY: Math.abs(
          glyphRect.top + glyphRect.height / 2 - (handleRect.top + handleRect.height / 2),
        ),
        glyphDisplay: glyphStyle.display,
        glyphAlignItems: glyphStyle.alignItems,
        glyphJustifyContent: glyphStyle.justifyContent,
        glyphTransform: glyphStyle.transform,
      };
    }),
  );

  for (const handle of geometry) {
    expect(handle.deltaX).toBeLessThanOrEqual(1);
    expect(handle.deltaY).toBeLessThanOrEqual(1);
    expect(handle.glyphDisplay).toBe("flex");
    expect(handle.glyphAlignItems).toBe("center");
    expect(handle.glyphJustifyContent).toBe("center");
  }
  expect(geometry.find((handle) => handle.role === "col-drag-handle")?.glyphTransform).toBe(
    "none",
  );
  expect(geometry.find((handle) => handle.role === "row-drag-handle")?.glyphTransform).not.toBe(
    "none",
  );
});

/** The share surfaces materialize / slide on CSS keyframes; geometry reads
 *  mid-animation measure a scaled or travelling panel, so settle first. */
async function settleShareSurface(surface: import("playwright/test").Locator) {
  await surface.evaluate((node) =>
    Promise.all(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

test("share desktop popover is named and owns keyboard focus", async ({ page }) => {
  await login(page);
  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Share keyboard", markdown: "Body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  // the head is the status sentence; the first control after it is the
  // password switch on its row
  await expect(dialog.getByRole("heading")).toHaveText(
    "Anyone with the link will be able to read this page.",
  );
  await expect(page.getByRole("switch", { name: "Password protection" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("switch", { name: "Password protection" }),
  ).toBeFocused();
});

test("share uses a viewport bottom sheet with 44px targets at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Share geometry", markdown: "Body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);
  const trigger = page
    .locator('[data-share-mobile-trigger][aria-label="Share"]')
    .first();
  await expect(trigger).toBeVisible();
  await trigger.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await trigger.click();
  const surface = page.locator("[data-share-mobile-surface]");
  await expect(surface).toBeVisible();
  await settleShareSurface(surface);
  await expect(page.getByRole("switch", { name: "Password protection" })).toBeVisible();
  await page.getByRole("switch", { name: "Password protection" }).click();
  await expect(page.locator(".brain-share-password-field")).toBeVisible();
  await settleShareSurface(surface);
  await page.getByRole("textbox", { name: "Share password" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focusedExpiryRadio = page.locator('input[type="radio"]:focus-visible');
  await expect(focusedExpiryRadio).toHaveValue("never");
  const focusedExpiryStyle = await focusedExpiryRadio.locator("..").evaluate((label) => {
    const style = getComputedStyle(label);
    return { boxShadow: style.boxShadow, outlineStyle: style.outlineStyle };
  });
  expect(
    focusedExpiryStyle.boxShadow !== "none" ||
      (focusedExpiryStyle.outlineStyle !== "none" && focusedExpiryStyle.outlineStyle !== ""),
  ).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('input[type="radio"][value="1"]')).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('input[type="radio"][value="7"]')).toBeChecked();

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const node = document.querySelector(selector) as HTMLElement;
      const bounds = node.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const panel = document.querySelector("[data-share-mobile-surface]") as HTMLElement;
    const targets = [
      ...panel.querySelectorAll<HTMLElement>("button, input:not(.sr-only), label:has(input[type='radio'])"),
    ].map((node) => ({
      label: node.getAttribute("aria-label") ?? node.textContent?.trim(),
      height: node.getBoundingClientRect().height,
    }));
    const panelBounds = panel.getBoundingClientRect();
    return {
      panel: rect("[data-share-mobile-surface]"),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
      targets,
      top: panelBounds.top,
    };
  });

  expect(Math.abs(geometry.panel.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.panel.right - geometry.viewportWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.panel.bottom - geometry.viewportHeight)).toBeLessThanOrEqual(1);
  expect(geometry.panelOverflow).toBeLessThanOrEqual(1);
  expect(geometry.bodyOverflow).toBeLessThanOrEqual(1);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  for (const target of geometry.targets) {
    expect(target.height, target.label).toBeGreaterThanOrEqual(44);
  }

  await page.keyboard.press("Escape");
  await expect(surface).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.evaluate((node) => node.scrollIntoView({ block: "end" }));
  await trigger.click();
  await expect(surface).toBeVisible();
  await settleShareSurface(surface);
  const bottomGeometry = await surface.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, bottom: bounds.bottom };
  });
  expect(Math.abs(bottomGeometry.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(bottomGeometry.right - 320)).toBeLessThanOrEqual(1);
  expect(Math.abs(bottomGeometry.bottom - 800)).toBeLessThanOrEqual(1);
});

test("default active share is a ledger on paper inside the regular glass", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Active share polish", markdown: "Body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  const disclosure = await browserJson(page, `/api/page/${created.id}/share`);
  expect(disclosure.ok).toBeTruthy();
  const enabled = await browserJson(page, `/api/page/${created.id}/share`, {
    method: "POST",
    body: {
      enabled: true,
      expectedScopeToken: (disclosure.body as { scopeToken: string }).scopeToken,
      password: null,
      expiresAt: null,
    },
  });
  expect(enabled.ok).toBeTruthy();

  await page.goto(`/p/${created.id}`);
  await page.locator('button[aria-label="Share"]:visible').click();
  const surface = page.locator("[data-share-surface]");
  await expect(surface).toBeVisible();
  await settleShareSurface(surface);
  await expect(surface.getByRole("heading")).toHaveText(
    "Anyone with the link can read this page.",
  );
  await expect(surface.getByRole("button", { name: "Copy link" })).toHaveAttribute("title", "Copy link");
  await expect(surface.getByRole("link", { name: "Open public page" })).toHaveAttribute(
    "title",
    "Open public page",
  );
  await expect(surface.locator(".brain-share-link-field")).toHaveCount(0);
  await expect(surface.locator(".brain-share-url-well")).toHaveCount(0);

  const geometry = await surface.evaluate((node) => {
    const plate = node.firstElementChild as HTMLElement;
    const rows = [...node.querySelectorAll<HTMLElement>("[data-share-row]")];
    const rowRects = rows.map((row) => row.getBoundingClientRect());
    const rowStyles = rows.map((row) => {
      const style = getComputedStyle(row);
      return {
        background: style.backgroundColor,
        hairline: style.borderTopWidth,
        hairlineColor: style.borderTopColor,
        sides: [style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      };
    });
    const head = node.querySelector("h2") as HTMLElement;
    const headStyle = getComputedStyle(head);
    const label = node.querySelector('[data-share-row="read"] .brain-share-row-label') as HTMLElement;
    const value = node.querySelector('[data-share-row="read"] .brain-share-row-value') as HTMLElement;
    const url = node.querySelector("[data-share-url]") as HTMLElement;
    const surfaceBounds = node.getBoundingClientRect();
    const plateBounds = plate.getBoundingClientRect();
    const plateStyle = getComputedStyle(plate);
    const focusOrder = [...node.querySelectorAll<HTMLElement>("button, a")].map(
      (target) => target.getAttribute("aria-label") ?? target.textContent?.trim(),
    );
    const material = getComputedStyle(node);
    const size = (selector: string) => {
      const rect = (node.querySelector(selector) as HTMLElement).getBoundingClientRect();
      return [rect.width, rect.height];
    };
    const action = rows[rows.length - 1];
    const stop = action.querySelector("[data-share-stop-row]") as HTMLElement;
    return {
      surfaceHeight: surfaceBounds.height,
      sleeve: [
        plateBounds.left - surfaceBounds.left,
        surfaceBounds.right - plateBounds.right,
        plateBounds.top - surfaceBounds.top,
        surfaceBounds.bottom - plateBounds.bottom,
      ],
      plate: {
        background: plateStyle.backgroundColor,
        blur: plateStyle.backdropFilter,
        radius: plateStyle.borderTopLeftRadius,
      },
      rowNames: rows.map((row) => row.dataset.shareRow),
      rowHeights: rowRects.map((rect) => rect.height),
      gaps: rowRects.slice(1).map((rect, index) => rect.top - rowRects[index].bottom),
      rowStyles,
      head: {
        size: headStyle.fontSize,
        weight: headStyle.fontWeight,
        bottom: head.getBoundingClientRect().bottom,
        firstRowTop: rowRects[0].top,
      },
      register: {
        labelSize: getComputedStyle(label).fontSize,
        valueSize: getComputedStyle(value).fontSize,
        labelWeight: getComputedStyle(label).fontWeight,
        valueWeight: getComputedStyle(value).fontWeight,
        labelColor: getComputedStyle(label).color,
        valueColor: getComputedStyle(value).color,
        urlFamily: getComputedStyle(url).fontFamily,
        urlSize: getComputedStyle(url).fontSize,
      },
      material: {
        blur: material.backdropFilter !== "none",
        radius: material.borderTopLeftRadius,
        animation: material.animationName,
        border: material.borderTopWidth,
      },
      copySize: size('[aria-label="Copy link"]'),
      openSize: size('[aria-label="Open public page"]'),
      stopRight: action.getBoundingClientRect().right - stop.getBoundingClientRect().right,
      stopPadding: getComputedStyle(stop).paddingRight,
      stopIsLastRow: action.dataset.shareRow === "action" && action.nextElementSibling === null,
      focusOrder,
      urlTitle: url.title,
      overflow: node.scrollWidth - node.clientWidth,
    };
  });
  // the surface is the regular material r14 materializing on data-state
  expect(geometry.material).toEqual({
    blur: true,
    radius: "14px",
    animation: "materialize-in",
    border: "0px",
  });
  // the glass is a 6px sleeve around an opaque paper plate (r8 inside r14),
  // so nothing readable stands on a backdrop layer
  for (const side of geometry.sleeve) expect(side).toBeCloseTo(6, 0);
  expect(geometry.plate.blur).toBe("none");
  expect(geometry.plate.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(geometry.plate.radius).toBe("8px");
  // one head sentence, then the rows in order, the action last
  expect(geometry.head.size).toBe("15px");
  expect(geometry.head.weight).toBe("600");
  expect(geometry.rowNames).toEqual(["link", "read", "password", "action"]);
  expect(geometry.stopIsLastRow).toBe(true);
  // every row is its content on 10px of padding under a 1px hairline, never
  // under 44: the 28 icon buttons make 49, a text row rests on the 44 floor,
  // the 24 switch makes 45, the 32 button in the action row makes 53
  expect(geometry.rowHeights.map((height) => Math.round(height))).toEqual([49, 44, 45, 53]);
  // a four-row card with a one-line head fits 252: the head's 44 plus the
  // rows plus the 6px sleeve on both sides
  expect(geometry.surfaceHeight).toBeLessThanOrEqual(252);
  // rows are separated by one hairline each and nothing else: no fills, no
  // side borders, no gaps
  for (const gap of geometry.gaps) expect(Math.abs(gap)).toBeLessThanOrEqual(1);
  for (const style of geometry.rowStyles) {
    expect(style.background).toBe("rgba(0, 0, 0, 0)");
    expect(style.hairline).toBe("1px");
    expect(style.hairlineColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(style.sides).toEqual(["0px", "0px", "0px"]);
  }
  expect(Math.abs(geometry.head.bottom - geometry.head.firstRowTop)).toBeLessThanOrEqual(1);
  // label and value share one register (Table 14/500); the hierarchy is colour
  expect(geometry.register.labelSize).toBe("14px");
  expect(geometry.register.valueSize).toBe("14px");
  expect(geometry.register.labelWeight).toBe("500");
  expect(geometry.register.valueWeight).toBe("500");
  expect(geometry.register.labelColor).not.toBe(geometry.register.valueColor);
  // the address is the one monospaced value
  expect(geometry.register.urlFamily).toMatch(/JetBrains Mono|monospace/);
  expect(geometry.register.urlSize).toBe("12px");
  // copy and open are the 28 IconButton of rows and menus
  expect(geometry.copySize).toEqual([28, 28]);
  expect(geometry.openSize).toEqual([28, 28]);
  // the red capsule hangs 8 into the row's 12 and keeps 8 of padding, so the
  // label ends on the row's text rule, 12 from the plate's edge
  expect(geometry.stopRight).toBeCloseTo(4, 0);
  expect(geometry.stopPadding).toBe("8px");
  expect(geometry.focusOrder.slice(0, 4)).toEqual([
    "Copy link",
    "Open public page",
    "Password protection",
    "Stop sharing",
  ]);
  expect(geometry.urlTitle).toContain(`/share/${created.id}`);
  expect(geometry.overflow).toBeLessThanOrEqual(1);

  await page.keyboard.press("Escape");
  await expect(surface).toBeHidden();
  await expect(page.locator('button[aria-label="Share"]:visible')).toBeFocused();
});

test("default active mobile utility keeps 44px targets separate without wrapping", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await login(page);
  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Mobile active share utility", markdown: "Body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  const disclosure = await browserJson(page, `/api/page/${created.id}/share`);
  const enabled = await browserJson(page, `/api/page/${created.id}/share`, {
    method: "POST",
    body: {
      enabled: true,
      expectedScopeToken: (disclosure.body as { scopeToken: string }).scopeToken,
      password: null,
      expiresAt: null,
    },
  });
  expect(enabled.ok).toBeTruthy();

  await page.goto(`/p/${created.id}`);
  const trigger = page.locator('[data-share-mobile-trigger][aria-label="Share"]').first();
  await trigger.click();
  const surface = page.locator("[data-share-mobile-surface]");
  await expect(surface).toBeVisible();
  await settleShareSurface(surface);

  const geometry = await surface.evaluate((node) => {
    const rect = (selector: string) =>
      (node.querySelector(selector) as HTMLElement).getBoundingClientRect();
    const rows = [...node.querySelectorAll<HTMLElement>("[data-share-row]")];
    const rowRects = rows.map((row) => row.getBoundingClientRect());
    const plate = node.firstElementChild as HTMLElement;
    const copy = rect('[aria-label="Copy link"]');
    const open = rect('[aria-label="Open public page"]');
    const password = rect('[aria-label="Password protection"]');
    const stop = rect("[data-share-stop-row]");
    const intersects = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const sheetBounds = node.getBoundingClientRect();
    const plateBounds = plate.getBoundingClientRect();
    return {
      rowNames: rows.map((row) => row.dataset.shareRow),
      rowHeights: rowRects.map((row) => row.height),
      gaps: rowRects.slice(1).map((row, index) => row.top - rowRects[index].bottom),
      plateRadius: getComputedStyle(plate).borderTopLeftRadius,
      plateInset: [plateBounds.left - sheetBounds.left, sheetBounds.right - plateBounds.right],
      sizes: {
        copy: [copy.width, copy.height],
        open: [open.width, open.height],
        password: [password.width, password.height],
        stop: [stop.width, stop.height],
      },
      overlap: intersects(copy, open) || intersects(password, stop),
      overflow: node.scrollWidth - node.clientWidth,
      linkWrap: Math.abs(copy.top - open.top),
    };
  });
  // the same ledger on the phone sheet: the plate is r10 at the sheet's 10
  // (sheet 20 = 10 + 10), every row and every control at the 44 minimum
  expect(geometry.rowNames).toEqual(["link", "read", "password", "action"]);
  expect(geometry.plateRadius).toBe("10px");
  expect(geometry.plateInset).toEqual([10, 10]);
  for (const height of geometry.rowHeights) expect(height).toBeGreaterThanOrEqual(44);
  for (const gap of geometry.gaps) expect(Math.abs(gap)).toBeLessThanOrEqual(1);
  expect(geometry.sizes.copy).toEqual([44, 44]);
  expect(geometry.sizes.open).toEqual([44, 44]);
  expect(geometry.sizes.password).toEqual([56, 44]);
  expect(geometry.sizes.stop[0]).toBeGreaterThanOrEqual(88);
  expect(geometry.sizes.stop[1]).toBe(44);
  expect(geometry.overlap).toBe(false);
  expect(geometry.linkWrap).toBeLessThanOrEqual(1);
  expect(geometry.overflow).toBeLessThanOrEqual(1);

  await page.keyboard.press("Escape");
  await expect(surface).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Duplicate waits for the visible unsaved body before copying", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Duplicate fresh body", markdown: "Old body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  await page.goto(`/p/${created.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await content.fill("Fresh body typed immediately before duplicate");

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();

  await expect(page).not.toHaveURL(`/p/${created.id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    "Duplicate fresh body (copy)",
  );
  await expect(
    page.getByRole("textbox", { name: "Page content" }),
  ).toContainText("Fresh body typed immediately before duplicate");
});

test("@release page appearance persists across editor and public share", async ({ page }) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "Page appearance",
      markdown: [
        "#### Deep heading",
        "",
        ':::callout{icon="💡"}',
        "A wide callout",
        ":::",
      ].join("\n"),
    },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  expect(
    (
      await browserJson(page, `/api/page/${created.id}`, {
        method: "PATCH",
        body: {
          font: "mono",
          smallText: true,
          fullWidth: true,
        },
      })
    ).ok,
  ).toBeTruthy();
  const disclosure = await browserJson(
    page,
    `/api/page/${created.id}/share`,
  );
  expect(disclosure.ok).toBeTruthy();
  expect(
    (
      await browserJson(page, `/api/page/${created.id}/share`, {
        method: "POST",
        body: {
          enabled: true,
          expectedScopeToken: (disclosure.body as { scopeToken: string })
            .scopeToken,
          password: null,
          expiresAt: null,
        },
      })
    ).ok,
  ).toBeTruthy();

  await page.goto(`/p/${created.id}`);
  const article = page.locator("article.brain-page-article");
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(article).toHaveAttribute("data-page-font", "mono");
  await expect(article).toHaveAttribute("data-small-text", "true");
  await expect(article).toHaveAttribute("data-full-width", "true");
  await expect(content.locator("h4")).toHaveCSS("max-width", "none");
  await expect(content.locator(".brain-callout")).toHaveCSS("max-width", "none");
  const editorFonts = await content.evaluate((editor) => ({
    body: getComputedStyle(editor).fontFamily,
    heading: getComputedStyle(editor.querySelector("h4") as HTMLElement).fontFamily,
    size: getComputedStyle(editor).fontSize,
  }));
  const editorTitleFont = await page
    .getByRole("textbox", { name: "Page title" })
    .evaluate((title) => getComputedStyle(title).fontFamily);
  expect(editorFonts.heading).toBe(editorTitleFont);
  expect(editorFonts.heading).not.toBe(editorFonts.body);
  expect(editorFonts.size).toBe("14px");

  await page.reload();
  await expect(article).toHaveAttribute("data-page-font", "mono");
  await expect(article).toHaveAttribute("data-full-width", "true");

  await page.goto(`/share/${created.id}`);
  const sharedArticle = page.locator("article.brain-page-article");
  const sharedContent = sharedArticle.locator(".ProseMirror");
  await expect(sharedArticle).toHaveAttribute("data-page-font", "mono");
  await expect(sharedArticle).toHaveAttribute("data-small-text", "true");
  await expect(sharedArticle).toHaveAttribute("data-full-width", "true");
  await expect(sharedContent).toHaveCSS("white-space", "normal");
  await expect(sharedContent.locator("h4")).toHaveCSS("max-width", "none");
  const shareFonts = await sharedArticle.evaluate((node) => ({
    title: getComputedStyle(node.querySelector("h1") as HTMLElement).fontFamily,
    heading: getComputedStyle(node.querySelector("h4") as HTMLElement).fontFamily,
    body: getComputedStyle(node.querySelector(".ProseMirror") as HTMLElement)
      .fontFamily,
  }));
  expect(shareFonts.heading).toBe(shareFonts.title);
  expect(shareFonts.title).not.toBe(shareFonts.body);
});

test("public share renders authorized structural children without changing Markdown", async ({
  page,
  context,
}) => {
  await login(page);
  const rootResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Public structural children" },
  });
  expect(rootResponse.ok).toBeTruthy();
  const root = rootResponse.body as { id: string };
  const authoredResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: root.id, title: "Authored public child" },
  });
  const derivedTitle =
    "🧭 Derived public child with a deliberately long title that wraps safely";
  const derivedResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: root.id, title: derivedTitle },
  });
  expect(authoredResponse.ok).toBeTruthy();
  expect(derivedResponse.ok).toBeTruthy();
  const authored = authoredResponse.body as { id: string };
  const derived = derivedResponse.body as { id: string };
  const rootBefore = await browserJson(page, `/api/page/${root.id}`);
  const markdown = `Body before children\n\n[Authored child](/p/${authored.id})`;
  const seeded = await browserJson(page, `/api/page/${root.id}`, {
    method: "PUT",
    body: {
      markdown,
      rev: (rootBefore.body as { rev: string }).rev,
    },
  });
  expect(seeded.ok).toBeTruthy();
  const disclosure = await browserJson(page, `/api/page/${root.id}/share`);
  expect(disclosure.ok).toBeTruthy();
  const shared = await browserJson(page, `/api/page/${root.id}/share`, {
    method: "POST",
    body: {
      enabled: true,
      expectedScopeToken: (disclosure.body as { scopeToken: string }).scopeToken,
      password: null,
      expiresAt: null,
    },
  });
  expect(shared.ok).toBeTruthy();

  await context.clearCookies();
  await page.goto(`/share/${root.id}`);
  const article = page.locator("article.brain-page-article");
  const authoredLink = article.locator(
    `.ProseMirror a.brain-page-ref[href="/share/${root.id}?page=${authored.id}"]`,
  );
  const derivedWrapper = article.locator("[data-derived-page-refs]");
  const derivedLink = derivedWrapper.locator(
    `a.brain-page-ref[data-page-ref="${derived.id}"]`,
  );
  await expect(authoredLink).toHaveCount(1);
  await expect(derivedLink).toHaveCount(1);
  await expect(derivedLink).toHaveText(`📄 ${derivedTitle}`);
  await expect(derivedLink).toHaveAttribute(
    "href",
    `/share/${root.id}?page=${derived.id}`,
  );
  await expect(
    derivedWrapper.locator(`a[data-page-ref="${authored.id}"]`),
  ).toHaveCount(0);
  await expect(article.locator("a.brain-page-ref")).toHaveCount(2);
  await expect(derivedWrapper.locator("section, header, h2, ul, ol, li")).toHaveCount(0);
  await expect(article.getByText("Subpages", { exact: true })).toHaveCount(0);
  await expect(derivedWrapper).toHaveCSS("border-top-width", "0px");

  const styles = async (locator: Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        padding: style.padding,
        margin: style.margin,
        borderRadius: style.borderRadius,
      };
    });
  expect(await styles(derivedLink)).toEqual(await styles(authoredLink));

  await page.setViewportSize({ width: 320, height: 800 });
  await expect(derivedLink).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
  await derivedLink.click();
  await expect(page).toHaveURL(
    new RegExp(`/share/${root.id}\\?page=${derived.id}$`),
  );
  await expect(page.locator("article h1")).toHaveText(derivedTitle);
  const backLink = page.getByRole("link", {
    name: "Back to Public structural children",
  });
  await expect(backLink).toHaveAttribute("href", `/share/${root.id}`);
  await expect(backLink).toContainText("Public structural children");
  await expect(backLink).not.toContainText("←");
  await expect(backLink.locator("svg")).toHaveAttribute("width", "14");
  const restingColor = await backLink.evaluate(
    (element) => getComputedStyle(element).color,
  );
  await backLink.hover();
  expect(
    await backLink.evaluate((element) => getComputedStyle(element).color),
  ).not.toBe(restingColor);
  await backLink.focus();
  await expect(backLink).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);

  await login(page);
  const rootAfter = await browserJson(page, `/api/page/${root.id}`);
  expect((rootAfter.body as { markdown: string }).markdown).toBe(markdown);
});

test("@mobile public descendant back link has a 44px touch target at 320", async ({
  page,
  context,
}) => {
  await login(page);
  const rootTitle =
    "Shared parent with a deliberately long title that must truncate safely";
  const rootResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: rootTitle },
  });
  expect(rootResponse.ok).toBeTruthy();
  const root = rootResponse.body as { id: string };
  const childResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: root.id, title: "Shared mobile child" },
  });
  expect(childResponse.ok).toBeTruthy();
  const child = childResponse.body as { id: string };
  const disclosure = await browserJson(page, `/api/page/${root.id}/share`);
  expect(disclosure.ok).toBeTruthy();
  expect(
    (
      await browserJson(page, `/api/page/${root.id}/share`, {
        method: "POST",
        body: {
          enabled: true,
          expectedScopeToken: (disclosure.body as { scopeToken: string })
            .scopeToken,
          password: null,
          expiresAt: null,
        },
      })
    ).ok,
  ).toBeTruthy();

  await context.clearCookies();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`/share/${root.id}?page=${child.id}`);
  const backLink = page.getByRole("link", { name: `Back to ${rootTitle}` });
  await expect(backLink).toBeVisible();
  await expect(backLink).toHaveAttribute("href", `/share/${root.id}`);
  await expect(backLink).toHaveClass(/brain-touch-hit/);
  await expect(backLink.locator("svg")).toHaveAttribute("height", "14");
  await expect(backLink).not.toContainText("←");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);

  const touchTarget = await backLink.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const pseudo = getComputedStyle(element, "::before");
    const width = Number.parseFloat(pseudo.width);
    const height = Number.parseFloat(pseudo.height);
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const inset = 3;
    const points = [
      [centerX, centerY - height / 2 + inset],
      [centerX, centerY],
      [centerX, centerY + height / 2 - inset],
    ];
    return {
      width,
      height,
      owned: points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === element || (hit !== null && element.contains(hit));
      }),
    };
  });
  expect(touchTarget.width).toBeGreaterThanOrEqual(44);
  expect(touchTarget.height).toBeGreaterThanOrEqual(44);
  expect(touchTarget.owned).toBe(true);
  await backLink.focus();
  await expect(backLink).toBeFocused();
});

test("@release pinned roots stay discoverable while home and search remain concise", async ({
  page,
}, testInfo) => {
  await login(page);
  const suffix = `${Date.now()}-${testInfo.retry}`;
  const created: Array<{ id: string; title: string }> = [];
  for (let index = 0; index < 7; index += 1) {
    const title = `Navigation clarity ${index} ${suffix}`;
    const response = await browserJson(page, "/api/page", {
      method: "POST",
      body: { title, markdown: `Activity ${index}` },
    });
    expect(response.ok).toBeTruthy();
    created.push({ id: (response.body as { id: string }).id, title });
  }
  expect(
    (
      await browserJson(page, `/api/page/${created[0].id}`, {
        method: "PATCH",
        body: { pinned: true },
      })
    ).ok,
  ).toBeTruthy();

  await page.goto("/");
  const sidebar = page.locator("aside");
  const pinnedSection = sidebar.getByText("Pinned", { exact: true }).locator("..");
  await expect(
    pinnedSection.getByText(created[0].title, { exact: true }),
  ).toBeVisible();
  await expect(sidebar.getByText(created[0].title, { exact: true })).toHaveCount(2);
  await pinnedSection.getByText(created[0].title, { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Page content" })).toBeVisible();
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page).toHaveURL("/");

  await expect(
    pinnedSection.getByText(created[0].title, { exact: true }),
  ).toBeVisible();
  const reviewAll = page.getByRole("button", { name: /Review all \(/ });
  await expect(reviewAll).toBeVisible();
  await reviewAll.click();
  await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();

  await page.locator('[data-search-trigger="desktop"]').click();
  const palette = page.getByTestId("desktop-command-palette");
  await expect(palette.getByText("Recent", { exact: true })).toBeVisible();
  await expect(palette.getByText("All pages", { exact: true })).toHaveCount(0);

  await palette.locator("input[cmdk-input]").fill(created[1].title);
  await expect(palette.getByText("Pages", { exact: true })).toBeVisible();
  await expect(
    palette.getByRole("option", { name: new RegExp(created[1].title) }),
  ).toBeVisible();
});

test("@mobile Pages and Search are accessible mobile-only surfaces", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await login(page);
  const createdTitle = `Mobile primary navigation ${Date.now()}-${testInfo.retry}`;

  const captureSurface = async (
    surface: "pages" | "search" | "settings",
    width: number,
  ) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.classList.contains("dark")),
        )
        .toBe(scheme === "dark");
      const name = `${surface}-${width}-${scheme}.png`;
      const path = testInfo.outputPath(name);
      await page.screenshot({ path });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.classList.contains("dark")),
      )
      .toBe(false);
  };

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: createdTitle },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  const tabbar = page.locator("nav.brain-mobile-tabbar");
  const sidebar = page.locator("aside.brain-sidebar");
  const main = page.locator("main.brain-main");
  const pagesView = page.getByTestId("mobile-pages-view");
  const searchView = page.getByTestId("mobile-search-view");
  const labels = ["Home", "Search", "New", "Pages", "Mail"];

  const viewportContent =
    (await page.locator('meta[name="viewport"]').getAttribute("content")) ?? "";
  expect(viewportContent).not.toMatch(/maximum-scale/i);
  expect(viewportContent).not.toMatch(/user-scalable\s*=\s*no/i);

  const assertMobileNavigation = async (width: number) => {
    await page.setViewportSize({
      width,
      height: width === 390 ? 844 : width === 700 ? 700 : 568,
    });
    await expect(tabbar).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
    await expect(tabbar.getByRole("button")).toHaveCount(5);
    for (const label of labels) {
      const button = tabbar.getByRole("button", { name: label, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${label} is missing a mobile hit target`).not.toBeNull();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);

    const mailTab = tabbar.getByRole("button", { name: "Mail", exact: true });
    await mailTab.click();
    await expect(page).toHaveURL("/mail");
    await expect(mailTab).toHaveAttribute("aria-current", "page");
    await page.goBack();
    await expect(page).toHaveURL(`/p/${created.id}`);

    const pagesTab = tabbar.getByRole("button", { name: "Pages", exact: true });
    await pagesTab.click();
    await expect(tabbar).not.toHaveAttribute("aria-hidden", "true");
    await expect(pagesTab).toHaveAttribute("aria-current", "page");
    await expect(pagesView).toBeVisible();
    await expect(pagesView).toHaveAttribute("role", "dialog");
    await expect(pagesView).toHaveAttribute("aria-modal", "true");
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    await expect(main).toHaveAttribute("aria-hidden", "true");
    expect(await sidebar.evaluate((element) => (element as HTMLElement).inert)).toBe(
      true,
    );
    expect(await main.evaluate((element) => (element as HTMLElement).inert)).toBe(
      true,
    );
    await expect
      .poll(async () => (await sidebar.boundingBox())?.x ?? -Infinity)
      .toBeLessThan(-200);

    const search = pagesView.getByRole("textbox", { name: "Search pages" });
    // opening Pages must not raise the keyboard: the sheet itself takes
    // focus, the search field focuses only on an explicit tap
    await expect(pagesView).toBeFocused();
    await expect(search).not.toBeFocused();
    expect(
      Number.parseFloat(
        await search.evaluate((input) => getComputedStyle(input).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
    await captureSurface("pages", width);
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press("Tab");
      const focusState = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return {
          insidePages: !!active?.closest('[data-testid="mobile-pages-view"]'),
          hidden: !!active?.closest('[aria-hidden="true"], [inert]'),
          visible: !!active && active.getClientRects().length > 0,
        };
      });
      expect(focusState).toEqual({
        insidePages: true,
        hidden: false,
        visible: true,
      });
    }

    const searchTab = tabbar.getByRole("button", {
      name: "Search",
      exact: true,
    });
    await searchTab.click();
    await expect(pagesView).toBeHidden();
    await expect(searchView).toBeVisible();
    await expect(searchView).toHaveAttribute("role", "dialog");
    await expect(searchView).toHaveAttribute("aria-modal", "true");
    await expect(searchTab).toHaveAttribute("aria-current", "page");
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    await expect(main).toHaveAttribute("aria-hidden", "true");
    const palette = page.getByRole("combobox", {
      name: "Search and commands",
    });
    await expect(palette).toBeVisible();
    await expect(palette).toBeFocused();
    expect(
      Number.parseFloat(await palette.evaluate((input) => getComputedStyle(input).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await captureSurface("search", width);
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press("Tab");
      const focusState = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return {
          insideSearch: !!active?.closest('[data-testid="mobile-search-view"]'),
          hidden: !!active?.closest('[aria-hidden="true"], [inert]'),
          visible: !!active && active.getClientRects().length > 0,
        };
      });
      expect(focusState).toEqual({
        insideSearch: true,
        hidden: false,
        visible: true,
      });
    }

    // Primary navigation must close Search before switching surfaces. Leaving
    // the palette mounted here would cover Mail even though the URL changed.
    await mailTab.click();
    await expect(page).toHaveURL("/mail");
    await expect(searchView).toBeHidden();
    await expect(mailTab).toHaveAttribute("aria-current", "page");
    await page.goBack();
    await expect(page).toHaveURL(`/p/${created.id}`);
    await expect(searchView).toBeHidden();
    await searchTab.click();
    await expect(searchView).toBeVisible();
    await expect(palette).toBeFocused();

    await palette.fill(createdTitle);
    const paletteResult = page.locator(
      `[cmdk-item][data-value="page-${created.id}"]`,
    );
    await expect(paletteResult).toHaveAccessibleName(new RegExp(createdTitle));
    await paletteResult.click();
    await expect(searchView).toBeHidden();
    await expect(page).toHaveURL(`/p/${created.id}`);
    // The sidebar stays off-canvas (and out of the a11y tree) on mobile —
    // only the main surface comes back.
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    await expect(main).not.toHaveAttribute("aria-hidden", "true");
    await expect(searchTab).toBeFocused();

    await searchTab.click();
    await expect(searchView).toBeVisible();
    await expect(palette).toBeFocused();
    await palette.fill("Mobile");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(searchView).toBeHidden();
    await expect(searchTab).toBeFocused();

    await tabbar.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(pagesView).toBeVisible();

    const settingsGear = pagesView.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    const settingsRoot = page.getByTestId("mobile-settings-root");
    const openAndAssertSettings = async () => {
      await settingsGear.click();
      // the gear navigates to /settings — a full-screen page of the shell,
      // never a dialog; the drawer closes under it
      await expect(page).toHaveURL("/settings");
      await expect(settingsRoot).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(pagesView).toBeHidden();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
      ).toBeLessThanOrEqual(0);
    };
    const assertPagesRestored = async () => {
      // leaving /settings restores the Pages drawer and its gear owns focus
      await expect(page).toHaveURL(`/p/${created.id}`);
      await expect(settingsRoot).toBeHidden();
      await expect(pagesView).toBeVisible();
      await expect(settingsGear).toBeVisible();
      await expect(settingsGear).toBeFocused();
      await expect(sidebar).toHaveAttribute("aria-hidden", "true");
      await expect(main).toHaveAttribute("aria-hidden", "true");
      expect(
        await sidebar.evaluate((element) => (element as HTMLElement).inert),
      ).toBe(true);
      expect(await main.evaluate((element) => (element as HTMLElement).inert)).toBe(
        true,
      );
    };

    await openAndAssertSettings();
    await captureSurface("settings", width);
    await settingsRoot
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await assertPagesRestored();

    await page.goForward();
    await expect(page).toHaveURL("/settings");
    await expect(settingsRoot).toBeVisible();
    await page.goBack();
    await assertPagesRestored();

    await openAndAssertSettings();
    await page.keyboard.press("Escape");
    await assertPagesRestored();

    await openAndAssertSettings();
    await page.goBack();
    await assertPagesRestored();

    await search.fill(createdTitle);
    const result = pagesView.getByRole("button", {
      name: `Open ${createdTitle}`,
      exact: true,
    });
    await expect(result).toBeVisible();
    await result.click();
    await expect(pagesView).toBeHidden();
    await expect(page).toHaveURL(`/p/${created.id}`);
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    await expect(main).not.toHaveAttribute("aria-hidden", "true");
    expect(await sidebar.evaluate((element) => (element as HTMLElement).inert)).toBe(
      true,
    );
    expect(await main.evaluate((element) => (element as HTMLElement).inert)).toBe(
      false,
    );
    await expect(
      tabbar.getByRole("button", { name: "Pages", exact: true }),
    ).toBeFocused();

    await tabbar.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(pagesView).toBeVisible();
    await pagesView.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(pagesView).toBeHidden();
    await expect(
      tabbar.getByRole("button", { name: "Pages", exact: true }),
    ).toBeFocused();

    await tabbar.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(pagesView).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pagesView).toBeHidden();
    await expect(
      tabbar.getByRole("button", { name: "Pages", exact: true }),
    ).toBeFocused();
  };

  await assertMobileNavigation(390);
  await assertMobileNavigation(320);
  await assertMobileNavigation(700);

  await tabbar.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(pagesView).toBeVisible();
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(pagesView).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(main).toBeFocused();
});

test("@mobile Search hands focus to Home and a newly created page", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const sourceResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Mobile Search focus source" },
  });
  expect(sourceResponse.ok).toBeTruthy();
  const source = sourceResponse.body as { id: string };
  await page.goto(`/p/${source.id}`);

  const tabbar = page.locator("nav.brain-mobile-tabbar");
  const searchView = page.getByTestId("mobile-search-view");
  await tabbar.getByRole("button", { name: "Search", exact: true }).click();
  await expect(searchView).toBeVisible();

  // Next's dev badge overlaps the bottom-left tab; production has no such
  // portal, so dispatch to the semantic control itself.
  await searchView
    .getByRole("button", { name: "Home", exact: true })
    .dispatchEvent("click");
  await expect(searchView).toBeHidden();
  await expect(page).toHaveURL("/");
  const outerHome = tabbar.getByRole("button", { name: "Home", exact: true });
  await expect(outerHome).toHaveAttribute("aria-current", "page");
  await expect(outerHome).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(
    false,
  );

  await tabbar.getByRole("button", { name: "Search", exact: true }).click();
  await expect(searchView).toBeVisible();
  const createdResponse = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/page"
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as { parentId?: string | null };
    return body.parentId === null;
  });
  await searchView.getByRole("button", { name: "New", exact: true }).click();
  const response = await createdResponse;
  expect(response.ok()).toBeTruthy();
  const created = (await response.json()) as { id: string };

  await expect(searchView).toBeHidden();
  await expect(page).toHaveURL(`/p/${created.id}`);
  const title = page.getByRole("textbox", { name: "Page title" });
  await expect(title).toHaveValue("Untitled");
  await expect(title).toBeFocused();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(title).toBeFocused();
});

test("@mobile Search crosses the 768px boundary without losing state", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Responsive surface state" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);
  await page.setViewportSize({ width: 700, height: 700 });

  const tabbar = page.locator("nav.brain-mobile-tabbar");
  const sidebar = page.locator("aside.brain-sidebar");
  const main = page.locator("main.brain-main");
  const pagesView = page.getByTestId("mobile-pages-view");
  const searchView = page.getByTestId("mobile-search-view");

  // Search is a peer full-screen surface on mobile. At exactly 768px the same
  // open search becomes the existing desktop palette with its query and focus.
  await tabbar.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(pagesView).toBeVisible();
  await tabbar.getByRole("button", { name: "Search", exact: true }).click();
  const resizedPalette = page.getByRole("combobox", {
    name: "Search and commands",
  });
  await expect(pagesView).toBeHidden();
  await expect(searchView).toBeVisible();
  await expect(resizedPalette).toBeVisible();
  await expect(resizedPalette).toBeFocused();
  await resizedPalette.fill("Responsive");
  await page.setViewportSize({ width: 768, height: 700 });
  await expect(searchView).toBeHidden();
  await expect(page.getByTestId("desktop-command-palette")).toBeVisible();
  await expect(sidebar).toBeVisible();
  // The desktop palette is a real modal dialog: the app behind it is hidden
  // from assistive tech while it is open, but never made inert (that is the
  // mobile blocking-surface contract only).
  await expect(main).toHaveAttribute("aria-hidden", "true");
  expect(await main.evaluate((element) => (element as HTMLElement).inert)).toBe(
    false,
  );
  await expect(resizedPalette).toBeVisible();
  await expect(resizedPalette).toBeFocused();
  await expect(resizedPalette).toHaveValue("Responsive");
  await expect(resizedPalette).toHaveCSS("font-size", "17px");
  await page.keyboard.press("Escape");
  await expect(resizedPalette).toBeHidden();
  await expect(main).not.toHaveAttribute("aria-hidden", "true");
  await expect(sidebar.locator('[data-search-trigger="desktop"]')).toBeFocused();

  // Opening Settings on desktop and then narrowing the viewport must keep
  // browser navigation the owner of the surface. Back leaves it, Forward
  // re-enters it, and focus lands on the visible Settings entry point.
  const desktopSettings = sidebar.getByRole("button", {
    name: "Settings",
    exact: true,
  });
  // Next's dev badge overlaps this bottom-left control; production has no such
  // portal, so dispatch to the semantic control instead of testing the badge.
  await desktopSettings.dispatchEvent("click");
  await expect(page).toHaveURL("/settings/appearance");
  const settingsDetail = page.getByTestId("mobile-settings-detail");
  await expect(settingsDetail).toBeVisible();
  await page.setViewportSize({ width: 700, height: 700 });
  // the narrowed viewport keeps the deep-linked section as a mobile screen
  await expect(settingsDetail).toBeVisible();
  await page.goBack();
  await expect(settingsDetail).toBeHidden();
  await expect(
    tabbar.getByRole("button", { name: "Pages", exact: true }),
  ).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL("/settings/appearance");
  await expect(settingsDetail).toBeVisible();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goBack();
  await expect(settingsDetail).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(desktopSettings).toBeFocused();
});

test("a block moves into a column and back, then the empty column collapses", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Column drag roundtrip", markdown: "123123\n\n## Привет" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  const content = page.getByRole("textbox", { name: "Page content" });
  let greeting = content.getByRole("heading", { name: "Привет", exact: true });
  const firstBlock = content.locator("p").filter({ hasText: /^123123$/ });
  const firstBox = await firstBlock.boundingBox();
  expect(firstBox).not.toBeNull();
  if (!firstBox) throw new Error("Missing first block geometry");

  // A narrow side-edge drop creates the second column.
  await dragBlockToPoint(
    page,
    greeting,
    { x: firstBox.x + firstBox.width - 2, y: firstBox.y + firstBox.height / 2 },
    "side",
  );
  await expect(content.locator(".brain-cols")).toHaveCount(1);
  await expect(content.locator(".brain-col")).toHaveCount(2);

  const persistedMarkdown = async () => {
    const read = await browserJson(page, `/api/page/${created.id}`);
    return ((read.body as { markdown?: string }).markdown ?? "").trim();
  };
  await expect.poll(persistedMarkdown).toContain("::::cols");

  // The whole left lane — including whitespace below its block — accepts the
  // return drop. Once the right lane is empty, the layout becomes one flow.
  // Put the caret in the unobscured left block so the NodeSelection toolbar
  // from the first drag closes before the next handle hover.
  await firstBlock.click({ position: { x: 4, y: 8 } });
  greeting = content.getByRole("heading", { name: "Привет", exact: true });
  const leftColumn = content.locator(".brain-col").first();
  const leftBox = await leftColumn.boundingBox();
  expect(leftBox).not.toBeNull();
  if (!leftBox) throw new Error("Missing left column geometry");
  await dragBlockToPoint(
    page,
    greeting,
    { x: leftBox.x + leftBox.width / 2, y: leftBox.y + leftBox.height - 2 },
    "inside",
    "cancel",
  );
  await expect(content.locator(".brain-col")).toHaveCount(2);

  // A cancelled drag must not strand the custom cursor or poison the next try.
  await firstBlock.click({ position: { x: 4, y: 8 } });
  greeting = content.getByRole("heading", { name: "Привет", exact: true });
  await dragBlockToPoint(
    page,
    greeting,
    { x: leftBox.x + leftBox.width / 2, y: leftBox.y + leftBox.height - 2 },
    "inside",
  );

  await expect(content.locator(".brain-cols")).toHaveCount(0);
  await expect
    .poll(() => content.evaluate((element) => document.activeElement === element))
    .toBe(true);
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+z`);
  await expect(content.locator(".brain-cols")).toHaveCount(1);
  await expect(content.locator(".brain-col")).toHaveCount(2);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(content.locator(".brain-cols")).toHaveCount(0);
  await expect.poll(persistedMarkdown).toBe("123123\n\n## Привет");
  await page.reload();
  await expect(content.locator(".brain-cols")).toHaveCount(0);
  await expect(content.getByText("123123", { exact: true })).toBeVisible();
  await expect(
    content.getByRole("heading", { name: "Привет", exact: true }),
  ).toBeVisible();
});

test("slash Columns keeps two empty lanes ready for editing", async ({ page }) => {
  await login(page);
  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Empty columns" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);

  const content = page.getByRole("textbox", { name: "Page content" });
  await content.focus();
  await page.keyboard.type("/");
  const slashMenu = page.getByTestId("slash-menu");
  await expect(slashMenu).toBeVisible();
  await slashMenu
    .getByRole("button", { name: "Columns", exact: true })
    .click();

  await expect(content.locator(".brain-cols")).toHaveCount(1);
  await expect(content.locator(".brain-col")).toHaveCount(2);
  await page.waitForTimeout(300);
  await expect(content.locator(".brain-col")).toHaveCount(2);
  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/page/${created.id}`);
      return (read.body as { markdown?: string }).markdown ?? "";
    })
    .toContain("::::cols");
});

test("a trailing page reference keeps a writable line for slash commands", async ({
  page,
}) => {
  await login(page);

  const childResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Current child title" },
  });
  expect(childResponse.ok).toBeTruthy();
  const child = childResponse.body as { id: string };

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "Trailing page reference",
      markdown: `[Stale child title](/p/${child.id})`,
    },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };

  let bodyPuts = 0;
  await page.route(`**/api/page/${parent.id}`, async (route) => {
    if (route.request().method() === "PUT") bodyPuts += 1;
    await route.continue();
  });

  await page.goto(`/p/${parent.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  const pageRef = content.locator(
    `a.brain-page-ref[data-page-ref="${child.id}"]`,
  );
  await expect(pageRef).toHaveCount(1);

  const trailingParagraph = content.locator("p").last();
  await expect(trailingParagraph).toHaveText("");
  await expect(pageRef).toContainText("Current child title");

  // Loading normalizes the stale stored label and appends a synthetic empty
  // line. Neither display-only change may create a body revision on blur.
  await content.focus();
  await content.blur();
  await page.waitForTimeout(900);
  expect(bodyPuts).toBe(0);

  // Refocusing the editor used to leave ProseMirror's real selection in the
  // page-ref paragraph while the browser painted the caret below it. The user
  // should not have to click the synthetic line a second time before typing.
  await content.focus();
  await page.keyboard.type("/");

  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(pageRef).toContainText("Current child title");
  await expect(trailingParagraph).toHaveText("/");
});

// The test above reaches the editor through `focus()` because that is what the
// product does for the reader: Enter from the title hands the body the focus
// and nothing else. Say it in the reader's own gesture too — a page that opens
// with a page reference offers the browser no text position of its own, so a
// focus that carries no caret drops every key that follows it.
test("Enter from the title types into a page that opens with a reference", async ({
  page,
}) => {
  await login(page);

  const childResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Reference-first child" },
  });
  expect(childResponse.ok).toBeTruthy();
  const child = childResponse.body as { id: string };

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "Reference-first page",
      markdown: `[Reference-first child](/p/${child.id})`,
    },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };

  await page.goto(`/p/${parent.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(
    content.locator(`a.brain-page-ref[data-page-ref="${child.id}"]`),
  ).toHaveCount(1);

  await page.getByRole("textbox", { name: "Page title" }).click();
  await page.keyboard.press("Enter");
  await expect(content).toBeFocused();
  const typed = "the body took the key";
  await page.keyboard.type(typed);

  await expect(content).toContainText(typed);
  await expect(
    content.locator(`a.brain-page-ref[data-page-ref="${child.id}"]`),
  ).toHaveCount(1);
  await expect
    .poll(async () => {
      const response = await browserJson(page, `/api/page/${parent.id}`);
      return (response.body as { markdown: string }).markdown;
    })
    .toContain(typed);
});

test("slash menu creates a page at the cursor and saves before opening it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Slash parent", markdown: "Before" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };

  await page.goto(`/p/${parent.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  const beforeParagraph = content.locator("p").filter({ hasText: /^Before$/ });
  await expect(beforeParagraph).toHaveCount(1);
  await content.focus();
  await beforeParagraph.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error("Before paragraph has no text node");
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text, text.textContent?.length ?? 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");

  const slashMenu = page.getByTestId("slash-menu");
  await expect(slashMenu).toBeVisible();
  const newPageOption = slashMenu.getByRole("button", {
    name: "New page",
    exact: true,
  });
  await expect(newPageOption).toBeVisible();
  await expect(
    slashMenu.getByRole("button").first(),
  ).toHaveText(/New page/);

  let releaseRefSave!: () => void;
  const refSaveGate = new Promise<void>((resolve) => {
    releaseRefSave = resolve;
  });
  let markRefSaveSeen!: () => void;
  const refSaveSeen = new Promise<void>((resolve) => {
    markRefSaveSeen = resolve;
  });
  let sawRefSave = false;
  await page.route(`**/api/page/${parent.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { markdown?: string };
      if (body.markdown?.includes("/p/")) {
        if (!sawRefSave) {
          sawRefSave = true;
          markRefSaveSeen();
        }
        await refSaveGate;
      }
    }
    await route.continue();
  });
  let failNextTreeRefresh = true;
  await page.route("**/api/tree", async (route) => {
    if (failNextTreeRefresh) {
      failNextTreeRefresh = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary tree failure" }),
      });
      return;
    }
    await route.continue();
  });
  const failedTreeRefresh = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/tree" &&
      response.status() === 503,
  );

  const createdResponse = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/page"
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as { parentId?: string };
    return body.parentId === parent.id;
  });

  try {
    await page.keyboard.press("Enter");
    const response = await createdResponse;
    expect(response.ok()).toBeTruthy();
    const created = (await response.json()) as {
      id: string;
      title: string;
    };

    await refSaveSeen;
    await expect(page).toHaveURL(`/p/${parent.id}`);
    releaseRefSave();

    await failedTreeRefresh;
    await expect(page).toHaveURL(`/p/${created.id}`, { timeout: 15_000 });
    const createdTitle = page.getByRole("textbox", { name: "Page title" });
    await expect(createdTitle).toHaveValue("Untitled");
    await expect(createdTitle).toBeFocused();
    await expect(
      page.getByText("Page created. Refresh to update the sidebar"),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const read = await browserJson(page, `/api/page/${parent.id}`);
        return (read.body as { markdown?: string }).markdown;
      })
      .toMatch(
        new RegExp(
          `^Before\\n\\n\\[[^\\]]*Untitled\\]\\(/p/${created.id}\\)$`,
        ),
      );

    await page.goBack();
    await expect(page).toHaveURL(`/p/${parent.id}`);
    const pageRef = page.locator(
      `a.brain-page-ref[data-page-ref="${created.id}"]`,
    );
    await expect(pageRef).toHaveCount(1);
    expect(
      await pageRef.evaluate((element) => {
        const paragraph = element.closest("p");
        const trailingParagraph = paragraph?.nextElementSibling;
        return {
          previous: paragraph?.previousElementSibling?.textContent,
          trailing: trailingParagraph?.textContent,
          trailingIsLast: !trailingParagraph?.nextElementSibling,
        };
      }),
    ).toEqual({ previous: "Before", trailing: "", trailingIsLast: true });

    const treeResponse = await browserJson(page, "/api/tree");
    const tree = treeResponse.body as {
      tree: Array<{ id: string; children: Array<{ id: string }> }>;
    };
    const parentNode = tree.tree.find((node) => node.id === parent.id);
    expect(parentNode?.children.some((child) => child.id === created.id)).toBe(
      true,
    );
  } finally {
    releaseRefSave();
  }
});

test("failed slash page creation unlocks the editor without losing the trigger", async ({
  page,
}) => {
  await login(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Slash failure" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };

  await page.goto(`/p/${parent.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await content.focus();
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();

  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/api/page", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { parentId?: string };
      if (body.parentId === parent.id) {
        await failureGate;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary failure" }),
        });
        return;
      }
    }
    await route.continue();
  });
  const failedResponse = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/page"
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as { parentId?: string };
    return body.parentId === parent.id;
  });

  try {
    await page.keyboard.press("Enter");
    await expect(content).toHaveAttribute("contenteditable", "false");
    await expect(content).toHaveAttribute("aria-busy", "true");
    releaseFailure();
    expect((await failedResponse).status()).toBe(503);

    await expect(content).toHaveAttribute("contenteditable", "true");
    await expect(content).not.toHaveAttribute("aria-busy", "true");
    await expect(page).toHaveURL(`/p/${parent.id}`);
    await expect(content).toContainText("/");
    await content.focus();
    await page.keyboard.type("x");
    await expect(content).toContainText("/x");
  } finally {
    releaseFailure();
  }
});

test("failed slash parent save keeps the inserted link in a local draft", async ({
  page,
}) => {
  await login(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Slash save failure" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };

  await page.goto(`/p/${parent.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await content.focus();
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();

  await page.route(`**/api/page/${parent.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { markdown?: string };
      if (body.markdown?.includes("/p/")) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "forced save failure" }),
        });
        return;
      }
    }
    await route.continue();
  });
  const createdResponse = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/page"
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as { parentId?: string };
    return body.parentId === parent.id;
  });
  const failedSave = page.waitForResponse((response) => {
    if (
      response.request().method() !== "PUT" ||
      new URL(response.url()).pathname !== `/api/page/${parent.id}` ||
      response.status() !== 400
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as { markdown?: string };
    return !!body.markdown?.includes("/p/");
  });

  // This scenario verifies draft recovery, not slash-menu keyboard selection.
  // Click the explicit item so a slow full-suite worker cannot lose the active
  // index between route setup and Enter (keyboard navigation is covered above).
  await page
    .getByTestId("slash-menu")
    .getByRole("button", { name: "New page", exact: true })
    .click();
  const created = (await (await createdResponse).json()) as { id: string };
  await failedSave;

  await expect(page).toHaveURL(`/p/${parent.id}`);
  await expect(content).toHaveAttribute("contenteditable", "true");
  await expect(content).not.toHaveAttribute("aria-busy", "true");
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${created.id}"]`),
  ).toHaveCount(1);
  // The glass shell moved the save indicator from the sidebar/topbar into the
  // page head on the paper, so it now lives inside <main> and renders once.
  await expect(
    page.locator("main").locator(
      '[role="status"][title="Couldn’t save. Your local draft is safe."]',
    ),
  ).toBeVisible();

  const draft = await page.evaluate((id) => {
    const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith(prefix),
    );
    return key ? localStorage.getItem(key) : null;
  }, parent.id);
  expect(draft).toContain(`/p/${created.id}`);
  const serverParent = await browserJson(page, `/api/page/${parent.id}`);
  expect((serverParent.body as { markdown?: string }).markdown).not.toContain(
    `/p/${created.id}`,
  );
});

test("an external edit is never overwritten by a stale local draft", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Conflict note", markdown: "Base body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  await page.goto(`/p/${created.id}`);
  let content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  // Leave and return through the page cache. Hold the background revalidation
  // so typing lands inside Milkdown's 200 ms serialization window.
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page).toHaveURL("/");

  // A first Milkdown serialization can normalize the stored Markdown. Let any
  // such navigation flush finish before simulating an independent writer.
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
        return Object.keys(localStorage).some(
          (key) => key.startsWith(prefix) || key === `brain-draft-${id}`,
        );
      }, created.id),
    )
    .toBe(false);
  const beforeExternal = await browserJson(page, `/api/page/${created.id}`);
  const currentPage = beforeExternal.body as { rev: string };

  const external = await browserJson(page, `/api/page/${created.id}`, {
    method: "PUT",
    body: { markdown: "External MCP body", rev: currentPage.rev },
  });
  expect(external.ok).toBeTruthy();

  let releaseRevalidation!: () => void;
  const revalidationGate = new Promise<void>((resolve) => {
    releaseRevalidation = resolve;
  });
  let markRevalidationSeen!: () => void;
  const revalidationSeen = new Promise<void>((resolve) => {
    markRevalidationSeen = resolve;
  });
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() === "GET") {
      markRevalidationSeen();
      await revalidationGate;
    }
    await route.continue();
  });
  await page.goBack();
  await expect(page).toHaveURL(`/p/${created.id}`);
  await revalidationSeen;
  content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await content.fill("Local draft that must survive");
  releaseRevalidation();

  await expect(page.getByText("Page changed elsewhere")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeVisible();
  const server = await browserJson(page, `/api/page/${created.id}`);
  expect(server.body).toMatchObject({ markdown: "External MCP body" });
  await expect(content).toContainText("Local draft that must survive");
  const storedDraft = await page.evaluate((id) => {
    const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith(prefix),
    );
    const raw = (key && localStorage.getItem(key)) ??
      localStorage.getItem(`brain-draft-${id}`);
    return raw ? (JSON.parse(raw) as { markdown?: string }).markdown : null;
  }, created.id);
  expect(storedDraft?.trimEnd()).toBe("Local draft that must survive");
});

test("a stale parent edit removes only the reference after conflict", async ({
  page,
}) => {
  await login(page);

  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Conflict parent", markdown: "Committed parent body" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };
  const childResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Child that must survive" },
  });
  expect(childResponse.ok).toBeTruthy();
  const child = childResponse.body as { id: string };
  const initialParent = await browserJson(page, `/api/page/${parent.id}`);
  expect(
    (
      await browserJson(page, `/api/page/${parent.id}`, {
        method: "PUT",
        body: {
          markdown: [
            "Committed parent body",
            `[Child that must survive](/p/${child.id})`,
          ].join("\n\n"),
          rev: (initialParent.body as { rev: string }).rev,
        },
      })
    ).ok,
  ).toBe(true);
  const childBeforeConflict = await browserJson(page, `/api/page/${child.id}`);
  expect(childBeforeConflict.ok).toBeTruthy();

  await page.goto(`/p/${parent.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await expect(
    page.locator(`a.brain-page-ref[data-page-ref="${child.id}"]`),
  ).toBeVisible();
  await expect.poll(() => draftBodies(page, parent.id)).toEqual([]);

  const current = await browserJson(page, `/api/page/${parent.id}`);
  const currentParent = current.body as { rev: string };

  // Hold every page refresh after the initial render. Otherwise the SSE reload
  // can win the race and install the remote revision before the local edit,
  // turning this conflict test into an ordinary successful save.
  let releaseParentReads!: () => void;
  const parentReadsGate = new Promise<void>((resolve) => {
    releaseParentReads = resolve;
  });
  let markParentReadSeen!: () => void;
  const parentReadSeen = new Promise<void>((resolve) => {
    markParentReadSeen = resolve;
  });
  let parentReadsReleased = false;
  const releaseParentReadsOnce = () => {
    if (parentReadsReleased) return;
    parentReadsReleased = true;
    releaseParentReads();
  };
  const waitForParentReadSeen = async () => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        parentReadSeen,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(new Error("Timed out waiting for the held parent read")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };
  const parentRoutePattern = `**/api/page/${parent.id}`;
  const parentRouteHandler = async (route: Route) => {
    if (route.request().method() === "GET") {
      markParentReadSeen();
      await parentReadsGate;
    }
    await route.continue();
  };
  await page.route(parentRoutePattern, parentRouteHandler);

  try {
    let conflictResponses = 0;
    page.on("response", (response) => {
      if (
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/page/${parent.id}` &&
        response.status() === 409
      ) {
        conflictResponses += 1;
      }
    });

    const remoteProse = [
      "Remote parent body that must survive",
      "Committed parent body",
    ].join("\n\n");
    const remoteBody =
      `${remoteProse}\n\n` + `[Child that must survive](/p/${child.id})`;
    const remote = await browserJson(page, `/api/page/${parent.id}`, {
      method: "PUT",
      body: { markdown: remoteBody, rev: currentParent.rev },
    });
    expect(remote.ok).toBeTruthy();
    await waitForParentReadSeen();

    let childDeletes = 0;
    page.on("request", (request) => {
      if (
        request.method() === "DELETE" &&
        new URL(request.url()).pathname === `/api/page/${child.id}`
      ) {
        childDeletes += 1;
      }
    });

    const conflictResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/page/${parent.id}` &&
        response.status() === 409,
    );
    await page
      .locator(`a.brain-page-ref[data-page-ref="${child.id}"]`)
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove reference" }).click();
    const removeDialog = page.getByRole("dialog", {
      name: "Remove reference to “Child that must survive”?",
    });
    await removeDialog
      .getByRole("button", { name: "Remove reference", exact: true })
      .click();
    await conflictResponse;
    expect(conflictResponses).toBe(1);
    releaseParentReadsOnce();
    await expect(removeDialog.getByRole("alert")).toHaveText(
      "Page changed elsewhere. Close this dialog, review it, and retry.",
    );
    await expect(removeDialog.getByRole("button", { name: "Retry" })).toBeVisible();

    const unchangedParent = await browserJson(page, `/api/page/${parent.id}`);
    expect(unchangedParent.body).toMatchObject({ markdown: remoteBody });
    await removeDialog.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText(/Reference removed/)).toBeVisible();
    expect(childDeletes).toBe(0);

    const original = await browserJson(page, `/api/page/${parent.id}`);
    expect(original.body).toMatchObject({ markdown: remoteProse });
    const survivingChild = await browserJson(page, `/api/page/${child.id}`);
    expect(survivingChild).toEqual(childBeforeConflict);
    expect(conflictResponses).toBe(1);
    expect(childDeletes).toBe(0);
  } finally {
    releaseParentReadsOnce();
    await page.unroute(parentRoutePattern, parentRouteHandler);
  }
});

test("autosave survives a metadata-only revision change", async ({ page }) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Before metadata", markdown: "Base body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  const putBodies: Array<{
    markdown?: string;
    rev?: string;
    baseMarkdown?: string;
  }> = [];
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      putBodies.push(route.request().postDataJSON());
    }
    await route.continue();
  });

  await page.goto(`/p/${created.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await content.fill("Local body after metadata");
  // Wait until Milkdown has serialized the edit and captured its old body
  // baseline, but stay inside the 700 ms autosave debounce window.
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
        return Object.keys(localStorage).some((key) => key.startsWith(prefix));
      }, created.id),
    )
    .toBe(true);

  const patched = await browserJson(page, `/api/page/${created.id}`, {
    method: "PATCH",
    body: { title: "After metadata", icon: "🧠" },
  });
  expect(patched.ok).toBeTruthy();

  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/page/${created.id}`);
      return read.body as {
        markdown?: string;
        meta?: { title?: string; icon?: string };
      };
    })
    .toMatchObject({
      markdown: "Local body after metadata",
      meta: { title: "After metadata", icon: "🧠" },
    });
  expect(putBodies[0]?.markdown?.trimEnd()).toBe(
    "Local body after metadata",
  );
  expect(putBodies[0]?.baseMarkdown).toBe("Base body");
  await expect(page.getByText("Couldn't save. Your draft is safe.")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
        return Object.keys(localStorage).some((key) => key.startsWith(prefix));
      }, created.id),
    )
    .toBe(false);
});

test("a latched metadata-only conflict resumes on a clean load", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Latched metadata conflict", markdown: "Base body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  const beforeMetadata = await browserJson(page, `/api/page/${created.id}`);
  const stale = beforeMetadata.body as { rev: string };

  const patched = await browserJson(page, `/api/page/${created.id}`, {
    method: "PATCH",
    body: { title: "Latched metadata conflict renamed" },
  });
  expect(patched.ok).toBeTruthy();
  await seedConflictedDraft(
    page,
    created.id,
    "Recovered local edit",
    stale.rev,
    "Base body",
    "latched-metadata:1",
  );

  await page.goto(`/p/${created.id}`);
  await expect(page.getByRole("textbox", { name: "Page content" })).toContainText(
    "Recovered local edit",
  );
  await expect
    .poll(
      async () => {
        const read = await browserJson(page, `/api/page/${created.id}`);
        return read.body as {
          markdown?: string;
          meta?: { title?: string };
        };
      },
      { timeout: 12_000 },
    )
    .toMatchObject({
      markdown: "Recovered local edit",
      meta: { title: "Latched metadata conflict renamed" },
    });
  await expect(page.getByText("Page changed elsewhere")).toHaveCount(0);
  await expect.poll(() => draftBodies(page, created.id)).toEqual([]);
});

test("a schema-v2 draft recovers through its committed historical base", async ({
  page,
}) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Legacy recovery", markdown: "Committed base body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  const beforeMetadata = await browserJson(page, `/api/page/${created.id}`);
  const stale = beforeMetadata.body as { rev: string };
  await waitForCommittedPageHistory(page, created.id);

  const patched = await browserJson(page, `/api/page/${created.id}`, {
    method: "PATCH",
    body: { title: "Legacy recovery renamed", icon: "🧠" },
  });
  expect(patched.ok).toBeTruthy();
  await seedSchemaV2Draft(
    page,
    created.id,
    "Recovered schema-v2 body",
    stale.rev,
    "legacy-v2:metadata-only",
  );

  await page.goto(`/p/${created.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toContainText("Recovered schema-v2 body");
  await expect
    .poll(
      async () => {
        const read = await browserJson(page, `/api/page/${created.id}`);
        return read.body as {
          markdown?: string;
          meta?: { title?: string; icon?: string };
        };
      },
      { timeout: 12_000 },
    )
    .toMatchObject({
      markdown: "Recovered schema-v2 body",
      meta: { title: "Legacy recovery renamed", icon: "🧠" },
    });
  await expect(page.getByText("Couldn't save. Your draft is safe.")).toHaveCount(0);
  await expect.poll(() => draftBodies(page, created.id)).toEqual([]);
});

test("a cross-tab conflict stops PUTs and recovers the exact draft as a sibling", async ({
  page,
}) => {
  await login(page);

  const uploaded = await page.evaluate(async () => {
    const encoded =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([bytes], "recovery-image.png", { type: "image/png" }));
    const response = await fetch("/api/upload", { method: "POST", body: form });
    return { ok: response.ok, body: await response.json() };
  });
  expect(uploaded.ok).toBe(true);
  const attachmentUrl = (uploaded.body as { url: string }).url;
  expect(attachmentUrl).toMatch(/^\/_attachments-v2\/[\w.-]+\.png$/);
  const localDraft =
    `Legacy local draft that must survive\n\n![](${attachmentUrl})\n`;
  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Legacy real conflict", markdown: "Committed base body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  const beforeRemote = await browserJson(page, `/api/page/${created.id}`);
  const stale = beforeRemote.body as { rev: string };
  await waitForCommittedPageHistory(page, created.id);

  const remote = await browserJson(page, `/api/page/${created.id}`, {
    method: "PUT",
    body: { markdown: "Remote body that must survive", rev: stale.rev },
  });
  expect(remote.ok).toBeTruthy();
  await seedSchemaV2Draft(
    page,
    created.id,
    localDraft,
    stale.rev,
    "legacy-v2:real-conflict",
  );

  let originalPuts = 0;
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") originalPuts += 1;
    await route.continue();
  });
  await page.goto(`/p/${created.id}`);
  let content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toContainText("Legacy local draft that must survive");
  await expect(
    page.getByRole("button", { name: "Save a copy" }),
  ).toBeVisible({ timeout: 12_000 });
  await expect.poll(() => originalPuts).toBe(1);

  // The conflict latch survives a reload and every background-save trigger.
  // A stale cross-tab draft must not retry its PUT forever.
  await page.reload();
  content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toContainText("Legacy local draft that must survive");
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pagehide"));
  });
  await page.waitForTimeout(1_000);
  expect(originalPuts).toBe(1);

  const beforeRecovery = await draftBodies(page, created.id);
  expect(beforeRecovery).toContain(localDraft);

  // A failed recovery POST leaves every draft byte intact and keeps the action
  // available for a retry.
  await page.route("**/api/page", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Save a copy" }).click();
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeEnabled();
  expect(await draftBodies(page, created.id)).toEqual(beforeRecovery);
  const current = await browserJson(page, `/api/page/${created.id}`);
  expect(current.body).toMatchObject({
    markdown: "Remote body that must survive",
  });

  await page.unroute("**/api/page");
  let recoveryRequest: { markdown?: string; parentId?: string | null; title?: string } | null =
    null;
  await page.route("**/api/page", async (route) => {
    if (route.request().method() === "POST") {
      recoveryRequest = route.request().postDataJSON() as {
        markdown?: string;
        parentId?: string | null;
        title?: string;
      };
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Save a copy" }).click();
  await expect
    .poll(() => new URL(page.url()).pathname.split("/").at(-1))
    .not.toBe(created.id);
  const recoveredId = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(recoveryRequest).toMatchObject({
    markdown: localDraft,
    parentId: null,
    title: "Legacy real conflict (recovered)",
  });

  const original = await browserJson(page, `/api/page/${created.id}`);
  expect(original.body).toMatchObject({ markdown: "Remote body that must survive" });
  const recovered = await browserJson(page, `/api/page/${recoveredId}`);
  expect(recovered.body).toMatchObject({
    markdown: localDraft.trimEnd(),
    meta: { title: "Legacy real conflict (recovered)" },
  });
  const attachment = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      status: response.status,
      prefix: [...new Uint8Array(await response.arrayBuffer()).subarray(0, 8)],
    };
  }, attachmentUrl);
  expect(attachment.status).toBe(200);
  expect(attachment.prefix).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await expect.poll(() => draftBodies(page, created.id)).toEqual([]);
  expect(originalPuts).toBe(1);
});

test("conflict recovery clears adopted drafts after edit and repeated reloads", async ({
  page,
}) => {
  await login(page);
  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Reloaded conflict lineage", markdown: "Committed base" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  const beforeRemote = await browserJson(page, `/api/page/${created.id}`);
  const stale = beforeRemote.body as { rev: string };
  await waitForCommittedPageHistory(page, created.id);
  const remote = await browserJson(page, `/api/page/${created.id}`, {
    method: "PUT",
    body: { markdown: "Remote durable body", rev: stale.rev },
  });
  expect(remote.ok).toBeTruthy();
  await seedSchemaV2Draft(
    page,
    created.id,
    "Adopted local A",
    stale.rev,
    "legacy-v2:lineage-a",
  );

  let originalPuts = 0;
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") originalPuts += 1;
    await route.continue();
  });
  await page.goto(`/p/${created.id}`);
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeVisible({
    timeout: 12_000,
  });
  await expect.poll(() => originalPuts).toBe(1);

  await page.reload();
  const content = page.getByRole("textbox", { name: "Page content" });
  const newestLocal = "Newer local B after the first conflict reload";
  await content.fill(newestLocal);
  await expect
    .poll(async () =>
      (await draftBodies(page, created.id)).some(
        (body) => body.trimEnd() === newestLocal,
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page content" })).toContainText(
    newestLocal,
  );
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeVisible();
  expect(originalPuts).toBe(1);

  await page.getByRole("button", { name: "Save a copy" }).click();
  await expect
    .poll(() => new URL(page.url()).pathname.split("/").at(-1))
    .not.toBe(created.id);
  await expect.poll(() => draftBodies(page, created.id)).toEqual([]);
  const original = await browserJson(page, `/api/page/${created.id}`);
  expect(original.body).toMatchObject({ markdown: "Remote durable body" });
  const recoveredId = new URL(page.url()).pathname.split("/").at(-1)!;
  const recovered = await browserJson(page, `/api/page/${recoveredId}`);
  expect(recovered.body).toMatchObject({ markdown: newestLocal });
});

test("recovery falls back to a visible root copy when its parent was trashed", async ({
  page,
}) => {
  await login(page);
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Recovery parent" },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };
  const sourceResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      parentId: parent.id,
      title: "Recovery child",
      markdown: "Committed child base",
    },
  });
  expect(sourceResponse.ok).toBeTruthy();
  const source = sourceResponse.body as { id: string };
  const beforeRemote = await browserJson(page, `/api/page/${source.id}`);
  const stale = beforeRemote.body as { rev: string };
  await waitForCommittedPageHistory(page, source.id);
  const remote = await browserJson(page, `/api/page/${source.id}`, {
    method: "PUT",
    body: { markdown: "Remote child body", rev: stale.rev },
  });
  expect(remote.ok).toBeTruthy();
  const localDraft = "Local child draft";
  await seedSchemaV2Draft(
    page,
    source.id,
    localDraft,
    stale.rev,
    "legacy-v2:deleted-parent",
  );

  await page.goto(`/p/${source.id}`);
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeVisible({
    timeout: 12_000,
  });
  const staleTree = await browserJson(page, "/api/tree");
  await page.route("**/api/tree", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(staleTree.body),
    });
  });

  const deleted = await browserJson(page, `/api/page/${parent.id}`, {
    method: "DELETE",
  });
  expect(deleted.ok).toBeTruthy();
  const recoveryParents: Array<string | null> = [];
  await page.route("**/api/page", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { parentId?: string | null };
      recoveryParents.push(body.parentId ?? null);
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "Save a copy" }).click();
  await expect
    .poll(() => new URL(page.url()).pathname.split("/").at(-1))
    .not.toBe(source.id);
  expect(recoveryParents).toEqual([parent.id, null]);
  const recoveredId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.unroute("**/api/tree");
  const recovered = await browserJson(page, `/api/page/${recoveredId}`);
  expect(recovered.body).toMatchObject({
    markdown: localDraft,
    meta: { title: "Recovery child (recovered)" },
  });
  const tree = await browserJson(page, "/api/tree");
  const roots = (tree.body as { tree: Array<{ id: string }> }).tree;
  expect(roots.map((node) => node.id)).toContain(recoveredId);
});

test("storage failure keeps the exact draft in memory and never claims recovery is safe", async ({
  page,
}) => {
  await login(page);
  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Memory-only recovery", markdown: "Server base" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.goto(`/p/${created.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("brain-draft")) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });

  let responseMode: "error" | "conflict" = "error";
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      if (responseMode === "error") {
        await route.fulfill({ status: 400, contentType: "application/json", body: "{}" });
      } else {
        await route.fulfill({ status: 409, contentType: "application/json", body: "{}" });
      }
      return;
    }
    if (route.request().method() === "GET" && responseMode === "conflict") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ markdown: "Remote body", rev: "abcdef123456" }),
      });
      return;
    }
    await route.continue();
  });

  await content.fill("Memory-only draft after ordinary save failure");
  const recoveryUnavailable = page.getByText(
    "Keep this tab open — local recovery is unavailable",
  );
  await expect(recoveryUnavailable).toHaveCount(1);
  await expect(recoveryUnavailable).toBeVisible();
  await expect(page.getByText(/draft is safe/i)).toHaveCount(0);
  await expect.poll(() => draftBodies(page, created.id)).toEqual([]);
  await expect(content).toContainText("Memory-only draft after ordinary save failure");

  responseMode = "conflict";
  const exactConflictDraft = "Exact in-memory conflict draft";
  await content.fill(exactConflictDraft);
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeVisible();
  await expect(recoveryUnavailable).toHaveCount(1);
  await expect(recoveryUnavailable).toBeVisible();
  await expect(page.getByText(/draft is safe/i)).toHaveCount(0);
  await expect(content).toContainText(exactConflictDraft);
  await expect.poll(() => draftBodies(page, created.id)).toEqual([]);

  await page.getByRole("button", { name: "Save a copy" }).click();
  await expect
    .poll(() => new URL(page.url()).pathname.split("/").at(-1))
    .not.toBe(created.id);
  const recoveredId = new URL(page.url()).pathname.split("/").at(-1)!;
  const recovered = await browserJson(page, `/api/page/${recoveredId}`);
  expect(recovered.body).toMatchObject({ markdown: exactConflictDraft });
});

test("sidebar structure stays frozen around a conflicted source and its parents", async ({
  page,
}) => {
  await login(page);
  const sourceResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Guarded source", markdown: "Source base" },
  });
  expect(sourceResponse.ok).toBeTruthy();
  const source = sourceResponse.body as { id: string };
  const childResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: source.id, title: "Guarded child" },
  });
  expect(childResponse.ok).toBeTruthy();
  const child = childResponse.body as { id: string };
  const freeResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Free page" },
  });
  expect(freeResponse.ok).toBeTruthy();
  const free = freeResponse.body as { id: string };

  await page.goto(`/p/${source.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await page.route(`**/api/page/${source.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 409, contentType: "application/json", body: "{}" });
      return;
    }
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ markdown: "Remote source", rev: "abcdef123456" }),
      });
      return;
    }
    await route.continue();
  });
  await content.fill("Local conflicted source");
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeVisible();

  const sourceRow = page
    .locator("nav")
    .getByText("Guarded source", { exact: true })
    .locator("..");
  const expand = sourceRow.getByRole("button", { name: "Expand" });
  if (await expand.isVisible()) await expand.click();
  const childRow = page
    .locator("nav")
    .getByText("Guarded child", { exact: true })
    .locator("..");
  await expect(childRow).toBeVisible();

  const requests = { move: 0, delete: 0, duplicate: 0 };
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/move") requests.move += 1;
    if (request.method() === "DELETE" && pathname === `/api/page/${child.id}`) {
      requests.delete += 1;
    }
    if (
      request.method() === "POST" &&
      pathname === `/api/page/${child.id}/duplicate`
    ) {
      requests.duplicate += 1;
    }
  });
  const openChildMenu = async () => {
    await childRow.getByRole("button", { name: "More actions" }).click();
  };

  await openChildMenu();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await openChildMenu();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await openChildMenu();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await expect(page.getByText("Save a copy first.", { exact: true })).toBeVisible();
  expect(requests).toEqual({ move: 0, delete: 0, duplicate: 0 });

  await page.locator("nav").getByText("Free page", { exact: true }).click();
  await expect(page).toHaveURL(`/p/${free.id}`);
  const freeRow = page
    .locator("nav")
    .getByText("Free page", { exact: true })
    .locator("..");
  await freeRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByLabel("Search destinations").fill("Guarded source");
  await page.getByRole("option", { name: /Guarded source$/ }).click();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Move page" })
      .getByText("Save a copy first.", { exact: true }),
  ).toBeVisible();
  expect(requests.move).toBe(0);
});

test("a stale SSE reload cannot replace a confirmed save", async ({ page }) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "SSE race", markdown: "Old body" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  await page.goto(`/p/${created.id}`);
  let content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();

  let releaseStaleGet!: () => void;
  const staleGetGate = new Promise<void>((resolve) => {
    releaseStaleGet = resolve;
  });
  let markStaleGetCaptured!: () => void;
  const staleGetCaptured = new Promise<void>((resolve) => {
    markStaleGetCaptured = resolve;
  });
  let interceptNextClientGet = true;
  await page.route(`**/api/page/${created.id}`, async (route) => {
    const request = route.request();
    if (
      interceptNextClientGet &&
      request.method() === "GET" &&
      request.headers()["x-brain-client"]
    ) {
      interceptNextClientGet = false;
      const staleResponse = await route.fetch();
      markStaleGetCaptured();
      await staleGetGate;
      await route.fulfill({ response: staleResponse });
      return;
    }
    await route.continue();
  });

  // This external metadata event starts reloadCurrent. Its response is fetched
  // now, then deliberately delivered only after the newer body PUT succeeds.
  const patched = await browserJson(page, `/api/page/${created.id}`, {
    method: "PATCH",
    body: { title: "SSE race renamed" },
  });
  expect(patched.ok).toBeTruthy();
  await staleGetCaptured;

  await content.fill("Confirmed newer body");
  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/page/${created.id}`);
      return (read.body as { markdown?: string }).markdown;
    })
    .toBe("Confirmed newer body");

  releaseStaleGet();
  await page.waitForTimeout(250);
  await expect(content).toContainText("Confirmed newer body");

  // The stale response must not poison the navigation cache either.
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page).toHaveURL("/");
  await page.goBack();
  await expect(page).toHaveURL(`/p/${created.id}`);
  content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toContainText("Confirmed newer body");
});

test("a late 409 latches the newest draft for its own page only", async ({
  page,
}) => {
  await login(page);
  const suffix = Date.now().toString(36);
  const xResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: `Late conflict X ${suffix}`, markdown: "Base X" },
  });
  const yResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: `Independent Y ${suffix}`, markdown: "Base Y" },
  });
  expect(xResponse.ok).toBeTruthy();
  expect(yResponse.ok).toBeTruthy();
  const x = xResponse.body as { id: string };
  const y = yResponse.body as { id: string };
  const xBefore = await browserJson(page, `/api/page/${x.id}`);
  const staleX = xBefore.body as { rev: string };

  let releaseFirstPut!: () => void;
  const firstPutGate = new Promise<void>((resolve) => {
    releaseFirstPut = resolve;
  });
  let markFirstPutSeen!: () => void;
  const firstPutSeen = new Promise<void>((resolve) => {
    markFirstPutSeen = resolve;
  });
  let originalPuts = 0;
  await page.route(`**/api/page/${x.id}`, async (route) => {
    if (
      route.request().method() === "PUT" &&
      route.request().headers()["x-e2e-remote"] !== "1"
    ) {
      originalPuts += 1;
      if (originalPuts === 1) {
        markFirstPutSeen();
        await firstPutGate;
      }
    }
    await route.continue();
  });

  await page.goto(`/p/${x.id}`);
  let content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await content.fill("Older X operation in flight");
  await firstPutSeen;

  const newestX = "Newest X draft must survive byte for byte";
  await content.fill(newestX);
  let newestXStored = "";
  await expect
    .poll(async () => {
      const stored = (await draftBodies(page, x.id)).find(
        (body) => body.trimEnd() === newestX,
      );
      if (stored !== undefined) newestXStored = stored;
      return stored !== undefined;
    })
    .toBe(true);
  await page.getByText(`Independent Y ${suffix}`, { exact: true }).click();
  await expect(page).toHaveURL(`/p/${y.id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    `Independent Y ${suffix}`,
  );
  content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toContainText("Base Y");
  const newestY = "Independent Y draft";
  await content.fill(newestY);
  await expect
    .poll(async () =>
      (await draftBodies(page, y.id)).some(
        (body) => body.trimEnd() === newestY,
      ),
    )
    .toBe(true);

  // A test-only marker lets this authenticated second writer pass the route
  // while the browser's ordinary stale PUT remains deliberately held.
  const remote = await page.evaluate(
    async ({ id, rev }) => {
      const response = await fetch(`/api/page/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-e2e-remote": "1",
        },
        body: JSON.stringify({ markdown: "Remote X body", rev }),
      });
      return { ok: response.ok, status: response.status };
    },
    { id: x.id, rev: staleX.rev },
  );
  expect(remote).toEqual({ ok: true, status: 200 });
  releaseFirstPut();

  await expect
    .poll(async () => {
      const entries = await page.evaluate((id) => {
        const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
        return Object.keys(localStorage)
          .filter((key) => key.startsWith(prefix))
          .map((key) => JSON.parse(localStorage.getItem(key) ?? "{}")) as Array<{
          markdown?: string;
          conflicted?: boolean;
        }>;
      }, x.id);
      return entries.find((entry) => entry.markdown === newestXStored) ?? null;
    })
    .toMatchObject({ markdown: newestXStored, conflicted: true });
  expect(originalPuts).toBe(1);

  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/page/${y.id}`);
      return (read.body as { markdown?: string }).markdown?.trimEnd();
    })
    .toBe(newestY);
  await page.getByText(`Late conflict X ${suffix}`, { exact: true }).click();
  await expect(page).toHaveURL(`/p/${x.id}`);
  await expect(page.getByRole("textbox", { name: "Page content" })).toContainText(
    newestX,
  );
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeVisible();
  expect(originalPuts).toBe(1);
  const original = await browserJson(page, `/api/page/${x.id}`);
  expect(original.body).toMatchObject({ markdown: "Remote X body" });
});

test("an older A save cannot consume a newer A-B-A draft", async ({ page }) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "ABA note", markdown: "Base" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstSeen!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    markFirstSeen = resolve;
  });
  const putBodies: string[] = [];
  await page.route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as { markdown: string };
    putBodies.push(body.markdown.trim());
    if (putBodies.length === 1) {
      markFirstSeen();
      await firstGate;
    }
    await route.continue();
  });

  await page.goto(`/p/${created.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await content.fill("A");
  await firstSeen;
  await content.fill("B");
  await page.waitForTimeout(800);
  await content.fill("A");
  // Keep A1 blocked until A2's debounce fires. The old markdown-based dedupe
  // incorrectly attached A2 to A1 here and never sent the third write.
  await page.waitForTimeout(800);
  releaseFirst();

  await expect.poll(() => putBodies).toEqual(["A", "B", "A"]);
  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/page/${created.id}`);
      return (read.body as { markdown?: string }).markdown;
    })
    .toBe("A");
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
        const scoped = Object.keys(localStorage).find((candidate) =>
          candidate.startsWith(prefix),
        );
        return scoped
          ? localStorage.getItem(scoped)
          : localStorage.getItem(`brain-draft-${id}`);
      }, created.id),
    )
    .toBeNull();
});

test("two tabs preserve independent drafts for the same page", async ({ page }) => {
  await login(page);

  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Two-tab note", markdown: "Base" },
  });
  expect(createdResponse.ok).toBeTruthy();
  const created = createdResponse.body as { id: string };
  await page.context().route(`**/api/page/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  const other = await page.context().newPage();
  try {
    // The behavior under test is isolated per-tab draft storage, not whether
    // the development compiler can hydrate two cold editors simultaneously.
    // Wait for each editor independently so a slow CI worker cannot turn the
    // setup into a race before either draft exists.
    await page.goto(`/p/${created.id}`);
    const pageA = page.getByRole("textbox", { name: "Page content" });
    await expect(pageA).toBeVisible({ timeout: 12_000 });

    await other.goto(`/p/${created.id}`);
    const pageB = other.getByRole("textbox", { name: "Page content" });
    await expect(pageB).toBeVisible({ timeout: 12_000 });

    await pageA.fill("draft from tab A");
    await pageB.fill("draft from tab B");

    await expect
      .poll(() =>
        page.evaluate((id) => {
          const prefix = `brain-draft-v2:${encodeURIComponent(id)}:`;
          return Object.keys(localStorage)
            .filter((key) => key.startsWith(prefix))
            .map((key) => JSON.parse(localStorage.getItem(key) ?? "{}"))
            .map((draft: { markdown?: string }) => draft.markdown?.trimEnd())
            .sort();
        }, created.id),
      )
      .toEqual(["draft from tab A", "draft from tab B"]);
  } finally {
    await other.close();
  }
});
