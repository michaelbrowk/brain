import { readFileSync } from "node:fs";
import path from "node:path";

// Resolved from the working directory rather than from `import.meta`, because
// Playwright transpiles this module to CommonJS and Vitest does not. Both
// runners start at the repository root, which `e2e/mail-image-shots.spec.ts`
// already relies on for its output path.
const FIXTURE_DIR = path.join(process.cwd(), "lib", "mail", "testing");

/** Long enough that no reader column can hold it, with nothing to break on. */
export const UNBREAKABLE_TEXT_TOKEN =
  "https://example.test/example-org/example-repo/actions/runs/18446744073709551615/job/9223372036854775807?check_suite_focus=true";

export const UNBREAKABLE_LINK_TOKEN =
  "https://example.test/example-org/example-repo/suites/29876543210987654321/artifacts/1357924680135792468?anchor=deadbeefcafe";

/**
 * Layout fixtures for the sanitized reader frame.
 *
 * The shape is the one GitHub sends for a workflow-run notification: a 544px
 * container, a card, and a "table" that is really a stack of sibling single-row
 * tables. Every data row carries the same three cells — an empty avatar cell, a
 * `width:100%` text cell, and a trailing status cell the sender protects with
 * `white-space:nowrap`. That trailing cell is the one that used to render one
 * glyph per line.
 *
 * Two rows are probes rather than copies of GitHub. `Duration` is a short label
 * with neither nowrap nor alignment, which shredded at every width. The last row
 * is the spacer idiom (`[mark][width:100%][button]`) that email uses to push two
 * things apart — a reader rule that fixes the status column by overriding the
 * sender's widths collapses that row, so it is measured alongside the bug.
 */
export const githubActionsRunEmailHtml = card([
  rowUnit(
    '<td align="center" style="padding:0"><img src="https://example.test/avatar.png" width="56" height="56" alt="" style="border-style:none"></td>',
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">example-org/example-repo</p></td>',
    '<td class="pr-2 py-2" style="white-space:nowrap;padding:8px 8px 8px 0"><a href="https://example.test/run" class="btn" style="display:inline-block;padding:0 7px">View run</a></td>',
  ),
  rowUnit(
    '<td align="center" style="padding:0"></td>',
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">Job</p></td>',
    '<td class="pr-2 py-2" style="white-space:nowrap;padding:8px 8px 8px 0"><p class="mb-0" style="margin-bottom:0">Status</p></td>',
  ),
  rowUnit(
    '<td align="center" style="padding:0"></td>',
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">check / typecheck</p></td>',
    `<td class="pr-2 py-2" style="white-space:nowrap;padding:8px 8px 8px 0">${label("Failed")}</td>`,
  ),
  rowUnit(
    '<td align="center" style="padding:0"></td>',
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">check / round-trips</p></td>',
    `<td class="pr-2 py-2" style="white-space:nowrap;padding:8px 8px 8px 0">${label("Cancelled")}</td>`,
  ),
  rowUnit(
    '<td align="center" style="padding:0"></td>',
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">Duration</p></td>',
    '<td class="pr-2 py-2" style="padding:8px 8px 8px 0"><p class="mb-0" style="margin-bottom:0">Queued</p></td>',
  ),
  rowUnit(
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">Billed minutes</p></td>',
    '<td align="right" style="padding:8px 8px 8px 0"><p class="mb-0" style="margin-bottom:0">14 min</p></td>',
  ),
  rowUnit(
    '<td style="padding:8px 0"><img src="https://example.test/mark.png" width="32" height="32" alt="" style="border-style:none"></td>',
    '<td style="width:100%;padding:0"></td>',
    '<td style="padding:8px 0"><a href="https://example.test/rerun" style="display:inline-block;padding:0 7px;border:1px solid #e1e4e8">Re-run</a></td>',
  ),
]);

/**
 * The same card with two cells no column can hold: an unbreakable token as
 * text, and one inside a link. Nothing GitHub sends looks like this, and plenty
 * of transactional mail does. It is the worst case for any rule that gives a
 * cell a min-content floor, so it is measured apart from the bug.
 */
export const githubActionsRunEmailWithTokensHtml = card([
  rowUnit(
    '<td align="center" style="padding:0"></td>',
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">Job</p></td>',
    '<td class="pr-2 py-2" style="white-space:nowrap;padding:8px 8px 8px 0"><p class="mb-0" style="margin-bottom:0">Status</p></td>',
  ),
  rowUnit(
    '<td align="center" style="padding:0"></td>',
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">check / typecheck</p></td>',
    `<td class="pr-2 py-2" style="white-space:nowrap;padding:8px 8px 8px 0">${label("Failed")}</td>`,
  ),
  rowUnit(
    '<td align="center" style="padding:0"></td>',
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">Run</p></td>',
    `<td class="pr-2 py-2" style="padding:8px 8px 8px 0"><p class="mb-0" style="margin-bottom:0">${UNBREAKABLE_TEXT_TOKEN}</p></td>`,
  ),
  rowUnit(
    '<td align="center" style="padding:0"></td>',
    '<td class="p-2" style="width:100%;padding:8px"><p class="mb-0" style="margin-bottom:0">Artifact</p></td>',
    `<td class="pr-2 py-2" style="padding:8px 8px 8px 0"><a href="https://example.test/artifact" style="display:inline-block">${UNBREAKABLE_LINK_TOKEN}</a></td>`,
  ),
]);

/** GitHub's shared chrome: a 544px container around one bordered card. */
function card(rows: readonly string[]): string {
  return [
    '<html style="-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;box-sizing:border-box">',
    '<body bgcolor="#fff" style="font-size:14px;line-height:1.5;color:#24292e;background-color:#fff;margin:0">',
    '<table width="100%" align="center" class="container-sm width-full" style="border-spacing:0;border-collapse:collapse;max-width:544px;margin-right:auto;margin-left:auto;width:100% !important">',
    '<tr><td align="center" valign="top" class="center p-3" style="padding:16px"><center>',
    '<table width="100%" class="width-full" style="width:100% !important">',
    '<tr><td class="border rounded-2 d-block" style="border-radius:6px !important;display:block !important;padding:0;border:1px solid #e1e4e8">',
    '<table align="center" class="width-full text-center" style="width:100% !important;text-align:center !important">',
    '<tr><td class="p-3 p-sm-4" style="padding:24px">',
    '<table width="100%" align="center" cellpadding="0" cellspacing="0" border="0" class="width-full" style="width:100% !important">',
    '<tr><td align="center" style="padding:0">',
    ...rows,
    "</td></tr></table>",
    "</td></tr></table>",
    "</td></tr></table>",
    '<table width="100%" align="center" cellpadding="0" cellspacing="0" border="0" class="width-full" style="width:100% !important">',
    '<tr><td align="center" style="padding:16px 0 0 0"><p class="mb-0" style="margin-bottom:0">You are receiving this because you are subscribed to this thread.</p></td></tr>',
    "</table>",
    "</center></td></tr></table>",
    "</body></html>",
  ].join("");
}

/** A row GitHub draws as its own single-row table, bottom rule included. */
function rowUnit(...cells: readonly string[]): string {
  return [
    '<table align="center" class="border-bottom width-full text-center" style="border-bottom-width:1px !important;border-bottom-color:#e1e4e8 !important;border-bottom-style:solid !important;width:100% !important;text-align:center !important">',
    '<tr><td align="left" class="d-block text-left" style="text-align:left !important;display:block !important;padding:0">',
    '<table width="100%" align="center" cellpadding="0" cellspacing="0" border="0" class="width-full" style="width:100% !important">',
    `<tr>${cells.join("")}</tr>`,
    "</table></td></tr></table>",
  ].join("");
}

function label(text: string): string {
  return `<span class="Label" style="display:inline-block;font-size:12px;font-weight:500;line-height:18px;border-radius:2em;background-color:transparent !important;padding:0 7px;border:1px solid #e1e4e8">${text}</span>`;
}

/**
 * A saved-search digest from a fictional service, reconstructed for this file.
 *
 * Nothing in it is captured from anyone's mail. The service, the sender, the
 * listings, the wording and every asset URL are invented, and every domain is
 * a reserved example name. What is deliberate is the geometry: bulk mail
 * declares an image's size in four ways a reader has to draw differently, and
 * this template was written to hold all four.
 *
 * - The wordmark declares `width` and `height`, inside an anchor the sender
 *   made narrower than the picture (`width:84px` around a 101px image).
 * - A listing logo declares 48x48 inside `<td width="48"
 *   style="width:48px;padding-right:8px">` — a cell the sender declared exactly
 *   as wide as the picture, with padding on top of it.
 * - A "Quick reply" badge declares 16x16 inside an 8px cell. The sender means
 *   the picture to overflow, and every other client draws it.
 * - Three header icons declare `height` and nothing else. Their rasters are 2x,
 *   so an override that drops the declared height doubles them.
 *
 * Around those four sits the structure they have to be measured inside: a
 * fixed-width shell that gives way below 600px, nested presentational tables,
 * a picture the sender sized responsively and capped with `max-width`, and a
 * 1x1 tracking pixel the sanitizer drops before the reader ever sees it.
 */
export const declaredGeometryDigestEmailHtml = readFileSync(
  path.join(FIXTURE_DIR, "declared-geometry-digest.html"),
  "utf8",
);

/**
 * What each fixture image would arrive as once the reader has fetched it.
 * The pictures are invented like the rest of the message, so these sizes are
 * chosen rather than measured: every raster is larger than the size its sender
 * declares, because a picture drawn at its own pixels instead of the declared
 * ones is only visible when the two differ. The three header icons are 2x, and
 * two of them carry a ratio that is not the third's, so a width derived from
 * the raster cannot be mistaken for a constant.
 *
 * Matched as substrings and read in order, so the longer names come first:
 * `wordmark` is the tail of `plus-wordmark` and `footer-wordmark` too.
 */
export const DECLARED_GEOMETRY_DIGEST_RASTERS: ReadonlyArray<
  readonly [string, readonly [number, number]]
> = Object.freeze([
  ["listing-logo_100_100", [100, 100]],
  ["avatar_128_128", [128, 128]],
  ["inbox-icon", [62, 50]],
  ["saved-icon", [64, 50]],
  ["alerts-icon", [64, 50]],
  ["reply-badge", [100, 100]],
  ["new-badge", [32, 32]],
  ["plus-wordmark", [156, 16]],
  ["footer-wordmark", [168, 42]],
  ["app-preview", [468, 418]],
  ["open-pixel", [1, 1]],
  ["wordmark", [202, 74]],
]);

/** The raster the fixture's sender would have served for this URL. */
export function declaredGeometryDigestRaster(
  sourceUrl: string,
): readonly [number, number] {
  const raster = DECLARED_GEOMETRY_DIGEST_RASTERS.find(([name]) =>
    sourceUrl.includes(name),
  );
  if (raster === undefined) {
    throw new Error(`no raster size for ${sourceUrl}`);
  }
  return raster[1];
}

/**
 * Two shapes the digest does not contain, and both bound the same rule from
 * the other side.
 *
 * - A hero the sender declared far wider than any reader column. The column is
 *   the reader's own bound and still holds, or every newsletter pans sideways.
 * - An icon the sender sized by height alone, in a cell the sender declared
 *   narrower than the icon's ratio wants. Capping it against that cell left a
 *   zero-width picture at full height.
 */
export const wideImageEmailHtml = [
  '<table width="100%"><tbody>',
  '<tr><td style="padding:16px">',
  '<img src="https://example.test/hero.png" alt="Hero" width="1200" height="600" style="display:block;width:1200px;height:600px">',
  "</td></tr>",
  "<tr><td>",
  '<table width="100%"><tbody><tr>',
  '<td width="20" style="width:20px;padding-right:4px">',
  '<img src="https://example.test/badge.png" alt="Badge" height="24" style="height:24px">',
  "</td>",
  '<td style="width:100%">a headline that takes the rest of the row</td>',
  "</tr></tbody></table>",
  "</td></tr>",
  "</tbody></table>",
].join("");

/**
 * The commonest shape in a newsletter: a hero the sender sized, in a cell the
 * sender padded and did not size. The cell is the picture's only box, and the
 * picture has to fit it — a bound that reaches past the cell to the column
 * widens the picture by the padding, and the whole message pans by that much.
 */
export const paddedHeroEmailHtml = [
  '<table width="100%"><tbody>',
  '<tr><td style="padding:16px">',
  '<img src="https://example.test/hero.png" alt="Hero" width="600" height="300" style="display:block">',
  "</td></tr>",
  '<tr><td style="padding:0 16px 16px">a caption under the picture</td></tr>',
  "</tbody></table>",
].join("");

/** The rasters the sender would have served for `wideImageEmailHtml`. */
export const WIDE_IMAGE_RASTERS: ReadonlyArray<
  readonly [string, readonly [number, number]]
> = Object.freeze([
  ["hero.png", [2400, 1200]],
  ["badge.png", [192, 48]],
]);
