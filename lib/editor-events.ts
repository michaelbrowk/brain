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

/** A task record changed somewhere the open note cannot see: another tab, the
 *  Tasks surface, an MCP call, a repeat rule advancing. Dispatched on `window`
 *  by the shell's store-event forwarder, which is the one place that already
 *  knows a `type: "task"` event arrived and that it was not this tab's own
 *  write. */
export const TASKS_CHANGED_EVENT = "brain:tasks-changed";
