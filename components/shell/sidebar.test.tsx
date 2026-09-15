// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionRender } from "@/test/framer-motion-mock";
import { DUR } from "@/lib/motion";
import { ShellSidebar, type ShellSidebarProps } from "./sidebar";

const harness = { reduce: false };
const renders: MotionRender[] = [];

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => harness.reduce,
    onRender: (render) => {
      renders.push(render);
    },
  });
});

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
    onNewTask: vi.fn(),
    onNewMessage: vi.fn(),
    onNavigateNotification: vi.fn(),
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

/** The framer props the count chip rendered with, off the stub's record. */
function countRender(): MotionRender | undefined {
  return renders.findLast((render) =>
    String(render.props.className ?? "").includes("tree-row-count"),
  );
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
    harness.reduce = false;
    renders.length = 0;
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

  it("calls the daily-page row Journal, so Today means one thing in this panel", async () => {
    // Tasks has a list called Today, and the row above it opened a page also
    // called "Today thoughts". Two rows, one word, two destinations. The row
    // keeps its `sun` and its page: only the label moved.
    await render();

    const journal = navRow("Journal");
    expect(journal).not.toBeNull();
    expect(navRow("Today thoughts")).toBeNull();

    const onOpenDailyPage = vi.fn();
    await render({ onOpenDailyPage });
    await act(async () => navRow("Journal")?.click());
    expect(onOpenDailyPage).toHaveBeenCalledTimes(1);
  });

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

  it("crossfades the count when it changes, the way a group header's count does", async () => {
    // A completion decrements this number while the reader is looking at
    // Mail or a note, which is the whole reason the chip exists. The group
    // header in the Tasks column crossfades its own count at DUR.fast, and
    // one number changing in two places should not change in two ways.
    await render({ tasksOpenTodayCount: 3 });
    const chip = countRender();
    expect(chip?.motion.initial).toEqual({ opacity: 0 });
    expect(chip?.motion.animate).toEqual({ opacity: 1 });
    expect(chip?.motion.exit).toEqual({
      opacity: 0,
      transition: { duration: DUR.fast },
    });
    expect(chip?.motion.transition).toEqual({ duration: DUR.fast });
    expect(navRow("Tasks")?.querySelector(".tree-row-count")?.textContent).toBe("3");
  });

  it("collapses that crossfade under reduced motion", async () => {
    harness.reduce = true;
    await render({ tasksOpenTodayCount: 3 });

    const chip = countRender();
    expect(chip?.motion.transition).toEqual({ duration: 0 });
    expect(chip?.motion.exit).toEqual({ opacity: 0, transition: { duration: 0 } });
  });

  it("keeps the count and the update dot on their own rows", async () => {
    await render({ tasksOpenTodayCount: 2 });

    // The two marks belong to two rows and no row is ever handed both, so
    // the precedence inside `NavRow` is unreachable rather than untested:
    // what is worth holding is WHICH row wears which mark.
    const dot = document.querySelector('[aria-label="Update available"]');
    expect(dot?.closest("button.tree-row")?.textContent).toContain("Settings");
    const count = document.querySelector(".tree-row-count");
    expect(count?.closest("button.tree-row")?.textContent).toContain("Tasks");
  });
});

// THE HEAD OF THE PANEL: a wordmark and a pair of controls.
//
// The pair is the point. The bell was a 28 capsule standing 4px from a 34
// circle, so two controls that do the same KIND of thing were drawn at two
// sizes with no air between them and read as one lopsided object, and the
// smaller of the two was the one carrying a number. Both are 34 now, the air
// is 12, and the count comes inside the bell's own box rather than hanging out
// of it into that air.

const CSS = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");

/** One CSS rule's body, by its exact selector line. */
function cssRule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  const start = CSS.indexOf("{", at);
  return CSS.slice(start + 1, CSS.indexOf("}", start));
}

describe("ShellSidebar head", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    harness.reduce = false;
    renders.length = 0;
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
        json: async () => ({ notifications: [], unread: 0 }),
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
    await act(async () => {
      await Promise.resolve();
    });
  }

  const head = () => document.querySelector<HTMLElement>(".brain-sidebar-head")!;
  const bell = () => head().querySelector<HTMLButtonElement>('[aria-label^="Notifications"]')!;
  const plus = () => head().querySelector<HTMLButtonElement>('[aria-label="New"]')!;

  it("draws the bell and the plus at one size", async () => {
    await render();

    // the plus is `.btn-accent`, which globals.css sizes at 34
    expect(plus().classList.contains("btn-accent")).toBe(true);
    expect(cssRule(".btn-accent")).toContain("width: 34px");

    // the bell is the same family at the same size, and takes it from the
    // atom rather than from a class written once at this call site
    expect(bell().classList.contains("icon-btn")).toBe(true);
    expect(bell().dataset.size).toBe("34");
    expect(cssRule('.icon-btn[data-size="34"]')).toContain("width: 34px");
    expect(cssRule('.icon-btn[data-size="34"]')).toContain("height: 34px");
  });

  it("puts twelve of air between them", async () => {
    await render();

    const pair = bell().parentElement!;
    expect(pair).toBe(plus().parentElement);
    // Tailwind's gap-3 is 0.75rem, which is 12 at the root size
    expect(pair.className.split(/\s+/)).toContain("gap-3");
    expect(pair.className.split(/\s+/)).not.toContain("gap-1");
  });

  it("keeps the 36 row, with room to spare", async () => {
    await render();

    // 280 sidebar − 24 panel padding − 6 head padding = 250 for the line. The
    // pair takes 34 + 12 + 34 = 80 and the wordmark's box measures 82 at 1440
    // (6 + 18 + 8 + "Brain" at H3 + 6), so 88 is spare and the wordmark is the
    // only thing here that can grow.
    expect(cssRule(".brain-sidebar-head")).toContain("height: 36px");
    expect(head().querySelector(".brain-wordmark")).not.toBeNull();
  });

  it("brings the count inside the bell's own box", async () => {
    const badge = cssRule(".brain-bell-badge");
    // At 28 the badge hung 3px out of the control on both sides to clear the
    // crown. The 34 box IS that hang, so the corner is the box's own corner
    // and the clearance measured on the 28 is unchanged.
    expect(badge).toMatch(/\btop: 0;/);
    expect(badge).toMatch(/\bright: 0;/);
    expect(badge).not.toContain("-3px");
    // the paper ring that keeps two ink shapes two, and the press target
    expect(badge).toContain("box-shadow: 0 0 0 2px var(--paper)");
    expect(badge).toContain("pointer-events: none");
  });

  it("names the plus for the menu it opens, and draws none on Settings", async () => {
    await render();
    expect(plus().getAttribute("aria-label")).toBe("New");
    expect(plus().getAttribute("aria-haspopup")).toBe("menu");

    await render({ surface: "settings", settingsSection: "appearance" });
    expect(head().querySelector('[aria-label="New"]')).toBeNull();
    // the bell stands there: a reminder fires whatever surface is open
    expect(head().querySelector('[aria-label^="Notifications"]')).not.toBeNull();
  });
});