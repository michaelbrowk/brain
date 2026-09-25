// Apps in a real browser. The things only Chromium can answer.
//
// This file exists because of a bug no unit test in the branch could see. Next
// accumulates every header rule whose source matches a path and lets nothing
// downstream remove a key one of them set, so the global block's
// `X-Frame-Options: DENY` and `frame-ancestors 'none'` were on every
// `/api/app/*` response and the route's own per-request policy was dropped
// beside them. The canvas mounted a frame the browser then refused, silently:
// a CSP violation inside an opaque-origin frame is reported to nobody, and the
// HEAD preflight answered 200 so the missing-files state did not catch it
// either. Every assertion in the branch was green while the feature was
// completely broken on a real server.
//
// Four more things are here for the same reason, that nothing short of a
// browser answers them:
//
// The sandbox. An opaque origin, no cookies, and a fetch of Brain's own API
// that comes back with nothing. jsdom has no origin model and would pass
// whatever we wrote.
//
// The bridge. postMessage between two real windows, with the host's
// `event.source` check doing the work it exists for, and the kit's own
// `window.brain` executing for the first time anywhere.
//
// An asset painting. A CSP violation inside an opaque-origin frame is reported
// to nobody, so a policy that allows nothing looks exactly like an app that
// draws nothing. The only way to know the frame can load its own files is to
// load one and measure it. `naturalWidth`, not a screenshot: a blocked image
// is still laid out and a visual diff would pass on the alt box.
//
// And the round trip: an app opened, answered, and the page it wrote read back,
// which is the sentence the whole feature makes.
//
// WHY THE APP PAGES ARE SEEDED THROUGH THE PORTABLE IMPORT AND NOT THROUGH
// `create_app_page`. The plan asks for the MCP round trip here. It cannot run:
// `/api/mcp` evaluates `oauthIssuer()` at module load and throws for any
// `BRAIN_PUBLIC_ORIGIN` that is not an exact https origin, and this harness
// serves `http://127.0.0.1:<port>`, which is also what the share links and the
// frame's own policy are built from. `.env.example` states that rule as
// product behaviour ("MCP ... wait for a real https:// origin"), so the
// endpoint is off here by design rather than broken. The three tools are
// covered at the unit level in `app/api/mcp/app-tools.test.ts`; the portable
// import is the other surface that reaches `writeAppFiles` and `setAppMeta`,
// and what these cases are about is everything downstream of whichever wrote
// the files.
//
// EVERY TEST IN THIS FILE IS `@release`, for the reason `e2e/tasks.spec.ts`
// states at its head: `ci.yml` and `release.yml` both run `--grep @release`,
// so an untagged test here would run in the weekly full job and nowhere else,
// and the sandbox is not a guarantee to check weekly.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "playwright/test";

import { createPortableArchive } from "../lib/portable/archive";
import { freshNotes } from "./fresh-notes";

freshNotes();

const PORT = process.env.BRAIN_E2E_PORT ?? "3021";
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** The shipped trainer, read off disk. Nothing about it is written for this
 *  test: a case that drilled a fixture would prove the fixture. */
const TRAINER = readFileSync(
  path.join(process.cwd(), "examples", "apps", "spanish-trainer", "index.html"),
  "utf8",
);

/** An entry that says three things out loud: that the document rendered, that
 *  its inline script ran under `script-src 'unsafe-inline'`, and that the host
 *  answered it over the bridge. It keeps asking until it is answered, because
 *  the frame can finish loading before the host has attached its listener, and
 *  five asks a second sits well under the thirty the limiter allows.
 *
 *  And it asks for its own asset with a RELATIVE url, which is the whole
 *  reason the grant is in the path. A blocked subresource inside an
 *  opaque-origin frame reports nothing anywhere, so the image says out loud
 *  whether it painted and how wide it came out. */
const PROBE = `<!doctype html>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Frame probe</title>
<body style="font: 14px system-ui">
<p id="loaded">the frame document rendered</p>
<p id="said">no answer yet</p>
<img id="dot" src="assets/dot.png" alt="">
<p id="asset">the asset has not settled</p>
<script>
  var dot = document.getElementById("dot");
  var asset = document.getElementById("asset");
  dot.addEventListener("load", function () {
    asset.textContent = "the asset painted, " + dot.naturalWidth + " wide";
  });
  dot.addEventListener("error", function () {
    asset.textContent = "the asset was refused";
  });
  if (dot.complete && dot.naturalWidth > 0) {
    asset.textContent = "the asset painted, " + dot.naturalWidth + " wide";
  }
  var asking = setInterval(ask, 200);
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.rid !== "probe-1") return;
    clearInterval(asking);
    document.getElementById("said").textContent = data.ok
      ? "the host answered hello, theme " + data.data.theme
      : "the host refused: " + data.reason;
  });
  function ask() {
    parent.postMessage({ v: 1, rid: "probe-1", type: "hello" }, "*");
  }
  ask();
</script>
</body>
`;

/** What an app can reach of the notebook it is drawn in, which is nothing at
 *  all except through the bridge. Every answer is written into one element so
 *  the case reads them together rather than four at a time. */
const ESCAPE = `<!doctype html>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Escape attempt</title>
<body>
<p id="report">running</p>
<script>
  var found = {};
  function done() {
    document.getElementById("report").textContent = JSON.stringify(found);
  }
  try {
    found.cookie = document.cookie === "" ? "empty" : "readable";
  } catch (error) {
    found.cookie = "threw";
  }
  try {
    found.top = String(top.location.href);
  } catch (error) {
    found.top = "threw";
  }
  try {
    found.parentName = String(parent.name);
  } catch (error) {
    found.parentName = "threw";
  }
  fetch("/api/tree").then(
    function () { found.api = "answered"; done(); },
    function () { found.api = "refused"; done(); }
  );
</script>
</body>
`;

/** One opaque pixel, so the asset cases measure a real decode rather than an
 *  element that happens to exist. `naturalWidth` is 1 only if the bytes
 *  arrived and the browser read them as a PNG. Base64 rather than a fixture
 *  file, so the case carries the bytes it depends on. */
const DOT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The three shapes a vocabulary page comes in, on one page, so the trainer
 *  is reading what `vocabulary.test.ts` says it reads. The translations are
 *  Russian because the reader's bargain is Spanish on the left and a
 *  non-Latin script on the right, which is what tells a pair from a
 *  conjugation. `examples/apps/spanish-trainer/README.md` has the rule. */
const WEEK_ONE = [
  "# Week one",
  "",
  "| Spanish | Русский |",
  "| --- | --- |",
  "| hola | привет |",
  "| adios | пока |",
  "",
  "- gracias — спасибо",
  "",
  "buenos - добрый",
  "",
].join("\n");

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

/** The response headers a same-origin request receives, read in the page so
 *  the owner's session rides with it. `page.request.get()` does not carry it
 *  and answers 401. Header names come back lowercased, as `Headers` gives
 *  them. */
async function headersOf(page: Page, requestPath: string) {
  return page.evaluate(async (path: string) => {
    const response = await fetch(path);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers };
  }, requestPath);
}

async function browserJson(
  page: Page,
  requestPath: string,
  init: { method?: string; body?: unknown } = {},
) {
  return page.evaluate(
    async ({ path, requestInit }) => {
      const response = await fetch(path, {
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
    { path: requestPath, requestInit: init },
  );
}

interface SeedPage {
  sourceId: string;
  parentSourceId: string | null;
  title: string;
  markdown: string;
  app?: {
    entryHtml: string;
    /** Source ids of the pages this app may write. The import remaps them
     *  onto the ids it mints, exactly as an export from another notebook
     *  would be remapped. */
    owns?: string[];
    assets?: { name: string; base64: string }[];
  };
}

/** Pages written by the store's own writers, app files included. The archive
 *  is built here rather than exported from a notebook so the test states the
 *  shape it depends on instead of inheriting one. */
async function seed(page: Page, title: string, pages: SeedPage[]): Promise<void> {
  const encoder = new TextEncoder();
  const files: { path: string; data: Uint8Array }[] = [];
  const manifestPages = pages.map((source, index) => {
    const slug = `p${String(index).padStart(6, "0")}`;
    files.push({ path: `pages/${slug}.md`, data: encoder.encode(source.markdown) });
    if (!source.app) {
      return {
        sourceId: source.sourceId,
        parentSourceId: source.parentSourceId,
        markdownPath: `pages/${slug}.md`,
        meta: { title: source.title },
      };
    }
    files.push({
      path: `app/${slug}/index.html`,
      data: encoder.encode(source.app.entryHtml),
    });
    const assets = (source.app.assets ?? []).map((asset) => {
      files.push({
        path: `app/${slug}/assets/${asset.name}`,
        data: Uint8Array.from(Buffer.from(asset.base64, "base64")),
      });
      return { name: asset.name, archivePath: `app/${slug}/assets/${asset.name}` };
    });
    return {
      sourceId: source.sourceId,
      parentSourceId: source.parentSourceId,
      markdownPath: `pages/${slug}.md`,
      meta: { title: source.title },
      app: {
        meta: {
          entry: "app/index.html",
          version: 1,
          builtBy: "Claude",
          builtAt: "2026-09-22T10:00:00.000Z",
          owns: source.app.owns ?? [],
          state: false,
          reason: "build me a trainer for my Spanish words",
        },
        entryPath: `app/${slug}/index.html`,
        assets,
      },
    };
  });

  const manifest = {
    format: "brain-portable",
    version: 3,
    exportedAt: "2026-09-22T10:00:00.000Z",
    scope: "subtree",
    title,
    pages: manifestPages,
    attachments: [],
  };
  const archive = createPortableArchive([
    { path: "manifest.json", data: encoder.encode(JSON.stringify(manifest)) },
    ...files,
  ]);

  const imported = await page.evaluate(async (base64: string) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const form = new FormData();
    form.append("file", new File([bytes], "app.tar.gz", { type: "application/gzip" }));
    form.append("mode", "apply");
    const response = await fetch("/api/portable/import", { method: "POST", body: form });
    return { status: response.status, body: await response.text() };
  }, Buffer.from(archive).toString("base64"));

  expect(imported.status, imported.body).toBe(200);
}

interface FlatNode {
  id: string;
  parentId: string | null;
  title: string;
}

/** The whole notebook as a flat list. Every case here runs against the same
 *  notes folder, so a fixture is found by a title carrying this run's own tag
 *  and by its place in the tree, never by a bare title that an earlier case
 *  also used. */
async function flatTree(page: Page): Promise<FlatNode[]> {
  const answered = await browserJson(page, "/api/tree");
  expect(answered.ok, JSON.stringify(answered.body)).toBeTruthy();
  const out: FlatNode[] = [];
  const walk = (nodes: FlatNode[] & { children?: unknown }[]) => {
    for (const node of nodes) {
      out.push({ id: node.id, parentId: node.parentId, title: node.title });
      walk(((node as { children?: unknown[] }).children ?? []) as never);
    }
  };
  walk(((answered.body as { tree?: unknown[] }).tree ?? []) as never);
  return out;
}

async function idOf(page: Page, title: string): Promise<string> {
  const nodes = await flatTree(page);
  const found = nodes.find((node) => node.title === title);
  expect(found, `no page titled ${title}`).toBeTruthy();
  return found!.id;
}

/** A tag per case, so two cases seeding the same fixture into one notes
 *  folder cannot find each other's pages. */
function tag(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** The markdown the owner's own API reports for a page. */
async function markdownOf(page: Page, id: string): Promise<string> {
  const read = await browserJson(page, `/api/page/${id}`);
  return (read.body as { markdown?: string }).markdown ?? "";
}

/** Every row title in the notification centre, which is what the bell draws. */
async function bellTitles(page: Page): Promise<string[]> {
  const centre = await browserJson(page, "/api/notifications");
  const rows = (centre.body as { notifications?: { title?: string }[] }).notifications;
  return (rows ?? []).map((row) => row.title ?? "");
}

/** One row of the trainer's `Words` table, as the owner reads it. */
function wordRow(markdown: string, word: string): string[] | null {
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length === 5 && cells[0] === word) return cells;
  }
  return null;
}

interface Trainer {
  title: string;
  deck: string;
  trainer: string;
  words: string;
  /** A second app in the same subtree, carrying one image. A visitor's token
   *  has to reach an app's files as well as its entry, and the trainer has no
   *  picture of its own to prove it with. */
  probeTitle: string;
  probe: string;
}

/** The notebook seeded for the trainer: a deck, a page of words in all three
 *  shapes, the trainer itself, and the `Words` page it owns. The trainer looks
 *  for a child of its own titled exactly `Words`, so that one title is not
 *  tagged and the page is found by its parent instead. */
async function seedTrainer(page: Page): Promise<Trainer> {
  const run = tag();
  const title = `Trainer ${run}`;
  const probeTitle = `Frame probe ${run}`;
  await seed(page, `Spanish ${run}`, [
    {
      sourceId: "deck",
      parentSourceId: null,
      title: `Spanish ${run}`,
      markdown: "Words I am learning.\n",
    },
    { sourceId: "week", parentSourceId: "deck", title: `Week one ${run}`, markdown: WEEK_ONE },
    {
      sourceId: "trainer",
      parentSourceId: "deck",
      title,
      markdown: "Drills the words on the pages beside it.\n",
      app: { entryHtml: TRAINER, owns: ["words"] },
    },
    { sourceId: "words", parentSourceId: "trainer", title: "Words", markdown: "" },
    {
      sourceId: "probe",
      parentSourceId: "deck",
      title: probeTitle,
      // No separator on this line, so the trainer reads no word out of it and
      // the deck stays the four the source page names.
      markdown: "An app with a picture in it.\n",
      app: { entryHtml: PROBE, assets: [{ name: "dot.png", base64: DOT_PNG_BASE64 }] },
    },
  ]);

  const nodes = await flatTree(page);
  const trainer = nodes.find((node) => node.title === title);
  expect(trainer, `no page titled ${title}`).toBeTruthy();
  const words = nodes.find(
    (node) => node.parentId === trainer!.id && node.title === "Words",
  );
  expect(words, "the trainer has no Words page under it").toBeTruthy();
  const probe = nodes.find((node) => node.title === probeTitle);
  expect(probe, `no page titled ${probeTitle}`).toBeTruthy();
  return {
    title,
    deck: trainer!.parentId!,
    trainer: trainer!.id,
    words: words!.id,
    probeTitle,
    probe: probe!.id,
  };
}

test("@release an app page's frame loads under its own policy and answers hello", async ({
  page,
}) => {
  await login(page);
  const title = `Frame probe ${tag()}`;
  await seed(page, title, [
    {
      sourceId: "probe",
      parentSourceId: null,
      title,
      markdown: "The release case for an app page's frame.\n",
      app: { entryHtml: PROBE, assets: [{ name: "dot.png", base64: DOT_PNG_BASE64 }] },
    },
  ]);
  const id = await idOf(page, title);

  await page.goto(`/p/${id}`);

  // The head the canvas draws, which is the shell's half of the page.
  await expect(page.getByText("Built by Claude")).toBeVisible({ timeout: 20_000 });

  // And the app's half. Reaching this text at all means the response was not
  // refused by X-Frame-Options, its document rendered inside a frame with no
  // `allow-same-origin`, and its inline script ran under the route's policy.
  const frame = page.frameLocator(`iframe[title="${title}"]`);
  await expect(frame.locator("#loaded")).toHaveText(
    "the frame document rendered",
    { timeout: 20_000 },
  );
  await expect(frame.locator("#said")).toHaveText(
    /^the host answered hello, theme (light|dark)$/,
    { timeout: 20_000 },
  );

  // THE CASE THAT CATCHES A FRAME THAT CANNOT REACH ITS OWN FILES.
  //
  // The image is asked for with a relative url, so the browser resolves it
  // against the entry's path and the grant in that path rides along. Under the
  // old shape the same request arrived with no session (the frame's origin is
  // opaque, so nothing cross-site carries a cookie) and no query (a relative
  // url drops it), was answered 404, and Chrome reported it as
  // ERR_BLOCKED_BY_ORB with no CSP violation, no securitypolicyviolation event
  // and no console line anywhere. The picture simply never appeared.
  await expect(frame.locator("#asset")).toHaveText("the asset painted, 1 wide", {
    timeout: 20_000,
  });
  expect(
    await frame.locator("#dot").evaluate((img) => (img as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);

  // The address the frame is actually mounted at, and the headers the browser
  // received for it. Read from inside the page so the request carries the
  // owner's session the way the mint call did.
  const src = await page.locator(`iframe[title="${title}"]`).getAttribute("src");
  expect(src).toMatch(new RegExp(`^/api/app/${id}/t/[^/]+/index\\.html$`));

  const entry = await headersOf(page, src!);
  expect(entry.status).toBe(200);
  expect(entry.headers["x-frame-options"]).toBeUndefined();
  expect(entry.headers["content-security-policy"]).toContain(
    `frame-ancestors ${ORIGIN}`,
  );
  expect(entry.headers["content-security-policy"]).toContain("connect-src 'none'");
  expect(entry.headers["content-security-policy"]).not.toContain(
    "frame-ancestors 'none'",
  );
  // The host-source has to be a prefix of the asset's own address, or the
  // browser refuses it before the route is reached.
  expect(entry.headers["content-security-policy"]).toContain(
    `${ORIGIN}/api/app/${id}/t/`,
  );
  expect(entry.headers["cache-control"]).toBe("private, no-store");
  expect(entry.headers["x-content-type-options"]).toBe("nosniff");

  // And the same address with the token segment taken out is nothing at all.
  const untokened = await headersOf(page, `/api/app/${id}/index.html`);
  expect(untokened.status).toBe(404);

  // Narrowing the catch-all took nothing away from every other path.
  const shell = await headersOf(page, `/p/${id}`);
  expect(shell.headers["x-frame-options"]).toBe("DENY");
  expect(shell.headers["content-security-policy"]).toContain("frame-src 'self'");
  expect(shell.headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
});

test("@release the owner answers three cards and the trainer's Words page says so", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const seeded = await seedTrainer(page);

  await page.goto(`/p/${seeded.trainer}`);
  await expect(page.getByText("Built by Claude")).toBeVisible({ timeout: 20_000 });

  const frame = page.frameLocator(`iframe[title="${seeded.title}"]`);
  // The kit ran, `hello` was answered, the tree and four pages were read, and
  // the deck was built out of three shapes of markdown. The first card is the
  // shortest sentence that says all of it.
  await expect(frame.locator("#sourceLine")).toHaveText(/^4 words, 4 due now\.$/, {
    timeout: 20_000,
  });

  const answers = ["againBtn", "goodBtn", "easyBtn"];
  const answered: string[] = [];
  for (const button of answers) {
    const word = await frame.locator("#wordEl").textContent();
    expect(word, "the card has no word on it").toBeTruthy();
    answered.push(word!);
    await frame.locator("#showBtn").click();
    await expect(frame.locator("#translationEl")).toBeVisible();
    await frame.locator(`#${button}`).click();
    if (answered.length === 1) {
      // The first answer on its own, before a second can fold into it: the
      // singular sentence the bell draws for one write, with the app's own
      // name in front of it and nothing the app chose anywhere in it.
      await expect
        .poll(() => bellTitles(page), { timeout: 30_000 })
        .toContain(`${seeded.title} updated Words`);
    }
  }

  // Three answers, three statuses, and the word nobody saw still new. The
  // whole table is written every time, so the fourth row is the assertion
  // that a save is a save of the deck and not of one row.
  // Poll on the LAST answer's own row, not on the table's header: the header
  // is there after the first save, and reading then is a race with the third.
  await expect
    .poll(
      async () => wordRow(await markdownOf(page, seeded.words), answered[2])?.[2],
      { timeout: 30_000 },
    )
    .toBe("known");
  const words = await markdownOf(page, seeded.words);
  expect(wordRow(words, answered[0])?.[2]).toBe("learning");
  expect(wordRow(words, answered[1])?.[2]).toBe("learning");
  expect(wordRow(words, answered[2])?.[2]).toBe("known");
  // Good pushes the date out; Again leaves the word due today.
  expect(wordRow(words, answered[0])?.[4]).toBe("");
  expect(wordRow(words, answered[1])?.[4]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  for (const word of ["hola", "adios", "gracias", "buenos"]) {
    expect(wordRow(words, word), `${word} is not on the Words page`).not.toBeNull();
  }

  // And the burst folds rather than filling the bell with a line per card.
  await expect
    .poll(() => bellTitles(page), { timeout: 30_000 })
    .toContain(`${seeded.title} updated 3 pages`);
});

test("@release an app cannot read Brain's API, its cookies, or the top window", async ({
  page,
}) => {
  await login(page);
  const title = `Escape attempt ${tag()}`;
  await seed(page, title, [
    {
      sourceId: "escape",
      parentSourceId: null,
      title,
      markdown: "What an app can reach, which is nothing.\n",
      app: { entryHtml: ESCAPE },
    },
  ]);
  await page.goto(`/p/${await idOf(page, title)}`);

  const frame = page.frameLocator(`iframe[title="${title}"]`);
  const report = frame.locator("#report");
  await expect(report).not.toHaveText("running", { timeout: 20_000 });
  const found = JSON.parse((await report.textContent()) ?? "{}") as Record<string, string>;

  // connect-src 'none'. Not to another site and not to Brain either, so an
  // app that wanted the whole notebook could not ask for it behind the
  // bridge's back.
  expect(found.api).toBe("refused");
  // No allow-same-origin, so the frame's origin is opaque: it carries no
  // cookie of Brain's and cannot read one.
  expect(["empty", "threw"]).toContain(found.cookie);
  // And it cannot read the document that framed it, in either direction.
  expect(found.top).toBe("threw");
  expect(found.parentName).toBe("threw");
});

test("@release a shared trainer runs, and refuses to write", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page);
  const seeded = await seedTrainer(page);

  // Share the deck, so the link reaches the trainer and the pages it reads.
  const scope = await browserJson(page, `/api/page/${seeded.deck}/share`);
  expect(scope.ok, JSON.stringify(scope.body)).toBeTruthy();
  const shared = await browserJson(page, `/api/page/${seeded.deck}/share`, {
    method: "POST",
    body: {
      enabled: true,
      canEdit: false,
      expectedScopeToken: (scope.body as { scopeToken: string }).scopeToken,
    },
  });
  expect(shared.ok, JSON.stringify(shared.body)).toBeTruthy();
  expect((shared.body as { public: boolean }).public).toBe(true);

  const before = await markdownOf(page, seeded.words);

  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  try {
    await visitor.goto(
      `/share/${seeded.deck}?page=${seeded.trainer}`,
    );
    // The title block is the shared page's own, and the body the server drew
    // is behind the island rather than printed under it.
    await expect(visitor.locator("h1")).toHaveText(seeded.title, { timeout: 20_000 });
    await expect(visitor.locator("[data-share-fallback]")).toBeHidden();

    const frame = visitor.frameLocator(`iframe[title="${seeded.title}"]`);
    // The app runs, and it read the shared subtree to build its deck.
    await expect(frame.locator("#sourceLine")).toHaveText(
      /^4 words, 4 due now\.$/,
      { timeout: 20_000 },
    );

    await frame.locator("#showBtn").click();
    await frame.locator("#goodBtn").click();

    // The app's own refusal line, in its own words, rather than a silence a
    // visitor would read as a save.
    await expect(frame.locator("#statusLine")).toHaveText(
      "This is a shared copy, so your answers stay in this browser.",
      { timeout: 20_000 },
    );
    // And the owner's page is exactly as it was.
    expect(await markdownOf(page, seeded.words)).toBe(before);

    // THE VISITOR'S OWN TOKEN, AND THE HALF OF IT NOTHING ELSE MEASURES.
    //
    // The share page mints the frame's address from the grant it resolved, so
    // the visitor's authority is in the path the way the owner's is. Its
    // entry loading proves the mint; an asset painting proves the rest of the
    // path, which is the request that carries no cookie and no query and used
    // to be a picture that simply never appeared.
    await visitor.goto(`/share/${seeded.deck}?page=${seeded.probe}`);
    const probe = visitor.frameLocator(`iframe[title="${seeded.probeTitle}"]`);
    await expect(probe.locator("#loaded")).toHaveText("the frame document rendered", {
      timeout: 20_000,
    });
    await expect(probe.locator("#asset")).toHaveText("the asset painted, 1 wide", {
      timeout: 20_000,
    });

    const probeSrc = await visitor
      .locator(`iframe[title="${seeded.probeTitle}"]`)
      .getAttribute("src");
    expect(probeSrc).toMatch(new RegExp(`^/api/app/${seeded.probe}/t/[^/]+/index\\.html$`));
    // The address a visitor's frame is given carries no root and no version in
    // a query, because a relative asset url would drop them.
    expect(probeSrc).not.toContain("root=");
    expect(probeSrc).not.toContain("v=");
  } finally {
    await visitorContext.close();
  }
});

test("@release @mobile the frame fills the canvas above the tab bar at 390", async ({
  page,
}) => {
  await login(page);
  const seeded = await seedTrainer(page);
  await page.goto(`/p/${seeded.trainer}`);

  const frame = page.locator(`iframe[title="${seeded.title}"]`);
  await expect(frame).toBeVisible({ timeout: 20_000 });
  const tabbar = page.locator("nav.brain-mobile-tabbar");
  await expect(tabbar).toBeVisible();

  const frameBox = await frame.boundingBox();
  const barBox = await tabbar.boundingBox();
  expect(frameBox, "the frame has no box").not.toBeNull();
  expect(barBox, "the tab bar has no box").not.toBeNull();
  // An app's own bottom control must not sit behind Brain's, which is what
  // `--tabbar-reserve` on the canvas is for.
  expect(frameBox!.y + frameBox!.height).toBeLessThanOrEqual(barBox!.y + 1);
  expect(frameBox!.width).toBeGreaterThan(300);
});
