/** WHETHER A SURFACE THAT LISTENS ON THE WINDOW MAY TAKE A KEY.
 *
 *  Mail and Tasks hear their keys on the window, because their keys are not
 *  typed into anything: `e` archives the open letter and `t` sends the
 *  selected task to Today wherever the focus happens to be. The window hears
 *  every key on the page for as long as the listener is bound, though, and it
 *  is bound for as long as the surface is mounted, which is longer than the
 *  surface is the thing on screen:
 *
 *  - The shell swaps canvases inside `AnimatePresence mode="wait"`, so the
 *    surface that is leaving stays mounted through its exit. `CanvasPresence`
 *    makes it inert for those frames, which takes the focus out of it and
 *    does nothing about a listener on the window: an `e` pressed as Mail left
 *    archived a letter the reader could no longer see.
 *  - The phone's Pages view and its search make `<main>` inert the same way.
 *    A surface under one of them is not where a key was meant either.
 *
 *  So the surface asks its own root, the way the caret menus ask their editor
 *  (`editor/caret-menu-keys.ts`). A root that is not there takes nothing. */
export function surfaceTakesKeys(root: Element | null): boolean {
  return root !== null && root.closest("[inert]") === null;
}
