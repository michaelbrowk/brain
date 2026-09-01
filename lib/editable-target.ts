/**
 * Typing surfaces own the keyboard. A window-level shortcut that fires while
 * the caret sits in a field or in ProseMirror is answering someone else's
 * gesture: ⌘Z inside the composer is "fix that typo", and the shell's undo
 * would spend a ten-second archive window on it — silently, since the pill
 * leaves looking pressed and nothing records the rollback.
 *
 * Walk up from the event target rather than checking it alone: the key event
 * lands on the deepest node, which inside ProseMirror is a text node's
 * element, not the contenteditable host.
 */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']",
    ) !== null
  );
}
