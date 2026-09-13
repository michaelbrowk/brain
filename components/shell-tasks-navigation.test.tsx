// @vitest-environment jsdom

// The desktop URL contract of the tasks surface (/tasks): the deep-link
// mount, the sidebar row that opens it with a real history entry, and Back
// leaving it for the notes surface.

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
  static instances: FakeEventSource[] = [];
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
  constructor() {
    FakeEventSource.instances.push(this);
  }
}

function surfaceBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="tasks-surface"]');
}

function navRow(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button.tree-row")].find(
      (button) => button.textContent?.includes(label),
    ) ?? null
  );
}

describe("tasks surface navigation (desktop)", () => {
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
      // desktop viewport: neither (max-width: 767px) nor reduced motion
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/settings/update") {
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

  it("mounts the surface on a /tasks deep link, with the row current and no toolbar", async () => {
    window.history.replaceState({}, "", "/tasks");

    await act(async () =>
      root.render(
        <Shell tree={[]} initialSelectedId={null} initialSurface="tasks" />,
      ),
    );
    await settle();

    await findLazy(surfaceBody, "tasks surface");
    expect(navRow("Tasks")?.getAttribute("aria-current")).toBe("page");
    expect(navRow("Mail")?.getAttribute("aria-current")).toBeNull();
    // the surface carries its own head, so neither toolbar variant draws
    expect(document.querySelector(".brain-topbar")).toBeNull();
  });

  it("opens from the sidebar row with a real entry, and Back leaves it", async () => {
    window.history.replaceState({}, "", "/");

    await act(async () => root.render(<Shell tree={[]} initialSelectedId={null} />));
    await settle();
    expect(surfaceBody()).toBeNull();

    await act(async () => navRow("Tasks")?.click());
    await findLazy(surfaceBody, "tasks surface after the row click");
    expect(window.location.pathname).toBe("/tasks");

    await act(async () => {
      window.history.replaceState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    expect(surfaceBody()).toBeNull();
  });

  it("hands a task event to the surface without refetching the tree", async () => {
    window.history.replaceState({}, "", "/tasks");

    await act(async () =>
      root.render(
        <Shell tree={[]} initialSelectedId={null} initialSurface="tasks" />,
      ),
    );
    const body = await findLazy(surfaceBody, "tasks surface");
    expect(body.dataset.refreshToken).toBe("0");

    const treeCalls = () =>
      apiFetchMock.mock.calls.filter(([input]) => String(input) === "/api/tree")
        .length;
    const before = treeCalls();

    await act(async () => {
      FakeEventSource.instances[0]?.onmessage?.({
        data: JSON.stringify({ type: "task", id: "task-1", src: "other" }),
      } as MessageEvent);
    });
    await settle();

    expect(surfaceBody()?.dataset.refreshToken).toBe("1");
    expect(treeCalls()).toBe(before);
  });

  it("re-enters on a forward popstate to /tasks", async () => {
    window.history.replaceState({}, "", "/");

    await act(async () => root.render(<Shell tree={[]} initialSelectedId={null} />));
    await settle();

    await act(async () => {
      window.history.replaceState({}, "", "/tasks");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await findLazy(surfaceBody, "tasks surface after a forward popstate");
  });
});
