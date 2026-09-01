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
