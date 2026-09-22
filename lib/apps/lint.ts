/** THE TWO FAILURES THAT BREAK THE THEME, AND THE ONE THAT BREAKS THE FRAME.
 *
 *  Spec §6. This cannot judge taste and does not try: an ugly app passes. It
 *  stops an entry that will look wrong in dark (no `color-scheme`, a colour
 *  written as a hex) and one that will simply not load (a resource from
 *  another origin, which the frame's `default-src 'none'` blocks silently,
 *  leaving an app that looks broken with nothing in the console the owner
 *  will ever see).
 *
 *  It is a line scan rather than a parse. An entry is one file of inlined
 *  HTML, CSS and JavaScript with no structure worth walking, and a line
 *  number is what an agent needs to fix it. A fourth rule that needed a parser
 *  would be a sign the lint had grown past what the spec asked of it.
 *
 *  First finding only. An agent fixes one thing and calls again; a list of
 *  fifty invites a rewrite that changes more than the lint asked for. */
export type AppLintRule = "color_scheme" | "hard_coded_colour" | "external_resource";

export interface AppLintFinding {
  readonly rule: AppLintRule;
  readonly line: number;
}

/** A colour written out rather than read from a token. `var(--x, red)` is
 *  allowed: the fallback of a custom property IS the token path, and a
 *  fallback that never fires is not what makes a theme wrong. */
const COLOUR = /(#[0-9a-fA-F]{3,8}\b)|(\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\()/;

/** Anything that would be fetched from outside the app's own folder. `data:`
 *  is allowed because the policy allows it; `assets/…` is allowed because it
 *  is the app's own. Everything else is blocked at load time with nothing
 *  said, so it is refused here where something can be said. */
const IMPORT = /@import\b/;
const EXTERNAL_ATTRIBUTE = /\b(?:src|href)\s*=\s*["']([^"']*)["']/gi;
const EXTERNAL_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

function isLocal(reference: string): boolean {
  const value = reference.trim();
  if (value.length === 0) return true;
  if (value.startsWith("data:") || value.startsWith("#")) return true;
  // An app is served from /api/app/<id>/, so its own files are relative and
  // nothing else is. A leading slash reaches Brain's own origin, which the
  // policy blocks and which an app has no business addressing anyway.
  return (
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) &&
    !value.startsWith("//") &&
    !value.startsWith("/")
  );
}

/** EVERY `var(…)` ON A LINE, NESTED ONES INCLUDED.
 *
 *  A regex cannot do this: `var\(\s*--[^)]*\)` stops at the first `)`, so
 *  `var(--a, var(--b, x))` leaves a trailing `)` behind and the rest of the
 *  line is then read as bare CSS. A token with a token fallback is the
 *  ordinary shape, so that is not an edge case, it is the second thing an
 *  agent writes. Count the depth instead. */
function stripVars(line: string): string {
  let out = "";
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (depth === 0 && line.startsWith("var(", index)) {
      depth = 1;
      index += 3;
      continue;
    }
    if (depth > 0) {
      if (line[index] === "(") depth += 1;
      else if (line[index] === ")") depth -= 1;
      continue;
    }
    out += line[index];
  }
  return out;
}

/** The kit's own first rule is `:root { color-scheme: light dark }`, injected
 *  at serve time, so an entry that asks for the kit has declared it. Refusing
 *  one would make the kit's own example fail the lint that guards it. */
const KIT_LINK = /<link\s+rel=["']brain-kit["']\s*\/?>/i;

export function lintAppEntry(html: string): AppLintFinding | null {
  if (!/color-scheme/i.test(html) && !KIT_LINK.test(html)) {
    return { rule: "color_scheme", line: 1 };
  }

  const lines = html.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const at = index + 1;

    if (IMPORT.test(line)) return { rule: "external_resource", line: at };
    // `<link rel="brain-kit">` has no href to check and is the one link the
    // serve step replaces. It is skipped whole so the attribute scan below
    // cannot read a future `rel` value as a reference.
    if (KIT_LINK.test(line)) continue;
    for (const pattern of [EXTERNAL_ATTRIBUTE, EXTERNAL_URL]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        if (!isLocal(match[1])) return { rule: "external_resource", line: at };
      }
    }

    // A colour inside a var() is the token path; take those out before
    // looking, so `var(--paper, canvas)` and `var(--ink)` read as clean and a
    // bare `#fcfbf8` on the same line still does not.
    if (COLOUR.test(stripVars(line))) {
      return { rule: "hard_coded_colour", line: at };
    }
  }
  return null;
}
