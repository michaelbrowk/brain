// @vitest-environment jsdom

/** The editor's own half of an external write: the callback `MilkdownEditor`
 *  registers with the shell, on the real component. It hands over a keystroke
 *  that has not been serialized yet before anything is applied ("dirty"), and
 *  after an apply nothing of the old text comes back as an edit: no deferred
 *  serialize of it, no change flag, and the next flush compares against the
 *  applied body. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalWriteResult } from "./external-write";
import { MilkdownEditor } from "./milkdown-editor";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

type Apply = (markdown: string) => ExternalWriteResult;

describe("MilkdownEditor's registered external write", () => {
  let host: HTMLDivElement;
  let root: Root;
  let apply: Apply | null;
  let flush: (() => void) | null;
  let changes: string[];
  let dirty: number;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, "", "/p/page1");
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ tasks: [] }) }));
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    apply = null;
    flush = null;
    changes = [];
    dirty = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/");
  });

  async function mount(value: string) {
    await act(async () =>
      root.render(
        <MilkdownEditor
          value={value}
          onChange={(markdown) => changes.push(markdown.trim())}
          onDirty={() => {
            dirty += 1;
          }}
          registerFlush={(next) => {
            flush = next;
            return () => {
              if (flush === next) flush = null;
            };
          }}
          registerExternalWrite={(next) => {
            apply = next;
            return () => {
              if (apply === next) apply = null;
            };
          }}
        />,
      ),
    );
    // Milkdown builds its view asynchronously.
    for (let i = 0; i < 50 && !host.querySelector(".ProseMirror"); i += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    const view = host.querySelector<HTMLElement>(".ProseMirror");
    if (!view || !apply) throw new Error("the editor did not mount");
    return view;
  }

  /** A keystroke as the browser delivers it: the text node changes, and
   *  ProseMirror's DOM observer reads it back into a transaction. */
  async function typeAtEnd(view: HTMLElement, text: string) {
    const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
    if (!last) throw new Error("no text");
    await act(async () => {
      last.data += text;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("hands over an unserialized keystroke instead of applying over it", async () => {
    const view = await mount("Alpha line.\n\nOmega line.");
    await typeAtEnd(view, " KEY");
    expect(dirty).toBe(1);
    expect(changes).toEqual([]);

    let result: ExternalWriteResult | undefined;
    await act(async () => {
      result = apply!("Alpha line.\n\nOmega line, edited elsewhere.");
    });

    expect(result).toBe("dirty");
    expect(changes).toEqual(["Alpha line.\n\nOmega line. KEY"]);
    expect(view.textContent).toContain("KEY");
    expect(view.textContent).not.toContain("edited elsewhere");
  });

  it("after an apply, nothing of the old text comes back as an edit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const view = await mount("Alpha line.\n\nOmega line.");
    let result: ExternalWriteResult | undefined;
    await act(async () => {
      result = apply!("Alpha line, from the phone.\n\nOmega line.");
    });
    expect(result).toBe("applied");
    expect(view.textContent).toContain("from the phone");

    // No deferred serialize, no change flag, and a flush against the applied
    // body finds nothing to hand over.
    await act(async () => vi.advanceTimersByTime(2_000));
    await act(async () => flush!());
    expect(changes).toEqual([]);
    expect(dirty).toBe(0);
  });
});
