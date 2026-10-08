/** The editor's plugin stack as `milkdown-editor.tsx` mounts it, for tests
 *  that need the whole of it rather than one plugin: the typing-cost gate and
 *  any probe that asks what a keystroke costs with every plugin listening.
 *  The React-bound block handle is the one piece left out, since it needs a
 *  provider. Not a test file: vitest collects `*.test.ts` only. */

import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { tableBlock } from "@milkdown/kit/component/table-block";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { attachmentRefs } from "./attachment-refs";
import { callout } from "./callout";
import { colorMarks } from "./color-mark";
import { columnDrop } from "./column-drop";
import { columns } from "./columns";
import { createDeferredSerializer, deferredSerialize } from "./deferred-serialize";
import { editingCore } from "./editing-core";
import { emptyBlocks } from "./empty-block";
import { images } from "./image";
import { imageUploadPlugin } from "./image-upload";
import { linkPreviewPlugin } from "./link-preview";
import { loadGuard } from "./load-guard";
import { math } from "./math";
import { normalizeLegacy } from "./normalize";
import { pageFiling } from "./page-filing";
import { pageRef, setPageRefOrigin, syncLivePageInfo } from "./page-ref";
import { createPageRefNesting } from "./page-ref-nesting";
import { searchHighlight } from "./search-highlight";
import { tableCells } from "./table-cell";
import { noNestedTables } from "./table-guard";
import { taskCheckbox } from "./task-checkbox";
import { toggle } from "./toggle";

export const HARNESS_ORIGIN = "http://localhost:3000";

/** How many times `run` walked a whole document. `Node.descendants` is
 *  `nodesBetween(0, size)` on the node, so one count covers both spellings,
 *  and only a walk that starts at a `doc` node and spans all of it counts: a
 *  plugin that reads the block under the caret is what this is meant to
 *  allow. The count is what makes "independent of page size" a test and not
 *  a timing. */
export function wholeDocumentWalks(run: () => void): number {
  const prototype = ProseNode.prototype as unknown as {
    nodesBetween: (this: ProseNode, from: number, to: number, ...rest: unknown[]) => void;
  };
  const original = prototype.nodesBetween;
  let walks = 0;
  prototype.nodesBetween = function (this: ProseNode, from, to, ...rest) {
    if (this.type.name === "doc" && from === 0 && to === this.content.size) walks += 1;
    return original.call(this, from, to, ...rest);
  };
  try {
    run();
  } finally {
    prototype.nodesBetween = original;
  }
  return walks;
}

/** `n` lines of prose only. */
export function plainPage(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(`Line ${i} of the page, a sentence with a few words and a number ${i * 7}.`);
  }
  return lines.join("\n\n");
}

/** `n` lines mixing what a real note holds: headings, inline marks and links,
 *  bullet and task items, a card URL alone on its line, a page row, a quote. */
export function mixedPage(n: number): string {
  const lines: string[] = [];
  let i = 0;
  while (lines.length < n) {
    lines.push(
      `## Section ${i}`,
      `Paragraph ${i} with **bold**, _em_, a [link](https://example.com/${i}) and Cyrillic текст ${i}.`,
      `- item ${i}a`,
      `- [ ] task ${i}`,
      `- item ${i}c`,
      `https://example.org/card${i % 5}`,
      `[Page](/p/abc123)`,
      `> quoted ${i}`,
    );
    i += 1;
  }
  return lines.slice(0, n).join("\n\n");
}

export interface MountedStack {
  editor: Editor;
  view: EditorView;
  serialize: () => string;
  root: HTMLElement;
}

export async function mountFullStack(markdown: string): Promise<MountedStack> {
  const root = document.createElement("div");
  document.body.append(root);
  setPageRefOrigin(HARNESS_ORIGIN);
  syncLivePageInfo([{ id: "abc123", title: "Page", icon: "" }]);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark.filter((plugin) => plugin !== syncHeadingIdPlugin))
    .use(gfm)
    .use(taskCheckbox)
    .use(attachmentRefs)
    .use(noNestedTables)
    .use(tableCells)
    .use(normalizeLegacy)
    .use(editingCore)
    .use(colorMarks)
    .use(columns)
    .use(emptyBlocks)
    .use(callout)
    .use(toggle)
    .use(images)
    .use(imageUploadPlugin(null))
    .use(math)
    .use(pageRef)
    .use(linkPreviewPlugin(true))
    .use(tableBlock)
    .use(history)
    .use(clipboard)
    .use(cursor)
    .use(pageFiling)
    .use(createPageRefNesting(() => null, false, () => {}, () => {}))
    .use(columnDrop)
    .use(searchHighlight)
    .use(loadGuard(() => {}))
    .use(deferredSerialize(createDeferredSerializer(), () => {}))
    .create();
  const view = editor.ctx.get(editorViewCtx) as EditorView;
  const serialize = () => editor.ctx.get(serializerCtx)(view.state.doc);
  return { editor, view, serialize, root };
}
