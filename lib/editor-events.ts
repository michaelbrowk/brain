/** Window events the shell and the editor agree on.
 *
 *  The editor is dynamically imported to keep Milkdown out of the shell's
 *  bundle, so the two cannot import each other and a name they both need has
 *  to live somewhere neither owns. This module is that seam: no runtime of its
 *  own, no dependency, importable from either bundle.
 */

export const NESTED_TABLE_BLOCKED_EVENT = "brain:nested-table-blocked";

export function notifyNestedTableBlocked() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NESTED_TABLE_BLOCKED_EVENT));
}

/** The page opened read-only because its load would have dropped content
 *  (`components/editor/load-guard.ts`). The editor knows it; the shell owns
 *  the toast that says so. */
export const LOSSY_LOAD_EVENT = "brain:editor-lossy-load";

export function notifyLossyLoad() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LOSSY_LOAD_EVENT));
}

/** A task record changed somewhere the open note cannot see: another tab, the
 *  Tasks surface, an MCP call, a repeat rule advancing. Dispatched on `window`
 *  by the shell's store-event forwarder, which is the one place that already
 *  knows a `type: "task"` event arrived and that it was not this tab's own
 *  write. */
export const TASKS_CHANGED_EVENT = "brain:tasks-changed";

/** The open note's document changed. Dispatched on `window` by the editor
 *  itself, for the surfaces that float over the canvas and read the line the
 *  caret is in: `selectionchange` never fires for a press that rewrites the
 *  block under a caret that has not moved, so a toggle read its own result
 *  one gesture late. */
export const EDITOR_DOC_CHANGED_EVENT = "brain:editor-doc-changed";

export function notifyEditorDocChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EDITOR_DOC_CHANGED_EVENT));
}

/** The writer asked for the link field (Mod-Shift-k in the editor). The key
 *  is bound in a ProseMirror keymap, where every other editor chord lives;
 *  the field is the floating toolbar's, which listens for this. */
export const EDITOR_LINK_FIELD_EVENT = "brain:editor-link-field";

export function notifyEditorLinkField() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EDITOR_LINK_FIELD_EVENT));
}
