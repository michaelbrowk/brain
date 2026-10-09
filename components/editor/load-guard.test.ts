// @vitest-environment jsdom

import { Editor, defaultValueCtx, parserCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { MarkdownNode, Root } from "@milkdown/kit/transformer";
import { $remark } from "@milkdown/kit/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { images } from "./image";
import { loadGuard, parseDropCount } from "./load-guard";

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

  it("marks a later parse that dropped content, for an external write to refuse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { editor } = await load("plain", [blockEveryImage]);
    const lossy = editor.action((ctx) => ctx.get(parserCtx)("# Title ![i](/a.png) end"));
    const whole = editor.action((ctx) => ctx.get(parserCtx)("# Title end"));
    expect(parseDropCount(lossy!)).toBeGreaterThan(0);
    expect(parseDropCount(whole!)).toBe(0);
    await editor.destroy();
  });
});

/** A page whose load drops content. Real shapes keep being fixed (a toggle
 *  inside a column loaded whole once nested fences were repaired), so the
 *  loss comes from the old block-image pass above: the heading holding an
 *  image cannot be built and is dropped with its words. */
const LOSSY = [
  "* [ ] task line",
  "",
  ':::callout{icon="💡"}',
  "aside",
  ":::",
  "",
  "# SECRET WORDS ![i](/a.png) end",
].join("\n");

describe("a page whose load dropped content", () => {
  async function lossyPage() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { taskCheckboxMarkdown } = await import("./task-checkbox");
    const { callout } = await import("./callout");
    const { columns } = await import("./columns");
    const { toggle } = await import("./toggle");
    const { listener, listenerCtx } = await import("@milkdown/kit/plugin/listener");
    const { editorViewCtx } = await import("@milkdown/kit/core");
    const saves: string[] = [];
    const onLoss = vi.fn();
    const root = document.createElement("div");
    document.body.append(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, LOSSY);
        ctx.get(listenerCtx).markdownUpdated((_, md, prev) => {
          if (md !== prev) saves.push(md);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(taskCheckboxMarkdown)
      .use(columns)
      .use(callout)
      .use(toggle)
      .use(images)
      .use(blockEveryImage)
      .use(loadGuard(onLoss))
      .use(listener)
      .create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    return { editor, view, root, saves, onLoss };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

  // Read-only stops typing, not the controls a NodeView draws, nor the
  // editor's own dispatches: each of these saved the shortened document.
  it("refuses a task checkbox tick", async () => {
    const { editor, view, root, saves, onLoss } = await lossyPage();
    expect(onLoss).toHaveBeenCalled();
    const before = view.state.doc;
    root
      .querySelector<HTMLElement>(".brain-task-box")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    expect(view.state.doc.eq(before)).toBe(true);
    expect(saves).toEqual([]);
    await editor.destroy();
  });

  it("refuses a callout icon pick", async () => {
    const { editor, view, saves } = await lossyPage();
    const before = view.state.doc;
    let pos = -1;
    view.state.doc.descendants((node, at) => {
      if (node.type.name === "callout") pos = at;
    });
    view.dispatch(view.state.tr.setNodeAttribute(pos, "icon", "🔥"));
    await settle();
    expect(view.state.doc.eq(before)).toBe(true);
    expect(saves).toEqual([]);
    await editor.destroy();
  });

  it("refuses a drop or any other insertion", async () => {
    const { editor, view, saves } = await lossyPage();
    const before = view.state.doc;
    const { insert } = await import("@milkdown/kit/utils");
    editor.action(insert("[📎 file.pdf](/_attachments/file.pdf)"));
    view.dispatch(view.state.tr.insertText("typed", 1));
    await settle();
    expect(view.state.doc.eq(before)).toBe(true);
    expect(saves).toEqual([]);
    await editor.destroy();
  });
});

describe("what the guard counts", () => {
  it("counts a node the parser could not add, not only one it could not close", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { $nodeSchema } = await import("@milkdown/kit/utils");
    // A block that takes paragraphs, handed bare text: `addNode` cannot
    // build it and the parser drops it in silence.
    const box = $nodeSchema("zz_box", () => ({
      group: "block",
      content: "paragraph+",
      parseDOM: [{ tag: "section" }],
      toDOM: () => ["section", 0],
      parseMarkdown: {
        match: (node) => node.type === "zzBox",
        runner: (state, _node, type) => {
          state.addNode(type, undefined, [type.schema.text("loose")]);
        },
      },
      toMarkdown: { match: () => false, runner: () => {} },
    }));
    const boxes = $remark("zzBoxes", () => () => (tree: Root) => {
      const root = tree as unknown as MarkdownNode;
      root.children = root.children?.map((child) =>
        child.type === "paragraph" ? { type: "zzBox" } : child,
      );
    });
    const { editor, onLoss } = await load("BOX", [box, boxes]);
    expect(onLoss).toHaveBeenCalledWith(1);
    await editor.destroy();
  });

  it("holds the editor state back until the counting parser is in place", async () => {
    const { editorStateTimerCtx } = await import("@milkdown/kit/core");
    const { editor } = await load("text");
    const timers = editor.action((ctx) => ctx.get(editorStateTimerCtx));
    expect(timers.map((timer) => timer.name)).toContain("BrainLoadGuardReady");
    await editor.destroy();
  });
});
