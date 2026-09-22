// @vitest-environment jsdom

// The shell with a module off. The DOM contract (shell-dom-contract.test.tsx)
// pins the whole markup; this file pins the facts that matter and would be
// hard to read out of a 400 KB baseline, plus the two things a baseline
// cannot see at all: the requests the shell does not make, and what it does
// when the module goes off underneath the surface it is showing.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { resetTasksStore } from "./tasks-client";
import { resetMailComposeAvailable } from "./mail-compose-available";
import { Shell } from "./shell";

vi.mock("@/lib/client", () => ({ apiFetch: vi.fn(), CLIENT_ID: "test-client" }));
vi.mock("next/dynamic", () => ({
  default: () =>
    function Stub() {
      return null;
    },
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));
vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const STAMP = "2026-08-01T08:00:00.000Z";
const TREE: TreeNode[] = [
  {
    id: "work",
    parentId: null,
    title: "Work",
    order: "work",
    created: STAMP,
    updated: STAMP,
    hasChildren: false,
    children: [],
  },
];

/** Captures the one listener the shell installs, so a `modules` event can be
 *  delivered the way the server delivers it. */
class FakeEventSource {
  static CLOSED = 2 as const;
  static last: FakeEventSource | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe("the shell with a module off", () => {
  let host: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    resetTasksStore();
    resetMailComposeAvailable();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      const ok = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as Response;
      if (url === "/api/tree") return ok({ tree: TREE });
      if (url === "/api/notifications") return ok({ notifications: [], unread: 0 });
      if (url.startsWith("/api/tasks")) return ok({ tasks: [] });
      return ok({});
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ apiVersion: 2, accounts: [] }),
          }) as Response,
      ),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
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
    resetTasksStore();
    resetMailComposeAvailable();
    vi.unstubAllGlobals();
  });

  async function render(
    modules: { mail: boolean; tasks: boolean },
    props: Record<string, unknown> = {},
  ) {
    await act(async () =>
      root.render(
        <Shell tree={TREE} initialSelectedId={null} modules={modules} {...props} />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  const labels = () =>
    [...document.body.querySelectorAll("button")].map((b) => b.textContent ?? "");

  it("draws both nav rows with both modules on", async () => {
    await render({ mail: true, tasks: true });
    expect(labels().some((text) => text.includes("Tasks"))).toBe(true);
    expect(labels().some((text) => text.includes("Mail"))).toBe(true);
  });

  it("takes the Tasks row off the sidebar and asks for no records at all", async () => {
    await render({ mail: true, tasks: false });
    expect(labels().some((text) => text.includes("Tasks"))).toBe(false);
    expect(labels().some((text) => text.includes("Mail"))).toBe(true);
    // Hiding the chip while still polling would be a module that is off on
    // screen and running underneath.
    const asked = apiFetchMock.mock.calls.map((call) => String(call[0]));
    expect(asked.some((url) => url.startsWith("/api/tasks"))).toBe(false);
  });

  it("takes the Mail row off the sidebar when Mail is off", async () => {
    await render({ mail: false, tasks: true });
    expect(labels().some((text) => text.includes("Mail"))).toBe(false);
    expect(labels().some((text) => text.includes("Tasks"))).toBe(true);
  });

  it("leaves Home when the module it is showing goes off underneath it", async () => {
    window.history.replaceState({}, "", "/tasks");
    await render({ mail: true, tasks: true }, { initialSurface: "tasks" });
    expect(window.location.pathname).toBe("/tasks");

    await act(async () => {
      FakeEventSource.last?.onmessage?.({
        data: JSON.stringify({
          type: "modules",
          id: "modules",
          modules: { mail: true, tasks: false },
        }),
      } as MessageEvent);
      await Promise.resolve();
    });

    // replaceState and not push: the surface the reader was on no longer
    // exists, so it must not be a back target either.
    expect(window.location.pathname).toBe("/");
    expect(labels().some((text) => text.includes("Tasks"))).toBe(false);
  });

  it("leaves the hidden Mail settings section for Appearance", async () => {
    window.history.replaceState({}, "", "/settings/mail");
    await render(
      { mail: true, tasks: true },
      { initialSurface: "settings", initialSettingsSection: "mail" },
    );
    await act(async () => {
      FakeEventSource.last?.onmessage?.({
        data: JSON.stringify({
          type: "modules",
          id: "modules",
          modules: { mail: false, tasks: true },
        }),
      } as MessageEvent);
      await Promise.resolve();
    });
    expect(window.location.pathname).toBe("/settings/appearance");
  });
});
