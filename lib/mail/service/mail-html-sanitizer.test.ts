import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it } from "vitest";

import { MAIL_RESOURCE_LIMITS } from "../security";
import {
  sanitizeMailHtml,
  sanitizeMailHtmlWithRemoteImages,
} from "./mail-html-sanitizer";

const BUDGET = Object.freeze({
  maxCharacters: 100_000,
  maxNodes: 1_000,
  maxAttributes: 4_000,
  maxRemoteImages: 32,
});
/** The budget the MIME worker gives every message. */
const MESSAGE_BUDGET = Object.freeze({
  maxCharacters: MAIL_RESOURCE_LIMITS.htmlCharacters,
  maxNodes: MAIL_RESOURCE_LIMITS.maxDomNodes,
  maxAttributes: MAIL_RESOURCE_LIMITS.maxDomAttributes,
  maxRemoteImages: MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
});

type TreeNode = DefaultTreeAdapterMap["childNode"];
type TreeElement = DefaultTreeAdapterMap["element"];

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const EMITTED_TAGS = new Set([
  "a", "b", "blockquote", "br", "center", "code", "del", "div", "em", "h1",
  "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s",
  "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "u", "ul",
]);
const EMITTED_ATTRIBUTES = new Set([
  "align", "alt", "border", "cellpadding", "cellspacing", "colspan",
  "data-brain-cid", "data-brain-href", "data-brain-remote-image", "dir",
  "height", "rowspan", "style", "valign", "width",
]);

/** The body a browser builds from a whole document, as the frame parses it. */
function browserBody(html: string): TreeElement {
  const root = parse(html).childNodes.find(
    (node): node is TreeElement => node.nodeName === "html",
  );
  const body = root?.childNodes.find(
    (node): node is TreeElement => node.nodeName === "body",
  );
  if (body === undefined) throw new Error("the parser built no body");
  return body;
}

/** The reader frame's own document around the sanitized markup. */
function frameBody(sanitized: string | null): TreeElement {
  return browserBody(`<!doctype html><html><head></head><body>${sanitized ?? ""}</body></html>`);
}

/** Element nesting and text, which is what the layout is made of. */
function nesting(nodes: readonly TreeNode[]): string {
  return nodes
    .map((node) => {
      if (node.nodeName === "#text") {
        return JSON.stringify((node as DefaultTreeAdapterMap["textNode"]).value);
      }
      if (!("tagName" in node)) return "";
      return `${node.tagName}(${nesting(node.childNodes)})`;
    })
    .filter((part) => part.length > 0)
    .join(",");
}

/** Every namespace, name, attribute and text, so a re-parse cannot hide a change. */
function everything(nodes: readonly TreeNode[]): string {
  return nodes
    .map((node) => {
      if (node.nodeName === "#text") {
        return JSON.stringify((node as DefaultTreeAdapterMap["textNode"]).value);
      }
      if (!("tagName" in node)) return `#${node.nodeName}`;
      const attributes = node.attrs
        .map(({ name, value }) => `${name}=${JSON.stringify(value)}`)
        .join(" ");
      return `${node.namespaceURI}:${node.tagName}[${attributes}](${everything(node.childNodes)})`;
    })
    .join(",");
}

function descendants(nodes: readonly TreeNode[]): TreeElement[] {
  return nodes.flatMap((node) =>
    "tagName" in node ? [node, ...descendants(node.childNodes)] : [],
  );
}

function limitCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return "no error";
}

describe("mail HTML sanitizer", () => {
  it("drops document metadata instead of leaking the subject into the message body", () => {
    const sanitized = sanitizeMailHtml(
      [
        "<!doctype html><html><head>",
        "<title>3 animation rules you can apply today</title>",
        "<style>body{font-size:99px}</style>",
        "<template>Hidden template copy</template>",
        "</head><body>",
        '<div style="font-family:Inter,ui-sans-serif,sans-serif;font-size:16px;line-height:29px">',
        "People often think you need to have that thing.",
        "</div></body></html>",
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toBe(
      '<div style="font-family:Inter,ui-sans-serif,sans-serif;font-size:16px;line-height:29px">People often think you need to have that thing.</div>',
    );
    expect(sanitized).not.toMatch(
      /3 animation rules|font-size:99px|Hidden template copy/,
    );
  });

  it("keeps bounded newsletter layout styles without retaining network CSS", () => {
    const sanitized = sanitizeMailHtml(
      [
        '<table width="100%" cellpadding="12" cellspacing="0" bgcolor="#fff"',
        ' style="max-width:640px;margin:0 auto;border-collapse:collapse;',
        'background-image:url(https://tracker.test/pixel);position:fixed">',
        '<tr><td style="padding:16px;text-align:center;color:#222;font-size:16px">',
        "Newsletter",
        "</td></tr></table>",
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toContain('width="100%"');
    expect(sanitized).toContain('cellpadding="12"');
    expect(sanitized).toContain(
      'style="max-width:640px;margin:0 auto;border-collapse:collapse;background-color:#fff"',
    );
    expect(sanitized).toContain(
      'style="padding:16px;text-align:center;color:#222;font-size:16px"',
    );
    expect(sanitized).not.toMatch(/tracker|url\(|background-image|position/i);
  });

  it("keeps preheader hiding styles so preview text never renders as a column", () => {
    const sanitized = sanitizeMailHtml(
      [
        '<div style="font-size:0;line-height:1px;color:transparent;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">',
        "Preview copy meant for the inbox list only",
        "</div>",
        '<div style="visibility:hidden;overflow-x:auto;overflow-y:scroll;opacity:.5">Half</div>',
        '<span style="opacity:50%;overflow:clip">Percent</span>',
        '<p style="opacity:2;opacity:-1;opacity:1e3;opacity:url(https://evil.test);overflow:inherit;overflow:url(https://evil.test);visibility:initial;overflow-x:hidden url(https://evil.test)">Rejected</p>',
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toContain(
      '<div style="font-size:0;line-height:1px;color:transparent;max-height:0;max-width:0;opacity:0;overflow:hidden">',
    );
    expect(sanitized).toContain(
      '<div style="visibility:hidden;overflow-x:auto;overflow-y:scroll;opacity:.5">Half</div>',
    );
    expect(sanitized).toContain(
      '<span style="opacity:50%;overflow:clip">Percent</span>',
    );
    expect(sanitized).toContain("<p>Rejected</p>");
    expect(sanitized).not.toMatch(/mso-hide|inherit|initial|evil|url\(/);
  });

  it("keeps hidden tracking images suppressed after the hiding styles became allowed", () => {
    let sequence = 0;
    const result = sanitizeMailHtmlWithRemoteImages(
      [
        '<img style="opacity:0" src="https://hidden.example.test/opacity.png" alt="Opacity pixel">',
        '<img style="visibility:hidden" src="https://hidden.example.test/visibility.png" alt="Visibility pixel">',
        '<img style="overflow:hidden;width:1px;height:1px" src="https://hidden.example.test/overflow.png" alt="Overflow pixel">',
        '<div style="overflow:hidden;width:0"><img width="600" height="400" src="https://visible.example.test/clipped-layout.png" alt="Clipped layout"></div>',
      ].join(""),
      BUDGET,
      () => `remote-image-a${String(++sequence).padStart(32, "0")}`,
    );

    expect(result.remoteImages).toEqual([
      {
        remoteImageId: `remote-image-a${"0".repeat(31)}1`,
        sourceUrl: "https://visible.example.test/clipped-layout.png",
      },
    ]);
    expect(result.html?.match(/data-brain-remote-image=/g)).toHaveLength(1);
    expect(result.html).toContain('<div style="overflow:hidden;width:0">');
    expect(result.html).toContain("Opacity pixel");
    expect(result.html).toContain("Visibility pixel");
    expect(result.html).toContain("Overflow pixel");
    expect(result.html).not.toMatch(/https:\/\/|hidden\.example|visible\.example/);
  });

  it("keeps inline email tables on one row", () => {
    const sanitized = sanitizeMailHtml(
      [
        '<table style="display:inline-table;float:none;width:32px">',
        '<tr><td><img src="cid:social@example.test" alt="Social"></td></tr>',
        "</table>",
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toContain(
      'style="display:inline-table;float:none;width:32px"',
    );
  });

  it("removes active content, remote loads, forms, and obfuscated CSS", () => {
    const sanitized = sanitizeMailHtml(
      [
        '<script>fetch("https://evil.test")</script>',
        '<form action="https://evil.test"><input name="secret"><p>Visible copy</p></form>',
        '<img src="https://tracker.test/pixel" alt="remote">',
        '<img src="cid:logo@example.test" onerror="steal()"',
        ' style="width:120px;background:u\\72l(https://evil.test)">',
        '<a href="javascript:steal()" ping="https://tracker.test">bad</a>',
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toContain("Visible copy");
    expect(sanitized).toContain("remote");
    expect(sanitized).toContain(
      '<img data-brain-cid="logo@example.test" alt="" style="width:120px">',
    );
    expect(sanitized).not.toMatch(
      /script|form|input|onerror|javascript:|https:\/\/|ping=|u\\72l/i,
    );
  });

  it("separates HTTPS image URLs from opaque iframe identifiers", () => {
    let sequence = 0;
    const result = sanitizeMailHtmlWithRemoteImages(
      [
        '<img src="https://images.example.test/banner.png?campaign=one#fragment" alt="Banner">',
        '<img src="https://images.example.test/banner.png?campaign=one" alt="Again">',
        '<img src="//cdn.example.test/photo.jpg" alt="Photo">',
        '<img src="https://user:secret@images.example.test/credential.png" alt="Credential">',
        '<img src="http://images.example.test/plain.png" alt="Plain">',
        '<img src="https://127.0.0.1/internal.png" alt="Internal">',
        '<img src="https://localhost/local.png" alt="Local">',
        '<img src="https://tracker.example.test/open.gif" width="1" height="1" alt="Pixel">',
        '<img src="https://tracker.example.test/css.gif" style="width:1px;height:1px" alt="CSS Pixel">',
        '<img src="https://tracker.example.test/hidden.gif" style="display:none" alt="Hidden">',
      ].join(""),
      { ...BUDGET, maxRemoteImages: 2 },
      () => `remote-image-a${String(++sequence).padStart(32, "0")}`,
    );

    expect(result.remoteImages).toEqual([
      {
        remoteImageId: `remote-image-a${"0".repeat(31)}1`,
        sourceUrl: "https://images.example.test/banner.png?campaign=one",
      },
      {
        remoteImageId: `remote-image-a${"0".repeat(31)}2`,
        sourceUrl: "https://cdn.example.test/photo.jpg",
      },
    ]);
    expect(result.html).toContain(
      `data-brain-remote-image="remote-image-a${"0".repeat(31)}1"`,
    );
    expect(result.html?.match(/data-brain-remote-image=/g)).toHaveLength(3);
    expect(result.html).toContain("Credential");
    expect(result.html).toContain("Plain");
    expect(result.html).toContain("Internal");
    expect(result.html).toContain("Local");
    expect(result.html).toContain("Pixel");
    expect(result.html).toContain("CSS Pixel");
    expect(result.html).toContain("Hidden");
    expect(result.html).not.toMatch(
      /images\.example|cdn\.example|tracker\.example|127\.0\.0\.1|localhost|secret/,
    );
  });

  it("does not allocate remote images hidden by their own or ancestor attributes and styles", () => {
    let sequence = 0;
    const result = sanitizeMailHtmlWithRemoteImages(
      [
        '<img hidden src="https://hidden.example.test/own-hidden.png" alt="Own hidden">',
        '<img aria-hidden=" TRUE " src="https://hidden.example.test/own-aria.png" alt="Own aria">',
        '<div hidden><img width="600" height="400" src="https://hidden.example.test/ancestor-hidden.png" alt="Ancestor hidden"></div>',
        '<section aria-hidden="true"><img src="https://hidden.example.test/unknown-ancestor.png" alt="Unknown ancestor"></section>',
        '<div style="DISPLAY:/**/none ! important"><img src="https://hidden.example.test/display.png" alt="Display hidden"></div>',
        '<div style="visibility:hidden"><img src="https://hidden.example.test/visibility.png" alt="Visibility hidden"></div>',
        '<div style="visibility:collapse"><img src="https://hidden.example.test/collapse.png" alt="Visibility collapse"></div>',
        '<div style="content-visibility: hidden"><img src="https://hidden.example.test/content-visibility.png" alt="Content hidden"></div>',
        '<div style="opacity:.0"><img src="https://hidden.example.test/opacity-number.png" alt="Opacity number"></div>',
        '<div style="opacity:0%"><img src="https://hidden.example.test/opacity-percent.png" alt="Opacity percent"></div>',
        '<div hidden><wbr><img src="https://hidden.example.test/after-void.png" alt="After void hidden"></div>',
        '<img src="https://visible.example.test/after-hidden.png" alt="Visible after hidden">',
      ].join(""),
      BUDGET,
      () => `remote-image-a${String(++sequence).padStart(32, "0")}`,
    );

    expect(result.remoteImages).toEqual([
      {
        remoteImageId: `remote-image-a${"0".repeat(31)}1`,
        sourceUrl: "https://visible.example.test/after-hidden.png",
      },
    ]);
    expect(result.html?.match(/data-brain-remote-image=/g)).toHaveLength(1);
    expect(result.html).toContain("Visible after hidden");
    expect(result.html).not.toMatch(
      /https:\/\/|hidden\.example|visible\.example|own-hidden|own-aria|ancestor-hidden|unknown-ancestor|opacity-number/,
    );
  });

  it("does not allocate remote images constrained to tracking-pixel dimensions", () => {
    let sequence = 0;
    const result = sanitizeMailHtmlWithRemoteImages(
      [
        '<img width="2" height="1" src="https://pixel.example.test/attributes.gif" alt="Attribute pixel">',
        '<img style="width:0;height:auto" src="https://pixel.example.test/zero-width.gif" alt="Zero width">',
        '<img style="height:0;width:auto" src="https://pixel.example.test/zero-height.gif" alt="Zero height">',
        '<img style="max-width:0" src="https://pixel.example.test/zero-max-width.gif" alt="Zero maximum width">',
        '<img style="width:0%" src="https://pixel.example.test/zero-percent.gif" alt="Zero percent width">',
        '<img style="max-height:0rem" src="https://pixel.example.test/zero-rem.gif" alt="Zero rem height">',
        '<img width="1" src="https://pixel.example.test/implicit-height.gif" alt="Implicit small height">',
        '<img style="width:1px;height:auto" src="https://pixel.example.test/auto-height.gif" alt="Automatic small height">',
        '<img style="max-width:1px" src="https://pixel.example.test/implicit-max-height.gif" alt="Implicit maximum height">',
        '<img height="1" src="https://pixel.example.test/implicit-width.gif" alt="Implicit small width">',
        '<img style="height:1px;width:auto" src="https://pixel.example.test/auto-width.gif" alt="Automatic small width">',
        '<img style="max-height:1px" src="https://pixel.example.test/implicit-max-width.gif" alt="Implicit maximum width">',
        '<img style="max-width:1px;max-height:2px" src="https://pixel.example.test/max-size.gif" alt="Maximum pixel">',
        '<img width="600" style="max-width:2px;height:1px" src="https://pixel.example.test/mixed-size.gif" alt="Mixed pixel">',
        '<div style="width:2px;max-height:2px"><img width="600" height="400" src="https://pixel.example.test/allowed-ancestor.gif" alt="Allowed ancestor pixel"></div>',
        '<section width="1px" style="max-height:.5px"><img src="https://pixel.example.test/unknown-ancestor.gif" alt="Unknown ancestor pixel"></section>',
        '<div style="max-width:1px;max-height:1px"><br><wbr><img src="https://pixel.example.test/after-void.gif" alt="Void pixel"></div>',
        '<table><tr><th style="width:600px;height:0"><img width="600" src="https://visible.example.test/zero-height-layout.png" alt="Visible zero-height layout"></th></tr></table>',
        '<img style="max-width:1px;height:400px" src="https://visible.example.test/one-small-axis.png" alt="One small axis">',
        '<img width="3" height="2" src="https://visible.example.test/three-by-two.png" alt="Three by two">',
        '<img style="width:1px;width:600px;height:1px;height:400px" src="https://visible.example.test/overridden.png" alt="Overridden size">',
        '<img style="width:600px!important;width:1px;height:400px!important;height:1px" src="https://visible.example.test/important.png" alt="Important visible size">',
        '<img style="width:600px;width:1px!important;height:400px;height:1px!important" src="https://pixel.example.test/important-small.gif" alt="Important small size">',
        '<img src="https://visible.example.test/after-small-ancestor.png" alt="Visible after small ancestor">',
      ].join(""),
      BUDGET,
      () => `remote-image-a${String(++sequence).padStart(32, "0")}`,
    );

    expect(result.remoteImages.map(({ sourceUrl }) => sourceUrl)).toEqual([
      "https://visible.example.test/zero-height-layout.png",
      "https://visible.example.test/one-small-axis.png",
      "https://visible.example.test/three-by-two.png",
      "https://visible.example.test/overridden.png",
      "https://visible.example.test/important.png",
      "https://visible.example.test/after-small-ancestor.png",
    ]);
    expect(result.html?.match(/data-brain-remote-image=/g)).toHaveLength(6);
    expect(result.html).toContain("style=\"width:600px;height:400px\"");
    expect(result.html).toContain("Visible after small ancestor");
    expect(result.html).not.toMatch(
      /https:\/\/|pixel\.example|visible\.example|attributes\.gif|max-size\.gif|mixed-size\.gif|unknown-ancestor\.gif/,
    );
  });

  it("keeps the layout a browser builds from malformed table markup", () => {
    // Synthetic, in the shape bulk mail breaks: every pattern below makes a
    // browser repair the markup, and the reader frame renders what we send.
    const letter = [
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
      "<html><head><style>.hero{width:600px}</style></head><body>",
      // A row opened straight inside a cell, then the author's closing tags.
      '<table width="600"><tr><td><table><tr><td><tr><td>Headline</td></tr></td></tr></table>Beside the headline</td><td>Side column</td></tr></table>',
      // A stray `</td>` inside a nested table.
      "<table><tr><td><table><tr><td>Feature one</td></td><td>Feature two</td></tr></table>After the features</td><td>Second column</td></tr></table>",
      // A table inside a paragraph, and the paragraph's end tag in a cell.
      "<p><span>Intro<table><tr><td>Inside the paragraph</p>After the paragraph</td></tr></table>",
      // A cell left open when its table ends.
      "<table><tr><td><table><tr><td>Open cell<td>Next cell</table>Outer cell</td><td>Last column</td></tr></table>",
      // The first newline after `<pre>` is the parser's, the second is text.
      "<pre>\n\nIndented after a blank line</pre>",
      "</body></html>",
    ].join("");

    const sanitized = sanitizeMailHtml(letter, BUDGET);

    expect(nesting(frameBody(sanitized).childNodes)).toBe(
      nesting(browserBody(letter).childNodes),
    );
  });

  it.each([
    ['<a href="javascript:alert(1)">script link</a>'],
    ['<a href="  JaVaScRiPt:alert(1)">spaced link</a>'],
    ['<a href="java&#x09;script:alert(1)">tab entity link</a>'],
    ['<a href="&#106;avascript:alert(1)">numeric entity link</a>'],
    ['<img src="cid:logo@example.test" onerror="alert(1)" onload="alert(1)">'],
    ['<div onclick="alert(1)" onmouseover="alert(1)">handlers</div>'],
    ['<body onload="alert(1)"><p>second body</p>'],
    ["<script>alert(1)</script>"],
    ['<iframe src="https://evil.test" srcdoc="<script>alert(1)</script>"></iframe>'],
    ['<object data="https://evil.test/x.swf"><embed src="https://evil.test/x.swf"></object>'],
    ["<svg><script>alert(1)</script></svg>"],
    ['<svg><a xlink:href="javascript:alert(1)"><text>svg link</text></a></svg>'],
    ["<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>"],
    ["<svg><style><img src=x onerror=alert(1)></style></svg>"],
    ["<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>"],
    [
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=1&Tab;onerror=alert(1)&gt;">',
    ],
    ["<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>"],
    ['<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
    ["<template><script>alert(1)</script><img src=x onerror=alert(1)></template>"],
    ["<!--><img src=x onerror=alert(1)>-->"],
    ["<!---><img src=x onerror=alert(1)>-->"],
    ["<!-- --!><img src=x onerror=alert(1)> -->"],
    ['<!--<img src="--><img src=x onerror=alert(1)>">-->'],
    ["<!--[if gte mso 9]><img src=x onerror=alert(1)><![endif]-->"],
    ["<xmp><img src=x onerror=alert(1)></xmp>"],
    ["<noembed><img src=x onerror=alert(1)></noembed>"],
    ["<textarea><img src=x onerror=alert(1)></textarea>"],
    ["<title><img src=x onerror=alert(1)></title>"],
    ["<style><img src=x onerror=alert(1)></style>"],
    ['<div title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">quoted title</div>'],
    [
      '<table><tr><td><a href="https://ok.example.test"><table><tr><td><a href="javascript:alert(1)">nested link</a></td></tr></table></a></td></tr></table>',
    ],
  ])("emits nothing executable and nothing a re-parse changes: %s", (payload) => {
    const sanitized = sanitizeMailHtml(`<p>Before</p>${payload}<p>After</p>`, BUDGET);
    const frame = frameBody(sanitized);

    expect(sanitized).toContain("<p>Before</p>");
    // Text is escaped, so every `<` left in the output opens a tag.
    for (const tag of sanitized?.match(/<[^>]*>/g) ?? []) {
      expect(tag).not.toMatch(
        /^<\/?(?:script|iframe|object|embed|svg|math|style|template|noscript|xmp|noembed|textarea|title|form)\b|\son[a-z]+=|javascript:/i,
      );
    }
    for (const element of descendants(frame.childNodes)) {
      expect(element.namespaceURI).toBe(HTML_NAMESPACE);
      expect(EMITTED_TAGS).toContain(element.tagName);
      for (const attribute of element.attrs) {
        expect(EMITTED_ATTRIBUTES).toContain(attribute.name);
      }
    }
    // Serializing the tree the frame built and parsing it again must give the
    // same tree: the output carries no markup that mutates on a second parse.
    expect(everything(frameBody(serialize(frame)).childNodes)).toBe(
      everything(frame.childNodes),
    );
  });

  it("refuses markup longer than the budget before parsing it", () => {
    // The output would fit: the style is dropped. The input still may not.
    const source = `<style>${"x".repeat(200)}</style><p>Short</p>`;

    expect(limitCode(() => sanitizeMailHtml(source, { ...BUDGET, maxCharacters: 100 }))).toBe(
      "EMAXLEN",
    );
  });

  it("refuses nesting deeper than a browser builds", () => {
    const source = `${"<div>".repeat(600)}Deep`;

    expect(
      limitCode(() => sanitizeMailHtml(source, { ...BUDGET, maxNodes: 50_000 })),
    ).toBe("EMAXLEN");
  });

  it("counts a run of text as one node however its characters are spelled", () => {
    // Every spelling here is one text node in the frame. The parser reports
    // each character reference as its own event, and the markup the
    // sanitizer reads spells a no-break space, `&`, `<` and `>` that way.
    for (const text of [
      "word ".repeat(2_000),
      "word&nbsp;".repeat(2_000),
      "Q&A ".repeat(2_000),
      "1 &lt; 2 &gt; 0 ".repeat(1_000),
    ]) {
      expect(sanitizeMailHtml(`<p>${text}</p>`, BUDGET)).toMatch(/^<p>/);
    }
  });

  it("counts the elements a browser rebuilds against the node budget", () => {
    // Sixty distinct formatting elements left open when their paragraph ends
    // are reopened inside every paragraph that follows: 400 paragraphs become
    // 24,000 elements, from about 4,000 characters.
    const source = [
      "<p>",
      Array.from({ length: 60 }, (_, index) => `<b class="c${index}">`).join(""),
      "x",
      "</p><p>x".repeat(400),
    ].join("");

    expect(limitCode(() => sanitizeMailHtml(source, BUDGET))).toBe("EMAXLEN");
  });
});

/** A message filled to its size limit with numbered parts between two ends. */
function fillToLimit(part: (index: string) => string, start = "", end = ""): string {
  const parts = [start];
  let length = start.length + end.length;
  for (let index = 0; ; index++) {
    const next = part(index.toString(36));
    if (length + next.length > MESSAGE_BUDGET.maxCharacters) break;
    parts.push(next);
    length += next.length;
  }
  return `${parts.join("")}${end}`;
}

/** One tag whose distinct attributes fill the message to its size limit. */
function tagOfAttributes(open: string, close = ">"): string {
  return fillToLimit((index) => ` a${index}`, open, close);
}

function repeatToLimit(unit: string, prefix = ""): string {
  return fillToLimit(() => unit, prefix);
}

describe("mail HTML sanitizer time bounds", () => {
  // Each case is a message within the worker's own budget, built to make one
  // stage superlinear; the worst took parse5 most of a minute. Each now takes
  // tens of milliseconds, so the bound is generous.
  it.each([
    ["a start tag of distinct attributes", () => tagOfAttributes("<x"), "EMAXLEN"],
    ["an end tag of distinct attributes", () => tagOfAttributes("</x"), "empty"],
    [
      "the same tag inside an SVG style, which a streaming parser reads as text",
      () => tagOfAttributes("<svg><style><x", "></style></svg>"),
      "EMAXLEN",
    ],
    ["empty comments", () => repeatToLimit("<!---->"), "EMAXLEN"],
    ["text and empty comments", () => repeatToLimit("a<!---->"), "EMAXLEN"],
    ["49,000 top-level elements", () => "<i></i>".repeat(49_000), "sanitized"],
    [
      "49,000 elements moved out of a table",
      () => `<table>${"<i></i>".repeat(49_000)}</table>`,
      "sanitized",
    ],
    [
      "49,000 line breaks a misnested end tag moves into a new element",
      () => `<b><div>${"<br>".repeat(49_000)}</b>`,
      "sanitized",
    ],
    [
      "a stray html tag per attribute, each merged into the root",
      () => fillToLimit((index) => `<html a${index}>`),
      "EMAXLEN",
    ],
  ])("bounds %s", (_label, source, expected) => {
    expect(outcomeWithin(source(), 500)).toBe(expected);
  });

  // parse5 walks its stack of open elements, and its list of open formatting
  // elements, on most tags. The depth cap bounds both, so the work stays
  // proportional to the length of the message, times a constant the cap
  // sets: these two take under a second, where a square would take minutes.
  it.each([
    [
      "stray end tags under the deepest nesting allowed",
      () => repeatToLimit("</div>", "<span>".repeat(505)),
    ],
    [
      "formatting elements left open in each of 60 nested cells",
      () => {
        let serial = 0;
        const cell = () =>
          `<p>${Array.from({ length: 250 }, () => `<b c=${(serial++).toString(36)}>`).join("")}</p><table><tr><td>`;
        return Array.from({ length: 60 }, cell).join("") + "<i></i>".repeat(33_000);
      },
    ],
  ])("keeps %s within the depth cap's bound", (_label, source) => {
    expect(outcomeWithin(source(), 5_000)).toBe("sanitized");
  });
});

function outcomeWithin(markup: string, milliseconds: number): unknown {
  expect(markup.length).toBeLessThanOrEqual(MESSAGE_BUDGET.maxCharacters);
  const started = performance.now();
  let outcome: unknown;
  try {
    outcome = sanitizeMailHtml(markup, MESSAGE_BUDGET) === null ? "empty" : "sanitized";
  } catch (error) {
    outcome = (error as { code?: unknown }).code;
  }
  expect(performance.now() - started).toBeLessThan(milliseconds);
  return outcome;
}
