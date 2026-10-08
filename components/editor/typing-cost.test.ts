// @vitest-environment jsdom

/** Typing cost must not grow with the page. The editor's own plugin stack is
 *  mounted as `milkdown-editor.tsx` mounts it, a keystroke is dispatched at
 *  the top of a 50-line page and of a 5,000-line one, and the per-key cost of
 *  the long page may be at most a small multiple of the short one. Before
 *  0.22 a 5k-line page cost dozens of times a 50-line page per key: four
 *  plugins walked the whole document on every transaction.
 *
 *  `BRAIN_TYPING_COST_REPORT=1` prints the measurements for every size. */

import { TextSelection } from "@milkdown/kit/prose/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixedPage, mountFullStack, plainPage } from "./editor-stack.harness";
import { setPageRefOrigin, syncLivePageInfo } from "./page-ref";

const REPORT = process.env.BRAIN_TYPING_COST_REPORT === "1";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface TypingCost {
  lines: number;
  blocks: number;
  bytes: number;
  mountMs: number;
  keyMs: number;
  selectionMs: number;
  serializeMs: number;
}

/** Median per-keystroke cost of typing at the top of the page, in ms. */
export async function measureTypingCost(markdown: string, keys = 40): Promise<TypingCost> {
  const t0 = performance.now();
  const { editor, view, serialize } = await mountFullStack(markdown);
  const mountMs = performance.now() - t0;
  const firstText = 2;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, firstText)));
  // Warm the JIT and the first-paint caches outside the measured run.
  for (let i = 0; i < 5; i += 1) {
    view.dispatch(view.state.tr.insertText("w", view.state.selection.from));
  }
  const keyTimes: number[] = [];
  for (let i = 0; i < keys; i += 1) {
    const from = view.state.selection.from;
    const t = performance.now();
    view.dispatch(view.state.tr.insertText("x", from));
    keyTimes.push(performance.now() - t);
  }
  const selectionTimes: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const pos = firstText + (i % 3);
    const t = performance.now();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    selectionTimes.push(performance.now() - t);
  }
  const t3 = performance.now();
  const markdownOut = serialize();
  const serializeMs = performance.now() - t3;
  const cost = {
    lines: markdown.split("\n").filter((line) => line.trim()).length,
    blocks: view.state.doc.childCount,
    bytes: markdownOut.length,
    mountMs,
    keyMs: median(keyTimes),
    selectionMs: median(selectionTimes),
    serializeMs,
  };
  editor.destroy();
  return cost;
}

function fmt(c: TypingCost) {
  return `lines=${c.lines} blocks=${c.blocks} bytes=${c.bytes} mount=${c.mountMs.toFixed(0)}ms key=${c.keyMs.toFixed(2)}ms selection=${c.selectionMs.toFixed(2)}ms serialize=${c.serializeMs.toFixed(1)}ms`;
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

  /** jsdom has no layout, so the per-key floor is the plugin stack alone,
   *  about 0.2 ms bare. A long page is allowed a small multiple of the short
   *  page, plus a fixed allowance that keeps GC pauses from failing a run. */
  const MULTIPLE = 3;
  const ALLOWANCE_MS = 1;

  for (const [name, build] of [
    ["plain", plainPage],
    ["mixed", mixedPage],
  ] as const) {
    it(`${name}: a 5,000-line page costs at most ${MULTIPLE}x a 50-line page per key`, async () => {
      const short = await measureTypingCost(build(50));
      const long = await measureTypingCost(build(5000));
      if (REPORT) {
        const mid = await measureTypingCost(build(1800));
        console.log(`[typing-cost] ${name} 50:   ${fmt(short)}`);
        console.log(`[typing-cost] ${name} 1800: ${fmt(mid)}`);
        console.log(`[typing-cost] ${name} 5000: ${fmt(long)}`);
      }
      expect(long.keyMs).toBeLessThanOrEqual(short.keyMs * MULTIPLE + ALLOWANCE_MS);
      expect(long.selectionMs).toBeLessThanOrEqual(short.selectionMs * MULTIPLE + ALLOWANCE_MS);
    }, 600_000);
  }
});
