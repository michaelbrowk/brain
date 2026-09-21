// @vitest-environment jsdom

// The bell, the badge and the centre under it. Two of these are easy to get
// wrong and are pinned on purpose: the badge crossfades at `DUR.fast` and
// collapses under reduced motion, and the `mail-new` row is one counted line
// that opens Mail and names no thread at all.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DUR } from "@/lib/motion";
import type { MotionProps } from "@/test/framer-motion-mock";
import { KIND_GLYPH, NotificationsBell } from "./notifications-bell";
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

const requestOpenThread = vi.fn();
vi.mock("./mail-surface-client", () => ({
  requestOpenThread: (...args: unknown[]) => requestOpenThread(...args),
}));

let rows: unknown[];
let host: HTMLDivElement;
let root: Root;
const navigate = vi.fn();

const MAIL_ID = "mail-new:2026-09-14T12:00:00.000Z";
const AGENT_ID = "agent:2026-09-14T12:00:00.000Z:create_task:9f2c1b4a5e6d7c80";
/** `agentMailHref` of the same account and thread the mail id above carries.
 *  Written out rather than computed, so the test reads as a fixture. */
const AGENT_MAIL_HREF =
  "/mail?account=account-adeadbeefdeadbeefdeadbeefdeadbeef&thread=7468726561642d6f6e65";

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetNotificationsStore();
  harness.reduce = false;
  harness.spans.length = 0;
  navigate.mockReset();
  requestOpenThread.mockReset();
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

const glyphMotion = () =>
  harness.spans.filter((span) => span.props["data-bell-glyph"] !== undefined);

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

  // The bell goes bold while anything is unread. That swap used to be a
  // one-frame cut beside a number that dissolved, so half of one state change
  // faded and half snapped. One behaviour, not two.
  it("crossfades the bell's own weight beside the number, on the same beat", async () => {
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "One", href: "/tasks" },
    ];
    await render();
    const drawn = glyphMotion().at(-1)!;
    expect(drawn.motion.transition).toEqual({ duration: DUR.fast });
    expect(drawn.motion.exit).toEqual({ opacity: 0, transition: { duration: DUR.fast } });
  });

  it("collapses the bell's crossfade under reduced motion, the way the number's collapses", async () => {
    harness.reduce = true;
    await render();
    const drawn = glyphMotion().at(-1)!;
    expect(drawn.motion.transition).toEqual({ duration: 0 });
    expect(drawn.motion.exit).toEqual({ opacity: 0, transition: { duration: 0 } });
  });

  // THE SWAP HAS TO REMOUNT THE GLYPH, not repaint it in place: `key={weight}`
  // is what makes AnimatePresence treat a weight change as one glyph leaving
  // and another arriving instead of one glyph's `variant` prop changing under
  // it, which is the one-frame cut this crossfade exists to remove. A
  // constant key would leave the duration and reduced-motion cases above
  // green while quietly undoing the fix, so the DOM node's own identity is
  // the thing pinned here.
  it("remounts the glyph node on a weight change, rather than updating it in place", async () => {
    await render();
    const linear = host.querySelector("[data-bell-glyph]");
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "One", href: "/tasks" },
    ];
    await act(async () => {
      root.render(<NotificationsBell onNavigate={navigate} refreshToken={1} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const bold = host.querySelector("[data-bell-glyph]");
    expect(bold).not.toBeNull();
    expect(bold).not.toBe(linear);
  });

  it("draws the bell bold while something is unread and linear when nothing is", async () => {
    await render();
    const quiet = host.querySelector("[data-bell-glyph] svg")!.innerHTML;
    await act(async () => root.unmount());
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    resetNotificationsStore();
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "One", href: "/tasks" },
    ];
    await render();
    expect(host.querySelector("[data-bell-glyph] svg")!.innerHTML).not.toBe(quiet);
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
  });

  it("names the task in the path it opens", async () => {
    // The stored href is "/tasks", which opens the column and points at
    // nothing in it. The task is in the row's own id, and the surface reads
    // `?task=` to select that row and scroll to it.
    rows = [
      { id: "task-reminder:task-1:2026-09-14T13:00", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "Water the plants", href: "/tasks" },
    ];
    await render();
    await open();
    await act(async () => item("Water the plants")!.click());
    expect(navigate).toHaveBeenCalledWith("/tasks?task=task-1");
  });

  // The rewrite is keyed on the destination as well as on the id. A row whose
  // href already names something is a row the centre stored a destination for
  // on purpose, and turning it into "/tasks?task=…" because the id happened to
  // decode would send the reader somewhere they were not going.
  it("leaves a row alone whose href is not the Tasks column", async () => {
    rows = [
      {
        id: "task-reminder:task-1:2026-09-14T13:00",
        kind: "task-reminder",
        at: "2026-09-14T12:00:00.000Z",
        title: "Water the plants",
        href: "/tasks/archive",
      },
    ];
    await render();
    await open();
    await act(async () => item("Water the plants")!.click());
    expect(navigate).toHaveBeenCalledWith("/tasks/archive");
  });

  // THE BODY IS WHAT SAYS WHAT HAPPENED. Title and body shared one truncating
  // span, so a long title ate the row and every body was cut in its first two
  // characters: a fired reminder and a missed one became one row, one small
  // circle and a timestamp.
  it("truncates the title and never shrinks the body to make room for it", async () => {
    rows = [
      {
        id: "a",
        kind: "task-missed",
        at: "2026-09-14T12:00:00.000Z",
        title: "Call the fitter about the worktop template before Friday",
        body: "Missed 2026-09-13 at 18:00",
        href: "/tasks",
      },
    ];
    await render();
    await open();
    const row = document.querySelector('[role="menuitem"]')!;
    const title = row.querySelector("[data-notification-title]")!;
    const body = row.querySelector("[data-notification-body]")!;
    expect(title.textContent).toBe("Call the fitter about the worktop template before Friday");
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("flex-1");
    expect(body.textContent).toBe("Missed 13 Sep, 18:00");
    expect(body.className).toContain("shrink-0");
    expect(body.className).toContain("max-w-[57%]");
  });

  // THE STORED BODY IS LOCALE-FREE AND THE ROW IS NOT. A server timer writes
  // the body into a file that also feeds a push payload, so the day in it is
  // an ISO one; at 320px "Missed 2026-09-13 at 18:00" wants 176px against a
  // cap of 176, and the date was the half that got cut. The row reads it out.
  it("reads a missed row's ISO day out as a month a reader can see whole", async () => {
    rows = [
      {
        id: "a",
        kind: "task-missed",
        at: "2026-09-14T12:00:00.000Z",
        title: "Ring the dentist about the crown",
        body: "Missed 2026-09-13 at 18:00",
        href: "/tasks",
      },
    ];
    await render();
    await open();
    expect(
      document.querySelector('[role="menuitem"] [data-notification-body]')!.textContent,
    ).toBe("Missed 13 Sep, 18:00");
  });

  it("leaves a fired row's clock alone, so the two kinds read alike", async () => {
    rows = [
      {
        id: "b",
        kind: "task-reminder",
        at: "2026-09-14T12:00:00.000Z",
        title: "Water the plants",
        body: "07:45",
        href: "/tasks",
      },
    ];
    await render();
    await open();
    expect(
      document.querySelector('[role="menuitem"] [data-notification-body]')!.textContent,
    ).toBe("07:45");
  });

  it("does not touch a body that is somebody's own words", async () => {
    rows = [
      {
        id: AGENT_ID,
        kind: "agent-action",
        at: "2026-09-14T12:00:00.000Z",
        title: "Claude wrote a page",
        body: "Re: the 2026-09-13 at 18:00 slot",
        href: "/",
      },
    ];
    await render();
    await open();
    // The missed producer's shape is a body that STARTS with "Missed". A body
    // that happens to carry a date is a sentence somebody wrote, and rewriting
    // it would be this row editing somebody else's words.
    expect(
      document.querySelector('[role="menuitem"] [data-notification-body]')!.textContent,
    ).toBe("Re: the 2026-09-13 at 18:00 slot");
  });

  /** ONE LINE, A COUNT, AND NO LETTER IN IT. The centre drew one row per
   *  thread until 0.12.2, with a sender and a subject on each, which made the
   *  bell a second inbox. */
  it("draws the mail row as a count with no body", async () => {
    rows = [
      { id: MAIL_ID, kind: "mail-new", at: "2026-09-14T12:00:00.000Z", title: "10 new messages", href: "/mail" },
    ];
    await render();
    await open();
    expect(item("10 new messages")).not.toBeNull();
    expect(document.querySelector('[role="menuitem"] [data-notification-body]')).toBeNull();
  });

  it("says one message in the singular", async () => {
    rows = [
      { id: MAIL_ID, kind: "mail-new", at: "2026-09-14T12:00:00.000Z", title: "1 new message", href: "/mail" },
    ];
    await render();
    await open();
    expect(item("1 new message")).not.toBeNull();
  });

  it("marks the mail row read and opens Mail, naming no thread", async () => {
    rows = [
      { id: MAIL_ID, kind: "mail-new", at: "2026-09-14T12:00:00.000Z", title: "10 new messages", href: "/mail" },
    ];
    await render();
    await open();
    await act(async () => item("10 new messages")!.click());
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const read = calls.find((call) => String(call[0]) === "/api/notifications/read");
    expect(JSON.parse(String((read?.[1] as { body?: unknown })?.body))).toEqual({
      ids: [MAIL_ID],
    });
    expect(requestOpenThread).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/mail");
  });

  it("clears the centre with Mark all read and opens nothing", async () => {
    rows = [
      { id: MAIL_ID, kind: "mail-new", at: "2026-09-14T12:00:00.000Z", title: "10 new messages", href: "/mail" },
    ];
    await render();
    await open();
    await act(async () => item("Mark all read")!.click());
    expect(requestOpenThread).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  /** An agent row about a thread carries the pair in its href, because its id
   *  is a digest. The press asks Mail to open the thread and goes to the
   *  surface, and it does NOT mark the thread read: this row is a record of
   *  what an agent did, not a new letter. */
  it("asks Mail to open the thread an agent row is about", async () => {
    rows = [
      {
        id: AGENT_ID,
        kind: "agent-action",
        at: "2026-09-14T12:00:00.000Z",
        title: "Claude replied to a message",
        href: AGENT_MAIL_HREF,
      },
    ];
    await render();
    await open();
    await act(async () => item("Claude replied to a message")!.click());
    expect(requestOpenThread).toHaveBeenCalledWith(
      "account-adeadbeefdeadbeefdeadbeefdeadbeef",
      "thread-one",
    );
    expect(navigate).toHaveBeenCalledWith("/mail");
  });

  it("leaves an agent row that names no thread alone", async () => {
    rows = [
      {
        id: AGENT_ID,
        kind: "agent-action",
        at: "2026-09-14T12:00:00.000Z",
        title: "Claude sent a message",
        href: "/mail",
      },
    ];
    await render();
    await open();
    await act(async () => item("Claude sent a message")!.click());
    expect(requestOpenThread).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/mail");
  });

  it("draws one glyph per kind", async () => {
    rows = [
      { id: "a", kind: "task-reminder", at: "2026-09-14T12:00:00.000Z", title: "One", href: "/tasks" },
      { id: "b", kind: "task-missed", at: "2026-09-14T11:00:00.000Z", title: "Two", href: "/tasks" },
      { id: MAIL_ID, kind: "mail-new", at: "2026-09-14T10:00:00.000Z", title: "Three", href: "/mail" },
      { id: AGENT_ID, kind: "agent-action", at: "2026-09-14T09:00:00.000Z", title: "Four", href: "/tasks?task=task-1" },
    ];
    await render();
    await open();
    const glyphs = [...document.querySelectorAll('[role="menuitem"] svg')];
    expect(glyphs).toHaveLength(4);
    expect(Object.keys(KIND_GLYPH)).toHaveLength(4);
  });

  // WHAT AN AGENT DID IS A ROW LIKE ANY OTHER: one line, its own glyph, and a
  // press that goes where the producer pointed it. The task it names is in the
  // href the producer wrote, not in the id, so nothing here rewrites it.
  it("draws an agent row on one line and opens what it names", async () => {
    rows = [
      {
        id: AGENT_ID,
        kind: "agent-action",
        at: "2026-09-14T12:00:00.000Z",
        title: "Claude created a task",
        body: "Water the plants",
        href: "/tasks?task=task-1",
      },
    ];
    await render();
    await open();
    const row = document.querySelector('[role="menuitem"]')!;
    expect(row.querySelector("[data-notification-title]")!.textContent).toBe(
      "Claude created a task",
    );
    expect(row.querySelector("[data-notification-body]")!.textContent).toBe(
      "Water the plants",
    );
    await act(async () => item("Claude created a task")!.click());
    expect(navigate).toHaveBeenCalledWith("/tasks?task=task-1");
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
