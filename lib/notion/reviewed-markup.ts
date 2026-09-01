import { fromMarkdown } from "mdast-util-from-markdown";
import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import type { NotionSnapshotV2Node } from "./snapshot-v2.ts";

// The reviewed inventory is a closed policy, not a description of anyone's
// workspace: Notion `<aside>` blocks and the literal tags below are allowed on
// these page ids, in these counts, and nowhere else. The ids are synthetic, in
// the shape the tests use for a page that exists only in a fixture
// (`"1".repeat(32)`), so a tree holding none of them normalizes nothing and
// still gets the "nowhere else" half of the rule. An operator converting a real
// export names its own pages and counts here before it runs.
const syntheticReviewedPageId = (digit: string): string => digit.repeat(32);

export const PERSONAL_REVIEWED_CALLOUT_SPECS = [
  { notionId: syntheticReviewedPageId("3"), count: 1 },
  { notionId: syntheticReviewedPageId("4"), count: 2 },
  { notionId: syntheticReviewedPageId("5"), count: 3 },
  { notionId: syntheticReviewedPageId("6"), count: 1 },
] as const;

export const PERSONAL_REVIEWED_LITERAL_SPECS = [
  {
    notionId: syntheticReviewedPageId("7"),
    token: "<insert-here/>",
    count: 1,
  },
  {
    notionId: syntheticReviewedPageId("8"),
    token: "</content>",
    count: 1,
  },
  {
    notionId: syntheticReviewedPageId("8"),
    token: "</invoke>",
    count: 1,
  },
] as const;

const CALLOUT_SPECS = PERSONAL_REVIEWED_CALLOUT_SPECS;
const LITERAL_SPECS = PERSONAL_REVIEWED_LITERAL_SPECS;

const REVIEWED_PAGE_IDS = new Set<string>([
  ...CALLOUT_SPECS.map((spec) => spec.notionId),
  ...LITERAL_SPECS.map((spec) => spec.notionId),
]);

export interface NotionReviewedMarkupReport {
  version: 1;
  callouts: readonly { notionId: string; count: number }[];
  literals: readonly {
    notionId: string;
    token: string;
    count: number;
    representation: "escaped_text_v1";
  }[];
}

export interface NormalizedNotionReviewedMarkup {
  markdownByNotionId: ReadonlyMap<string, string>;
  report: NotionReviewedMarkupReport;
}

interface MarkdownNode {
  type?: string;
  name?: string;
  value?: string;
  attributes?: Record<string, unknown> | null;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: MarkdownNode[];
}

interface OffsetRange {
  start: number;
  end: number;
}

interface AsideTag {
  type: "open" | "close";
  lineStart: number;
  lineEnd: number;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

const graphemeSegmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

/** Normalize only the pages the inventory above names. A page the inventory
 * names but the tree does not hold is skipped, so a tree with none of them
 * normalizes nothing; any occurrence outside the closed page/token/count
 * inventory still fails before a snapshot is produced. */
export function normalizeReviewedPersonalMarkup(
  pages: ReadonlyMap<string, string>,
): NormalizedNotionReviewedMarkup {
  const normalized = new Map<string, string>();
  for (const [notionId, source] of pages) {
    const calloutSpec = CALLOUT_SPECS.find((spec) => spec.notionId === notionId);
    const literalSpecs = LITERAL_SPECS.filter((spec) => spec.notionId === notionId);
    const sourceLiteralOffsets = literalTokenOffsetsByToken(source);
    const sourceAsideCount = asideTagCount(source);
    if (!calloutSpec && sourceAsideCount > 0) {
      throw new Error("Notion aside markup appeared outside its reviewed page");
    }
    for (const spec of LITERAL_SPECS) {
      const count = sourceLiteralOffsets.get(spec.token)?.length ?? 0;
      if (notionId !== spec.notionId && count > 0) {
        throw new Error("Notion literal markup appeared outside its reviewed page");
      }
    }

    let markdown = source;
    if (calloutSpec) {
      markdown = normalizeAsideCallouts(markdown, calloutSpec.count);
    }
    if (literalSpecs.length > 0) {
      markdown = normalizeLiteralTokens(
        markdown,
        literalSpecs,
        sourceLiteralOffsets,
      );
    }
    normalized.set(notionId, markdown);
  }

  const report = reviewedPersonalMarkupReport();
  assertReviewedMarkupSnapshot("personal", mapAsNodes(normalized), report);
  return { markdownByNotionId: normalized, report };
}

export function emptyNotionReviewedMarkupReport(): NotionReviewedMarkupReport {
  return { version: 1, callouts: [], literals: [] };
}

/** Neutralize only the opening `<` of already-normalized literal tokens for
 * unsupported-HTML detection. Keeping the rest of the line, including the
 * closing `>`, prevents a token from hiding a surrounding foreign tag. The
 * returned Markdown bytes are never persisted. */
export function maskReviewedEscapedLiteralsForValidation(
  notionId: string,
  input: string,
): string {
  const replacements: Replacement[] = [];
  for (const spec of LITERAL_SPECS) {
    if (spec.notionId !== notionId) continue;
    for (const offset of tokenOffsets(input, spec.token)) {
      if (precedingBackslashCount(input, offset) === 1) {
        replacements.push({
          start: offset,
          end: offset + 1,
          value: "",
        });
      }
    }
  }
  return applyReplacements(input, replacements);
}

/** Re-derive the closed normalized inventory before operator materialization.
 * Snapshot/source hashes commit the exact icons, bodies, placement, and escaped
 * literal bytes. The report is an additional two-capture policy boundary. */
export function assertReviewedMarkupSnapshot(
  scope: "personal" | "channel",
  nodes: readonly Pick<
    NotionSnapshotV2Node,
    "kind" | "notionId" | "enhancedMarkdown"
  >[],
  report: NotionReviewedMarkupReport,
): void {
  const expected =
    scope === "personal"
      ? reviewedPersonalMarkupReport()
      : emptyNotionReviewedMarkupReport();
  if (stableJson(report) !== stableJson(expected)) {
    throw new Error("Notion reviewed-markup report does not match the closed policy");
  }
  const reviewedNodes = new Map<
    string,
    Pick<NotionSnapshotV2Node, "kind" | "notionId" | "enhancedMarkdown">
  >();
  for (const node of nodes) {
    if (!REVIEWED_PAGE_IDS.has(node.notionId)) continue;
    if (reviewedNodes.has(node.notionId)) {
      throw new Error("reviewed Notion page appeared more than once in the snapshot");
    }
    reviewedNodes.set(node.notionId, node);
  }
  if (scope === "personal") {
    // A snapshot carrying none of the inventoried pages is the ordinary case —
    // a tree that has none of them. What cannot vary is the shape of the ones
    // it does carry.
    for (const node of reviewedNodes.values()) {
      if (node.kind !== "page") {
        throw new Error("reviewed Notion markup must belong to a page node");
      }
    }
  }

  for (const node of nodes) {
    const expectedCallouts =
      scope === "personal"
        ? (CALLOUT_SPECS.find((spec) => spec.notionId === node.notionId)?.count ?? 0)
        : 0;
    if (normalizedCalloutCount(node.enhancedMarkdown) !== expectedCallouts) {
      throw new Error(
        REVIEWED_PAGE_IDS.has(node.notionId)
          ? "reviewed Notion callout inventory changed"
          : "reviewed Notion markup appeared outside its closed page set",
      );
    }
    for (const spec of LITERAL_SPECS) {
      const expectedLiterals =
        scope === "personal" && node.notionId === spec.notionId
          ? spec.count
          : 0;
      if (
        escapedVisibleLiteralTokenOffsets(node.enhancedMarkdown, spec.token).length !==
        expectedLiterals
      ) {
        throw new Error(
          REVIEWED_PAGE_IDS.has(node.notionId)
            ? "reviewed Notion literal inventory changed"
            : "reviewed Notion markup appeared outside its closed page set",
        );
      }
    }
  }
}

function normalizeAsideCallouts(markdown: string, expectedCount: number): string {
  const tags = asideTags(markdown);
  if (tags.length !== expectedCount * 2) {
    throw new Error("reviewed Notion aside occurrence count changed");
  }
  const replacements: Replacement[] = [];
  let open: AsideTag | null = null;
  for (const tag of tags) {
    if (tag.type === "open") {
      if (open) throw new Error("reviewed Notion aside blocks cannot nest");
      open = tag;
      continue;
    }
    if (!open) throw new Error("reviewed Notion aside block is unbalanced");
    const bodyStart = open.lineEnd + 1;
    if (bodyStart > tag.lineStart) {
      throw new Error("reviewed Notion aside block has no body line");
    }
    const bodyEnd =
      tag.lineStart > bodyStart && markdown[tag.lineStart - 1] === "\n"
        ? tag.lineStart - 1
        : tag.lineStart;
    const body = markdown.slice(bodyStart, bodyEnd);
    const normalized = calloutFromAsideBody(body);
    replacements.push({
      start: open.lineStart,
      end: tag.lineEnd,
      value: normalized,
    });
    open = null;
  }
  if (open) throw new Error("reviewed Notion aside block is unbalanced");
  if (replacements.length !== expectedCount) {
    throw new Error("reviewed Notion aside block count changed");
  }
  return applyReplacements(markdown, replacements);
}

function asideTagCount(markdown: string): number {
  return asideTags(markdown).length;
}

function asideTags(markdown: string): AsideTag[] {
  const codeRanges = markdownCodeRanges(markdown);
  const tags: AsideTag[] = [];
  let lineStart = 0;
  for (const line of markdown.split("\n")) {
    const lineEnd = lineStart + line.length;
    const token = /<\/?aside\b/i.exec(line);
    if (token && !rangeOverlaps(codeRanges, lineStart + token.index, lineEnd)) {
      const exact = line.trim();
      if (exact !== "<aside>" && exact !== "</aside>") {
        throw new Error("reviewed Notion aside tag or attributes changed");
      }
      const tokenOffset = lineStart + line.indexOf(exact);
      if (rangeOverlaps(codeRanges, tokenOffset, tokenOffset + exact.length)) {
        lineStart = lineEnd + 1;
        continue;
      }
      tags.push({
        type: exact === "<aside>" ? "open" : "close",
        lineStart,
        lineEnd,
      });
    }
    lineStart = lineEnd + 1;
  }
  return tags;
}

function calloutFromAsideBody(sourceBody: string): string {
  const lines = sourceBody.split("\n");
  if (
    lines.at(-1) !== "" ||
    (lines.length > 1 && lines.at(-2)?.trim().length === 0)
  ) {
    throw new Error("reviewed Notion aside structural trailing blank changed");
  }
  lines.pop();
  const contentLine = lines.findIndex((line) => line.trim().length > 0);
  if (contentLine < 0) throw new Error("reviewed Notion aside body is empty");
  const line = lines[contentLine];
  if (line !== line.trimStart()) {
    throw new Error("reviewed Notion aside icon line gained indentation");
  }
  const first = graphemeSegmenter.segment(line)[Symbol.iterator]().next().value as
    | { segment: string }
    | undefined;
  const icon = first?.segment;
  if (!icon || !isEmojiGrapheme(icon)) {
    throw new Error("reviewed Notion aside must begin with one emoji grapheme");
  }
  const rest = line.slice(icon.length);
  const separator = /^( +)(.+)$/u.exec(rest);
  if (!separator || separator[2].trim().length === 0) {
    throw new Error("reviewed Notion aside emoji must be followed by content");
  }
  if (/[\u0000-\u001f\u007f"{}]/u.test(icon)) {
    throw new Error("reviewed Notion aside icon is unsafe for a directive attribute");
  }
  lines[contentLine] = separator[2];
  const body = lines.join("\n");
  assertNoNestedContainerDirectives(body);
  const fence = directiveFence(body);
  return `${fence}callout{icon="${icon}"}\n${body}\n${fence}`;
}

function assertNoNestedContainerDirectives(body: string): void {
  const visit = (node: MarkdownNode): void => {
    if (node.type === "containerDirective") {
      throw new Error("reviewed Notion callout body cannot contain nested directives");
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(reviewedMarkdownTree(body));
}

function isEmojiGrapheme(input: string): boolean {
  return /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3/u.test(
    input,
  );
}

function directiveFence(body: string): string {
  const longest = Math.max(
    0,
    ...body
      .split("\n")
      .map((line) => /^ {0,3}(:{3,})/.exec(line)?.[1].length ?? 0),
  );
  return ":".repeat(Math.max(3, longest + 1));
}

function normalizeLiteralTokens(
  markdown: string,
  specs: readonly (typeof LITERAL_SPECS)[number][],
  offsetsByToken: ReadonlyMap<string, readonly number[]>,
): string {
  const replacements: Replacement[] = [];
  for (const spec of specs) {
    const offsets = offsetsByToken.get(spec.token) ?? [];
    const textualOffsets = tokenOffsetsOutsideCode(markdown, spec.token);
    if (
      textualOffsets.length !== offsets.length ||
      textualOffsets.some((offset, index) => offset !== offsets[index])
    ) {
      throw new Error("reviewed Notion literal token source form changed");
    }
    if (offsets.length !== spec.count) {
      throw new Error("reviewed Notion literal token count changed");
    }
    for (const offset of offsets) {
      if (precedingBackslashCount(markdown, offset) !== 0) {
        throw new Error("reviewed Notion literal token gained a source escape");
      }
      replacements.push({
        start: offset,
        end: offset + spec.token.length,
        value: `\\${spec.token}`,
      });
    }
  }
  return applyReplacements(markdown, replacements);
}

function literalTokenOffsetsByToken(
  markdown: string,
): ReadonlyMap<string, readonly number[]> {
  const expected = new Set<string>(LITERAL_SPECS.map((spec) => spec.token));
  const offsets = new Map<string, number[]>(
    [...expected].map((token) => [token, []]),
  );
  const visit = (node: MarkdownNode): void => {
    if (node.type === "code" || node.type === "inlineCode") return;
    if (node.type === "html" && node.value && expected.has(node.value)) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        markdown.slice(start, end) !== node.value
      ) {
        throw new Error("reviewed Notion literal token has unstable source offsets");
      }
      offsets.get(node.value)?.push(start);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(markdown) as MarkdownNode);
  return offsets;
}

function escapedVisibleLiteralTokenOffsets(markdown: string, token: string): number[] {
  const offsets: number[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "html") {
      return;
    }
    if (node.type === "text") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (typeof start !== "number" || typeof end !== "number") {
        throw new Error("reviewed Notion literal text has unstable source offsets");
      }
      const textValueCount = tokenOffsets(node.value ?? "", token).length;
      const nodeOffsets: number[] = [];
      let cursor = start;
      for (;;) {
        const offset = markdown.indexOf(token, cursor);
        if (offset < 0 || offset + token.length > end) break;
        if (precedingBackslashCount(markdown, offset) === 1) {
          nodeOffsets.push(offset);
        }
        cursor = offset + token.length;
      }
      if (textValueCount !== nodeOffsets.length) {
        throw new Error("reviewed Notion literal visible representation changed");
      }
      offsets.push(...nodeOffsets);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(reviewedMarkdownTree(markdown));
  return offsets;
}

function tokenOffsetsOutsideCode(markdown: string, token: string): number[] {
  const ranges = markdownCodeRanges(markdown);
  const offsets: number[] = [];
  let cursor = 0;
  for (;;) {
    const offset = markdown.indexOf(token, cursor);
    if (offset < 0) break;
    if (!rangeOverlaps(ranges, offset, offset + token.length)) offsets.push(offset);
    cursor = offset + token.length;
  }
  return offsets;
}

function precedingBackslashCount(markdown: string, offset: number): number {
  let backslashes = 0;
  for (let index = offset - 1; index >= 0 && markdown[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes;
}

function tokenOffsets(input: string, token: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (;;) {
    const offset = input.indexOf(token, cursor);
    if (offset < 0) return offsets;
    offsets.push(offset);
    cursor = offset + token.length;
  }
}

function normalizedCalloutCount(markdown: string): number {
  const ranges = markdownCodeRanges(markdown);
  let count = 0;
  let open: { fenceLength: number } | null = null;
  let lineStart = 0;
  for (const line of markdown.split("\n")) {
    const lineEnd = lineStart + line.length;
    if (!rangeOverlaps(ranges, lineStart, lineEnd)) {
      const directiveLine = /^ {0,3}(:{3,})(.*)$/u.exec(line);
      const tail = directiveLine?.[2] ?? "";
      const calloutLike = /^callout(?:$|[\s[{])/u.test(tail);
      if (calloutLike) {
        const match = /^callout\{icon="([^"]+)"\}$/u.exec(tail);
        if (!directiveLine || !match) {
          throw new Error("reviewed Notion callout opening syntax changed");
        }
        if (open) throw new Error("reviewed Notion callouts cannot nest");
        assertSafeSingleEmojiGrapheme(match[1]);
        open = { fenceLength: directiveLine[1].length };
        count += 1;
      } else if (open && directiveLine && tail.trim().length === 0) {
        const closingLength = directiveLine[1].length;
        if (closingLength >= open.fenceLength) {
          if (closingLength !== open.fenceLength) {
            throw new Error("reviewed Notion callout fences must match exactly");
          }
          open = null;
        }
      }
    }
    lineStart = lineEnd + 1;
  }
  if (open) throw new Error("reviewed Notion callout is unbalanced");
  if (semanticNormalizedCalloutCount(markdown) !== count) {
    throw new Error("reviewed Notion callout directive structure changed");
  }
  return count;
}

function semanticNormalizedCalloutCount(markdown: string): number {
  let count = 0;
  const visit = (
    node: MarkdownNode,
    parentType: string | undefined,
    insideCallout: boolean,
  ): void => {
    if (node.type === "containerDirective") {
      if (insideCallout) {
        throw new Error("reviewed Notion callout body cannot contain nested directives");
      }
      if (node.name !== "callout") {
        for (const child of node.children ?? []) visit(child, node.type, false);
        return;
      }
      if (parentType !== "root") {
        throw new Error("reviewed Notion callouts cannot nest");
      }
      const attributes = node.attributes ?? {};
      if (
        Object.keys(attributes).length !== 1 ||
        typeof attributes.icon !== "string"
      ) {
        throw new Error("reviewed Notion callout attributes changed");
      }
      assertSafeSingleEmojiGrapheme(attributes.icon);
      count += 1;
      for (const child of node.children ?? []) visit(child, node.type, true);
      return;
    }
    for (const child of node.children ?? []) {
      visit(child, node.type, insideCallout);
    }
  };
  visit(reviewedMarkdownTree(markdown), undefined, false);
  return count;
}

function assertSafeSingleEmojiGrapheme(input: string): void {
  const graphemes = [...graphemeSegmenter.segment(input)].map(
    (segment) => segment.segment,
  );
  if (
    graphemes.length !== 1 ||
    graphemes[0] !== input ||
    !isEmojiGrapheme(input)
  ) {
    throw new Error("reviewed Notion callout icon must be one emoji grapheme");
  }
  if (/[\u0000-\u001f\u007f"{}]/u.test(input)) {
    throw new Error("reviewed Notion callout icon is unsafe for a directive attribute");
  }
}

function markdownCodeRanges(markdown: string): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (typeof start === "number" && typeof end === "number") {
        ranges.push({ start, end });
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(reviewedMarkdownTree(markdown));
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function reviewedMarkdownTree(markdown: string): MarkdownNode {
  return fromMarkdown(markdown, {
    extensions: [directive()],
    mdastExtensions: [directiveFromMarkdown()],
  }) as MarkdownNode;
}

function rangeOverlaps(
  ranges: readonly OffsetRange[],
  start: number,
  end: number,
): boolean {
  return ranges.some((range) => range.start < end && range.end > start);
}

function applyReplacements(markdown: string, replacements: readonly Replacement[]): string {
  let result = markdown;
  for (const replacement of [...replacements].sort(
    (left, right) => right.start - left.start,
  )) {
    result =
      result.slice(0, replacement.start) +
      replacement.value +
      result.slice(replacement.end);
  }
  return result;
}

function reviewedPersonalMarkupReport(): NotionReviewedMarkupReport {
  return {
    version: 1,
    callouts: CALLOUT_SPECS.map((spec) => ({ ...spec })),
    literals: LITERAL_SPECS.map((spec) => ({
      ...spec,
      representation: "escaped_text_v1" as const,
    })),
  };
}

function mapAsNodes(
  pages: ReadonlyMap<string, string>,
): Array<
  Pick<NotionSnapshotV2Node, "kind" | "notionId" | "enhancedMarkdown">
> {
  return [...pages].map(([notionId, enhancedMarkdown]) => ({
    kind: "page",
    notionId,
    enhancedMarkdown,
  }));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
