// @vitest-environment jsdom

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it } from "vitest";
import { INTERNAL_PAGE_LINK_CLASS } from "@/lib/internal-page-link";
import { attachmentRefs } from "./attachment-refs";
import { pageRef, setPageRefOrigin, syncLivePageInfo } from "./page-ref";

/** THE MARKER ON LINKED WORDS IS PROSEMIRROR'S OWN.
 *
 *  0.21.0 put `brain-internal-page-link` on the anchors after ProseMirror drew
 *  them, from a MutationObserver. ProseMirror reads a class write on a mark's
 *  DOM as a change to the range the mark covers, and two such writes in one
 *  flush cover more than either mark, so the redraw replaced both anchors
 *  with fresh ones, the observer marked those, and the page never loaded.
 *  The link mark's view draws the class itself now, so nothing else writes to
 *  the editor's DOM and a body with any number of these settles at mount. */

const ORIGIN = window.location.origin;
const editors: Editor[] = [];

afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
});

async function mount(markdown: string) {
  setPageRefOrigin(ORIGIN);
  syncLivePageInfo([
    { id: "abc123", title: "Alpha" },
    { id: "def456", title: "Beta" },
  ]);
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark.filter((plugin) => plugin !== syncHeadingIdPlugin))
    .use(attachmentRefs)
    .use(pageRef)
    .create();
  editors.push(editor);
  const view = editor.ctx.get(editorViewCtx) as EditorView;
  let updates = 0;
  const updateState = view.updateState.bind(view);
  view.updateState = (state) => {
    updates++;
    updateState(state);
  };
  return { view, root, updates: () => updates };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

function anchors(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLAnchorElement>(".ProseMirror a")];
}

describe("the linked-words marker", () => {
  it.each([
    ["one", "x [a](/p/abc123#words) y", 1],
    ["two to one page", "x [a](/p/abc123#words) mid [b](/p/abc123#words) y", 2],
    ["two to two pages", "x [a](/p/abc123#words) mid [b](/p/def456#words) y", 2],
    ["three in two paragraphs", "[a](/p/abc123#words) [b](/p/def456#words)\n\n[c](/p/abc123#words)", 3],
  ])("is drawn on %s at mount and the editor stays idle", async (_name, markdown, count) => {
    const { root, updates } = await mount(markdown);
    const drawn = anchors(root);
    expect(drawn.filter((a) => a.classList.contains(INTERNAL_PAGE_LINK_CLASS))).toHaveLength(count);
    await settle();
    expect(updates()).toBe(0);
    expect(anchors(root)).toEqual(drawn);
  });

  it("is drawn only on linked words, never on a chip or a web link", async () => {
    const { root } = await mount(
      "[a](/p/abc123#words) [Beta](/p/def456) [site](https://example.com) [b](/p/def456#words) [frag](/p/abc123#other)",
    );
    const marked = anchors(root).map((a) => [a.textContent, a.classList.contains(INTERNAL_PAGE_LINK_CLASS)]);
    expect(marked.filter(([, on]) => on).map(([text]) => text)).toEqual(["a", "b"]);
    expect(root.querySelector(".brain-page-ref")?.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(false);
  });

  it("follows the href when the mark changes", async () => {
    const { view, root } = await mount("x [a](https://example.com) y");
    expect(anchors(root)[0].classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(false);
    const link = view.state.schema.marks.link;
    view.dispatch(view.state.tr.addMark(3, 4, link.create({ href: "/p/abc123#words" })));
    expect(anchors(root)[0].classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(true);
    view.dispatch(view.state.tr.addMark(3, 4, link.create({ href: "https://example.com" })));
    expect(anchors(root)[0].classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(false);
  });
});
