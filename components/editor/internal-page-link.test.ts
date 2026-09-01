// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  classifyEditorLinkNavigation,
  classifyInternalPageLink,
  followEditorLink,
  INTERNAL_PAGE_LINK_CLASS,
  observeInternalPageLinks,
} from "./internal-page-link";

const ORIGIN = "https://brain.example";

async function mutationsDelivered() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("classifyInternalPageLink", () => {
  it.each([
    ["/p/abc_123-Z", { id: "abc_123-Z", href: "/p/abc_123-Z" }],
    [
      "https://brain.example/p/abc_123-Z",
      { id: "abc_123-Z", href: "/p/abc_123-Z" },
    ],
  ])("classifies %s and returns a canonical relative href", (href, expected) => {
    expect(classifyInternalPageLink(href, ORIGIN)).toEqual(expected);
  });

  it.each([
    "https://foreign.example/p/abc123",
    "https://brain.example.evil/p/abc123",
    "http://brain.example/p/abc123",
    "https://brain.example:444/p/abc123",
    "https://user@brain.example/p/abc123",
    "//brain.example/p/abc123",
    "/share/abc123",
    "/p/abc123/more",
    "/p/abc123/",
    "/p/",
    "/p/abc%2F123",
    "/p/abc%5F123",
    "/p/abc.123",
    "/p/abc123?view=full",
    "/p/abc123#section",
    "https://brain.example/p/abc123?view=full",
    "https://brain.example/p/abc123#section",
    " https://brain.example/p/abc123",
    "https://brain.example/p/abc123 ",
  ])("rejects non-exact or deceptive href %s", (href) => {
    expect(classifyInternalPageLink(href, ORIGIN)).toBeNull();
  });

  it("rejects a malformed current origin", () => {
    expect(classifyInternalPageLink("/p/abc123", "not an origin")).toBeNull();
    expect(
      classifyInternalPageLink("/p/abc123", "https://brain.example/path"),
    ).toBeNull();
  });
});

describe("editor link navigation", () => {
  it("keeps Brain pages inside the app and opens regular links externally", () => {
    expect(classifyEditorLinkNavigation("/p/abc123", ORIGIN)).toEqual({
      kind: "internal",
      id: "abc123",
    });
    expect(
      classifyEditorLinkNavigation(
        "https://docs.google.com/document/d/example?tab=t.0",
        ORIGIN,
      ),
    ).toEqual({
      kind: "external",
      href: "https://docs.google.com/document/d/example?tab=t.0",
    });
  });

  it("follows external links from the editor without changing Brain navigation", () => {
    const navigateInternal = vi.fn();
    const openExternal = vi.fn();

    expect(
      followEditorLink(
        "https://datalens.example/dashboard?tab=content",
        ORIGIN,
        navigateInternal,
        openExternal,
      ),
    ).toBe(true);
    expect(navigateInternal).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(
      "https://datalens.example/dashboard?tab=content",
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "https://user:password@example.com/private",
    "//foreign.example/path",
  ])("does not follow unsafe or ambiguous href %s", (href) => {
    expect(followEditorLink(href, ORIGIN, vi.fn(), vi.fn())).toBe(false);
  });
});

describe("observeInternalPageLinks", () => {
  it("adds and removes markers as hrefs change while ignoring page refs", async () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <a id="relative" href="/p/abc123">Relative</a>
      <a id="absolute" href="${ORIGIN}/p/def456">Absolute</a>
      <a id="foreign" href="https://foreign.example/p/ghi789">Foreign</a>
      <a id="page-ref" class="brain-page-ref" href="/p/ref123">Page ref</a>
    `;
    const stop = observeInternalPageLinks(root, ORIGIN);
    const relative = root.querySelector<HTMLAnchorElement>("#relative")!;
    const absolute = root.querySelector<HTMLAnchorElement>("#absolute")!;
    const foreign = root.querySelector<HTMLAnchorElement>("#foreign")!;
    const pageRef = root.querySelector<HTMLAnchorElement>("#page-ref")!;

    expect(relative.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(true);
    expect(absolute.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(true);
    expect(foreign.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(false);
    expect(pageRef.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(false);

    relative.setAttribute("href", "https://foreign.example/p/abc123");
    foreign.setAttribute("href", `${ORIGIN}/p/ghi789`);
    absolute.classList.add("brain-page-ref");
    await mutationsDelivered();

    expect(relative.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(false);
    expect(foreign.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(true);
    expect(absolute.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(false);

    const added = document.createElement("a");
    added.href = "/p/new_page";
    root.append(added);
    await mutationsDelivered();
    expect(added.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(true);

    stop();
    const afterStop = document.createElement("a");
    afterStop.href = "/p/after_stop";
    root.append(afterStop);
    await mutationsDelivered();
    expect(afterStop.classList.contains(INTERNAL_PAGE_LINK_CLASS)).toBe(false);
  });
});
