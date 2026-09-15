// @vitest-environment jsdom

// WHERE A NOTIFICATION ROW TAKES THE READER. The shell routes on the row's
// PATH and not on its kind, so a kind added later needs no branch there. That
// generosity is exactly what needs holding: an href the shell has no surface
// for has to land somewhere deliberate rather than nowhere.

import { act, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";
import { resetNotificationsStore } from "./notifications-client";
import { resetTasksStore } from "./tasks-client";
import { Shell } from "./shell";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

// BOTH SURFACES ARE DOUBLED, because the subject here is where a press goes
// and not what the column does once it is there. The real Tasks surface reads
// `?task=` and takes the query off again as soon as it has answered it, which
// would erase the half of this the shell owns.
vi.mock("./mail-surface", () => ({
  MailSurface: () => <div data-testid="fake-mail-surface" />,
}));

vi.mock("./tasks-surface", () => ({
  TasksSurface: () => <div data-testid="tasks-surface" />,
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

const TASK_ID = "task-reminder:task-1:2026-09-14T13:00";
const MAIL_ID = "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d6f6e65";

let rows: unknown[];

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

function tasksSurface(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="tasks-surface"]');
}

function mailSurface(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="fake-mail-surface"]');
}

describe("a notification row's destination", () => {
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
    resetNotificationsStore();
    rows = [];
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/tree") return response({ tree: [] });
      if (url.startsWith("/api/tasks?")) return response({ tasks: [] });
      if (url === "/api/notifications") {
        return response({
          notifications: rows,
          unread: rows.filter((item) => (item as { readAt?: string }).readAt === undefined)
            .length,
        });
      }
      // A press in the centre marks the row read, so this file answers that
      // one write on its own path rather than on a prefix that would also
      // swallow a stray one.
      if (url === "/api/notifications/read") return response({ read: 1 });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      // desktop viewport: the bell is in the sidebar head, which is where the
      // centre lives at every width. Home draws no notification rows.
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
    // Radix measures its content and captures the pointer; jsdom ships
    // neither. The same stubs `notifications-bell.test.tsx` puts up.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("PointerEvent", MouseEvent);
    for (const name of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"]) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        value: () => (name === "hasPointerCapture" ? false : undefined),
      });
    }
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
    document
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((element) => element.remove());
    resetNotificationsStore();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** The centre with one row in it, opened, and that row pressed. */
  async function pressTheRow(title: string) {
    window.history.replaceState({}, "", "/");
    await act(async () => root.render(<Shell tree={[]} initialSelectedId={null} />));
    await settle();

    const bell = document.querySelector<HTMLButtonElement>('[aria-label^="Notifications"]');
    if (!bell) throw new Error("the bell is not in the sidebar head");
    // Radix opens a dropdown on `pointerdown`, so a bare `.click()` here would
    // press against a menu that never opened.
    await act(async () => {
      bell.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await settle();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      (node.textContent ?? "").includes(title),
    );
    if (!(item instanceof HTMLElement)) throw new Error(`no row reading ${title}`);
    await act(async () => item.click());
    await settle();
  }

  it("takes a task row to the Tasks surface", async () => {
    rows = [
      {
        id: TASK_ID,
        kind: "task-reminder",
        at: "2026-09-14T12:00:00.000Z",
        title: "Water the plants",
        body: "13:00",
        href: "/tasks",
      },
    ];
    await pressTheRow("Water the plants");

    await findLazy(tasksSurface, "tasks surface after the row press");
    expect(window.location.pathname).toBe("/tasks");
    // The entry carries the task, because that is what the surface reads to
    // select the row and scroll to it. `openTasks` writes the bare path, so
    // the row's own href is written before it rather than after.
    expect(window.location.search).toBe("?task=task-1");
    expect(mailSurface()).toBeNull();
  });

  it("re-asks the tasks surface for its records when a task row is pressed while Tasks is already on screen", async () => {
    rows = [
      {
        id: TASK_ID,
        kind: "task-reminder",
        at: "2026-09-14T12:00:00.000Z",
        title: "Water the plants",
        body: "13:00",
        href: "/tasks",
      },
    ];
    await pressTheRow("Water the plants");
    await findLazy(tasksSurface, "tasks surface after the first press");

    const tasksCallsBefore = apiFetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/tasks?"),
    ).length;

    // Pressed again with Tasks already the surface on screen: `openTasks`
    // writes nothing this time, since the pathname already starts with
    // `/tasks`, so a bumped revision is the only thing that can make the
    // shell's own `useTasks` read again.
    rows = [
      {
        id: TASK_ID,
        kind: "task-reminder",
        at: "2026-09-14T12:05:00.000Z",
        title: "Water the plants",
        body: "13:00",
        href: "/tasks",
      },
    ];
    await pressTheRow("Water the plants");

    await vi.waitFor(() => {
      const tasksCallsAfter = apiFetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/tasks?"),
      ).length;
      expect(tasksCallsAfter).toBeGreaterThan(tasksCallsBefore);
    });
  });

  it("takes a mail row to Mail", async () => {
    rows = [
      {
        id: MAIL_ID,
        kind: "mail-new",
        at: "2026-09-14T12:00:00.000Z",
        title: "Ana Silva",
        body: "Lunch on Friday",
        href: "/mail",
      },
    ];
    await pressTheRow("Ana Silva");

    await findLazy(mailSurface, "mail surface after the row press");
    expect(window.location.pathname).toBe("/mail");
    expect(tasksSurface()).toBeNull();
  });

  it("takes a row it has no surface for home, rather than nowhere", async () => {
    // The centre is generic: a kind whose href is neither Mail nor Tasks joins
    // without a branch in the shell, and Home is where it lands until one of
    // its own exists.
    rows = [
      {
        id: "agent-notice:one",
        kind: "task-reminder",
        at: "2026-09-14T12:00:00.000Z",
        title: "Something else entirely",
        href: "/nowhere",
      },
    ];
    await pressTheRow("Something else entirely");

    expect(window.location.pathname).toBe("/");
    expect(tasksSurface()).toBeNull();
    expect(mailSurface()).toBeNull();
  });
});
