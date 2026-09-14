// @vitest-environment jsdom

// HOME'S FIRST ROW ON A PHONE. The six tab slots are full, so a phone has no
// bell: these rows are the only way into the centre there, which is why the
// gates around them are each held by a case here. The block draws nothing at
// all when nothing is unread, nothing at desktop widths where the bell is two
// hundred pixels away in the sidebar head, and at most three rows when there
// is something waiting.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HubNotifications } from "./hub-notifications";
import { resetNotificationsStore } from "./notifications-client";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

vi.mock("@/lib/client", () => ({
  apiFetch: (...args: unknown[]) => (globalThis.fetch as typeof fetch)(...(args as [RequestInfo])),
  CLIENT_ID: "test-client",
}));

const MAIL_ID = "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d6f6e65";

let rows: unknown[];
let host: HTMLDivElement;
let root: Root;
const navigate = vi.fn();

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "task-reminder",
    at: "2026-09-14T12:00:00.000Z",
    title: `Task ${id}`,
    href: "/tasks",
    ...over,
  };
}

/** The phone question the block asks, answered here rather than by a real
 *  viewport. `false` is the desktop, where the sidebar's bell draws instead. */
function stubWidth(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query === "(max-width: 767px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetNotificationsStore();
  navigate.mockReset();
  rows = [];
  stubWidth(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/notifications") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            notifications: rows,
            unread: rows.filter((item) => (item as { readAt?: string }).readAt === undefined)
              .length,
          }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ read: 1 }) } as Response;
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetNotificationsStore();
  vi.unstubAllGlobals();
});

async function render(refreshToken = 0) {
  await act(async () =>
    root.render(<HubNotifications onNavigate={navigate} refreshToken={refreshToken} />),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function drawn(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-hub-notification-row]")];
}

describe("the centre on Home", () => {
  it("draws nothing while nothing is unread", async () => {
    rows = [row("a", { readAt: "2026-09-14T12:05:00.000Z" })];
    await render();
    expect(host.querySelector("[data-hub-notifications]")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("draws the unread rows, freshest first and three at most", async () => {
    rows = [row("a"), row("b"), row("c"), row("d")];
    await render();
    expect(drawn()).toHaveLength(3);
    expect(drawn()[0].textContent).toContain("Task a");
    expect(host.textContent).not.toContain("Task d");
  });

  it("carries the kind's glyph and the row's body", async () => {
    rows = [row(MAIL_ID, { kind: "mail-new", title: "Ana Silva", body: "Lunch on Friday", href: "/mail" })];
    await render();
    const only = drawn()[0];
    expect(only.textContent).toContain("Ana Silva");
    expect(only.textContent).toContain("Lunch on Friday");
    expect(only.querySelector("svg")).not.toBeNull();
  });

  it("opens the place a pressed row came from", async () => {
    rows = [row("a", { href: "/tasks" })];
    await render();
    await act(async () => drawn()[0].click());
    expect(navigate).toHaveBeenCalledWith("/tasks");
  });

  it("draws nothing at desktop widths, where the bell is", async () => {
    // `md:hidden` is a CSS rule, so without a mount gate the same three rows
    // stand in the document twice at 1440 — once here and once in the open
    // menu — and an unscoped query resolves to two of everything.
    stubWidth(false);
    rows = [row("a")];
    await render();
    expect(drawn()).toHaveLength(0);
  });

  it("re-asks the centre when a notification event bumps its token", async () => {
    rows = [row("a")];
    await render();
    expect(drawn()).toHaveLength(1);

    // What the shell does with the store's `notification` event: one number,
    // read by the bell and by these rows alike.
    rows = [row("a"), row("b")];
    await render(1);
    expect(drawn()).toHaveLength(2);
  });
});
