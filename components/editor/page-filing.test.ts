// @vitest-environment jsdom
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_PAGE_REF_FILED_CLASS,
  docHasPageRef,
  documentSections,
  FILED_FLASH_CLEAR_MS,
  filePageRefTransaction,
  pageFilingKey,
  pageFilingPlugin,
  refusesUnfiledDrag,
  sectionEndPos,
} from "./page-filing";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    heading: {
      content: "inline*",
      group: "block",
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    page_ref: {
      atom: true,
      inline: true,
      group: "inline",
      attrs: { id: {}, label: { default: "" } },
      toDOM: (node) => [
        "a",
        { class: "brain-page-ref", "data-page-ref": String(node.attrs.id) },
        String(node.attrs.label),
      ],
    },
    // Columns are lanes of the page; a callout holds its own content. A
    // heading in a column is a section, a heading in a callout is not.
    cols: { content: "col+", group: "block", toDOM: () => ["div", 0] },
    col: { content: "block+", toDOM: () => ["div", 0] },
    callout: { content: "block+", group: "block", toDOM: () => ["div", 0] },
    text: { group: "inline" },
  },
});

const prose = (value: string) =>
  schema.node("paragraph", null, schema.text(value));
const heading = (level: number, value: string) =>
  schema.node("heading", { level }, schema.text(value));
const ref = (id: string, label = id) =>
  schema.node("paragraph", null, [schema.node("page_ref", { id, label })]);
const col = (...blocks: ReturnType<typeof prose>[]) =>
  schema.node("col", null, blocks);
const cols = (...blocks: ReturnType<typeof prose>[]) =>
  schema.node("cols", null, [col(...blocks)]);
const callout = (...blocks: ReturnType<typeof prose>[]) =>
  schema.node("callout", null, blocks);
const doc = (...blocks: ReturnType<typeof prose>[]) =>
  schema.node("doc", null, blocks);

/** Titles of the standalone page blocks, in document order. */
function refs(node: ReturnType<typeof doc>) {
  const found: string[] = [];
  node.descendants((child) => {
    if (child.type.name === "page_ref") found.push(String(child.attrs.id));
  });
  return found;
}

/** Block types in document order — where a filed reference landed. A lane
 *  container is spelled out block by block, so a reference filed into a
 *  column shows inside that column. */
function shape(node: ReturnType<typeof doc>): string[] {
  const found: string[] = [];
  node.forEach((child) => {
    const id = child.firstChild?.attrs.id;
    if (child.type.name === "cols" || child.type.name === "col") {
      found.push(`${child.type.name}[${shape(child).join(" ")}]`);
    } else {
      found.push(
        child.type.name === "paragraph" && typeof id === "string" && id
          ? `ref:${id}`
          : `${child.type.name}:${child.textContent}`,
      );
    }
  });
  return found;
}

const file = (
  node: ReturnType<typeof doc>,
  id: string,
  headingIndex: number | null,
) => {
  const state = EditorState.create({ schema, doc: node });
  const tr = filePageRefTransaction(state, {
    id,
    label: `📄 ${id}`,
    headingIndex,
  });
  return tr ? tr.doc : null;
};

describe("docHasPageRef", () => {
  it("counts an inline mention as much as a standalone block", () => {
    const inline = schema.node("paragraph", null, [
      schema.text("See "),
      schema.node("page_ref", { id: "inline", label: "" }),
      schema.text(" first."),
    ]);
    const body = doc(ref("block"), inline);
    expect(docHasPageRef(body, "block")).toBe(true);
    expect(docHasPageRef(body, "inline")).toBe(true);
    expect(docHasPageRef(body, "absent")).toBe(false);
  });
});

describe("sectionEndPos", () => {
  const body = doc(
    prose("Intro"),
    heading(1, "Reading"),
    prose("A"),
    heading(2, "Deeper"),
    prose("B"),
    heading(1, "Writing"),
    prose("C"),
  );

  it("ends a section at the next heading of the same or higher rank", () => {
    // "Reading" owns its own nested "Deeper" section, so it runs to "Writing".
    const writingPos =
      body.child(0).nodeSize +
      body.child(1).nodeSize +
      body.child(2).nodeSize +
      body.child(3).nodeSize +
      body.child(4).nodeSize;
    expect(sectionEndPos(body, 0)).toBe(writingPos);
  });

  it("ends a nested section at the next heading of any higher rank", () => {
    const writingPos =
      body.child(0).nodeSize +
      body.child(1).nodeSize +
      body.child(2).nodeSize +
      body.child(3).nodeSize +
      body.child(4).nodeSize;
    expect(sectionEndPos(body, 1)).toBe(writingPos);
  });

  it("runs the last section, an unknown index, and no placement to the end", () => {
    expect(sectionEndPos(body, 2)).toBe(body.content.size);
    expect(sectionEndPos(body, 9)).toBe(body.content.size);
    expect(sectionEndPos(body, null)).toBe(body.content.size);
    expect(sectionEndPos(doc(prose("Only prose")), 0)).toBe(
      doc(prose("Only prose")).content.size,
    );
  });
});

describe("documentSections", () => {
  // The reader picks a name from this list and the insert resolves the same
  // index against the same list. One walk, so an index cannot mean one block
  // in the picker and another one in the document.
  const body = doc(
    heading(1, "Reading"),
    cols(heading(2, "News"), prose("Inside the column")),
    heading(1, "Writing"),
    prose("C"),
  );

  it("counts a heading inside a column — that is where Smart sort writes them", () => {
    expect(documentSections(body).map((section) => section.text)).toEqual([
      "Reading",
      "News",
      "Writing",
    ]);
  });

  it("files under a column heading inside that column", () => {
    // Smart sort lays the page out as `::::cols` with a `## Section` in each
    // column. The menu used to offer only "End of page" for such a page, and
    // the new child went under the columns, outside every section.
    const filed = file(body, "verbs", 1);
    expect(filed && shape(filed)).toEqual([
      "heading:Reading",
      "cols[col[heading:News paragraph:Inside the column ref:verbs]]",
      "heading:Writing",
      "paragraph:C",
    ]);
  });

  it("ends a top-level section before the next heading of its rank, column and all", () => {
    // "Reading" owns the columns row as one of its blocks; the "News" inside
    // it is in another lane and neither closes "Reading" nor is closed by
    // "Writing".
    const filed = file(body, "verbs", 0);
    expect(filed && shape(filed)).toEqual([
      "heading:Reading",
      "cols[col[heading:News paragraph:Inside the column]]",
      "ref:verbs",
      "heading:Writing",
      "paragraph:C",
    ]);
  });

  it("ends a column section at the next heading of its rank in the same column", () => {
    const twoInOne = doc(
      schema.node("cols", null, [
        col(heading(2, "Left A"), prose("a"), heading(2, "Left B"), prose("b")),
        col(heading(2, "Right"), prose("r")),
      ]),
    );
    expect(documentSections(twoInOne).map((section) => section.text)).toEqual([
      "Left A",
      "Left B",
      "Right",
    ]);
    const filed = file(twoInOne, "verbs", 0);
    expect(filed && shape(filed)).toEqual([
      "cols[col[heading:Left A paragraph:a ref:verbs heading:Left B paragraph:b] col[heading:Right paragraph:r]]",
    ]);
    // A section in the right column runs to the end of the right column.
    const filedRight = file(twoInOne, "verbs", 2);
    expect(filedRight && shape(filedRight)).toEqual([
      "cols[col[heading:Left A paragraph:a heading:Left B paragraph:b] col[heading:Right paragraph:r ref:verbs]]",
    ]);
  });

  it("keeps a heading inside a callout out, columns inside it and all", () => {
    // A callout holds its own content. A `cols` row inside it is the
    // callout's, so its columns are lanes of the aside, not of the page.
    const aside = doc(
      heading(1, "Reading"),
      callout(heading(2, "Aside"), cols(heading(2, "Deeper"))),
    );
    expect(documentSections(aside).map((section) => section.text)).toEqual([
      "Reading",
    ]);
  });

  it("names a heading that is one page reference after that page", () => {
    const named = doc(
      schema.node("heading", { level: 2 }, [
        schema.node("page_ref", { id: "verbs", label: "📄 Verbs" }),
      ]),
      prose("a"),
    );
    expect(documentSections(named).map((section) => section.text)).toEqual([
      "📄 Verbs",
    ]);
  });

  it("reports each section's depth so the menu can show the outline", () => {
    expect(
      documentSections(
        doc(heading(1, "Reading"), heading(3, "Later"), prose("A")),
      ),
    ).toEqual([
      { index: 0, depth: 1, text: "Reading", end: expect.any(Number) },
      { index: 1, depth: 3, text: "Later", end: expect.any(Number) },
    ]);
  });
});

describe("refusesUnfiledDrag", () => {
  const body = doc(heading(1, "Reading"), ref("verbs"), prose("A"));
  const view = (body: ReturnType<typeof doc>, editable = true) => ({
    editable,
    state: { doc: body },
  });

  it("answers a page the body already links, before the release", () => {
    expect(refusesUnfiledDrag(view(body), { id: "verbs", label: "" })).toBe(
      true,
    );
    expect(refusesUnfiledDrag(view(body), { id: "nouns", label: "" })).toBe(
      false,
    );
  });

  it("answers an editor that is not taking mutations", () => {
    expect(
      refusesUnfiledDrag(view(body, false), { id: "nouns", label: "" }),
    ).toBe(true);
  });

  it("lets a drag it cannot read through to the drop, which can read it", () => {
    expect(refusesUnfiledDrag(view(body), null)).toBe(false);
  });

  it("does not answer one document from another one's cache", () => {
    const empty = doc(prose("A"));
    expect(refusesUnfiledDrag(view(body), { id: "verbs", label: "" })).toBe(
      true,
    );
    expect(refusesUnfiledDrag(view(empty), { id: "verbs", label: "" })).toBe(
      false,
    );
    expect(refusesUnfiledDrag(view(body), { id: "verbs", label: "" })).toBe(
      true,
    );
  });
});

describe("filePageRefTransaction", () => {
  it("writes the reference at the end of the chosen section", () => {
    const filed = file(
      doc(heading(1, "Reading"), prose("A"), heading(1, "Writing"), prose("C")),
      "verbs",
      0,
    );
    expect(filed && shape(filed)).toEqual([
      "heading:Reading",
      "paragraph:A",
      "ref:verbs",
      "heading:Writing",
      "paragraph:C",
    ]);
  });

  it("files at the end of a page that has no headings at all", () => {
    const filed = file(doc(prose("Just prose")), "verbs", null);
    expect(filed && shape(filed)).toEqual(["paragraph:Just prose", "ref:verbs"]);
  });

  it("selects the block it just wrote", () => {
    const state = EditorState.create({
      schema,
      doc: doc(heading(1, "Reading"), prose("A")),
    });
    const tr = filePageRefTransaction(state, {
      id: "verbs",
      label: "📄 verbs",
      headingIndex: 0,
    });
    expect(tr?.selection.from).toBe(state.doc.content.size);
    expect(tr?.doc.nodeAt(tr.selection.from)?.firstChild?.attrs.id).toBe("verbs");
  });

  it("marks the block as filed, which the selection alone cannot say", () => {
    // A NodeSelection on a standalone page block is also what picking one up
    // to move it sets, so the confirming flash hangs on this meta instead —
    // "arrived just now", which only the write knows.
    const state = EditorState.create({
      schema,
      doc: doc(heading(1, "Reading"), prose("A")),
    });
    const tr = filePageRefTransaction(state, {
      id: "verbs",
      label: "📄 verbs",
      headingIndex: 0,
    });
    expect(tr?.getMeta(pageFilingKey)).toEqual({
      flash: state.doc.content.size,
    });
    expect(BRAIN_PAGE_REF_FILED_CLASS).toBe("brain-page-ref-filed");
  });

  it("refuses a page the document already links, wherever it links it", () => {
    // The tail row survives until Milkdown serializes, so a second drop or a
    // second menu click inside that window is a real gesture, not a replay.
    const body = doc(heading(1, "Reading"), ref("verbs"), prose("A"));
    expect(file(body, "verbs", 0)).toBeNull();
    expect(file(body, "verbs", null)).toBeNull();
    expect(refs(body)).toEqual(["verbs"]);

    const inline = doc(
      schema.node("paragraph", null, [
        schema.text("See "),
        schema.node("page_ref", { id: "verbs", label: "" }),
      ]),
    );
    expect(file(inline, "verbs", null)).toBeNull();
  });
});

describe("the confirming flash", () => {
  const mounted: EditorView[] = [];

  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy();
    vi.useRealTimers();
  });

  /** The plugin on a real view, which is where the flash's timer lives. */
  function mount() {
    const place = document.body.appendChild(document.createElement("div"));
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: doc(
          heading(1, "Reading"),
          prose("A"),
          heading(1, "Writing"),
          prose("C"),
        ),
        plugins: [pageFilingPlugin()],
      }),
      // jsdom has nothing to scroll, and ProseMirror measures the document to
      // do it.
      handleScrollToSelection: () => true,
    });
    mounted.push(view);
    return view;
  }

  /** The page whose block is flashing, or null while none is. */
  function flashing(view: EditorView) {
    const [flash] = pageFilingKey.getState(view.state)?.find() ?? [];
    if (!flash) return null;
    return view.state.doc.nodeAt(flash.from)?.firstChild?.attrs.id ?? null;
  }

  function fileInto(view: EditorView, id: string, headingIndex: number) {
    const tr = filePageRefTransaction(view.state, {
      id,
      label: `📄 ${id}`,
      headingIndex,
    });
    expect(tr).not.toBeNull();
    if (tr) view.dispatch(tr);
  }

  it("gives a second filing inside the window its own full hold", () => {
    // Two filings 500ms apart. The first block's flash is replaced by the
    // second's, and the timer that was armed for it must go with it — one
    // left running would take the new fill off 220ms in, part-way through
    // the hold, so the block cuts instead of fading.
    vi.useFakeTimers();
    const view = mount();

    fileInto(view, "verbs", 0);
    expect(flashing(view)).toBe("verbs");

    vi.advanceTimersByTime(500);
    fileInto(view, "nouns", 1);
    expect(flashing(view)).toBe("nouns");

    vi.advanceTimersByTime(FILED_FLASH_CLEAR_MS - 500);
    expect(flashing(view)).toBe("nouns");

    vi.advanceTimersByTime(499);
    expect(flashing(view)).toBe("nouns");
    vi.advanceTimersByTime(1);
    expect(flashing(view)).toBeNull();
  });

  it("keeps one window when an edit shifts the block it is on", () => {
    // The decoration moves with the document, and it is the same flash —
    // its window runs from the filing, not from the last keystroke.
    vi.useFakeTimers();
    const view = mount();

    fileInto(view, "verbs", 0);
    vi.advanceTimersByTime(400);
    view.dispatch(view.state.tr.insertText("Now ", 1));
    expect(flashing(view)).toBe("verbs");

    vi.advanceTimersByTime(FILED_FLASH_CLEAR_MS - 400);
    expect(flashing(view)).toBeNull();
  });
});
