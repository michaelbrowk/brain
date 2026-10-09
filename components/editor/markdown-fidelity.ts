/** THE FILE KEEPS THE WRITER'S MARKDOWN.
 *
 *  Milkdown serializes through remark-stringify with its defaults, which is a
 *  dialect of its own: `*` bullets, every list loose, `1)` folded to `1.`,
 *  setext headings and indented code rewritten, `---` to `***`, a hard break
 *  to a backslash, bare URLs wrapped in angle brackets, `_` escaped inside
 *  words, `:` escaped before letters. A hand-written or imported file was
 *  rewritten end to end by its first save, and the diff of an edit was the
 *  whole page.
 *
 *  This module is Brain's own serializer configuration. Three parts:
 *
 *  1. A remark pass at parse time reads the shape of each construct off the
 *     source bytes (which bullet, which ordered delimiter, setext or ATX,
 *     fence or indent, the rule's spelling, the hard break's spelling, the
 *     link's form) the way the preset already reads `*` versus `_` for
 *     emphasis.
 *  2. Schema extensions carry those shapes through ProseMirror as attributes,
 *     so they survive editing and come back out on the mdast node.
 *  3. Stringify handlers write each node in the shape it arrived in, and in
 *     Brain's defaults when it was typed here: `-` bullets, tight lists, `.`
 *     delimiters, ATX, fences, `---`, two trailing spaces, bare URLs. Text is
 *     escaped only where the characters would otherwise read as syntax.
 *
 *  Empty lines: `<br />` stays the spelling of an empty paragraph the writer
 *  made between blocks, because it is the only one CommonMark reads back as
 *  a line and other renderers show as one. It is never written for an empty
 *  list item (`-`) or an empty table cell, which carry nothing to keep. An
 *  empty task item keeps it, because `- [ ]` without content is not a task
 *  to GFM.
 *
 *  `scripts/verify-serialize-fidelity.mjs` is the gate: the first serialize
 *  of every fixture and every note must be the input, byte for byte.
 *
 *  Known and older than this module, left for a later round: a `<br />` line
 *  inside a callout, a toggle or a column is dropped on load (the preset's
 *  empty-line pass strips it where the container's parser does not put a
 *  paragraph back); a run of empty paragraphs at the end of a page loses
 *  one per save (the preset skips the last block when it is empty); an
 *  inline `<br>` inside a paragraph outside a table is stripped on load. */
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import {
  bulletListSchema,
  codeBlockSchema,
  hardbreakSchema,
  headingSchema,
  hrSchema,
  orderedListSchema,
} from "@milkdown/kit/preset/commonmark";
import { extendListItemSchemaForTask, tableSchema } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from "@milkdown/kit/transformer";
import { $remark } from "@milkdown/kit/utils";
import { Fragment } from "@milkdown/kit/prose/model";
import { attachmentLinkSchema } from "./attachment-refs";

/* ------------------------------------------------------------------------ */
/* 1. Source shapes, read at parse time                                      */
/* ------------------------------------------------------------------------ */

type Positioned = MarkdownNode & {
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

function offsets(node: Positioned): [number, number] | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === "number" && typeof end === "number" ? [start, end] : null;
}

/** The marker an ordered item was written with: its number and delimiter. */
const ORDERED_MARKER = /^\s*(\d+)([.)])/;

function readShapes(node: Positioned, source: string) {
  const span = offsets(node);
  const children = node.children as Positioned[] | undefined;
  if (span) {
    const [start, end] = span;
    const head = source.charAt(start);
    switch (node.type) {
      case "list": {
        const first = children?.[0];
        const itemStart = first && offsets(first)?.[0];
        if (typeof itemStart !== "number") break;
        if (node.ordered) {
          const numbers = (children ?? []).map((item) => {
            const at = offsets(item)?.[0];
            const m = typeof at === "number" ? ORDERED_MARKER.exec(source.slice(at, at + 12)) : null;
            return m ? { number: Number(m[1]), delimiter: m[2] } : null;
          });
          const delimiter = numbers[0]?.delimiter;
          if (delimiter) node.delimiter = delimiter;
          // `1. 1. 1.` is a list whose numbers do not count; CommonMark takes
          // only the first, and the writer asked for them to stay put.
          if (numbers.length > 1 && numbers.every((n) => n && n.number === numbers[0]?.number)) {
            node.increment = false;
          }
        } else {
          const marker = source.charAt(itemStart);
          if (marker === "-" || marker === "*" || marker === "+") node.marker = marker;
        }
        break;
      }
      case "heading":
        if (head !== "#") {
          node.setext = true;
          // The underline as drawn: CommonMark asks no length of it, and a
          // writer who drew three dashes gets three dashes back.
          node.underline = (source.slice(start, end).split("\n").at(-1) ?? "").trim().length;
        }
        break;
      case "code": {
        const fence = /^(`{3,}|~{3,})/.exec(source.slice(start, end));
        node.fence = fence ? fence[1] : "indent";
        break;
      }
      case "thematicBreak":
        node.rule = source.slice(start, end);
        break;
      case "break":
        node.hard = source.charAt(start) === "\\" ? "backslash" : "spaces";
        break;
      case "link":
        node.form = head === "<" ? "angle" : head === "[" ? "resource" : "literal";
        break;
      case "table":
        // The whole table, bytes and all: column padding is the writer's,
        // and it is written back as long as no cell changed.
        // The store folds CRLF on the way in; the kept bytes must too, or a
        // CRLF file's table came back with the one block that still had CR.
        node.source = source.slice(start, end).replace(/\r\n?/g, "\n");
        break;
      default:
        break;
    }
  }
  children?.forEach((child) => readShapes(child, source));
}

/** Runs before every other pass that could move a node away from its bytes:
 *  shapes are read from positions, and positions are only true on the tree
 *  the parser built. */
export const remarkSourceShapes = $remark(
  "brainSourceShapes",
  () => () => (tree: unknown, file: { value?: unknown }) => {
    if (typeof file?.value !== "string") return;
    readShapes(tree as Positioned, file.value);
  },
);

/* ------------------------------------------------------------------------ */
/* 2. Shapes as attributes, through ProseMirror and back                     */
/* ------------------------------------------------------------------------ */

/** The preset wrote `spread` as the strings "true" and "false", and "false"
 *  is a true value to remark-stringify: that one coercion is what made every
 *  tight list loose. Read both spellings, write a boolean. */
const isSpread = (value: unknown) => value === true || value === "true";

const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

/** The preset drops a paragraph's trailing hard break, which has nothing to
 *  break to. `table-cell.ts` writes a cell's back; nothing else wants it. */
function contentWithoutTrailingBreak(node: ProseNode): Fragment {
  if (node.childCount >= 1 && node.lastChild?.type.name === "hardbreak") {
    const kept: ProseNode[] = [];
    node.content.forEach((child, _offset, index) => {
      if (index !== node.childCount - 1) kept.push(child);
    });
    return Fragment.fromArray(kept);
  }
  return node.content;
}

const fidelityBulletList = bulletListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, marker: { default: "-", validate: "string" } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, type) => {
        state
          .openNode(type, { spread: node.spread === true, marker: str(node.marker, "-") })
          .next(node.children ?? [])
          .closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        state
          .openNode("list", undefined, {
            ordered: false,
            spread: isSpread(node.attrs.spread),
            marker: str(node.attrs.marker, "-"),
          })
          .next(node.content)
          .closeNode();
      },
    },
  };
});

const fidelityOrderedList = orderedListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: {
      ...base.attrs,
      delimiter: { default: ".", validate: "string" },
      increment: { default: true, validate: "boolean" },
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, type) => {
        state
          .openNode(type, {
            spread: node.spread === true,
            order: typeof node.start === "number" ? node.start : 1,
            delimiter: str(node.delimiter, "."),
            increment: node.increment !== false,
          })
          .next(node.children ?? [])
          .closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        state
          .openNode("list", undefined, {
            ordered: true,
            start: typeof node.attrs.order === "number" ? node.attrs.order : 1,
            spread: isSpread(node.attrs.spread),
            delimiter: str(node.attrs.delimiter, "."),
            increment: node.attrs.increment !== false,
          })
          .next(node.content)
          .closeNode();
      },
    },
  };
});

/** A typed item is tight, like a typed list. The preset's default of `true`
 *  put a blank line between an item's text and its own nested list. */
const fidelityListItem = extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  const spreadAttr = base.attrs?.spread ?? { default: true };
  return {
    ...base,
    attrs: { ...base.attrs, spread: { ...spreadAttr, default: false } },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        const spread = isSpread(node.attrs.spread);
        const props: Record<string, string | boolean> =
          node.attrs.checked == null
            ? { spread }
            : {
                label: str(node.attrs.label),
                listType: str(node.attrs.listType),
                spread,
                checked: Boolean(node.attrs.checked),
              };
        state.openNode("listItem", undefined, props).next(node.content).closeNode();
      },
    },
  };
});

const fidelityHeading = headingSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: {
      ...base.attrs,
      setext: { default: false, validate: "boolean" },
      underline: { default: 0, validate: "number" },
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, type) => {
        state
          .openNode(type, {
            level: node.depth,
            setext: node.setext === true,
            underline: typeof node.underline === "number" ? node.underline : 0,
          })
          .next(node.children ?? [])
          .closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        state
          .openNode("heading", undefined, {
            depth: node.attrs.level,
            setext: node.attrs.setext === true,
            underline: typeof node.attrs.underline === "number" ? node.attrs.underline : 0,
          })
          .next(contentWithoutTrailingBreak(node))
          .closeNode();
      },
    },
  };
});

const fidelityCodeBlock = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, fence: { default: "", validate: "string" } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, type) => {
        state.openNode(type, { language: str(node.lang), fence: str(node.fence) });
        if (typeof node.value === "string" && node.value) state.addText(node.value);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        state.addNode("code", undefined, node.content.firstChild?.text || "", {
          lang: str(node.attrs.language),
          fence: str(node.attrs.fence),
        });
      },
    },
  };
});

const fidelityHr = hrSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, rule: { default: "", validate: "string" } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, type) => {
        state.addNode(type, { rule: str(node.rule) });
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        state.addNode("thematicBreak", undefined, undefined, { rule: str(node.attrs.rule) });
      },
    },
  };
});

const fidelityHardbreak = hardbreakSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, hard: { default: "", validate: "string" } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, type) => {
        const data = node.data as { isInline?: boolean } | undefined;
        state.addNode(type, { isInline: Boolean(data?.isInline), hard: str(node.hard) });
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        if (node.attrs.isInline) state.addNode("text", undefined, "\n");
        else state.addNode("break", undefined, undefined, { hard: str(node.attrs.hard) });
      },
    },
  };
});

const fidelityLink = attachmentLinkSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, form: { default: null, validate: "string|null" } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, markType) => {
        state.openMark(markType, {
          href: node.url,
          title: node.title ?? null,
          form: typeof node.form === "string" ? node.form : null,
        });
        state.next(node.children ?? []);
        state.closeMark(markType);
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, mark) => {
        state.withMark(mark, "link", undefined, {
          title: mark.attrs.title ?? null,
          url: mark.attrs.href,
          form: typeof mark.attrs.form === "string" ? mark.attrs.form : null,
        });
      },
    },
  };
});

/** The table's own bytes ride along as an attribute, so an untouched table
 *  is written back as it was: remark-stringify pads every column to its
 *  widest cell, and a hand-written `| a | b |` came back twice as wide. */
const fidelityTable = tableSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, source: { default: "", validate: "string" } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, type) => {
        const align = node.align;
        const children = (node.children ?? []).map((row, index) => ({
          ...row,
          align,
          isHeader: index === 0,
        }));
        state.openNode(type, { source: str(node.source) });
        state.next(children);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        const firstLine = node.content.firstChild?.content;
        if (!firstLine) return;
        const align: (string | null)[] = [];
        firstLine.forEach((cell) => {
          const alignment = cell.attrs.alignment;
          align.push(typeof alignment === "string" ? alignment : null);
        });
        state.openNode("table", undefined, { align, source: str(node.attrs.source) });
        state.next(node.content);
        state.closeNode();
      },
    },
  };
});

/* No extension of `paragraph`. Milkdown re-appends an extended schema at the
 * end of its group, and `paragraph` last in the block group makes
 * `blockquote` the default block: `createAndFill` recursed until the stack
 * ran out and no empty page could mount. The empty-item and empty-cell rule
 * lives in the stringify layer below instead. */

/* ------------------------------------------------------------------------ */
/* 3. Stringify handlers                                                     */
/* ------------------------------------------------------------------------ */

type Unsafe = {
  character: string;
  before?: string;
  after?: string;
  atBreak?: boolean;
  inConstruct?: string | string[];
  notInConstruct?: string | string[];
  _compiled?: RegExp;
};

type Info = {
  before: string;
  after: string;
  now: { line: number; column: number };
  lineShift: number;
};

type Tracker = {
  move: (value: string) => string;
  shift: (value: number) => void;
  current: () => { now: Info["now"]; lineShift: number };
};

type State = {
  stack: string[];
  unsafe: Unsafe[];
  options: Record<string, unknown>;
  bulletCurrent?: string;
  bulletLastUsed?: string;
  enter: (name: string) => () => void;
  safe: (value: string, config: Partial<Info> & { encode?: string[] }) => string;
  containerPhrasing: (parent: MarkdownNode, info: Partial<Info>) => string;
  containerFlow: (parent: MarkdownNode, info: Partial<Info>) => string;
  createTracker: (info: Partial<Info>) => Tracker;
  indentLines: (
    value: string,
    map: (line: string, index: number, blank: boolean) => string,
  ) => string;
  handle: (node: MarkdownNode, parent: MarkdownNode | undefined, state: State, info: Info) => string;
};

type Handler = (
  node: MarkdownNode,
  parent: MarkdownNode | undefined,
  state: State,
  info: Info,
) => string;

/* --- which characters still need escaping ------------------------------- */

const listInScope = (stack: string[], list: string | string[] | undefined, none: boolean) => {
  if (list === undefined) return none;
  const names = Array.isArray(list) ? list : [list];
  return names.some((name) => stack.includes(name));
};

const patternInScope = (stack: string[], pattern: Unsafe) =>
  listInScope(stack, pattern.inConstruct, true) &&
  !listInScope(stack, pattern.notInConstruct, false);

/** A letter or digit of the scripts a note here is written in; an `_` with
 *  one on each side cannot open or close emphasis, so it is prose. */
const WORD = "A-Za-z0-9\\u00C0-\\u024F\\u0400-\\u04FF";

const brainUnsafeByBase = new WeakMap<Unsafe[], Unsafe[]>();

/** remark-stringify's escape table, less the entries that escape prose: the
 *  autolink-literal guards (`www.`, `https:`, `@`), the directive guard on
 *  every `:` before a letter, `_` inside a word and `[` that opens nothing.
 *  Text that read as prose on the way in is prose on the way out. */
function brainUnsafe(base: Unsafe[]): Unsafe[] {
  const cached = brainUnsafeByBase.get(base);
  if (cached) return cached;
  const kept: Unsafe[] = [];
  for (const p of base) {
    const phrasing = p.inConstruct === "phrasing" || (Array.isArray(p.inConstruct) && p.inConstruct.includes("phrasing"));
    if (p.character === "@" && p.before === "[+\\-.\\w]") continue;
    if (p.character === "." && p.before === "[Ww]") continue;
    if (p.character === ":" && (p.before === "[ps]" || p.before === "[^:]")) continue;
    if (p.character === "_" && phrasing && !p.atBreak) {
      kept.push(
        { ...p, before: `[^${WORD}]` },
        { ...p, after: `(?:[^${WORD}]|$)` },
      );
      continue;
    }
    if (p.character === "[" && phrasing && !p.atBreak && !p.before && !p.after) {
      // `[` is syntax only when a `]` later turns into a link, a reference
      // or a footnote; `[[Wiki]]` and `[not a link]` are words. The base
      // table and gfm-footnote each carry one such entry.
      kept.push({ ...p, after: "(?:\\^|[^\\]\\n]*\\][\\[(:])" });
      continue;
    }
    if (p.character === "[" && p.atBreak && !p.after) {
      // At a line start, `[` opens a definition or a footnote definition
      // only with `]:` or `^` behind it; `[[Wiki]]` on its own line is words.
      kept.push({ ...p, after: "(?:\\^|[^\\]\\n]*\\]:)" });
      continue;
    }
    kept.push(p);
  }
  // Fresh pattern objects so the compiled regex of the base entry is not
  // reused for a changed one.
  const fresh = kept.map((p) => ({ ...p, _compiled: undefined }));
  brainUnsafeByBase.set(base, fresh);
  return fresh;
}

function withUnsafe<T>(state: State, unsafe: Unsafe[], run: () => T): T {
  const saved = state.unsafe;
  state.unsafe = unsafe;
  try {
    return run();
  } finally {
    state.unsafe = saved;
  }
}

const text: Handler = (node, _parent, state, info) => {
  const value = str(node.value);
  // Whitespace alone needs nothing. The preset's shortcut took any run that
  // ENDED in whitespace, so `\- ` before `**a**` lost its backslash and the
  // line came back a list.
  if (/^\s+$/.test(value)) return value;
  return withUnsafe(state, brainUnsafe(state.unsafe), () =>
    state.safe(value, { ...info, encode: [] }),
  );
};

/* --- lists ---------------------------------------------------------------- */

const list: Handler = (node, parent, state, info) => {
  const exit = state.enter("list");
  const bulletCurrent = state.bulletCurrent;
  let bullet = node.ordered ? str(node.delimiter, ".") : str(node.marker, "-");
  const other = node.ordered ? (bullet === "." ? ")" : ".") : bullet === "-" ? "*" : "-";
  // Two lists back to back read as one unless their markers differ. The
  // other two guards remark-stringify keeps are not needed here: an item
  // always holds a paragraph, so an empty one is `-` on its own line and
  // `- - -` cannot form, and a rule inside an item is written with a
  // character that is not the bullet (`thematicBreak` below).
  if (parent && state.bulletLastUsed && bullet === state.bulletLastUsed) bullet = other;
  state.bulletCurrent = bullet;
  const increment = state.options.incrementListMarker;
  state.options.incrementListMarker = node.increment !== false;
  const value = state.containerFlow(node, info);
  state.options.incrementListMarker = increment;
  state.bulletLastUsed = bullet;
  state.bulletCurrent = bulletCurrent;
  exit();
  return value;
};

/** The item with its checkbox. gfm's own handler wrote the box after `.`
 *  markers only, so `1) [x] done` came back `1) done`. */
const listItem: Handler = (node, parent, state, info) => {
  const marker = state.bulletCurrent ?? "-";
  let bullet = marker;
  if (parent?.type === "list" && parent.ordered) {
    const start = typeof parent.start === "number" && parent.start > -1 ? parent.start : 1;
    const index = state.options.incrementListMarker === false ? 0 : (parent.children ?? []).indexOf(node);
    bullet = String(start + index) + marker;
  }
  let size = bullet.length + 1;
  const indent = state.options.listItemIndent ?? "one";
  if (indent === "tab" || (indent === "mixed" && (parent?.spread === true || node.spread === true))) {
    size = Math.ceil(size / 4) * 4;
  }
  const head = node.children?.[0];
  const checkbox =
    typeof node.checked === "boolean" && head?.type === "paragraph" ? `[${node.checked ? "x" : " "}] ` : "";
  const tracker = state.createTracker(info);
  tracker.move(bullet + " ".repeat(size - bullet.length) + checkbox);
  tracker.shift(size);
  const exit = state.enter("listItem");
  const value = state.indentLines(state.containerFlow(node, tracker.current()), (line, index, blank) => {
    if (index) return (blank ? "" : " ".repeat(size)) + line;
    return (blank ? bullet : bullet + " ".repeat(size - bullet.length) + checkbox) + line;
  });
  exit();
  return value;
};

/* --- headings ------------------------------------------------------------- */

const heading: Handler = (node, _parent, state, info) => {
  const depth = typeof node.depth === "number" ? node.depth : 1;
  const rank = Math.max(Math.min(6, depth), 1);
  const tracker = state.createTracker(info);
  const hasBreak = (node.children ?? []).some(
    (child) => child.type === "break" || (typeof child.value === "string" && /\r?\n|\r/.test(child.value)),
  );
  // An emptied setext heading has nothing to underline: `=====` alone would
  // read back as a paragraph.
  const hasText = (node.children ?? []).length > 0;
  if (rank < 3 && hasText && (node.setext === true || hasBreak)) {
    const exit = state.enter("headingSetext");
    const subexit = state.enter("phrasing");
    const value = state.containerPhrasing(node, { ...tracker.current(), before: "\n", after: "\n" });
    subexit();
    exit();
    const lastLine = value.length - (Math.max(value.lastIndexOf("\r"), value.lastIndexOf("\n")) + 1);
    const drawn = typeof node.underline === "number" && node.underline > 0 ? node.underline : lastLine;
    return value + "\n" + (rank === 1 ? "=" : "-").repeat(Math.max(drawn, 1));
  }
  const sequence = "#".repeat(rank);
  const exit = state.enter("headingAtx");
  const subexit = state.enter("phrasing");
  tracker.move(sequence + " ");
  let value = state.containerPhrasing(node, { before: "# ", after: "\n", ...tracker.current() });
  if (/^[\t ]/.test(value)) value = "&#x" + value.charCodeAt(0).toString(16).toUpperCase() + ";" + value.slice(1);
  value = value ? sequence + " " + value : sequence;
  subexit();
  exit();
  return value;
};

/* --- code ----------------------------------------------------------------- */

const longestStreak = (value: string, char: string) => {
  let longest = 0;
  let run = 0;
  for (const c of value) {
    run = c === char ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
};

const code: Handler = (node, _parent, state, info) => {
  const raw = str(node.value);
  const lang = str(node.lang);
  const fence = str(node.fence);
  // Indented code has no info string and cannot start or end on a blank
  // line; when the writer's block no longer can be one, it gets a fence.
  if (
    fence === "indent" &&
    !lang &&
    raw &&
    /[^ \r\n]/.test(raw) &&
    !/^[\t ]*(?:[\r\n]|$)|(?:^|[\r\n])[\t ]*$/.test(raw)
  ) {
    const exit = state.enter("codeIndented");
    const value = state.indentLines(raw, (line, _index, blank) => (blank ? "" : "    ") + line);
    exit();
    return value;
  }
  const marker = fence.startsWith("~") ? "~" : "`";
  const sequence = marker.repeat(Math.max(longestStreak(raw, marker) + 1, 3, fence === "indent" ? 0 : fence.length));
  const suffix = marker === "`" ? "GraveAccent" : "Tilde";
  const tracker = state.createTracker(info);
  const exit = state.enter("codeFenced");
  let value = tracker.move(sequence);
  if (lang) {
    const subexit = state.enter(`codeFencedLang${suffix}`);
    value += tracker.move(state.safe(lang, { before: value, after: " ", encode: ["`"], ...tracker.current() }));
    subexit();
  }
  value += tracker.move("\n");
  if (raw) value += tracker.move(raw + "\n");
  value += tracker.move(sequence);
  exit();
  return value;
};

/* --- rules and breaks ----------------------------------------------------- */

const thematicBreak: Handler = (node, parent, state) => {
  const rule = str(node.rule);
  // Inside an item, dashes right under the item's line would be a setext
  // underline, and the bullet's own character on the first line of an item
  // (`* ***`) would be a rule: the rule takes a character that is neither.
  const inItem = state.stack.includes("listItem");
  const bullet = state.bulletCurrent ?? "-";
  const onBulletLine = parent?.type === "listItem" && parent.children?.[0] === node;
  if (
    /^(?:[-*_][ \t]*){3,}$/.test(rule) &&
    !(inItem && (rule.includes("-") || (onBulletLine && rule.includes(bullet))))
  ) {
    return rule;
  }
  if (!inItem) return "---";
  return bullet === "*" ? "___" : "***";
};

const hardBreak: Handler = (node, _parent, state, info) => {
  // Where an end of line cannot stand (a setext heading, a table cell) the
  // break is a space, as remark-stringify writes it.
  if (state.unsafe.some((p) => p.character === "\n" && patternInScope(state.stack, p))) {
    return /[ \t]/.test(info.before) ? "" : " ";
  }
  return node.hard === "backslash" ? "\\\n" : "  \n";
};

/* --- links ---------------------------------------------------------------- */

const textOf = (node: MarkdownNode): string =>
  typeof node.value === "string" ? node.value : (node.children ?? []).map(textOf).join("");

/** `https://x`, `www.x` and `me@x` are links GFM reads without brackets, so
 *  a link whose text is its own address needs none, where GFM would read
 *  one: after a line start, whitespace or `*_~(`, before whitespace or the
 *  trailing punctuation it leaves outside, and with no such punctuation on
 *  the address itself. Anywhere else a bare address is not a link, or is a
 *  different one, and the brackets stay. */
function literalForm(node: MarkdownNode, info?: Pick<Info, "before" | "after">): string | null {
  if ((node.children ?? []).length !== 1 || node.children?.[0]?.type !== "text") return null;
  if (node.title) return null;
  const label = textOf(node);
  const url = str(node.url);
  if (!label || /[\s<>]/.test(label)) return null;
  if (/[?!.,:*_~]$/.test(label) || !balancedParens(label)) return null;
  if (info) {
    if (!/(?:^|[\s*_~(])$/.test(info.before)) return null;
    if (!/^(?:$|[\s<?!.,:*_~)])/.test(info.after)) return null;
  }
  if (url === label && /^https?:\/\//i.test(label)) return label;
  if (url === `http://${label}` && /^www\./i.test(label)) return label;
  if (url === `mailto:${label}` && /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(label)) return label;
  return null;
}

function balancedParens(url: string): boolean {
  let depth = 0;
  for (const c of url) {
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const link: Handler = (node, _parent, state, info) => {
  const tracker = state.createTracker(info);
  const url = str(node.url);
  const literal = node.form === "angle" ? null : literalForm(node, info);
  if (literal) {
    const exit = state.enter("autolink");
    const value = tracker.move(literal);
    exit();
    return value;
  }
  if (
    node.form !== "resource" &&
    (node.children ?? []).length === 1 &&
    node.children?.[0]?.type === "text" &&
    !node.title &&
    (textOf(node) === url || `mailto:${textOf(node)}` === url) &&
    /^[a-z][a-z+.-]+:/i.test(url) &&
    !/[\0- <>\u007F]/.test(url)
  ) {
    const exit = state.enter("autolink");
    const value = tracker.move("<" + textOf(node) + ">");
    exit();
    return value;
  }
  const quote = str(state.options.quote, '"');
  const exit = state.enter("link");
  let subexit = state.enter("label");
  let value = tracker.move("[");
  value += tracker.move(state.containerPhrasing(node, { before: value, after: "](", ...tracker.current() }));
  value += tracker.move("](");
  subexit();
  if ((!url && node.title) || /[\0- \u007F]/.test(url)) {
    subexit = state.enter("destinationLiteral");
    value += tracker.move("<");
    value += tracker.move(state.safe(url, { before: value, after: ">", ...tracker.current() }));
    value += tracker.move(">");
  } else {
    subexit = state.enter("destinationRaw");
    // Balanced parentheses are legal in a bare destination, and Wikipedia
    // addresses carry them.
    const unsafe = balancedParens(url)
      ? state.unsafe.filter((p) => !((p.character === "(" || p.character === ")") && p.inConstruct === "destinationRaw"))
      : state.unsafe;
    value += tracker.move(
      withUnsafe(state, unsafe, () =>
        state.safe(url, { before: value, after: node.title ? " " : ")", ...tracker.current() }),
      ),
    );
  }
  subexit();
  if (node.title) {
    subexit = state.enter(quote === '"' ? "titleQuote" : "titleApostrophe");
    value += tracker.move(" " + quote);
    value += tracker.move(state.safe(str(node.title), { before: value, after: quote, ...tracker.current() }));
    value += tracker.move(quote);
    subexit();
  }
  value += tracker.move(")");
  exit();
  return value;
};
(link as Handler & { peek?: Handler }).peek = (node, _parent, _state, info) =>
  node.form !== "angle" && literalForm(node, info) ? literalForm(node, info)!.charAt(0) : "[";

/* --- the root: one link stays one link ----------------------------------- */

const MARK_TYPES = new Set(["strong", "emphasis", "delete", "textColor", "textHighlight", "inlineCode"]);

function sameLink(a: MarkdownNode, b: MarkdownNode) {
  return a.url === b.url && (a.title ?? null) === (b.title ?? null);
}

/** The link a mark run ends in, when the run is a single chain down to one. */
function linkInside(node: MarkdownNode): MarkdownNode | null {
  if (node.type === "link") return node;
  if (!MARK_TYPES.has(node.type) || node.children?.length !== 1) return null;
  return linkInside(node.children[0]!);
}

function withoutLink(node: MarkdownNode): MarkdownNode[] {
  if (node.type === "link") return node.children ?? [];
  return [{ ...node, children: withoutLink(node.children![0]!) }];
}

const isSpace = (node: MarkdownNode) => node.type === "text" && /^[ \t]+$/.test(str(node.value));

const isEmptyText = (node: MarkdownNode) => node.type === "text" && !str(node.value);

const lastDescendant = (node: MarkdownNode): MarkdownNode => {
  const last = node.children?.at(-1);
  return last ? lastDescendant(last) : node;
};

/** The preset moves a mark's edge spaces out of the mark and leaves an
 *  empty text node behind, so `**[a](u) [b](u)**` left ProseMirror as
 *  `strong(link a, "")`, a space, `strong(link b)` and was written as two
 *  bolds. The empty text is the signature: a mark ending in one, a bare
 *  space, and the same mark again are one mark around the space. A writer's
 *  own `**a** **b**` carries no empty text and stays two. */
function rejoinSplitMarks(node: MarkdownNode) {
  const children = node.children;
  if (!children) return;
  // This level first, while the empty text is still there to read; the
  // children's own passes, and the sweep of empty texts, come after.
  let index = 0;
  while (index < children.length) {
    const current = children[index]!;
    const space = children[index + 1];
    const next = children[index + 2];
    if (
      MARK_TYPES.has(current.type) &&
      current.children?.length &&
      isEmptyText(lastDescendant(current)) &&
      space &&
      isSpace(space) &&
      next &&
      next.type === current.type &&
      sameMarkProps(current, next)
    ) {
      const { children: _a, ...rest } = current;
      const merged: MarkdownNode = {
        ...rest,
        children: [...withoutTrailingEmptyText(current.children), space, ...(next.children ?? [])],
      };
      children.splice(index, 3, merged);
      continue;
    }
    index += 1;
  }
  for (const child of children) rejoinSplitMarks(child);
  node.children = children.filter((c) => !isEmptyText(c));
}

/** The children with the empty text the preset left at the deepest end
 *  taken out, so the joined mark does not carry it. */
function withoutTrailingEmptyText(children: MarkdownNode[]): MarkdownNode[] {
  const last = children.at(-1);
  if (!last) return children;
  if (isEmptyText(last)) return children.slice(0, -1);
  if (last.children) return [...children.slice(0, -1), { ...last, children: withoutTrailingEmptyText(last.children) }];
  return children;
}

function sameMarkProps(a: MarkdownNode, b: MarkdownNode) {
  const strip = ({ children: _c, position: _p, ...rest }: MarkdownNode) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

/** `[a **b** c](u)` leaves ProseMirror as three text runs, and the preset's
 *  serializer closes the link mark after each, so the file got three links
 *  with a space between. Adjacent pieces of one address are joined back into
 *  one link before anything is written. */
function joinSplitLinks(node: MarkdownNode) {
  const children = node.children;
  if (!children) return;
  children.forEach(joinSplitLinks);
  const joined: MarkdownNode[] = [];
  let index = 0;
  while (index < children.length) {
    const head = linkInside(children[index]!);
    if (!head) {
      joined.push(children[index]!);
      index += 1;
      continue;
    }
    const pieces: MarkdownNode[] = [children[index]!];
    let cursor = index + 1;
    while (cursor < children.length) {
      const direct = linkInside(children[cursor]!);
      if (direct && sameLink(direct, head)) {
        pieces.push(children[cursor]!);
        cursor += 1;
        continue;
      }
      // Across a bare space only when exactly one neighbour is the link
      // under a mark: that is the split's signature (`link`, space,
      // `strong(link)`). Two plain links, or two links under the same mark
      // (`**[a](u) [b](u)**`), are two links the writer made.
      const after = children[cursor + 1] ? linkInside(children[cursor + 1]!) : null;
      const previous = pieces.at(-1)!;
      const next = children[cursor + 1];
      if (
        isSpace(children[cursor]!) &&
        after &&
        next &&
        sameLink(after, head) &&
        (previous.type === "link") !== (next.type === "link")
      ) {
        pieces.push(children[cursor]!, next);
        cursor += 2;
        continue;
      }
      break;
    }
    // Only a run the serializer split is joined: at least one piece is the
    // link under a mark. Two plain links to one address a space apart are
    // two links, and two page refs are two chips.
    if (pieces.length === 1 || pieces.every((piece) => isSpace(piece) || piece.type === "link")) {
      joined.push(children[index]!);
      index += 1;
      continue;
    }
    joined.push({
      ...head,
      children: pieces.flatMap((piece) => (isSpace(piece) ? [piece] : withoutLink(piece))),
    });
    index = cursor;
  }
  node.children = joined;
}

/* --- tables: the writer's bytes while no cell changed ---------------------- */

/** A row's cells as the writer spelled them: outer pipes off, split on every
 *  pipe that is not escaped, each cell trimmed. */
function sourceCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (c === "\\" && i + 1 < line.length) {
      cell += c + line[i + 1];
      i += 1;
    } else if (c === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += c;
    }
  }
  cells.push(cell);
  const trimmed = cells.map((c) => c.trim());
  if (/^\s*\|/.test(line)) trimmed.shift();
  if (/\|\s*$/.test(line)) trimmed.pop();
  return trimmed;
}

function sourceAlign(cell: string): string | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : left ? "left" : right ? "right" : null;
}

/** True when every cell and every alignment of the table as it stands reads
 *  the same as the bytes it was loaded from, so those bytes can be written. */
function tableUnchanged(table: MarkdownNode, state: State): boolean {
  const source = str(table.source);
  const lines = source.split("\n");
  const rows = (table.children ?? []) as MarkdownNode[];
  if (lines.length < 2 || lines.length - 1 !== rows.length) return false;
  const delimiters = sourceCells(lines[1]!);
  const align = (table.align ?? []) as (string | null)[];
  if (delimiters.length !== align.length) return false;
  if (delimiters.some((cell, i) => sourceAlign(cell) !== (align[i] ?? null))) return false;
  const exitTable = state.enter("table");
  try {
    return rows.every((row, r) => {
      const written = sourceCells(lines[r < 1 ? 0 : r + 1]!);
      const cells = (row.children ?? []) as MarkdownNode[];
      if (written.length !== cells.length) return false;
      const exitRow = state.enter("tableRow");
      try {
        return cells.every((cell, c) => {
          const value = state.handle(cell, row, state, {
            before: " ",
            after: " ",
            now: { line: 1, column: 1 },
            lineShift: 0,
          });
          // A cell that is only breaks is an empty cell on both sides: the
          // preset reads `<br>` as the empty placeholder and writes
          // `<br />` back for it.
          const bare = (cell: string) => cell.replace(/^(?:<br\s*\/?>)+$/i, "");
          return bare(value.trim()) === bare(written[c]!);
        });
      } finally {
        exitRow();
      }
    });
  } finally {
    exitTable();
  }
}

function keepUnchangedTables(node: MarkdownNode, state: State) {
  const children = node.children;
  if (!children) return;
  node.children = children.map((child) => {
    if (child.type === "table" && typeof child.source === "string" && child.source) {
      return tableUnchanged(child, state) ? { type: "html", value: child.source } : child;
    }
    keepUnchangedTables(child, state);
    return child;
  });
}

const isBreakHtml = (node: MarkdownNode) =>
  node.type === "html" && /^<br\s*\/?>$/i.test(str(node.value).trim());

/** The preset writes an empty paragraph as `<br />`. In a plain list item
 *  that is all the item holds, or in a table cell, the paragraph is the
 *  container's own and the writer typed `-` or `|  |`: the break goes. An
 *  empty task item keeps it, because `- [ ]` without content is not a task
 *  to GFM. */
function stripBareBreaks(node: MarkdownNode) {
  const children = node.children;
  if (!children) return;
  for (const child of children) stripBareBreaks(child);
  if (node.type === "tableCell") {
    for (const child of children) {
      if (child.type === "paragraph" && child.children?.length && child.children.every(isBreakHtml)) {
        child.children = [];
      }
    }
    return;
  }
  // The first paragraph of a plain item, when it is only a break, is the
  // paragraph the schema demands and the writer never typed. Before a
  // nested list it stays, empty, so the item is `-` on its own line and the
  // nested marker does not move up onto it (`- - a`); before anything else
  // (a rule, a heading) it goes, and that block takes the item's line.
  if (node.type === "listItem" && node.checked == null && children.length > 0) {
    const first = children[0]!;
    if (first.type === "paragraph" && first.children?.length && first.children.every(isBreakHtml)) {
      if (children.length > 1 && children[1]!.type !== "list") children.shift();
      else children[0] = { type: "paragraph", children: [] } as MarkdownNode;
    }
  }
}

const root: Handler = (node, _parent, state, info) => {
  rejoinSplitMarks(node);
  joinSplitLinks(node);
  stripBareBreaks(node);
  keepUnchangedTables(node, state);
  return state.containerFlow(node, info);
};

/* --- the configuration ----------------------------------------------------- */

type StringifyOptions = {
  handlers?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Before `pageRef` in the stack: its text handler wraps whatever is set
 *  here, and the spacer rule needs to see Brain's escaping underneath. */
export const fidelityStringify: MilkdownPlugin = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (options) => {
    const current = options as StringifyOptions;
    return {
      ...current,
      bullet: "-",
      bulletOther: "*",
      listItemIndent: "one",
      rule: "-",
      handlers: {
        ...(current.handlers ?? {}),
        text,
        list,
        listItem,
        heading,
        code,
        thematicBreak,
        break: hardBreak,
        link,
        root,
      },
    } as unknown as typeof options;
  });
  return () => {};
};

export const markdownFidelity = [
  remarkSourceShapes,
  fidelityBulletList,
  fidelityOrderedList,
  fidelityListItem,
  fidelityHeading,
  fidelityCodeBlock,
  fidelityHr,
  fidelityHardbreak,
  fidelityLink,
  fidelityTable,
  fidelityStringify,
].flat();
