import { Parser } from "htmlparser2";
import {
  defaultTreeAdapter,
  html,
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterMap,
  type TreeAdapter,
} from "parse5";

import { validateMailRemoteImageSourceUrl } from "../security";
import { mailLinkDestination } from "../link-destination";

import {
  applyTrackingValue, mailClassNames, mailPresentationSheet, TRACKED_CSS_PROPERTY,
  visibilityVariants, type TrackingValue,
} from "./mail-html-sanitizer-styles";

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "center",
  "code",
  "del",
  "div",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);
const HTML_VOID_TAGS = new Set([
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
const DROP_CONTENT_TAGS = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "frame",
  "frameset",
  "head",
  "iframe",
  "input",
  "link",
  "math",
  "media",
  "meta",
  "noscript",
  "object",
  "option",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "video",
]);

export interface MailHtmlSanitizerBudget {
  readonly maxCharacters: number;
  readonly maxNodes: number;
  readonly maxAttributes: number;
  readonly maxRemoteImages: number;
}

export interface SanitizedMailRemoteImage {
  readonly remoteImageId: string;
  readonly sourceUrl: string;
}

export interface SanitizedMailHtmlResult {
  readonly html: string | null;
  readonly remoteImages: readonly SanitizedMailRemoteImage[];
}

const SAFE_REMOTE_IMAGE_ID = /^remote-image-a[0-9a-f]{32}$/;
const OVERFLOW_KEYWORDS = Object.freeze([
  "visible",
  "hidden",
  "clip",
  "scroll",
  "auto",
]);
/**
 * The deepest element the tree builder may nest; a deeper message is refused
 * like any other over budget. parse5 walks its stack of open elements on most
 * tags and its serializer recurses once per level, so without a bound both
 * the time and the call stack would be the sender's choice. Chromium's parser
 * nests no deeper than 512 either.
 */
const MAX_TREE_DEPTH = 512;
/**
 * The most attributes one element may carry; a message with more is refused
 * like any other over budget. A busy table cell in bulk mail carries about
 * thirty.
 */
const MAX_ELEMENT_ATTRIBUTES = 256;

/**
 * Sanitizes the tree a browser would build from the markup, event by event,
 * and never retains remote resources.
 */
export function sanitizeMailHtml(
  source: string,
  budget: MailHtmlSanitizerBudget,
): string | null {
  return sanitizeMailHtmlInternal(source, budget, null).html;
}

/**
 * Keeps only an opaque identifier in sanitized HTML. The source URL crosses
 * the no-network worker boundary separately and is never exposed to the
 * browser or iframe.
 */
export function sanitizeMailHtmlWithRemoteImages(
  source: string,
  budget: MailHtmlSanitizerBudget,
  allocateRemoteImageId: (sourceUrl: string) => string,
): SanitizedMailHtmlResult {
  if (typeof allocateRemoteImageId !== "function") {
    throw limitError("remote image allocator is invalid");
  }
  return sanitizeMailHtmlInternal(source, budget, allocateRemoteImageId);
}

function sanitizeMailHtmlInternal(
  source: string,
  budget: MailHtmlSanitizerBudget,
  allocateRemoteImageId: ((sourceUrl: string) => string) | null,
): SanitizedMailHtmlResult {
  if (source.length > budget.maxCharacters) {
    throw limitError("HTML exceeds the character limit");
  }
  const output: string[] = [];
  const emittedStack: string[] = [];
  const remoteImageSuppressionStack: Array<{
    readonly tag: string;
    readonly suppressed: boolean;
  }> = [];
  const remoteImages: SanitizedMailRemoteImage[] = [];
  const remoteIds = new Set<string>();
  const remoteSources = new Map<string, string>();
  let outputCharacters = 0;
  let nodes = 0;
  let attributes = 0;
  let suppressedDepth = 0;
  // htmlparser2 reports each character reference as its own text event, and
  // the markup it reads spells a no-break space, `&`, `<` and `>` that way. A
  // run of text between two tags is still one node in the frame.
  let inTextRun = false;

  const append = (value: string) => {
    if (value.length === 0) return;
    if (outputCharacters + value.length > budget.maxCharacters) {
      throw limitError("sanitized HTML exceeds the character limit");
    }
    outputCharacters += value.length;
    output.push(value);
  };
  const admitNode = (attributeCount = 0) => {
    nodes++;
    attributes += attributeCount;
    if (nodes > budget.maxNodes) throw limitError("sanitized HTML exceeds the node limit");
    if (attributes > budget.maxAttributes) {
      throw limitError("sanitized HTML exceeds the attribute limit");
    }
  };

  const document = browserTreeMarkup(source, budget);
  const sheet = mailPresentationSheet(
    document.styles, ALLOWED_TAGS, sanitizeCssValue,
  );

  const cssClasses = (value: string | undefined) => mailClassNames(value)
    .filter((name) => sheet.classes.has(name)).map((name) => "bm-c-" + name);
  const visibilityCache = new Map<string, ReturnType<typeof visibilityVariants>>();
  const hidesRemoteImage = (tag: string, raw: Record<string, string>) => {
    if (Object.hasOwn(raw, "hidden")) return true;
    const inline = parseTrackingStyle(raw.style);
    const isImage = tag === "img";
    if (!sheet.tracking.size) return trackingStyleHides(raw, isImage, inline);
    const key = tag + " " + mailClassNames(raw.class).filter(name => sheet.classes.has(name)).join(" ");
    let variants = visibilityCache.get(key);
    if (!variants) {
      variants = visibilityVariants(sheet, tag, raw.class);
      if (visibilityCache.size < 256) visibilityCache.set(key, variants);
    }
    if (!variants.length) return trackingStyleHides(raw, isImage, inline);
    return variants.every(style => {
      if (!inline.size) return trackingStyleHides(raw, isImage, style);
      const effective = new Map(style);
      for (const [property, declaration] of inline) applyTrackingValue(effective, property, declaration);
      return trackingStyleHides(raw, isImage, effective);
    });
  };

  // A presentation-only attribute contains no visible copy. The reader extracts
  // this generated stylesheet before measuring or binding any images.
  if (sheet.css) append(`<span data-brain-mail-css="${escapeHtml(sheet.css)}"></span>`);
  const body = document.body;
  const bodyAttributes = safePresentationAttributes("body", body, !!sheet.css);
  const direction = normalizeDirection(body.dir);
  if (direction) bodyAttributes.push(`dir="${direction}"`);
  const bodyClasses = cssClasses(body.class);
  if (sheet.usesBody) bodyClasses.push("bm-body");
  if (bodyClasses.length) bodyAttributes.push(`class="${bodyClasses.join(" ")}"`);
  const bodyHidesImages = hidesRemoteImage("body", body);
  if (Object.hasOwn(body, "hidden")) return { html: null, remoteImages: [] };
  if (bodyAttributes.length) append(`<div ${bodyAttributes.join(" ")}>`);

  const parser = new Parser(
    {
      onopentag(name, rawAttributes) {
        inTextRun = false;
        const normalizedName = name.toLowerCase();
        const ancestorSuppressesRemoteImages =
          remoteImageSuppressionStack.at(-1)?.suppressed ?? bodyHidesImages;
        const suppressesRemoteImages =
          ancestorSuppressesRemoteImages ||
          hidesRemoteImage(normalizedName, rawAttributes);
        if (!HTML_VOID_TAGS.has(normalizedName)) {
          remoteImageSuppressionStack.push({
            tag: normalizedName,
            suppressed: suppressesRemoteImages,
          });
        }
        admitNode(Object.keys(rawAttributes).length);
        if (suppressedDepth > 0) {
          suppressedDepth++;
          return;
        }
        if (DROP_CONTENT_TAGS.has(normalizedName) || Object.hasOwn(rawAttributes, "hidden")) {
          suppressedDepth = 1;
          return;
        }
        if (!ALLOWED_TAGS.has(normalizedName)) {
          emittedStack.push("");
          return;
        }

        const classes = cssClasses(rawAttributes.class);
        const classAttributes = classes.length ? [`class="${classes.join(" ")}"`] : [];

        if (normalizedName === "img") {
          const cid = normalizeCidSource(rawAttributes.src);
          if (cid === null) {
            const remoteSource = normalizeRemoteImageSource(rawAttributes.src);
            if (
              remoteSource !== null &&
              allocateRemoteImageId !== null &&
              !suppressesRemoteImages
            ) {
              let remoteImageId = remoteSources.get(remoteSource);
              if (
                remoteImageId === undefined &&
                remoteImages.length < budget.maxRemoteImages
              ) {
                remoteImageId = allocateRemoteImageId(remoteSource);
                if (
                  !SAFE_REMOTE_IMAGE_ID.test(remoteImageId) ||
                  remoteIds.has(remoteImageId)
                ) {
                  throw limitError("remote image identifier is invalid");
                }
                remoteIds.add(remoteImageId);
                remoteSources.set(remoteSource, remoteImageId);
                remoteImages.push(
                  Object.freeze({ remoteImageId, sourceUrl: remoteSource }),
                );
              }
              if (remoteImageId !== undefined) {
                const alternative = sanitizeMetadata(rawAttributes.alt, 512);
                const imageAttributes = [
                  `data-brain-remote-image="${remoteImageId}"`,
                  `alt="${escapeHtml(alternative ?? "")}"`,
                  ...classAttributes,
                  ...safePresentationAttributes(normalizedName, rawAttributes, !!sheet.css),
                ];
                append(`<img ${imageAttributes.join(" ")}>`);
                return;
              }
            }
            const alternative = sanitizeText(rawAttributes.alt ?? "");
            if (alternative) append(escapeHtml(alternative));
            return;
          }
          const alternative = sanitizeMetadata(rawAttributes.alt, 512);
          const imageAttributes = [
            `data-brain-cid="${escapeHtml(cid)}"`,
            `alt="${escapeHtml(alternative ?? "")}"`,
            ...classAttributes,
            ...safePresentationAttributes(normalizedName, rawAttributes, !!sheet.css),
          ];
          append(
            `<img ${imageAttributes.join(" ")}>`,
          );
          return;
        }

        const safeAttributes: string[] = [...classAttributes];
        if (normalizedName === "a") {
          const link = mailLinkDestination(rawAttributes.href);
          if (link !== null) {
            safeAttributes.push(`data-brain-href="${escapeHtml(link)}"`);
          }
        }
        if (normalizedName === "td" || normalizedName === "th") {
          for (const key of ["colspan", "rowspan"] as const) {
            const value = normalizeTableSpan(rawAttributes[key]);
            if (value !== null) safeAttributes.push(`${key}="${value}"`);
          }
        }
        const direction = normalizeDirection(rawAttributes.dir);
        if (direction !== null) safeAttributes.push(`dir="${direction}"`);
        safeAttributes.push(
          ...safePresentationAttributes(normalizedName, rawAttributes, !!sheet.css),
        );

        append(`<${normalizedName}${safeAttributes.length ? ` ${safeAttributes.join(" ")}` : ""}>`);
        // A parser drops the newline straight after `<pre>`. parse5 already
        // dropped the sender's, so the frame is given one of its own to drop
        // and a leading blank line in the text survives.
        if (normalizedName === "pre") append("\n");
        if (!HTML_VOID_TAGS.has(normalizedName)) emittedStack.push(normalizedName);
      },
      ontext(value) {
        if (suppressedDepth > 0) return;
        const text = sanitizeText(value);
        if (text.length === 0) return;
        if (!inTextRun) admitNode();
        inTextRun = true;
        append(escapeHtml(text));
      },
      onclosetag(name) {
        inTextRun = false;
        const normalizedName = name.toLowerCase();
        closeRemoteImageSuppressionFrame(
          remoteImageSuppressionStack,
          normalizedName,
        );
        if (suppressedDepth > 0) {
          suppressedDepth--;
          return;
        }
        if (HTML_VOID_TAGS.has(normalizedName)) return;
        while (emittedStack.length > 0) {
          const emitted = emittedStack.pop()!;
          if (emitted) append(`</${emitted}>`);
          if (emitted === normalizedName || emitted === "") break;
        }
      },
    },
    {
      decodeEntities: true,
      lowerCaseAttributeNames: true,
      lowerCaseTags: true,
      recognizeSelfClosing: true,
    },
  );
  parser.write(document.markup);
  parser.end();
  while (emittedStack.length > 0) {
    const emitted = emittedStack.pop()!;
    if (emitted) append(`</${emitted}>`);
  }
  if (bodyAttributes.length) append("</div>");
  const sanitized = output.join("").trim();
  return Object.freeze({
    html: sanitized.length === 0 ? null : sanitized,
    remoteImages: Object.freeze(remoteImages),
  });
}

/**
 * The markup again, as the tree a browser builds from it. htmlparser2 closes
 * an element on any matching end tag, straight through the table boundaries a
 * browser respects, so a stray `</td>` in a nested table closed the outer cell
 * and pulled the rest of the layout out of it. parse5 applies the HTML tree
 * construction rules instead, and its serialization closes every element
 * explicitly, which the event sanitizer below then reads without repairing.
 *
 * Full documents keep the body’s presentation. Fragments use a body context
 * in the same no-quirks mode as the reader. Only sanitized stylesheet rules
 * come out of the head. Scripting is off because the frame
 * runs none, which is also how the frame reads the inside of a `<noscript>`:
 * as markup, so an attribute value cannot end the element early.
 */
function browserTreeMarkup(
  source: string,
  budget: MailHtmlSanitizerBudget,
): { markup: string; styles: string[]; body: Record<string, string> } {
  const treeAdapter = boundedTreeAdapter(budget);
  const options = { scriptingEnabled: false, treeAdapter };
  let body: Record<string, string> = {};
  let content: TreeParent;
  let styleRoot: TreeParent;
  if (/<(?:html|body)(?:\s|>)/i.test(source)) {
    // Force the same no-quirks layout as the reader document, including for
    // fragments from older senders which omit a standards-mode doctype.
    const document = parse("<!doctype html>" + source, options);
    const root = treeAdapter.getChildNodes(document).find(isElementNamed("html"))!;
    const bodyElement = treeAdapter.getChildNodes(root).find(isElementNamed("body"));
    if (!bodyElement) return { markup: "", styles: [], body };
    body = Object.fromEntries(bodyElement.attrs.map(({ name, value }) => [name, value]));
    const rootDir = root.attrs.find((attr) => attr.name === "dir")?.value;
    if (rootDir && !body.dir) body.dir = rootDir;
    content = bodyElement;
    styleRoot = root;
  } else {
    content = parseFragment(defaultTreeAdapter.createElement("body", html.NS.HTML, []), source, options);
    styleRoot = content;
  }

  const styles: string[] = [];
  function collectStyles(parent: TreeParent) {
    for (const node of treeAdapter.getChildNodes(parent)) {
      if (!treeAdapter.isElementNode(node) || node.namespaceURI !== html.NS.HTML) continue;
      if (node.tagName === "style") {
        const type = node.attrs.find((attr) => attr.name === "type")?.value.trim().toLowerCase();
        const media = node.attrs.find((attr) => attr.name === "media")?.value.trim().toLowerCase();
        if ((!type || type === "text/css") && (!media || media === "all" || media === "screen")) {
          for (const child of treeAdapter.getChildNodes(node)) {
            if (treeAdapter.isTextNode(child)) styles.push(child.value);
          }
        }
      } else if (node.tagName === "head" || !DROP_CONTENT_TAGS.has(node.tagName)) {
        collectStyles(node);
      }
    }
  }
  if (/<style[\s>]/i.test(source)) collectStyles(styleRoot);
  return { markup: serialize(content, options), styles, body };
}

function isElementNamed(tag: string) {
  return (node: TreeChild): node is DefaultTreeAdapterMap["element"] =>
    "tagName" in node && node.tagName === tag && node.namespaceURI === html.NS.HTML;
}

type TreeParent = DefaultTreeAdapterMap["parentNode"];
type TreeChild = DefaultTreeAdapterMap["childNode"];

/**
 * parse5's own tree, held to the sanitizer's budget while it is built.
 *
 * Every node counts when it is created: an element (a browser reopens an
 * unclosed formatting element inside every block after it, so a short message
 * can build far more elements than it spells), a comment, and a text node,
 * which parse5 creates only when the text cannot join the node before it.
 *
 * The time it takes is the length of the markup times a constant, and three
 * things keep it there. The patch in `patches/parse5@8.0.1.patch` finds a
 * duplicate attribute in constant time, where parse5 scanned every attribute
 * before it on the same tag. `MAX_TREE_DEPTH` bounds the stack of open
 * elements parse5 walks on most tags, and with it the list of open formatting
 * elements it walks on some: that bound is the constant, and it makes the
 * worst message of the full size take about half a second. And the child
 * arrays below change only at their ends. parse5 moves a parent's children
 * one at a time by detaching the first, which as a splice shifts every child
 * behind it, so detaching the first child only advances a count past it and
 * the detached entries are cut off in one go when the whole array is next
 * read. A node parse5 inserts before, or detaches from anywhere else, sits
 * at or near the end of its parent, where the search starts.
 */
function boundedTreeAdapter(
  budget: MailHtmlSanitizerBudget,
): TreeAdapter<DefaultTreeAdapterMap> {
  let nodes = 0;
  let attributes = 0;
  const admitNode = () => {
    if (++nodes > budget.maxNodes) {
      throw limitError("sanitized HTML exceeds the node limit");
    }
  };
  // A template's content is a fragment with no parent of its own.
  const templateHosts = new WeakMap<object, TreeParent>();
  const assertDepth = (parent: TreeParent) => {
    let depth = 1;
    for (
      let node: TreeParent | null = parent;
      node !== null;
      node = "parentNode" in node ? node.parentNode : (templateHosts.get(node) ?? null)
    ) {
      if (++depth > MAX_TREE_DEPTH) {
        throw limitError("sanitized HTML exceeds the nesting limit");
      }
    }
  };
  const detachedFront = new WeakMap<TreeParent, number>();
  const frontOf = (parent: TreeParent) => detachedFront.get(parent) ?? 0;
  const insertAt = (parent: TreeParent, node: TreeChild, index: number) => {
    parent.childNodes.splice(index, 0, node);
    node.parentNode = parent;
  };
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      if (attrs.length > MAX_ELEMENT_ATTRIBUTES) {
        throw limitError("sanitized HTML exceeds the attribute limit of one element");
      }
      attributes += attrs.length;
      if (attributes > budget.maxAttributes) {
        throw limitError("sanitized HTML exceeds the attribute limit");
      }
      admitNode();
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    createCommentNode(data) {
      admitNode();
      return defaultTreeAdapter.createCommentNode(data);
    },
    // Every stray `<html>` tag merges its attributes into the root, and each
    // merge reads the root's whole list, so the root obeys the same cap.
    adoptAttributes(recipient, attrs) {
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
      if (recipient.attrs.length > MAX_ELEMENT_ATTRIBUTES) {
        throw limitError("sanitized HTML exceeds the attribute limit of one element");
      }
    },
    insertText(parent, text) {
      const last =
        parent.childNodes.length > frontOf(parent) ? parent.childNodes.at(-1) : undefined;
      if (last !== undefined && defaultTreeAdapter.isTextNode(last)) {
        last.value += text;
        return;
      }
      admitNode();
      defaultTreeAdapter.appendChild(parent, defaultTreeAdapter.createTextNode(text));
    },
    insertTextBefore(parent, text, reference) {
      const index = parent.childNodes.lastIndexOf(reference);
      const previous = index > frontOf(parent) ? parent.childNodes[index - 1] : undefined;
      if (previous !== undefined && defaultTreeAdapter.isTextNode(previous)) {
        previous.value += text;
        return;
      }
      admitNode();
      insertAt(parent, defaultTreeAdapter.createTextNode(text), index);
    },
    appendChild(parent, node) {
      if (defaultTreeAdapter.isElementNode(node)) assertDepth(parent);
      defaultTreeAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, reference) {
      if (defaultTreeAdapter.isElementNode(node)) assertDepth(parent);
      insertAt(parent, node, parent.childNodes.lastIndexOf(reference));
    },
    detachNode(node) {
      const parent = node.parentNode;
      if (parent === null) return;
      const front = frontOf(parent);
      if (parent.childNodes[front] === node) {
        detachedFront.set(parent, front + 1);
      } else {
        parent.childNodes.splice(parent.childNodes.lastIndexOf(node), 1);
      }
      node.parentNode = null;
    },
    getFirstChild(node) {
      return node.childNodes[frontOf(node)];
    },
    getChildNodes(node) {
      const front = detachedFront.get(node);
      if (front !== undefined) {
        node.childNodes.splice(0, front);
        detachedFront.delete(node);
      }
      return node.childNodes;
    },
    setTemplateContent(template, content) {
      templateHosts.set(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
  };
}

function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function sanitizeMetadata(value: string | undefined, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const sanitized = sanitizeText(value).replace(/[\r\n\t]/g, " ").trim();
  return sanitized.length === 0 ? null : sanitized.slice(0, maximum);
}

function normalizeCidSource(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^cid:([^\s<>]{1,512})$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function normalizeRemoteImageSource(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  const candidate = value.trim();
  if (candidate.length === 0) return null;
  try {
    const parsed = new URL(/^\/\//.test(candidate) ? `https:${candidate}` : candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hostname.length === 0 ||
      (parsed.port !== "" && parsed.port !== "443")
    ) {
      return null;
    }
    parsed.hash = "";
    const normalized = parsed.toString();
    if (normalized.length > 2_048) return null;
    try {
      return validateMailRemoteImageSourceUrl(normalized);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function closeRemoteImageSuppressionFrame(
  stack: Array<{ readonly tag: string; readonly suppressed: boolean }>,
  tag: string,
): void {
  if (HTML_VOID_TAGS.has(tag)) return;
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index]?.tag !== tag) continue;
    stack.splice(index);
    return;
  }
}

function trackingStyleHides(
  raw: Record<string, string>,
  isImage: boolean,
  declarations: ReadonlyMap<string, TrackingValue>,
): boolean {
  const value = (name: string) => declarations.get(name)?.value;
  if (value("display") === "none") return true;
  if (value("visibility") === "hidden" || value("visibility") === "collapse") return true;
  if (value("content-visibility") === "hidden") return true;
  if (isZeroOpacity(value("opacity"))) return true;

  const widths = [
    trackingPixelHtmlLength(raw.width),
    trackingPixelCssLength(value("width")),
    trackingPixelCssLength(value("max-width")),
  ].filter((value): value is number => value !== null);
  const heights = [
    trackingPixelHtmlLength(raw.height),
    trackingPixelCssLength(value("height")),
    trackingPixelCssLength(value("max-height")),
  ].filter((value): value is number => value !== null);
  const hasSmallWidth =
    widths.length > 0 && Math.min(...widths) <= 2;
  const hasSmallHeight =
    heights.length > 0 && Math.min(...heights) <= 2;
  if (!isImage) {
    // Email builders commonly put visible table content in a zero-height row.
    // Treat a container as tracking-only only when both axes constrain it;
    // the fetched raster still receives an independent 2x2 pixel check.
    return hasSmallWidth && hasSmallHeight;
  }
  if (
    widths.some((value) => value === 0) ||
    heights.some((value) => value === 0)
  ) {
    return true;
  }
  if (
    isImage &&
    ((widths.length > 0 && Math.min(...widths) <= 2 && heights.length === 0) ||
      (heights.length > 0 &&
        Math.min(...heights) <= 2 &&
        widths.length === 0))
  ) {
    return true;
  }
  return (
    hasSmallWidth &&
    hasSmallHeight
  );
}

function parseTrackingStyle(value: string | undefined): Map<string, TrackingValue> {
  const declarations = new Map<string, TrackingValue>();
  if (typeof value !== "string" || value.length > 8_192) return new Map();
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const declaration of withoutComments.split(";").slice(0, 64)) {
    const separator = declaration.indexOf(":");
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (!TRACKED_CSS_PROPERTY.test(property)) {
      continue;
    }
    const important = /!\s*important\s*$/i.test(
      declaration.slice(separator + 1),
    );
    const candidate = declaration
      .slice(separator + 1)
      .replace(/!\s*important\s*$/i, "")
      .trim()
      .toLowerCase();
    applyTrackingValue(declarations, property, { value: candidate, important });
  }
  return declarations;
}

function trackingPixelHtmlLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  const candidate = value.trim().toLowerCase();
  if (!/^(?:[0-9]{1,6}(?:\.[0-9]{1,3})?)(?:px)?$/.test(candidate)) {
    return null;
  }
  const parsed = Number.parseFloat(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function trackingPixelCssLength(value: string | undefined): number | null {
  if (
    value !== undefined &&
    /^(?:0+(?:\.0+)?|\.0+)(?:px|pt|em|rem|%)?$/.test(value)
  ) {
    return 0;
  }
  if (
    value === undefined ||
    !/^(?:[0-9]{1,6}(?:\.[0-9]{1,3})?|\.[0-9]{1,3})px$/.test(
      value,
    )
  ) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isZeroOpacity(value: string | undefined): boolean {
  if (
    value === undefined ||
    !/^(?:[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))(?:%)?$/.test(value)
  ) {
    return false;
  }
  return Number.parseFloat(value) === 0;
}

function normalizeTableSpan(value: string | undefined): string | null {
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 100 ? String(parsed) : null;
}

function normalizeDirection(value: string | undefined): "ltr" | "rtl" | "auto" | null {
  return value === "ltr" || value === "rtl" || value === "auto" ? value : null;
}

function safePresentationAttributes(
  tag: string,
  raw: Record<string, string>,
  preservePriority: boolean,
): string[] {
  const attributes: string[] = [];
  for (const key of ["width", "height"] as const) {
    const value = normalizeDimension(raw[key]);
    if (value !== null) attributes.push(`${key}="${value}"`);
  }
  if (tag === "table" || tag === "td" || tag === "th") {
    for (const key of ["cellpadding", "cellspacing", "border"] as const) {
      const value = normalizeUnsignedInteger(raw[key], 1_000);
      if (value !== null) attributes.push(`${key}="${value}"`);
    }
  }
  const align = normalizeKeyword(raw.align, ["left", "center", "right", "justify"]);
  if (align !== null) attributes.push(`align="${align}"`);
  const verticalAlign = normalizeKeyword(raw.valign, ["top", "middle", "bottom", "baseline"]);
  if (verticalAlign !== null) attributes.push(`valign="${verticalAlign}"`);

  if (tag === "font") {
    const color = raw.color && sanitizeCssColor(raw.color.trim());
    const face = raw.face && sanitizeCssValue("font-family", raw.face);
    if (color) attributes.push(`color="${escapeHtml(color)}"`);
    if (face) attributes.push(`face="${escapeHtml(face)}"`);
    if (/^(?:[1-7]|[+-][1-6])$/.test(raw.size ?? "")) attributes.push(`size="${raw.size}"`);
  }
  const style = sanitizeInlineStyle(raw.style, raw.bgcolor, preservePriority);
  if (style !== null) attributes.push(`style="${escapeHtml(style)}"`);
  return attributes;
}

function sanitizeInlineStyle(
  value: string | undefined,
  backgroundColor: string | undefined,
  preservePriority: boolean,
): string | null {
  const declarations = new Map<
    string,
    { readonly value: string; readonly important: boolean }
  >();
  if (typeof value === "string" && value.length <= 8_192) {
    const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const declaration of withoutComments.split(";").slice(0, 64)) {
      const separator = declaration.indexOf(":");
      if (separator < 1) continue;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const important = /!\s*important\s*$/i.test(
        declaration.slice(separator + 1),
      );
      const candidate = declaration
        .slice(separator + 1)
        .trim()
        .replace(/!\s*important\s*$/i, "")
        .trim();
      const sanitized = sanitizeCssValue(property, candidate);
      if (sanitized === null) continue;
      const previous = declarations.get(property);
      if (previous?.important && !important) continue;
      declarations.set(property, { value: sanitized, important });
    }
  }
  if (!declarations.has("background-color") && typeof backgroundColor === "string") {
    const color = sanitizeCssColor(backgroundColor.trim());
    if (color !== null) {
      declarations.set("background-color", { value: color, important: false });
    }
  }
  if (declarations.size === 0) return null;
  return [...declarations]
    .map(([property, declaration]) => `${property}:${declaration.value}${preservePriority && declaration.important ? "!important" : ""}`)
    .join(";");
}

function sanitizeCssValue(property: string, value: string): string | null {
  if (
    value.length === 0 ||
    value.length > 256 ||
    /[\\@{}<>\u0000-\u001f\u007f]/.test(value) ||
    /(?:url|image|expression|var|calc)\s*\(/i.test(value)
  ) {
    return null;
  }
  if (property === "color" || property === "background-color" || property === "background") {
    return sanitizeCssColor(value);
  }
  if (property === "font-family") {
    return value.length <= 160 && value.split(",").every(
      (name) => /^(?:[a-z0-9 .-]+|'[a-z0-9 .-]+'|"[a-z0-9 .-]+")$/i.test(name.trim()),
    ) ? collapseCssSpace(value) : null;
  }
  if (property === "font-size" || property === "line-height" || property === "letter-spacing") {
    return isCssLength(value, property === "line-height") ? value.toLowerCase() : null;
  }
  if (
    /^(?:width|height|min-width|max-width|min-height|max-height|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|border-(?:top|right|bottom|left)-width|border-spacing)$/.test(
      property,
    )
  ) {
    const parts = collapseCssSpace(value).split(" ");
    return parts.length <= 4 && parts.every((part) => isCssLength(part, false, true))
      ? parts.join(" ").toLowerCase()
      : null;
  }
  if (/^border(?:-(?:top|right|bottom|left))?$/.test(property)) {
    return sanitizeBorder(value);
  }
  if (property === "opacity") {
    return sanitizeCssOpacity(value);
  }
  const keywords: Record<string, readonly string[]> = {
    display: [
      "block",
      "inline",
      "inline-block",
      "inline-table",
      "table",
      "table-row",
      "table-cell",
      "none",
    ],
    "text-align": ["left", "center", "right", "justify", "start", "end"],
    "vertical-align": ["top", "middle", "bottom", "baseline", "sub", "super", "text-top", "text-bottom"],
    "font-style": ["normal", "italic", "oblique"],
    "font-weight": ["normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
    "text-decoration": ["none", "underline", "line-through"],
    "text-transform": ["none", "uppercase", "lowercase", "capitalize"],
    "white-space": ["normal", "nowrap", "pre", "pre-wrap", "pre-line"],
    "word-break": ["normal", "break-all", "keep-all", "break-word"],
    "overflow-wrap": ["normal", "break-word", "anywhere"],
    // Layout-only hiding keywords. Email preheaders rely on them, and the
    // tracking detector reads the raw style before this allowlist applies.
    overflow: OVERFLOW_KEYWORDS,
    "overflow-x": OVERFLOW_KEYWORDS,
    "overflow-y": OVERFLOW_KEYWORDS,
    visibility: ["visible", "hidden", "collapse"],
    "border-collapse": ["collapse", "separate"],
    "table-layout": ["auto", "fixed"],
    direction: ["ltr", "rtl"],
    float: ["none", "left", "right"],
  };
  const allowed = Object.hasOwn(keywords, property) ? keywords[property] : undefined;
  return allowed?.includes(value.toLowerCase()) ? value.toLowerCase() : null;
}

function sanitizeCssOpacity(value: string): string | null {
  const candidate = value.toLowerCase();
  if (!/^(?:[0-9]{1,3}(?:\.[0-9]{1,3})?|\.[0-9]{1,3})%?$/.test(candidate)) {
    return null;
  }
  const parsed = Number.parseFloat(candidate);
  const maximum = candidate.endsWith("%") ? 100 : 1;
  return parsed >= 0 && parsed <= maximum ? candidate : null;
}

function sanitizeCssColor(value: string): string | null {
  const candidate = collapseCssSpace(value).toLowerCase();
  return /^(?:#[0-9a-f]{3,8}|[a-z]{1,24}|(?:rgb|rgba|hsl|hsla)\([0-9.% ,+-]{1,64}\))$/.test(
    candidate,
  )
    ? candidate
    : null;
}

function sanitizeBorder(value: string): string | null {
  const parts = collapseCssSpace(value).split(" ");
  if (parts.length === 1 && parts[0]?.toLowerCase() === "none") return "none";
  if (parts.length < 2 || parts.length > 3) return null;
  const widthIndex = parts.findIndex((part) => isCssLength(part, false));
  const styleIndex = parts.findIndex((part) =>
    /^(?:solid|dashed|dotted|double|none)$/i.test(part),
  );
  if (widthIndex < 0 || styleIndex < 0 || widthIndex === styleIndex) return null;
  const remainder = parts.filter(
    (_part, index) => index !== widthIndex && index !== styleIndex,
  );
  if (remainder.length > 1) return null;
  const color = remainder[0];
  if (color !== undefined && sanitizeCssColor(color) === null) return null;
  return [parts[widthIndex]!, parts[styleIndex]!, color]
    .filter((part): part is string => part !== undefined)
    .map((part) => part.toLowerCase())
    .join(" ");
}

function isCssLength(value: string, unitless: boolean, allowAuto = false): boolean {
  if (allowAuto && value.toLowerCase() === "auto") return true;
  if (unitless && /^(?:0|[0-9]{1,3}(?:\.[0-9]{1,3})?)$/.test(value)) return true;
  return /^(?:0|[0-9]{1,5}(?:\.[0-9]{1,3})?(?:px|pt|em|rem|%))$/i.test(value);
}

function normalizeDimension(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (/^[0-9]{1,5}%$/.test(candidate)) {
    const percentage = Number(candidate.slice(0, -1));
    return percentage <= 1_000 ? `${percentage}%` : null;
  }
  return normalizeUnsignedInteger(candidate, 100_000);
}

function normalizeUnsignedInteger(
  value: string | undefined,
  maximum: number,
): string | null {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value.trim())) return null;
  const number = Number(value);
  return number <= maximum ? String(number) : null;
}

function normalizeKeyword<const T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase() as T;
  return allowed.includes(candidate) ? candidate : null;
}

function collapseCssSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function limitError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "EMAXLEN" });
}
