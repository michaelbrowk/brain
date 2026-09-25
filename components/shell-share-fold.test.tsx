// @vitest-environment jsdom

// THE FOLD'S READ-BACK, DRIVEN FROM THE CARD THAT PRESSES IT.
//
// `share-popover.test.tsx` proves what the card sends and what it draws when
// the callback answers; it cannot prove what the shell does between those two
// moments, because there `onAbsorbNestedShares` is a stub. The shell's own
// callback writes the fold, reads the durable scope back a second time, and
// speaks only if that read says the link works: public, nothing overlapping it
// any more, unlocked and unexpired. Nothing exercised those last two
// conditions, so mutating either away reddened no test.
//
// This file renders the assembled <Shell>, opens the share card on a page that
// holds a nested grant, presses the fold, and asserts the requests that follow
// and the sentence that reaches the DOM.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareScopeSnapshot, TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { Shell } from "./shell";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor() {
      return <div data-testid="fake-editor" />;
    },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const STAMP = "2026-09-20T08:00:00.000Z";

function fixtureTree(): TreeNode[] {
  return [
    {
      id: "page-a",
      parentId: null,
      title: "Apartment",
      order: "page-a",
      created: STAMP,
      updated: STAMP,
      hasChildren: false,
      children: [],
    },
  ];
}

function snapshot(values: Partial<ShareScopeSnapshot> = {}): ShareScopeSnapshot {
  return {
    rootId: "page-a",
    descendantCount: 2,
    overlappingRoots: [],
    scopeToken: "a".repeat(64),
    public: false,
    shareLocked: false,
    shareEdit: false,
    shareExpiresAt: null,
    shareVersion: 0,
    ...values,
  };
}

/** The page under review holds one nested link and nothing else, which is the
 *  one shape the card offers the fold for. */
function blockedByNested(): ShareScopeSnapshot {
  return snapshot({
    overlappingRoots: [
      {
        rootId: "inside",
        title: "Kitchen",
        relation: "descendant",
        shareExpiresAt: null,
        shareLocked: false,
      },
    ],
  });
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("the shell's fold read-back", () => {
  let host: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.mocked(apiFetch);
  /** What the second read of the durable scope answers, per case. */
  let readBack: ShareScopeSnapshot;
  let copied: string[];

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    copied = [];
    readBack = snapshot({ public: true, shareVersion: 1 });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/page-a") {
        return response({
          meta: { title: "Apartment", stickers: [] },
          markdown: "Body",
          rev: "rev-a",
        });
      }
      if (url === "/api/page/page-a/share" && init?.method === "POST") {
        return response(snapshot({ public: true, shareVersion: 1 }));
      }
      if (url === "/api/page/page-a/share") {
        // The first read is the card's disclosure, every later one the
        // callback's own read-back.
        return response(
          fetchMock.mock.calls.filter(
            ([candidate, options]) =>
              String(candidate) === "/api/page/page-a/share" &&
              (options as RequestInit | undefined)?.method === undefined,
          ).length > 1
            ? readBack
            : blockedByNested(),
        );
      }
      if (url === "/api/tree") return response({ tree: fixtureTree() });
      if (url === "/api/notifications") {
        return response({ notifications: [], unread: 0 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    vi.stubGlobal(
      "EventSource",
      class {
        onopen: (() => void) | null = null;
        addEventListener() {}
        removeEventListener() {}
        close() {}
      },
    );
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    });
    for (const name of [
      "hasPointerCapture",
      "setPointerCapture",
      "releasePointerCapture",
    ]) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        value: () => undefined,
      });
    }
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    window.history.replaceState({}, "", "/p/page-a");
    await act(async () =>
      root.render(<Shell tree={fixtureTree()} initialSelectedId="page-a" />),
    );
    await settle();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((node) => node.remove());
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function click(element: Element | null | undefined) {
    if (!element) throw new Error("Expected a clickable element");
    await act(async () => {
      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
  }

  function button(name: string) {
    return [...document.body.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  }

  /** The card, opened on the desktop topbar's trigger. */
  async function openCard() {
    const triggers = [
      ...host.querySelectorAll<HTMLButtonElement>('[aria-label="Share"]'),
    ];
    await click(triggers.at(-1));
    for (let round = 0; round < 20 && !button("Share Apartment instead"); round += 1) {
      await settle();
    }
  }

  const shareRequests = () =>
    fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/page/page-a/share",
    );

  it("copies the link only after a second read says the fold stands", async () => {
    await openCard();
    await click(button("Share Apartment instead"));

    // Three requests in order: the card's disclosure, the fold, the read-back.
    // A fourth follows, and only here: the fold landed, so the tree refresh
    // moves the card's scope revision and it discloses the new state.
    const requests = shareRequests();
    expect(requests).toHaveLength(4);
    expect(requests[0][1]?.method).toBeUndefined();
    expect(requests[1][1]?.method).toBe("POST");
    expect(JSON.parse(String(requests[1][1]?.body))).toEqual({
      enabled: true,
      absorbNested: true,
      expectedScopeToken: "a".repeat(64),
    });
    expect(requests[2][1]?.method).toBeUndefined();

    expect(copied).toEqual([`${location.origin}/share/page-a`]);
    expect(document.body.textContent).toContain(
      "Public link copied. The links inside it still work.",
    );
  });

  it("refuses the toast when the read-back comes back locked", async () => {
    readBack = snapshot({ public: true, shareLocked: true, shareVersion: 1 });
    await openCard();
    await click(button("Share Apartment instead"));

    expect(shareRequests()).toHaveLength(3);
    expect(copied).toEqual([]);
    expect(document.body.textContent).not.toContain("still work");
    expect(document.body.textContent).toContain(
      "Couldn't confirm sharing this page instead.",
    );
  });

  it("refuses the toast when the read-back's deadline has already passed", async () => {
    readBack = snapshot({
      public: true,
      shareExpiresAt: "2020-01-01T00:00:00.000Z",
      shareVersion: 1,
    });
    await openCard();
    await click(button("Share Apartment instead"));

    expect(shareRequests()).toHaveLength(3);
    expect(copied).toEqual([]);
    expect(document.body.textContent).not.toContain("still work");
    expect(document.body.textContent).toContain(
      "Couldn't confirm sharing this page instead.",
    );
  });

  it("refuses the toast when the read-back still shows a grant inside", async () => {
    readBack = blockedByNested();
    readBack = { ...readBack, public: true, shareVersion: 1 };
    await openCard();
    await click(button("Share Apartment instead"));

    expect(shareRequests()).toHaveLength(3);
    expect(copied).toEqual([]);
    expect(document.body.textContent).not.toContain("still work");
  });
});
