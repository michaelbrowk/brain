/** Filing an unreferenced child into its parent's Markdown.
 *
 *  A page created under a parent through MCP is a direct child the parent's
 *  body does not link, so `components/subpages.tsx` paints it in the derived
 *  tail below the editor. Nothing in the document represents it, which is why
 *  it cannot be reordered — there is no block to move. Filing writes the
 *  reference into the body at a position the reader picks, and the existing
 *  derivation then drops the row from the tail. No new state, no new field.
 *
 *  This module is deliberately free of ProseMirror and React so both the tail
 *  (a plain React row) and the editor plugin can share one payload contract. */

/** Marks a drag that started in the derived tail. The editor reads it back on
 *  drop to refuse a second copy of a page the body already links. It is NOT
 *  `BRAIN_PAGE_REF_DRAG_MIME`: that one means "reparent this page", and the
 *  sidebar arms its nesting drop the moment it sees it. */
export const BRAIN_UNFILED_PAGE_MIME = "application/x-brain-unfiled-page+json";

/** The keyboard and touch path. The tail row is a sibling of the editor, not a
 *  descendant, so the row menu reaches the mounted plugin through the window —
 *  the same bridge `BRAIN_PAGE_REF_EXTERNAL_ACCEPT_EVENT` already uses. */
export const BRAIN_FILE_PAGE_EVENT = "brain:file-page-ref";

/** What the editor did with that request, sent back the same way. The tail
 *  asked for the move and is the only thing left on screen once the row goes,
 *  so it is also the thing that says out loud what happened. */
export const BRAIN_FILE_PAGE_RESULT_EVENT = "brain:file-page-ref-result";

const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LABEL = 1_024;

export interface UnfiledPage {
  id: string;
  label: string;
}

export interface FilePageRefDetail extends UnfiledPage {
  /** Index among the body's section headings — at the top level or inside a
   *  column — or null for end of page. */
  headingIndex: number | null;
}

/** Why a filing request produced nothing. `duplicate` is the body already
 *  linking that page; `locked` is an editor that is not accepting mutations. */
export type FilePageRefRefusal = "duplicate" | "locked";

export interface FilePageRefResult {
  id: string;
  /** Heading the reference landed under, or null for the end of the page.
   *  Read from the live document after the placement was resolved, so it names
   *  where the block actually went rather than where it was aimed. */
  section: string | null;
  refused: FilePageRefRefusal | null;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** The drag payload ProseMirror itself understands. `data-pm-slice="0 0 []"`
 *  is the editor's own marker for an exact, fully closed slice, so the stock
 *  external-drop path inserts one whole block instead of guessing how far the
 *  fragment is open. The anchor carries no `href`: the link mark's parse rule
 *  is `a[href]` and would otherwise win over the page-ref node's
 *  `a[data-page-ref]`, turning an atomic page block into editable link text. */
export function unfiledPageDropHtml({ id, label }: UnfiledPage): string {
  return `<p data-pm-slice="0 0 []"><a data-page-ref="${escapeHtml(
    id,
  )}">${escapeHtml(label)}</a></p>`;
}

/** Fallback for a drop that lands in a code block, and for any target outside
 *  Brain: the Markdown the serializer would have written anyway. */
export function unfiledPageDropText({ id, label }: UnfiledPage): string {
  return `[${label.replace(/[[\]]/g, "\\$&")}](/p/${id})`;
}

export function encodeUnfiledPage({ id, label }: UnfiledPage): string {
  return JSON.stringify({ id, label });
}

export function decodeUnfiledPage(value: string): UnfiledPage | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const id = typeof parsed?.id === "string" ? parsed.id : "";
    const label = typeof parsed?.label === "string" ? parsed.label : "";
    if (!PAGE_ID_RE.test(id) || label.length > MAX_LABEL) return null;
    return { id, label };
  } catch {
    return null;
  }
}

export function asFilePageRefDetail(value: unknown): FilePageRefDetail | null {
  if (!value || typeof value !== "object") return null;
  const detail = value as Record<string, unknown>;
  const id = typeof detail.id === "string" ? detail.id : "";
  const label = typeof detail.label === "string" ? detail.label : "";
  const headingIndex = detail.headingIndex;
  if (!PAGE_ID_RE.test(id) || label.length > MAX_LABEL) return null;
  if (
    headingIndex !== null &&
    (!Number.isSafeInteger(headingIndex) || (headingIndex as number) < 0)
  ) {
    return null;
  }
  return { id, label, headingIndex: headingIndex as number | null };
}

export interface DocumentHeading {
  /** Position among the body's section headings, in document order. A
   *  heading inside a column counts; one inside a toggle, a callout, a quote
   *  or a list does not. */
  index: number;
  depth: number;
  text: string;
}

/** The page's own sections, as the mounted editor counts them.
 *
 *  There used to be a second count here, taken from the serialised Markdown
 *  with mdast. The two agreed only while the two heading sets agreed: a
 *  heading that is top-level in Markdown but nested in the document — inside a
 *  column, a toggle, a callout — shifted the numbering, and the reader's
 *  "Writing" quietly became the end of the page. One walk of the live document
 *  now produces both the list the menu shows and the index the insert
 *  resolves, so an index cannot mean two different blocks. */
const NO_HEADINGS: readonly DocumentHeading[] = Object.freeze([]);

let liveHeadings: readonly DocumentHeading[] = NO_HEADINGS;
const headingListeners = new Set<() => void>();

function sameHeadings(
  a: readonly DocumentHeading[],
  b: readonly DocumentHeading[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (heading, at) =>
        heading.index === b[at].index &&
        heading.depth === b[at].depth &&
        heading.text === b[at].text,
    )
  );
}

/** Called by the editor plugin on mount and on every document change. Equal
 *  snapshots keep their identity, so a keystroke that does not touch a heading
 *  does not re-render the tail. */
export function setDocumentHeadings(headings: readonly DocumentHeading[]) {
  if (sameHeadings(liveHeadings, headings)) return;
  liveHeadings = headings.length === 0 ? NO_HEADINGS : headings;
  headingListeners.forEach((listener) => listener());
}

export function getDocumentHeadings(): readonly DocumentHeading[] {
  return liveHeadings;
}

/** No editor is mounted on the server, so there are no sections to offer. */
export function getServerDocumentHeadings(): readonly DocumentHeading[] {
  return NO_HEADINGS;
}

export function subscribeDocumentHeadings(listener: () => void): () => void {
  headingListeners.add(listener);
  return () => {
    headingListeners.delete(listener);
  };
}

/** The row being dragged right now, or null.
 *
 *  `dataTransfer.getData` returns "" during `dragover` — the payload is only
 *  readable on `drop`. Refusing at the moment the reader can still change
 *  their mind therefore needs the id from somewhere else, and the tail and the
 *  editor share one window. The drop still validates the real payload, so a
 *  drag from another window is judged on what it actually carries. */
let draggingPage: UnfiledPage | null = null;

export function setDraggingUnfiledPage(page: UnfiledPage | null) {
  draggingPage = page;
}

export function draggingUnfiledPage(): UnfiledPage | null {
  return draggingPage;
}
