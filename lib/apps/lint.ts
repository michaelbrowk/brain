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

/** THE `#` THAT IS A NAME, NOT A COLOUR.
 *
 *  `#dead`, `#add` and `#cafe` are hex, and they are also perfectly ordinary
 *  anchor names and element ids. An agent told "it writes a colour instead of
 *  reading a token" about `<a href="#dead">` has no move that satisfies the
 *  lint except renaming the anchor, and the sentence never tells it that.
 *
 *  These constructs are blanked before the colour scan, and nothing else is.
 *  A bare `#abc` in a JavaScript string is still refused: nothing here can
 *  tell a colour from an id once the `#` is inside quotes on its own, and the
 *  answer for an app that needs one is to build the string from a token. */
const NOT_A_COLOUR: readonly RegExp[] = [
  /\bhref\s*=\s*(?:"#[^"]*"|'#[^']*'|#[^\s"'>]*)/gi,
  /\burl\(\s*["']?#[^"')]*["']?\s*\)/gi,
  /\b(?:querySelectorAll|querySelector|getElementById|closest)\s*\(\s*(?:"[^"]*"|'[^']*')\s*\)/g,
  /\b(?:id|aria-[a-zA-Z-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi,
];

/** THE NAMED COLOURS, WHICH ARE ONLY COLOURS WHERE CSS IS READ.
 *
 *  CSS Color 4's list. `red` and `white` are words a person writes in a
 *  paragraph and an agent writes in a class name, so the rule is scoped to a
 *  declaration's value inside a `<style>` block or a `style=` attribute,
 *  which is the one place the browser will read one as a colour.
 *
 *  `transparent` and `currentcolor` are out because neither fixes a value:
 *  one paints nothing and the other follows the text, which follows the
 *  token. The CSS-wide keywords are out for the same reason. */
const NAMED_COLOURS: ReadonlySet<string> = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque",
  "black", "blanchedalmond", "blue", "blueviolet", "brown", "burlywood",
  "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk",
  "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray",
  "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen",
  "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise",
  "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue",
  "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey",
  "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral",
  "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
  "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen",
  "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue",
  "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace",
  "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
  "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red",
  "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen",
  "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle",
  "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow",
  "yellowgreen",
]);

/** Anything that would be fetched from outside the app's own folder. `data:`
 *  is allowed because the policy allows it; `assets/…` is allowed because it
 *  is the app's own. Everything else is blocked at load time with nothing
 *  said, so it is refused here where something can be said.
 *
 *  THE VALUE MAY BE UNQUOTED. HTML has never required quotes, and
 *  `<script src=https://cdn.x/a.js>` is a script tag a browser loads and the
 *  first version of this rule read as clean. The name list is every attribute
 *  the browser fetches from, not only the two the spec named in passing:
 *  `srcset`, `data`, `poster` and `background` all fetch, and `action`,
 *  `formaction` and `ping` all send. */
const IMPORT = /@import\b/;
const EXTERNAL_ATTRIBUTE =
  /\b(?:src|srcset|href|data|poster|action|formaction|ping|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/gi;
const EXTERNAL_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

/** The references one attribute value holds. Most hold one; `srcset` holds a
 *  comma-separated list with a descriptor after each, and `ping` holds a
 *  space-separated one, so the value is split on both and every part is
 *  checked. A descriptor such as `2x` names no scheme and reads as local,
 *  which is what it is.
 *
 *  A `data:` value is NOT split. An inline SVG carries
 *  `xmlns='http://www.w3.org/2000/svg'` inside its own payload, and splitting
 *  that would refuse a URI the policy explicitly allows. */
function referencesIn(value: string): readonly string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.toLowerCase().startsWith("data:")) return [];
  return trimmed.split(/[\s,]+/).filter((part) => part.length > 0);
}

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
const KIT_LINKS = /<link\s+rel=["']brain-kit["']\s*\/?>/gi;

/** The same text with every character of every match replaced by a space, so
 *  a construct can be taken out of the scan without moving anything after it.
 *  Newlines survive, which is what keeps a line number a line number. */
function blankOut(text: string, patterns: readonly RegExp[]): string {
  let out = text;
  for (const pattern of patterns) {
    out = out.replace(pattern, (match) => match.replace(/[^\n]/g, " "));
  }
  return out;
}

const COMMENT = /<!--[\s\S]*?-->/g;

/** EVERY `<style>` BLOCK AND EVERY `style=` ATTRIBUTE, AND NOTHING ELSE.
 *
 *  The named-colour rule needs to know where the browser will read a value as
 *  CSS, because `red` is a word in a paragraph everywhere else. The answer is
 *  this text: the same length as the entry, with everything that is not CSS
 *  blanked, so an offset in it is an offset in the original and a line number
 *  is still a line number. */
function cssOnly(html: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  const kept: Array<{ start: number; text: string }> = [];
  for (const pattern of [
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    /(\bstyle\s*=\s*["'])([^"']*)(["'])/gi,
  ]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      kept.push({ start: match.index + match[1].length, text: match[2] });
    }
  }
  let out = blank(html);
  for (const { start, text } of kept) {
    out = out.slice(0, start) + text + out.slice(start + text.length);
  }
  return out;
}

/** True when a declaration's value on this line of CSS names a colour. The
 *  value is what follows a `:` up to the end of the declaration, so a
 *  selector (`.red`, `a:hover`) is never read as one. A `url()` and a quoted
 *  string are taken out first: `url(assets/red.png)` is a file and
 *  `content: "red"` is a word. */
function namesAColour(css: string): boolean {
  const DECLARATION = /:([^;{}]*)/g;
  let match: RegExpExecArray | null;
  while ((match = DECLARATION.exec(css)) !== null) {
    const value = match[1]
      .replace(/url\([^)]*\)/gi, " ")
      .replace(/"[^"]*"|'[^']*'/g, " ")
      .toLowerCase();
    for (const word of value.match(/[a-z]+/g) ?? []) {
      if (NAMED_COLOURS.has(word)) return true;
    }
  }
  return false;
}

export function lintAppEntry(entry: string): AppLintFinding | null {
  // A COMMENT IS NOT A DECLARATION AND NOT A HIDING PLACE. Taken out before
  // any rule runs, so a commented-out `color-scheme` does not satisfy the
  // first rule and a commented-out kit link does not carry the rest of its
  // line past the others.
  const html = blankOut(entry, [COMMENT]);

  if (!/color-scheme/i.test(html) && !KIT_LINK.test(html)) {
    return { rule: "color_scheme", line: 1 };
  }

  // The kit link has no reference to check and is the one link the serve step
  // replaces, so it is blanked rather than skipped. Skipping its whole LINE,
  // which is what this did first, made it a place to hide a script behind.
  const scanned = blankOut(html, [KIT_LINKS]);
  const lines = scanned.split("\n");
  const css = cssOnly(scanned).split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const at = index + 1;

    if (IMPORT.test(line)) return { rule: "external_resource", line: at };
    for (const pattern of [EXTERNAL_ATTRIBUTE, EXTERNAL_URL]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const value = match[1] ?? match[2] ?? match[3] ?? "";
        for (const reference of referencesIn(value)) {
          if (!isLocal(reference)) return { rule: "external_resource", line: at };
        }
      }
    }

    // A colour inside a var() is the token path; take those out before
    // looking, so `var(--paper, canvas)` and `var(--ink)` read as clean and a
    // bare `#fcfbf8` on the same line still does not. The fragments and
    // selectors go too: `#dead` is an anchor far more often than a colour.
    if (COLOUR.test(stripVars(blankOut(line, NOT_A_COLOUR)))) {
      return { rule: "hard_coded_colour", line: at };
    }
    if (namesAColour(stripVars(css[index]))) {
      return { rule: "hard_coded_colour", line: at };
    }
  }
  return null;
}
