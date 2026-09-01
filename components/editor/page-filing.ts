import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import {
  asFilePageRefDetail,
  BRAIN_FILE_PAGE_EVENT,
  BRAIN_FILE_PAGE_RESULT_EVENT,
  BRAIN_UNFILED_PAGE_MIME,
  decodeUnfiledPage,
  draggingUnfiledPage,
  setDocumentHeadings,
  type DocumentHeading,
  type FilePageRefDetail,
  type FilePageRefRefusal,
  type FilePageRefResult,
  type UnfiledPage,
} from "@/lib/page-filing";
import { editorWrapper } from "./column-drop";
import { isBlockLaneDepth } from "./columns";
import { pageRefVisibleText } from "./page-ref";

/** Exported so a transaction's filing meta can be read back off it. */
export const pageFilingKey = new PluginKey<DecorationSet>("brainPageFiling");

/** The class the confirming flash keys on (`components/editor/milkdown.css`).
 *
 *  It used to be `.ProseMirror-selectednode`, and a NodeSelection on a
 *  standalone page block is set by more than the insert: picking one up to
 *  move it sets the same selection, so leaving drew "just arrived" on a block
 *  that had been there for a week. The flash hangs on the act of filing now —
 *  a meta on the transaction that writes the block, and a decoration that
 *  carries this class for as long as the animation runs. The NodeSelection
 *  stays where it was; the keyboard needs it. */
export const BRAIN_PAGE_REF_FILED_CLASS = "brain-page-ref-filed";

/** The flash's own window, and when the decoration goes. Clearing a frame or
 *  two late costs nothing — the animation has already landed on its `to`
 *  values, which are the block's ordinary ones — while clearing early would
 *  snap a fill that is still on screen.
 *
 *  Late is not never. The animation runs `both`, so its end frame keeps
 *  winning over the block's own rules for as long as the class is there: a
 *  decoration left on would swallow the pending-nest fill the next time a
 *  page is dragged onto that block. */
const FILED_FLASH_MS = 600;
export const FILED_FLASH_CLEAR_MS = FILED_FLASH_MS + 120;

/** One flash's own identity, so the timer that takes it off can tell "still
 *  the same fill" from "a second filing replaced it". ProseMirror carries a
 *  decoration's spec object through mapping untouched — an edit that shifts
 *  the block is the same flash — while every new decoration gets a new one. */
function filedFlashSpec() {
  return {};
}

/** Meta on the transaction that files a page: where the block landed, or null
 *  to take the flash back off. */
interface FiledFlashMeta {
  flash: number | null;
}

/** A paragraph whose whole content is one page-ref atom for this id — the
 *  block a filing writes, and the block the flash goes on. The same shape
 *  `pageRefParagraphs` marks `brain-page-ref-only`. */
function filedPageRefPos(doc: ProseNode, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name !== "paragraph") return true;
    if (
      node.childCount === 1 &&
      node.firstChild?.type.name === "page_ref" &&
      node.firstChild.attrs.id === id
    ) {
      found = pos;
    }
    return false;
  });
  return found;
}

/** Does the body already link this page anywhere — as a child block or as an
 *  inline mention? Both count: `unreferencedDirectChildren` reads the same
 *  Markdown, so a second copy would sit in a document that has no room for it
 *  and the tail row would not come back. */
export function docHasPageRef(doc: ProseNode, id: string): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === "page_ref" && node.attrs.id === id) found = true;
    return !found;
  });
  return found;
}

export interface DocumentSection extends DocumentHeading {
  /** Position before the next heading of the same or higher rank, or the end
   *  of the document. */
  end: number;
}

/** A heading's name as the reader sees it. A page reference in a heading is
 *  an atom with no text of its own — `textContent` reads it as nothing, and
 *  the menu offered "Untitled heading" for a section named after a page. Its
 *  name is the page's live title, the same text the editor paints. */
function headingText(node: ProseNode): string {
  let text = "";
  node.forEach((child) => {
    text +=
      child.type.name === "page_ref"
        ? pageRefVisibleText(child)
        : child.textContent;
  });
  return text.trim();
}

/** The page's sections, in document order, from the live document.
 *
 *  This is the only place headings are counted. The menu shows what it
 *  returns and `sectionEndPos` resolves against the same list, so an index
 *  cannot name one block in the picker and a different one on insert.
 *
 *  A heading is a section when it sits in a block lane — the document, or a
 *  column of a `cols` row that is itself in a lane (`isBlockLaneDepth` owns
 *  that rule). Columns are how this owner lays a page out, and Smart sort
 *  writes its `## Section` headings inside them, so a heading in a column is
 *  as much a place to file under as one at the top level. A heading inside a
 *  toggle, a callout, a quote or a list is part of that block, not a place of
 *  its own. A section runs to the next heading of the same or higher rank in
 *  its own lane, or to the end of that lane: two columns are two lanes, and a
 *  heading in one says nothing about the other. */
export function documentSections(doc: ProseNode): DocumentSection[] {
  const sections: DocumentSection[] = [];
  /** Open sections per lane, keyed by the lane's content start. */
  const open = new Map<number, number[]>();
  doc.descendants((node, pos) => {
    const $pos = doc.resolve(pos);
    if (node.type.name === "heading") {
      if (!isBlockLaneDepth($pos, $pos.depth)) return false;
      const laneStart = $pos.start();
      const depth = typeof node.attrs.level === "number" ? node.attrs.level : 1;
      const stack = open.get(laneStart) ?? [];
      while (stack.length > 0) {
        const candidate = sections[stack[stack.length - 1]];
        if (candidate.depth < depth) break;
        candidate.end = pos;
        stack.pop();
      }
      stack.push(sections.length);
      open.set(laneStart, stack);
      sections.push({
        index: sections.length,
        depth,
        text: headingText(node),
        end: $pos.end(),
      });
      return false;
    }
    // Only lanes are entered: a `cols` row that is itself in a lane, and its
    // columns. Everything else holds its own content.
    if (node.type.name === "cols") return isBlockLaneDepth($pos, $pos.depth);
    return node.type.name === "col";
  });
  return sections;
}

/** End of the section owned by the nth section heading. `null`, and an index
 *  no heading answers to, both mean the end of the page — a plain page with
 *  children has no sections, and "at the bottom" is still a place. */
export function sectionEndPos(
  doc: ProseNode,
  headingIndex: number | null,
): number {
  if (headingIndex === null) return doc.content.size;
  return documentSections(doc)[headingIndex]?.end ?? doc.content.size;
}

/** The transaction that files a page, or null when there is nothing to do.
 *  Refusing an id the document already carries is the whole double-insert
 *  guard: the tail row survives the ~200ms until Milkdown serializes, so a
 *  second drop or a second menu click in that window is a real gesture. */
export function filePageRefTransaction(
  state: EditorState,
  detail: FilePageRefDetail,
): Transaction | null {
  const paragraph = state.schema.nodes.paragraph;
  const pageRef = state.schema.nodes.page_ref;
  if (!paragraph || !pageRef) return null;
  if (docHasPageRef(state.doc, detail.id)) return null;
  const block = paragraph.create(null, [
    pageRef.create({ id: detail.id, label: detail.label }),
  ]);
  const pos = sectionEndPos(state.doc, detail.headingIndex);
  const tr = state.tr.insert(pos, block);
  const $pos = tr.doc.resolve(pos);
  if ($pos.nodeAfter?.eq(block)) {
    tr.setSelection(NodeSelection.create(tr.doc, pos));
  }
  // What the flash is for: this block arrived just now. A NodeSelection is
  // also set, and is also set by picking an existing block up, so the two
  // cannot share a hook.
  tr.setMeta(pageFilingKey, { flash: pos } satisfies FiledFlashMeta);
  return tr.scrollIntoView();
}

/** Only one editor is mounted at a time, but a page switch overlaps the two
 *  for a tick. The outgoing view clears the shared heading list only while it
 *  is still the one that filled it. */
let headingOwner: symbol | null = null;

/** `docHasPageRef` walks the whole document and `dragover` fires continuously.
 *  Nothing edits mid-drag, so the answer holds for as long as the document
 *  object does. */
let refusalCache: { id: string; doc: ProseNode; duplicate: boolean } | null =
  null;

function isDuplicate(doc: ProseNode, id: string): boolean {
  if (refusalCache && refusalCache.id === id && refusalCache.doc === doc) {
    return refusalCache.duplicate;
  }
  const duplicate = docHasPageRef(doc, id);
  refusalCache = { id, doc, duplicate };
  return duplicate;
}

/** Must this drag be refused, now, while the reader can still act on it?
 *
 *  The duplicate veto used to sit on `drop`: the whole gesture showed a valid
 *  insertion line and the release did `preventDefault` with nothing said. A
 *  drag that cannot land is answered on `dragover` instead — no line, and
 *  `no-drop` under the cursor. `dragged` is null for a drag from another
 *  window, whose payload this side cannot read until the drop; that one is
 *  judged there, on what it actually carries. */
export function refusesUnfiledDrag(
  view: { editable: boolean; state: { doc: ProseNode } },
  dragged: UnfiledPage | null,
): boolean {
  if (!view.editable) return true;
  if (!dragged) return false;
  return isDuplicate(view.state.doc, dragged.id);
}

/** The house way of saying "not here" to a drag: a flag on the editor wrapper
 *  that CSS reads, exactly as `data-col-drop` already does. */
function flagRefused(view: EditorView, refused: boolean) {
  const wrapper = editorWrapper(view);
  if (refused) wrapper.setAttribute("data-file-refused", "true");
  else wrapper.removeAttribute("data-file-refused");
}

function report(id: string, result: Omit<FilePageRefResult, "id">) {
  window.dispatchEvent(
    new CustomEvent<FilePageRefResult>(BRAIN_FILE_PAGE_RESULT_EVENT, {
      detail: { id, ...result },
    }),
  );
}

/** Two ways into the document for a child the body does not link yet.
 *
 *  The pointer path is Milkdown's own: the tail row hands ProseMirror an exact
 *  slice as `text/html`, so the stock external-drop path parses it, the block
 *  drop indicator draws where it would for any block drag, and the drop lands
 *  at that block boundary. Nothing here re-implements that — what this plugin
 *  owns is the refusal, and it says it while the reader can still act on it:
 *  on `dragover`, by suppressing the indicator and giving `no-drop`, instead
 *  of letting a valid-looking line end in a silent `preventDefault`.
 *
 *  The keyboard and touch path is the row menu, which cannot drag: it names a
 *  heading (or the end of the page) and this plugin inserts the same block,
 *  then reports what it did so the tail can say it out loud. */
export function pageFilingPlugin(): Plugin<DecorationSet> {
  /** The page a `dragover` let through, waiting for the drop's own
   *  transaction. The pointer path never runs `filePageRefTransaction` —
   *  ProseMirror writes the block — so this is how that path says a page was
   *  filed rather than merely moved. */
  let pendingFiled: string | null = null;

  return new Plugin<DecorationSet>({
    key: pageFilingKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, flash) => {
        const meta = tr.getMeta(pageFilingKey) as FiledFlashMeta | undefined;
        if (!meta) return flash.map(tr.mapping, tr.doc);
        if (meta.flash === null) return DecorationSet.empty;
        const node = tr.doc.nodeAt(meta.flash);
        if (!node) return DecorationSet.empty;
        return DecorationSet.create(tr.doc, [
          Decoration.node(
            meta.flash,
            meta.flash + node.nodeSize,
            { class: BRAIN_PAGE_REF_FILED_CLASS },
            filedFlashSpec(),
          ),
        ]);
      },
    },
    /** The pointer path's half of the same sentence. The drop is Milkdown's
     *  own — this plugin only agreed to it — so the position is read back
     *  off the document the drop produced. */
    appendTransaction: (transactions, _previous, state) => {
      const id = pendingFiled;
      if (id === null) return null;
      pendingFiled = null;
      if (!transactions.some((tr) => tr.getMeta("uiEvent") === "drop")) {
        return null;
      }
      const pos = filedPageRefPos(state.doc, id);
      if (pos === null) return null;
      return state.tr.setMeta(pageFilingKey, {
        flash: pos,
      } satisfies FiledFlashMeta);
    },
    view: (view) => {
      const token = Symbol("page-filing");
      headingOwner = token;
      const publish = (doc: ProseNode) => {
        if (headingOwner !== token) return;
        setDocumentHeadings(
          documentSections(doc).map(({ index, depth, text }) => ({
            index,
            depth,
            text,
          })),
        );
      };
      publish(view.state.doc);

      const onFile = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        const detail = asFilePageRefDetail(event.detail);
        if (!detail) return;
        const refuse = (refused: FilePageRefRefusal) =>
          report(detail.id, { section: null, refused });
        if (!view.editable) return refuse("locked");
        // Resolved before the insert, from the same list the menu showed.
        const section =
          detail.headingIndex === null
            ? null
            : (documentSections(view.state.doc)[detail.headingIndex]?.text ??
              null);
        const tr = filePageRefTransaction(view.state, detail);
        if (!tr) return refuse("duplicate");
        view.dispatch(tr);
        // The row that carried the menu unmounts as soon as the body
        // serializes. Focus has to land somewhere, and the block just
        // written is where the reader is looking.
        //
        // Not now, though: the menu is still mounted and its focus scope is
        // trapped, so a synchronous focus would be pulled straight back and
        // then dropped on <body> when the row goes. One turn later the trap
        // is gone, and the menu has been told not to restore the trigger.
        setTimeout(() => {
          if (!view.isDestroyed) view.focus();
        }, 0);
        report(detail.id, { section, refused: null });
      };

      const endDrag = () => {
        refusalCache = null;
        pendingFiled = null;
        flagRefused(view, false);
      };

      /** The flash is a decoration, not a fill the element keeps, so it has
       *  to be taken back off. One timer at a time, and it belongs to the
       *  decoration on screen: filing a second page inside the window
       *  replaces the first one, and a timer still armed for the decoration
       *  that is gone would fire part-way through the new block's hold and
       *  cut its fill instead of fading it. */
      let flashTimer = 0;
      let flashSpec: unknown = null;
      const clearFlash = () => {
        flashTimer = 0;
        if (view.isDestroyed) return;
        if (pageFilingKey.getState(view.state)?.find().length === 0) return;
        view.dispatch(
          view.state.tr.setMeta(pageFilingKey, {
            flash: null,
          } satisfies FiledFlashMeta),
        );
      };

      window.addEventListener(BRAIN_FILE_PAGE_EVENT, onFile);
      // `dragend` fires on the tail row, `drop` may land outside the editor;
      // neither reaches the view's own handlers.
      window.addEventListener("dragend", endDrag);
      window.addEventListener("drop", endDrag);
      return {
        update: (updated, previous) => {
          if (!updated.state.doc.eq(previous.doc)) publish(updated.state.doc);
          const [flash] = pageFilingKey.getState(updated.state)?.find() ?? [];
          const spec: unknown = flash ? flash.spec : null;
          if (spec === flashSpec) return;
          flashSpec = spec;
          if (flashTimer !== 0) window.clearTimeout(flashTimer);
          flashTimer =
            spec === null
              ? 0
              : window.setTimeout(clearFlash, FILED_FLASH_CLEAR_MS);
        },
        destroy: () => {
          window.removeEventListener(BRAIN_FILE_PAGE_EVENT, onFile);
          window.removeEventListener("dragend", endDrag);
          window.removeEventListener("drop", endDrag);
          if (flashTimer !== 0) window.clearTimeout(flashTimer);
          endDrag();
          if (headingOwner === token) {
            headingOwner = null;
            setDocumentHeadings([]);
          }
        },
      };
    },
    props: {
      decorations: (state) => pageFilingKey.getState(state),
      handleDOMEvents: {
        dragover: (view, rawEvent) => {
          const event = rawEvent as DragEvent;
          const transfer = event.dataTransfer;
          if (!transfer?.types.includes(BRAIN_UNFILED_PAGE_MIME)) return false;
          const refused = refusesUnfiledDrag(view, draggingUnfiledPage());
          flagRefused(view, refused);
          if (!refused) return false;
          transfer.dropEffect = "none";
          // Returning true keeps ProseMirror's own `dragover` handler — which
          // calls preventDefault unconditionally — from running, so the
          // browser never arms a drop here and `drop` never fires at all.
          return true;
        },
        dragleave: (view, rawEvent) => {
          const event = rawEvent as DragEvent;
          const to = event.relatedTarget;
          // Moving between blocks leaves one and enters the next; only the
          // one that leaves the editor takes the refusal down. `dragend`
          // and `drop` cover every drag that started in this window — this
          // is for one that started in another and never ends here.
          if (to instanceof Node && view.dom.contains(to)) return false;
          flagRefused(view, false);
          return false;
        },
        drop: (view, rawEvent) => {
          const event = rawEvent as DragEvent;
          const dragged = decodeUnfiledPage(
            event.dataTransfer?.getData(BRAIN_UNFILED_PAGE_MIME) ?? "",
          );
          if (!dragged) return false;
          // A drag from another window never passed through `dragover`
          // with a payload this side could read, so the real check is here.
          if (!view.editable || docHasPageRef(view.state.doc, dragged.id)) {
            event.preventDefault();
            return true;
          }
          // Milkdown's own external-drop path writes the block. What it
          // cannot know is that this one is a filing rather than a move, so
          // the id waits here for the transaction it produces.
          pendingFiled = dragged.id;
          return false;
        },
      },
    },
  });
}

/** What Milkdown mounts. The plugin itself is built above, where a test can
 *  reach it without an editor. */
export const pageFiling = $prose(() => pageFilingPlugin());
