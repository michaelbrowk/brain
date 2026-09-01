// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_FILE_PAGE_EVENT,
  BRAIN_FILE_PAGE_RESULT_EVENT,
  BRAIN_UNFILED_PAGE_MIME,
  setDocumentHeadings,
  type FilePageRefDetail,
  type FilePageRefResult,
} from "@/lib/page-filing";
import type { TreeNode } from "@/lib/store/types";
import { referencedPageIds, Subpages } from "./subpages";

const ORIGIN = "https://brain.example";

function node(
  id: string,
  title: string,
  icon?: string,
  collectionRow?: TreeNode["collectionRow"],
): TreeNode {
  const timestamp = "2026-08-12T08:00:00.000Z";
  return {
    id,
    parentId: "parent",
    title,
    icon,
    order: id,
    created: timestamp,
    updated: timestamp,
    hasChildren: false,
    children: [],
    collectionRow,
  };
}

describe("Subpages", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("PointerEvent", MouseEvent);
    for (const method of [
      "hasPointerCapture",
      "setPointerCapture",
      "releasePointerCapture",
      "scrollIntoView",
    ]) {
      Object.defineProperty(HTMLElement.prototype, method, {
        configurable: true,
        value: () => (method === "hasPointerCapture" ? false : undefined),
      });
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    setDocumentHeadings([]);
    await act(async () => root.unmount());
    host.remove();
    document
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((element) => element.remove());
    vi.unstubAllGlobals();
  });

  it("renders nothing on the server, where the origin is unknown", () => {
    // An SSR-seeded page must not paint every child as a derived ref and
    // drop them once the browser origin arrives: the anchors the body already
    // links would flash twice, and hover-driven UI would bind to the ghosts.
    expect(
      renderToString(
        <Subpages
          pages={[node("a", "Alpha"), node("b", "Beta")]}
          markdown="[Alpha](/p/a)"
          onNavigate={vi.fn()}
        />,
      ),
    ).toBe("");
  });

  it("dedupes children explicitly linked anywhere in parsed Markdown", () => {
    const markdown = [
      "Inline [One](/p/one) mention.",
      "",
      "- Nested [Two](https://brain.example/p/two)",
      "",
      "[Three by reference][three]",
      "",
      "[three]: /p/three",
      "",
      "```md",
      "[Code is not a reference](/p/code)",
      "```",
      "",
      "[Query stays ordinary](/p/query?view=full)",
    ].join("\n");

    expect([...referencedPageIds(markdown, ORIGIN)]).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("keeps tree order and reflects live title, icon, and structural updates", async () => {
    const navigate = vi.fn();
    const render = async (children: TreeNode[]) => {
      await act(async () =>
        root.render(
          <Subpages
            pages={children}
            markdown=""
            currentOrigin={ORIGIN}
            onNavigate={navigate}
          />,
        ),
      );
    };

    await render([node("b", "Beta"), node("a", "Alpha", "🌱")]);
    let links = [...host.querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).toEqual([
      "📄 Beta",
      "🌱 Alpha",
    ]);
    expect(host.querySelector("[data-derived-page-refs]")).not.toBeNull();
    expect(links.map((link) => link.getAttribute("data-page-ref"))).toEqual([
      "b",
      "a",
    ]);
    expect(links.every((link) => link.className === "brain-page-ref")).toBe(
      true,
    );
    // icon span + one text node, nothing else — textContent stays "<icon> <title>"
    expect(links.every((link) => link.childNodes.length === 2)).toBe(true);
    expect(
      links.map((link) => (link.firstChild as HTMLElement).className),
    ).toEqual(["brain-page-ref-icon", "brain-page-ref-icon"]);
    expect(links.map((link) => link.firstChild?.textContent)).toEqual([
      "📄",
      "🌱",
    ]);
    expect(
      links.every((link) => link.lastChild?.nodeType === Node.TEXT_NODE),
    ).toBe(true);
    expect(host.querySelector("section")).toBeNull();
    expect(host.querySelector("header")).toBeNull();
    expect(host.querySelector("h2")).toBeNull();
    expect(host.querySelector("ul, ol, li")).toBeNull();
    expect(host.querySelector("[data-subpages-count]")).toBeNull();
    expect(host.textContent).not.toContain("Subpages");

    expect((links[0] as HTMLAnchorElement).tabIndex).toBe(0);
    (links[0] as HTMLAnchorElement).focus();
    await act(async () =>
      links[0].dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 0,
        }),
      ),
    );
    expect(navigate).toHaveBeenCalledWith("b");

    links[0].addEventListener("click", (event) => event.preventDefault());
    for (const modifiers of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      await act(async () =>
        links[0].dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            ...modifiers,
          }),
        ),
      );
    }
    expect(navigate).toHaveBeenCalledTimes(1);

    await render([node("a", "Alpha renamed", "🪄"), node("c", "Gamma")]);
    links = [...host.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/p/a",
      "/p/c",
    ]);
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "🪄 Alpha renamed",
      "📄 Gamma",
    ]);
  });

  it("hides referenced children and collection rows without changing Markdown", async () => {
    const markdown = "Before [Beta](/p/b) after";
    await act(async () =>
      root.render(
        <Subpages
          pages={[
            node("a", "Alpha"),
            node("b", "Beta"),
            node("row", "Imported row", undefined, {
              source: "notion",
              version: 1,
              databaseId: "database",
              values: {},
            }),
          ]}
          markdown={markdown}
          currentOrigin={ORIGIN}
          onNavigate={vi.fn()}
        />,
      ),
    );

    expect(
      [...host.querySelectorAll("a")].map((link) => link.textContent),
    ).toEqual(["📄 Alpha"]);
    expect(markdown).toBe("Before [Beta](/p/b) after");

    await act(async () =>
      root.render(
        <Subpages
          pages={[node("a", "Alpha"), node("b", "Beta")]}
          markdown=""
          currentOrigin={ORIGIN}
          onNavigate={vi.fn()}
        />,
      ),
    );
    expect(
      [...host.querySelectorAll("a")].map((link) => link.textContent),
    ).toEqual(["📄 Alpha", "📄 Beta"]);
  });

  it("hands the editor an exact slice and drops the browser's link payload", async () => {
    await act(async () =>
      root.render(
        <Subpages
          pages={[node("verbs", "Verbs", "📗")]}
          markdown="# Reading"
          currentOrigin={ORIGIN}
          onNavigate={vi.fn()}
        />,
      ),
    );

    const anchor = host.querySelector("a") as HTMLAnchorElement;
    const carried = new Map<string, string>();
    const transfer = {
      effectAllowed: "",
      clearData: vi.fn(() => carried.clear()),
      setData: (type: string, value: string) => carried.set(type, value),
      getData: (type: string) => carried.get(type) ?? "",
    };
    // Chrome pre-fills a link drag with the resolved absolute URL. Left in
    // place it becomes the Markdown destination, so the row must clear it.
    carried.set("text/uri-list", `${ORIGIN}/p/verbs`);
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    await act(async () => {
      anchor.dispatchEvent(event);
    });

    expect(transfer.clearData).toHaveBeenCalled();
    expect(carried.get("text/uri-list")).toBeUndefined();
    expect(carried.get("text/html")).toBe(
      '<p data-pm-slice="0 0 []"><a data-page-ref="verbs">📗 Verbs</a></p>',
    );
    expect(carried.get("text/plain")).toBe("[📗 Verbs](/p/verbs)");
    expect(carried.get(BRAIN_UNFILED_PAGE_MIME)).toBe(
      JSON.stringify({ id: "verbs", label: "📗 Verbs" }),
    );
    expect(anchor.dataset.dragging).toBe("true");

    await act(async () => {
      anchor.dispatchEvent(new Event("dragend", { bubbles: true }));
    });
    expect(anchor.dataset.dragging).toBeUndefined();
  });

  async function openRowMenu(host: HTMLElement) {
    const trigger = host.querySelector(
      "[data-file-page-trigger]",
    ) as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    return {
      trigger,
      items: [
        ...document.body.querySelectorAll('[role^="menuitem"]'),
      ] as HTMLElement[],
    };
  }

  it("offers the sections the mounted editor counts, not the ones Markdown implies", async () => {
    const filed: FilePageRefDetail[] = [];
    const listener = (event: Event) => {
      filed.push((event as CustomEvent<FilePageRefDetail>).detail);
    };
    window.addEventListener(BRAIN_FILE_PAGE_EVENT, listener);
    try {
      // The body's `## Later` sits inside a column, so the document has two
      // sections while the Markdown reads as three. The menu shows the two
      // the insert can resolve.
      setDocumentHeadings([
        { index: 0, depth: 1, text: "Reading" },
        { index: 1, depth: 2, text: "Later" },
      ]);
      await act(async () =>
        root.render(
          <Subpages
            pages={[node("verbs", "Verbs", "📗")]}
            markdown={":::cols\n:::col\n# Buried\n:::\n:::"}
            currentOrigin={ORIGIN}
            onNavigate={vi.fn()}
          />,
        ),
      );

      const { trigger, items } = await openRowMenu(host);
      expect(trigger.getAttribute("aria-label")).toBe(
        "File Verbs into this page",
      );
      expect(trigger.tabIndex).toBe(0);
      // The trigger is a sibling of the link, never inside it: the anchor's
      // textContent is what parseDOM and search read.
      expect(trigger.closest("a")).toBeNull();

      // Sections first — "End of page" moves nothing for a page whose
      // sections are all above it, so it is never the default.
      expect(items.map((item) => item.textContent?.trim())).toEqual([
        "Reading",
        "Later",
        "End of page",
      ]);
      // The outline the reader already sees in the document.
      expect(items[0].style.paddingInlineStart).toBe("8px");
      expect(items[1].style.paddingInlineStart).toBe("20px");
      // A page with many sections has somewhere to scroll, and the menu
      // material keeps its own edge because the scroll is inside it.
      const scroller = items[0].parentElement as HTMLElement;
      expect(scroller.className).toContain("overflow-y-auto");
      expect(scroller.style.maxHeight).toContain(
        "--radix-dropdown-menu-content-available-height",
      );

      await act(async () => {
        items[1].dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(filed).toEqual([
        { id: "verbs", label: "📗 Verbs", headingIndex: 1 },
      ]);
    } finally {
      window.removeEventListener(BRAIN_FILE_PAGE_EVENT, listener);
    }
  });

  it("offers only the end of the page when the document has no sections", async () => {
    await act(async () =>
      root.render(
        <Subpages
          pages={[node("verbs", "Verbs", "📗")]}
          markdown="Just prose."
          currentOrigin={ORIGIN}
          onNavigate={vi.fn()}
        />,
      ),
    );

    const { items } = await openRowMenu(host);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "End of page",
    ]);
  });

  it("names the tail so a row is not read as part of the section above it", async () => {
    await act(async () =>
      root.render(
        <Subpages
          pages={[node("verbs", "Verbs", "📗")]}
          markdown="# Writing"
          currentOrigin={ORIGIN}
          onNavigate={vi.fn()}
        />,
      ),
    );

    const block = host.querySelector(
      "[data-derived-page-refs]",
    ) as HTMLElement;
    const name = block.querySelector("p") as HTMLElement;
    expect(name.textContent).toBe("Not in this page");
    expect(block.className).toContain("border-t");
    // A section label, on the register every other section label takes —
    // `text-label` (11/600/18/+0.06px, sentence case), not a one-off. The
    // menu's "File under" and the sidebar's "Pages" are in the same frame.
    expect(name.className).toContain("text-label");
    expect(name.className).not.toMatch(/uppercase|text-\[|tracking-/);
  });

  it("says what the editor did, for a reader who cannot see the row leave", async () => {
    // Stand in for the mounted plugin: it answers on the same turn, which is
    // what lets the row menu know whether to give focus back to its trigger.
    const reply = (result: Omit<FilePageRefResult, "id">) => (event: Event) => {
      const { id } = (event as CustomEvent<FilePageRefDetail>).detail;
      window.dispatchEvent(
        new CustomEvent<FilePageRefResult>(BRAIN_FILE_PAGE_RESULT_EVENT, {
          detail: { id, ...result },
        }),
      );
    };
    const render = async () =>
      act(async () =>
        root.render(
          <Subpages
            pages={[node("verbs", "Verbs", "📗")]}
            markdown="# Writing"
            currentOrigin={ORIGIN}
            onNavigate={vi.fn()}
          />,
        ),
      );
    const live = () => host.querySelector('[role="status"]')?.textContent;

    setDocumentHeadings([{ index: 0, depth: 1, text: "Writing" }]);
    let listener = reply({ section: "Writing", refused: null });
    window.addEventListener(BRAIN_FILE_PAGE_EVENT, listener);
    try {
      await render();
      const { items } = await openRowMenu(host);
      expect(live()).toBe("");
      await act(async () => {
        items[0].dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      expect(live()).toBe("Verbs filed under Writing");
    } finally {
      window.removeEventListener(BRAIN_FILE_PAGE_EVENT, listener);
    }

    listener = reply({ section: null, refused: "duplicate" });
    window.addEventListener(BRAIN_FILE_PAGE_EVENT, listener);
    try {
      const { items } = await openRowMenu(host);
      await act(async () => {
        items[1].dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      expect(live()).toBe("Verbs is already in this page");
    } finally {
      window.removeEventListener(BRAIN_FILE_PAGE_EVENT, listener);
    }
  });

  it("does not swallow a request no editor answered", async () => {
    await act(async () =>
      root.render(
        <Subpages
          pages={[node("verbs", "Verbs", "📗")]}
          markdown="Just prose."
          currentOrigin={ORIGIN}
          onNavigate={vi.fn()}
        />,
      ),
    );
    const { items } = await openRowMenu(host);
    await act(async () => {
      items[0].dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "The page is busy, Verbs was not filed",
    );
  });

  it("renders nothing when every structural child already has a Markdown link", () => {
    expect(
      renderToString(
        <Subpages
          pages={[node("a", "Alpha"), node("b", "Beta")]}
          markdown="[Alpha](/p/a) and [Beta](/p/b)"
          currentOrigin={ORIGIN}
          onNavigate={vi.fn()}
        />,
      ),
    ).toBe("");
  });
});
