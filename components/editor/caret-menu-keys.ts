/** WHETHER A MENU THAT FOLLOWS THE CARET MAY TAKE THIS KEY.
 *
 *  The slash and wiki-link menus listen on the document in the capture phase,
 *  because ProseMirror handles a key on its own element and ignores one that
 *  arrives already prevented. That reach is also how a menu took keys that
 *  were never its own, so each refusal below is one it made:
 *
 *  - An IME is composing. Its Enter commits the candidate, and Safari sends
 *    that commit as keyCode 229 with `isComposing` already false.
 *  - The editor is inert, which is a page on its way off the screen. A return
 *    to the page during that exit turned the leaving editor's `/h1` into a
 *    heading.
 *  - The key was typed somewhere else. The ⌘K palette opened over a menu that
 *    was still up: its Enter ran "New page" in the editor behind it, filed an
 *    Untitled child and linked it into the page. A dialog, the title field and
 *    a sidebar row are all outside the editor, and a key typed there is
 *    theirs. */
export function caretMenuTakesKey(
  event: KeyboardEvent,
  container: HTMLElement | null,
): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (!container || container.closest("[inert]")) return false;
  return event.target instanceof Node && container.contains(event.target);
}
