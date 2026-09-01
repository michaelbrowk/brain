import { describe, expect, it } from "vitest";
import {
  appendStandalonePageRef,
  mapMarkdownOffset,
  openContainerClosers,
  removeOneStandalonePageRef,
  removeStandalonePageRefs,
  removeStandalonePageRefOccurrence,
  removeStandalonePageRefOccurrenceWithRestore,
  restoreStandalonePageRefAtOffset,
  standalonePageRefOccurrences,
} from "./page-ref-nesting";

describe("removeOneStandalonePageRef", () => {
  it("removes exactly one standalone reference and preserves surrounding prose", () => {
    const source = [
      "Intro",
      "[First](/p/source_id)",
      "Middle [inline](/p/source_id) mention",
      "[Duplicate](/p/source_id)",
      "Tail",
    ].join("\n\n");

    expect(removeOneStandalonePageRef(source, "source_id")).toEqual({
      markdown: [
        "Intro",
        "Middle [inline](/p/source_id) mention",
        "[Duplicate](/p/source_id)",
        "Tail",
      ].join("\n\n"),
      removed: true,
    });
  });

  it("handles a reference at either document boundary", () => {
    expect(
      removeOneStandalonePageRef("[Page](/p/id)\n\nBody", "id"),
    ).toEqual({ markdown: "Body", removed: true });
    expect(
      removeOneStandalonePageRef("Body\n\n[Page](/p/id)", "id"),
    ).toEqual({ markdown: "Body", removed: true });
  });

  it("does not remove inline mentions or a different page", () => {
    const markdown = "Text [Page](/p/id) stays inline";
    expect(removeOneStandalonePageRef(markdown, "id")).toEqual({
      markdown,
      removed: false,
    });
    expect(removeOneStandalonePageRef("[Page](/p/other)", "id")).toEqual({
      markdown: "[Page](/p/other)",
      removed: false,
    });
  });

  it("does not remove a paragraph containing two page references", () => {
    const markdown = "[Other](/p/other) [Source](/p/id)";
    expect(removeOneStandalonePageRef(markdown, "id")).toEqual({
      markdown,
      removed: false,
    });
  });

  it("does not treat bracketed prose followed by a reference as standalone", () => {
    const markdown = "[Draft] notes before [Source](/p/id)";
    expect(removeOneStandalonePageRef(markdown, "id")).toEqual({
      markdown,
      removed: false,
    });
  });

  it("accepts escaped brackets inside the one standalone link label", () => {
    expect(removeOneStandalonePageRef("[\\[Draft\\]](/p/id)", "id")).toEqual({
      markdown: "",
      removed: true,
    });
  });

  it("binds duplicate refs to their exact ordinal and raw fingerprint", () => {
    const markdown = [
      "[First label](/p/id)",
      "Unique prose between duplicates",
      "[Second label](/p/id)",
    ].join("\n\n");
    const fingerprints = standalonePageRefOccurrences(markdown, "id");
    expect(fingerprints).toEqual([
      "[First label](/p/id)",
      "[Second label](/p/id)",
    ]);
    expect(
      removeStandalonePageRefOccurrence(markdown, "id", 1, fingerprints[1]),
    ).toEqual({
      markdown: "[First label](/p/id)\n\nUnique prose between duplicates",
      removed: true,
    });
  });

  it("rejects an ordinal/fingerprint mismatch without changing markdown", () => {
    const markdown = "[First](/p/id)\n\n[Second](/p/id)";
    expect(
      removeStandalonePageRefOccurrence(
        markdown,
        "id",
        1,
        "[First](/p/id)",
      ),
    ).toEqual({ markdown, removed: false });
  });

  it("ignores page-looking links inside fenced and indented code", () => {
    const markdown = [
      "```md",
      "[Code ref](/p/id)",
      "```",
      "",
      "    [Indented code ref](/p/id)",
      "",
      "[Real ref](/p/id)",
    ].join("\n");

    expect(standalonePageRefOccurrences(markdown, "id")).toEqual([
      "[Real ref](/p/id)",
    ]);
    expect(
      removeStandalonePageRefOccurrence(
        markdown,
        "id",
        0,
        "[Real ref](/p/id)",
      ),
    ).toEqual({
      markdown: [
        "```md",
        "[Code ref](/p/id)",
        "```",
        "",
        "    [Indented code ref](/p/id)",
      ].join("\n"),
      removed: true,
    });
  });

  it("uses the exact raw paragraph including harmless outer spaces", () => {
    const markdown = "Intro\n\n  [Spaced](/p/id)  \n\nTail";
    expect(standalonePageRefOccurrences(markdown, "id")).toEqual([
      "  [Spaced](/p/id)  ",
    ]);
    expect(
      removeStandalonePageRefOccurrence(
        markdown,
        "id",
        0,
        "[Spaced](/p/id)",
      ),
    ).toEqual({ markdown, removed: false });
  });

  it("restores the selected duplicate at its mapped position without replacing later text", () => {
    const markdown = [
      "[First](/p/id)",
      "Middle",
      "[Second](/p/id)",
      "Tail",
    ].join("\n\n");
    const fingerprints = standalonePageRefOccurrences(markdown, "id");
    const removal = removeStandalonePageRefOccurrenceWithRestore(
      markdown,
      "id",
      1,
      fingerprints[1],
    );
    expect(removal.removed).toBe(true);
    expect(removal.restorePoint).toBeDefined();

    const laterMarkdown = `${removal.markdown}\n\nLate text`;
    const mappedOffset = mapMarkdownOffset(
      removal.markdown,
      laterMarkdown,
      removal.restorePoint!.insertionOffset,
    );
    expect(mappedOffset).toBe(removal.restorePoint!.insertionOffset);
    expect(
      restoreStandalonePageRefAtOffset(laterMarkdown, {
        ...removal.restorePoint!,
        insertionOffset: mappedOffset!,
      }),
    ).toEqual({
      markdown: `${markdown}\n\nLate text`,
      restored: true,
    });
  });

  it("shifts an Undo point through text inserted before it", () => {
    const before = "Intro\n\nTail";
    const after = "New lead\n\nIntro\n\nTail";
    expect(mapMarkdownOffset(before, after, "Intro".length)).toBe(
      "New lead\n\nIntro".length,
    );
  });

  it("fails closed when a later replacement spans the Undo point", () => {
    expect(mapMarkdownOffset("before-after", "rewritten", 6)).toBeNull();
  });
});


describe("removeStandalonePageRefs", () => {
  it("takes every standalone reference and leaves the prose between them", () => {
    const markdown = [
      "Intro prose stays in place.",
      "## Beds & Borders",
      "[Tomato Trial Rows](/p/id)",
      "Middle prose stays in place.",
      "[Tomato Trial Rows](/p/id)",
      "Tail prose stays in place.",
    ].join("\n\n");

    expect(removeStandalonePageRefs(markdown, "id")).toEqual({
      markdown: [
        "Intro prose stays in place.",
        "## Beds & Borders",
        "Middle prose stays in place.",
        "Tail prose stays in place.",
      ].join("\n\n"),
      removed: 2,
    });
  });

  it("removes two adjacent references without cutting into the text after them", () => {
    const markdown = "[A](/p/id)\n\n[A](/p/id)\n\nKeep this line.";

    expect(removeStandalonePageRefs(markdown, "id")).toEqual({
      markdown: "Keep this line.",
      removed: 2,
    });
  });

  it("never touches a reference inside a sentence", () => {
    const markdown = "The brief for [Tomato Trial](/p/id) was written in March.";

    expect(removeStandalonePageRefs(markdown, "id")).toEqual({
      markdown,
      removed: 0,
    });
  });

  it("leaves other pages' references alone", () => {
    const markdown = "[Mine](/p/id)\n\n[Theirs](/p/other)";

    expect(removeStandalonePageRefs(markdown, "id")).toEqual({
      markdown: "[Theirs](/p/other)",
      removed: 1,
    });
  });
});

/** A page laid out in two columns, exactly as the "organize" action writes it:
 *  the closing `:::` sits on the line after the last row, with no blank line
 *  between. */
const COLUMNS = [
  "::::cols",
  ":::col",
  "## Beds & Borders",
  "",
  "[Archive](/p/arch)",
  "",
  "[Tomato Trial Rows](/p/toms)",
  ":::",
  "",
  ":::col",
  "## Trials",
  "",
  "[Bees](/p/bees)",
  ":::",
  "::::",
].join("\n");

describe("page rows inside columns", () => {
  it("finds a row wherever it sits in the layout, first or last in its lane", () => {
    expect(standalonePageRefOccurrences(COLUMNS, "arch")).toEqual([
      "[Archive](/p/arch)",
    ]);
    // The one the closing fence used to swallow.
    expect(standalonePageRefOccurrences(COLUMNS, "toms")).toEqual([
      "[Tomato Trial Rows](/p/toms)",
    ]);
    expect(standalonePageRefOccurrences(COLUMNS, "bees")).toEqual([
      "[Bees](/p/bees)",
    ]);
  });

  it("numbers rows across lanes in document order", () => {
    const markdown = [
      "[Top](/p/dup)",
      "",
      "::::cols",
      ":::col",
      "[Left](/p/dup)",
      ":::",
      "",
      ":::col",
      "[Right](/p/dup)",
      ":::",
      "::::",
    ].join("\n");

    expect(standalonePageRefOccurrences(markdown, "dup")).toEqual([
      "[Top](/p/dup)",
      "[Left](/p/dup)",
      "[Right](/p/dup)",
    ]);
  });

  it("removes one row from a column and leaves the layout standing", () => {
    expect(
      removeStandalonePageRefOccurrence(
        COLUMNS,
        "toms",
        0,
        "[Tomato Trial Rows](/p/toms)",
      ),
    ).toEqual({
      markdown: [
        "::::cols",
        ":::col",
        "## Beds & Borders",
        "",
        "[Archive](/p/arch)",
        ":::",
        "",
        ":::col",
        "## Trials",
        "",
        "[Bees](/p/bees)",
        ":::",
        "::::",
      ].join("\n"),
      removed: true,
    });
  });

  it("sweeps a moved page's rows out of every lane", () => {
    const markdown = [
      "::::cols",
      ":::col",
      "[Left](/p/dup)",
      "",
      "Prose stays",
      ":::",
      "",
      ":::col",
      "[Right](/p/dup)",
      "",
      "More prose",
      ":::",
      "::::",
    ].join("\n");

    // Removal eats the whitespace before a row and none after it, so a row that
    // opened its lane leaves behind the blank line that followed it. Markdown
    // reads that the same, and Undo puts the row back into the exact gap.
    expect(removeStandalonePageRefs(markdown, "dup")).toEqual({
      markdown: [
        "::::cols",
        ":::col",
        "",
        "Prose stays",
        ":::",
        "",
        ":::col",
        "",
        "More prose",
        ":::",
        "::::",
      ].join("\n"),
      removed: 2,
    });
  });

  it("leaves a reference inside a callout or a toggle alone", () => {
    for (const container of ["callout", 'toggle{summary="Later"}']) {
      const markdown = [
        `:::${container}`,
        "[Aside](/p/id)",
        ":::",
      ].join("\n");
      expect(standalonePageRefOccurrences(markdown, "id")).toEqual([]);
      expect(removeStandalonePageRefs(markdown, "id")).toEqual({
        markdown,
        removed: 0,
      });
    }
  });

  it("leaves a reference in a list item or a quote alone", () => {
    for (const markdown of ["- [Item](/p/id)", "> [Quoted](/p/id)"]) {
      expect(standalonePageRefOccurrences(markdown, "id")).toEqual([]);
    }
  });
});

describe("what counts as a page row — the editor's rule", () => {
  it("matches exactly /p/<id>, so a hand-written link with a fragment, a query or a trailing slash is prose", () => {
    // `[Раздел](/p/x#h)` is an ordinary link in the editor. A prefix match
    // once called it the page's row and swept it off the disk on a move.
    const source = [
      "Intro",
      "[Раздел](/p/xid#h)",
      "[Поиск](/p/xid?q=1)",
      "[Слэш](/p/xid/)",
      "[Row](/p/xid)",
      "Tail",
    ].join("\n\n");

    expect(standalonePageRefOccurrences(source, "xid")).toEqual(["[Row](/p/xid)"]);
    expect(removeStandalonePageRefs(source, "xid")).toEqual({
      markdown: [
        "Intro",
        "[Раздел](/p/xid#h)",
        "[Поиск](/p/xid?q=1)",
        "[Слэш](/p/xid/)",
        "Tail",
      ].join("\n\n"),
      removed: 1,
    });
  });

  it("counts a same-origin absolute link as the row the editor shows, and only with that origin", () => {
    const source = [
      "[Row](http://brain.local/p/xid)",
      "[Row](/p/xid)",
      "[Elsewhere](http://other.local/p/xid)",
    ].join("\n\n");

    expect(standalonePageRefOccurrences(source, "xid", "http://brain.local")).toEqual([
      "[Row](http://brain.local/p/xid)",
      "[Row](/p/xid)",
    ]);
    expect(standalonePageRefOccurrences(source, "xid")).toEqual(["[Row](/p/xid)"]);
    expect(standalonePageRefOccurrences(source, "xid", null)).toEqual([
      "[Row](/p/xid)",
    ]);
  });

  it("numbers rows the way the editor does when a directive Brain does not own is in the way", () => {
    // `:::toggle{title="T"}` came in through MCP write_page. The editor
    // turns it into literal prose and hoists its body, so `[A](/p/a)` inside
    // it is row 0 of page `a` and the one at the tail is row 1. Parsing the
    // raw directive as one opaque block made the tail row 0 — and removing
    // "row 0" took the wrong line off the disk while the fingerprint, taken
    // from the same list, agreed.
    const source = [
      "Intro",
      ':::toggle{title="T"}\n[A](/p/a)\n:::',
      "[Moving](/p/moving)",
      "[A](/p/a)",
    ].join("\n\n");

    expect(standalonePageRefOccurrences(source, "a")).toEqual([
      "[A](/p/a)",
      "[A](/p/a)",
    ]);
    const removal = removeStandalonePageRefOccurrenceWithRestore(
      source,
      "a",
      0,
      "[A](/p/a)",
    );
    expect(removal.removed).toBe(true);
    expect(removal.markdown).toBe(
      [
        "Intro",
        ':::toggle{title="T"}\n:::',
        "[Moving](/p/moving)",
        "[A](/p/a)",
      ].join("\n\n"),
    );
  });

  it("still leaves a row inside a callout or a toggle Brain owns alone", () => {
    const source = [
      ':::callout{icon="💡"}\n[A](/p/a)\n:::',
      ":::toggle{summary=\"More\"}\n[A](/p/a)\n:::",
      "[A](/p/a)",
    ].join("\n\n");
    expect(standalonePageRefOccurrences(source, "a")).toEqual(["[A](/p/a)"]);
  });
});

describe("appendStandalonePageRef", () => {
  it("adds one row at the end of an ordinary body, and to an empty one", () => {
    expect(appendStandalonePageRef("Intro\n\n", "📄 Child", "c")).toBe(
      "Intro\n\n[📄 Child](/p/c)",
    );
    expect(appendStandalonePageRef("", "Child", "c")).toBe("[Child](/p/c)");
    expect(appendStandalonePageRef("Intro", "A [b] c", "c")).toBe(
      "Intro\n\n[A \\[b\\] c](/p/c)",
    );
  });

  it("closes a fence the body left open before the row", () => {
    expect(openContainerClosers("Intro\n\n```js\nconst x = 1;")).toEqual(["```"]);
    expect(openContainerClosers("Intro\n\n~~~~\ncode")).toEqual(["~~~~"]);
    expect(openContainerClosers("Intro\n\n```js\ncode\n```")).toEqual([]);
    expect(openContainerClosers("    indented code")).toEqual([]);

    const appended = appendStandalonePageRef(
      "Intro\n\n```js\nconst x = 1;",
      "Child",
      "c",
    );
    expect(appended).toBe("Intro\n\n```js\nconst x = 1;\n```\n\n[Child](/p/c)");
    expect(standalonePageRefOccurrences(appended, "c")).toEqual(["[Child](/p/c)"]);
  });

  it("closes an open column layout, innermost first, so the row is a row of the page", () => {
    const body = "::::cols\n:::col\n## Left\n\n[Old](/p/old)";
    expect(openContainerClosers(body)).toEqual([":::", "::::"]);

    const appended = appendStandalonePageRef(body, "Child", "c");
    expect(appended).toBe(
      "::::cols\n:::col\n## Left\n\n[Old](/p/old)\n:::\n::::\n\n[Child](/p/c)",
    );
    // and a fence open inside an open column closes in that order
    expect(
      openContainerClosers("::::cols\n:::col\n```\ncode"),
    ).toEqual(["```", ":::", "::::"]);
  });

  it("closes only what is open: a finished column layout gets the row after it", () => {
    const body = "::::cols\n:::col\n[Old](/p/old)\n:::\n::::";
    expect(openContainerClosers(body)).toEqual([]);
    expect(appendStandalonePageRef(body, "Child", "c")).toBe(
      `${body}\n\n[Child](/p/c)`,
    );
  });

  it("refuses a body it cannot put a top-level row in", () => {
    // An unclosed fence inside a blockquote needs a `> ` closer this does not
    // write; the appended row would become a second fence. Refusing is the
    // honest answer — the move fails instead of the document.
    expect(() =>
      appendStandalonePageRef("> ```js\n> code", "Child", "c"),
    ).toThrow("cannot be appended as a top-level row");
    expect(() =>
      appendStandalonePageRef("<!-- unclosed", "Child", "c"),
    ).toThrow("cannot be appended as a top-level row");
  });
});
