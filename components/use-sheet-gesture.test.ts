// @vitest-environment jsdom

// THE PHONE-SHAPED QUESTION, AND THE GESTURE THAT ANSWERS IT.
//
// The hook is one media query, and the sheet it turns on is drawn by the
// panels that ask it. Two of them ask now (the mail composer and the When
// picker), so the query and the two thresholds are pinned here rather than in
// each panel's own file, where a second copy is how one of them ends up on a
// different breakpoint from the rest of the app.

import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MotionRender } from "@/test/framer-motion-mock";

const renders: MotionRender[] = [];

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => false,
    onRender: (render) => {
      renders.push(render);
    },
  });
});

/** `animate(value, to, transition)` from `framer-motion/dom`: the spring back
 *  to 0 the panel plays when a drag was short of both thresholds. */
const springBack = vi.fn<
  (value: unknown, to: number, transition: unknown) => { stop: () => void }
>(() => ({ stop: () => {} }));
vi.mock("framer-motion/dom", () => ({ animate: springBack }));

const { matchesSheet, useSheetGesture } = await import("./use-sheet-gesture");
const { TasksWhenPicker } = await import("./tasks-when-picker");
const { MailComposer } = await import("./mail-composer");
const { SHEET_DISMISS_OFFSET, SHEET_DISMISS_VELOCITY, SPRING_SHEET } = await import(
  "@/lib/motion"
);

const TODAY = "2026-09-13";

/** Every listener the hook registered, so a case can move the breakpoint
 *  under a mounted component the way a rotation does. */
const listeners: (() => void)[] = [];
/** Read through a getter, because the hook holds the MediaQueryList it was
 *  given and re-reads `matches` off it: a stub that froze the answer at
 *  construction could never change its mind. */
let sheet = false;

function stubMatchMedia(matches: boolean): void {
  sheet = matches;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return sheet;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, handler: () => void) => listeners.push(handler),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix's popper measures its content, and jsdom ships no ResizeObserver.
  (globalThis as typeof globalThis & { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  renders.length = 0;
  listeners.length = 0;
  sheet = false;
  springBack.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function Probe(): React.ReactNode {
  return createElement("output", null, String(useSheetGesture()));
}

describe("the breakpoint", () => {
  it("asks one query, and the same one every panel is drawn at", () => {
    const source = readFileSync(
      path.join(process.cwd(), "components/use-sheet-gesture.ts"),
      "utf8",
    );
    const queries = [...source.matchAll(/\(max-width:\s*(\d+)px\)/g)].map((hit) => hit[1]);
    expect(queries).toEqual(["767"]);
  });

  it("answers false where the platform cannot be asked", () => {
    // Server render, and the jsdom stubs that ship half of `matchMedia`. A
    // panel that guessed `true` here would enter as a sheet on a desktop.
    vi.stubGlobal("matchMedia", undefined);
    expect(matchesSheet()).toBe(false);
  });

  it("reads the query on the first render, so the entrance plays", async () => {
    stubMatchMedia(true);
    await act(async () => root.render(createElement(Probe)));
    expect(host.textContent).toBe("true");
  });

  it("follows the query when the window turns under it", async () => {
    stubMatchMedia(false);
    await act(async () => root.render(createElement(Probe)));
    expect(host.textContent).toBe("false");

    sheet = true;
    await act(async () => {
      for (const listener of listeners) listener();
    });
    expect(host.textContent).toBe("true");
  });
});

/** THE GRIP IS THE ONLY DRAG SURFACE, and what it does at the end of a drag
 *  is two numbers: past 120px of travel, or past 800px/s of velocity, the
 *  panel goes; short of both it springs back and stays open. The When picker
 *  is the surface this is measured on, because it is the one that opens under
 *  a row. */
describe("the sheet the When picker rides", () => {
  const openSheet = async () => {
    stubMatchMedia(true);
    await act(async () => {
      root.render(
        createElement(TasksWhenPicker, {
          value: { when: TODAY, evening: false, time: null },
          today: TODAY,
          onPick: () => {},
          ariaLabel: "When",
          trigger: createElement("button", { type: "button" }, "When"),
        }),
      );
    });
    await act(async () => {
      host
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  /** The panel framer is dragging: the one render that declared `drag: "y"`. */
  const dragEnd = () => {
    const panel = [...renders].reverse().find((render) => render.motion.drag === "y");
    return panel?.motion.onDragEnd as
      | ((event: unknown, info: { offset: { y: number }; velocity: { y: number } }) => void)
      | undefined;
  };

  it("draws the grip and hands it the drag, and nothing else", async () => {
    await openSheet();
    expect(document.querySelector(".brain-composer-grip")).not.toBeNull();
    expect(document.querySelector(".brain-menu.brain-when-sheet")).not.toBeNull();
    const panel = [...renders].reverse().find((render) => render.motion.drag === "y");
    expect(panel?.motion.dragListener).toBe(false);
    expect(panel?.motion.dragConstraints).toEqual({ top: 0 });
  });

  /** ONE OBJECT CARRIES THE MATERIAL AND THE SPRING. The sheet used to be a
   *  box INSIDE the popover's content, so the glass, the blur and the shadow
   *  stayed where they were while the box slid away: for the length of the
   *  exit an empty pane of the material sat over the list. What moves has to
   *  be what the reader sees. */
  it("puts the material on the element the spring moves", async () => {
    await openSheet();
    const panel = [...renders].reverse().find((render) => render.motion.drag === "y");
    const className = String(panel?.props.className ?? "");
    expect(className).toContain("brain-menu");
    expect(className).toContain("brain-when-sheet");
    expect(className).toContain("brain-when-panel");
    // And nothing else in the tree wears the material beside it.
    expect(document.querySelectorAll(".brain-menu.brain-when-sheet")).toHaveLength(1);
  });

  it("takes the panel away when the drag passes the offset", async () => {
    await openSheet();
    expect(document.querySelector(".brain-when-picker")).not.toBeNull();

    await act(async () => {
      dragEnd()?.(null, {
        offset: { y: SHEET_DISMISS_OFFSET + 1 },
        velocity: { y: 0 },
      });
    });

    expect(document.querySelector(".brain-when-picker")).toBeNull();
    // C3. IT CONTINUES OFF THE BOTTOM, it does not dissolve where it stands
    // and it does not spring back to nought. One object, one animation: the
    // material's own keyframes are off for the sheet form, so this spring is
    // the whole of the dismissal.
    expect(springBack).toHaveBeenCalledTimes(1);
    const [, to, transition] = springBack.mock.calls[0]!;
    expect(to).toBeGreaterThan(SHEET_DISMISS_OFFSET);
    expect(transition).toEqual(SPRING_SHEET);
  });

  it("takes it away on a flick that never travelled, at 800 px/s", async () => {
    await openSheet();
    await act(async () => {
      dragEnd()?.(null, { offset: { y: 8 }, velocity: { y: SHEET_DISMISS_VELOCITY + 1 } });
    });
    expect(document.querySelector(".brain-when-picker")).toBeNull();
  });

  it("expands under the row and scrolls inside the room there is", async () => {
    await openSheet();
    // FULL WIDTH UNDER THE ROW, on the material's own floor taken off, and a
    // grid that scrolls rather than running off the bottom edge with Done on
    // it. The height is the room Radix measured between the chip and the
    // window edge, which is a number only the browser has.
    const scroller = document.querySelector<HTMLElement>(".brain-when-scroll");
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain("edge-fade");
    expect(scroller?.className).toContain("overflow-y-auto");
    expect(scroller?.querySelector(".brain-when-picker")).not.toBeNull();

    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    const cap = /\.brain-when-scroll \{\s*max-height: ([^;]+);/.exec(css)?.[1];
    expect(cap).toContain("--radix-popover-content-available-height");
    // The grip's 26px and the floating tab bar both come off the room the grid
    // may take, so Done is never under either of them.
    expect(css).toMatch(
      /\.brain-when-sheet \.brain-when-scroll \{\s*max-height: calc\(\s*var\(--radix-popover-content-available-height, 100dvh\) - 38px -\s*var\(--tabbar-reserve, 0px\)\s*\);/,
    );
    // The edge is the atom's, so its 160ms is collapsed where every other
    // scroller's is rather than exempted here.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n  \.edge > i,\n  \.edge-fade \{\n    transition: none;/);
  });

  it("springs a short slow drag back and leaves the panel standing", async () => {
    await openSheet();

    await act(async () => {
      dragEnd()?.(null, {
        offset: { y: SHEET_DISMISS_OFFSET - 1 },
        velocity: { y: SHEET_DISMISS_VELOCITY - 1 },
      });
    });

    expect(document.querySelector(".brain-when-picker")).not.toBeNull();
    expect(springBack).toHaveBeenCalledTimes(1);
    // Back to where it started, on the gesture spring and not the entrance's.
    expect(springBack.mock.calls[0][1]).toBe(0);
  });
});

/** THE OTHER PANEL THAT ASKS THE QUESTION.
 *
 *  The hook was pulled out of the composer, and the picker's cases above
 *  measure it on the picker alone. A shared hook proves nothing about the two
 *  surfaces agreeing: the composer could stop asking it, or keep asking it and
 *  hand the grip different numbers, and every case above would stay green. So
 *  the composer states the same three facts here.
 */
describe("the sheet the mail composer rides", () => {
  const account = {
    accountId: "account-a",
    emailAddress: "owner@example.com",
    displayName: null,
    status: "connected",
    connectedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    capabilities: {
      mailboxes: ["inbox"],
      listThreads: true,
      sync: true,
      headerPreview: true,
      messageBodies: true,
      threadMutations: true,
      compose: true,
      send: true,
      reply: true,
    },
    providerKind: "gmail",
  } as const;

  const draft = {
    idempotencyKey: "key-one",
    mode: "compose",
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    text: "",
    replyToMessageId: null,
    notice: null,
  } as const;

  const cancelled = vi.fn();

  const openComposer = async (phone: boolean) => {
    cancelled.mockReset();
    stubMatchMedia(phone);
    await act(async () => {
      root.render(
        createElement(MailComposer, {
          account,
          initialDraft: draft,
          sending: false,
          sendError: null,
          sendBlocked: false,
          onCancel: cancelled,
          onDiscard: () => {},
          onDraftChange: () => {},
          onRetrySave: () => {},
          onSend: () => {},
        }),
      );
    });
  };

  /** The one render that declared `drag: "y"`, which is the sheet itself. */
  const panel = () => [...renders].reverse().find((render) => render.motion.drag === "y");

  it("draws the grip below the breakpoint and hands it the drag, and nothing else", async () => {
    await openComposer(true);
    expect(host.querySelector(".brain-composer-grip")).not.toBeNull();
    expect(panel()?.motion.dragListener).toBe(false);
    expect(panel()?.motion.dragConstraints).toEqual({ top: 0 });
  });

  it("is not a sheet above it, where the composer is a pane", async () => {
    await openComposer(false);
    expect(host.querySelector(".brain-composer-grip")).toBeNull();
    expect(panel()).toBeUndefined();
  });

  it("closes on the same two numbers the picker closes on", async () => {
    await openComposer(true);
    const dragEnded = panel()?.motion.onDragEnd as (
      event: unknown,
      info: { offset: { y: number }; velocity: { y: number } },
    ) => void;

    await act(async () => {
      dragEnded(null, { offset: { y: SHEET_DISMISS_OFFSET - 1 }, velocity: { y: 0 } });
    });
    expect(cancelled).not.toHaveBeenCalled();

    await act(async () => {
      dragEnded(null, { offset: { y: SHEET_DISMISS_OFFSET + 1 }, velocity: { y: 0 } });
    });
    expect(cancelled).toHaveBeenCalledTimes(1);

    await act(async () => {
      dragEnded(null, { offset: { y: 8 }, velocity: { y: SHEET_DISMISS_VELOCITY + 1 } });
    });
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
});
