// @vitest-environment jsdom

import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView, type DecorationSet } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinkPreviewPlugin } from "./link-preview";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
  marks: {
    link: {
      attrs: { href: {} },
      toDOM: (mark) => ["a", { href: mark.attrs.href }, 0],
    },
  },
});

const URL_TEXT = "https://example.com/post";

function bareLinkDoc() {
  return schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(
      null,
      schema.text(URL_TEXT, [schema.marks.link.create({ href: URL_TEXT })]),
    ),
  ]);
}

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.restoreAllMocks();
});

function mount(enabled: boolean) {
  const plugin = createLinkPreviewPlugin(enabled);
  const state = EditorState.create({ schema, doc: bareLinkDoc(), plugins: [plugin] });
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView(host, { state });
  views.push(view);
  return { plugin, state, host };
}

describe("createLinkPreviewPlugin", () => {
  it("decorates a bare external link with a card when unfurl is a capability", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ title: "Post" }), { status: 200 }),
    );
    const { plugin, state, host } = mount(true);
    const set = plugin.props.decorations!.call(plugin, state) as DecorationSet | null;
    expect(set?.find()).toHaveLength(2);
    expect(host.querySelector(".brain-embed")).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves the bare link alone and makes no request without it", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { plugin, state, host } = mount(false);
    expect(plugin.props.decorations!.call(plugin, state)).toBeNull();
    expect(host.querySelector(".brain-embed")).toBeNull();
    expect(host.querySelector(".brain-embed-source")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
