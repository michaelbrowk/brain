// Apps in a real browser.
//
// This file exists because of a bug no unit test in the branch could see. Next
// accumulates every header rule whose source matches a path and lets nothing
// downstream remove a key one of them set, so the global block's
// `X-Frame-Options: DENY` and `frame-ancestors 'none'` were on every
// `/api/app/*` response and the route's own per-request policy was dropped
// beside them. The canvas mounted a frame the browser then refused, silently:
// a CSP violation inside an opaque-origin frame is reported to nobody, and the
// HEAD preflight answered 200 so the missing-files state did not catch it
// either. Every assertion in this file was green while the feature was
// completely broken on a real server.
//
// So the case below runs the whole path: an app page written through the
// store, opened in the shell, its entry served by the route under its own
// policy, its document rendered inside the sandboxed frame, its inline script
// run, and the bridge answering it. Nothing short of a browser answers any of
// that.
//
// The app page is seeded through the portable import, which is the only
// surface in this release that reaches `writeAppFiles` and `setAppMeta`. The
// MCP tools that build an app land later, and the round trip through them is
// that task's case, not this one.
//
// EVERY TEST IN THIS FILE IS `@release`, for the reason `e2e/tasks.spec.ts`
// states at its head: `ci.yml` and `release.yml` both run `--grep @release`,
// so an untagged test here would run in the weekly full job and nowhere else.
import { expect, test, type Page } from "playwright/test";

import { createPortableArchive } from "../lib/portable/archive";

const PORT = process.env.BRAIN_E2E_PORT ?? "3021";
const ORIGIN = `http://127.0.0.1:${PORT}`;

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
const ENTRY = `<!doctype html>
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

/** One opaque pixel, so the asset case measures a real decode rather than an
 *  element that happens to exist. `naturalWidth` is 1 only if the bytes
 *  arrived and the browser read them as a PNG. */
const DOT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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
 *  the owner's session rides with it. Header names come back lowercased, as
 *  `Headers` gives them. */
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

/** One app page, written by the store's own app writers. The archive is built
 *  here rather than exported from a notebook so the test states the shape it
 *  depends on instead of inheriting one. */
async function seedAppPage(page: Page, title: string): Promise<string> {
  const encoder = new TextEncoder();
  const manifest = {
    format: "brain-portable",
    version: 3,
    exportedAt: "2026-09-22T10:00:00.000Z",
    scope: "subtree",
    title,
    pages: [
      {
        sourceId: "src-app",
        parentSourceId: null,
        markdownPath: "pages/p000000.md",
        meta: { title },
        app: {
          meta: {
            entry: "app/index.html",
            version: 1,
            builtBy: "Claude",
            builtAt: "2026-09-22T10:00:00.000Z",
            owns: [],
            state: false,
            reason: "prove the frame loads under its own policy",
          },
          entryPath: "app/p000000/index.html",
          assets: [
            { name: "dot.png", archivePath: "app/p000000/assets/dot.png" },
          ],
        },
      },
    ],
    attachments: [],
  };
  const archive = createPortableArchive([
    { path: "manifest.json", data: encoder.encode(JSON.stringify(manifest)) },
    {
      path: "pages/p000000.md",
      data: encoder.encode("The release case for an app page's frame.\n"),
    },
    { path: "app/p000000/index.html", data: encoder.encode(ENTRY) },
    { path: "app/p000000/assets/dot.png", data: new Uint8Array(DOT_PNG) },
  ]);

  const imported = await page.evaluate(async (base64: string) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const form = new FormData();
    form.append("file", new File([bytes], "app.tar.gz", { type: "application/gzip" }));
    form.append("mode", "apply");
    const response = await fetch("/api/portable/import", {
      method: "POST",
      body: form,
    });
    return { status: response.status, body: await response.text() };
  }, Buffer.from(archive).toString("base64"));

  expect(imported.status, imported.body).toBe(200);
  const result = JSON.parse(imported.body) as {
    result: { rootIds: string[] };
  };
  const id = result.result.rootIds[0];
  expect(id).toBeTruthy();
  return id!;
}

test("@release an app page's frame loads under its own policy and answers hello", async ({
  page,
}) => {
  await login(page);
  const id = await seedAppPage(page, "Frame probe");

  await page.goto(`/p/${id}`);

  // The head the canvas draws, which is the shell's half of the page.
  await expect(page.getByText("Built by Claude")).toBeVisible({ timeout: 20_000 });

  // And the app's half. Reaching this text at all means the response was not
  // refused by X-Frame-Options, its document rendered inside a frame with no
  // `allow-same-origin`, and its inline script ran under the route's policy.
  const frame = page.frameLocator('iframe[title="Frame probe"]');
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
  const src = await page
    .locator('iframe[title="Frame probe"]')
    .getAttribute("src");
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
