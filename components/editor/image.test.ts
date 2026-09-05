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
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("inline images and attachment links", () => {
  const PDF_BARE = "/_attachments-v2/abc123456789.pdf";
  const PDF_RESOLVED = "/api/media/abc123456789.pdf?root=root-1&page=page-9&v=2";
  const resolver = (url: string) =>
    url === BARE ? RESOLVED : url === PDF_BARE ? PDF_RESOLVED : url;

  async function editorWith(markdown: string) {
    const { attachmentRefs } = await import("./attachment-refs");
    const root = document.createElement("div");
    document.body.append(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
      })
      .use(commonmark)
      .use(attachmentRefs)
      .use(images)
      .create();
    return {
      editor,
      view: editor.action((ctx) => ctx.get(editorViewCtx)),
      dispose: async () => {
        await editor.destroy();
        root.remove();
      },
    };
  }

  it("renders an image inside a paragraph and a file link through the resolver, and stores both bare", async () => {
    setAttachmentSrcResolver(resolver);
    const md = `before ![shot](${BARE}) after\n\n[📎 doc](${PDF_BARE})`;
    const { editor, view, dispose } = await editorWith(md);
    try {
      expect(view.dom.querySelector("p img")?.getAttribute("src")).toBe(RESOLVED);
      expect(view.dom.querySelector("p a")?.getAttribute("href")).toBe(PDF_RESOLVED);
      expect(editor.action(getMarkdown())).toContain(`![shot](${BARE})`);
      expect(editor.action(getMarkdown())).toContain(`[📎 doc](${PDF_BARE})`);
    } finally {
      await dispose();
    }
  });

  it("takes the access triple back out of pasted HTML, for a figure, an inline image and a link", async () => {
    setAttachmentSrcResolver(resolver);
    // pasteHTML builds a ClipboardEvent for the paste props; jsdom has none.
    vi.stubGlobal("ClipboardEvent", class extends Event {});
    const { editor, view, dispose } = await editorWith("start");
    try {
      view.pasteHTML(
        `<figure data-brain-image="true"><img src="${RESOLVED}" alt="fig"></figure>` +
          `<p>inline <img src="${RESOLVED}" alt="in"> here</p>` +
          `<p><a href="${PDF_RESOLVED}">📎 doc</a></p>`,
      );
      const md = editor.action(getMarkdown());
      expect(md).toContain(`![fig](${BARE})`);
      expect(md).toContain(`![in](${BARE}`); // the preset copies alt into title
      expect(md).toContain(`[📎 doc](${PDF_BARE})`);
      expect(md).not.toContain("/api/media");
      expect(md).not.toContain("root=");
    } finally {
      vi.unstubAllGlobals();
      await dispose();
    }
  });

  it("retries an image that failed to load, once, when asked", async () => {
    const { noteAttachmentLoadFailure, retryFailedAttachmentImages } = await import(
      "./attachment-src"
    );
    setAttachmentSrcResolver(resolver);
    const { view, dispose } = await editorWith(`![shot](${BARE})\n\ntext ![in](${BARE})`);
    try {
      // img[src]: ProseMirror adds a src-less separator img after a trailing
      // inline atom, which is not an attachment.
      const imgs = [...view.dom.querySelectorAll("img[src]")];
      expect(imgs).toHaveLength(2);
      for (const img of imgs) img.dispatchEvent(new Event("error"));
      expect(retryFailedAttachmentImages()).toBe(2);
      for (const img of imgs) {
        expect(img.getAttribute("src")?.startsWith(RESOLVED), img.getAttribute("src") ?? "").toBe(true);
        expect(img.getAttribute("src")).not.toBe(RESOLVED);
      }
      expect(retryFailedAttachmentImages()).toBe(0);
      // An image that never failed is not touched.
      const untouched = document.createElement("img");
      noteAttachmentLoadFailure(untouched, "https://example.com/x.png");
      expect(retryFailedAttachmentImages()).toBe(0);
    } finally {
      await dispose();
    }
  });
});

describe("bareAttachmentSrc", () => {
  it("is the exact inverse of the resolver and leaves everything else alone", async () => {
    const { bareAttachmentSrc } = await import("./attachment-src");
    expect(bareAttachmentSrc(RESOLVED)).toBe(BARE);
    expect(bareAttachmentSrc("/api/media/abc123456789.png")).toBe(BARE);
    expect(bareAttachmentSrc(`${BARE}?page=p&v=1`)).toBe(BARE);
    expect(bareAttachmentSrc(BARE)).toBe(BARE);
    expect(bareAttachmentSrc("/_attachments/abc123456789.png")).toBe("/_attachments/abc123456789.png");
    expect(bareAttachmentSrc("https://example.com/x.png?a=1")).toBe("https://example.com/x.png?a=1");
    expect(bareAttachmentSrc("/api/media/../etc")).toBe("/api/media/../etc");
  });
});
