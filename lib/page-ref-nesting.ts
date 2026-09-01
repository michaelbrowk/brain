import { directiveFromMarkdown } from "mdast-util-directive";
import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";
import { internalPageLinkId } from "./internal-page-link";
import {
  explicitContainerClosing,
  stripStrayDirectiveNodes,
} from "./stray-directives";

export interface StandalonePageRefRemoval {
  markdown: string;
  removed: boolean;
}

export interface StandalonePageRefRestorePoint {
  removedMarkdown: string;
  insertionOffset: number;
}

export interface StandalonePageRefRemovalWithRestore
  extends StandalonePageRefRemoval {
  restorePoint?: StandalonePageRefRestorePoint;
}

export interface StandalonePageRefRestore {
  markdown: string;
  restored: boolean;
}

interface StandalonePageRefOccurrence {
  fingerprint: string;
  removalStart: number;
  removalEnd: number;
}

interface PositionedMarkdownNode {
  type: string;
  name?: string;
  url?: string;
  children?: PositionedMarkdownNode[];
  position?: {
    start?: { offset?: number; column?: number };
    end?: { offset?: number };
  };
}

/** The origin page links are classified against. The browser passes
 *  `window.location.origin`; the Store passes its configured public origin;
 *  null means only relative `/p/<id>` links are page links. Both sides of an
 *  API call have to pass the same origin, or "row n" names different rows. */
export type PageLinkOrigin = string | null | undefined;

function parseBody(markdown: string): PositionedMarkdownNode | null {
  try {
    const root = fromMarkdown(markdown, {
      extensions: [directive()],
      mdastExtensions: [directiveFromMarkdown()],
    }) as PositionedMarkdownNode;
    // The editor turns every directive Brain does not own back into prose
    // and hoists its body into the lane it sat in. Rows are numbered after
    // that, so the same walk runs here — see `lib/stray-directives.ts`.
    stripStrayDirectiveNodes(root, markdown);
    return root;
  } catch {
    return null;
  }
}

/** Every block a page row can sit in, in document order.
 *
 * The document body and a column are *block lanes* — see
 * `components/editor/columns.ts`, which owns that word. A `:::col` is stored as
 * a container directive, so without the directive extension the fence glues
 * itself onto the last paragraph of the column and that row stops looking like
 * a reference at all: `[Card](/p/x)\n:::` parses as a link plus the text
 * `":::"`. The editor drags every row in a column alike, so the Markdown that
 * removal is bound to has to see them alike too. */
function blockLaneChildren(
  root: PositionedMarkdownNode,
): PositionedMarkdownNode[] {
  const blocks: PositionedMarkdownNode[] = [];
  const walk = (parent: PositionedMarkdownNode) => {
    for (const child of parent.children ?? []) {
      if (child.type === "containerDirective" && child.name === "cols") {
        for (const column of child.children ?? []) {
          if (column.type === "containerDirective" && column.name === "col") {
            walk(column);
          }
        }
        continue;
      }
      blocks.push(child);
    }
  };
  walk(root);
  return blocks;
}

function standalonePageRefMatches(
  markdown: string,
  pageId: string,
  origin: PageLinkOrigin,
): StandalonePageRefOccurrence[] {
  if (!pageId) return [];
  const root = parseBody(markdown);
  if (!root) return [];
  const matches: StandalonePageRefOccurrence[] = [];
  for (const paragraph of blockLaneChildren(root)) {
    const link = paragraph.children?.[0];
    // The editor's rule for a page link, `internalPageLinkId`: exactly
    // `/p/<id>`, or the same path on this origin. `[Раздел](/p/x#h)` is an
    // ordinary link in the editor and stays one here — a prefix match once
    // swept it off the disk as if it were the page's row.
    const linkedId =
      paragraph.type === "paragraph" &&
      paragraph.children?.length === 1 &&
      link?.type === "link"
        ? internalPageLinkId(link.url, origin)
        : null;
    if (linkedId !== pageId) continue;

    const start = paragraph.position?.start?.offset;
    const end = paragraph.position?.end?.offset;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      start < 0 ||
      end < start ||
      end > markdown.length
    ) {
      continue;
    }

    // mdast positions exclude optional indentation and trailing spaces. Bind
    // the request to the exact raw paragraph as stored on disk, not to its
    // normalized label, then remove only the surrounding block separator.
    let fingerprintStart = start;
    while (
      fingerprintStart > 0 &&
      (markdown[fingerprintStart - 1] === " " ||
        markdown[fingerprintStart - 1] === "\t")
    ) {
      fingerprintStart -= 1;
    }
    let fingerprintEnd = end;
    while (
      fingerprintEnd < markdown.length &&
      (markdown[fingerprintEnd] === " " || markdown[fingerprintEnd] === "\t")
    ) {
      fingerprintEnd += 1;
    }

    let removalStart = fingerprintStart;
    while (removalStart > 0 && /[\t\n\r ]/.test(markdown[removalStart - 1])) {
      removalStart -= 1;
    }
    let removalEnd = fingerprintEnd;
    if (removalStart === 0) {
      while (
        removalEnd < markdown.length &&
        /[\t\n\r ]/.test(markdown[removalEnd])
      ) {
        removalEnd += 1;
      }
    }
    matches.push({
      fingerprint: markdown.slice(fingerprintStart, fingerprintEnd),
      removalStart,
      removalEnd,
    });
  }
  return matches;
}

/** Exact raw standalone Markdown paragraphs for one page id, in document
 * order across every block lane. Shell uses the dragged row's ordinal to bind a
 * request to the same physical occurrence under the expected parent revision,
 * so this walk and the editor's must enumerate the same rows in the same
 * order — `forEachStandalonePageRef` in `components/editor/page-ref-nesting.ts`
 * is the other half. */
export function standalonePageRefOccurrences(
  markdown: string,
  pageId: string,
  origin?: PageLinkOrigin,
): string[] {
  return standalonePageRefMatches(markdown, pageId, origin).map(
    (match) => match.fingerprint,
  );
}

export function removeStandalonePageRefOccurrence(
  markdown: string,
  pageId: string,
  occurrence: number,
  fingerprint: string,
  origin?: PageLinkOrigin,
): StandalonePageRefRemoval {
  const removal = removeStandalonePageRefOccurrenceWithRestore(
    markdown,
    pageId,
    occurrence,
    fingerprint,
    origin,
  );
  return { markdown: removal.markdown, removed: removal.removed };
}

/** Remove one exact occurrence and retain only the inverse text + position.
 * Shell maps that position through later edits before Undo, so restoring the
 * reference never replaces a newer document snapshot. */
export function removeStandalonePageRefOccurrenceWithRestore(
  markdown: string,
  pageId: string,
  occurrence: number,
  fingerprint: string,
  origin?: PageLinkOrigin,
): StandalonePageRefRemovalWithRestore {
  if (!Number.isInteger(occurrence) || occurrence < 0 || !fingerprint) {
    return { markdown, removed: false };
  }
  const match = standalonePageRefMatches(markdown, pageId, origin)[occurrence];
  if (!match || match.fingerprint !== fingerprint) {
    return { markdown, removed: false };
  }
  return {
    markdown:
      markdown.slice(0, match.removalStart) + markdown.slice(match.removalEnd),
    removed: true,
    restorePoint: {
      removedMarkdown: markdown.slice(match.removalStart, match.removalEnd),
      insertionOffset: match.removalStart,
    },
  };
}

/** Map a saved insertion point through one later text change. This mirrors the
 * stable part of an editor transaction map: edits wholly before/after the
 * point shift or preserve it; a replacement spanning the point is ambiguous
 * and fails closed instead of restoring into the wrong paragraph. */
export function mapMarkdownOffset(
  before: string,
  after: string,
  offset: number,
): number | null {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > before.length
  ) {
    return null;
  }
  if (before === after) return offset;

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
  if (offset <= prefix) return offset;
  if (offset >= beforeChangeEnd) {
    return afterChangeEnd + (offset - beforeChangeEnd);
  }
  return null;
}

export function restoreStandalonePageRefAtOffset(
  markdown: string,
  restorePoint: StandalonePageRefRestorePoint,
): StandalonePageRefRestore {
  const { insertionOffset, removedMarkdown } = restorePoint;
  if (
    !removedMarkdown ||
    !Number.isInteger(insertionOffset) ||
    insertionOffset < 0 ||
    insertionOffset > markdown.length
  ) {
    return { markdown, restored: false };
  }
  return {
    markdown:
      markdown.slice(0, insertionOffset) +
      removedMarkdown +
      markdown.slice(insertionOffset),
    restored: true,
  };
}

/** Remove one whole Markdown paragraph that consists only of a Brain page
 * reference. Inline mentions and any duplicate standalone reference after the
 * first one remain untouched. */
export function removeOneStandalonePageRef(
  markdown: string,
  pageId: string,
  origin?: PageLinkOrigin,
): StandalonePageRefRemoval {
  if (!pageId) return { markdown, removed: false };

  const first = standalonePageRefMatches(markdown, pageId, origin)[0];
  return first
    ? removeStandalonePageRefOccurrence(
        markdown,
        pageId,
        0,
        first.fingerprint,
        origin,
      )
    : { markdown, removed: false };
}

export interface StandalonePageRefSweep {
  markdown: string;
  removed: number;
}

/** Remove every standalone page-reference paragraph for one page id.
 *
 * A move away from a parent makes each of those paragraphs untrue at once, so
 * unlike the editor's single-occurrence removal — which is bound to the exact
 * block a reader dragged — this sweeps all of them. It removes one at a time
 * and re-scans, because two adjacent reference paragraphs have overlapping
 * removal ranges and splicing them in one pass would cut into the wrong text.
 *
 * Inline references inside a sentence are never matched, here or anywhere in
 * this module: `standalonePageRefMatches` only accepts a paragraph whose whole
 * content is the link. */
export function removeStandalonePageRefs(
  markdown: string,
  pageId: string,
  origin?: PageLinkOrigin,
): StandalonePageRefSweep {
  let current = markdown;
  let removed = 0;
  for (;;) {
    const next = removeOneStandalonePageRef(current, pageId, origin);
    if (!next.removed) return { markdown: current, removed };
    current = next.markdown;
    removed += 1;
  }
}

const FENCE_OPENING_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSING_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const CONTAINER_OPENING_RE = /^ {0,3}(:{3,})[^:\s]/;

/** The closing fence an unclosed fenced code block still needs, or undefined
 *  when the block is closed or is indented code. */
function fenceClosing(lines: readonly string[]): string | undefined {
  const opening = FENCE_OPENING_RE.exec(lines[0]);
  if (!opening) return undefined;
  if (lines.length >= 2) {
    const closing = FENCE_CLOSING_RE.exec(lines[lines.length - 1]);
    if (
      closing &&
      closing[1][0] === opening[1][0] &&
      closing[1].length >= opening[1].length
    ) {
      return undefined;
    }
  }
  return opening[1];
}

/** What a body left open at its end — an unclosed fenced code block or
 *  container directive on the chain of last children — as the lines that
 *  close them, innermost first, each indented to the column it was opened
 *  in. Markdown closes all of them at the end of the document, so text
 *  appended after such a body lands inside the innermost one. */
export function openContainerClosers(markdown: string): string[] {
  const root = parseRaw(markdown);
  if (!root) return [];
  const closers: string[] = [];
  let node = root.children?.at(-1);
  while (node) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    const source =
      typeof start === "number" && typeof end === "number"
        ? markdown.slice(start, end)
        : undefined;
    const lines = source?.split(/\r?\n/) ?? [];
    const indent = " ".repeat(Math.max(0, (node.position?.start?.column ?? 1) - 1));
    if (node.type === "code" && lines.length > 0) {
      const closing = fenceClosing(lines);
      if (closing !== undefined) closers.push(indent + closing);
    } else if (node.type === "containerDirective" && lines.length > 0) {
      const opening = CONTAINER_OPENING_RE.exec(lines[0]);
      if (opening && explicitContainerClosing(lines) === undefined) {
        closers.push(indent + opening[1]);
      }
    }
    node = node.children?.at(-1);
  }
  return closers.reverse();
}

/** The raw mdast, with the containers Markdown actually parsed — no stray
 *  directive rewritten — because closing is about what the parser sees. */
function parseRaw(markdown: string): PositionedMarkdownNode | null {
  try {
    return fromMarkdown(markdown, {
      extensions: [directive()],
      mdastExtensions: [directiveFromMarkdown()],
    }) as PositionedMarkdownNode;
  } catch {
    return null;
  }
}

/** A body with one more row: `[label](/p/<pageId>)` as a paragraph of its
 *  own at the top level. Whatever the body left open is closed first, so the
 *  row is a row and not the last line of a code block or the tail of a
 *  column. The result is read back before it is returned; a body this cannot
 *  place a row in — one ending inside an unclosed HTML block, or a fence
 *  inside a blockquote — is refused rather than quietly corrupted. */
export function appendStandalonePageRef(
  markdown: string,
  label: string,
  pageId: string,
  origin?: PageLinkOrigin,
): string {
  const body = markdown.trimEnd();
  const link = `[${label.replace(/([\\[\]])/g, "\\$1")}](/p/${pageId})`;
  const closers = body ? openContainerClosers(body) : [];
  const closed = closers.length > 0 ? `${body}\n${closers.join("\n")}` : body;
  const next = [closed, link].filter(Boolean).join("\n\n");
  const before = standalonePageRefOccurrences(body, pageId, origin).length;
  const after = standalonePageRefOccurrences(next, pageId, origin);
  if (after.length !== before + 1 || after[after.length - 1] !== link) {
    throw new Error(
      `page reference for ${pageId} cannot be appended as a top-level row`,
    );
  }
  return next;
}
