// @vitest-environment jsdom

// Shell DOM contract.
//
// Renders <Shell> in jsdom in six states with the heavy children (Milkdown,
// MailSurface) stubbed, normalises the resulting markup and compares it with
// the files in test/__contracts__/. The point is a mechanical refactor of
// shell.tsx (S1–S5 in the glass-migration plan) proving "zero DOM diff":
// a slice moved into components/shell/*.tsx must render byte-identical
// markup in every state.
//
//   SHELL_DOM_CONTRACT=write pnpm exec vitest run components/shell-dom-contract.test.tsx
//
// rewrites the baseline. A restyle PR that changes the shell on purpose
// regenerates it the same way and commits the result. scripts/shell-dom-diff.mjs
// runs write mode on a base ref and on the head and diffs the two outputs.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { Shell, type ShellInitialPage } from "./shell";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

// Both code-split children are stubbed by what their loader imports: the
// editor host and the mail surface stay in the contract as named slots.
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    const source = String(loader);
    if (source.includes("mail-surface")) {
      return function FakeMailSurface() {
        return <div data-testid="fake-mail-surface" />;
      };
    }
    return function FakeEditor(props: { value: string }) {
      return <div data-testid="fake-editor">{props.value}</div>;
    };
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const CONTRACT_DIR =
  process.env.SHELL_DOM_CONTRACT_DIR ??
  path.join(process.cwd(), "test", "__contracts__");
const WRITE = process.env.SHELL_DOM_CONTRACT === "write";

const NOW = new Date("2026-08-20T10:00:00.000Z");
const STAMP = "2026-08-01T08:00:00.000Z";

function node(
  id: string,
  title: string,
  extra: Partial<TreeNode> = {},
  children: TreeNode[] = [],
  parentId: string | null = null,
): TreeNode {
  return {
    id,
    parentId,
    title,
    order: id,
    created: STAMP,
    updated: STAMP,
    hasChildren: children.length > 0,
    children,
    ...extra,
  };
}

function fixtureTree(): TreeNode[] {
  const notes = node("notes", "Project notes", { icon: "🗒️" }, [], "work");
  return [
    node("work", "Work", { pinned: true, icon: "📘", cover: "grad:2" }, [notes]),
    node("personal", "Personal", { category: "Life" }),
    node("reading", "Reading list", { tags: ["books"] }),
  ];
}

function pageBody(id: string): ShellInitialPage {
  const entry = fixtureTree().find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`fixture page missing: ${id}`);
  return {
    id,
    meta: {
      title: entry.title,
      icon: entry.icon,
      cover: entry.cover,
      stickers: [],
    },
    markdown: `# ${entry.title}\n\nBody of ${entry.title}.`,
    rev: `rev-${id}`,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Stable EventSource double: Shell opens one per mount for live sync. */
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
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

/** React `useId` / Radix ids follow tree position, not markup — a slice
 *  moved into its own component shifts them. dnd-kit numbers its live
 *  regions per mount. `<time title>` is the locale rendering of a fixed
 *  instant and differs per machine. All three are masked. */
function normalise(html: string) {
  return (
    html
      .replace(/_r_[0-9a-z]+_/g, "_r_id_")
      .replace(/«[^»]*»/g, "«id»")
      .replace(/:r[0-9a-z]+:/g, ":id:")
      .replace(/(Dnd[A-Za-z]+-)\d+/g, "$1n")
      .replace(/(<time\b[^>]*\btitle=")[^"]*(")/g, "$1«locale»$2")
      .replace(/\s+/g, " ")
      .replace(/> </g, "><")
      .replace(/></g, ">\n<")
      .trim() + "\n"
  );
}

type StateName =
  | "hub"
  | "page-cover"
  | "mail"
  | "focus-mode"
  | "mobile-viewport"
  | "mobile-pages-open";

interface StateSetup {
  url: string;
  mobile?: boolean;
  focusMode?: boolean;
  props: Parameters<typeof Shell>[0];
  /** Interaction after mount that moves the shell into the state. */
  after?: (host: HTMLElement) => Promise<void>;
}

const STATES: Record<StateName, () => StateSetup> = {
  hub: () => ({
    url: "/",
    props: { tree: fixtureTree(), initialSelectedId: null },
  }),
  "page-cover": () => ({
    url: "/p/work",
    props: {
      tree: fixtureTree(),
      initialSelectedId: "work",
      initialPage: pageBody("work"),
    },
  }),
  mail: () => ({
    url: "/mail",
    props: {
      tree: fixtureTree(),
      initialSelectedId: null,
      initialSurface: "mail",
    },
  }),
  "focus-mode": () => ({
    url: "/p/personal",
    focusMode: true,
    props: {
      tree: fixtureTree(),
      initialSelectedId: "personal",
      initialPage: pageBody("personal"),
    },
  }),
  "mobile-viewport": () => ({
    url: "/",
    mobile: true,
    props: { tree: fixtureTree(), initialSelectedId: null },
  }),
  "mobile-pages-open": () => ({
    url: "/",
    mobile: true,
    props: { tree: fixtureTree(), initialSelectedId: null },
    after: async (host) => {
      const pages = host.querySelector<HTMLButtonElement>(
        '[data-mobile-tab="pages"]',
      );
      if (!pages) throw new Error("mobile Pages tab not rendered");
      await act(async () => pages.click());
    },
  }),
};

describe("Shell DOM contract", () => {
  let host: HTMLDivElement;
  let root: Root;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ now: NOW });
    localStorage.clear();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/tree") return response({ tree: fixtureTree() });
      const page = /^\/api\/page\/([^/?]+)$/.exec(url);
      if (page) return response(pageBody(page[1]));
      throw new Error(`unexpected request in DOM contract: ${url}`);
    });

    rafCallbacks = new Map();
    nextFrame = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrame++;
        rafCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => rafCallbacks.delete(id)),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("PointerEvent", MouseEvent);
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubViewport(mobile: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches:
          (mobile && query === "(max-width: 767px)") ||
          query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function flushAnimationFrames() {
    while (rafCallbacks.size) {
      const callbacks = [...rafCallbacks.values()];
      rafCallbacks.clear();
      await act(async () => {
        callbacks.forEach((callback) => callback(0));
      });
      await settle();
    }
  }

  async function render(name: StateName) {
    const setup = STATES[name]();
    stubViewport(setup.mobile ?? false);
    if (setup.focusMode) localStorage.setItem("brain-focus", "true");
    window.history.replaceState({}, "", setup.url);

    await act(async () => root.render(<Shell {...setup.props} />));
    await flushAnimationFrames();
    await settle();
    await setup.after?.(host);
    await flushAnimationFrames();
    await settle();

    // Radix portals (dialogs, menus) mount on body, outside the host.
    return normalise(document.body.innerHTML);
  }

  function contractPath(name: StateName) {
    return path.join(CONTRACT_DIR, `shell-${name}.html`);
  }

  for (const name of Object.keys(STATES) as StateName[]) {
    it(`renders the ${name} state`, async () => {
      const html = await render(name);
      const file = contractPath(name);

      if (WRITE) {
        mkdirSync(CONTRACT_DIR, { recursive: true });
        writeFileSync(file, html);
        return;
      }

      expect(
        existsSync(file),
        `missing ${path.relative(process.cwd(), file)} — run SHELL_DOM_CONTRACT=write`,
      ).toBe(true);
      expect(html).toBe(readFileSync(file, "utf8"));
    });
  }
});
