const MAX_SEARCH_QUERY_BYTES = 256;
const MAX_SEARCH_TERMS = 12;
const MAX_SEARCH_TERM_CODE_POINTS = 64;
const UTF8 = new TextEncoder();

/**
 * Normalize a user-entered search query without depending on Node globals so
 * the browser and the private mail service enforce the same boundary.
 */
export function normalizeMailSearchQueryText(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    UTF8.encode(value).byteLength < 1 ||
    UTF8.encode(value).byteLength > MAX_SEARCH_QUERY_BYTES
  ) {
    return null;
  }
  const terms = value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length < 1 || terms.length > MAX_SEARCH_TERMS) {
    return null;
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if ([...term].length > MAX_SEARCH_TERM_CODE_POINTS) return null;
    if (!seen.has(term)) {
      seen.add(term);
      unique.push(term);
    }
  }
  if (unique.length < 1 || unique.length > MAX_SEARCH_TERMS) return null;
  return unique.join(" ");
}
