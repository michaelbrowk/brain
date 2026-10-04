// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
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

/** EVERY KEY LISTENER ON THE WINDOW OR THE DOCUMENT, AND WHO ANSWERS FOR IT.
 *
 *  A listener up there hears every key on the page, so each one either asks
 *  whether its surface is still on screen or is listed here with the reason
 *  it does not have to. The count is the point: a new listener in any of
 *  these files, or in a file that is not here at all, reddens this case until
 *  somebody has decided which of the two it is. */
const ASKS: Readonly<Record<string, { listeners: number; asks: string }>> = {
  "components/mail-surface.tsx": { listeners: 1, asks: "surfaceTakesKeys(" },
  "components/tasks-surface.tsx": { listeners: 2, asks: "surfaceTakesKeys(" },
  "components/tasks-row.tsx": { listeners: 1, asks: "surfaceTakesKeys(" },
  "components/editor/slash-menu.tsx": { listeners: 1, asks: "caretMenuTakesKey(" },
  "components/editor/wikilink-menu.tsx": { listeners: 1, asks: "caretMenuTakesKey(" },
};

const NEED_NOT_ASK: Readonly<Record<string, { listeners: number; why: string }>> = {
  "components/shell.tsx": {
    listeners: 4,
    why: "The shell's own chords and its two undo keys. The shell is what the canvases leave from, and it never leaves.",
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

const KEY_LISTENER = /\b(?:window|document)\s*\.\s*addEventListener\(\s*["']keydown["']/g;

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

describe("key listeners on the window and the document", () => {
  const counted = new Map<string, { listeners: number; source: string }>();
  for (const directory of ["components", "app", "lib"]) {
    for (const file of sources(path.join(process.cwd(), directory))) {
      const source = readFileSync(file, "utf8");
      const listeners = source.match(KEY_LISTENER)?.length ?? 0;
      if (listeners > 0) {
        counted.set(path.relative(process.cwd(), file), { listeners, source });
      }
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
    const source = counted.get(file)?.source ?? "";
    expect(source.split(entry.asks).length - 1).toBeGreaterThanOrEqual(entry.listeners);
  });
});
