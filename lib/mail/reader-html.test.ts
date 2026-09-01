// jsdom, because two of these tests ask which images a frame rule reaches.
// That is a selector-matching question, and the browser is the only honest
// answer to it.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import type { MailContentAttachmentDto } from "./content-types";
import { MAIL_INLINE_IMAGE_MAX_BYTES } from "./content-types";
import {
  createMailHtmlDocument,
  MAIL_READER_IFRAME_SANDBOX,
} from "./reader-html";
import { MAIL_RESOURCE_LIMITS } from "./security";
import { sanitizeMailHtmlWithRemoteImages } from "./service/mail-html-sanitizer";

describe("mail reader HTML document", () => {
  it("binds a verified CID only to the authenticated attachment proxy", () => {
    const document = createMailHtmlDocument({
      sanitizedHtml: [
        '<table style="width:100%"><tr><td>Newsletter</td></tr></table>',
        '<img data-brain-cid="logo@example.test" alt="Logo" style="width:120px">',
        '<img data-brain-cid="missing@example.test" alt="Missing">',
      ].join(""),
      attachments: [inlineAttachment()],
      cidSources: new Map([
        ["logo@example.test", "blob:https://brain.test/verified-logo"],
      ]),
    });

    expect(MAIL_READER_IFRAME_SANDBOX).toBe("allow-same-origin");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("img-src blob:");
    expect(document).toContain("style-src 'unsafe-inline'");
    expect(document).toContain(
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
    );
    expect(document).toContain('<main id="brain-mail-content">');
    expect(document).toContain(
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif',
    );
    const css = readFrameCss(document);

    // The frame clips sideways, so nothing may leave it unnoticed.
    expect(declaredOn(css, "body", "overflow-x")).toEqual({
      value: "hidden",
      important: false,
    });
    expect(declaredOn(css, "#brain-mail-content *", "box-sizing")).toEqual({
      value: "border-box",
      important: false,
    });
    expect(declaredOn(css, "#brain-mail-content p", "max-width")).toEqual({
      value: "100%",
      important: true,
    });
    // A cell is sized by its content, so a blanket max-width on cells would
    // fight the column model rather than contain anything.
    expect(declaredOn(css, "#brain-mail-content td", "max-width")).toBeNull();

    // Narrow widths: tables give up their pixel widths, and a cell the sender
    // froze is allowed to wrap so the row can fit.
    expect(
      declaredOn(
        css,
        '#brain-mail-content table:not([style*="display:inline-table"])',
        "width",
        "(max-width:600px)",
      ),
    ).toEqual({ value: "100%", important: true });
    expect(
      declaredOn(
        css,
        '#brain-mail-content td[style*="white-space:nowrap"]:not([align=right])',
        "white-space",
        "(max-width:600px)",
      ),
    ).toEqual({ value: "normal", important: true });

    // Right-aligned values are amounts and dates. They hold at every width, so
    // the rule may not live inside the narrow-width block.
    for (const [property, value] of [
      ["white-space", "nowrap"],
      ["overflow-wrap", "normal"],
      ["word-break", "normal"],
    ] as const) {
      expect(declaredOn(css, "#brain-mail-content td[align=right]", property)).toEqual({
        value,
        important: true,
      });
      expect(
        declaredOn(
          css,
          "#brain-mail-content td[align=right]",
          property,
          "(max-width:600px)",
        ),
      ).toBeNull();
    }
    expect(document).toContain(
      'src="blob:https://brain.test/verified-logo"',
    );
    expect(document).toContain('style="width:120px"');
    expect(document).toContain("Missing");
    expect(document).not.toContain("missing@example.test");
    expect(document).not.toContain("data-brain-cid");
  });

  it("floors a table column at its longest word and leaves the sender the last word", () => {
    const css = readFrameCss(
      createMailHtmlDocument({
        sanitizedHtml: "<table><tr><td>Status</td></tr></table>",
        attachments: [],
        cidSources: new Map(),
      }),
    );

    // Prose sits in a box the column already sized, so breaking a token
    // anywhere costs nothing there and keeps it off the clipped edge.
    expect(declaredOn(css, "#brain-mail-content", "overflow-wrap")).toEqual({
      value: "anywhere",
      important: false,
    });
    // A cell is a column. `anywhere` would also drop its min-content to one
    // glyph, and a short label next to a greedy sibling collapses to a stack of
    // single letters. `break-word` still breaks a word that cannot fit.
    for (const selector of [
      "#brain-mail-content td",
      "#brain-mail-content th",
    ]) {
      expect(declaredOn(css, selector, "overflow-wrap")).toEqual({
        value: "break-word",
        important: false,
      });
    }
    // Not important, so a sender who writes overflow-wrap or word-break on the
    // cell itself asked for that and still wins over this default.
    expect(
      declaredOn(css, "#brain-mail-content td", "overflow-wrap")?.important,
    ).toBe(false);

    // A token with nothing to break on still widens the message. It pans here
    // rather than disappearing past the clipped edge of the frame.
    expect(declaredOn(css, "#brain-mail-content", "overflow-x")).toEqual({
      value: "auto",
      important: false,
    });
    // Nothing scales the frame, so an origin for a transform that never
    // arrives only reads as a mechanism that exists.
    expect(declaredOn(css, "#brain-mail-content", "transform-origin")).toBeNull();
  });

  it("keeps responsive images within their sender-declared width", () => {
    const remoteImageId = `remote-image-a${"4".repeat(32)}`;
    const document = createMailHtmlDocument({
      sanitizedHtml: [
        `<img data-brain-remote-image="${remoteImageId}" alt="" width="58" style="display:block;height:auto;width:100%;font-size:13px">`,
        `<img data-brain-remote-image="${remoteImageId}" alt="" width="600" style="display:block;width:600px">`,
      ].join(""),
      attachments: [],
      cidSources: new Map(),
      remoteSources: new Map([
        [remoteImageId, "blob:https://brain.test/verified-remote-image"],
      ]),
    });

    expect(document).toContain(
      'width="58" style="display:block;height:auto;width:58px;font-size:13px;max-width:100%"',
    );
    expect(document).toContain(
      'width="600" style="display:block;width:600px"',
    );
  });

  it("keeps an image the sender sized by height alone at that height", () => {
    const css = readFrameCss(
      createMailHtmlDocument({
        sanitizedHtml: "",
        attachments: [],
        cidSources: new Map(),
      }),
    );

    // An image the frame is allowed to narrow has to give up the sender's
    // pixel height, or the new width holds the old height and it distorts.
    for (const shrinkable of [
      '<img alt="" width="600" height="400">',
      '<img alt="" width="600" style="height:400px">',
      '<img alt="" style="width:600px;height:400px">',
      '<img alt="" width="58" style="display:block;width:58px;max-width:100%">',
    ]) {
      expect(frameForces(css, shrinkable, "height"), shrinkable).toEqual({
        value: "auto",
        important: true,
      });
    }

    // Where height is the only dimension declared, it is the size. Forcing it
    // to auto leaves a replaced element with nothing declared on either axis,
    // and the raster then draws at its own pixels — a 2x asset at 2x.
    for (const heightOnly of [
      '<img alt="" height="24">',
      '<img alt="" style="height:24px">',
      '<img alt="" height="24" style="height:24px">',
      '<img alt="" height="24" style="max-width:400px">',
    ]) {
      expect(frameForces(css, heightOnly, "height"), heightOnly).toBeNull();
    }

    // Nothing stretches an image to fill the frame either.
    for (const image of [
      '<img alt="" height="24">',
      '<img alt="" width="600" height="400">',
    ]) {
      expect(frameForces(css, image, "width"), image).toBeNull();
    }
  });

  it("bounds a mail image by the box around it, and by the column only past that box", () => {
    const css = readFrameCss(
      createMailHtmlDocument({
        sanitizedHtml: "",
        attachments: [],
        cidSources: new Map(),
      }),
    );

    // The default is the containing block, as every mail client draws it. A
    // column bound on every sized image widened the commonest newsletter
    // shape — a hero in a padded cell — past its cell, and the message panned
    // by the padding.
    for (const sized of [
      '<img alt="" width="48" height="48">',
      '<img alt="" width="16" height="16" style="width:16px;height:16px">',
      '<img alt="" style="display:block;width:101px;height:37px">',
      '<img alt="">',
      '<img alt="" style="display:block">',
    ]) {
      expect(frameForces(css, sized, "max-width"), sized).toEqual({
        value: "100%",
        important: false,
      });
    }

    // Sized by height alone, `100%` of a cell narrower than the ratio wants
    // is a picture squeezed to that cell at full height. The column is the
    // one bound with nothing nearer to it: the frame is the column, and the
    // unit reads its content box from inside, scrollbar and gutter excluded.
    expect(
      declaredOn(css, "#brain-mail-content", "container-type"),
    ).toEqual({ value: "inline-size", important: false });
    for (const tall of [
      '<img alt="" height="25">',
      '<img alt="" style="display:inline-block;height:25px">',
    ]) {
      expect(frameForces(css, tall, "max-width"), tall).toEqual({
        value: "100cqw",
        important: false,
      });
    }

    // A stand-in for an image the frame cannot show takes the same default
    // and carries whatever the picture itself was given (below).
    expect(
      frameForces(
        css,
        '<span class="brain-mail-image-placeholder" style="width:48px;aspect-ratio:48/48"></span>',
        "max-width",
      ),
    ).toEqual({ value: "100%", important: false });
  });

  it("lets a picture past a box its sender declared narrower than it", () => {
    const remoteImageId = `remote-image-a${"c".repeat(32)}`;
    const build = (sanitizedHtml: string, bound = true) =>
      createMailHtmlDocument({
        sanitizedHtml,
        attachments: [],
        cidSources: new Map(),
        remoteSources: new Map(
          bound
            ? [[remoteImageId, "blob:https://brain.test/verified-picture"]]
            : [],
        ),
      });
    const image = (attributes: string) =>
      `<img data-brain-remote-image="${remoteImageId}" alt="" ${attributes}>`;

    // The overflow badge: 16px of picture in a cell declared 8px wide. The
    // sender means it to overflow and every other client draws it. The cell
    // is narrower than the picture, so the picture is bound by the column
    // instead, and the cell is given the box model its width was written in.
    expect(
      build(
        `<td width="8" style="width:8px;padding-right:4px">${image(
          'width="16" height="16" style="display:block;height:16px;width:16px"',
        )}</td>`,
      ),
    ).toContain(
      '<td width="8" style="width:8px;padding-right:4px;box-sizing:content-box"><img src="blob:https://brain.test/verified-picture" alt="" width="16" height="16" style="display:block;height:16px;width:16px;max-width:100cqw"></td>',
    );

    // The job-card logo: 48px in a cell declared 48px with 8px of padding.
    // Email writes a cell's width for its content box, so the cell is not
    // narrower than the picture once it is read that way — the picture stays
    // bound by the cell and the cell widens to carry it plus the padding.
    expect(
      build(
        `<td width="48" style="width:48px;padding-right:8px"><a style="display:inline-block">${image(
          'width="48" height="48" style="display:inline-block;height:48px;width:48px"',
        )}</a></td>`,
      ),
    ).toContain(
      '<td width="48" style="width:48px;padding-right:8px;box-sizing:content-box"><a style="display:inline-block"><img src="blob:https://brain.test/verified-picture" alt="" width="48" height="48" style="display:inline-block;height:48px;width:48px"></a></td>',
    );

    // The wordmark: 101px inside the sender's own 84px anchor. Same shape,
    // not a cell — the box keeps the reset's border box, so its padding is
    // taken off before it is compared.
    expect(
      build(
        `<a style="display:inline-block;width:84px">${image(
          'width="101" height="37" style="height:37px;width:101px"',
        )}</a>`,
      ),
    ).toContain('style="height:37px;width:101px;max-width:100cqw"');
    expect(
      build(
        `<div style="width:48px;padding:0 8px 0 0">${image('width="48"')}</div>`,
      ),
    ).toContain('<img src="blob:https://brain.test/verified-picture" alt="" width="48" style="max-width:100cqw">');

    // A hero in a padded cell with no declared width is the commonest shape
    // in a newsletter, and nothing here touches it: the cell bounds it.
    const hero = build(
      `<td style="padding:16px">${image('width="600" style="display:block"')}</td>`,
    );
    expect(hero).toContain(
      '<td style="padding:16px"><img src="blob:https://brain.test/verified-picture" alt="" width="600" style="display:block"></td>',
    );
    // Nor a cell declared wide enough, in pixels or as a share of the table.
    expect(
      build(`<td width="600">${image('width="600" style="display:block"')}</td>`),
    ).toContain('<td width="600" style="box-sizing:content-box"><img src="blob:https://brain.test/verified-picture" alt="" width="600" style="display:block"></td>');
    expect(
      build(`<td width="50%" style="padding:16px">${image('width="600"')}</td>`),
    ).toContain('<td width="50%" style="padding:16px"><img src="blob:https://brain.test/verified-picture" alt="" width="600"></td>');

    // A sender who writes `max-width` on the picture asked for that bound
    // and keeps it, in either spelling.
    expect(
      build(
        `<a style="width:84px">${image('width="101" style="width:101px;max-width:100%"')}</a>`,
      ),
    ).toContain('style="width:101px;max-width:100%"><');
    expect(
      build(`<td width="300">${image('width="600" style="width:100%"')}</td>`),
    ).toContain('style="width:600px;max-width:100%"><');

    // The stand-in for a picture the frame cannot show holds the shape the
    // picture would have had, past the same box.
    expect(
      build(
        `<td width="8" style="width:8px;padding-right:4px">${image(
          'width="16" height="16" style="display:block;height:16px;width:16px"',
        )}</td>`,
        false,
      ),
    ).toContain(
      '<span class="brain-mail-image-placeholder" aria-hidden="true" style="display:block;width:16px;aspect-ratio:16/16;max-width:100cqw"></span>',
    );
  });

  it("takes a declared width to be the picture, not the picture less its padding", () => {
    const css = readFrameCss(
      createMailHtmlDocument({
        sanitizedHtml: "",
        attachments: [],
        cidSources: new Map(),
      }),
    );

    // Every element in the message is put in the border box, which is right for
    // the sender's containers and wrong for a replaced element: a store
    // badge written `width:120px;padding-right:8px` drew its picture at 112,
    // and an avatar with a 2px ring loses the ring on the same reasoning.
    expect(declaredOn(css, "#brain-mail-content *", "box-sizing")).toEqual({
      value: "border-box",
      important: false,
    });
    for (const padded of [
      '<img alt="" width="120" height="40" style="width:120px;padding-right:8px">',
      '<img alt="" height="24" style="width:24px;height:24px;border:2px solid white">',
    ]) {
      expect(frameForces(css, padded, "box-sizing"), padded).toEqual({
        value: "content-box",
        important: false,
      });
    }
  });

  it("reads a declared width in the spelling the sanitizer emits", () => {
    // The frame asks the style string whether the sender declared a width at
    // all. That holds only because the sanitizer rewrites every style into one
    // `property:value` per `;` — the sender's own spelling never arrives.
    const remoteImageId = `remote-image-a${"b".repeat(32)}`;
    const sanitized = sanitizeMailHtmlWithRemoteImages(
      '<img src="https://images.example.com/hero.png" WIDTH="600" STYLE="Display: Block ; Width: 600PX !important ; Height : 400px">',
      {
        maxCharacters: MAIL_RESOURCE_LIMITS.htmlCharacters,
        maxNodes: MAIL_RESOURCE_LIMITS.maxDomNodes,
        maxAttributes: MAIL_RESOURCE_LIMITS.maxDomAttributes,
        maxRemoteImages: MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
      },
      () => remoteImageId,
    ).html;

    expect(sanitized).toContain(
      'width="600" style="display:block;width:600px;height:400px"',
    );

    const document = createMailHtmlDocument({
      sanitizedHtml: sanitized ?? "",
      attachments: [],
      cidSources: new Map(),
      remoteSources: new Map([
        [remoteImageId, "blob:https://brain.test/verified-hero"],
      ]),
    });
    const image = /<img [^>]*>/.exec(document)?.[0] ?? "";
    expect(frameForces(readFrameCss(document), image, "height")).toEqual({
      value: "auto",
      important: true,
    });
  });

  it("replaces a sized unavailable image with a same-sized placeholder box", () => {
    const pending = `remote-image-a${"7".repeat(32)}`;
    const document = createMailHtmlDocument({
      sanitizedHtml: [
        '<table><tr><td width="40">',
        `<img data-brain-remote-image="${pending}" alt="Blurred profile image" width="40" height="40" style="display:block;border:none">`,
        "</td></tr></table>",
        '<img data-brain-cid="banner@example.test" alt="Banner &quot;Q3&quot;" width="100%" style="width:120.5px;height:30px">',
        '<img data-brain-cid="spacer@example.test" alt="" width="8" height="8">',
      ].join(""),
      attachments: [],
      cidSources: new Map(),
      remoteSources: new Map(),
    });

    expect(document).toContain(
      '<td width="40" style="box-sizing:content-box"><span class="brain-mail-image-placeholder" role="img" aria-label="Blurred profile image" title="Blurred profile image" style="display:block;width:40px;aspect-ratio:40/40"></span></td>',
    );
    expect(document).toContain(
      '<span class="brain-mail-image-placeholder" role="img" aria-label="Banner &quot;Q3&quot;" title="Banner &quot;Q3&quot;" style="width:120.5px;aspect-ratio:120.5/30"></span>',
    );
    expect(document).toContain(
      '<span class="brain-mail-image-placeholder" aria-hidden="true" style="width:8px;aspect-ratio:8/8"></span>',
    );
    const textContent = document.replace(/<[^>]*>/g, "");
    expect(textContent).not.toContain("Blurred profile image");
    expect(textContent).not.toContain("Banner");
    const placeholderCss = readFrameCss(document);
    for (const [property, value] of [
      ["display", "inline-block"],
      ["height", "auto"],
      ["vertical-align", "top"],
    ] as const) {
      expect(
        declaredOn(
          placeholderCss,
          "#brain-mail-content .brain-mail-image-placeholder",
          property,
        ),
      ).toEqual({ value, important: false });
    }
    expect(document).not.toContain("data-brain-remote-image");
    expect(document).not.toContain("data-brain-cid");
  });

  it("keeps alt text of an unsized unavailable image on one clipped line", () => {
    const unsized = `remote-image-a${"9".repeat(32)}`;
    const widthOnly = `remote-image-a${"a".repeat(32)}`;
    const document = createMailHtmlDocument({
      sanitizedHtml: [
        `<img data-brain-remote-image="${unsized}" alt="Campaign hero">`,
        `<img data-brain-remote-image="${widthOnly}" alt="Wide banner" width="600" style="width:100%;height:auto">`,
        '<img data-brain-cid="silent@example.test" alt="">',
      ].join(""),
      attachments: [],
      cidSources: new Map(),
      remoteSources: new Map(),
    });

    expect(document).toContain(
      '<span class="brain-mail-image-alt" title="Campaign hero">Campaign hero</span>',
    );
    expect(document).toContain(
      '<span class="brain-mail-image-alt" title="Wide banner">Wide banner</span>',
    );
    expect(document).not.toContain("brain-mail-image-placeholder\"");
    expect(document).not.toContain('title=""');
    expect(document).toContain(
      "#brain-mail-content .brain-mail-image-alt{display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:top}",
    );
  });

  it("fails closed for duplicate, non-raster, and non-inline CID metadata", () => {
    const attachment = inlineAttachment();
    const document = createMailHtmlDocument({
      sanitizedHtml: [
        '<img data-brain-cid="logo@example.test" alt="Blocked">',
        '<img data-brain-cid="oversized@example.test" alt="Oversized">',
      ].join(""),
      attachments: [
        attachment,
        { ...attachment, attachmentId: `attachment-a${"3".repeat(32)}` },
        { ...attachment, mimeType: "image/svg+xml" },
        { ...attachment, disposition: "attachment" },
        {
          ...attachment,
          attachmentId: `attachment-a${"4".repeat(32)}`,
          contentId: "oversized@example.test",
          bytes: MAIL_INLINE_IMAGE_MAX_BYTES + 1,
        },
      ],
      cidSources: new Map([
        ["logo@example.test", "blob:https://brain.test/duplicate"],
        ["oversized@example.test", "blob:https://brain.test/oversized"],
      ]),
    });

    expect(document).toContain("Blocked");
    expect(document).toContain("Oversized");
    expect(document).not.toContain("blob:https://brain.test/oversized");
    expect(document).not.toContain("blob:https://brain.test/duplicate");
    expect(document).not.toContain("/api/mail/attachments/");
  });

  it("matches an HTML-escaped CID attribute to the raw attachment identifier", () => {
    const contentId = "logo&brand@example.test";
    const document = createMailHtmlDocument({
      sanitizedHtml:
        '<img data-brain-cid="logo&amp;brand@example.test" alt="Brand">',
      attachments: [{ ...inlineAttachment(), contentId }],
      cidSources: new Map([
        [contentId, "blob:https://brain.test/escaped-cid"],
      ]),
    });

    expect(document).toContain('src="blob:https://brain.test/escaped-cid"');
    expect(document).not.toContain("data-brain-cid");
  });

  it("binds an opaque remote image only to an already verified blob URL", () => {
    const remoteImageId = `remote-image-a${"5".repeat(32)}`;
    const sourceUrl = "https://images.example.com/private-campaign.png";
    const document = createMailHtmlDocument({
      sanitizedHtml: [
        `<img data-brain-remote-image="${remoteImageId}" alt="Campaign">`,
        `<img data-brain-remote-image="remote-image-a${"6".repeat(32)}" alt="Missing">`,
      ].join(""),
      attachments: [],
      cidSources: new Map(),
      remoteSources: new Map([
        [remoteImageId, "blob:https://brain.test/verified-remote"],
      ]),
    });

    expect(document).toContain('src="blob:https://brain.test/verified-remote"');
    expect(document).toContain("Missing");
    expect(document).not.toContain("data-brain-remote-image");
    expect(document).not.toContain(sourceUrl);
    expect(document).not.toContain("images.example.com");
  });
});

interface FrameCssRule {
  readonly media: string | null;
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, CssDeclaration>;
}

interface CssDeclaration {
  readonly value: string;
  readonly important: boolean;
}

/**
 * Reads the frame's stylesheet as rules rather than as one string, so a test
 * can ask what a selector declares instead of pinning how it was written.
 */
function readFrameCss(document: string): readonly FrameCssRule[] {
  const style = /<style>([\s\S]*?)<\/style>/.exec(document)?.[1];
  expect(style).toBeDefined();
  return readBlock(style ?? "", null);
}

function readBlock(css: string, media: string | null): FrameCssRule[] {
  const rules: FrameCssRule[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) break;
    const prelude = css.slice(cursor, open).trim();
    let depth = 1;
    let scan = open + 1;
    while (scan < css.length && depth > 0) {
      if (css[scan] === "{") depth++;
      if (css[scan] === "}") depth--;
      scan++;
    }
    const body = css.slice(open + 1, scan - 1);
    if (prelude.startsWith("@media")) {
      rules.push(...readBlock(body, prelude.slice("@media".length).trim()));
    } else {
      rules.push({
        media,
        selectors: prelude.split(",").map((selector) => selector.trim()),
        declarations: readDeclarations(body),
      });
    }
    cursor = scan;
  }
  return rules;
}

function readDeclarations(body: string): Map<string, CssDeclaration> {
  const declarations = new Map<string, CssDeclaration>();
  for (const raw of body.split(";")) {
    const separator = raw.indexOf(":");
    if (separator < 1) continue;
    const property = raw.slice(0, separator).trim();
    const rest = raw.slice(separator + 1).trim();
    const important = rest.endsWith("!important");
    declarations.set(property, {
      value: important ? rest.slice(0, -"!important".length).trim() : rest,
      important,
    });
  }
  return declarations;
}

/**
 * What the frame's stylesheet forces on this element. The frame carries no
 * other cascade, so "does a rule declaring `property` match this element" is
 * the behaviour a reader sees — independent of how the selector is written.
 */
function frameForces(
  css: readonly FrameCssRule[],
  elementHtml: string,
  property: string,
  media: string | null = null,
): CssDeclaration | null {
  const host = window.document.createElement("main");
  host.id = "brain-mail-content";
  host.innerHTML = elementHtml;
  window.document.body.append(host);
  try {
    const element = host.firstElementChild;
    expect(element, elementHtml).not.toBeNull();
    let found: CssDeclaration | null = null;
    for (const rule of css) {
      if (rule.media !== media) continue;
      const declaration = rule.declarations.get(property);
      if (declaration === undefined) continue;
      if (!rule.selectors.some((selector) => element!.matches(selector))) continue;
      if (found?.important && !declaration.important) continue;
      found = declaration;
    }
    return found;
  } finally {
    host.remove();
  }
}

/** The last declaration of `property` for exactly this selector, or null. */
function declaredOn(
  css: readonly FrameCssRule[],
  selector: string,
  property: string,
  media: string | null = null,
): CssDeclaration | null {
  let found: CssDeclaration | null = null;
  for (const rule of css) {
    if (rule.media !== media) continue;
    if (!rule.selectors.includes(selector)) continue;
    found = rule.declarations.get(property) ?? found;
  }
  return found;
}

function inlineAttachment(): MailContentAttachmentDto {
  return {
    attachmentId: `attachment-a${"2".repeat(32)}`,
    filename: "logo.png",
    mimeType: "image/png",
    disposition: "inline",
    contentId: "logo@example.test",
    bytes: 64,
  };
}
