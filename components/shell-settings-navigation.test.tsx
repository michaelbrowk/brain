// @vitest-environment jsdom

// The desktop URL contract of the settings surface (/settings/[section]):
// deep-link render, the /settings → /settings/appearance normalisation, the
// replaceState section change, Esc semantics, and back/forward.

import { act, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";
import { Shell } from "./shell";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

vi.mock("./mail-surface", () => ({
  MailSurface: () => <div data-testid="fake-mail-surface" />,
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    let Resolved: React.ComponentType<Record<string, unknown>> | null = null;
    return function DynamicStub(props: Record<string, unknown>) {
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        if (Resolved) return;
        void Promise.resolve(loader()).then((mod) => {
          Resolved =
            (mod as { default?: React.ComponentType<Record<string, unknown>> })
              ?.default ?? (mod as React.ComponentType<Record<string, unknown>>);
          force();
        });
      }, []);
      return Resolved ? <Resolved {...props} /> : null;
    };
  },
}));

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function findLazy<T extends Element>(
  select: () => T | null | undefined,
  what: string,
): Promise<T> {
  // a cold vitest transform of a code-split chunk can take real time —
  // wait in 10ms steps, not bare macrotasks
  for (let round = 0; round < 200; round += 1) {
    const found = select();
    if (found) return found;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await settle();
  }
  throw new Error(`not found: ${what}`);
}

class FakeEventSource {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSED = 2 as const;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe("settings surface navigation (desktop)", () => {
  let host: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/tree") return response({ tree: [] });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      // desktop viewport: nothing matches (max-width: 767px)
      matches: query.includes("prefers-reduced-motion") ? false : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/mail/accounts")) {
          return Promise.resolve(response({ apiVersion: 2, accounts: [] }));
        }
        if (url === "/api/settings/backup" || url === "/api/settings/mcp") {
          return Promise.resolve(response({ error: "unavailable" }, 503));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function sidebarSectionRow(label: string) {
    const slot = document.querySelector('[aria-label="Settings sections"]');
    if (!slot) return null;
    return (
      [...slot.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      ) ?? null
    );
  }

  it("renders a deep-linked section: content, sidebar slot, breadcrumb", async () => {
    window.history.replaceState({}, "", "/settings/connections");

    await act(async () =>
      root.render(
        <Shell
          tree={[]}
          initialSelectedId={null}
          initialSurface="settings"
          initialSettingsSection="connections"
        />,
      ),
    );
    await settle();

    const detail = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-detail"]',
        ),
      "settings content",
    );
    expect(detail.textContent).toContain("MCP server");

    // the sidebar slot lists the six sections; the active row is current
    const active = sidebarSectionRow("Connections");
    expect(active).not.toBeNull();
    expect(active?.getAttribute("aria-current")).toBe("page");
    expect(sidebarSectionRow("Appearance")?.getAttribute("aria-current")).toBeNull();
    // the pages tree and its search capsule are not in the slot
    expect(document.querySelector('[data-search-trigger="desktop"]')).toBeNull();
    // the foot Settings row reads as current too
    expect(
      document
        .querySelector('[data-settings-trigger="desktop"]')
        ?.getAttribute("aria-current"),
    ).toBe("page");

    // breadcrumb pill: Settings › Connections
    const crumb = document.querySelector('nav[aria-label="Breadcrumb"]');
    expect(crumb?.textContent).toContain("Settings");
    expect(crumb?.textContent).toContain("Connections");
  });

  it("normalises /settings to /settings/appearance in place", async () => {
    window.history.replaceState({}, "", "/settings");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");

    await act(async () =>
      root.render(
        <Shell tree={[]} initialSelectedId={null} initialSurface="settings" />,
      ),
    );
    await settle();

    expect(replaceState).toHaveBeenCalledWith({}, "", "/settings/appearance");
    expect(pushState).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/settings/appearance");
    const detail = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-detail"]',
        ),
      "settings content",
    );
    expect(detail.textContent).toContain("Theme");
    expect(detail.textContent).toContain("Reading typeface");
    expect(detail.textContent).toContain("Background");
  });

  it("changes the section in place — Back leaves settings in one step", async () => {
    window.history.replaceState({}, "", "/settings/appearance");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");

    await act(async () =>
      root.render(
        <Shell
          tree={[]}
          initialSelectedId={null}
          initialSurface="settings"
          initialSettingsSection="appearance"
        />,
      ),
    );
    await settle();
    await findLazy(
      () => sidebarSectionRow("Data"),
      "sidebar section list",
    );

    await act(async () => sidebarSectionRow("Data")?.click());
    expect(replaceState).toHaveBeenCalledWith({}, "", "/settings/data");
    expect(pushState).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/settings/data");
    const detail = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-detail"]',
        ),
      "settings content",
    );
    await findLazy(
      () =>
        detail.textContent?.includes("Export all notes") ? detail : null,
      "data section content",
    );
    expect(sidebarSectionRow("Data")?.getAttribute("aria-current")).toBe("page");
  });

  it("opens from the sidebar with a real entry and Esc goes back", async () => {
    window.history.replaceState({}, "", "/");
    const pushState = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    await act(async () =>
      root.render(<Shell tree={[]} initialSelectedId={null} />),
    );
    await settle();

    const trigger = document.querySelector(
      '[data-settings-trigger="desktop"]',
    ) as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(pushState).toHaveBeenCalledWith({}, "", "/settings/appearance");
    await findLazy(
      () =>
        document.querySelector('[data-testid="mobile-settings-detail"]'),
      "settings content",
    );

    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    // entered in-app: Esc pops the settings entry, the popstate restores
    // the previous surface
    expect(back).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.history.replaceState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    expect(
      document.querySelector('[data-testid="mobile-settings-detail"]'),
    ).toBeNull();
  });

  it("shows a back row in the settings slot that shares the close semantics", async () => {
    window.history.replaceState({}, "", "/");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    await act(async () =>
      root.render(<Shell tree={[]} initialSelectedId={null} />),
    );
    await settle();

    // the pages slot has no back row — the tree is already home
    expect(document.querySelector(".brain-sidebar-back")).toBeNull();

    const trigger = document.querySelector(
      '[data-settings-trigger="desktop"]',
    ) as HTMLButtonElement;
    await act(async () => trigger.click());
    await findLazy(
      () => document.querySelector('[data-testid="mobile-settings-detail"]'),
      "settings content",
    );

    const row = document.querySelector<HTMLButtonElement>(
      ".brain-sidebar-back",
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Back");
    await act(async () => row?.click());
    // entered in-app: the row pops the settings entry, exactly like Esc
    expect(back).toHaveBeenCalledTimes(1);
  });

  /* MAIL IS AN ORDINARY DESTINATION IN THE PANEL AGAIN. The slot used to be
     taken over by mail's rail, and a Back row above it was the way out. Mail
     navigates itself from the head of its own column now, so the panel keeps
     the tree, the Mail row in it marks itself selected, and there is no back
     row to draw — the wordmark is the way home it always was. Settings keeps
     its own (the test above). */
  it("keeps the tree panel and marks Mail selected while mail is open", async () => {
    window.history.replaceState({}, "", "/mail");

    await act(async () =>
      root.render(
        <Shell tree={[]} initialSelectedId={null} initialSurface="mail" />,
      ),
    );
    await settle();
    await findLazy(
      () => document.querySelector('[data-testid="fake-mail-surface"]'),
      "mail surface",
    );

    expect(document.querySelector(".brain-sidebar-back")).toBeNull();
    const sidebar = document.querySelector(".brain-sidebar") as HTMLElement;
    const mailRow = [...sidebar.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Mail",
    );
    expect(mailRow?.getAttribute("aria-current")).toBe("page");
    expect(sidebar.textContent).toContain("Pages");
    expect(sidebar.querySelector(".brain-sidebar-search")).not.toBeNull();
  });

  it("Esc on a cold /settings load exits home instead of leaving the site", async () => {
    window.history.replaceState({}, "", "/settings/appearance");
    const pushState = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    await act(async () =>
      root.render(
        <Shell
          tree={[]}
          initialSelectedId={null}
          initialSurface="settings"
          initialSettingsSection="appearance"
        />,
      ),
    );
    await settle();
    await findLazy(
      () =>
        document.querySelector('[data-testid="mobile-settings-detail"]'),
      "settings content",
    );

    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(back).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledWith({}, "", "/");
    expect(window.location.pathname).toBe("/");
    expect(
      document.querySelector('[data-testid="mobile-settings-detail"]'),
    ).toBeNull();
  });

  it("follows back/forward between settings sections and the notes surface", async () => {
    window.history.replaceState({}, "", "/");

    await act(async () =>
      root.render(<Shell tree={[]} initialSelectedId={null} />),
    );
    await settle();

    // forward into a section (the URL is the contract)
    await act(async () => {
      window.history.replaceState({}, "", "/settings/sharing");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const detail = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-detail"]',
        ),
      "settings content",
    );
    expect(detail.textContent).toContain("Shared pages");

    // back out to the hub
    await act(async () => {
      window.history.replaceState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    expect(
      document.querySelector('[data-testid="mobile-settings-detail"]'),
    ).toBeNull();

    // forward again re-enters the same section
    await act(async () => {
      window.history.replaceState({}, "", "/settings/sharing");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await findLazy(
      () =>
        document.querySelector('[data-testid="mobile-settings-detail"]'),
      "settings content after forward",
    );
  });
});
