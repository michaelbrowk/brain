// Page-ref effect reconciliation: after a remove / restore of a `[[id]]`
// reference, decide from the page body whether the effect landed, was
// undone, or can no longer be told apart from concurrent edits.
// Extracted verbatim from shell.tsx (S1 of the shell extraction).

import { standalonePageRefOccurrences } from "@/lib/page-ref-nesting";

export type PageRefEffectReceipt = {
  beforeMarkdown: string;
  afterMarkdown: string;
  beforeOffset: number;
  afterOffset: number;
  text: string;
} & (
  | {
      kind: "remove";
      pageRefId: string;
      fingerprint: string;
    }
  | { kind: "restore" }
);
export type PageRefEffectReconciliation = {
  state: "applied" | "not-applied" | "ambiguous";
  mappedOffset?: number;
};

/** Prove that every concurrent text change stayed wholly outside an operation
 * range. A change touching either boundary is ambiguous and fails closed. */
export function mapRangeThroughOutsideChanges(
  before: string,
  after: string,
  rangeStart: number,
  rangeEnd: number,
): number | null {
  if (
    !Number.isInteger(rangeStart) ||
    !Number.isInteger(rangeEnd) ||
    rangeStart < 0 ||
    rangeEnd < rangeStart ||
    rangeEnd > before.length
  ) {
    return null;
  }
  if (before === after) return rangeStart;

  const protectedText = before.slice(rangeStart, rangeEnd);
  if (protectedText) {
    const candidates: number[] = [];
    let searchFrom = 0;
    while (searchFrom <= after.length - protectedText.length) {
      const candidate = after.indexOf(protectedText, searchFrom);
      if (candidate < 0) break;
      candidates.push(candidate);
      searchFrom = candidate + 1;
    }
    const suffix = before.slice(rangeEnd);
    if (suffix) {
      const suffixMatches = candidates.filter(
        (candidate) =>
          after.slice(candidate + protectedText.length) === suffix,
      );
      if (suffixMatches.length === 1) return suffixMatches[0];
      if (suffixMatches.length > 1) return null;
    }
    const prefixText = before.slice(0, rangeStart);
    if (prefixText) {
      const prefixMatches = candidates.filter(
        (candidate) => after.slice(0, candidate) === prefixText,
      );
      if (prefixMatches.length === 1) return prefixMatches[0];
      if (prefixMatches.length > 1) return null;
    }
  }

  let prefix = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(
    before.length - prefix,
    after.length - prefix,
  );
  while (
    suffix < suffixLimit &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeChangeEnd = before.length - suffix;
  const afterChangeEnd = after.length - suffix;
  if (beforeChangeEnd < rangeStart && prefix < rangeStart) {
    return rangeStart + (after.length - before.length);
  }
  if (
    rangeEnd > rangeStart &&
    beforeChangeEnd === rangeStart &&
    prefix === rangeStart &&
    after.slice(afterChangeEnd, afterChangeEnd + (rangeEnd - rangeStart)) ===
      before.slice(rangeStart, rangeEnd)
  ) {
    return afterChangeEnd;
  }
  if (prefix > rangeEnd && beforeChangeEnd > rangeEnd) {
    return rangeStart;
  }
  return null;
}

export function reconcilePageRefEffect(
  receipt: PageRefEffectReceipt,
  currentMarkdown: string,
  origin: string | null = null,
): PageRefEffectReconciliation {
  const removing = receipt.kind === "remove";
  let beforeOffset = mapRangeThroughOutsideChanges(
    receipt.beforeMarkdown,
    currentMarkdown,
    receipt.beforeOffset,
    receipt.beforeOffset + (removing ? receipt.text.length : 0),
  );
  let afterOffset = mapRangeThroughOutsideChanges(
    receipt.afterMarkdown,
    currentMarkdown,
    receipt.afterOffset,
    receipt.afterOffset + (removing ? 0 : receipt.text.length),
  );
  let afterMappedToIdenticalText = false;
  if (beforeOffset !== null) {
    const textPresent =
      currentMarkdown.slice(
        beforeOffset,
        beforeOffset + receipt.text.length,
      ) === receipt.text;
    if (textPresent === !removing) beforeOffset = null;
  }
  if (afterOffset !== null) {
    const textPresent =
      currentMarkdown.slice(
        afterOffset,
        afterOffset + receipt.text.length,
      ) === receipt.text;
    if (textPresent === removing) {
      afterMappedToIdenticalText = removing;
      afterOffset = null;
    }
  }
  if (
    removing &&
    beforeOffset !== null &&
    currentMarkdown === receipt.beforeMarkdown
  ) {
    const identityOccurrences = standalonePageRefOccurrences(
      receipt.beforeMarkdown,
      receipt.pageRefId,
      origin,
    ).filter((fingerprint) => fingerprint === receipt.fingerprint).length;
    if (identityOccurrences !== 1) beforeOffset = null;
  }
  if (
    removing &&
    beforeOffset !== null &&
    afterMappedToIdenticalText
  ) {
    const originalPrefix = receipt.beforeMarkdown.slice(
      0,
      receipt.beforeOffset,
    );
    const originalSuffix = receipt.beforeMarkdown.slice(
      receipt.beforeOffset + receipt.text.length,
    );
    const currentPrefix = currentMarkdown.slice(0, beforeOffset);
    const currentSuffix = currentMarkdown.slice(
      beforeOffset + receipt.text.length,
    );
    const exactLeftAnchor =
      originalPrefix.length > 0 &&
      (currentPrefix.startsWith(originalPrefix) ||
        currentPrefix.endsWith(originalPrefix));
    const exactRightAnchor =
      originalSuffix.length > 0 &&
      (currentSuffix.startsWith(originalSuffix) ||
        currentSuffix.endsWith(originalSuffix));
    if (
      currentMarkdown !== receipt.beforeMarkdown &&
      !(exactLeftAnchor && exactRightAnchor)
    ) {
      beforeOffset = null;
    }
  }
  if (afterOffset !== null && beforeOffset === null) {
    return { state: "applied", mappedOffset: afterOffset };
  }
  if (beforeOffset !== null && afterOffset === null) {
    return { state: "not-applied", mappedOffset: beforeOffset };
  }
  return { state: "ambiguous" };
}
