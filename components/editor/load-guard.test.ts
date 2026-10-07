// @vitest-environment jsdom

import { Editor, defaultValueCtx, parserCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { MarkdownNode, Root } from "@milkdown/kit/transformer";
import { $remark } from "@milkdown/kit/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { images } from "./image";
import { loadGuard } from "./load-guard";

/** The remark pass `image.ts` used to run: every image child of anything
 *  becomes the block image. Kept here as the one known shape that loses
 *  content, so the guard has something real to catch. */
const blockEveryImage = $remark("zzBlockEveryImage", () => () => (tree: Root) => {
  const walk = (node: MarkdownNode) => {
    node.children = node.children?.map((child) => {
      if (child.type === "image") return { ...child, type: "brainImage" };
      walk(child);
      return child;
    });
  };
  walk(tree as unknown as MarkdownNode);
});

async function load(markdown: string, extra: unknown[] = []) {
  const onLoss = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(images)
    .use(extra.flat() as never)
    .use(loadGuard(onLoss))
    .create();
  return { editor, onLoss, root };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("loadGuard", () => {
  it("reports a load that would drop a heading the schema cannot build", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { editor, onLoss } = await load("# Title ![i](/a.png) end\n\nafter", [
      blockEveryImage,
    ]);
    expect(onLoss).toHaveBeenCalledTimes(1);
    expect(onLoss.mock.calls[0][0]).toBeGreaterThan(0);
    await editor.destroy();
  });

  it("stays quiet for documents that load whole", async () => {
    const corpus = [
      "# Title ![i](/a.png) end",
      "| a | b |\n| - | - |\n| x ![i](/a.png) | ![i](/a.png) |",
      "- one\n- ![i](/a.png)\n  - nested",
      "![i](/a.png)\n\n> ![i](/a.png)\n\n```ts\nconst x = 1;\n```",
      "",
    ];
    for (const markdown of corpus) {
      const { editor, onLoss } = await load(markdown);
      expect(onLoss, markdown).not.toHaveBeenCalled();
      await editor.destroy();
    }
  });

  it("reports only the load, not a later parse such as a pasted document", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { editor, onLoss } = await load("plain", [blockEveryImage]);
    editor.action((ctx) => ctx.get(parserCtx)("# Title ![i](/a.png) end"));
    expect(onLoss).not.toHaveBeenCalled();
    await editor.destroy();
  });
});
