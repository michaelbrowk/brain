import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { resolveDropZone } from "@/lib/drop-zone";
import type { TreeNode } from "@/lib/store/types";
import { isBlockLaneDepth, isBlockLaneElement } from "./columns";

const COLUMN_SIDE_ZONE_PX = 20;
const pageRefNestingKey = new PluginKey("brainPageRefNesting");
export const BRAIN_PAGE_REF_DRAG_MIME = "application/x-brain-page-ref+json";
export const BRAIN_PAGE_REF_EXTERNAL_ACCEPT_EVENT =
  "brain:page-ref-external-accept";
const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
let activePageRefDragSource: PageRefNestingSource | null = null;

export interface PageRefNestingIntent {
  sourceId: string;
  targetId: string;
}

export interface PageRefNestingSource {
  id: string;
  occurrence: number;
  label?: string;
}

export type PageRefNestingScope = "sibling" | "tree";

export interface PageRefNestingIntentInput {
  sourceId: string;
  targetId: string;
  clientX: number;
  clientY: number;
  targetLeft: number;
  targetTop: number;
  targetWidth: number;
  targetHeight: number;
}

export interface PageRefNestingRequest {
  operationId: string;
  result: Promise<boolean>;
}

export type ReparentPageRef = (
  source: PageRefNestingSource,
  targetId: string,
  scope?: PageRefNestingScope,
) => PageRefNestingRequest | null;
export type RequestRemovePageRef = (source: PageRefNestingSource) => void;

/** Read-only client-local drag identity. Browsers deliberately hide custom
 * DataTransfer payloads during dragover, so sidebar preflight uses the source
 * captured by this tab's accepted editor dragstart instead. */
export function getActivePageRefDragSource(): Readonly<PageRefNestingSource> | null {
  return activePageRefDragSource ? { ...activePageRefDragSource } : null;
}

export function pageRefDragSourcesMatch(
  left: PageRefNestingSource | null,
  right: PageRefNestingSource | null,
): boolean {
  return !!left && !!right && left.id === right.id && left.occurrence === right.occurrence;
}

function setActivePageRefDragSource(source: PageRefNestingSource): void {
  activePageRefDragSource = { ...source };
}

function clearActivePageRefDragSource(): void {
  activePageRefDragSource = null;
}

export type PageRefNestingTargetValidation =
  | { valid: true; cleanupRetry: boolean }
  | { valid: false; cleanupRetry: false };

function findTreePath(tree: TreeNode[], id: string): TreeNode[] {
  for (const node of tree) {
    if (node.id === id) return [node];
    const childPath = findTreePath(node.children, id);
    if (childPath.length) return [node, ...childPath];
  }
  return [];
}

/** Structural preflight shared by the sidebar's visual drop state and the
 * mutation callback. It stays pure so dragover cannot toast or start work. */
export function validatePageRefNestingTarget({
  tree,
  pageId,
  source: dragged,
  targetId,
  scope = "sibling",
}: {
  tree: TreeNode[];
  pageId: string | null;
  source: PageRefNestingSource;
  targetId: string;
  scope?: PageRefNestingScope;
}): PageRefNestingTargetValidation {
  const sourcePath = findTreePath(tree, dragged.id);
  const targetPath = findTreePath(tree, targetId);
  const parentPagePath = pageId ? findTreePath(tree, pageId) : [];
  const source = sourcePath.at(-1);
  const target = targetPath.at(-1);
  const directSiblingNest =
    !!pageId && source?.parentId === pageId && target?.parentId === pageId;
  const staleSiblingCleanup =
    !!pageId && source?.parentId === targetId && target?.parentId === pageId;
  const staleTreeCleanup =
    scope === "tree" && !!pageId && source?.parentId === targetId;
  const cleanupRetry =
    scope === "tree" ? staleTreeCleanup : staleSiblingCleanup;
  const treeTargetMove =
    scope === "tree" &&
    !!pageId &&
    source?.parentId !== targetId;
  const placementAllowed =
    scope === "tree"
      ? treeTargetMove || staleTreeCleanup
      : directSiblingNest || staleSiblingCleanup;
  const invalid =
    !pageId ||
    dragged.id === targetId ||
    dragged.id === pageId ||
    targetId === pageId ||
    !Number.isInteger(dragged.occurrence) ||
    dragged.occurrence < 0 ||
    !source ||
    !target ||
    !placementAllowed ||
    !!source.collectionRow ||
    !!target.collection ||
    !!target.collectionRow ||
    targetPath.some((node) => node.id === dragged.id) ||
    parentPagePath.some((node) => node.id === dragged.id);
  return invalid
    ? { valid: false, cleanupRetry: false }
    : { valid: true, cleanupRetry };
}

export function acceptExternalPageRefNesting(
  request: PageRefNestingRequest,
): void {
  window.dispatchEvent(
    new CustomEvent(BRAIN_PAGE_REF_EXTERNAL_ACCEPT_EVENT, { detail: request }),
  );
}

/** Freeze the old editor snapshot synchronously before an accepted structural
 * drop can blur or serialize it. Internal and sidebar drops share this bridge. */
export function freezeAcceptedPageRefNesting({
  editor,
  source,
  request,
  onAccepted,
  onFrozenChange,
}: {
  editor: HTMLElement;
  source: HTMLElement;
  request: PageRefNestingRequest;
  onAccepted?: () => void;
  onFrozenChange: (frozen: boolean) => void;
}): () => void {
  try {
    onAccepted?.();
  } catch {}
  onFrozenChange(true);
  const previousEditable = editor.getAttribute("contenteditable");
  editor.setAttribute("contenteditable", "false");
  editor.setAttribute("aria-busy", "true");
  source.setAttribute("data-page-ref-nest-pending", "true");
  let settled = false;
  const unfreeze = () => {
    if (settled) return;
    settled = true;
    onFrozenChange(false);
    source.removeAttribute("data-page-ref-nest-pending");
    if (editor.isConnected) {
      if (previousEditable === null) editor.removeAttribute("contenteditable");
      else editor.setAttribute("contenteditable", previousEditable);
      editor.removeAttribute("aria-busy");
    }
  };
  void request.result.then(unfreeze, unfreeze);
  return unfreeze;
}

export function encodePageRefDragPayload(
  source: PageRefNestingSource,
): string {
  return JSON.stringify({
    id: source.id,
    occurrence: source.occurrence,
    ...(source.label ? { label: source.label } : {}),
  });
}

export function decodePageRefDragPayload(
  value: string,
): PageRefNestingSource | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !PAGE_ID_RE.test(typeof parsed.id === "string" ? parsed.id : "") ||
      !Number.isSafeInteger(parsed.occurrence) ||
      typeof parsed.occurrence !== "number" ||
      parsed.occurrence < 0 ||
      (parsed.label !== undefined &&
        (typeof parsed.label !== "string" || parsed.label.length > 1_024))
    ) {
      return null;
    }
    return {
      id: parsed.id as string,
      occurrence: parsed.occurrence,
      ...(typeof parsed.label === "string" && parsed.label.trim()
        ? { label: parsed.label.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Every standalone page row in the document, in document order, walking into
 * column lanes and nothing else. This is the document half of the enumeration
 * `standalonePageRefAnchors` does on the DOM: same rows, same order, so an
 * `occurrence` measured against one addresses the same block in the other.
 *
 * The walk descends a `cols` only when it reaches one as a lane child, which is
 * what makes lane-ness transitive here as well — a `cols` inside a callout is
 * never entered, so nothing inside it is ever a row. */
export function forEachStandalonePageRef(
  doc: ProseNode,
  visit: (id: string, node: ProseNode, pos: number) => void,
): void {
  const walk = (lane: ProseNode, contentStart: number) => {
    lane.forEach((node, offset) => {
      const pos = contentStart + offset;
      const id = pageRefId(node);
      if (id) {
        visit(id, node, pos);
        return;
      }
      if (node.type.name !== "cols") return;
      node.forEach((column, columnOffset) => {
        // pos + 1 enters the `cols`, + 1 again enters the column itself.
        if (column.type.name === "col") walk(column, pos + columnOffset + 2);
      });
    });
  };
  walk(doc, 0);
}

/** How many standalone rows for `id` come before `pos`. */
function occurrenceBefore(doc: ProseNode, id: string, pos: number): number {
  let occurrence = 0;
  forEachStandalonePageRef(doc, (candidate, _node, candidatePos) => {
    if (candidatePos < pos && candidate === id) occurrence += 1;
  });
  return occurrence;
}

function pageRefCounts(doc: ProseNode): Map<string, number> {
  const counts = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name !== "page_ref") return;
    const id = node.attrs.id;
    if (typeof id === "string" && id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  });
  return counts;
}

/** Find the exact standalone occurrence removed by an editor transaction.
 * Inline refs are intentionally ignored, and converting a standalone ref into
 * an inline mention is not a removal because the total ref count is unchanged. */
export function findRemovedStandalonePageRef(
  before: ProseNode,
  after: ProseNode,
  selectionFrom: number,
  selectionTo: number,
): PageRefNestingSource | null {
  if (before.eq(after)) return null;
  const beforeCounts = pageRefCounts(before);
  const afterCounts = pageRefCounts(after);
  const occurrences = new Map<string, number>();
  const candidates: Array<PageRefNestingSource & { from: number; to: number }> =
    [];

  forEachStandalonePageRef(before, (id, node, position) => {
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    if ((afterCounts.get(id) ?? 0) < (beforeCounts.get(id) ?? 0)) {
      candidates.push({
        id,
        occurrence,
        from: position,
        to: position + node.nodeSize,
      });
    }
  });
  if (!candidates.length) return null;

  const rangeFrom = Math.min(selectionFrom, selectionTo);
  const rangeTo = Math.max(selectionFrom, selectionTo);
  const selected =
    candidates.find(
      (candidate) =>
        rangeFrom <= candidate.from && rangeTo >= candidate.to,
    ) ??
    candidates.find(
      (candidate) =>
        rangeFrom <= candidate.to && rangeTo >= candidate.from,
    ) ??
    candidates.reduce((nearest, candidate) => {
      const distance = Math.min(
        Math.abs(rangeFrom - candidate.from),
        Math.abs(rangeFrom - candidate.to),
      );
      const nearestDistance = Math.min(
        Math.abs(rangeFrom - nearest.from),
        Math.abs(rangeFrom - nearest.to),
      );
      return distance < nearestDistance ? candidate : nearest;
    });
  const node = before.nodeAt(selected.from);
  const label = node?.firstChild?.attrs.label;
  return {
    id: selected.id,
    occurrence: selected.occurrence,
    ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
  };
}

/** The middle of another page block means "make this page its child". The
 * upper/lower zones deliberately remain unclaimed so Milkdown's stock
 * before/after reorder keeps working exactly as it did before. */
export function resolvePageRefNestingIntent({
  sourceId,
  targetId,
  clientX,
  clientY,
  targetLeft,
  targetTop,
  targetWidth,
  targetHeight,
}: PageRefNestingIntentInput): PageRefNestingIntent | null {
  if (
    !sourceId ||
    !targetId ||
    sourceId === targetId ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(targetLeft) ||
    !Number.isFinite(targetTop) ||
    !Number.isFinite(targetWidth) ||
    !Number.isFinite(targetHeight) ||
    targetWidth <= COLUMN_SIDE_ZONE_PX * 2 ||
    targetHeight <= 0
  ) {
    return null;
  }
  const horizontalOffset = clientX - targetLeft;
  if (
    horizontalOffset <= COLUMN_SIDE_ZONE_PX ||
    horizontalOffset >= targetWidth - COLUMN_SIDE_ZONE_PX
  ) {
    return null;
  }
  const zone = resolveDropZone({ clientY, targetTop, targetHeight });
  if (zone !== "into") return null;
  return { sourceId, targetId };
}

interface StandalonePageRef {
  id: string;
  node: ProseNode;
  pos: number;
  occurrence: number;
  element: HTMLElement;
  paragraph: HTMLElement;
}

interface StandalonePageRefDom {
  id: string;
  element: HTMLElement;
  paragraph: HTMLElement;
}

function rowAnchor(paragraph: HTMLElement): HTMLElement | null {
  return (
    Array.from(paragraph.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.matches("a[data-page-ref]"),
    ) ?? null
  );
}

/** Resolve a standalone page row from either its title or the empty row area
 * around it. Keeping this DOM-only and exported makes the two hit contracts
 * (title drag source and whole-row drop target) directly testable.
 *
 * The row must sit directly in a block lane — the document body or a column.
 * A page link inside a list item, a quote, a callout or a toggle is prose about
 * a page, not a row of this page's children, and stays out of the gesture. */
export function resolveStandalonePageRefDom(
  editor: HTMLElement,
  target: EventTarget | null,
): StandalonePageRefDom | null {
  if (!(target instanceof Element)) return null;
  const paragraph = target.closest<HTMLElement>("p.brain-page-ref-only");
  if (!paragraph || !isBlockLaneElement(editor, paragraph.parentElement)) {
    return null;
  }
  const element = rowAnchor(paragraph);
  const id = element?.dataset.pageRef ?? "";
  return element && id ? { id, element, paragraph } : null;
}

/** Every standalone page row's title anchor, in document order across every
 * lane. `occurrence` is an index into this list filtered by page id, so the
 * three places that need one — the drag, the pending marker, the row menu —
 * must all count the same rows in the same order. Exported so they do. */
export function standalonePageRefAnchors(editor: HTMLElement): HTMLElement[] {
  return Array.from(
    editor.querySelectorAll<HTMLElement>("p.brain-page-ref-only"),
  )
    .filter((paragraph) => isBlockLaneElement(editor, paragraph.parentElement))
    .map(rowAnchor)
    .filter(
      (anchor): anchor is HTMLElement => !!anchor?.dataset.pageRef,
    );
}

function pageRefId(node: ProseNode | null | undefined): string | null {
  if (
    node?.type.name !== "paragraph" ||
    node.childCount !== 1 ||
    node.firstChild?.type.name !== "page_ref"
  ) {
    return null;
  }
  const id = node.firstChild.attrs.id;
  return typeof id === "string" && id ? id : null;
}

function selectedStandalonePageRef(view: EditorView): StandalonePageRef | null {
  const { selection } = view.state;
  if (!(selection instanceof NodeSelection)) return null;
  const node = view.state.doc.nodeAt(selection.from);
  const id = pageRefId(node);
  const $pos = view.state.doc.resolve(selection.from);
  if (!node || !id || !isBlockLaneDepth($pos, $pos.depth)) return null;
  const dom = view.nodeDOM(selection.from);
  const paragraph = dom instanceof HTMLElement ? dom : dom?.parentElement;
  if (!paragraph || !isBlockLaneElement(view.dom, paragraph.parentElement)) {
    return null;
  }
  const element = paragraph.querySelector<HTMLElement>("a[data-page-ref]");
  if (element?.dataset.pageRef !== id) return null;
  return {
    id,
    node,
    pos: selection.from,
    occurrence: occurrenceBefore(view.state.doc, id, selection.from),
    element,
    paragraph,
  };
}

function standalonePageRefFromDom(
  view: EditorView,
  target: EventTarget | null,
): StandalonePageRef | null {
  const resolved = resolveStandalonePageRefDom(view.dom, target);
  if (!resolved) return null;
  let found: { node: ProseNode; pos: number } | null = null;
  forEachStandalonePageRef(view.state.doc, (id, node, pos) => {
    if (found || id !== resolved.id) return;
    const dom = view.nodeDOM(pos);
    const paragraph = dom instanceof HTMLElement ? dom : dom?.parentElement;
    if (paragraph === resolved.paragraph) found = { node, pos };
  });
  if (!found) return null;
  const located = found as { node: ProseNode; pos: number };
  return {
    id: resolved.id,
    node: located.node,
    pos: located.pos,
    occurrence: occurrenceBefore(view.state.doc, resolved.id, located.pos),
    element: resolved.element,
    paragraph: resolved.paragraph,
  };
}

function targetStandalonePageRef(
  view: EditorView,
  event: DragEvent,
): { id: string; element: HTMLElement; rect: DOMRect } | null {
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const target = resolveStandalonePageRefDom(view.dom, hit);
  if (!target) return null;
  const rect = target.paragraph.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  // Keep the transient attribute on the page-ref NodeView. ProseMirror owns the
  // paragraph decoration and can replace that outer DOM node during dragover.
  return { id: target.id, element: target.element, rect };
}

interface NestingArm {
  intent: PageRefNestingIntent;
  source: StandalonePageRef;
  target: { id: string; element: HTMLElement; rect: DOMRect };
}

function resolveNestingArm(view: EditorView, event: DragEvent): NestingArm | null {
  const source = selectedStandalonePageRef(view);
  const target = targetStandalonePageRef(view, event);
  if (!source || !target) return null;
  const intent = resolvePageRefNestingIntent({
    sourceId: source.id,
    targetId: target.id,
    clientX: event.clientX,
    clientY: event.clientY,
    targetLeft: target.rect.left,
    targetTop: target.rect.top,
    targetWidth: target.rect.width,
    targetHeight: target.rect.height,
  });
  return intent ? { intent, source, target } : null;
}

/** True when this plugin claims the event: the drag carries a standalone page
 * row and the pointer is in the centre band of another one.
 *
 * `column-drop.ts` listens to the same drag over the same rows and would
 * otherwise propose a layout move for a pointer already promising a nest — two
 * indicators for one gesture, then whichever `drop` handler runs first wins.
 * It asks here and yields, so the two outcomes are exclusive by construction
 * rather than by plugin order. */
export function claimsPageRefNesting(view: EditorView, event: DragEvent): boolean {
  try {
    return !!view.dragging && !!resolveNestingArm(view, event);
  } catch {
    return false;
  }
}

function findExactStandalonePageRef(
  view: EditorView,
  source: StandalonePageRef,
): StandalonePageRef | null {
  const exact = view.state.doc.nodeAt(source.pos);
  if (pageRefId(exact) === source.id && exact?.eq(source.node)) {
    return source;
  }
  return null;
}

/** Adds only the new centre-drop intent. Normal edge drops pass straight
 * through to Milkdown. An accepted structural move is server-first: the exact
 * source block stays visible while the composite request runs, and document
 * edits are briefly frozen. Success remounts authoritative Markdown in Shell;
 * failure needs no local rollback because no transaction was applied. */
export function createPageRefNesting(
  onReparent: ReparentPageRef,
  initiallyFrozen = false,
  onAccepted?: () => void,
  onRequestRemove?: RequestRemovePageRef,
) {
  return $prose(() => {
    let documentFrozen = initiallyFrozen;
    let unfreeze: (() => void) | null = null;
    let titleDragging = false;
    let externalDragSource: StandalonePageRef | null = null;
    let active:
      | {
          intent: PageRefNestingIntent;
          source: StandalonePageRef;
          target: HTMLElement;
        }
      | null = null;

    const cleanup = () => {
      active?.target.removeAttribute("data-page-ref-nest-target");
      active = null;
    };

    const freezeRequest = (
      view: EditorView,
      source: StandalonePageRef,
      request: PageRefNestingRequest,
    ) => {
      unfreeze?.();
      unfreeze = freezeAcceptedPageRefNesting({
        editor: view.dom,
        source: source.element,
        request,
        onAccepted,
        onFrozenChange: (frozen) => {
          documentFrozen = frozen;
        },
      });
    };

    const arm = (view: EditorView, event: DragEvent) => {
      const armed = resolveNestingArm(view, event);
      if (!armed) {
        if (active) cleanup();
        return;
      }
      if (active?.target !== armed.target.element) cleanup();
      armed.target.element.setAttribute("data-page-ref-nest-target", "true");
      active = {
        intent: armed.intent,
        source: armed.source,
        target: armed.target.element,
      };
    };

    return new Plugin({
      key: pageRefNestingKey,
      view: (view) => {
        const externalAccept = (rawEvent: Event) => {
          if (
            documentFrozen ||
            !titleDragging ||
            !externalDragSource ||
            !(rawEvent instanceof CustomEvent)
          ) {
            return;
          }
          const request = rawEvent.detail as PageRefNestingRequest | undefined;
          if (
            !request ||
            typeof request.operationId !== "string" ||
            !(request.result instanceof Promise)
          ) {
            return;
          }
          const source = findExactStandalonePageRef(view, externalDragSource);
          if (source) freezeRequest(view, source, request);
        };
        const windowCleanup = () => {
          cleanup();
          clearActivePageRefDragSource();
          if (!titleDragging) return;
          titleDragging = false;
          externalDragSource = null;
          view.dragging = null;
          view.dom.dataset.dragging = "false";
        };
        window.addEventListener(
          BRAIN_PAGE_REF_EXTERNAL_ACCEPT_EVENT,
          externalAccept,
        );
        window.addEventListener("dragend", windowCleanup);
        window.addEventListener("drop", windowCleanup);
        return {
          destroy: () => {
            window.removeEventListener(
              BRAIN_PAGE_REF_EXTERNAL_ACCEPT_EVENT,
              externalAccept,
            );
            window.removeEventListener("dragend", windowCleanup);
            window.removeEventListener("drop", windowCleanup);
            clearActivePageRefDragSource();
            unfreeze?.();
            cleanup();
          },
        };
      },
      filterTransaction: (transaction, state) => {
        if (documentFrozen && transaction.docChanged) return false;
        if (!transaction.docChanged || !onRequestRemove) return true;
        const removed = findRemovedStandalonePageRef(
          state.doc,
          transaction.doc,
          state.selection.from,
          state.selection.to,
        );
        if (!removed) return true;
        onRequestRemove(removed);
        return false;
      },
      props: {
        handleDOMEvents: {
          dragstart: (view, rawEvent) => {
            if (documentFrozen) return false;
            const event = rawEvent as DragEvent;
            const anchor =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>("a[data-page-ref]")
                : null;
            if (!anchor || !event.dataTransfer) return false;
            const source = standalonePageRefFromDom(view, anchor);
            if (!source) return false;

            const selection = NodeSelection.create(view.state.doc, source.pos);
            view.dispatch(view.state.tr.setSelection(selection));
            const slice = selection.content();
            const { dom, text } = view.serializeForClipboard(slice);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.clearData();
            event.dataTransfer.setData("text/html", dom.innerHTML);
            event.dataTransfer.setData("text/plain", text);
            const dragSource = {
              id: source.id,
              occurrence: source.occurrence,
              label: source.element.textContent?.trim() || undefined,
            } satisfies PageRefNestingSource;
            event.dataTransfer.setData(
              BRAIN_PAGE_REF_DRAG_MIME,
              encodePageRefDragPayload(dragSource),
            );
            const rect = source.paragraph.getBoundingClientRect();
            event.dataTransfer.setDragImage(
              source.paragraph,
              Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
              Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
            );
            view.dragging = { slice, move: true };
            view.dom.dataset.dragging = "true";
            titleDragging = true;
            externalDragSource = source;
            setActivePageRefDragSource(dragSource);
            // The browser keeps the native drag alive, but ProseMirror must not
            // replace this whole-paragraph payload with a plain URL drag.
            return true;
          },
          dragover: (view, rawEvent) => {
            try {
              if (documentFrozen || !view.dragging) {
                if (active) cleanup();
                return false;
              }
              arm(view, rawEvent as DragEvent);
            } catch {
              cleanup();
            }
            // Passive until drop: edge reorder and its drop cursor remain stock.
            return false;
          },
          drop: (view, event) => {
            if (!active) return false;
            const armed = active;
            cleanup();
            clearActivePageRefDragSource();
            event.preventDefault();
            const source = findExactStandalonePageRef(view, armed.source);
            if (!source) return true;
            let request: PageRefNestingRequest | null = null;
            try {
              request = onReparent(
                {
                  id: armed.intent.sourceId,
                  occurrence: armed.source.occurrence,
                },
                armed.intent.targetId,
              );
            } catch {
              return true;
            }
            // A synchronous rejection (for example, another active move) owns
            // this centre drop but must not mutate the document.
            if (!request) return true;
            // Freeze before contenteditable=false can trigger blur.
            freezeRequest(view, source, request);
            return true;
          },
          dragleave: (view, event) => {
            const related = (event as DragEvent).relatedTarget;
            if (!(related instanceof Node) || !view.dom.contains(related)) {
              cleanup();
            }
            return false;
          },
        },
      },
    });
  });
}
