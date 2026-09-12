/**
 * Shortcut labels are written once, in Mac glyphs, and translated here for
 * everyone else. The handlers behind them already accept `ctrlKey` alongside
 * `metaKey`, so the shortcuts work on Windows and Linux; only the labels used
 * to say otherwise, to exactly the people most likely to self-host.
 *
 * Which spelling a reader sees is decided by the `data-platform` stamp the
 * before-paint script in `app/layout.tsx` puts on `<html>`. See the `Kbd` atom
 * in `components/ui/primitives.tsx` for how the two spellings share one chip.
 */

/** Leading glyphs that are modifier keys, and their names off a Mac. */
const MODIFIERS: Readonly<Record<string, string>> = {
  "⌘": "Ctrl",
  "⌃": "Ctrl",
  "⌥": "Alt",
  "⇧": "Shift",
};

/** Keys that a Mac label draws and a Windows or Linux one names. */
const KEYS: Readonly<Record<string, string>> = {
  "↵": "Enter",
  "⏎": "Enter",
};

/**
 * The Windows and Linux spelling of a Mac shortcut label: `⌘⌥N` becomes
 * `Ctrl+Alt+N`. Only leading glyphs count as modifiers, so a label that has
 * none of them comes back untouched and the caller can tell the two spellings
 * apart by comparing strings.
 */
export function pcShortcut(label: string): string {
  const modifiers: string[] = [];
  let key = "";
  for (const character of label) {
    const modifier = MODIFIERS[character];
    if (modifier !== undefined && key === "") {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    key += KEYS[character] ?? character;
  }
  if (modifiers.length === 0) return label;
  return [...modifiers, key].filter(Boolean).join("+");
}
