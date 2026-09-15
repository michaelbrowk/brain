// @vitest-environment jsdom

// The desktop URL contract of the tasks surface (/tasks): the deep-link
// mount, the sidebar row that opens it with a real history entry, and Back
// leaving it for the notes surface.

import { act, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";
import { resetTasksStore } from "./tasks-client";
import { resetMailComposeAvailable } from "./mail-compose-available";
import { resetTaskCaptureFocus } from "./tasks-ghost-row";
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
    resetTasksStore();
    resetTaskCaptureFocus();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/tree") return response({ tree: [] });
      // the surface and the sidebar count read ONE list of records
      if (url.startsWith("/api/tasks?")) return response({ tasks: [] });
      // the bell asks the centre on mount, on every surface
      if (url === "/api/notifications")
        return response({ notifications: [], unread: 0 });
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
    // Radix's popper measures its content and captures the pointer; jsdom
    // ships neither. The head's plus opens one.
    resetMailComposeAvailable();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("PointerEvent", MouseEvent);
    for (const name of [
      "hasPointerCapture",
      "setPointerCapture",
      "releasePointerCapture",
    ]) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        value: () => (name === "hasPointerCapture" ? false : undefined),
      });
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((element) => element.remove());
    window.history.replaceState(null, "", "/");
    resetMailComposeAvailable();
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
    await findLazy(surfaceBody, "tasks surface");

    const callsFor = (prefix: string) =>
      apiFetchMock.mock.calls.filter(([input]) => String(input).startsWith(prefix))
        .length;
    const treeBefore = callsFor("/api/tree");
    const tasksBefore = callsFor("/api/tasks?");
    // the count and the column subscribe to one module, so the surface being
    // on screen is still one read
    expect(tasksBefore).toBe(1);

    await act(async () => {
      FakeEventSource.instances[0]?.onmessage?.({
        data: JSON.stringify({ type: "task", id: "task-1", src: "other" }),
      } as MessageEvent);
    });
    await settle();

    // the event bumps the token, and the token is part of the load's key
    expect(callsFor("/api/tasks?")).toBe(tasksBefore + 1);
    expect(callsFor("/api/tree")).toBe(treeBefore);
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

  // THE PLUS MAKES MORE THAN A PAGE NOW. Its Task row is the palette's "New
  // task" reached by pointing instead of typing: the same surface, the same
  // list, the same caret.
  const plus = () =>
    document.querySelector<HTMLButtonElement>(
      '.brain-sidebar-head [aria-label="New"]',
    );

  const menuRow = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => (node.textContent ?? "").trim() === name,
    );

  async function openNewMenu() {
    await act(async () => {
      plus()!.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await settle();
  }

  it("opens Tasks with the caret in the capture row from the head's plus", async () => {
    window.history.replaceState({}, "", "/");

    await act(async () => root.render(<Shell tree={[]} initialSelectedId={null} />));
    await settle();
    expect(surfaceBody()).toBeNull();

    await openNewMenu();
    expect(menuRow("Task")).not.toBeUndefined();

    await act(async () => menuRow("Task")!.click());
    await findLazy(surfaceBody, "tasks surface after the Task row");
    expect(window.location.pathname).toBe("/tasks");

    const capture = await findLazy(
      () => document.querySelector<HTMLInputElement>('input[aria-label="New task"]'),
      "the capture row",
    );
    expect(capture.placeholder).toBe("New task…");
    expect(document.activeElement).toBe(capture);
  });

  it("does not steal the caret on a later visit after one Task press", async () => {
    window.history.replaceState({}, "", "/");

    await act(async () => root.render(<Shell tree={[]} initialSelectedId={null} />));
    await settle();

    await openNewMenu();
    await act(async () => menuRow("Task")!.click());
    await findLazy(surfaceBody, "tasks surface after the Task row");
    await findLazy(
      () => document.querySelector<HTMLInputElement>('input[aria-label="New task"]'),
      "the capture row on the first visit",
    );

    // leave Tasks the way a reader would, with Back
    await act(async () => {
      window.history.replaceState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    expect(surfaceBody()).toBeNull();

    // and come straight back through the sidebar row, not the plus: the
    // request that focused the row the first time must not fire again
    await act(async () => navRow("Tasks")?.click());
    await findLazy(surfaceBody, "tasks surface after the second visit");

    const capture = await findLazy(
      () => document.querySelector<HTMLInputElement>('input[aria-label="New task"]'),
      "the capture row on the second visit",
    );
    expect(document.activeElement).not.toBe(capture);
  });

  it("does the same from Settings, where the plus is not drawn", async () => {
    window.history.replaceState({}, "", "/settings/appearance");

    await act(async () =>
      root.render(
        <Shell tree={[]} initialSelectedId={null} initialSurface="settings" />,
      ),
    );
    await settle();
    // Settings draws no create in its head, so the palette carries the row
    expect(plus()).toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    await settle();

    const newTask = await findLazy(
      () =>
        [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
          (item) => item.textContent?.trim() === "New task",
        ),
      "the palette's New task row",
    );
    await act(async () => newTask.click());
    await findLazy(surfaceBody, "tasks surface after New task on Settings");
    expect(window.location.pathname).toBe("/tasks");

    const capture = await findLazy(
      () => document.querySelector<HTMLInputElement>('input[aria-label="New task"]'),
      "the capture row",
    );
    expect(document.activeElement).toBe(capture);
  });
});