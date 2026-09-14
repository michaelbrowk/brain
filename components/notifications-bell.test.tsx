// @vitest-environment jsdom

// The bell, the badge and the centre under it. Two of these are easy to get
// wrong and are pinned on purpose: the badge crossfades at `DUR.fast` and
// collapses under reduced motion, and opening a `mail-new` row marks its
// thread read without waiting for the mail service to answer.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DUR } from "@/lib/motion";
import type { MotionProps } from "@/test/framer-motion-mock";
import { NotificationsBell } from "./notifications-bell";
import { resetNotificationsStore } from "./notifications-client";

const harness = {
  reduce: false,
  spans: [] as { motion: MotionProps; props: Record<string, unknown> }[],
};

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => harness.reduce,
    onRender: ({ tag, motion, props }) => {
      if (tag === "span") harness.spans.push({ motion, props });
    },
  });
});

const updateThread = vi.fn(async () => undefined);
vi.mock("./mail-surface-client", () => ({
  defaultMailSurfaceClient: {
    updateThread: (...args: unknown[]) =>
      (updateThread as unknown as (...a: unknown[]) => Promise<undefined>)(...args),
  },
}));

let rows: unknown[];
let host: HTMLDivElement;
let root: Root;
const navigate = vi.fn();

const MAIL_ID = "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d6f6e65";

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetNotificationsStore();
  harness.reduce = false;
  harness.spans.length = 0;
  navigate.mockReset();
  updateThread.mockReset();
  updateThread.mockResolvedValue(undefined);
  rows = [];
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
            unread: rows.filter((r) => (r as { readAt?: string }).readAt === undefined).length,
          }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ read: 1 }) } as Response;
    }),
  );
  // Radix's popper measures its content and captures the pointer; jsdom ships
  // neither. The same four stubs `page-actions-ui.test.tsx` puts up.
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
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<NotificationsBell onNavigate={navigate} />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const bell = () => host.querySelector<HTMLButtonElement>('[aria-label^="Notifications"]');

/** Radix opens a dropdown on `pointerdown`, not on `click`, so a bare
 *  `.click()` here would assert against a menu that never opened. */
const open = async () => {
  await act(async () => {
    bell()!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
};

const item = (name: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
    (node.textContent ?? "").includes(name),
  ) as HTMLElement | undefined;

const badge = () => host.querySelector(".brain-bell-badge");

const badgeMotion = () =>
  harness.spans.filter((span) =>
    String(span.props.className ?? "").includes("brain-bell-badge"),
  );

describe("the bell", () => {
  it("is drawn with nothing unread, and says so", async () => {
    await render();
    expect(bell()!.getAttribute("aria-label")).toBe("Notifications");
    expect(badge()).toBeNull();
  });

  it("carries the count when something is unread", async () => {
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "Water the plants", href: "/tasks" },
      { id: "b", kind: "task-missed", at: "2026-09-13T12:00:00.000Z", title: "Call the bank", href: "/tasks" },
    ];
    await render();
    expect(bell()!.getAttribute("aria-label")).toBe("Notifications, 2 unread");
    expect(badge()!.textContent).toBe("2");
  });

  it("draws no number past ninety-nine", async () => {
    rows = Array.from({ length: 120 }, (_, index) => ({
      id: `row-${index}`,
      kind: "task-reminder",
      at: "2026-09-14T12:00:00.000Z",
      title: "Water the plants",
      href: "/tasks",
    }));
    await render();
    expect(badge()!.textContent).toBe("99+");
  });

  it("crossfades the number at DUR.fast, keyed on the number itself", async () => {
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "One", href: "/tasks" },
    ];
    await render();
    const drawn = badgeMotion().at(-1)!;
    expect(drawn.motion.transition).toEqual({ duration: DUR.fast });
    expect(drawn.motion.exit).toEqual({ opacity: 0, transition: { duration: DUR.fast } });
  });

  it("collapses that crossfade under reduced motion", async () => {
    harness.reduce = true;
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "One", href: "/tasks" },
    ];
    await render();
    const drawn = badgeMotion().at(-1)!;
    expect(drawn.motion.transition).toEqual({ duration: 0 });
    expect(drawn.motion.exit).toEqual({ opacity: 0, transition: { duration: 0 } });
  });

  it("says the centre is empty rather than drawing an empty list", async () => {
    await render();
    await open();
    expect(document.body.textContent).toContain("Nothing waiting");
  });

  it("opens a task row at its href and marks it read", async () => {
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "Water the plants", body: "13:00", href: "/tasks" },
    ];
    await render();
    await open();
    await act(async () => item("Water the plants")!.click());
    expect(navigate).toHaveBeenCalledWith("/tasks");
    expect(updateThread).not.toHaveBeenCalled();
  });

  it("marks a mail row's thread read before it opens Mail", async () => {
    rows = [
      { id: MAIL_ID, kind: "mail-new", at: "2026-09-14T12:00:00.000Z", title: "Ana Silva", body: "Lunch on Friday", href: "/mail" },
    ];
    await render();
    await open();
    await act(async () => item("Ana Silva")!.click());
    expect(updateThread).toHaveBeenCalledWith({
      accountId: "account-adeadbeefdeadbeefdeadbeefdeadbeef",
      threadId: "thread-one",
      read: true,
    });
    expect(navigate).toHaveBeenCalledWith("/mail");
  });

  it("still opens Mail when the thread mutation fails", async () => {
    updateThread.mockRejectedValue(new Error("mail_service_unavailable"));
    rows = [
      { id: MAIL_ID, kind: "mail-new", at: "2026-09-14T12:00:00.000Z", title: "Ana Silva", href: "/mail" },
    ];
    await render();
    await open();
    await act(async () => item("Ana Silva")!.click());
    expect(navigate).toHaveBeenCalledWith("/mail");
  });

  it("clears the centre with Mark all read and touches no mailbox", async () => {
    rows = [
      { id: MAIL_ID, kind: "mail-new", at: "2026-09-14T12:00:00.000Z", title: "Ana Silva", href: "/mail" },
    ];
    await render();
    await open();
    await act(async () => item("Mark all read")!.click());
    expect(updateThread).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("draws one glyph per kind", async () => {
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "One", href: "/tasks" },
      { id: "b", kind: "task-missed", at: "2026-09-14T11:00:00.000Z", title: "Two", href: "/tasks" },
      { id: MAIL_ID, kind: "mail-new", at: "2026-09-14T10:00:00.000Z", title: "Three", href: "/mail" },
    ];
    await render();
    await open();
    const glyphs = [...document.querySelectorAll('[role="menuitem"] svg')];
    expect(glyphs).toHaveLength(3);
  });

  it("marks a read row apart from an unread one", async () => {
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "One", href: "/tasks" },
      { id: "b", kind: "task-reminder", at: "2026-09-14T11:00:00.000Z", title: "Two", href: "/tasks", readAt: "2026-09-14T11:30:00.000Z" },
    ];
    await render();
    await open();
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items[0].hasAttribute("data-unread")).toBe(true);
    expect(items[1].hasAttribute("data-unread")).toBe(false);
  });
});
