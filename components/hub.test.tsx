// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { Hub } from "./hub";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Hub", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query === "(hover: hover)" })),
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("explains the two sidebar items a new notebook shows", async () => {
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={async () => null} />,
      ),
    );
    await settle();

    expect(host.textContent).toContain("Your notebook is empty");
    expect(host.textContent).toContain("Today thoughts opens a page for today");
    expect(host.textContent).toContain("Mail is for a Gmail or IMAP account");
  });

  /** A page the feed will show: written at this moment, so the week filter
   *  keeps it. */
  function recent(values: Partial<TreeNode> & { id: string; title: string }): TreeNode {
    const updated = new Date().toISOString();
    return {
      parentId: null,
      order: values.id,
      created: updated,
      updated,
      hasChildren: false,
      children: [],
      ...values,
    };
  }

  it("names the visitor who wrote a page last, and keeps Brain AI as it is", async () => {
    await act(async () =>
      root.render(
        <Hub
          tree={[
            recent({ id: "p1", title: "Edited page", updatedBy: "visitor", updatedByName: "Ada" }),
            recent({ id: "p2", title: "Claude page", updatedBy: "claude" }),
            recent({ id: "p3", title: "My page", updatedBy: "me" }),
          ]}
          onSelect={() => {}}
          onCreate={async () => null}
        />,
      ),
    );
    await settle();

    expect(host.textContent).toContain("edited by Ada");
    expect(host.textContent).toContain("Brain AI");
    // the owner's own writes stay unlabelled
    expect(host.textContent).not.toContain("edited by a visitor");
  });

  it("holds a hostile name inside the row without taking the title's room", async () => {
    // 40 is the cap normalizeVisitorName applies, and the name is the
    // visitor's own text. jsdom lays nothing out, so what is pinned here is
    // the flex contract that decides the row at 320px: the title grows and
    // shrinks, and the badge is capped so it can never take the whole line.
    // Without the cap the title's flex basis of 0 gives it a shrink weight of
    // 0, the badge absorbs every pixel of overflow, and the title renders at
    // zero width.
    await act(async () =>
      root.render(
        <Hub
          tree={[
            recent({
              id: "p1",
              title: "A page with a long title of its own",
              updatedBy: "visitor",
              updatedByName: "A".repeat(40),
            }),
          ]}
          onSelect={() => {}}
          onCreate={async () => null}
        />,
      ),
    );
    await settle();

    const badge = [...host.querySelectorAll("span")].find((candidate) =>
      candidate.textContent?.startsWith("edited by A"),
    );
    expect(badge).toBeDefined();
    expect(badge!.className).toContain("truncate");
    expect(badge!.className).toContain("min-w-0");
    expect(badge!.className).not.toContain("shrink-0");
    // The cap. Half the row at most, so the title always has the larger half.
    expect(badge!.className).toContain("max-w-[45%]");
    // Truncation hides characters, so the whole name stays readable on hover
    // and to a pointer that rests on it.
    expect(badge!.getAttribute("title")).toBe(`edited by ${"A".repeat(40)}`);

    const title = [...host.querySelectorAll("span")].find(
      (candidate) => candidate.textContent === "A page with a long title of its own",
    );
    expect(title).toBeDefined();
    expect(title!.className).toContain("flex-1");
    expect(title!.className).toContain("min-w-0");
    expect(title!.className).toContain("truncate");
  });

  it("says a visitor without falling back on a name the mint cannot omit", async () => {
    await act(async () =>
      root.render(
        <Hub
          tree={[recent({ id: "p1", title: "Hand edited", updatedBy: "visitor" })]}
          onSelect={() => {}}
          onCreate={async () => null}
        />,
      ),
    );
    await settle();

    expect(host.textContent).toContain("edited by a visitor");
  });
});
