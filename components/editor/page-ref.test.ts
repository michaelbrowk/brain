// @vitest-environment jsdom

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { getMarkdown } from "@milkdown/kit/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pageRef,
  setPageRefOrigin,
  syncLivePageInfo,
} from "./page-ref";

const ORIGIN = "https://brain.example";

afterEach(() => {
  syncLivePageInfo();
  setPageRefOrigin("");
  document.body.replaceChildren();
});

describe("page references", () => {
  it("splits a baked emoji label on an unresolved page without changing its text", async () => {
    setPageRefOrigin(ORIGIN);
    const root = document.createElement("div");
    document.body.append(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(
          defaultValueCtx,
          "[👩🏽‍💻 Gone page](/p/gone)\n\n[Plain label](/p/plain)",
        );
      })
      .use(commonmark)
      .use(gfm)
      .use(pageRef)
      .create();

    try {
      const gone = root.querySelector<HTMLAnchorElement>('[data-page-ref="gone"]')!;
      const plain = root.querySelector<HTMLAnchorElement>('[data-page-ref="plain"]')!;
      expect(gone.textContent).toBe("👩🏽‍💻 Gone page");
      expect(gone.querySelector(".brain-page-ref-icon")?.textContent).toBe("👩🏽‍💻");
      expect(gone.lastChild?.textContent).toBe(" Gone page");
      expect(plain.textContent).toBe("Plain label");
      expect(plain.querySelector(".brain-page-ref-icon")).toBeNull();
      expect(editor.action(getMarkdown())).toContain("[👩🏽‍💻 Gone page](/p/gone)");
    } finally {
      await editor.destroy();
    }
  });

  it("round-trips exact internal destinations while leaving other links ordinary", async () => {
    setPageRefOrigin(ORIGIN);
    syncLivePageInfo([
      { id: "relative", title: "Relative live", icon: "🧠" },
      { id: "absolute", title: "Absolute live" },
    ]);
    const root = document.createElement("div");
    document.body.append(root);
    const markdown = [
      "[Relative stale](/p/relative)",
      `[Absolute stale](${ORIGIN}/p/absolute)`,
      "[Foreign](https://foreign.example/p/relative)",
      "[Query](/p/relative?view=full)",
      `[Hash](${ORIGIN}/p/absolute#section)`,
      "[Trailing slash](/p/relative/)",
      "[Missing stale](/p/missing)",
    ].join("\n\n");
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
      })
      .use(commonmark)
      .use(gfm)
      .use(pageRef)
      .create();

    try {
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      const nodeTypes: string[] = [];
      let ordinaryLinks = 0;
      view.state.doc.descendants((node) => {
        nodeTypes.push(node.type.name);
        ordinaryLinks += node.marks.filter((mark) => mark.type.name === "link").length;
      });

      expect(nodeTypes.filter((type) => type === "page_ref")).toHaveLength(3);
      expect(ordinaryLinks).toBe(4);
      const relative = root.querySelector<HTMLAnchorElement>(
        '[data-page-ref="relative"]',
      )!;
      const absolute = root.querySelector<HTMLAnchorElement>(
        '[data-page-ref="absolute"]',
      )!;
      const missing = root.querySelector<HTMLAnchorElement>(
        '[data-page-ref="missing"]',
      )!;
      expect(relative.textContent).toBe("🧠 Relative live");
      expect(absolute.getAttribute("href")).toBe("/p/absolute");
      expect(absolute.textContent).toBe("📄 Absolute live");
      // the icon sits in its own span (for the 2px gap) — textContent above is
      // what parseDOM and search read, so it must stay "<icon> <title>"
      expect(relative.querySelector(".brain-page-ref-icon")?.textContent).toBe("🧠");
      expect(relative.childNodes).toHaveLength(2);
      expect(relative.lastChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(relative.lastChild?.textContent).toBe(" Relative live");
      // a stale label with no icon prefix stays one text node
      expect(missing.querySelector(".brain-page-ref-icon")).toBeNull();
      expect(missing.childNodes).toHaveLength(1);
      expect(missing.hasAttribute("href")).toBe(false);
      expect(missing.getAttribute("aria-disabled")).toBe("true");
      expect(missing.getAttribute("aria-label")).toBe(
        "Page unavailable: Missing stale",
      );

      const serialized = editor.action(getMarkdown());
      expect(serialized).toContain("[🧠 Relative live](/p/relative)");
      expect(serialized).toContain("[📄 Absolute live](/p/absolute)");
      expect(serialized).toContain("[Missing stale](/p/missing)");
      expect(serialized).toContain(
        "[Foreign](https://foreign.example/p/relative)",
      );
      expect(serialized).toContain("[Query](/p/relative?view=full)");
      expect(serialized).toContain(
        `[Hash](${ORIGIN}/p/absolute#section)`,
      );
      expect(serialized).toContain("[Trailing slash](/p/relative/)");
    } finally {
      await editor.destroy();
    }
  });

  it("refreshes rename, icon, and newly resolved DOM without a transaction", async () => {
    setPageRefOrigin(ORIGIN);
    syncLivePageInfo([
      { id: "known", title: "Before rename", icon: "📄" },
    ]);
    const root = document.createElement("div");
    document.body.append(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(
          defaultValueCtx,
          "[Known stale](/p/known)\n\n[Missing stale](/p/missing)",
        );
      })
      .use(commonmark)
      .use(gfm)
      .use(pageRef)
      .create();

    try {
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      const beforeDocument = view.state.doc.toJSON();
      const dispatch = vi.spyOn(view, "dispatch");
      const known = root.querySelector<HTMLAnchorElement>(
        '[data-page-ref="known"]',
      )!;
      const missing = root.querySelector<HTMLAnchorElement>(
        '[data-page-ref="missing"]',
      )!;
      expect(known.textContent).toBe("📄 Before rename");
      expect(missing.hasAttribute("href")).toBe(false);

      syncLivePageInfo([
        { id: "known", title: "After rename", icon: "🪄" },
        { id: "missing", title: "Now resolved", icon: "🌱" },
      ]);

      expect(dispatch).not.toHaveBeenCalled();
      expect(view.state.doc.toJSON()).toEqual(beforeDocument);
      expect(root.querySelector('[data-page-ref="known"]')).toBe(known);
      expect(root.querySelector('[data-page-ref="missing"]')).toBe(missing);
      expect(known.textContent).toBe("🪄 After rename");
      expect(known.querySelector(".brain-page-ref-icon")?.textContent).toBe("🪄");
      expect(missing.textContent).toBe("🌱 Now resolved");
      expect(missing.querySelector(".brain-page-ref-icon")?.textContent).toBe("🌱");
      expect(missing.getAttribute("href")).toBe("/p/missing");
      expect(missing.hasAttribute("aria-disabled")).toBe(false);

      const serialized = editor.action(getMarkdown());
      expect(serialized).toContain("[🪄 After rename](/p/known)");
      expect(serialized).toContain("[🌱 Now resolved](/p/missing)");
    } finally {
      await editor.destroy();
    }
  });
});
