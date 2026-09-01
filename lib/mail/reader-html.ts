import {
  MAIL_INLINE_IMAGE_MAX_BYTES,
  type MailContentAttachmentDto,
} from "./content-types";

const INLINE_RASTER_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Same-origin is required for parent-created blob: CID URLs in Chromium.
// Scripts, navigation, forms, popups, and every other sandbox capability stay absent.
export const MAIL_READER_IFRAME_SANDBOX = "allow-same-origin";

/** The frame's own gutter, on both sides of the message. */
const READER_GUTTER_PX = 8;

/**
 * The reader's column, named from inside the frame. The frame is the column,
 * and `#brain-mail-content` is a size container, so this is its content box —
 * the viewport less the gutter, and less a classic scrollbar where the platform
 * draws one, which `100vw` counted and `cqw` does not.
 */
const READER_COLUMN = "100cqw";

/** Tags the sanitizer may emit with no closing tag. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * An image whose sender declared this axis. The style test reads the
 * sanitizer's normalised style — one `property:value` per `;`, with no spaces —
 * so a declaration either opens the string or follows a `;`.
 */
function sizedBy(axis: "width" | "height"): readonly string[] {
  return [
    `#brain-mail-content img[${axis}]`,
    `#brain-mail-content img[style^="${axis}:"]`,
    `#brain-mail-content img[style*=";${axis}:"]`,
  ];
}

export function referencedInlineCidAttachments(
  sanitizedHtml: string,
  attachments: readonly MailContentAttachmentDto[],
): readonly MailContentAttachmentDto[] {
  const references = new Set(
    [...sanitizedHtml.matchAll(/<img data-brain-cid="([^"]+)"/g)].map(
      (match) => match[1]!,
    ),
  );
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    if (attachment.contentId !== null) {
      counts.set(
        attachment.contentId,
        (counts.get(attachment.contentId) ?? 0) + 1,
      );
    }
  }
  return Object.freeze(
    attachments.filter(
      (attachment) =>
        attachment.contentId !== null &&
        counts.get(attachment.contentId) === 1 &&
        attachment.disposition === "inline" &&
        INLINE_RASTER_MIME_TYPES.has(attachment.mimeType) &&
        attachment.bytes <= MAIL_INLINE_IMAGE_MAX_BYTES &&
        references.has(escapeHtml(attachment.contentId)),
    ),
  );
}

export function referencedRemoteImageIds(
  sanitizedHtml: string,
): readonly string[] {
  return Object.freeze([
    ...new Set(
      [...sanitizedHtml.matchAll(
        /<img data-brain-remote-image="(remote-image-a[0-9a-f]{32})"/g,
      )].map((match) => match[1]!),
    ),
  ]);
}

/**
 * Builds an inert srcdoc. The HTML input has already crossed the isolated
 * sanitizer boundary. CID images are bound only to this app's authenticated
 * attachment proxy; every other network source remains forbidden by CSP.
 */
export function createMailHtmlDocument(input: {
  readonly sanitizedHtml: string;
  readonly attachments: readonly MailContentAttachmentDto[];
  readonly cidSources: ReadonlyMap<string, string>;
  readonly remoteSources?: ReadonlyMap<string, string>;
}): string {
  const html = capResponsiveImagesAtDeclaredWidth(
    bindVerifiedRemoteImages(
      bindVerifiedCidImages(
        freePicturesFromNarrowerBoxes(input.sanitizedHtml),
        input.attachments,
        input.cidSources,
      ),
      input.remoteSources ?? new Map(),
    ),
  );
  const csp = [
    "default-src 'none'",
    "img-src blob:",
    "style-src 'unsafe-inline'",
    "script-src 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const responsiveStyle = [
    'html,body{margin:0;max-width:100%;overflow-x:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}',
    // `anywhere` is the safety net for a long unbreakable token in a block that
    // the column already sizes. It is also the reason a message can be wider
    // than the column at all: when a cell refuses to shrink, the extra width
    // pans here instead of being clipped away by the html/body rule above.
    // `container-type` makes the root the query container `100cqw` below reads.
    `#brain-mail-content{box-sizing:border-box;width:100%;padding:${READER_GUTTER_PX}px;overflow-x:auto;overflow-wrap:anywhere;container-type:inline-size}`,
    "#brain-mail-content *{box-sizing:border-box}",
    "#brain-mail-content div,#brain-mail-content p,#brain-mail-content blockquote,#brain-mail-content h1,#brain-mail-content h2,#brain-mail-content h3,#brain-mail-content h4,#brain-mail-content h5,#brain-mail-content h6,#brain-mail-content ul,#brain-mail-content ol{max-width:100%!important}",
    // A cell is a column, not prose. `anywhere` also lowers a column's
    // min-content to a single glyph, so a short label next to a greedy
    // `width:100%` sibling collapses to one letter per line. `break-word` still
    // breaks a word that cannot fit, and keeps the longest word as the floor.
    // No `!important`: a sender that sets overflow-wrap or word-break itself
    // asked for that behaviour and still wins over this default.
    "#brain-mail-content td,#brain-mail-content th{overflow-wrap:break-word}",
    // Right-aligned values are amounts and dates. They may not break at all,
    // and unlike the rule above this one holds at every width.
    "#brain-mail-content td[align=right]{width:auto!important;white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important}",
    "@media(max-width:600px){#brain-mail-content table:not([style*=\"display:inline-table\"]){width:100%!important;min-width:0!important;max-width:100%!important}#brain-mail-content td[style*=\"white-space:nowrap\"]:not([align=right]){white-space:normal!important}}",
    // `content-box` because a declared width is the picture, not the picture
    // less its own padding. The `*` reset above puts every element in this
    // message into the border box, which is right for the sender's containers
    // and wrong for a replaced element: a store badge written
    // `width:120px;padding-right:8px` drew its picture at 112.
    //
    // `100%` is the box around the picture, which is how every mail client
    // draws it and the bound the commonest newsletter shape depends on: a
    // hero in a padded cell. Bounding every sized picture by the column
    // instead widened that hero past its cell by the padding, and the whole
    // message panned by 36px. The one case the box gets wrong — a sender
    // who declared the box NARROWER than the picture, meaning it to overflow
    // — is found in the markup by `freePicturesFromNarrowerBoxes` and given
    // the column bound inline, picture by picture.
    "#brain-mail-content img{max-width:100%;box-sizing:content-box}",
    // Sized by height alone, a picture has no declared width to compare with
    // its box, and `100%` of a cell narrower than the ratio wants is a
    // zero-width picture at full height. The column is the one bound with
    // nothing nearer to it. A picture with a width as well is not "by height
    // alone": the second rule gives it the box back.
    `${sizedBy("height").join(",")}{max-width:${READER_COLUMN}}`,
    `${sizedBy("width").join(",")}{max-width:100%}`,
    // `height:auto` is here so an image that `max-width` narrows keeps its
    // ratio instead of holding the sender's pixel height. Applied to every
    // image it also takes the height away from one the sender sized by height
    // alone, and a replaced element with neither axis declared falls back to
    // its own raster — a 2x icon then draws at 2x. Height gives way only for
    // an image whose width is declared, the only one `max-width` can narrow.
    `${sizedBy("width").join(",")}{height:auto!important}`,
    "#brain-mail-content pre{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}",
    // Unavailable image stand-ins. The frame has no app tokens, so the fill is a
    // translucent tint of the surrounding text colour (the fill-active recipe).
    // A placeholder is only ever emitted for an image the sender sized, so it
    // takes the picture's own bound — the box by default, and inline whatever
    // the picture was given past it: it has to hold the shape the picture would.
    "#brain-mail-content .brain-mail-image-placeholder{display:inline-block;max-width:100%;height:auto;vertical-align:top;background:rgba(128,128,128,.12);background:color-mix(in srgb,currentcolor 7%,transparent)}",
    "#brain-mail-content .brain-mail-image-alt{display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:top}",
  ].join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><style>${responsiveStyle}</style></head><body><main id="brain-mail-content">${html}</main></body></html>`;
}

/**
 * A sender may declare a box narrower than the picture inside it, meaning the
 * picture to overflow — a digest card puts a 16px badge in an 8px cell and a
 * 101px wordmark in an 84px anchor, and every other client draws both.
 * `max-width:100%` resolves against that box and drew 4 and 84. So each
 * picture whose declared width exceeds the declared width of the nearest box
 * that has one is bound by the column instead, inline, and every other
 * picture keeps the box.
 *
 * A cell is read the way email writes it: its `width` names the content box,
 * with padding on top, so `<td width="48" style="padding-right:8px">` holds a
 * 48px logo exactly and is given `box-sizing:content-box` to draw that way
 * under the frame's border-box reset. Any other box keeps the reset, so its
 * padding comes off before the comparison. Percent widths bound nothing here.
 *
 * Runs on the sanitizer's output: one tag per `<`, attributes double-quoted
 * and escaped, styles normalised to `property:value` pairs joined by `;`.
 */
function freePicturesFromNarrowerBoxes(html: string): string {
  const open: Array<number | null> = [];
  return html.replace(
    /<(\/?)([a-z][a-z0-9]*)((?: [a-z-]+="[^"]*")*)>/g,
    (tag, closing: string, name: string, attributes: string) => {
      if (closing) {
        open.pop();
        return tag;
      }
      const style = /(?:^| )style="([^"]*)"/.exec(attributes)?.[1] ?? "";
      const declared = declaredPixels(attributes, style, "width");
      if (name === "img") {
        if (
          declared === null ||
          styleDeclares(style, "max-width") ||
          styleDeclares(style, "width", "100%")
        ) {
          return tag;
        }
        const box = nearestDeclaredBox(open);
        if (box === null || box >= declared) return tag;
        return withDeclaration(tag, style, `max-width:${READER_COLUMN}`);
      }
      const isCell = name === "td" || name === "th";
      let out = tag;
      let content = declared;
      if (declared !== null && isCell) {
        out = withDeclaration(tag, style, "box-sizing:content-box");
      } else if (declared !== null) {
        content = Math.max(0, declared - horizontalPadding(style));
      }
      if (!VOID_TAGS.has(name)) open.push(content);
      return out;
    },
  );
}

/** The innermost open box with a declared width, or none. */
function nearestDeclaredBox(open: ReadonlyArray<number | null>): number | null {
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const width = open[index];
    if (width != null) return width;
  }
  return null;
}

function styleDeclares(style: string, property: string, value?: string): boolean {
  return style.split(";").some((declaration) => {
    const [name, ...rest] = declaration.split(":");
    if (name?.trim().toLowerCase() !== property) return false;
    return value === undefined || rest.join(":").trim().toLowerCase() === value;
  });
}

/** The sanitizer's `px` values only; anything else pads by an unknown amount
 *  and is read as nothing rather than guessed. */
function horizontalPadding(style: string): number {
  let left = 0;
  let right = 0;
  const px = (value: string | undefined): number | null => {
    const match = /^([0-9]{1,5}(?:\.[0-9]{1,3})?)px$/.exec(value?.trim() ?? "");
    return match ? Number(match[1]) : value?.trim() === "0" ? 0 : null;
  };
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (property === "padding") {
      const parts = value.split(/\s+/).map(px);
      const [top, rightSide = top, , leftSide = rightSide] = parts;
      right = rightSide ?? 0;
      left = leftSide ?? 0;
    } else if (property === "padding-left") {
      left = px(value) ?? 0;
    } else if (property === "padding-right") {
      right = px(value) ?? 0;
    }
  }
  return left + right;
}

/** The tag again with one declaration added to its inline style. */
function withDeclaration(tag: string, style: string, declaration: string): string {
  if (style === "" && !/ style="/.test(tag)) {
    return `${tag.slice(0, -1)} style="${declaration}">`;
  }
  return tag.replace(
    ` style="${style}"`,
    ` style="${style === "" ? "" : `${style};`}${declaration}"`,
  );
}

function capResponsiveImagesAtDeclaredWidth(html: string): string {
  return html.replace(/<img ([^>]+)>/g, (tag, attributes: string) => {
    const declaredWidth = /(?:^| )width="([1-9][0-9]{0,5})"(?: |$)/.exec(
      attributes,
    )?.[1];
    const style = /(?:^| )style="([^"]*)"/.exec(attributes)?.[1];
    if (declaredWidth === undefined || style === undefined) return tag;

    const declarations = style.split(";");
    const responsiveWidth = declarations.findIndex(
      (declaration) => declaration.trim().toLowerCase() === "width:100%",
    );
    if (responsiveWidth === -1) return tag;

    declarations[responsiveWidth] = `width:${declaredWidth}px`;
    if (
      !declarations.some((declaration) =>
        declaration.trim().toLowerCase().startsWith("max-width:"),
      )
    ) {
      declarations.push("max-width:100%");
    }
    return tag.replace(
      `style="${style}"`,
      `style="${declarations.join(";")}"`,
    );
  });
}

function bindVerifiedRemoteImages(
  sanitizedHtml: string,
  sources: ReadonlyMap<string, string>,
): string {
  return sanitizedHtml.replace(
    /<img data-brain-remote-image="(remote-image-a[0-9a-f]{32})"((?: [a-z-]+="[^"]*")*)>/g,
    (_match, remoteImageId: string, attributes: string) => {
      const target = sources.get(remoteImageId);
      if (target && /^blob:[^\s<>"']{1,4096}$/.test(target)) {
        return `<img src="${escapeHtml(target)}"${attributes}>`;
      }
      return unavailableImageFallback(attributes);
    },
  );
}

/**
 * Stand-in for an image the frame cannot show. A sized image becomes a
 * same-sized neutral box so table layouts keep their shape. An unsized one
 * keeps its alt text on a single clipped line, never a one-glyph column.
 * Attribute values arrive already escaped by the sanitizer.
 */
function unavailableImageFallback(attributes: string): string {
  const alt = / alt="([^"]*)"/.exec(attributes)?.[1] ?? "";
  const style = / style="([^"]*)"/.exec(attributes)?.[1] ?? "";
  const width = declaredPixels(attributes, style, "width");
  const height = declaredPixels(attributes, style, "height");
  const label =
    alt.length > 0
      ? ` role="img" aria-label="${alt}" title="${alt}"`
      : ' aria-hidden="true"';
  if (width !== null && height !== null) {
    const block = /(?:^|;)display:block(?:;|$)/.test(style) ? "display:block;" : "";
    // The picture's own bound travels with it — the sender's `max-width`, or
    // the column bound a narrower box earned it — so the stand-in holds the
    // shape the picture would have had.
    const bound = style
      .split(";")
      .find((declaration) => /^max-width:/.test(declaration.trim()));
    const cap = bound === undefined ? "" : `;${bound.trim()}`;
    return `<span class="brain-mail-image-placeholder"${label} style="${block}width:${width}px;aspect-ratio:${width}/${height}${cap}"></span>`;
  }
  if (alt.length === 0) return "";
  return `<span class="brain-mail-image-alt" title="${alt}">${alt}</span>`;
}

/** A size declared in pixels — the attribute, or the inline style. */
function declaredPixels(
  attributes: string,
  style: string,
  axis: "width" | "height",
): number | null {
  const candidates = [
    ...style
      .split(";")
      .map((declaration) =>
        new RegExp(`^${axis}:([0-9]{1,5}(?:\\.[0-9]{1,3})?)px$`).exec(
          declaration.trim(),
        )?.[1],
      ),
    new RegExp(`(?:^| )${axis}="([0-9]{1,6})"(?: |$)`).exec(attributes)?.[1],
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function bindVerifiedCidImages(
  sanitizedHtml: string,
  attachments: readonly MailContentAttachmentDto[],
  sources: ReadonlyMap<string, string>,
): string {
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    if (attachment.contentId !== null) {
      counts.set(
        attachment.contentId,
        (counts.get(attachment.contentId) ?? 0) + 1,
      );
    }
  }
  const cidTargets = new Map<string, string | null>();
  for (const attachment of attachments) {
    if (
      attachment.contentId === null ||
      counts.get(attachment.contentId) !== 1 ||
      attachment.disposition !== "inline" ||
      !INLINE_RASTER_MIME_TYPES.has(attachment.mimeType) ||
      attachment.bytes > MAIL_INLINE_IMAGE_MAX_BYTES
    ) {
      continue;
    }
    const cid = escapeHtml(attachment.contentId);
    const target = sources.get(attachment.contentId);
    if (target === undefined || !/^blob:[^\s<>"']{1,4096}$/.test(target)) continue;
    cidTargets.set(cid, target);
  }
  return sanitizedHtml.replace(
    /<img data-brain-cid="([^"]+)"((?: [a-z-]+="[^"]*")*)>/g,
    (_match, cid: string, attributes: string) => {
      const target = cidTargets.get(cid);
      if (target) return `<img src="${escapeHtml(target)}"${attributes}>`;
      return unavailableImageFallback(attributes);
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
