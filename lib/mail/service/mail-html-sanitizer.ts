import { Parser } from "htmlparser2";

import { validateMailRemoteImageSourceUrl } from "../security";

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

/** Event-based sanitizer. It never builds a DOM and never retains remote resources. */
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

  const parser = new Parser(
    {
      onopentag(name, rawAttributes) {
        const normalizedName = name.toLowerCase();
        const ancestorSuppressesRemoteImages =
          remoteImageSuppressionStack.at(-1)?.suppressed ?? false;
        const suppressesRemoteImages =
          ancestorSuppressesRemoteImages ||
          isRemoteImageSuppressedElement(
            rawAttributes,
            normalizedName === "img",
          );
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
        if (DROP_CONTENT_TAGS.has(normalizedName)) {
          suppressedDepth = 1;
          return;
        }
        if (!ALLOWED_TAGS.has(normalizedName)) {
          emittedStack.push("");
          return;
        }

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
                  ...safePresentationAttributes(normalizedName, rawAttributes),
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
            ...safePresentationAttributes(normalizedName, rawAttributes),
          ];
          append(
            `<img ${imageAttributes.join(" ")}>`,
          );
          return;
        }

        const safeAttributes: string[] = [];
        if (normalizedName === "a") {
          const link = normalizeLink(rawAttributes.href);
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
          ...safePresentationAttributes(normalizedName, rawAttributes),
        );

        append(`<${normalizedName}${safeAttributes.length ? ` ${safeAttributes.join(" ")}` : ""}>`);
        if (!HTML_VOID_TAGS.has(normalizedName)) emittedStack.push(normalizedName);
      },
      ontext(value) {
        if (suppressedDepth > 0) return;
        const text = sanitizeText(value);
        if (text.length === 0) return;
        admitNode();
        append(escapeHtml(text));
      },
      onclosetag(name) {
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
  parser.write(source);
  parser.end();
  while (emittedStack.length > 0) {
    const emitted = emittedStack.pop()!;
    if (emitted) append(`</${emitted}>`);
  }
  const sanitized = output.join("").trim();
  return Object.freeze({
    html: sanitized.length === 0 ? null : sanitized,
    remoteImages: Object.freeze(remoteImages),
  });
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

function isRemoteImageSuppressedElement(
  raw: Record<string, string>,
  isImage: boolean,
): boolean {
  if (Object.hasOwn(raw, "hidden")) return true;
  if (raw["aria-hidden"]?.trim().toLowerCase() === "true") return true;

  const declarations = parseTrackingStyle(raw.style);
  if (declarations.get("display") === "none") return true;
  if (
    declarations.get("visibility") === "hidden" ||
    declarations.get("visibility") === "collapse"
  ) {
    return true;
  }
  if (declarations.get("content-visibility") === "hidden") return true;
  if (isZeroOpacity(declarations.get("opacity"))) return true;

  const widths = [
    trackingPixelHtmlLength(raw.width),
    trackingPixelCssLength(declarations.get("width")),
    trackingPixelCssLength(declarations.get("max-width")),
  ].filter((value): value is number => value !== null);
  const heights = [
    trackingPixelHtmlLength(raw.height),
    trackingPixelCssLength(declarations.get("height")),
    trackingPixelCssLength(declarations.get("max-height")),
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

function parseTrackingStyle(value: string | undefined): Map<string, string> {
  const declarations = new Map<
    string,
    { readonly value: string; readonly important: boolean }
  >();
  if (typeof value !== "string" || value.length > 8_192) return new Map();
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const declaration of withoutComments.split(";").slice(0, 64)) {
    const separator = declaration.indexOf(":");
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (
      !/^(?:display|visibility|content-visibility|opacity|width|height|max-width|max-height)$/.test(
        property,
      )
    ) {
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
    const previous = declarations.get(property);
    if (previous?.important && !important) continue;
    declarations.set(property, { value: candidate, important });
  }
  return new Map(
    [...declarations].map(([property, declaration]) => [
      property,
      declaration.value,
    ]),
  );
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

function normalizeLink(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const candidate = value.trim();
  if (/^\/\//.test(candidate)) return `https:${candidate}`;
  if (!/^(?:https?:|mailto:)/i.test(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
      return null;
    }
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length === 0) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
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

  const style = sanitizeInlineStyle(raw.style, raw.bgcolor);
  if (style !== null) attributes.push(`style="${escapeHtml(style)}"`);
  return attributes;
}

function sanitizeInlineStyle(
  value: string | undefined,
  backgroundColor: string | undefined,
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
    .map(([property, declaration]) => `${property}:${declaration.value}`)
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
    return /^[a-z0-9 ,.'"-]{1,160}$/i.test(value) ? collapseCssSpace(value) : null;
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
  const allowed = keywords[property];
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
