// @vitest-environment jsdom

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Schema, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { $prose, getMarkdown } from "@milkdown/kit/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentUploadProgressOptions,
  UploadedAttachment,
} from "./attachments";
import {
  createImageUploadController,
  handleWrapperImageDrop,
  imageUploadPluginKey,
} from "./image-upload";
import { images } from "./image";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      toDOM: () => ["p", 0],
    },
    columns: {
      content: "col+",
      group: "block",
      toDOM: () => ["div", { "data-columns": "true" }, 0],
    },
    col: {
      content: "block+",
      toDOM: () => ["div", { "data-col": "true" }, 0],
    },
    table: {
      content: "table_row+",
      group: "block",
      toDOM: () => ["div", { "data-table": "true" }, 0],
    },
    table_row: {
      content: "table_cell+",
      toDOM: () => ["div", { "data-row": "true" }, 0],
    },
    table_cell: {
      content: "block+",
      toDOM: () => ["div", { "data-cell": "true" }, 0],
    },
    text: { group: "inline" },
    brain_image: {
      group: "block",
      atom: true,
      attrs: {
        src: { default: "" },
        alt: { default: "" },
        width: { default: null },
        align: { default: null },
        title: { default: null },
      },
      toDOM: (node) => [
        "figure",
        { "data-brain-image": "true" },
        ["img", { src: node.attrs.src, alt: node.attrs.alt }],
      ],
    },
  },
});

type DeferredUpload = {
  file: File;
  options: AttachmentUploadProgressOptions;
  resolve: (value: UploadedAttachment) => void;
  reject: (reason: unknown) => void;
};

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});

function paragraph(text: string): ProseNode {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
}

function deferredUploader() {
  const calls: DeferredUpload[] = [];
  const upload = (file: File, options: AttachmentUploadProgressOptions) =>
    new Promise<UploadedAttachment>((resolve, reject) => {
      calls.push({ file, options, resolve, reject });
    });
  return { calls, upload };
}

function idFactory() {
  let value = 0;
  return () => `test-id-${++value}`;
}

function createView(
  upload: ReturnType<typeof deferredUploader>["upload"],
  doc = schema.nodes.doc.create(null, [paragraph("alpha"), paragraph("omega")]),
) {
  const revoked: string[] = [];
  const controller = createImageUploadController({
    upload,
    makeId: idFactory(),
    createPreviewUrl: (file) => `blob:${file.name}`,
    revokePreviewUrl: (url) => revoked.push(url),
    errorDurationMs: 60_000,
  });
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 2),
    plugins: [controller.plugin],
  });
  const mount = document.createElement("div");
  document.body.append(mount);
  const view = new EditorView(mount, { state });
  views.push(view);
  return { controller, view, revoked };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function uploaded(file: File, url: string): UploadedAttachment {
  return {
    url,
    name: file.name,
    size: file.size,
    type: file.type,
  };
}

function positionOf(doc: ProseNode, predicate: (node: ProseNode) => boolean) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (!predicate(node)) return true;
    found = pos;
    return false;
  });
  return found;
}

function nestedDocument(container: "col" | "table_cell") {
  const content = [paragraph("alpha"), paragraph("omega")];
  if (container === "col") {
    return schema.nodes.doc.create(null, [
      schema.nodes.columns.create(null, [schema.nodes.col.create(null, content)]),
    ]);
  }
  return schema.nodes.doc.create(null, [
    schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [
        schema.nodes.table_cell.create(null, content),
      ]),
    ]),
  ]);
}

describe("image upload decorations", () => {
  it("never serializes its placeholder into real Milkdown markdown", async () => {
    const uploader = deferredUploader();
    const controller = createImageUploadController({
      upload: uploader.upload,
      makeId: idFactory(),
      createPreviewUrl: () => "blob:markdown.png",
      revokePreviewUrl: () => undefined,
      errorDurationMs: 60_000,
    });
    const root = document.createElement("div");
    document.body.append(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, "alpha");
      })
      .use(commonmark)
      .use(gfm)
      .use(images)
      .use($prose(() => controller.plugin))
      .create();

    try {
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      const file = new File(["pixels"], "markdown.png", { type: "image/png" });
      controller.start(view, [file], 2);
      expect(editor.action(getMarkdown()).trim()).toBe("alpha");

      uploader.calls[0].options.onProgress?.(55);
      expect(editor.action(getMarkdown()).trim()).toBe("alpha");

      uploader.calls[0].reject(new Error("offline"));
      await settle();
      expect(editor.action(getMarkdown()).trim()).toBe("alpha");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("shows immediate preview/progress without changing the serializable document", () => {
    const uploader = deferredUploader();
    const { controller, view } = createView(uploader.upload);
    const before = view.state.doc.toJSON();
    const file = new File(["pixels"], "first.png", { type: "image/png" });

    const [id] = controller.start(view, [file], 2);

    expect(view.state.doc.toJSON()).toEqual(before);
    expect(imageUploadPluginKey.getState(view.state)?.find()).toHaveLength(1);
    expect(view.dom.querySelector(`[data-upload-id="${id}"] img`)?.getAttribute("src"))
      .toBe("blob:first.png");
    expect(view.dom.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow"))
      .toBe("0");

    uploader.calls[0].options.onProgress?.(42);

    expect(view.state.doc.toJSON()).toEqual(before);
    expect(view.dom.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow"))
      .toBe("42");
    expect(view.dom.querySelector("[role=status]")).toBeNull();
    expect(view.dom.querySelector("[role=progressbar]")?.getAttribute("aria-valuetext"))
      .toBe("Uploading image, 42%");
  });

  it("maps the placeholder through edits and inserts a normal image at that position", async () => {
    const uploader = deferredUploader();
    const { controller, view, revoked } = createView(uploader.upload);
    const file = new File(["pixels"], "mapped.png", { type: "image/png" });
    controller.start(view, [file], 3);

    view.dispatch(view.state.tr.insertText("Z", 1));
    uploader.calls[0].resolve(uploaded(file, "/_attachments-v2/mapped.png"));
    await settle();

    expect(view.state.doc.toJSON()).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Zal" }] },
        {
          type: "brain_image",
          attrs: {
            src: "/_attachments-v2/mapped.png",
            alt: "",
            width: null,
            align: null,
            title: null,
          },
        },
        { type: "paragraph", content: [{ type: "text", text: "pha" }] },
        { type: "paragraph", content: [{ type: "text", text: "omega" }] },
      ],
    });
    expect(imageUploadPluginKey.getState(view.state)?.find()).toHaveLength(0);
    expect(revoked).toEqual(["blob:mapped.png"]);
  });

  it.each(["col", "table_cell"] as const)(
    "keeps an upload attached when its block moves inside %s",
    async (containerType) => {
      const uploader = deferredUploader();
      const { controller, view } = createView(
        uploader.upload,
        nestedDocument(containerType),
      );
      const firstPos = positionOf(
        view.state.doc,
        (node) => node.type.name === "paragraph" && node.textContent === "alpha",
      );
      const first = view.state.doc.nodeAt(firstPos)!;
      const file = new File(["pixels"], `${containerType}.png`, {
        type: "image/png",
      });
      controller.start(view, [file], firstPos + 3);

      const move = view.state.tr.delete(firstPos, firstPos + first.nodeSize);
      const containerPos = positionOf(
        move.doc,
        (node) => node.type.name === containerType,
      );
      const container = move.doc.nodeAt(containerPos)!;
      move.insert(containerPos + 1 + container.content.size, first);
      view.dispatch(move.setMeta("uiEvent", "drop"));

      expect(view.dom.querySelector(".brain-image-upload")).not.toBeNull();
      uploader.calls[0].resolve(
        uploaded(file, `/_attachments-v2/${containerType}.png`),
      );
      await settle();

      const sequence: string[] = [];
      view.state.doc.descendants((node) => {
        if (node.type.name === "paragraph") sequence.push(node.textContent);
        if (node.type.name === "brain_image") sequence.push(String(node.attrs.src));
      });
      expect(sequence).toEqual([
        "omega",
        "al",
        `/_attachments-v2/${containerType}.png`,
        "pha",
      ]);
    },
  );

  it("keeps concurrent files in selection order when responses finish out of order", async () => {
    const uploader = deferredUploader();
    const { controller, view } = createView(uploader.upload);
    const first = new File(["a"], "first.png", { type: "image/png" });
    const second = new File(["b"], "second.png", { type: "image/png" });
    controller.start(view, [first, second], 6);

    uploader.calls[1].resolve(uploaded(second, "/_attachments-v2/second.png"));
    await settle();
    expect(JSON.stringify(view.state.doc.toJSON())).not.toContain("second.png");

    uploader.calls[0].resolve(uploaded(first, "/_attachments-v2/first.png"));
    await settle();

    const urls: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === "brain_image") urls.push(String(node.attrs.src));
    });
    expect(urls).toEqual([
      "/_attachments-v2/first.png",
      "/_attachments-v2/second.png",
    ]);
  });

  it("keeps separate user actions at the same position in A then B order", async () => {
    const uploader = deferredUploader();
    const { controller, view } = createView(uploader.upload);
    const first = new File(["a"], "first.png", { type: "image/png" });
    const second = new File(["b"], "second.png", { type: "image/png" });
    controller.start(view, [first], 6);
    controller.start(view, [second], 6);

    uploader.calls[1].resolve(uploaded(second, "/_attachments-v2/second.png"));
    await settle();
    expect(JSON.stringify(view.state.doc.toJSON())).not.toContain("second.png");

    uploader.calls[0].resolve(uploaded(first, "/_attachments-v2/first.png"));
    await settle();

    const urls: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === "brain_image") urls.push(String(node.attrs.src));
    });
    expect(urls).toEqual([
      "/_attachments-v2/first.png",
      "/_attachments-v2/second.png",
    ]);
  });

  it("keeps independent concurrent uploads mapped to their original blocks", async () => {
    const uploader = deferredUploader();
    const { controller, view } = createView(uploader.upload);
    const first = new File(["a"], "alpha.png", { type: "image/png" });
    const second = new File(["b"], "omega.png", { type: "image/png" });
    controller.start(view, [first], 3);
    controller.start(view, [second], 10);

    view.dispatch(view.state.tr.insertText("Z", 1));
    uploader.calls[1].resolve(uploaded(second, "/_attachments-v2/omega.png"));
    await settle();
    uploader.calls[0].resolve(uploaded(first, "/_attachments-v2/alpha.png"));
    await settle();

    const sequence: string[] = [];
    view.state.doc.forEach((node) => {
      sequence.push(
        node.type.name === "brain_image"
          ? String(node.attrs.src)
          : node.textContent,
      );
    });
    expect(sequence).toEqual([
      "Zal",
      "/_attachments-v2/alpha.png",
      "pha",
      "om",
      "/_attachments-v2/omega.png",
      "ega",
    ]);
  });

  it("collapses a pasted image selection and preserves typing before success", async () => {
    const uploader = deferredUploader();
    const { view } = createView(uploader.upload);
    const file = new File(["pixels"], "paste.png", { type: "image/png" });
    const before = view.state.doc.toJSON();
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 5)),
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [file], getData: () => "" },
    });

    view.dom.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(uploader.calls).toHaveLength(1);
    expect(view.state.selection.from).toBe(5);
    expect(view.state.selection.to).toBe(5);
    expect(view.state.doc.toJSON()).toEqual(before);

    view.dispatch(view.state.tr.insertText("NEW"));
    uploader.calls[0].resolve(uploaded(file, "/_attachments-v2/paste.png"));
    await settle();

    const sequence: string[] = [];
    view.state.doc.forEach((node) => {
      sequence.push(
        node.type.name === "brain_image" ? String(node.attrs.src) : node.textContent,
      );
    });
    expect(sequence).toEqual([
      "a",
      "/_attachments-v2/paste.png",
      "NEWa",
      "omega",
    ]);
  });

  it("keeps the selected text and later typing when the paste upload fails", async () => {
    const uploader = deferredUploader();
    const { view } = createView(uploader.upload);
    const file = new File(["pixels"], "failed-paste.png", { type: "image/png" });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 5)),
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [file], getData: () => "" },
    });
    view.dom.dispatchEvent(event);

    expect(view.state.selection.from).toBe(5);
    expect(view.state.selection.to).toBe(5);
    view.dispatch(view.state.tr.insertText("NEW"));
    uploader.calls[0].reject(new Error("offline"));
    await settle();

    expect(view.state.doc.textContent).toBe("alphNEWaomega");
    expect(view.dom.querySelector("[role=alert]")?.textContent)
      .toBe("Couldn't upload image.");
  });

  it("handles a real editor drop at the event coordinates", async () => {
    const uploader = deferredUploader();
    const { view } = createView(uploader.upload);
    const file = new File(["pixels"], "drop.png", { type: "image/png" });
    vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 10, inside: -1 });
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: 40 },
      clientY: { value: 80 },
      dataTransfer: {
        value: { files: [file], getData: () => "" },
      },
    });

    view.dom.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(uploader.calls).toHaveLength(1);
    uploader.calls[0].resolve(uploaded(file, "/_attachments-v2/drop.png"));
    await settle();
    expect(JSON.stringify(view.state.doc.toJSON())).toContain("drop.png");
  });

  it("prevents wrapper-whitespace navigation and uploads at the document end", async () => {
    const uploader = deferredUploader();
    const { view } = createView(uploader.upload);
    const file = new File(["pixels"], "below.png", { type: "image/png" });
    vi.spyOn(view, "posAtCoords").mockReturnValue(null);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const beforeUrl = window.location.href;

    expect(
      handleWrapperImageDrop(
        view,
        { clientX: 20, clientY: 2000, preventDefault, stopPropagation },
        [file],
      ),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(window.location.href).toBe(beforeUrl);
    expect(uploader.calls).toHaveLength(1);

    uploader.calls[0].resolve(uploaded(file, "/_attachments-v2/below.png"));
    await settle();
    expect(view.state.doc.lastChild?.type.name).toBe("brain_image");
  });

  it("removes a failed placeholder, leaves the document intact, and announces the error", async () => {
    const uploader = deferredUploader();
    const { controller, view, revoked } = createView(uploader.upload);
    const before = view.state.doc.toJSON();
    const file = new File(["pixels"], "broken.png", { type: "image/png" });
    controller.start(view, [file], 2);

    uploader.calls[0].reject(new Error("offline"));
    await settle();

    expect(view.state.doc.toJSON()).toEqual(before);
    expect(view.dom.querySelector(".brain-image-upload")).toBeNull();
    expect(view.dom.querySelector("[role=alert]")?.textContent)
      .toBe("Couldn't upload image.");
    expect(revoked).toEqual(["blob:broken.png"]);
  });

  it("aborts pending requests and revokes previews when the editor is destroyed", () => {
    const uploader = deferredUploader();
    const { controller, view, revoked } = createView(uploader.upload);
    const file = new File(["pixels"], "pending.png", { type: "image/png" });
    controller.start(view, [file], 2);

    view.destroy();
    views.splice(views.indexOf(view), 1);

    expect(uploader.calls[0].options.signal?.aborted).toBe(true);
    expect(revoked).toEqual(["blob:pending.png"]);
  });
});
