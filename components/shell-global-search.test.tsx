// @vitest-environment jsdom

// What the shell does with the palette's two new intents: a mail pick goes
// into the open-thread latch and opens Mail, a task pick writes the row's
// href, bumps the tasks token and opens Tasks. The palette itself is a stub
// that hands its props out, the way `shell-search-navigation.test.tsx` reads
// the page intents.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandPaletteSelection } from "./command-palette";
import type { TaskView } from "@/lib/tasks/model";
import { apiFetch } from "@/lib/client";
import { clearOpenThreadRequest, pendingOpenThread } from "./mail-surface-client";
import { resetTasksStore } from "./tasks-client";
import { Shell } from "./shell";

type PaletteProps = {
  onSelect: (selection: CommandPaletteSelection) => void;
  searchMail?: boolean;
  tasks?: readonly TaskView[];
  today?: string;
};

const harness = vi.hoisted(() => ({
  paletteProps: null as PaletteProps | null,
}));

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("./command-palette", () => ({
  CommandPalette: (props: PaletteProps) => {
    harness.paletteProps = props;
    return null;
  },
}));

// Neither surface is under test; each dynamic import resolves to a stub.
vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeSurface() {
      return <div data-testid="fake-surface" />;
    },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Shell global search", () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    harness.paletteProps = null;
    resetTasksStore();
    clearOpenThreadRequest();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) {
        return response({
          tasks: [
            {
              id: "task-1",
              title: "Water the plants",
              created: "2026-09-20T08:00:00.000Z",
              updated: "2026-09-20T08:00:00.000Z",
              done: false,
            },
          ],
        });
      }
      // the bell asks the centre on mount, on every surface
      if (url === "/api/notifications") return response({ notifications: [], unread: 0 });
      throw new Error(`Unexpected request: ${url}`);
    });
    window.history.replaceState({}, "", "/");
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "EventSource",
      class {
        onopen: (() => void) | null = null;
        addEventListener() {}
        close() {}
      },
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clearOpenThreadRequest();
    vi.unstubAllGlobals();
  });

  async function render(modules = { mail: true, tasks: true }) {
    await act(async () =>
      root.render(<Shell tree={[]} initialSelectedId={null} modules={modules} />),
    );
    await settle();
  }

  it("hands the palette the module switches, the task records and the day", async () => {
    await render();
    expect(harness.paletteProps?.searchMail).toBe(true);
    expect(harness.paletteProps?.tasks?.map((task) => task.id)).toEqual(["task-1"]);
    expect(harness.paletteProps?.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The switches seed state on mount, so a shell with both off is a fresh mount.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ mail: false, tasks: false });
    expect(harness.paletteProps?.searchMail).toBe(false);
    expect(harness.paletteProps?.tasks).toBeUndefined();
  });

  it("latches a mail pick and opens Mail", async () => {
    await render();

    await act(async () =>
      harness.paletteProps?.onSelect({
        kind: "mail",
        accountId: ACCOUNT_ID,
        threadId: "thread-1",
      }),
    );
    await settle();

    expect(pendingOpenThread()).toEqual({ accountId: ACCOUNT_ID, threadId: "thread-1" });
    expect(window.location.pathname).toBe("/mail");
  });

  it("writes the task href, reloads the records and opens Tasks", async () => {
    await render();
    const tasksLoads = () =>
      apiFetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/tasks?"))
        .length;
    const before = tasksLoads();

    await act(async () =>
      harness.paletteProps?.onSelect({ kind: "task", id: "task-1" }),
    );
    await settle();

    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/tasks?task=task-1",
    );
    // The bumped token is what makes the surface, already mounted or not,
    // read the query again: it shows up as one more load of the records.
    expect(tasksLoads()).toBe(before + 1);
  });

  it("encodes the task id into the href", async () => {
    await render();

    await act(async () =>
      harness.paletteProps?.onSelect({ kind: "task", id: "task/1 a" }),
    );
    await settle();

    expect(window.location.search).toBe("?task=task%2F1%20a");
  });
});
