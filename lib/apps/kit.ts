/** The Brain app kit. The frame's policy forbids it fetching a stylesheet or
 *  a script of its own, so the kit is a string this module splices into the
 *  entry at serve time, where the entry asks for it with
 *  `<link rel="brain-kit">`. Both constants are empty until the task that
 *  writes the kit fills them, and an entry that asks for it today gets
 *  nothing and still renders. */
export const APP_KIT_CSS = "";
export const APP_KIT_JS = "";

const KIT_LINK = /<link\s+rel=["']brain-kit["']\s*\/?>/i;

export function injectAppKit(html: string): string {
  if (!KIT_LINK.test(html)) return html;
  return html.replace(
    KIT_LINK,
    `<style>${APP_KIT_CSS}</style><script>${APP_KIT_JS}</script>`,
  );
}
