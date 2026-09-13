// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellSidebar, type ShellSidebarProps } from "./sidebar";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

function sidebarProps(
  overrides: Partial<ShellSidebarProps> = {},
): ShellSidebarProps {
  return {
    tree: [],
    selectedId: null,
    sidebarSelectedId: null,
    expanded: new Set<string>(),
    focusMode: false,
    offCanvas: false,
    surface: "notes",
    settingsSection: null,
    onSelectSettingsSection: vi.fn(),
    pinnedPages: [],
    onGoHome: vi.fn(),
    onCloseSettings: vi.fn(),
    onOpenPalette: vi.fn(),
    onCreatePage: vi.fn(async () => null),
    onOpenDailyPage: vi.fn(),
    onOpenMail: vi.fn(),
    onOpenTasks: vi.fn(),
    onSelect: vi.fn(),
    onToggleExpand: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onCopyLink: vi.fn(),
    onDuplicate: vi.fn(),
    onDialogIntent: vi.fn(),
    onMoveRequest: vi.fn(),
    onTogglePin: vi.fn(),
    onMove: vi.fn(),
    onReparentPageRef: vi.fn(() => null),
    onPrefetch: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenTrash: vi.fn(),
    onCollapsed: vi.fn(),
    ...overrides,
  };
}

function navRow(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button.tree-row")].find(
      (button) => button.textContent?.includes(label),
    ) ?? null
  );
}

describe("ShellSidebar tasks row", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          apiVersion: 1,
          version: "0.9.0",
          commit: "abc1234",
          buildTime: null,
          updateCheck: "on",
          checkedAt: null,
          latest: { version: "1.0.0", url: "https://example.test", publishedAt: "" },
          updateAvailable: true,
          error: null,
        }),
      })) as unknown as typeof fetch,
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ShellSidebarProps> = {}) {
    await act(async () => root.render(<ShellSidebar {...sidebarProps(overrides)} />));
  }

  it("renders a Tasks row under Mail, current while the surface is tasks", async () => {
    await render();

    const rows = [...document.querySelectorAll("button.tree-row")].map(
      (row) => row.textContent,
    );
    const mailAt = rows.findIndex((text) => text?.includes("Mail"));
    const tasksAt = rows.findIndex((text) => text?.includes("Tasks"));
    expect(mailAt).toBeGreaterThan(-1);
    expect(tasksAt).toBe(mailAt + 1);
    expect(navRow("Tasks")?.getAttribute("aria-current")).toBeNull();

    const onOpenTasks = vi.fn();
    await render({ surface: "tasks", onOpenTasks });
    expect(navRow("Tasks")?.getAttribute("aria-current")).toBe("page");
    expect(navRow("Mail")?.getAttribute("aria-current")).toBeNull();

    await act(async () => navRow("Tasks")?.click());
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });

  it("shows the open-today count on the Tasks row and nothing when it is zero", async () => {
    await render({ tasksOpenTodayCount: 3 });
    expect(navRow("Tasks")?.querySelector(".tree-row-count")?.textContent).toBe("3");

    await render({ tasksOpenTodayCount: 0 });
    expect(navRow("Tasks")?.querySelector(".tree-row-count")).toBeNull();

    await render();
    expect(navRow("Tasks")?.querySelector(".tree-row-count")).toBeNull();
  });

  it("never renders a count and a badge dot on one row", async () => {
    await render({ tasksOpenTodayCount: 2 });

    // the update dot lands on the Settings row, the count on Tasks
    const dots = document.querySelectorAll('[aria-label="Update available"]');
    expect(dots.length).toBeGreaterThan(0);
    for (const row of document.querySelectorAll("button.tree-row")) {
      const both =
        !!row.querySelector(".tree-row-count") &&
        !!row.querySelector('[aria-label="Update available"]');
      expect(both).toBe(false);
    }
  });
});
