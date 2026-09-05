// @vitest-environment jsdom

import { act, createRef, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { MobilePagesView } from "./mobile-pages-view";
import { resetUpdateStatusForTests } from "./settings/use-update-status";
import { Shell } from "./shell";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

// The mail surface is code-split and irrelevant here — a named stub keeps
// the /mail hand-off cheap while the settings chunks load for real.
vi.mock("./mail-surface", () => ({
  MailSurface: () => <div data-testid="fake-mail-surface" />,
}));

// A resolving next/dynamic: the loader runs on first render, so the real
// settings surface (and the real mail account manager inside it) mounts in
// jsdom the way it does in the app — after a macrotask round.
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

function node(
  id: string,
  title: string,
  children: TreeNode[] = [],
  parentId: string | null = null,
): TreeNode {
  return {
    id,
    parentId,
    title,
    order: id,
    created: "2026-07-14T00:00:00.000Z",
    updated: "2026-07-14T00:00:00.000Z",
    hasChildren: children.length > 0,
    children,
  };
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Chunks resolve over a few macrotask rounds in jsdom — poll for the
 *  element instead of assuming it is mounted right after the first settle. */
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mailAccount(accountId: string, emailAddress: string) {
  return {
    accountId,
    emailAddress,
    displayName: null,
    status: "connected",
    providerKind: "imap",
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit",
      username: emailAddress,
    },
    connectedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

const MAIL_ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";

/** Every request the settings surface can make in these tests. */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/mail/accounts")) {
        return Promise.resolve(
          response({
            apiVersion: 2,
            accounts: [mailAccount(MAIL_ACCOUNT_ID, "person@example.test")],
          }),
        );
      }
      if (url === "/api/settings/backup") {
        return Promise.resolve(response({ error: "unavailable" }, 503));
      }
      if (url === "/api/settings/mcp") {
        return Promise.resolve(response({ error: "unavailable" }, 503));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
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

describe("mobile navigation surfaces", () => {
  let host: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    resetUpdateStatusForTests();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/tree") return response({ tree: [] });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: () => undefined,
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: () => undefined,
    });
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

  it("shows a searchable page tree and opens a result without a sidebar", async () => {
    const child = node("child", "Project notes", [], "parent");
    const tree = [node("parent", "Work", [child]), node("personal", "Personal")];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    const returnFocusRef = createRef<HTMLButtonElement>();
    const fallbackFocusRef = createRef<HTMLElement>();

    await act(async () =>
      root.render(
        <MobilePagesView
          open
          tree={tree}
          selectedId="child"
          footer={<button type="button">Footer</button>}
          returnFocusRef={returnFocusRef}
          fallbackFocusRef={fallbackFocusRef}
          nestedModalOpen={false}
          onClose={onClose}
          onOpenSettings={onOpenSettings}
          onSelect={onSelect}
        />,
      ),
    );
    await settle();

    const pagesDialog = document.querySelector(
      '[data-testid="mobile-pages-view"]',
    ) as HTMLElement;
    expect(pagesDialog).not.toBeNull();
    expect(pagesDialog.getAttribute("role")).toBe("dialog");
    expect(pagesDialog.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector('aside.brain-sidebar')).toBeNull();
    expect(document.querySelector('[aria-label="Open Project notes"]')).not.toBeNull();
    const settings = document.querySelector(
      '[data-settings-trigger="mobile-pages"]',
    ) as HTMLButtonElement;
    expect(settings).not.toBeNull();
    await act(async () => settings.click());
    expect(onOpenSettings).toHaveBeenCalledWith(settings);

    const search = document.querySelector(
      'input[placeholder="Search pages"]',
    ) as HTMLInputElement;
    // opening Pages must not raise the keyboard: the sheet itself takes
    // focus, the search field focuses only on an explicit tap
    expect(document.activeElement).toBe(pagesDialog);
    expect(document.activeElement).not.toBe(search);
    expect(search.className).toContain("text-[16px]");
    expect(search.labels?.length).toBe(1);
    expect(search.labels?.[0]?.textContent?.trim()).toBe("Search pages");
    await act(async () => inputValue(search, "personal"));
    const clear = document.querySelector(
      '[aria-label="Clear page search"]',
    ) as HTMLButtonElement;
    expect(search.labels?.[0]?.contains(clear)).toBe(false);
    expect(document.querySelector('[aria-label="Open Personal"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Open Work"]')).toBeNull();

    await act(async () => {
      (document.querySelector('[aria-label="Open Personal"]') as HTMLButtonElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith("personal");

    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Pages open while a nested modal owns Escape", async () => {
    const onClose = vi.fn();
    const returnFocusRef = createRef<HTMLButtonElement>();
    const fallbackFocusRef = createRef<HTMLElement>();

    await act(async () =>
      root.render(
        <MobilePagesView
          open
          tree={[node("page", "Page")]}
          selectedId="page"
          footer={<button type="button">Footer</button>}
          returnFocusRef={returnFocusRef}
          fallbackFocusRef={fallbackFocusRef}
          nestedModalOpen
          onClose={onClose}
          onOpenSettings={() => {}}
          onSelect={() => {}}
        />,
      ),
    );
    await settle();

    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="mobile-pages-view"]')).not.toBeNull();
  });

  it("deep-links /settings as the mobile root list and Back exits home", async () => {
    stubFetch();
    window.history.replaceState({}, "", "/settings");
    const pushState = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    await act(async () =>
      root.render(
        <Shell tree={[]} initialSelectedId={null} initialSurface="settings" />,
      ),
    );
    await settle();

    const rootScreen = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-root"]',
        ),
      "mobile settings root",
    );
    for (const label of [
      "Appearance",
      "Mail",
      "Connections",
      "Sharing",
      "Data",
      "Account",
    ]) {
      expect(rootScreen.textContent).toContain(label);
    }
    // the mobile viewport keeps the root list at /settings — no rewrite
    expect(window.location.pathname).toBe("/settings");

    // a cold /settings load has no in-app entry behind it: Back goes home
    // through goHome (a push), never through history.back()
    const backButton = rootScreen.querySelector(
      '[aria-label="Back"]',
    ) as HTMLButtonElement;
    await act(async () => backButton.click());
    expect(back).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledWith({}, "", "/");
    expect(window.location.pathname).toBe("/");
    expect(
      document.querySelector('[data-testid="mobile-settings-root"]'),
    ).toBeNull();
  });

  it("marks the Pages drawer's Settings gear while a newer release is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          apiVersion: 1,
          version: "0.9.0",
          commit: "a".repeat(40),
          buildTime: "2026-09-01T18:00:00Z",
          updateCheck: "on",
          checkedAt: "2026-09-02T09:00:00Z",
          latest: {
            version: "0.9.1",
            url: "https://github.com/michaelbrowk/brain/releases/tag/v0.9.1",
            publishedAt: "2026-09-02T08:00:00Z",
          },
          updateAvailable: true,
          error: null,
        }),
      ),
    );

    await act(async () =>
      root.render(
        <MobilePagesView
          open
          tree={[node("page", "Page")]}
          selectedId={null}
          footer={null}
          returnFocusRef={createRef<HTMLButtonElement>()}
          fallbackFocusRef={createRef<HTMLElement>()}
          nestedModalOpen={false}
          onClose={() => {}}
          onOpenSettings={() => {}}
          onSelect={() => {}}
        />,
      ),
    );
    await settle();

    const gear = document.querySelector(
      '[data-settings-trigger="mobile-pages"]',
    ) as HTMLButtonElement;
    expect(gear.getAttribute("aria-label")).toBe("Settings");
    // the same dot the desktop Settings row wears, on the gear itself
    const dot = await findLazy(
      () => gear.querySelector('[aria-label="Update available"]'),
      "update dot on the Settings gear",
    );
    expect(dot.className).toContain("size-1.5 rounded-full bg-current");
  });

  it("opens Settings from the Pages drawer and Back restores the drawer", async () => {
    stubFetch();
    window.history.replaceState({}, "", "/");

    await act(async () =>
      root.render(<Shell tree={[node("page", "Page")]} initialSelectedId={null} />),
    );
    await settle();

    const pagesTab = document.querySelector(
      '[data-mobile-tab="pages"]',
    ) as HTMLButtonElement;
    await act(async () => pagesTab.click());
    const gear = document.querySelector(
      '[data-settings-trigger="mobile-pages"]',
    ) as HTMLButtonElement;
    expect(gear).not.toBeNull();
    await act(async () => gear.click());

    expect(window.location.pathname).toBe("/settings");
    await findLazy(
      () =>
        document.querySelector('[data-testid="mobile-settings-root"]'),
      "mobile settings root",
    );
    // the drawer closed under the surface
    expect(
      document.querySelector('[data-testid="mobile-pages-view"]'),
    ).toBeNull();

    // browser Back: the previous URL restores the drawer and its gear
    await act(async () => {
      window.history.replaceState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    await findLazy(
      () => document.querySelector('[data-testid="mobile-pages-view"]'),
      "restored pages drawer",
    );
    expect(
      document.querySelector('[data-testid="mobile-settings-root"]'),
    ).toBeNull();
  });

  it("drills into a section with a history entry and Back returns to the root", async () => {
    stubFetch();
    window.history.replaceState({}, "", "/settings");
    const pushState = vi.spyOn(window.history, "pushState");

    await act(async () =>
      root.render(
        <Shell tree={[]} initialSelectedId={null} initialSurface="settings" />,
      ),
    );
    await settle();

    const rootScreen = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-root"]',
        ),
      "mobile settings root",
    );
    const mail = [...rootScreen.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Mail"),
    ) as HTMLButtonElement;
    await act(async () => mail.click());

    expect(pushState).toHaveBeenCalledWith({}, "", "/settings/mail");
    expect(window.location.pathname).toBe("/settings/mail");
    const detail = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-detail"]',
        ),
      "mobile settings detail",
    );
    expect(detail.textContent).toContain("Mail");
    expect(
      document.querySelector('[data-testid="mobile-settings-root"]'),
    ).toBeNull();

    // browser Back to /settings re-renders the root list
    await act(async () => {
      window.history.replaceState({}, "", "/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    await findLazy(
      () =>
        document.querySelector('[data-testid="mobile-settings-root"]'),
      "root list after Back",
    );
  });

  it("pops the drilled history entry when the detail Back returns to the root", async () => {
    stubFetch();
    window.history.replaceState({}, "", "/settings");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    await act(async () =>
      root.render(
        <Shell tree={[]} initialSelectedId={null} initialSurface="settings" />,
      ),
    );
    await settle();

    const rootScreen = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-root"]',
        ),
      "mobile settings root",
    );
    const data = [...rootScreen.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Data"),
    ) as HTMLButtonElement;
    await act(async () => data.click());
    const detail = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-detail"]',
        ),
      "mobile settings detail",
    );

    const backButton = detail.querySelector(
      '[aria-label="Back"]',
    ) as HTMLButtonElement;
    await act(async () => backButton.click());
    // the drill-down pushed a real entry, so Back pops it — the root list
    // re-renders from the popstate, not from surface state
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("shows a deep-linked section without a root entry and Back rewrites in place", async () => {
    stubFetch();
    window.history.replaceState({}, "", "/settings/data");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const replaceState = vi.spyOn(window.history, "replaceState");

    await act(async () =>
      root.render(
        <Shell
          tree={[]}
          initialSelectedId={null}
          initialSurface="settings"
          initialSettingsSection="data"
        />,
      ),
    );
    await settle();

    const detail = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-detail"]',
        ),
      "mobile settings detail",
    );
    const backButton = detail.querySelector(
      '[aria-label="Back"]',
    ) as HTMLButtonElement;
    await act(async () => backButton.click());

    // a deep link never drilled from the root, so Back rewrites to the list
    // in place instead of popping foreign history
    expect(back).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith({}, "", "/settings");
    await findLazy(
      () =>
        document.querySelector('[data-testid="mobile-settings-root"]'),
      "root list after in-place Back",
    );
  });

  it("reopens Settings when browser Forward revisits its URL", async () => {
    stubFetch();
    window.history.replaceState({}, "", "/");

    await act(async () =>
      root.render(<Shell tree={[]} initialSelectedId={null} />),
    );
    await settle();
    expect(
      document.querySelector('[data-testid="mobile-settings-root"]'),
    ).toBeNull();

    await act(async () => {
      window.history.replaceState({}, "", "/settings/mail");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();

    const detail = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-detail"]',
        ),
      "settings detail after Forward",
    );
    expect(detail.textContent).toContain("Mail");
  });

  it("Escape steps a drilled section back to the root list", async () => {
    stubFetch();
    window.history.replaceState({}, "", "/settings");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    await act(async () =>
      root.render(
        <Shell tree={[]} initialSelectedId={null} initialSurface="settings" />,
      ),
    );
    await settle();

    const rootScreen = await findLazy(
      () =>
        document.querySelector<HTMLElement>(
          '[data-testid="mobile-settings-root"]',
        ),
      "mobile settings root",
    );
    const account = [...rootScreen.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Account"),
    ) as HTMLButtonElement;
    await act(async () => account.click());
    await findLazy(
      () =>
        document.querySelector('[data-testid="mobile-settings-detail"]'),
      "mobile settings detail",
    );

    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    // the drilled entry pops — the popstate handler owns the re-render
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("opens the deep-linked mail account's details from ?account=<id>", async () => {
    stubFetch();
    window.history.replaceState(
      {},
      "",
      `/settings/mail?account=${MAIL_ACCOUNT_ID}`,
    );

    await act(async () =>
      root.render(
        <Shell
          tree={[]}
          initialSelectedId={null}
          initialSurface="settings"
          initialSettingsSection="mail"
          initialMailSettingsAccountId={MAIL_ACCOUNT_ID}
        />,
      ),
    );
    await settle();

    // the account manager resolves its chunk, loads the account list, and
    // opens the deep-linked account's details view
    const remove = await findLazy(
      () =>
        [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Remove",
        ),
      "account details Remove action",
    );
    expect(remove).not.toBeNull();
    expect(document.body.textContent).toContain("person@example.test");
  });
});
