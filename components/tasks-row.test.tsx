// @vitest-environment jsdom

// The row: what it draws, what it says in its tail, and the three gestures it
// answers: the press, the swipe and the expansion. The timings are read off
// the animations the row actually starts, so a keyframe that stopped matching
// the spec's ms table fails here rather than on somebody's phone.

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskView } from "@/lib/tasks/model";
import type { MotionRender } from "@/test/framer-motion-mock";

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

const pressAnimate = vi.fn(() => ({ stop: () => {} }));
vi.mock("framer-motion/dom", () => ({ animate: pressAnimate }));

const { TasksRow, foldRow } = await import("./tasks-row");
const { renderTaskCheckbox } = await import("./tasks-checkbox");

/** Every WAAPI animation the row starts, in order. */
interface Recorded {
  element: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
}
const animations: Recorded[] = [];

const TODAY = "2026-09-13";

function task(id: string, over: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: id,
    created: "2026-09-01T09:00:00.000Z",
    updated: "2026-09-01T09:00:00.000Z",
    done: false,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;
const calls = {
  complete: vi.fn(async () => {}),
  reschedule: vi.fn(async () => {}),
  patch: vi.fn(),
  expand: vi.fn(),
  select: vi.fn(),
  selectNext: vi.fn(),
  reopen: vi.fn(),
  foldEnd: vi.fn(),
};

async function renderRows(
  tasks: TaskView[],
  over: Partial<React.ComponentProps<typeof TasksRow>> = {},
) {
  await act(async () => {
    root.render(
      <ul>
        {tasks.map((entry) => (
          <TasksRow
            key={entry.id}
            task={entry}
            today={TODAY}
            offsetMinutes={0}
            reduce={harness.reduce}
            selected={false}
            expanded={false}
            categories={["Work"]}
            onSelect={calls.select}
            onSelectNext={calls.selectNext}
            onExpand={calls.expand}
            onComplete={calls.complete}
            onReopen={calls.reopen}
            onReschedule={calls.reschedule}
            onPatch={calls.patch}
            onFoldEnd={calls.foldEnd}
            {...over}
          />
        ))}
      </ul>,
    );
  });
}

function pointer(
  type: string,
  init: { clientX?: number; clientY?: number; pointerType?: string } = {},
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "touch" });
  return event;
}

const row = () => document.querySelector(".brain-task-row") as HTMLElement;
const box = () => document.querySelector(".brain-task-box") as HTMLButtonElement;
const tick = () => box().querySelector("path") as SVGPathElement;

const css = readFileSync(
  path.join(path.resolve(__dirname, ".."), "app/globals.css"),
  "utf8",
);
const milkdown = readFileSync(
  path.join(path.resolve(__dirname, ".."), "components/editor/milkdown.css"),
  "utf8",
);

function ruleFor(sheet: string, selector: string): string {
  const at = sheet.indexOf(`\n${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  return sheet.slice(at, sheet.indexOf("}", at));
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  harness.reduce = false;
  renders.length = 0;
  animations.length = 0;
  pressAnimate.mockClear();
  for (const call of Object.values(calls)) call.mockClear();
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    writable: true,
    value(frames: Keyframe[], options: KeyframeAnimationOptions) {
      animations.push({ element: this as Element, frames, options });
      return { finished: Promise.resolve(), cancel: () => {} };
    },
  });
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  Reflect.deleteProperty(Element.prototype, "animate");
});

describe("what the row draws", () => {
  it("draws the checkbox as the same object the note draws", async () => {
    await renderRows([task("a")]);
    const drawn = renderTaskCheckbox({ checked: false, reduce: false });

    expect(box().className).toBe(drawn.className);
    expect(box().getAttribute("role")).toBe("checkbox");
    expect(tick().getAttribute("d")).toBe(drawn.querySelector("path")?.getAttribute("d"));
    expect(tick().getAttribute("stroke-width")).toBe("2");
    expect(tick().getAttribute("stroke-dasharray")).toBe("14");

    // and the same 16 / r4 / 1.5 box, declared once for both surfaces
    const shared = ruleFor(css, ".brain-task-box");
    expect(shared).toContain("width: 16px");
    expect(shared).toContain("border-radius: 4px");
    expect(shared).toContain("border: 1.5px solid var(--ink-3)");
    // the note's own rule adds position and nothing that redraws the box
    expect(milkdown).toContain("width: 16px");
    expect(milkdown).toContain("border-radius: 4px");
  });

  it("shows document-text in the tail when the task is linked", async () => {
    await renderRows([task("a", { page: "page-1" })]);
    const tail = document.querySelector(".brain-task-tail") as HTMLElement;
    expect(tail.querySelectorAll("svg").length).toBe(1);
  });

  it("shows restart in the tail when the task repeats", async () => {
    await renderRows([task("a", { repeat: { freq: "daily" } })]);
    expect(document.querySelectorAll(".brain-task-tail svg").length).toBe(1);
  });

  it("labels a detached task 'line removed from ‹page›' with the real page title", async () => {
    await renderRows(
      [task("a", { page: "page-1", detachedAt: "2026-09-12T09:00:00.000Z" })],
      { pageTitle: "Grocery list" },
    );
    expect(document.querySelector(".brain-task-caption")?.textContent).toBe(
      "line removed from Grocery list",
    );
    // a detached record answers its own `done`, so it wears no linked glyph
    expect(document.querySelectorAll(".brain-task-tail svg").length).toBe(0);
  });

  it("truncates the title and sets dir=auto", async () => {
    await renderRows([task("a", { title: "ذهاب إلى السوق" })]);
    const title = document.querySelector(".brain-task-title") as HTMLElement;
    expect(title.getAttribute("dir")).toBe("auto");
    expect(title.className).toContain("truncate");
  });

  it("shows an overdue deadline as red text and an ahead one in --ink-3", async () => {
    await renderRows([
      task("owed", { deadline: "2026-09-11" }),
      task("ahead", { deadline: "2026-09-20" }),
    ]);
    const captions = [...document.querySelectorAll(".brain-task-caption")];
    expect(captions.map((node) => node.textContent)).toEqual(["11 Sep", "20 Sep"]);
    expect(captions[0]?.hasAttribute("data-overdue")).toBe(true);
    expect(captions[1]?.hasAttribute("data-overdue")).toBe(false);
    // red is text on this surface and never a fill
    expect(ruleFor(css, '.brain-task-caption[data-overdue]')).toContain("color: var(--red)");
    expect(ruleFor(css, '.brain-task-caption[data-overdue]')).not.toContain("background");
  });

  it("flows the keyboard selection capsule between rows by layoutId", async () => {
    await renderRows([task("a"), task("b")], { selected: true });
    const capsules = renders.filter((render) =>
      String(render.props.className).includes("tree-row-capsule"),
    );
    expect(capsules.length).toBeGreaterThan(0);
    expect(capsules[0]?.motion.layoutId).toBe("tasks-select");
    expect(capsules[0]?.motion.transition).toEqual({
      type: "spring",
      bounce: 0,
      duration: 0.25,
    });
  });
});

describe("completion, drawn", () => {
  it("draws the check on a 200 ms dash after the fill's 60, and erases it on the cancel", async () => {
    await renderRows([task("a")]);
    await act(async () => box().click());

    const draw = animations.at(-1) as Recorded;
    expect(draw.element).toBe(tick());
    expect(draw.frames).toEqual([{ strokeDashoffset: 14 }, { strokeDashoffset: 0 }]);
    expect(draw.options.duration).toBe(200);
    expect(draw.options.delay).toBe(60);

    await act(async () => box().click());
    const erase = animations.at(-1) as Recorded;
    expect(erase.frames).toEqual([{ strokeDashoffset: 0 }, { strokeDashoffset: 14 }]);
    expect(erase.options.duration).toBe(120);
    expect(erase.options.easing).toBe("ease-in");
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("folds up on clip-path plus height over 220 ms, never on a scale", async () => {
    await renderRows([task("a")]);
    await act(async () => box().click());
    await act(async () => {
      vi.advanceTimersByTime(1300);
    });
    const fold = animations.at(-1) as Recorded;
    expect(fold.options.duration).toBe(220);
    expect(String(fold.frames[0]?.clipPath)).toBe("inset(0 0 0 0)");
    expect(String(fold.frames.at(-1)?.clipPath)).toBe("inset(0 0 100% 0)");
    expect(String(fold.frames.at(-1)?.height)).toBe("0px");
    expect(JSON.stringify(fold.frames)).not.toContain("scale");
  });

  it("folds down when the row is rescheduled, into the future", async () => {
    await renderRows([task("a")], { selected: true });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", metaKey: true }));
    });
    const fold = animations.at(-1) as Recorded;
    expect(String(fold.frames.at(-1)?.clipPath)).toBe("inset(100% 0 0 0)");
    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "2026-09-14",
      "Tomorrow",
    );
  });
});

describe("the expansion", () => {
  it("grows in real height and does not put the caret in the title", async () => {
    await renderRows([task("a")]);
    await act(async () => row().click());
    expect(calls.expand).toHaveBeenCalledWith("a");
    expect(document.querySelector("input")).toBeNull();

    // the capsule's height is a real height with a transition on it, and the
    // expanded state carries no transform
    expect(ruleFor(css, ".brain-task-row")).toContain("height 220ms var(--ease-out)");
    expect(ruleFor(css, ".brain-task-row[data-expanded]")).toContain(
      "height: calc(var(--task-capsule) + 40px)",
    );
    expect(ruleFor(css, ".brain-task-row[data-expanded]")).not.toContain("scale");
  });

  it("makes the title editable on a second tap and not on the first", async () => {
    await renderRows([task("a")], { expanded: true });
    expect(document.querySelector(".brain-task-input")).toBeNull();
    await act(async () => {
      (document.querySelector(".brain-task-title") as HTMLElement).click();
    });
    const input = document.querySelector(".brain-task-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("a");
  });
});

describe("the swipe", () => {
  const swipe = async (to: number, steps = [10]) => {
    await act(async () => {
      row().dispatchEvent(pointer("pointerdown", { clientX: 0 }));
    });
    for (const step of steps) {
      await act(async () => {
        row().dispatchEvent(pointer("pointermove", { clientX: step }));
      });
    }
    await act(async () => {
      row().dispatchEvent(pointer("pointermove", { clientX: to }));
    });
  };

  it("chooses no axis inside ten pixels of hysteresis", async () => {
    await renderRows([task("a")]);
    await act(async () => {
      row().dispatchEvent(pointer("pointerdown", { clientX: 0 }));
      row().dispatchEvent(pointer("pointermove", { clientX: 9 }));
      row().dispatchEvent(pointer("pointermove", { clientX: 40 }));
    });
    // 40 past the hysteresis is past the word's 24, so the word is up; the
    // point is that nothing moved at 9
    expect(document.querySelector(".brain-task-word")?.textContent).toContain("Tomorrow");
  });

  it("says Tomorrow to the right and Someday to the left, after 24 px", async () => {
    await renderRows([task("a")]);
    await swipe(20);
    expect(document.querySelector(".brain-task-word")).toBeNull();

    await swipe(60);
    expect(document.querySelector(".brain-task-word")?.textContent).toContain("Tomorrow");

    await swipe(-60, [-10]);
    expect(document.querySelector(".brain-task-word")?.textContent).toContain("Someday");
  });

  it("commits past 120 px and sends nothing when it is released short of it", async () => {
    await renderRows([task("a")]);
    await swipe(60);
    await act(async () => {
      row().dispatchEvent(pointer("pointerup", { clientX: 60 }));
    });
    expect(calls.reschedule).not.toHaveBeenCalled();
    expect(document.querySelector(".brain-task-word")).toBeNull();

    await swipe(130);
    await act(async () => {
      row().dispatchEvent(pointer("pointerup", { clientX: 130 }));
    });
    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "2026-09-14",
      "Tomorrow",
    );
  });

  it("commits a short flick on velocity alone, at 800 px/s", async () => {
    await renderRows([task("a")]);
    await act(async () => {
      row().dispatchEvent(pointer("pointerdown", { clientX: 0 }));
      row().dispatchEvent(pointer("pointermove", { clientX: 12 }));
    });
    await act(async () => {
      vi.advanceTimersByTime(10);
      row().dispatchEvent(pointer("pointermove", { clientX: 62 }));
      row().dispatchEvent(pointer("pointerup", { clientX: 62 }));
    });
    // 50px in 10ms is 5000 px/s, well past 800, on 62px of travel
    expect(calls.reschedule).toHaveBeenCalledTimes(1);
  });

  it("leaves a mouse alone: the swipe is a finger's gesture", async () => {
    await renderRows([task("a")]);
    await act(async () => {
      row().dispatchEvent(pointer("pointerdown", { clientX: 0, pointerType: "mouse" }));
      row().dispatchEvent(pointer("pointermove", { clientX: 200, pointerType: "mouse" }));
    });
    expect(document.querySelector(".brain-task-word")).toBeNull();
  });
});

describe("reduced motion", () => {
  beforeEach(() => {
    harness.reduce = true;
  });

  it("keeps the 160 ms fill, because it is colour and not movement", () => {
    const rule = ruleFor(css, "@media (prefers-reduced-motion: reduce)");
    void rule;
    // the box's fill transition is never inside a reduced-motion block
    expect(ruleFor(css, ".brain-task-box")).toContain(
      "background-color 160ms var(--ease-out)",
    );
    const reduced = css.slice(css.indexOf("/* Reduced motion: every transition on this surface"));
    expect(reduced).not.toContain(".brain-task-box");
  });

  it("fades the check over 120 ms with no dash draw and no scale", async () => {
    await renderRows([task("a")], { reduce: true });
    await act(async () => box().click());
    const draw = animations.at(-1) as Recorded;
    expect(draw.frames).toEqual([
      { strokeDashoffset: 0, opacity: 0 },
      { strokeDashoffset: 0, opacity: 1 },
    ]);
    expect(draw.options.duration).toBe(120);
    expect(pressAnimate).not.toHaveBeenCalled();
  });

  it("keeps the 1200 ms hold unchanged, and exits on a 120 ms opacity fade", async () => {
    await renderRows([task("a")], { reduce: true });
    await act(async () => box().click());
    await act(async () => {
      vi.advanceTimersByTime(1299);
    });
    expect(calls.complete).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(calls.complete).toHaveBeenCalledTimes(1);

    const fold = animations.at(-1) as Recorded;
    expect(fold.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(fold.options.duration).toBe(120);
    expect(JSON.stringify(fold.frames)).not.toContain("height");
  });

  it("drops the press scale and the row's own transform", () => {
    const reduced = css.slice(
      css.indexOf("/* Reduced motion: every transition on this surface"),
    );
    expect(reduced).toContain(".brain-task-row:active");
    expect(reduced).toContain("transform: none");
  });

  it("keeps the 1:1 swipe, because it is input and not animation", async () => {
    await renderRows([task("a")], { reduce: true });
    await act(async () => {
      row().dispatchEvent(pointer("pointerdown", { clientX: 0 }));
      row().dispatchEvent(pointer("pointermove", { clientX: 60 }));
    });
    expect(document.querySelector(".brain-task-word")?.textContent).toContain("Tomorrow");
  });

  it("gives the fold no spring and no travel when it is asked directly", () => {
    const element = document.createElement("div");
    foldRow(element, "up", true);
    const fold = animations.at(-1) as Recorded;
    expect(fold.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  });
});
