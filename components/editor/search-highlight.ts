import {
  collapseSearchWhitespace,
  type SearchTextTarget,
} from "@/lib/search-navigation";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { pageRefVisibleText } from "./page-ref";

interface HighlightRange {
  from: number;
  to: number;
  kind: "inline" | "node";
}

export type SearchTargetResolution =
  | { status: "exact"; ranges: HighlightRange[] }
  | { status: "missing" | "ambiguous"; ranges: [] };

interface SearchHighlightPluginState {
  requestId: number;
  decorations: DecorationSet;
}

type SearchHighlightMeta =
  | {
      type: "show";
      requestId: number;
      ranges: HighlightRange[];
    }
  | { type: "clear"; requestId?: number };

interface IndexedCharacter {
  from: number;
  to: number;
  kind: "inline" | "node";
}

interface IndexedDocumentText {
  text: string;
  characters: IndexedCharacter[];
}

export const searchHighlightPluginKey =
  new PluginKey<SearchHighlightPluginState>("brainSearchHighlight");

function appendNormalizedCharacter(
  output: string[],
  characters: IndexedCharacter[],
  character: string,
  position: IndexedCharacter,
) {
  if (/\s/.test(character)) {
    if (output.length === 0 || output.at(-1) === " ") return;
    output.push(" ");
    characters.push(position);
    return;
  }
  output.push(character);
  characters.push(position);
}

function indexedDocumentText(doc: ProseMirrorNode): IndexedDocumentText {
  const output: string[] = [];
  const characters: IndexedCharacter[] = [];
  let previousTextEnd: number | null = null;

  doc.descendants((node, position) => {
    if (node.type.name !== "page_ref" && (!node.isText || !node.text)) return;
    if (
      previousTextEnd !== null &&
      position > previousTextEnd &&
      output.at(-1) !== " "
    ) {
      appendNormalizedCharacter(output, characters, " ", {
        from: position,
        to: position,
        kind: "inline",
      });
    }
    const visibleText =
      node.type.name === "page_ref"
        ? pageRefVisibleText(node)
        : node.isText
          ? node.text
          : null;
    if (!visibleText) return;
    for (let index = 0; index < visibleText.length; index += 1) {
      appendNormalizedCharacter(
        output,
        characters,
        visibleText[index],
        node.type.name === "page_ref"
          ? {
              from: position,
              to: position + node.nodeSize,
              kind: "node",
            }
          : {
              from: position + index,
              to: position + index + 1,
              kind: "inline",
            },
      );
    }
    previousTextEnd =
      node.type.name === "page_ref"
        ? position + node.nodeSize
        : position + visibleText.length;
  });

  while (output.at(-1) === " ") {
    output.pop();
    characters.pop();
  }
  return { text: output.join(""), characters };
}

function allOccurrences(value: string, exact: string): number[] {
  const occurrences: number[] = [];
  let cursor = value.indexOf(exact);
  while (cursor !== -1) {
    occurrences.push(cursor);
    cursor = value.indexOf(exact, cursor + 1);
  }
  return occurrences;
}

function contextMatches(
  documentText: string,
  start: number,
  exactLength: number,
  before: string,
  after: string,
): boolean {
  const actualBefore = documentText.slice(
    Math.max(0, start - before.length),
    start,
  );
  const actualAfter = documentText.slice(
    start + exactLength,
    start + exactLength + after.length,
  );
  return (
    (!before || actualBefore.endsWith(before)) &&
    (!after || actualAfter.startsWith(after))
  );
}

function rangesForMatch(
  characters: IndexedCharacter[],
  start: number,
  end: number,
): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  for (let index = start; index < end; index += 1) {
    const character = characters[index];
    if (!character || character.to <= character.from) continue;
    const previous = ranges.at(-1);
    const canMerge =
      previous?.kind === "inline" &&
      character.kind === "inline" &&
      character.from <= previous.to;
    const sameNode =
      previous?.kind === "node" &&
      character.kind === "node" &&
      character.from === previous.from &&
      character.to === previous.to;
    if (previous && (canMerge || sameNode)) {
      previous.to = Math.max(previous.to, character.to);
    } else {
      ranges.push({ ...character });
    }
  }
  return ranges;
}

export function resolveSearchTextTarget(
  doc: ProseMirrorNode,
  target: SearchTextTarget,
): SearchTargetResolution {
  const indexed = indexedDocumentText(doc);
  const documentText = indexed.text.toLocaleLowerCase();
  const exact = collapseSearchWhitespace(target.exact)
    .trim()
    .toLocaleLowerCase();
  if (!exact) return { status: "missing", ranges: [] };

  const before = collapseSearchWhitespace(target.before).toLocaleLowerCase();
  const after = collapseSearchWhitespace(target.after).toLocaleLowerCase();
  const occurrences = allOccurrences(documentText, exact);
  if (occurrences.length === 0) return { status: "missing", ranges: [] };

  const expected = occurrences[target.occurrence];
  let selected: number | undefined;
  if (
    expected !== undefined &&
    contextMatches(documentText, expected, exact.length, before, after)
  ) {
    selected = expected;
  } else {
    const contextual = occurrences.filter((candidate) =>
      contextMatches(documentText, candidate, exact.length, before, after),
    );
    if (contextual.length === 1) selected = contextual[0];
    else return { status: "ambiguous", ranges: [] };
  }

  const ranges = rangesForMatch(
    indexed.characters,
    selected,
    selected + exact.length,
  );
  return ranges.length > 0
    ? { status: "exact", ranges }
    : { status: "missing", ranges: [] };
}

export function createSearchHighlightPlugin() {
  return new Plugin<SearchHighlightPluginState | null>({
    key: searchHighlightPluginKey,
    state: {
      init: () => null,
      apply(transaction, current) {
        const meta = transaction.getMeta(
          searchHighlightPluginKey,
        ) as SearchHighlightMeta | undefined;
        if (meta?.type === "show") {
          return {
            requestId: meta.requestId,
            decorations: DecorationSet.create(
              transaction.doc,
              meta.ranges.map(({ from, to, kind }) => {
                const attributes = {
                  class: "brain-search-match",
                  "data-search-highlight": String(meta.requestId),
                };
                return kind === "node"
                  ? Decoration.node(from, to, attributes)
                  : Decoration.inline(from, to, attributes);
              }),
            ),
          };
        }
        if (
          meta?.type === "clear" &&
          (meta.requestId === undefined ||
            current?.requestId === meta.requestId)
        ) {
          return null;
        }
        if (transaction.docChanged) return null;
        return current;
      },
    },
    props: {
      decorations(state) {
        return searchHighlightPluginKey.getState(state)?.decorations ?? null;
      },
    },
  });
}

export const searchHighlight = $prose(() => createSearchHighlightPlugin());

export function showSearchHighlight(
  view: EditorView,
  requestId: number,
  target: SearchTextTarget,
): SearchTargetResolution {
  const resolution = resolveSearchTextTarget(view.state.doc, target);
  const meta: SearchHighlightMeta =
    resolution.status === "exact"
      ? {
          type: "show",
          requestId,
          ranges: resolution.ranges,
        }
      : { type: "clear", requestId };
  const transaction = view.state.tr
    .setMeta(searchHighlightPluginKey, meta)
    .setMeta("addToHistory", false);
  view.dispatch(transaction);
  return resolution;
}

export function clearSearchHighlight(
  view: EditorView,
  requestId?: number,
): void {
  view.dispatch(
    view.state.tr
      .setMeta(searchHighlightPluginKey, {
        type: "clear",
        requestId,
      } satisfies SearchHighlightMeta)
      .setMeta("addToHistory", false),
  );
}
