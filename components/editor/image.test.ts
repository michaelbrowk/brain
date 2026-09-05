// @vitest-environment jsdom

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { DOMSerializer } from "@milkdown/kit/prose/model";
import { getMarkdown } from "@milkdown/kit/utils";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentSrc, setAttachmentSrcResolver } from "./attachment-src";
import { images } from "./image";

const BARE = "/_attachments-v2/abc123456789.png";
const RESOLVED = "/api/media/abc123456789.png?root=root-1&page=page-9&v=2";

afterEach(() => {
  setAttachmentSrcResolver(null);
});

describe("attachmentSrc", () => {
  it("is the identity until a resolver is set, and again once it is cleared", () => {
    expect(attachmentSrc(BARE)).toBe(BARE);
    setAttachmentSrcResolver(() => RESOLVED);
    expect(attachmentSrc(BARE)).toBe(RESOLVED);
    setAttachmentSrcResolver(null);
    expect(attachmentSrc(BARE)).toBe(BARE);
  });
});

describe("the image node", () => {
  it("renders through the resolver at display time and keeps the bare path everywhere the document is", async () => {
    setAttachmentSrcResolver((url) => (url === BARE ? RESOLVED : url));
    const root = document.createElement("div");
    document.body.append(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, `![shot](${BARE})`);
      })
      .use(commonmark)
      .use(images)
      .create();

    try {
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      // What the visitor's browser fetches.
      expect(
        view.dom.querySelector('figure[data-brain-image="true"] img')?.getAttribute("src"),
      ).toBe(RESOLVED);
      // What the document stores.
      expect(editor.action(getMarkdown())).toContain(`![shot](${BARE})`);
      // What a copy puts on the clipboard: the schema's toDOM, which the
      // paste parser reads back verbatim. A rewrite here would write the
      // access triple into the document on the next paste.
      const image = view.state.doc.child(0);
      expect(image.type.name).toBe("brain_image");
      const html = DOMSerializer.fromSchema(view.state.schema).serializeNode(image) as HTMLElement;
      expect(html.querySelector("img")?.getAttribute("src")).toBe(BARE);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
