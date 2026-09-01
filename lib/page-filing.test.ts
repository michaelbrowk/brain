import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asFilePageRefDetail,
  decodeUnfiledPage,
  draggingUnfiledPage,
  encodeUnfiledPage,
  getDocumentHeadings,
  getServerDocumentHeadings,
  setDocumentHeadings,
  setDraggingUnfiledPage,
  subscribeDocumentHeadings,
  unfiledPageDropHtml,
  unfiledPageDropText,
} from "./page-filing";

describe("unfiled page drag payload", () => {
  it("hands ProseMirror one exact, fully closed block", () => {
    // openStart/openEnd of 0 is what makes the stock drop insert a whole
    // block instead of unwrapping the paragraph into the drop target.
    expect(unfiledPageDropHtml({ id: "abc", label: "📄 Notes" })).toBe(
      '<p data-pm-slice="0 0 []"><a data-page-ref="abc">📄 Notes</a></p>',
    );
  });

  it("omits href so the page-ref atom wins over the link mark", () => {
    expect(unfiledPageDropHtml({ id: "abc", label: "x" })).not.toContain(
      "href",
    );
  });

  it("escapes a label that would otherwise close the anchor", () => {
    expect(
      unfiledPageDropHtml({ id: "abc", label: '</a><script>"&' }),
    ).toBe(
      '<p data-pm-slice="0 0 []"><a data-page-ref="abc">&lt;/a&gt;&lt;script&gt;&quot;&amp;</a></p>',
    );
  });

  it("falls back to the Markdown the serializer would have written", () => {
    expect(unfiledPageDropText({ id: "abc", label: "📄 Notes" })).toBe(
      "[📄 Notes](/p/abc)",
    );
    expect(unfiledPageDropText({ id: "abc", label: "a [b] c" })).toBe(
      "[a \\[b\\] c](/p/abc)",
    );
  });

  it("round-trips only bounded payloads", () => {
    expect(
      decodeUnfiledPage(encodeUnfiledPage({ id: "page_1", label: "📄 One" })),
    ).toEqual({ id: "page_1", label: "📄 One" });
    expect(decodeUnfiledPage("")).toBeNull();
    expect(decodeUnfiledPage("not json")).toBeNull();
    expect(decodeUnfiledPage(JSON.stringify({ id: "bad.id" }))).toBeNull();
    expect(
      decodeUnfiledPage(
        JSON.stringify({ id: "ok", label: "x".repeat(1_025) }),
      ),
    ).toBeNull();
  });

  it("accepts a filing intent only with a real id and a real placement", () => {
    expect(
      asFilePageRefDetail({ id: "ok", label: "📄 One", headingIndex: null }),
    ).toEqual({ id: "ok", label: "📄 One", headingIndex: null });
    expect(
      asFilePageRefDetail({ id: "ok", label: "", headingIndex: 2 }),
    ).toEqual({ id: "ok", label: "", headingIndex: 2 });
    expect(asFilePageRefDetail(null)).toBeNull();
    expect(asFilePageRefDetail("ok")).toBeNull();
    expect(
      asFilePageRefDetail({ id: "../etc", label: "", headingIndex: null }),
    ).toBeNull();
    expect(
      asFilePageRefDetail({ id: "ok", label: "", headingIndex: -1 }),
    ).toBeNull();
    expect(
      asFilePageRefDetail({ id: "ok", label: "", headingIndex: 1.5 }),
    ).toBeNull();
  });
});

describe("the live heading list", () => {
  afterEach(() => {
    setDocumentHeadings([]);
    setDraggingUnfiledPage(null);
  });

  it("is empty until an editor fills it, and empty again on the server", () => {
    expect(getDocumentHeadings()).toEqual([]);
    expect(getServerDocumentHeadings()).toEqual([]);
  });

  it("keeps its identity for an equal snapshot, so a keystroke costs nothing", () => {
    const listener = vi.fn();
    const stop = subscribeDocumentHeadings(listener);
    try {
      const reading = [{ index: 0, depth: 1, text: "Reading" }];
      setDocumentHeadings(reading);
      const first = getDocumentHeadings();
      expect(listener).toHaveBeenCalledTimes(1);

      setDocumentHeadings([{ index: 0, depth: 1, text: "Reading" }]);
      expect(getDocumentHeadings()).toBe(first);
      expect(listener).toHaveBeenCalledTimes(1);

      setDocumentHeadings([{ index: 0, depth: 2, text: "Reading" }]);
      expect(listener).toHaveBeenCalledTimes(2);
      setDocumentHeadings([{ index: 0, depth: 2, text: "Reading it" }]);
      expect(listener).toHaveBeenCalledTimes(3);
      setDocumentHeadings([]);
      expect(listener).toHaveBeenCalledTimes(4);
    } finally {
      stop();
    }
  });

  it("stops telling a subscriber that has gone", () => {
    const listener = vi.fn();
    subscribeDocumentHeadings(listener)();
    setDocumentHeadings([{ index: 0, depth: 1, text: "Reading" }]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the drag in flight", () => {
  afterEach(() => setDraggingUnfiledPage(null));

  it("carries the id `dragover` cannot read off the transfer", () => {
    expect(draggingUnfiledPage()).toBeNull();
    setDraggingUnfiledPage({ id: "verbs", label: "📗 Verbs" });
    expect(draggingUnfiledPage()).toEqual({ id: "verbs", label: "📗 Verbs" });
    setDraggingUnfiledPage(null);
    expect(draggingUnfiledPage()).toBeNull();
  });
});
