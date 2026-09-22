// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { BreadcrumbPill } from "./ui/breadcrumb-pill";
import { CommandPalette } from "./command-palette";
import { Hub } from "./hub";
import { MobilePagesView } from "./mobile-pages-view";
import { Subpages } from "./subpages";
import { resetTasksStore } from "./tasks-client";
import { TreeRow } from "./ui/tree-row";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

let host: HTMLDivElement | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  host?.remove();
  host = null;
  document.body
    .querySelectorAll("[data-radix-portal], [role=dialog]")
    .forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

/** A tree node the surfaces below will draw. `kind` is the only thing that
 *  ever varies between the two halves of each case: every assertion here is
 *  that the chip is read off `kind` and off nothing else. */
function node(values: Partial<TreeNode> & { id: string; title: string }): TreeNode {
  const timestamp = new Date().toISOString();
  return {
    parentId: null,
    order: values.id,
    created: timestamp,
    updated: timestamp,
    hasChildren: false,
    children: [],
    ...values,
  };
}

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host as HTMLDivElement).render(node);
  });
  return host;
}

describe("the chip on a tree row", () => {
  it("draws after the title when the page is an app", () => {
    const row = mount(<TreeRow title="Trainer" ai />);
    const chip = row.querySelector(".ai-chip");
    expect(chip?.textContent).toBe("AI");
    const title = row.querySelector(".tree-row-title") as HTMLElement;
    expect(
      title.compareDocumentPosition(chip as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws nothing on an ordinary page", () => {
    const row = mount(<TreeRow title="Spanish" />);
    expect(row.querySelector(".ai-chip")).toBeNull();
  });

  it("is not read off the title", () => {
    const row = mount(<TreeRow title="AI notes" />);
    expect(row.querySelector(".ai-chip")).toBeNull();
  });
});

describe("the chip on the breadcrumb", () => {
  it("draws on the crumb of an app page and on no other", () => {
    const crumb = mount(
      <BreadcrumbPill
        items={[
          { label: "Spanish", emoji: "📗" },
          { label: "Trainer", emoji: "🃏", ai: true },
        ]}
      />,
    );
    const chips = crumb.querySelectorAll(".ai-chip");
    expect(chips).toHaveLength(1);
    const segments = crumb.querySelectorAll(".crumb-seg");
    expect(segments[1].querySelector(".ai-chip")?.textContent).toBe("AI");
    expect(segments[0].querySelector(".ai-chip")).toBeNull();
  });

  it("never grows one on the folded grandparent segment", () => {
    const crumb = mount(
      <BreadcrumbPill items={[{ label: "…", title: "Spanish" }, { label: "Trainer" }]} />,
    );
    expect(crumb.querySelector(".ai-chip")).toBeNull();
  });
});

describe("the chip in the page's own subpage list", () => {
  const pages = [
    node({ id: "app1", title: "Trainer", icon: "🃏", kind: "app" }),
    node({ id: "page1", title: "Words", icon: "📄" }),
  ];

  it("names an app child with the chip and an ordinary one without", () => {
    const list = mount(<Subpages pages={pages} markdown="" onNavigate={() => {}} />);
    const app = list.querySelector('[data-page-ref="app1"]') as HTMLElement;
    const plain = list.querySelector('[data-page-ref="page1"]') as HTMLElement;
    expect(app.querySelector(".ai-chip")?.textContent).toBe("AI");
    expect(plain.querySelector(".ai-chip")).toBeNull();
  });
});

describe("the chip in the command palette", () => {
  it("names an app page in the page list and no ordinary one", async () => {
    await act(async () => {
      host = document.createElement("div");
      document.body.append(host);
      createRoot(host).render(
        <CommandPalette
          open
          onOpenChange={() => {}}
          tree={[
            node({ id: "app1", title: "Trainer", kind: "app" }),
            node({ id: "page1", title: "Spanish" }),
          ]}
          onSelect={() => {}}
          hasCurrent={false}
        />,
      );
    });
    const items = [
      ...document.body.querySelectorAll<HTMLElement>("[cmdk-item]"),
    ];
    const app = items.find((item) => item.textContent?.includes("Trainer"));
    const plain = items.find((item) => item.textContent?.includes("Spanish"));
    expect(app?.querySelector(".ai-chip")?.textContent).toBe("AI");
    expect(plain).toBeDefined();
    expect(plain?.querySelector(".ai-chip")).toBeNull();
  });
});

describe("the chip on Home", () => {
  it("names an app page in the feed and no ordinary one", async () => {
    // Home mounts the tasks and mail blocks too. Neither is what this case is
    // about, so both are answered empty.
    resetTasksStore();
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const body = String(input).includes("/api/mail/")
          ? { accounts: [] }
          : { tasks: [] };
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    await act(async () => {
      host = document.createElement("div");
      document.body.append(host);
      createRoot(host).render(
        <Hub
          tree={[
            node({ id: "app1", title: "Trainer", kind: "app", updatedBy: "claude" }),
            node({ id: "page1", title: "Spanish", updatedBy: "me" }),
          ]}
          onSelect={() => {}}
          onCreate={async () => null}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const rows = [...(host?.querySelectorAll<HTMLElement>("button") ?? [])];
    const app = rows.find((row) => row.textContent?.includes("Trainer"));
    const plain = rows.find((row) => row.textContent?.includes("Spanish"));
    expect(app?.querySelector(".ai-chip")?.textContent).toBe("AI");
    expect(plain).toBeDefined();
    expect(plain?.querySelector(".ai-chip")).toBeNull();
  });
});

describe("the chip in the mobile pages view", () => {
  function renderMobile(tree: TreeNode[]) {
    const ref = { current: null };
    return mount(
      <MobilePagesView
        open
        tree={tree}
        selectedId={null}
        footer={null}
        returnFocusRef={ref}
        fallbackFocusRef={ref}
        nestedModalOpen={false}
        onClose={() => {}}
        onOpenSettings={() => {}}
        onSelect={() => {}}
      />,
    );
  }

  it("draws on an app row and not on an ordinary one", () => {
    renderMobile([
      node({ id: "app1", title: "Trainer", kind: "app" }),
      node({ id: "page1", title: "Spanish" }),
    ]);
    const rows = [
      ...document.body.querySelectorAll<HTMLElement>('[aria-label^="Open "]'),
    ];
    const app = rows.find((row) => row.textContent?.includes("Trainer"));
    const plain = rows.find((row) => row.textContent?.includes("Spanish"));
    expect(app?.querySelector(".ai-chip")?.textContent).toBe("AI");
    expect(plain?.querySelector(".ai-chip")).toBeNull();
  });
});
