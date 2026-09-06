// The wrapper exists for one line, and that line is load-bearing: the island
// decides about a local draft in its first render, so a server render would
// hydrate against a different body than the one the visitor left behind. The
// test reads what `next/dynamic` was asked for, what the loader loads, and
// what the wrapper hands on.

import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

type DynamicOptions = { ssr?: boolean; loading?: unknown };

// Hoisted with the mock factories that read it: `vi.mock` runs before the
// module body.
const stand = vi.hoisted(() => ({
  asked: [] as Array<{
    loader: () => Promise<unknown>;
    options: DynamicOptions | undefined;
  }>,
  island: function ShareEditorStub() {
    return null;
  },
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>, options?: DynamicOptions) => {
    stand.asked.push({ loader, options });
    return function Island() {
      return null;
    };
  },
}));

vi.mock("./share-editor", () => ({ default: stand.island }));

import { ShareEditorMount } from "./share-editor-mount";

const props = {
  rootId: "root-1",
  pageId: "page-3",
  shareVersion: 7,
  vid: "vid123456789",
  initialMarkdown: "# Hello",
  initialRev: "abcdefabcdef",
  linkablePageIds: ["page-3"],
};

describe("the visitor editor mount", () => {
  it("asks for the island client-only", () => {
    expect(stand.asked).toHaveLength(1);
    expect(stand.asked[0]!.options?.ssr).toBe(false);
  });

  it("loads the visitor editor and nothing else", async () => {
    const loaded = (await stand.asked[0]!.loader()) as { default: unknown };
    expect(loaded.default).toBe(stand.island);
  });

  it("hands the island every prop unchanged, and no key of its own", () => {
    const element = ShareEditorMount(props) as ReactElement<typeof props>;
    expect(isValidElement(element)).toBe(true);
    expect(element.props).toEqual(props);
    // The island keys itself on the draft it opened; an outer key would
    // remount it and throw that away.
    expect(element.key).toBeNull();
  });
});
