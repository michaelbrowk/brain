// @vitest-environment jsdom

/** Typing cost must not grow with the page. The editor's own plugin stack is
 *  mounted as `milkdown-editor.tsx` mounts it, a keystroke is dispatched on
 *  a 50-line page and on a 5,000-line one, and the number of whole-document
 *  walks the keystroke causes must be the same on both: the presets walk the
 *  document a fixed few times per transaction, and nothing of Brain's may
 *  add a walk that the short page did not also take. Counts, not timings:
 *  a timing gate was red one run in several hundred on a quiet machine and
 *  three in five under load. Before 0.22 a 5k-line page cost dozens of
 *  times a 50-line page per key, from four plugins walking the whole
 *  document on every transaction.
 *
 *  `BRAIN_TYPING_COST_REPORT=1` also prints per-key timings for every size. */

import { TextSelection } from "@milkdown/kit/prose/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mixedPage,
  mountFullStack,
  plainPage,
  wholeDocumentWalks,
  type MountedStack,
} from "./editor-stack.harness";
import { setPageRefOrigin, syncLivePageInfo } from "./page-ref";

const REPORT = process.env.BRAIN_TYPING_COST_REPORT === "1";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Position inside the first top-level block of the given type. */
function insideFirst(stack: MountedStack, type: string): number {
  let found = -1;
  stack.view.state.doc.forEach((node, offset) => {
    if (found < 0 && node.type.name === type) found = offset + 1;
  });
  if (found < 0) throw new Error(`no ${type} in the page`);
  return found;
}

interface Walks {
  paragraphKey: number;
  headingKey: number | null;
  selection: number;
}

/** Whole-document walks one keystroke (and one caret move) causes. */
function walksPerKey(stack: MountedStack): Walks {
  const { view } = stack;
  const topLevelChildren = view.state.doc.childCount;
  const count = (run: () => void) => wholeDocumentWalks(run, { topLevelChildren });
  const place = (pos: number) =>
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  // Warm every lazily built cache first, outside the counted runs.
  place(insideFirst(stack, "paragraph") + 1);
  view.dispatch(view.state.tr.insertText("w", view.state.selection.from));
  const paragraphKey = count(() => {
    view.dispatch(view.state.tr.insertText("x", view.state.selection.from));
  });
  const selection = count(() => place(view.state.selection.from - 1));
  let headingKey: number | null = null;
  if (view.state.doc.firstChild?.type.name === "heading") {
    place(insideFirst(stack, "heading") + 1);
    headingKey = count(() => {
      view.dispatch(view.state.tr.insertText("x", view.state.selection.from));
    });
  }
  return { paragraphKey, headingKey, selection };
}

interface Timing {
  lines: number;
  blocks: number;
  keyMs: number;
  selectionMs: number;
  serializeMs: number;
}

/** Report only: median per-keystroke cost at the top of the page, in ms. */
function timing(stack: MountedStack, markdown: string, keys = 40): Timing {
  const { view, serialize } = stack;
  const start = insideFirst(stack, "paragraph") + 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
  const keyTimes: number[] = [];
  for (let i = 0; i < keys; i += 1) {
    const from = view.state.selection.from;
    const t = performance.now();
    view.dispatch(view.state.tr.insertText("x", from));
    keyTimes.push(performance.now() - t);
  }
  const selectionTimes: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const pos = start + (i % 3);
    const t = performance.now();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    selectionTimes.push(performance.now() - t);
  }
  const t3 = performance.now();
  serialize();
  return {
    lines: markdown.split("\n").filter((line) => line.trim()).length,
    blocks: view.state.doc.childCount,
    keyMs: median(keyTimes),
    selectionMs: median(selectionTimes),
    serializeMs: performance.now() - t3,
  };
}

function fmt(c: Timing) {
  return `lines=${c.lines} blocks=${c.blocks} key=${c.keyMs.toFixed(2)}ms selection=${c.selectionMs.toFixed(2)}ms serialize=${c.serializeMs.toFixed(1)}ms`;
}

describe("typing cost is independent of page size", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ tasks: [] }) }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    syncLivePageInfo();
    setPageRefOrigin("");
    document.body.replaceChildren();
  });

  for (const [name, build] of [
    ["plain", plainPage],
    ["mixed", mixedPage],
  ] as const) {
    it(`${name}: a keystroke on a 5,000-line page walks the document as often as on a 50-line page`, async () => {
      const short = await mountFullStack(build(50));
      const long = await mountFullStack(build(5000));
      try {
        const shortWalks = walksPerKey(short);
        const longWalks = walksPerKey(long);
        expect(longWalks).toEqual(shortWalks);
        if (REPORT) {
          console.log(`[typing-cost] ${name} walks per key: ${JSON.stringify(shortWalks)}`);
          console.log(`[typing-cost] ${name} 50:   ${fmt(timing(short, build(50)))}`);
          const mid = await mountFullStack(build(1800));
          console.log(`[typing-cost] ${name} 1800: ${fmt(timing(mid, build(1800)))}`);
          mid.editor.destroy();
          console.log(`[typing-cost] ${name} 5000: ${fmt(timing(long, build(5000)))}`);
        }
      } finally {
        short.editor.destroy();
        long.editor.destroy();
      }
    }, 600_000);
  }
});
