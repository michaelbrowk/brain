/**
 * Pure text rules shared by every surface that shows mail text: the list
 * row, the reader's fallback preview, and the header-only preview. A rule
 * applied on one surface and not the other is how the same snippet ends up
 * readable in the list and full of raw entities in the reader.
 */

/**
 * Rejects transfer-encoded or decoder-corrupted text before it reaches the
 * reader. The provider snippet remains the last-resort safe preview.
 */
export function readableMailBody(value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  if (looksLikeEncodedTransferBody(value)) return null;
  const replacements = countOccurrences(value, "\ufffd");
  if (
    replacements >= 2 ||
    (replacements > 0 && /=(?![0-9a-f]{2}(?:=|\s|$))[a-z0-9]{2}/i.test(value))
  ) {
    return null;
  }
  return value;
}

/** The input is sanitizer output, so removing tags cannot expose raw active HTML. */
export function readableSanitizedMailHtml(value: string | null): string | null {
  if (value === null) return null;
  const visible = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|zwnj|zwj|#x?0*200[bcdf]|#0*160);/gi, " ")
    .replace(/&(?:amp|lt|gt|quot|#39);/gi, "x")
    .replace(/\s+/g, " ")
    .trim();
  if (visible.length === 0) {
    return /<img data-brain-(?:cid|remote-image)="[^"]+"/.test(value)
      ? value
      : null;
  }
  return readableMailBody(visible) === null ? null : value;
}

/** Shared reader/cache decision for whether the sanitized HTML alternative wins. */
export function preferSanitizedHtmlAlternative(
  textBody: string | null,
  htmlBody: string | null,
): boolean {
  if (htmlBody === null) return false;
  const visibleHtmlCharacters = countVisibleHtmlCharacters(htmlBody);
  if (textBody === null) {
    return (
      visibleHtmlCharacters > 0 ||
      /<img data-brain-(?:cid|remote-image)="[^"]+"/.test(htmlBody)
    );
  }
  if (visibleHtmlCharacters < 8) return false;
  const htmlReplacementCharacters = countOccurrences(htmlBody, "\ufffd");
  const textReplacementCharacters = countOccurrences(textBody, "\ufffd");
  if (
    htmlReplacementCharacters > 0 &&
    textReplacementCharacters === 0 &&
    readableMailBody(textBody) !== null
  ) {
    return false;
  }
  return true;
}

/** Named entities worth expanding in a snippet: what providers actually send. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
  bull: "•",
  shy: "",
  zwnj: "",
  zwj: "",
};

/**
 * Markers a mail client writes where a picture was — the text extractor's
 * leftovers, never something the sender typed. Bounded on purpose: a
 * bracketed run is only dropped when it opens with one of these words, so
 * "[Urgent] the lease" keeps its prefix and only the prefix rule may take it.
 */
const IMAGE_MARKER =
  /\[\s*(?:image|img|photo|picture|graphic|logo|banner|inline image|cid:[^\]]{0,120})[^\]]{0,40}\]/gi;

/** Numeric and named entities, expanded once — the snippet is a text node. */
function expandEntities(value: string): string {
  return value
    .replace(/&#(\d{1,7});/g, (match, code: string) => {
      const point = Number.parseInt(code, 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (match, code: string) => {
      const point = Number.parseInt(code, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&([a-zA-Z]{2,8});/g, (match, name: string) => {
      const replacement = ENTITIES[name.toLowerCase()];
      return replacement === undefined ? match : replacement;
    });
}

/**
 * The snippet is a continuation of the subject, not a field of its own, so it
 * has to arrive clean or not at all: entities expanded, image markers
 * dropped, whitespace collapsed. When nothing survives, the line simply ends
 * — absence is shown by absence, never by the words "No preview".
 */
export function sanitizeSnippet(raw: string | null | undefined): string {
  if (!raw) return "";
  return expandEntities(raw)
    .replace(IMAGE_MARKER, " ")
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")
    .replace(/\s+/gu, " ")
    .replace(/^[\s.,;:·•\-–—|]+/u, "")
    .trim();
}

export function looksLikeEncodedTransferBody(value: string): boolean {
  const tokens = value.match(/=[0-9a-f]{2}/gi)?.length ?? 0;
  if (
    /(?:=[0-9a-f]{2}){2,}/i.test(value) ||
    (tokens >= 8 && tokens * 12 >= value.length)
  ) {
    return true;
  }
  const compact = value.replace(/\s/g, "");
  return (
    compact.length >= 256 &&
    /^[a-z0-9+/]+={0,2}$/i.test(compact)
  );
}

function countOccurrences(value: string, token: string): number {
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(token, index)) !== -1) {
    count += 1;
    index += token.length;
  }
  return count;
}

function countVisibleHtmlCharacters(value: string): number {
  const visibleText = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|zwnj|zwj|#x?0*200[bcdf]|#0*160);/gi, " ")
    .replace(/\s/g, "");
  return visibleText.length;
}
