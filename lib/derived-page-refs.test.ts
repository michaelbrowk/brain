import { describe, expect, it } from "vitest";
import { referencedPageIds, unreferencedDirectChildren } from "./derived-page-refs";

const CHILDREN = [
  { id: "linked", title: "Linked" },
  { id: "derived", title: "Derived" },
];

describe("classifying a page link with no configured origin", () => {
  it("reads the relative form, which means the same thing on every host", () => {
    expect([...referencedPageIds("[a](/p/linked)", null)]).toEqual(["linked"]);
  });

  it("reads no absolute URL, because there is no origin to compare it to", () => {
    // The default this replaced was a hard-coded https://brain.example.com,
    // which classified links to an origin nobody had configured.
    expect(
      [...referencedPageIds("[a](https://brain.example.com/p/linked)", null)],
    ).toEqual([]);
  });
});

describe("unreferencedDirectChildren has three states, not two", () => {
  it("lists the unlinked children when no origin is configured", () => {
    // A shared page on an install with no BRAIN_PUBLIC_ORIGIN lost its whole
    // subpage list, read-only shares included.
    expect(
      unreferencedDirectChildren(CHILDREN, "[a](/p/linked)", null),
    ).toEqual([{ id: "derived", title: "Derived" }]);
  });

  it("lists nothing when the origin is not known yet", () => {
    // The client component's server snapshot. Painting every child and
    // collapsing the list once the browser origin arrives shows anchors that
    // never belonged on the page.
    expect(
      unreferencedDirectChildren(CHILDREN, "[a](/p/linked)", undefined),
    ).toEqual([]);
  });

  it("classifies against a real origin when there is one", () => {
    expect(
      unreferencedDirectChildren(
        CHILDREN,
        "[a](https://brain.test/p/linked)",
        "https://brain.test",
      ),
    ).toEqual([{ id: "derived", title: "Derived" }]);
  });
});
