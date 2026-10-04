// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceTakesKeys } from "./surface-keys";

describe("surfaceTakesKeys", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  const mount = () => {
    const canvas = document.createElement("div");
    const root = document.createElement("section");
    canvas.append(root);
    document.body.append(canvas);
    return { canvas, root };
  };

  it("lets a surface that is on screen take its keys", () => {
    expect(surfaceTakesKeys(mount().root)).toBe(true);
  });

  it("refuses while the canvas around the surface is inert, and no longer", () => {
    const { canvas, root } = mount();
    canvas.setAttribute("inert", "");
    expect(surfaceTakesKeys(root)).toBe(false);
    canvas.removeAttribute("inert");
    expect(surfaceTakesKeys(root)).toBe(true);
  });

  it("refuses a root that is inert itself", () => {
    const { root } = mount();
    root.setAttribute("inert", "");
    expect(surfaceTakesKeys(root)).toBe(false);
  });

  it("refuses a surface with no root to ask", () => {
    expect(surfaceTakesKeys(null)).toBe(false);
  });
});

/** EVERY KEY LISTENER BOUND BY HAND, AND WHO ANSWERS FOR IT.
 *
 *  A listener on the window or the document hears every key on the page, so
 *  each one either asks whether its surface is still on screen or is listed
 *  here with the reason it does not have to. The count is the point: a new
 *  listener in any of these files, or in a file that is not here at all,
 *  reddens this case until somebody has decided which of the two it is.
 *
 *  Read off the syntax tree, not off the text. The first census was a regex
 *  for `window|document.addEventListener("keydown"`, and it could not see a
 *  listener on any other target, a `keyup`, a name in backticks or an
 *  argument on the next line, and it took a comment that spelled the helper's
 *  name for a call to it. What counts here is a call to `addEventListener`
 *  whose first argument is the literal `keydown`, `keyup` or `keypress`, on
 *  any target, and a call to the helper. */
const ASKS: Readonly<Record<string, { listeners: number; asks: string }>> = {
  "components/mail-surface.tsx": { listeners: 1, asks: "surfaceTakesKeys" },
  "components/tasks-surface.tsx": { listeners: 2, asks: "surfaceTakesKeys" },
  "components/tasks-row.tsx": { listeners: 1, asks: "surfaceTakesKeys" },
  "components/editor/slash-menu.tsx": { listeners: 1, asks: "caretMenuTakesKey" },
  "components/editor/wikilink-menu.tsx": { listeners: 1, asks: "caretMenuTakesKey" },
};

const NEED_NOT_ASK: Readonly<Record<string, { listeners: number; why: string }>> = {
  "components/shell.tsx": {
    listeners: 4,
    why: "The shell's own chords, its two undo keys, and the Escape that leaves Settings, which is bound only while Settings is the surface and unbound in the commit that starts its exit. The shell is what the canvases leave from, and it never leaves.",
  },
  "components/tasks-checkbox.tsx": {
    listeners: 1,
    why: "On the checkbox button itself, for Space and Enter. A key reaches it only while the focus is on it, and an inert canvas holds no focus.",
  },
  "components/tasks-when-picker.tsx": {
    listeners: 2,
    why: "On the picker's own clock boxes and its own panel. A key reaches them only while the focus is inside the panel.",
  },
  "components/input-modality.tsx": {
    listeners: 1,
    why: "Records that the keyboard is in use, for the focus ring. It acts on nothing.",
  },
  "components/board.tsx": {
    listeners: 1,
    why: "Bound only while a card is being dragged, and its one key is Escape, which puts the card back and writes nothing. Refusing it on a leaving board would leave the drop as the only way to end the drag.",
  },
  "components/editor/task-checkbox.ts": {
    listeners: 1,
    why: "Escape for the When popover it opened, which stands at the body and holds the focus itself.",
  },
  "components/editor/floating-toolbar.tsx": {
    listeners: 1,
    why: "Escape for its own AI popover, bound only while that is open. It closes the popover and writes nothing.",
  },
};

const KEY_EVENT = /^key(?:down|up|press)$/;
const HELPERS = new Set(["surfaceTakesKeys", "caretMenuTakesKey"]);

/** The key listeners one source file binds, and the calls it makes to each
 *  helper. Comments and strings are not in the tree, so neither can stand in
 *  for a listener or for a call. */
function censusOf(file: string, source: string) {
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let listeners = 0;
  const asks = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "addEventListener" &&
        first !== undefined &&
        ts.isStringLiteralLike(first) &&
        KEY_EVENT.test(first.text)
      ) {
        listeners += 1;
      }
      if (ts.isIdentifier(callee) && HELPERS.has(callee.text)) {
        asks.set(callee.text, (asks.get(callee.text) ?? 0) + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { listeners, asks };
}

describe("the census's own reading", () => {
  it("counts a listener on any target, for any key event, however it is quoted or wrapped", () => {
    const source = [
      'window.addEventListener("keydown", a);',
      "document.addEventListener('keyup', b, true);",
      "box.addEventListener(`keypress`, c);",
      "this.root.current?.addEventListener(",
      '  "keydown",',
      "  d,",
      ");",
      'window.addEventListener("click", e);',
    ].join("\n");
    expect(censusOf("probe.ts", source).listeners).toBe(4);
  });

  it("takes neither a comment nor a string for a listener or for a call to the helper", () => {
    const source = [
      '// window.addEventListener("keydown", onKey) asks surfaceTakesKeys(root)',
      "/* if (!surfaceTakesKeys(root)) return; */",
      'const note = "surfaceTakesKeys(root) and addEventListener(\\"keydown\\")";',
      "void note;",
    ].join("\n");
    const { listeners, asks } = censusOf("probe.ts", source);
    expect(listeners).toBe(0);
    expect(asks.size).toBe(0);
  });

  it("counts the calls that are calls", () => {
    const source = [
      "const onKey = () => {",
      "  if (!surfaceTakesKeys(root)) return;",
      "  if (!caretMenuTakesKey(event, container)) return;",
      "};",
    ].join("\n");
    expect([...censusOf("probe.tsx", source).asks]).toEqual([
      ["surfaceTakesKeys", 1],
      ["caretMenuTakesKey", 1],
    ]);
  });
});

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sources(full, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

describe("key listeners bound by hand", () => {
  const counted = new Map<string, ReturnType<typeof censusOf>>();
  for (const directory of ["components", "app", "lib"]) {
    for (const file of sources(path.join(process.cwd(), directory))) {
      const source = readFileSync(file, "utf8");
      // Parsing every file would be the whole cost of this case, and a file
      // that never says the word binds nothing.
      if (!source.includes("addEventListener")) continue;
      const census = censusOf(file, source);
      if (census.listeners > 0) counted.set(path.relative(process.cwd(), file), census);
    }
  }

  it("are each accounted for, file by file", () => {
    expect(
      Object.fromEntries([...counted].map(([file, { listeners }]) => [file, listeners])),
    ).toEqual(
      Object.fromEntries(
        [...Object.entries(ASKS), ...Object.entries(NEED_NOT_ASK)].map(
          ([file, { listeners }]) => [file, listeners],
        ),
      ),
    );
  });

  it.each(Object.entries(ASKS))("%s asks once for every listener it binds", (file, entry) => {
    expect(counted.get(file)?.asks.get(entry.asks) ?? 0).toBeGreaterThanOrEqual(
      entry.listeners,
    );
  });
});
