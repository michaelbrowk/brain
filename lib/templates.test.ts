// @vitest-environment jsdom

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { getMarkdown } from "@milkdown/kit/utils";
import { afterEach, describe, expect, it } from "vitest";
import { columns } from "@/components/editor/columns";
import { emptyBlocks } from "@/components/editor/empty-block";
import {
  hasTemplateCaret,
  requestTemplateCaret,
  takeTemplateCaret,
  TEMPLATES,
} from "./templates";

afterEach(() => {
  document.body.replaceChildren();
});

async function loadTemplate(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    // same order as milkdown-editor.tsx: `columns` carries the stray-directive
    // guard that keeps "1:1" in a heading from parsing as a text directive
    .use(columns)
    .use(emptyBlocks)
    .create();
}

function expectWritableSections(editor: Editor, label: string) {
  const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
  doc.forEach((node, _offset, index) => {
    if (node.type.name !== "heading") return;
    const next = doc.maybeChild(index + 1);
    expect(
      next && next.type.name !== "heading",
      `${label}: "${node.textContent}" has nothing to type into`,
    ).toBe(true);
  });
  // the explicit empty paragraphs are real blocks, not literal text
  expect(doc.textContent, label).not.toContain("empty-block");
}

describe("page templates", () => {
  const filled = TEMPLATES.filter((template) => template.markdown !== "");

  it("gives every section a writable line under its heading", async () => {
    for (const template of filled) {
      const editor = await loadTemplate(template.markdown);
      try {
        expectWritableSections(editor, template.id);
      } finally {
        await editor.destroy();
      }
    }
  });

  it("instantiates an unchecked task checkbox, not a literal \"[ ]\" bullet", async () => {
    for (const [id, section] of [
      ["meeting", "Action items"],
      ["project", "Tasks"],
    ] as const) {
      const template = TEMPLATES.find((candidate) => candidate.id === id)!;
      const editor = await loadTemplate(template.markdown);
      try {
        const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
        let headingIndex = -1;
        doc.forEach((node, _offset, index) => {
          if (node.type.name === "heading" && node.textContent === section) headingIndex = index;
        });
        const list = doc.maybeChild(headingIndex + 1);
        expect(list?.type.name, id).toBe("bullet_list");
        const item = list?.firstChild;
        expect(item?.type.name, id).toBe("list_item");
        expect(item?.attrs.checked, `${id}: task checkbox state`).toBe(false);
        expect(item?.textContent, `${id}: no literal marker text`).toBe("");
        // the editor's own serialisation of an empty task item
        expect(editor.action(getMarkdown())).toContain("* [ ] <br />");
      } finally {
        await editor.destroy();
      }
    }
  });

  it("keeps its empty sections through a serialize → reload round-trip", async () => {
    const count = (markdown: string) => markdown.split("::empty-block").length - 1;
    for (const template of filled) {
      const editor = await loadTemplate(template.markdown);
      try {
        const serialized = editor.action(getMarkdown());
        expect(count(serialized), template.id).toBe(count(template.markdown));
        const reloaded = await loadTemplate(serialized);
        try {
          expectWritableSections(reloaded, `${template.id} (reloaded)`);
        } finally {
          await reloaded.destroy();
        }
      } finally {
        await editor.destroy();
      }
    }
  });
});

describe("template caret handoff", () => {
  it("is taken once, only by the page the menu created", () => {
    requestTemplateCaret("new-page", 1_000);
    expect(hasTemplateCaret("other-page", 1_001)).toBe(false);
    expect(takeTemplateCaret("other-page", 1_001)).toBe(false);
    // peeking does not consume — the editor mounts more than once per page
    expect(hasTemplateCaret("new-page", 1_001)).toBe(true);
    expect(hasTemplateCaret("new-page", 1_002)).toBe(true);
    expect(takeTemplateCaret("new-page", 1_003)).toBe(true);
    expect(takeTemplateCaret("new-page", 1_004)).toBe(false);
  });

  it("expires, so an abandoned navigation never moves the caret later", () => {
    requestTemplateCaret("new-page", 1_000);
    expect(hasTemplateCaret("new-page", 1_000 + 10_000)).toBe(false);
    expect(takeTemplateCaret("new-page", 1_000 + 10_000)).toBe(false);
  });

  it("starts every filled template with an empty section for the caret", () => {
    for (const template of TEMPLATES.filter((candidate) => candidate.markdown !== "")) {
      expect(template.markdown, template.id).toMatch(/^## [^\n]+\n\n::empty-block\n/);
    }
  });
});
