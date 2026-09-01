export interface Template {
  id: string;
  name: string;
  emoji: string; // page icon + shown in the picker; "" = auto-emoji (blank)
  title: string;
  markdown: string;
}

/** Built-in page templates. "Blank" is the plain New-page path.
 *  CommonMark collapses blank lines, so a heading with nothing under it gives
 *  the writer no line to click into. `::empty-block` (the editor's explicit
 *  empty paragraph) keeps every section writable. An empty task item is
 *  `- [ ] <br />`: GFM only recognises the checkbox when content follows it,
 *  and `<br />` is the placeholder the editor itself serialises for an empty
 *  task (`* [ ] <br />`), which parses back to an unchecked empty item. */
export const TEMPLATES: Template[] = [
  { id: "blank", name: "Blank page", emoji: "", title: "Untitled", markdown: "" },
  {
    id: "meeting",
    name: "Meeting notes",
    emoji: "📝",
    title: "Meeting notes",
    markdown:
      "## Attendees\n\n::empty-block\n\n## Agenda\n\n::empty-block\n\n## Notes\n\n::empty-block\n\n## Action items\n\n- [ ] <br />\n",
  },
  {
    id: "person",
    name: "Person",
    emoji: "👤",
    title: "Name",
    markdown:
      "## About\n\n::empty-block\n\n## Notes\n\n::empty-block\n\n## 1:1 log\n\n::empty-block\n",
  },
  {
    id: "project",
    name: "Project",
    emoji: "🎯",
    title: "Project",
    markdown:
      "## Goal\n\n::empty-block\n\n## Status\n\n::empty-block\n\n## Tasks\n\n- [ ] <br />\n\n## Notes\n\n::empty-block\n",
  },
  {
    id: "daily",
    name: "Daily note",
    emoji: "☀️",
    title: "Daily note",
    markdown:
      "## Today\n\n::empty-block\n\n## Done\n\n::empty-block\n\n## Tomorrow\n\n::empty-block\n",
  },
  {
    id: "reading",
    name: "Reading notes",
    emoji: "📚",
    title: "Reading notes",
    markdown:
      "## Source\n\n::empty-block\n\n## Key ideas\n\n- \n\n## Quotes\n\n> \n\n## Takeaways\n\n::empty-block\n",
  },
];

/** One-shot handoff from the New-page menu to the editor that mounts the page
 *  it created: the caret should land in the first empty section, so the
 *  "Press / for commands" hint shows under the first heading. Keyed by page id
 *  and short-lived, so a failed or abandoned navigation cannot move the caret
 *  on a later open. */
const TEMPLATE_CARET_TTL_MS = 10_000;
let pendingTemplateCaret: { pageId: string; expires: number } | null = null;

export function requestTemplateCaret(pageId: string, now = Date.now()): void {
  pendingTemplateCaret = { pageId, expires: now + TEMPLATE_CARET_TTL_MS };
}

/** Is a caret placement still owed to this page? (Non-consuming: the editor
 *  mounts more than once while a page settles, and only the instance that is
 *  ready to place the caret should take the handoff.) */
export function hasTemplateCaret(pageId: string, now = Date.now()): boolean {
  const pending = pendingTemplateCaret;
  if (!pending) return false;
  if (pending.expires <= now) {
    pendingTemplateCaret = null;
    return false;
  }
  return pending.pageId === pageId;
}

/** True once, for the page the menu just created. */
export function takeTemplateCaret(pageId: string, now = Date.now()): boolean {
  if (!hasTemplateCaret(pageId, now)) return false;
  pendingTemplateCaret = null;
  return true;
}
