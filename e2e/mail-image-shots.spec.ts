// Owner-gate artifact capture for image sizing in the mail reader — on demand:
//
//   BRAIN_E2E_PORT=3140 BRAIN_DIST_DIR=.next-img node scripts/e2e-dev.mjs
//   MAIL_IMAGE_SHOTS=1 BRAIN_E2E_PORT=3140 pnpm exec playwright test e2e/mail-image-shots.spec.ts
//
// Unlike the table pair, both halves of each pair come from one run: the only
// thing that changed is the frame's own image rules, so the "before" frame is
// this build with those exact rules swapped back. Same fixture, same rasters,
// same run — the pair differs by the rules and nothing else.
//
// Two pairs, two "befores". The digest is drawn against the ORIGINAL rule
// (`img{max-width:100%}` and nothing else), which shrank its logos and
// badges. The padded-hero capture is drawn against the rule that fixed those
// by bounding every sized picture to the column, which widened this hero past
// its cell and panned the message — the shape the box-bound default with a
// per-picture escape replaced.
//
// One scheme only. The frame renders the sender's own colours over the sender's
// own background, so a dark pass would be the same picture twice.
//
// Screenshots land in docs/design/mail/. Skipped everywhere else so the full
// e2e suite never rewrites the artifacts on disk.
//
// The directory it writes into is on the publication denylist
// (scripts/publication-denylist.mjs), so this repository carries none of
// these frames. Shoot them, read them, throw them away — but do not commit
// them here: the forbidden-path step of `pnpm check` refuses a tracked path
// the list names.

import path from "node:path";

import { expect, test } from "playwright/test";

import { createMailHtmlDocument } from "../lib/mail/reader-html";
import { MAIL_RESOURCE_LIMITS } from "../lib/mail/security";
import { sanitizeMailHtmlWithRemoteImages } from "../lib/mail/service/mail-html-sanitizer";
import {
  declaredGeometryDigestEmailHtml,
  declaredGeometryDigestRaster,
  paddedHeroEmailHtml,
} from "../lib/mail/testing/reader-layout-fixtures";

const OUT = path.join(process.cwd(), "docs", "design", "mail");

const SIZED_BY_WIDTH =
  '#brain-mail-content img[width],#brain-mail-content img[style^="width:"],#brain-mail-content img[style*=";width:"]';
const SIZED_BY_HEIGHT =
  '#brain-mail-content img[height],#brain-mail-content img[style^="height:"],#brain-mail-content img[style*=";height:"]';

/** The frame's image rules as they stand now. */
const NOW = {
  image:
    "#brain-mail-content img{max-width:100%;box-sizing:content-box}" +
    `${SIZED_BY_HEIGHT}{max-width:100cqw}` +
    `${SIZED_BY_WIDTH}{max-width:100%}`,
  placeholder: ".brain-mail-image-placeholder{display:inline-block;max-width:100%",
} as const;

/** The original rule, for the digest pair: one bound, the box. */
const BEFORE_ORIGINAL = [
  [NOW.image, "#brain-mail-content img{max-width:100%}"],
  [NOW.placeholder, NOW.placeholder],
] as const;

/** The column bound on every sized picture, for the padded-hero pair. */
const BEFORE_COLUMN = [
  [
    NOW.image,
    "#brain-mail-content img{max-width:100%;box-sizing:content-box}" +
      `${SIZED_BY_WIDTH},${SIZED_BY_HEIGHT}{max-width:calc(100vw - 16px)}`,
  ],
  [
    NOW.placeholder,
    ".brain-mail-image-placeholder{display:inline-block;max-width:calc(100vw - 16px)",
  ],
] as const;

test.skip(
  process.env.MAIL_IMAGE_SHOTS !== "1",
  "artifact capture — run with MAIL_IMAGE_SHOTS=1",
);

function readerDocument(
  emailHtml: string,
  raster: (sourceUrl: string) => readonly [number, number],
): string {
  let allocated = 0;
  const sanitized = sanitizeMailHtmlWithRemoteImages(
    emailHtml,
    {
      maxCharacters: MAIL_RESOURCE_LIMITS.htmlCharacters,
      maxNodes: MAIL_RESOURCE_LIMITS.maxDomNodes,
      maxAttributes: MAIL_RESOURCE_LIMITS.maxDomAttributes,
      maxRemoteImages: MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
    },
    () => `remote-image-a${(allocated++).toString(16).padStart(32, "0")}`,
  );
  expect(sanitized.html).not.toBeNull();
  return createMailHtmlDocument({
    sanitizedHtml: sanitized.html ?? "",
    attachments: [],
    cidSources: new Map(),
    remoteSources: new Map(
      sanitized.remoteImages.map((image) => {
        const [width, height] = raster(image.sourceUrl);
        return [image.remoteImageId, `blob:raster-${width}-${height}-end`];
      }),
    ),
  });
}

/**
 * The same document under an earlier rule set. The stylesheet is swapped
 * rule for rule, and the per-picture bounds the builder now writes inline
 * are taken off, since no earlier build wrote them.
 */
function under(
  fixed: string,
  swaps: ReadonlyArray<readonly [string, string]>,
): string {
  let before = fixed;
  for (const [now, previously] of swaps) {
    expect(before, `frame no longer contains ${now}`).toContain(now);
    before = before.replace(now, previously);
  }
  return before
    .replaceAll(";max-width:100cqw\"", '"')
    .replaceAll(' style="max-width:100cqw"', "")
    .replaceAll(";box-sizing:content-box\"", '"')
    .replaceAll(' style="box-sizing:content-box"', "");
}

test("capture the mail image artifacts", async ({ page }) => {
  // Same origin as the app so a srcdoc frame behaves, blank so the artifact is
  // the message and not the shell behind it.
  await page.goto("/login");
  // The login page is still settling its own client navigation. Replacing the
  // document under it races that and loses the frame.
  await page.waitForLoadState("networkidle");
  await page.setContent("<!doctype html><html><body></body></html>");

  const digest = readerDocument(
    declaredGeometryDigestEmailHtml,
    declaredGeometryDigestRaster,
  );
  const hero = readerDocument(paddedHeroEmailHtml, () => [1200, 600]);
  const pairs = [
    ["image", under(digest, BEFORE_ORIGINAL), digest],
    ["image-hero", under(hero, BEFORE_COLUMN), hero],
  ] as const;

  for (const [name, before, fixed] of pairs) {
    for (const width of [390, 620] as const) {
      for (const [suffix, documentHtml] of [
        ["-before", before],
        ["", fixed],
      ] as const) {
        await page.evaluate(
          async ([html, frameWidth]) => {
            document.querySelector("#brain-mail-shot")?.remove();
            let source = html as string;
            for (const token of new Set(
              source.match(/blob:raster-\d+-\d+-end/g) ?? [],
            )) {
              const [, w, h] = /blob:raster-(\d+)-(\d+)-end/.exec(token)!;
              const canvas = document.createElement("canvas");
              canvas.width = Number(w);
              canvas.height = Number(h);
              const context = canvas.getContext("2d")!;
              // A flat block would hide the real tell. A ring plus a diagonal
              // reads its own scale, so the pair shows the size change directly.
              context.fillStyle = "#0a66c2";
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.strokeStyle = "#ffffff";
              context.lineWidth = Math.max(1, Math.round(canvas.width / 16));
              context.beginPath();
              context.moveTo(0, 0);
              context.lineTo(canvas.width, canvas.height);
              context.moveTo(canvas.width, 0);
              context.lineTo(0, canvas.height);
              context.stroke();
              const blob = await new Promise<Blob>((resolve) =>
                canvas.toBlob((value) => resolve(value!), "image/png"),
              );
              source = source.split(token).join(URL.createObjectURL(blob));
            }

            const host = document.createElement("div");
            host.id = "brain-mail-shot";
            host.style.cssText = `position:absolute;inset:0 auto auto 0;width:${frameWidth}px;background:#fff`;
            const frame = document.createElement("iframe");
            frame.setAttribute("sandbox", "allow-same-origin");
            frame.style.cssText = "border:0;width:100%;height:2400px;display:block";
            frame.srcdoc = source;
            host.append(frame);
            await new Promise<void>((resolve) => {
              frame.addEventListener("load", () => resolve(), { once: true });
              document.body.append(host);
            });
            // The reader sizes the frame to its content. Do the same here so the
            // artifact is the message, not the message plus empty paper.
            const root = frame.contentDocument!.getElementById("brain-mail-content")!;
            frame.style.height = `${Math.ceil(root.scrollHeight)}px`;
          },
          [documentHtml, width] as const,
        );
        await page.waitForTimeout(200);
        await page
          .locator("#brain-mail-shot")
          .screenshot({ path: path.join(OUT, `${name}-${width}${suffix}.png`) });
      }
    }
  }
});
