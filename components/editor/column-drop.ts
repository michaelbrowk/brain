import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { claimsPageRefNesting } from "./page-ref-nesting";

type ColumnSide = "left" | "right";

type BlockInfo = {
  node: ProseNode;
  pos: number;
  parent: ProseNode;
  parentDepth: number;
  parentPos: number | null;
};

type SideDropTarget = {
  kind: "side";
  pos: number;
  side: ColumnSide;
  rect: DOMRect;
};

type InsideDropTarget = {
  kind: "inside";
  colPos: number;
  insertPos: number;
  rect: DOMRect;
  lineY: number;
};

type DropTarget = SideDropTarget | InsideDropTarget;

type NormalizeOp = {
  node: ProseNode;
  pos: number;
  kept: ProseNode[];
};

const columnDropKey = new PluginKey("brainColumnDrop");

/** Where a block may be picked up from and re-laid-out. Deliberately weaker
 *  than the block-lane rule in `columns.ts`: layout does not care whether the
 *  column belongs to the page or to a callout, only that it is a column. */
function isColumnParent(doc: ProseNode, pos: number, parentDepth: number) {
  const $pos = doc.resolve(pos);
  const parent = $pos.node(parentDepth);
  if (parent.type.name === "doc") return true;
  return (
    parent.type.name === "col" &&
    parentDepth > 0 &&
    $pos.node(parentDepth - 1).type.name === "cols"
  );
}

function parentStart(doc: ProseNode, pos: number, parentDepth: number) {
  if (parentDepth === 0) return null;
  return doc.resolve(pos).before(parentDepth);
}

function blockAt(doc: ProseNode, pos: number): BlockInfo | null {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) return null;

  const $pos = doc.resolve(pos);
  const node = $pos.nodeAfter;
  if (!node?.isBlock) return null;
  if (!isColumnParent(doc, pos, $pos.depth)) return null;

  return {
    node,
    pos,
    parent: $pos.parent,
    parentDepth: $pos.depth,
    parentPos: parentStart(doc, pos, $pos.depth),
  };
}

function blockAround(doc: ProseNode, rawPos: number): BlockInfo | null {
  const pos = Math.max(0, Math.min(rawPos, doc.content.size));
  const exact = blockAt(doc, pos);
  if (exact && exact.node.type.name !== "cols") return exact;

  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    const node = $pos.node(depth);
    if (!node.isBlock || node.type.name === "cols") continue;

    const parentDepth = depth - 1;
    if (!isColumnParent(doc, pos, parentDepth)) continue;

    return {
      node,
      pos: $pos.before(depth),
      parent: $pos.node(parentDepth),
      parentDepth,
      parentPos: parentStart(doc, pos, parentDepth),
    };
  }

  const before = $pos.nodeBefore;
  if (!before?.isBlock) return null;
  return blockAt(doc, pos - before.nodeSize);
}

function isEmptyColumn(node: ProseNode) {
  return (
    node.type.name === "col" &&
    node.childCount === 1 &&
    node.child(0).type.name === "paragraph" &&
    node.child(0).content.size === 0
  );
}

function findNormalizeOp(doc: ProseNode): NormalizeOp | null {
  let op: NormalizeOp | null = null;

  doc.descendants((node, pos) => {
    if (op || node.type.name !== "cols") return !op;

    const kept: ProseNode[] = [];
    let emptyCount = 0;
    node.forEach((child) => {
      if (isEmptyColumn(child)) emptyCount += 1;
      else kept.push(child);
    });

    if (kept.length < 2 || emptyCount > 0) {
      op = { node, pos, kept };
      return false;
    }

    return true;
  });

  return op;
}

function normalizeColumns(tr: Transaction) {
  for (;;) {
    const op = findNormalizeOp(tr.doc);
    if (!op) return tr;

    const end = op.pos + op.node.nodeSize;
    if (op.kept.length === 0) {
      const paragraph = tr.doc.type.schema.nodes.paragraph?.createAndFill();
      if (!paragraph) return tr.delete(op.pos, end);
      tr.replaceWith(op.pos, end, paragraph);
      continue;
    }

    if (op.kept.length === 1) {
      tr.replaceWith(op.pos, end, op.kept[0].content);
      continue;
    }

    tr.replaceWith(op.pos, end, op.node.type.create(op.node.attrs, op.kept));
  }
}

export function performColumnDrop(
  state: EditorState,
  draggedFrom: number,
  targetPos: number,
  side: ColumnSide,
): Transaction | null {
  const source = blockAt(state.doc, draggedFrom);
  const target = blockAt(state.doc, targetPos);
  const colsType = state.schema.nodes.cols;
  const colType = state.schema.nodes.col;

  if (!source || !target || !colsType || !colType) return null;
  if (source.node.type.name === "cols" || target.node.type.name === "cols") return null;
  if (source.pos === target.pos) return null;
  if (target.pos > source.pos && target.pos < source.pos + source.node.nodeSize) return null;

  const tr = state.tr.delete(source.pos, source.pos + source.node.nodeSize);
  const mappedTargetPos = tr.mapping.map(target.pos);
  const mappedTarget = blockAt(tr.doc, mappedTargetPos);
  if (!mappedTarget || mappedTarget.node.type.name === "cols") return null;

  const draggedCol = colType.create(null, source.node);

  if (mappedTarget.parent.type.name === "doc") {
    const targetCol = colType.create(null, mappedTarget.node);
    const content = side === "left" ? [draggedCol, targetCol] : [targetCol, draggedCol];
    const columns = colsType.create(null, content);
    tr.replaceWith(mappedTarget.pos, mappedTarget.pos + mappedTarget.node.nodeSize, columns);
    return normalizeColumns(tr);
  }

  if (mappedTarget.parent.type.name === "col" && mappedTarget.parentPos !== null) {
    const insertPos =
      side === "left"
        ? mappedTarget.parentPos
        : mappedTarget.parentPos + mappedTarget.parent.nodeSize;
    tr.insert(insertPos, draggedCol);
    return normalizeColumns(tr);
  }

  return null;
}

/** Move a block into an existing column. This is deliberately separate from
 *  performColumnDrop: a drop in the body of a column means "put it here", while
 *  a narrow side-edge drop means "make another column". */
export function performColumnMove(
  state: EditorState,
  draggedFrom: number,
  targetColPos: number,
  targetInsertPos: number,
): Transaction | null {
  const source = blockAt(state.doc, draggedFrom);
  const targetCol = state.doc.nodeAt(targetColPos);

  if (!source || source.node.type.name === "cols") return null;
  if (!targetCol || targetCol.type.name !== "col") return null;
  if (source.parentPos === targetColPos) return null;

  const targetStart = targetColPos + 1;
  const targetEnd = targetColPos + targetCol.nodeSize - 1;
  if (targetInsertPos < targetStart || targetInsertPos > targetEnd) return null;

  const tr = state.tr.delete(source.pos, source.pos + source.node.nodeSize);
  const mappedColPos = tr.mapping.map(targetColPos);
  const mappedInsertPos = tr.mapping.map(targetInsertPos);
  const mappedCol = tr.doc.nodeAt(mappedColPos);
  if (!mappedCol || mappedCol.type.name !== "col") return null;

  const mappedStart = mappedColPos + 1;
  const mappedEnd = mappedColPos + mappedCol.nodeSize - 1;
  if (isEmptyColumn(mappedCol)) {
    tr.replaceWith(mappedStart, mappedEnd, source.node);
  } else {
    tr.insert(
      Math.max(mappedStart, Math.min(mappedInsertPos, mappedEnd)),
      source.node,
    );
  }

  return normalizeColumns(tr);
}

/** The element the drop indicator is appended beside, and the one drag state
 *  is flagged on so CSS can answer it (`data-col-drop`, `data-file-refused`). */
export function editorWrapper(view: EditorView) {
  return (view.dom.closest(".relative") as HTMLElement | null) ?? view.dom.parentElement ?? view.dom;
}

function eventSideDropTarget(view: EditorView, event: DragEvent): SideDropTarget | null {
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!coords) return null;

  const target = blockAround(view.state.doc, coords.pos);
  if (!target || target.node.type.name === "cols") return null;

  const dom = view.nodeDOM(target.pos);
  const element = dom instanceof HTMLElement ? dom : dom?.parentElement;
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  // a tight fixed zone — 15% of a narrow column swallowed half the block and
  // made vertical reordering inside columns impossible
  const zone = 20;
  const fromLeft = event.clientX - rect.left;
  const fromRight = rect.right - event.clientX;
  const leftActive = fromLeft >= 0 && fromLeft <= zone;
  const rightActive = fromRight >= 0 && fromRight <= zone;

  if (!leftActive && !rightActive) return null;

  // vertical intent wins: if the pointer is closer to the block's top/bottom
  // edge than to its side, the user is reordering — let the normal drop happen
  const dVert = Math.min(
    Math.abs(event.clientY - rect.top),
    Math.abs(rect.bottom - event.clientY),
  );
  const dEdge = Math.min(
    leftActive ? fromLeft : Infinity,
    rightActive ? fromRight : Infinity,
  );
  if (dVert < dEdge) return null;

  return {
    kind: "side",
    pos: target.pos,
    side: leftActive && rightActive ? (fromLeft <= fromRight ? "left" : "right") : leftActive ? "left" : "right",
    rect,
  };
}

function columnAtElement(
  view: EditorView,
  element: HTMLElement,
): { node: ProseNode; pos: number } | null {
  let found: { node: ProseNode; pos: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found || node.type.name !== "col") return !found;
    const dom = view.nodeDOM(pos);
    const domElement = dom instanceof HTMLElement ? dom : dom?.parentElement;
    if (domElement === element) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  if (found) return found;

  // nodeDOM() can resolve a decoration wrapper rather than the schema node in
  // some ProseMirror builds. A position inside the first real child always has
  // the owning col in its resolved ancestor chain.
  const probe = element.firstElementChild ?? element;
  try {
    const rawPos = view.posAtDOM(probe, 0, 1);
    const pos = Math.max(0, Math.min(rawPos, view.state.doc.content.size));
    const $pos = view.state.doc.resolve(pos);
    for (let depth = $pos.depth; depth >= 1; depth -= 1) {
      const node = $pos.node(depth);
      if (node.type.name === "col") return { node, pos: $pos.before(depth) };
    }
  } catch {
    return null;
  }
  return found;
}

/** The entire visible column lane is a drop target, including the whitespace
 *  below its last block. This makes moving a block back out of a neighbouring
 *  column discoverable instead of requiring a pixel-perfect drop cursor. */
function eventInsideDropTarget(
  view: EditorView,
  event: DragEvent,
  source: BlockInfo,
): InsideDropTarget | null {
  const columns = Array.from(
    view.dom.querySelectorAll<HTMLElement>(".brain-cols > .brain-col"),
  );
  const element = columns.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  });
  if (!element) return null;

  const column = columnAtElement(view, element);
  if (!column || source.parentPos === column.pos) return null;

  const rect = element.getBoundingClientRect();
  let insertPos = column.pos + 1;
  let lineY = rect.top;
  let chosen = false;

  column.node.forEach((child, offset) => {
    if (chosen) return;
    const childPos = column.pos + 1 + offset;
    const dom = view.nodeDOM(childPos);
    const childElement = dom instanceof HTMLElement ? dom : dom?.parentElement;
    if (!childElement) return;
    const childRect = childElement.getBoundingClientRect();
    if (event.clientY <= childRect.top + childRect.height / 2) {
      insertPos = childPos;
      lineY = childRect.top;
      chosen = true;
      return;
    }
    insertPos = childPos + child.nodeSize;
    lineY = childRect.bottom;
  });

  return { kind: "inside", colPos: column.pos, insertPos, rect, lineY };
}

function eventDropTarget(view: EditorView, event: DragEvent): DropTarget | null {
  const { selection } = view.state;
  if (!(selection instanceof NodeSelection)) return null;
  const source = blockAt(view.state.doc, selection.from);
  if (!source) return null;
  // One pointer, one promise. The centre band of a standalone page row is the
  // nesting gesture's; a whole column lane is this one's — and the lane
  // contains the band. Yield it, or the reader sees an insertion line and a
  // nest ring at once and the release does whichever plugin is listed first.
  if (claimsPageRefNesting(view, event)) return null;

  const inside = eventInsideDropTarget(view, event, source);
  const side = eventSideDropTarget(view, event);
  // Once a block already lives in a column, another column's whole lane means
  // "move into it". For a document-level block, the narrow side edge retains
  // the existing create-a-column gesture; the rest of the lane still accepts it.
  return source.parent.type.name === "col" ? inside ?? side : side ?? inside;
}

/** Drag a block to another block's side to make columns (Notion-style).
 *
 *  SAFETY (this feature broke normal block reordering once — never again):
 *  `dragover` is PURELY PASSIVE. It only draws an overlay indicator and NEVER
 *  returns true / never preventDefaults — so ProseMirror's own dropcursor and
 *  the block plugin's reordering pipeline are never disturbed on any drag. The
 *  editor is only taken over on `drop`, and ONLY when the pointer was in a
 *  narrow side-edge column zone AND the transform succeeds. For every normal
 *  reorder drop the handler returns false immediately and PM behaves exactly as
 *  before. Every handler is wrapped so a thrown error can't break dragging. */
export const columnDrop = [
  $prose(() => {
    let indicator: HTMLDivElement | null = null;
    let active: DropTarget | null = null;

    const cleanup = (view: EditorView) => {
      indicator?.remove();
      indicator = null;
      active = null;
      try {
        editorWrapper(view).removeAttribute("data-col-drop");
      } catch {
        /* view may be gone */
      }
    };

    const show = (view: EditorView, target: DropTarget) => {
      const wrapper = editorWrapper(view);
      const wrapperRect = wrapper.getBoundingClientRect();

      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = "brain-col-drop-indicator";
      }
      if (indicator.parentElement !== wrapper) wrapper.append(indicator);
      indicator.dataset.kind = target.kind;
      if (target.kind === "side") {
        const x = target.side === "left" ? target.rect.left : target.rect.right;
        indicator.style.left = `${x - wrapperRect.left + wrapper.scrollLeft}px`;
        indicator.style.top = `${target.rect.top - wrapperRect.top + wrapper.scrollTop}px`;
        indicator.style.width = "2px";
        indicator.style.height = `${target.rect.height}px`;
      } else {
        indicator.style.left = `${target.rect.left - wrapperRect.left + wrapper.scrollLeft}px`;
        indicator.style.top = `${target.lineY - wrapperRect.top + wrapper.scrollTop}px`;
        indicator.style.width = `${target.rect.width}px`;
        indicator.style.height = "2px";
      }
      // hides PM's horizontal dropcursor via CSS while a column drop is armed
      wrapper.setAttribute("data-col-drop", "true");
      active = target;
    };

    return new Plugin({
      key: columnDropKey,
      view: (view) => {
        // dragend/drop fire on the drag SOURCE (the handle, outside view.dom) —
        // catch at the window level so a cancelled drag can't strand the overlay
        const windowCleanup = () => cleanup(view);
        window.addEventListener("dragend", windowCleanup);
        window.addEventListener("drop", windowCleanup);
        return {
          destroy: () => {
            window.removeEventListener("dragend", windowCleanup);
            window.removeEventListener("drop", windowCleanup);
            cleanup(view);
          },
        };
      },
      props: {
        handleDOMEvents: {
          // PASSIVE — observe only, never signal "handled"
          dragover: (view, event) => {
            try {
              if (!view.dragging) {
                if (active) cleanup(view);
                return false;
              }
              const target = eventDropTarget(view, event as DragEvent);
              if (!target) {
                if (active) cleanup(view);
                return false;
              }
              show(view, target);
            } catch {
              cleanup(view);
            }
            return false; // NEVER take over dragover — PM's pipeline stays intact
          },
          // only take over a drop that lands in an armed column zone
          drop: (view, event) => {
            if (!active) return false; // normal reorder → PM handles it
            const armed = active;
            cleanup(view);
            try {
              const { selection } = view.state;
              if (!(selection instanceof NodeSelection)) return false;
              const tr =
                armed.kind === "inside"
                  ? performColumnMove(
                      view.state,
                      selection.from,
                      armed.colPos,
                      armed.insertPos,
                    )
                  : performColumnDrop(
                      view.state,
                      selection.from,
                      armed.pos,
                      armed.side,
                    );
              if (!tr) return false;
              event.preventDefault();
              view.dispatch(tr.setMeta("uiEvent", "drop").scrollIntoView());
              view.focus();
              return true;
            } catch {
              return false;
            }
          },
          dragleave: (view, event) => {
            const related = (event as DragEvent).relatedTarget;
            if (!(related instanceof Node) || !editorWrapper(view).contains(related)) cleanup(view);
            return false;
          },
        },
      },
    });
  }),
].flat();
