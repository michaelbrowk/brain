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

const { TasksRow, foldRow, WRITE_AT_MS: WRITE_AT } = await import("./tasks-row");
const { CHIP_ROW_AIR, CHIP_ROW_RING, DUR } = await import("@/lib/motion");
const { renderTaskCheck, renderTaskCheckbox } = await import("./tasks-checkbox");
const { SOLAR } = await import("./ui/solar-icons.generated");
const { doneTimeOf } = await import("./tasks-lists");

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

/** Where the capsule actually is. The swipe drives a `MotionValue`, so the
 *  travel is readable without a layout engine. */
function capsuleX(): number {
  const capsule = [...renders]
    .reverse()
    .find((render) => String(render.props.className) === "brain-task-row");
  const style = capsule?.props.style as { x?: { get: () => number } } | undefined;
  return style?.x?.get() ?? Number.NaN;
}

/** Which Solar drawing a glyph is, not how many there are. Matched on the
 *  path itself: jsdom reflows the attributes of an injected SVG, so the body
 *  string does not survive a round trip but the geometry does. */
const glyphs = (within: Element) =>
  [...within.querySelectorAll("svg")].map((svg) => {
    const d = svg.querySelector("path")?.getAttribute("d") ?? "";
    if (!d) return "?";
    return Object.entries(SOLAR).find(([, body]) => body.includes(d))?.[0] ?? "?";
  });
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
    expect(glyphs(tail)).toEqual(["document-text-linear"]);
  });

  it("shows restart in the tail when the task repeats", async () => {
    await renderRows([task("a", { repeat: { freq: "daily" } })]);
    const tail = document.querySelector(".brain-task-tail") as HTMLElement;
    expect(glyphs(tail)).toEqual(["restart-linear"]);
  });

  it("grows the next occurrence beside the repeat while the hold runs", async () => {
    await renderRows([
      task("a", { repeat: { freq: "weekly", byWeekday: ["thu"] }, when: TODAY }),
    ]);
    const tail = () => document.querySelector(".brain-task-tail") as HTMLElement;
    expect(tail().textContent).toBe("");

    await act(async () => box().click());
    // 2026-09-13 is a Sunday, so the next Thursday is the 17th
    expect(tail().textContent).toBe("Thu 17");

    // and it goes back with the cancel, having said nothing untrue
    await act(async () => box().click());
    expect(tail().textContent).toBe("");
  });

  it("puts the tail and the title back when the write is refused", async () => {
    // The hold dims the title and grows the tail that names the next
    // occurrence. A refusal has to take back everything the hold changed, not
    // only the tick: a row left holding reads as completed while the toast
    // says it failed.
    calls.complete.mockRejectedValueOnce(new Error("refused"));
    await renderRows([
      task("a", { repeat: { freq: "weekly", byWeekday: ["thu"] }, when: TODAY }),
    ]);
    // `data-holding` sits on `.brain-task-row`, the element every one of the
    // row's own rules is written against: on the list item outside it the
    // whole `.brain-task-row[data-holding]` block matched nothing.
    const item = () => document.querySelector(".brain-task-row") as HTMLElement;
    const tail = () => document.querySelector(".brain-task-tail") as HTMLElement;

    await act(async () => box().click());
    expect(tail().textContent).toBe("Thu 17");
    expect(item().hasAttribute("data-holding")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(box().getAttribute("aria-checked")).toBe("false");
    expect(item().hasAttribute("data-holding")).toBe(false);
    expect(tail().textContent).toBe("");
  });

  it("crossfades the next occurrence under reduced motion too", async () => {
    // `materializeFade` IS the reduced-motion shape: opacity at DUR.fast and
    // nothing that travels. The tail carries it in both settings, so there is
    // one behaviour here rather than two, and the one that reaches a reader
    // with the setting on is the one every other reader sees.
    harness.reduce = true;
    await renderRows([
      task("a", { repeat: { freq: "weekly", byWeekday: ["thu"] }, when: TODAY }),
    ]);
    await act(async () => box().click());

    const caption = [...renders]
      .reverse()
      .find((render) => String(render.props.className) === "brain-task-caption");
    expect(caption?.motion.initial).toEqual({ opacity: 0 });
    expect(caption?.motion.animate).toEqual({ opacity: 1 });
    expect(caption?.motion.transition).toEqual({ duration: DUR.fast });
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

  it("says who ticked a linked task from a share link, in place of the time", async () => {
    // Spec row 145. The note owns a linked task's completion, so a visitor's
    // tick is the note's answer and the Logbook names them.
    await renderRows([
      task("a", {
        page: "page-1",
        done: true,
        doneAt: "2026-09-13T09:00:00.000Z",
        updatedByName: "Ada",
      }),
    ]);
    expect(document.querySelector(".brain-task-caption")?.textContent).toBe(
      "done by Ada via link",
    );
  });

  it("keeps the time on a completion nobody else answered", async () => {
    await renderRows([
      task("a", { page: "page-1", done: true, doneAt: "2026-09-13T09:00:00.000Z" }),
    ]);
    expect(document.querySelector(".brain-task-caption")?.textContent).not.toContain(
      "via link",
    );
  });

  it("takes the affordance off a history row rather than giving it behaviour", async () => {
    // An older completion of a repeating task has nothing left to undo. It
    // used to take the full hover fill, a pointer cursor and a tab stop and
    // then answer no gesture at all.
    const historic = ruleFor(css, ".brain-task-row[data-historic]");
    expect(historic).toContain("background-color: transparent");
    expect(historic).toContain("transform: none");
    expect(historic).toContain("cursor: default");
    // It beats the hover and the press on ORDER, at the same weight, so it
    // needs no `:hover` of its own: a `:hover` a touch screen can reach is one
    // it will not let go of.
    expect(css.indexOf(".brain-task-row[data-historic] {")).toBeGreaterThan(
      css.indexOf(".brain-task-row:active {"),
    );
    // The hover rule now excludes a selected row through `:not(:where(…))`,
    // which weighs nothing, so "the same weight" is still true and
    // the refusal still wins on order. A bare `:not([data-selected])` would
    // out-weigh this rule and light a history row up under the cursor again.
    const hoverAt = css.indexOf(".brain-task-row:not(:where([data-selected])):hover {");
    expect(hoverAt).toBeGreaterThan(-1);
    expect(css.indexOf(".brain-task-row[data-historic] {")).toBeGreaterThan(hoverAt);
    expect(ruleFor(css, ".brain-task-box_static")).toContain("cursor: default");
    // The mark is drawn with the same path and the same dash the control uses,
    // so the two checks cannot become two drawings.
    const mark = renderTaskCheck(true, "Water the office plants");
    expect(mark.tagName).toBe("SPAN");
    expect(mark.getAttribute("aria-disabled")).toBe("true");
    expect(mark.getAttribute("aria-checked")).toBe("true");
    expect(mark.hasAttribute("tabindex")).toBe(false);
    const path = mark.querySelector("path");
    expect(path?.getAttribute("d")).toBe(
      renderTaskCheckbox({ checked: true, reduce: false })
        .querySelector("path")
        ?.getAttribute("d"),
    );
    expect((path as SVGPathElement).style.strokeDashoffset).toBe("0");
  });

  it("caps no caption at a count of characters", async () => {
    // "line removed from Weekly planning" does not fit 22ch, and a reader got
    // "line removed from Weekly pl\u2026" with nothing to open and no title
    // attribute. The tail is its own column and does not shrink, so the
    // caption takes the width it needs and the title truncates first.
    const caption = ruleFor(css, ".brain-task-caption");
    expect(caption).not.toContain("max-width");
    expect(caption).toContain("text-overflow: ellipsis");
    expect(ruleFor(css, ".brain-task-tail")).toContain("flex-shrink: 0");

    await renderRows(
      [task("a", { page: "page-1", detachedAt: "2026-09-12T09:00:00.000Z" })],
      { pageTitle: "Weekly planning" },
    );
    expect(document.querySelector(".brain-task-caption")?.textContent).toBe(
      "line removed from Weekly planning",
    );
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

  it("folds down when the row is rescheduled, into the future", async () => {
    await renderRows([task("a")], { selected: true });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", metaKey: true }));
    });
    const fold = animations.at(-1) as Recorded;
    expect(String(fold.frames.at(-1)?.clipPath)).toBe("inset(100% 0 0 0)");
    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      { when: "2026-09-14", evening: false, time: null },
      "Tomorrow",
    );
  });

  it("keeps a timed task's clock across the key that moves it", async () => {
    await renderRows([task("a", { when: TODAY, time: "07:30" })], { selected: true });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", metaKey: true }));
    });
    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      { when: "2026-09-14", evening: false, time: "07:30" },
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
    expect(ruleFor(css, ".brain-task-row[data-expanded]")).not.toContain("scale");
  });

  /** I1. ONE LAYER ON AN EXPANDED ROW.
   *
   *  It painted `--blue-tint-2` plus a `--blue-rim` hairline with the ink
   *  capsule still stacked under it: three fills on one row, on a surface
   *  whose verdict was quiet focus, and since a row cannot be expanded
   *  without being selected the quiet version was never what a reader saw. */
  it("draws one fill on an expanded row, with no rim and no capsule under it", () => {
    const rule = ruleFor(css, ".brain-task-row[data-expanded]");
    expect(rule).toContain("background-color: var(--blue-tint)");
    expect(rule).not.toContain("--blue-tint-2");
    expect(rule).not.toContain("box-shadow");
    expect(
      ruleFor(css, ".brain-task-row[data-expanded] > .tree-row-capsule"),
    ).toContain("background-color: transparent");
  });

  it("takes the expanded capsule's height off the chips, which wrap", async () => {
    // IT WAS A NUMBER: `capsule + 40`, one line of chips. Four of them do not
    // fit on one line at 390, so the fourth was drawn outside the capsule. The
    // row sizes to its content and the chip row reveals itself from 0, which is
    // the same 220ms growth measured rather than assumed.
    expect(ruleFor(css, ".brain-task-row[data-expanded]")).toContain("height: auto");
    expect(ruleFor(css, ".brain-task-row[data-expanded]")).not.toContain(
      "calc(var(--task-capsule) + 40px)",
    );
    expect(ruleFor(css, ".brain-task-chips")).toContain("flex-wrap: wrap");
    // A chip keeps its own width and its own one line, so no chip is ever drawn
    // over the one beside it.
    expect(ruleFor(css, ".chip")).toContain("white-space: nowrap");
    expect(ruleFor(css, ".chip")).toContain("flex-shrink: 0");

    // THE AIR IS ONE NUMBER IN ONE PLACE, and it travels with the reveal. It
    // was three literals (a margin here, a padding on the capsule and the
    // number in the component) and the padding drew its 6px at chip height 0,
    // so the capsule stepped open before it grew. Neither side of it is held
    // in the stylesheet.
    expect(ruleFor(css, ".brain-task-row[data-expanded]")).not.toContain("padding-bottom");
    const chipRule = ruleFor(css, ".brain-task-chips");
    expect(chipRule).not.toContain("margin-top");
    expect(chipRule).not.toContain("margin-bottom");
    expect(chipRule).not.toContain("margin-block");

    await renderRows([task("a", { when: TODAY })], { expanded: true });
    const chips = renders.find(
      (render) => String(render.props.className) === "brain-task-chips",
    );
    expect(chips?.motion.initial).toMatchObject({
      height: 0,
      marginTop: 0,
      marginBottom: 0,
      paddingTop: 0,
      paddingBottom: 0,
    });
    expect(chips?.motion.animate).toMatchObject({
      height: "auto",
      marginTop: CHIP_ROW_AIR - CHIP_ROW_RING,
      marginBottom: CHIP_ROW_AIR - CHIP_ROW_RING,
      paddingTop: CHIP_ROW_RING,
      paddingBottom: CHIP_ROW_RING,
    });
    expect(CHIP_ROW_AIR).toBe(6);
  });

  /** THE REVEAL'S CLIP KEPT NO DISTANCE FROM THE CHIPS.
   *
   *  The chip row grows from height 0, so it has to clip while that plays.
   *  Its box hugged the chips exactly, so it went on clipping at rest: a
   *  chip's focus ring (3px at +2 offset, five pixels of reach) came back as
   *  two slivers on its left and right edges with its top and its bottom cut
   *  away, and the rim and the drop shadow every chip carries were shaved off
   *  with them. Every chip in the row, every time. The room is the ring's own
   *  reach, taken back on the outside so the first chip still starts on the
   *  text rule and the capsule is the height it always was. */
  it("keeps the reveal's clip off the chips it is drawn around", async () => {
    const rule = ruleFor(css, ".brain-task-chips");
    expect(rule).toContain("overflow: hidden");
    // Sideways is static, because no margin travels on that axis.
    expect(rule).toContain(`padding-inline: ${CHIP_ROW_RING}px`);
    expect(rule).toContain(`margin-inline: -${CHIP_ROW_RING}px`);
    // The ring's reach: the outline's own width plus its offset, and the one
    // place either of them is declared.
    const ring = ruleFor(css, "html[data-kbd] :focus-visible");
    expect(ring).toContain("outline: 3px solid var(--blue-ring)");
    expect(ring).toContain("outline-offset: 2px");
    expect(CHIP_ROW_RING).toBe(5);

    // And the air a reader sees is the 6 it has always been: what the padding
    // takes, the margin gives back.
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    const chips = renders.find(
      (render) => String(render.props.className) === "brain-task-chips",
    );
    const animate = chips?.motion.animate as Record<string, number>;
    expect(animate.paddingTop + animate.marginTop).toBe(CHIP_ROW_AIR);
    expect(animate.paddingBottom + animate.marginBottom).toBe(CHIP_ROW_AIR);
  });

  it("offers no deadline on a someday task", async () => {
    await renderRows([task("a", { when: "someday" })], { expanded: true });
    expect([...document.querySelectorAll(".chip")].map((chip) => chip.textContent))
      .not.toContain("Deadline");

    await renderRows([task("b", { when: TODAY })], { expanded: true });
    expect([...document.querySelectorAll(".chip")].map((chip) => chip.textContent))
      .toContain("Deadline");
  });

  it("draws the category control as a chip, between two chips", async () => {
    // Spec, The row: the second line materialises chips (`.chip`, 28, r14),
    // and `+ Category` or the word is one of them. It used to keep its own
    // bare-text geometry between two filled 28-tall capsules, where it read as
    // a label rather than as something to press.
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    const labels = [...document.querySelectorAll(".chip")].map((chip) =>
      chip.textContent,
    );
    expect(labels).toContain("+ Category");

    await renderRows([task("b", { when: TODAY, category: "Family" })], {
      expanded: true,
    });
    const set = [...document.querySelectorAll(".chip")].find(
      (chip) => chip.textContent === "Family",
    );
    expect(set).toBeDefined();
    expect(set?.getAttribute("aria-label")).toBe("Category: Family");
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

/** THREE RULES AND A STOP, AND NO FOURTH CONTROL.
 *
 *  No interval field, no end date, no count, no "this one or all future"
 *  dialog. The dialog is unnecessary by construction: editing the rule is the
 *  future and editing the instance is this one, and a control that does not
 *  exist cannot be asked for. */
describe("the repeat chip", () => {
  const chipLabels = () =>
    [...document.querySelectorAll(".chip")].map((chip) => chip.textContent);

  it("offers the rule on an unlinked task, and names the one it has", async () => {
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    expect(chipLabels()).toContain("Repeat");

    await renderRows([task("b", { when: TODAY, repeat: { freq: "daily" } })], {
      expanded: true,
    });
    expect(chipLabels()).toContain("Daily");
  });

  it("is not offered on a task that came from a note line, linked or detached", async () => {
    await renderRows([task("a", { page: "page-1" })], { expanded: true });
    expect(chipLabels()).not.toContain("Repeat");

    await renderRows(
      [task("b", { page: "page-1", detachedAt: "2026-09-12T09:00:00.000Z" })],
      { expanded: true },
    );
    expect(chipLabels()).not.toContain("Repeat");
  });

  it("is not offered on a done row, in the Logbook or anywhere else", async () => {
    // A rule on a done record promises a next occurrence nothing will write:
    // `listOf` files it in the Logbook because `done` is true, and it would
    // sit there claiming to repeat. The store refuses the same shape.
    await renderRows(
      [task("a", { done: true, doneAt: "2026-09-13T09:00:00.000Z" })],
      { expanded: true },
    );
    expect(chipLabels()).not.toContain("Repeat");

    // Including a done row of a record that already has a rule, which only an
    // import can make: there is nothing to change about it from here.
    await renderRows(
      [
        task("b", {
          done: true,
          doneAt: "2026-09-13T09:00:00.000Z",
          repeat: { freq: "daily" },
        }),
      ],
      { expanded: true },
    );
    expect(chipLabels()).not.toContain("Daily");
  });

  it("names the rule it would set, not the word twice, for a screen reader", async () => {
    await renderRows([task("a", { when: "2026-09-17" })], { expanded: true });
    const chipOf = (label: string) =>
      [...document.querySelectorAll(".chip")].find(
        (node) => node.getAttribute("aria-label") === label,
      );
    expect(chipOf("Repeat")).not.toBeUndefined();

    await renderRows(
      [task("b", { when: "2026-09-17", repeat: { freq: "weekly", byWeekday: ["thu"] } })],
      { expanded: true },
    );
    expect(chipOf("Repeat: every week on Thu")).not.toBeUndefined();
  });

});

/** A LOGBOOK ROW THAT IS HISTORY ANSWERS NOTHING.
 *
 *  Unticking is offered on the most recent completion of a repeating task and
 *  on no other, so an older row has nothing to undo, nothing to move and no
 *  chips to open over a completion that is over. */
describe("a history row", () => {
  const historic = () =>
    task("a", {
      done: true,
      doneAt: "2026-09-12T09:00:00.000Z",
      when: "2026-09-12",
      repeat: { freq: "daily" },
    });

  it("does not reopen on a press of its box", async () => {
    await renderRows([historic()], { historic: true });
    await act(async () => box().click());
    expect(calls.reopen).not.toHaveBeenCalled();

    await renderRows([historic()]);
    await act(async () => box().click());
    expect(calls.reopen).toHaveBeenCalledTimes(1);
  });

  it("selects nothing and opens nothing", async () => {
    // Not even the selection capsule: a capsule on a row that answers no key
    // is the same refusal one gesture later.
    await renderRows([historic()], { historic: true });
    await act(async () => {
      (document.querySelector(".brain-task-title") as HTMLElement).click();
    });
    expect(calls.select).not.toHaveBeenCalled();
    expect(calls.expand).not.toHaveBeenCalled();

    await renderRows([historic()]);
    await act(async () => {
      (document.querySelector(".brain-task-title") as HTMLElement).click();
    });
    expect(calls.select).toHaveBeenCalledWith("a");
  });

  it("becomes a control again when the entry above it is unticked", async () => {
    // A Logbook row's key is its completion, so the row below the newest one
    // keeps its key and stops being history the moment that one is undone.
    await renderRows([historic()], { historic: true });
    expect(document.querySelector(".brain-task-box")?.tagName).toBe("SPAN");

    await renderRows([historic()]);
    expect(document.querySelector(".brain-task-box")?.tagName).toBe("BUTTON");
  });

  it("answers no bare letter", async () => {
    await renderRows([historic()], { historic: true, selected: true });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    });
    expect(calls.reschedule).not.toHaveBeenCalled();
  });
});

/** ONE DATE CONTROL, ON A POINTER AND ON TOUCH ALIKE (D4).
 *
 *  The modality branch this block used to test is gone with the native input:
 *  `components/tasks-when-picker.tsx` is the control at every width, and
 *  `ops/design-guardrails.test.ts` refuses a second one under `app/`,
 *  `components/` and `lib/`. */
/** `hover: hover` or not, the chip opens the same control: the branch that
 *  read it is deleted. One stub, so the cases that open the picker run on a
 *  `matchMedia` that exists rather than on jsdom's absent one. */
const stubHover = (hover = true, sheet = false) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(hover: hover)" ? hover : sheet && query === "(max-width: 767px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
};

/** The detailed path's commit. A grid pick moves the picker's own value; Done
 *  is what sends it, and what closes the popover before the row folds. */
const pressDone = async () => {
  await act(async () => {
    document.querySelector<HTMLElement>("[data-when-done]")?.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

const openMenu = async () => {
  const chip = [...document.querySelectorAll<HTMLElement>(".chip")].find((node) =>
    node.getAttribute("aria-label")?.startsWith("When:"),
  );
  if (!chip) throw new Error("no When chip on the expanded row");
  await act(async () => {
    chip.dispatchEvent(pointer("pointerdown"));
    chip.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

describe("the When chip's picker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the same picker on a pointer and on touch (D4)", async () => {
    // A row per modality: the same key would keep the component mounted with
    // the popover it opened still open, and the second press would shut it.
    for (const [hover, id] of [
      [true, "pointer"],
      [false, "touch"],
    ] as const) {
      stubHover(hover);
      await renderRows([task(id, { when: TODAY })], { expanded: true });
      await openMenu();
      expect(document.querySelector(".brain-when-picker")).not.toBeNull();
      expect(document.querySelector('input[type="date"]')).toBeNull();
      expect(document.querySelector("[data-task-when-pick]")).toBeNull();
    }
  });

  it("folds the row only once the picker has gone", async () => {
    // A RESCHEDULE FOLDS THE ROW DOWNWARD, and a fold that starts while the
    // panel is still drawn takes the row out from under the thing the reader is
    // holding. So the grid moves the picker's own value and writes nothing, and
    // Done closes the popover and sends one PATCH.
    stubHover();
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    await openMenu();

    await act(async () => {
      document.querySelector<HTMLElement>('[data-day="2026-09-20"]')?.click();
    });
    expect(document.querySelector(".brain-when-picker")).not.toBeNull();
    expect(calls.reschedule).not.toHaveBeenCalled();

    await pressDone();

    expect(document.querySelector(".brain-when-picker")).toBeNull();
    expect(calls.reschedule).toHaveBeenCalledTimes(1);
  });

  /** A DAY IN THE GRID CLOSED THE CALENDAR AND SAVED NOTHING.
   *
   *  The panel is portalled to the end of the document and React carries its
   *  clicks up the ROW's tree all the same, so `openRow` heard a day cell as a
   *  second press on the row and folded it. The chips went, the picker went
   *  with them, and a teardown that is not a close throws the reader's day
   *  away: the one path the detailed contract rests on, with nothing filed and
   *  nothing said. The case above cannot see it, because `expanded` is a prop
   *  in this harness and the fold it asks for never arrives. This one watches
   *  the ask. */
  it("hears a press in the calendar as the calendar's and not as the row's", async () => {
    stubHover();
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    await openMenu();
    calls.expand.mockClear();
    calls.select.mockClear();

    await act(async () => {
      document.querySelector<HTMLElement>('[data-day="2026-09-20"]')?.click();
    });

    expect(calls.expand).not.toHaveBeenCalled();
    expect(calls.select).not.toHaveBeenCalled();
    expect(document.querySelector(".brain-when-picker")).not.toBeNull();
    // and the cell the reader pressed wears the ink capsule, which is the
    // whole of what the press was for
    expect(
      document
        .querySelector('[data-day="2026-09-20"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("hears the repeat menu and the category popover the same way", async () => {
    // EVERY PANEL A CHIP OPENS IS PORTALLED, so the rule cannot be about the
    // calendar. A press in any of them is a press on the control that opened
    // it, and the row it is drawn over answers none of them.
    stubHover();
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    const repeat = [...document.querySelectorAll<HTMLElement>(".chip")].find((node) =>
      (node.textContent ?? "").includes("Repeat"),
    )!;
    await act(async () => {
      repeat.dispatchEvent(pointer("pointerdown"));
      repeat.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const option = document.querySelector<HTMLElement>("[role='menuitemradio']");
    expect(option).not.toBeNull();
    calls.expand.mockClear();

    await act(async () => {
      option?.click();
    });

    expect(calls.expand).not.toHaveBeenCalled();
    expect(calls.patch).toHaveBeenCalledTimes(1);
  });

  /** I6. THE REPEAT MENU STATES ITS RULE, WHOLE.
   *
   *  "Every month on the 14th at 0..." was truncated at the width the menu
   *  was given and the clock was the half that got cut, in the one panel that
   *  exists to say what the rule is. And "Reminder · 07:45" was a
   *  `role="presentation"` div wearing `brain-menu-item`: menu item height,
   *  menu item indent, not pressable — the shape the picker's own code
   *  forbids two files away. */
  const openRepeatMenu = async () => {
    const chip = [...document.querySelectorAll<HTMLElement>(".chip")].find((node) =>
      node.getAttribute("aria-label")?.startsWith("Repeat"),
    );
    if (!chip) throw new Error("no Repeat chip on the expanded row");
    await act(async () => {
      chip.dispatchEvent(pointer("pointerdown"));
      chip.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  it("wraps the repeat rule instead of cutting it, and says where the clock is set", async () => {
    stubHover();
    await renderRows(
      [task("a", { when: TODAY, time: "07:45", repeat: { freq: "monthly", byMonthDay: 14 } })],
      { expanded: true },
    );
    await openRepeatMenu();

    const items = [...document.querySelectorAll(".brain-menu-item")];
    expect(items.some((item) => item.getAttribute("role") === "presentation")).toBe(
      false,
    );
    const rule = items.find((item) => item.textContent?.startsWith("Every month"));
    expect(rule?.textContent).toBe("Every month on the 14th at 07:45");
    expect(rule?.querySelector(".truncate")).toBeNull();

    const caption = document.querySelector(".brain-menu-caption") as HTMLElement;
    expect(caption.textContent).toBe("Reminder 07:45, set in When");
    expect(caption.className).not.toContain("brain-menu-item");
  });

  it("commits what the sheet was dragged away on, because a drag is a close", async () => {
    // THE GRIP IS THE PRIMARY WAY OUT ON A PHONE, and the same panel on a
    // pointer commits what a press outside settled on. Two dismissals of one
    // control cannot mean opposite things, so the drag writes too.
    stubHover(false, true);
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    await openMenu();
    await act(async () => {
      document.querySelector<HTMLElement>('[data-day="2026-09-20"]')?.click();
    });
    expect(calls.reschedule).not.toHaveBeenCalled();

    const sheet = [...renders].reverse().find((render) => render.motion.drag === "y");
    const dragEnd = sheet?.motion.onDragEnd as
      | ((event: null, info: { offset: { y: number }; velocity: { y: number } }) => void)
      | undefined;
    if (!dragEnd) throw new Error("the picker drew no sheet to drag");
    await act(async () => {
      dragEnd(null, { offset: { y: 200 }, velocity: { y: 0 } });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector(".brain-when-picker")).toBeNull();
    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      { when: "2026-09-20", evening: false, time: null },
      "20 Sep",
    );
  });

  it("closes and writes once on a quick row, and sends nothing that changes nothing", async () => {
    stubHover();
    await renderRows([task("a", { when: "someday" })], { expanded: true });
    await openMenu();
    await act(async () => {
      document.querySelector<HTMLElement>("[data-when-today]")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector(".brain-when-picker")).toBeNull();
    expect(calls.reschedule).toHaveBeenCalledTimes(1);

    // Today pressed on a row already in Today is a write nobody asked for.
    calls.reschedule.mockClear();
    await renderRows([task("b", { when: TODAY })], { expanded: true });
    await openMenu();
    await act(async () => {
      document.querySelector<HTMLElement>("[data-when-today]")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.reschedule).not.toHaveBeenCalled();
  });

  it("sends the day, the evening and the clock as one value", async () => {
    // The picker answers with the whole of where a task sits, so the row
    // hands one value on rather than three writes the reader made in one
    // gesture.
    stubHover();
    await renderRows([task("a", { when: TODAY, time: "13:00" })], { expanded: true });
    await openMenu();

    await act(async () => {
      document.querySelector<HTMLElement>('[data-day="2026-09-20"]')?.click();
    });
    await pressDone();

    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      { when: "2026-09-20", evening: false, time: "13:00" },
      "20 Sep",
    );
  });

  it("names the LIST the task landed in, not the field it cleared", async () => {
    // "Moved to No date" is a sentence about a field nobody is looking at. The
    // Inbox is the list with no day and where the reader will go and find it.
    stubHover();
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    await openMenu();
    await act(async () => {
      document.querySelector<HTMLElement>("[data-when-clear]")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      { when: null, evening: false, time: null },
      "Inbox",
    );
  });

  it("reports an evening as the evening, which is what the chip says too", async () => {
    stubHover();
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    await openMenu();
    await act(async () => {
      document.querySelector<HTMLElement>("[data-when-evening]")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      { when: TODAY, evening: true, time: null },
      "This Evening",
    );
  });

  it("says the day and the clock the chip is standing on", async () => {
    stubHover();
    await renderRows([task("a", { when: TODAY, evening: true, time: "20:30" })], {
      expanded: true,
    });
    const chip = [...document.querySelectorAll<HTMLElement>(".chip")].find((node) =>
      node.getAttribute("aria-label")?.startsWith("When:"),
    );
    expect(chip?.textContent).toContain("This Evening");
    expect(chip?.getAttribute("aria-label")).toBe("When: This Evening at 20:30");
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
    });
    // nine pixels is a tap wobbling, not a swipe: nothing has moved
    expect(capsuleX()).toBe(0);
    expect(document.querySelector(".brain-task-word")).toBeNull();

    await act(async () => {
      row().dispatchEvent(pointer("pointermove", { clientX: 40 }));
    });
    expect(capsuleX()).toBe(40);
    expect(document.querySelector(".brain-task-word")?.textContent).toContain("Tomorrow");
  });

  it("tracks the finger to the pixel, and rubber-bands only past 160", async () => {
    await renderRows([task("a")]);
    await act(async () => {
      row().dispatchEvent(pointer("pointerdown", { clientX: 0 }));
      row().dispatchEvent(pointer("pointermove", { clientX: 100 }));
    });
    expect(capsuleX()).toBe(100);
    await act(async () => {
      row().dispatchEvent(pointer("pointermove", { clientX: 300 }));
    });
    // past 160 the capsule falls behind the finger rather than following it
    expect(capsuleX()).toBeGreaterThan(160);
    expect(capsuleX()).toBeLessThan(300);
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
      { when: "2026-09-14", evening: false, time: null },
      "Tomorrow",
    );
  });

  it("carries the clock the record already has onto the day it swipes to", async () => {
    // THE REASON `whenValueFor` EXISTS. A swipe, a key and a palette row name a
    // day and nothing else, so the other two fields are read off the record:
    // the reminder the task is already carrying stays with it, and the evening
    // comes off because tomorrow has no evening of today's.
    await renderRows([task("a", { when: TODAY, evening: true, time: "13:00" })]);

    await swipe(130);
    await act(async () => {
      row().dispatchEvent(pointer("pointerup", { clientX: 130 }));
    });

    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      { when: "2026-09-14", evening: false, time: "13:00" },
      "Tomorrow",
    );
  });

  it("still commits when the capture was already released under it", async () => {
    // iOS releases the capture itself on `pointercancel`, and releasing one
    // that is gone throws `NotFoundError`. Thrown out of the handler it
    // aborted it before the commit: the finger travelled, the word appeared,
    // and the release silently did nothing, which on a device reads as the
    // gesture being broken.
    await renderRows([task("a")]);
    const element = row() as HTMLElement & {
      releasePointerCapture: (id: number) => void;
    };
    element.releasePointerCapture = () => {
      throw Object.assign(new Error("no pointer with this id"), {
        name: "NotFoundError",
      });
    };

    await swipe(130);
    await act(async () => {
      element.dispatchEvent(pointer("pointerup", { clientX: 130 }));
    });

    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      { when: "2026-09-14", evening: false, time: null },
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

  /** The surface's own reduced-motion block, on its own. */
  const reducedTasks = () => {
    const at = css.indexOf("/* Reduced motion: every transition on this surface");
    expect(at).toBeGreaterThan(-1);
    const end = css.indexOf("\n/* \u2500", at);
    return css.slice(at, end === -1 ? undefined : end);
  };

  it("keeps the 160 ms fill and the title's dim, because they are colour", () => {
    // The GLOBAL reduce rule is `* { transition-duration: 0.01ms !important }`
    // and it comes first, so a plain shorthand written under reduce loses to
    // it whatever it says: the measured duration on a row was 1e-05s and this
    // whole block was dead code. Every colour transition the spec keeps has to
    // carry `!important` to survive it.
    const global = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(global).toContain("transition-duration: 0.01ms !important");

    const reduced = reducedTasks();
    for (const selector of [
      ".brain-task-row {",
      ".brain-task-row[data-expanded] {",
      ".brain-task-box {",
      ".brain-task-row[data-holding] .brain-task-title {",
    ]) {
      expect(reduced).toContain(selector);
    }
    // Every transition this block restates wins, and every one of them is a
    // colour: nothing here travels, resizes or fades.
    const transitions = [...reduced.matchAll(/transition:[^;]+;/g)].map(
      (match) => match[0],
    );
    expect(transitions.length).toBe(4);
    for (const declaration of transitions) {
      expect(declaration).toContain("!important");
      expect(declaration).toMatch(/background-color|border-color|color /);
      expect(declaration).not.toMatch(/transform|opacity|height|width/);
    }
    // And the box still declares its fill outside the block, so the surface
    // reads the same either way.
    expect(ruleFor(css, ".brain-task-box")).toContain(
      "background-color 160ms var(--ease-out)",
    );
  });

  it("keeps the chip row's air, and travels none of it", async () => {
    // THE AIR IS NOT MOTION. Both sides of it moved into the component when
    // the capsule stopped carrying a padding, and the stylesheet holds neither
    // any more, so an expanded row under this setting would lose its 6px above
    // and below if the reduced branch dropped them. It lands at rest instead
    // of growing: no height here, on either frame. The air is split between a
    // padding and a margin so the clip stands off the chips, and the reduced
    // branch has to land BOTH halves or the room the ring needs is only there
    // for a reader who did not ask for less motion.
    await renderRows([task("a", { when: TODAY })], { expanded: true });
    const chips = renders.find(
      (render) => String(render.props.className) === "brain-task-chips",
    );
    const rest = {
      paddingTop: CHIP_ROW_RING,
      paddingBottom: CHIP_ROW_RING,
      marginTop: CHIP_ROW_AIR - CHIP_ROW_RING,
      marginBottom: CHIP_ROW_AIR - CHIP_ROW_RING,
    };
    expect(chips?.motion.initial).toMatchObject(rest);
    expect(chips?.motion.animate).toMatchObject(rest);
    expect(chips?.motion.initial).not.toHaveProperty("height");
    expect(chips?.motion.animate).not.toHaveProperty("height");
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

  it("keeps the 1200 ms hold unchanged, and still plays no exit", async () => {
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

    // The row stays under this setting too. The only WAAPI the completion
    // started is the check's own crossfade, on the tick and not on the row.
    expect(animations.every((entry) => entry.element === tick())).toBe(true);
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
    // the capsule is under the finger, to the pixel, with the setting on
    expect(capsuleX()).toBe(60);
    expect(document.querySelector(".brain-task-word")?.textContent).toContain("Tomorrow");
  });

  it("gives the fold no spring and no travel when it is asked directly", () => {
    const element = document.createElement("div");
    foldRow(element, "up", true);
    const fold = animations.at(-1) as Recorded;
    expect(fold.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  });
});

/** D5. THE SELECTION IS A PLACE, NOT AN EMPHASIS.
 *
 *  None of the six shell contract fixtures draws a task row, so the quiet
 *  focus is asserted through the rules the row computes for itself. */
describe("the quiet focus (D5)", () => {
  it("draws the selection at the sidebar's hover tint and not the grey fill", () => {
    const rule = ruleFor(css, ".brain-task-row > .tree-row-capsule");
    expect(rule).toContain("background-color: var(--fill-glass-hover)");
    expect(rule).not.toContain("--fill-glass-selected");
    expect(rule).not.toContain("box-shadow");
  });

  it("leaves the title's weight alone", () => {
    expect(css).not.toContain(".brain-task-row[data-selected] .brain-task-title");
  });

  it("keeps the sidebar's own capsule exactly as it was", () => {
    const rule = ruleFor(css, ".tree-row > .tree-row-capsule");
    expect(rule).toContain("background-color: var(--fill-glass-selected)");
    expect(rule).toContain("box-shadow");
    // and its hover veil is the sidebar's alone now: the task row wears no
    // capsule `::after` at all, so there is nothing on it to fade in
    expect(css).not.toContain(".brain-task-row > .tree-row-capsule::after");
    expect(css).not.toContain(
      ".brain-task-row[data-selected]:hover > .tree-row-capsule::after",
    );
  });

  it("adds the ring on a keyboard session and nowhere else", () => {
    const rule = ruleFor(css, "html[data-kbd] .brain-task-row[data-selected]");
    expect(rule).toContain("outline: 3px solid var(--blue-ring)");
    expect(rule).toContain("outline-offset: -3px");
  });

  it("does not stack a hover tint on a selected row", () => {
    expect(css).toContain(".brain-task-row:not(:where([data-selected])):hover");
  });

  it("still flows the capsule between rows on SPRING_SELECT", async () => {
    await renderRows([task("a"), task("b")], { selected: true });
    const capsule = renders.find((render) =>
      String(render.props.className).includes("tree-row-capsule"),
    );
    expect(capsule?.motion.layoutId).toBe("tasks-select");
  });
});

/** D3. A COMPLETION IS STRUCK THROUGH AND SINKS, and it does not leave. */
describe("the strike and the sink (D3)", () => {
  it("draws the strike from the left over DUR.base", () => {
    const rule = ruleFor(css, ".brain-task-title::after");
    expect(rule).toContain("transform: scaleX(0)");
    expect(rule).toContain("transform-origin: left center");
    expect(rule).toContain(`transition: transform ${DUR.base * 1000}ms var(--ease-out)`);
  });

  it("strikes a row that is holding and a row that is done", () => {
    expect(css).toContain(".brain-task-row[data-holding] .brain-task-title::after");
    expect(css).toContain(".brain-task-row[data-done] .brain-task-title::after");
  });

  it("flags the hold on the element those rules are written against", async () => {
    await renderRows([task("a", { when: TODAY })]);
    await act(async () => box().click());
    expect(row().hasAttribute("data-holding")).toBe(true);
  });

  it("lets reduced motion collapse the strike, because it travels", () => {
    // THE LOAD-BEARING FACT IS THE GLOBAL RULE'S PSEUDO-ELEMENTS. The strike
    // lives on `.brain-task-title::after` and `transition-duration` does not
    // inherit, so a global reduce rule written `*` alone would leave the line
    // travelling under the setting. It is written `*, *::before, *::after`,
    // and that is what makes the strike collapse.
    const global = ruleFor(css, "  *,\n  *::before,\n  *::after");
    expect(global).toContain("transition-duration: 0.01ms !important");
    // And the surface's own block does not exempt the strike back out: it
    // restates the four transitions that are COLOUR and nothing else.
    const reduced = css.slice(
      css.indexOf("/* Reduced motion: every transition on this surface"),
    );
    expect(reduced).not.toContain(".brain-task-title::after");
  });

  it("plays no fold when a task is completed", async () => {
    await renderRows([task("a", { when: TODAY })]);
    await act(async () => box().click());
    await act(async () => vi.advanceTimersByTime(WRITE_AT));
    await act(async () => {
      await Promise.resolve();
    });
    // The row stays. A fold fills forwards, so one played here would hold a row
    // that never unmounts at height 0 until the next load.
    expect(
      animations.some((entry) => entry.frames.some((frame) => "clipPath" in frame)),
    ).toBe(false);
  });

  it("still sends nothing when the completion is cancelled inside the hold", async () => {
    await renderRows([task("a", { when: TODAY })]);
    await act(async () => box().click());
    await act(async () => vi.advanceTimersByTime(WRITE_AT - 1));
    await act(async () => box().click());
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("sinks on the layout spring and not on a fold", async () => {
    await renderRows([task("a", { when: TODAY })]);
    const item = [...renders]
      .reverse()
      .find((render) => String(render.props.className) === "brain-task-row-item");
    expect(item?.motion.layout).toBe("position");
    expect(item?.motion.transition).toMatchObject({
      layout: { bounce: 0, duration: 0.42 },
    });
  });

  /** C2. THE STRUCK ROW DOES NOT TRAVEL OVER THE ROWS IT PASSES.
   *
   *  It used to ride the layout spring down its group at full opacity, and
   *  for about 110ms it was painted exactly on top of a stationary row: two
   *  titles in one composite, and an OPEN task wearing the struck row's
   *  filled box and its strike. So the row fades out where it stands, the
   *  reorder happens with the row invisible, and it fades in at the foot. */
  const lastItem = () =>
    [...renders]
      .reverse()
      .find((render) => String(render.props.className) === "brain-task-row-item");
  /** The node the fade is drawn on, which is NOT the node the reorder moves. */
  const lastWrap = () =>
    [...renders]
      .reverse()
      .find((render) => String(render.props.className) === "brain-task-swipe");

  async function tickAndSettle() {
    await act(async () => box().click());
    await act(async () => vi.advanceTimersByTime(WRITE_AT));
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("fades the struck row out in place and holds the reorder until it has gone", async () => {
    await renderRows([task("a", { when: TODAY })]);
    await tickAndSettle();

    const item = lastItem();
    expect(lastWrap()?.motion.animate).toMatchObject({ opacity: 0 });
    expect(lastWrap()?.motion.transition).toMatchObject({ duration: DUR.base });
    // Duration 0: the row does not travel. The delay is the fade, so the
    // reorder happens while there is nothing on screen to see it.
    expect(item?.motion.transition).toMatchObject({
      layout: { duration: 0, delay: DUR.base },
    });
  });

  /** AND THE FADE IS NOT ON THE ELEMENT THE REORDER MOVES.
   *
   *  Drawn on the `<li>` it never painted at all. React reorders the list by
   *  moving that node, and the opacity animation went with it: on the page
   *  the struck row held full ink for the whole sink, a neighbour sprang
   *  across it at full opacity, and C2 was exactly where it had been. So the
   *  list item animates the arrival's opacity and nothing else, and the
   *  wrapper inside it, which no reorder re-parents, carries the fade. */
  it("draws the fade one node in, on the wrapper the reorder never moves", async () => {
    await renderRows([task("a", { when: TODAY })]);
    await tickAndSettle();

    expect(lastItem()?.motion.animate).toMatchObject({ opacity: 1 });
    expect(lastWrap()?.motion.animate).toMatchObject({ opacity: 0 });
  });

  it("fades it back in at the foot once the fade is over", async () => {
    await renderRows([task("a", { when: TODAY })]);
    await tickAndSettle();
    await act(async () => vi.advanceTimersByTime(DUR.base * 1000));

    const item = lastItem();
    expect(lastWrap()?.motion.animate).toMatchObject({ opacity: 1 });
    expect(item?.motion.transition).toMatchObject({
      layout: { bounce: 0, duration: 0.42 },
    });
  });

  it("puts the row back where it was when the completion is refused", async () => {
    calls.complete.mockRejectedValueOnce(new Error("no"));
    await renderRows([task("a", { when: TODAY })]);
    await tickAndSettle();
    expect(lastWrap()?.motion.animate).toMatchObject({ opacity: 1 });
  });

  it("reorders instantly under reduced motion and fades nothing", async () => {
    harness.reduce = true;
    await renderRows([task("a", { when: TODAY })]);
    await tickAndSettle();
    const item = lastItem();
    expect(item?.motion.layout).toBe(false);
    expect(item?.motion.animate).toEqual({ opacity: 1 });
    expect(lastWrap()?.motion.animate).toEqual({ opacity: 1 });
  });

  it("moves without a spring under reduced motion", async () => {
    harness.reduce = true;
    await renderRows([task("a", { when: TODAY })]);
    const item = [...renders]
      .reverse()
      .find((render) => String(render.props.className) === "brain-task-row-item");
    expect(item?.motion.layout).toBe(false);
  });
});

describe("a completed row in a list is inert", () => {
  const done = () =>
    task("a", { when: TODAY, done: true, doneAt: `${TODAY}T09:00:00.000Z` });

  it("does not expand on a press", async () => {
    await renderRows([done()]);
    await act(async () => row().click());
    expect(calls.expand).not.toHaveBeenCalled();
  });

  it("takes no reschedule key", async () => {
    await renderRows([done()], { selected: true });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    });
    expect(calls.reschedule).not.toHaveBeenCalled();
  });

  it("takes no swipe", async () => {
    await renderRows([done()]);
    await act(async () => {
      row().dispatchEvent(pointer("pointerdown", { clientX: 0 }));
      row().dispatchEvent(pointer("pointermove", { clientX: 140 }));
      row().dispatchEvent(pointer("pointerup", { clientX: 140 }));
    });
    expect(calls.reschedule).not.toHaveBeenCalled();
    expect(capsuleX()).toBe(0);
  });

  it("still unticks from its checkbox", async () => {
    await renderRows([done()]);
    await act(async () => box().click());
    expect(calls.reopen).toHaveBeenCalled();
  });

  it("wears no hover fill, no press and no pointer", () => {
    const rule = ruleFor(css, ".brain-task-row[data-done]");
    expect(rule).toContain("background-color: transparent");
    expect(rule).toContain("transform: none");
    expect(rule).toContain("cursor: default");
    // and at the hover rule's own weight, so it wins on order the way the
    // history row's refusal does
    expect(css.indexOf(".brain-task-row[data-done] {")).toBeGreaterThan(
      css.indexOf(".brain-task-row:not(:where([data-selected])):hover {"),
    );
    expect(css.indexOf(".brain-task-row[data-done] {")).toBeGreaterThan(
      css.indexOf(".brain-task-row:active {"),
    );
  });
});

describe("the tail's clock and moon", () => {
  const tail = () => document.querySelector(".brain-task-tail") as HTMLElement;

  it("shows the time before the repeat glyph", async () => {
    await renderRows([
      task("a", { when: TODAY, time: "13:00", repeat: { freq: "daily" } }),
    ]);
    expect(tail().textContent).toContain("13:00");
    // Where each of the two stands among the tail's own children, so a clock
    // that drifted behind the glyph slot fails here.
    const children = [...tail().children];
    const slot = tail().querySelector(".brain-task-glyphs") as Element;
    expect(glyphs(slot)).toContain("restart-linear");
    expect(
      children.findIndex((node) => node.textContent === "13:00"),
    ).toBeLessThan(children.indexOf(slot));
  });

  it("writes the stored clock verbatim, with no locale in it", async () => {
    await renderRows([task("a", { when: TODAY, time: "13:00" })]);
    expect(tail().textContent).toContain("13:00");
    expect(tail().textContent).not.toContain("PM");
  });

  it("shows the moon on an evening task today and tomorrow", async () => {
    await renderRows([task("a", { when: TODAY, evening: true })]);
    expect(glyphs(tail())).toContain("moon-linear");
    await renderRows([task("b", { when: "2026-09-14", evening: true })]);
    expect(glyphs(tail())).toContain("moon-linear");
  });

  it("shows no moon on an overdue evening task", async () => {
    await renderRows([task("a", { when: "2026-09-11", evening: true })]);
    expect(glyphs(tail())).not.toContain("moon-linear");
    expect(tail().textContent).toContain("since Fri");
  });

  it("marks a fired reminder's time and never reddens it", async () => {
    // The fixture carries an overdue deadline too, so the red this test says
    // the clock does not take is red the tail is actually drawing beside it.
    await renderRows([
      task("a", {
        when: TODAY,
        time: "13:00",
        deadline: "2026-09-11",
        remindedAt: `${TODAY}T12:00:00.000Z`,
      }),
    ]);
    const time = tail().querySelector("[data-fired]") as HTMLElement;
    expect(time.textContent).toBe("13:00");
    expect(time.hasAttribute("data-overdue")).toBe(false);
    const red = [...tail().querySelectorAll("[data-overdue]")];
    expect(red.map((node) => node.textContent)).toEqual(["11 Sep"]);
    // A FIRED CLOCK IS ONE STEP UP FROM A PENDING ONE. The rule used to
    // restate `--ink-3`, which is the caption's base, so the attribute was a
    // signal with no drawing behind it and a reminder that had already spoken
    // read exactly like one still waiting. One step, not full ink and not
    // red: red belongs to the overdue deadline and a section with two reds
    // has none.
    expect(ruleFor(css, ".brain-task-caption[data-fired]")).toContain(
      "color: var(--ink-2)",
    );
    expect(ruleFor(css, ".brain-task-caption")).toContain("color: var(--ink-3)");
    expect(ruleFor(css, ".brain-task-caption[data-overdue]")).toContain(
      "color: var(--red)",
    );
  });

  it("says nothing about a fired reminder once the task is done", async () => {
    await renderRows([
      task("a", {
        when: TODAY,
        time: "13:00",
        remindedAt: `${TODAY}T12:00:00.000Z`,
        done: true,
        doneAt: `${TODAY}T13:05:00.000Z`,
      }),
    ]);
    expect(tail().querySelector("[data-fired]")).toBeNull();
  });

  it("shows one clock on a done row, the one it was finished at", async () => {
    // Two clocks side by side made the reader work out which was which. The
    // hour it was due at is what the strike is drawn over.
    await renderRows([
      task("a", {
        when: TODAY,
        time: "13:00",
        done: true,
        doneAt: `${TODAY}T12:25:00.000Z`,
      }),
    ]);
    expect(tail().querySelector("[data-time]")).toBeNull();
    // ONE CLOCK SHAPE IN THE COLUMN. A pending row prints the `HH:MM` the
    // file holds, so a done row prints `HH:MM` too. It used to go through
    // `Intl` and print `12:25 PM` on an en-US machine, four rows under an
    // `18:00`.
    expect(tail().textContent).toBe("12:25");
    expect(tail().textContent).toBe(doneTimeOf(`${TODAY}T12:25:00.000Z`, 0));
  });

  it("says nothing at all on a done row with no instant to report", async () => {
    await renderRows([task("a", { when: TODAY, time: "13:00", done: true })]);
    expect(tail().textContent).toBe("");
  });

  /** I10. THE TAIL HAS A COLUMN.
   *
   *  The glyphs are a slot, drawn on every row whether or not the row has a
   *  glyph for it. Without it the tail was a flex whose last child was flush,
   *  so a row carrying `restart` put its clock 22px left of where a row
   *  without one put its own, in the same list, on the axis a reader scans. */
  it("reserves the glyph slot on every row, with a glyph and without one", async () => {
    await renderRows([task("a", { when: TODAY, time: "13:00" })]);
    const bare = tail().querySelector(".brain-task-glyphs") as HTMLElement;
    expect(bare).not.toBeNull();
    expect(glyphs(bare)).toEqual([]);

    await renderRows([
      task("b", { when: TODAY, time: "13:00", repeat: { freq: "daily" } }),
    ]);
    const carried = tail().querySelector(".brain-task-glyphs") as HTMLElement;
    expect(glyphs(carried)).toEqual(["restart-linear"]);

    const rule = ruleFor(css, ".brain-task-glyphs");
    expect(rule).toContain("min-width: 16px");
    expect(rule).toContain("flex-shrink: 0");
    expect(rule).toContain("justify-content: flex-end");
  });

  it("hovers the tail only on a row that answers a hover", () => {
    const rule = ruleFor(
      css,
      "  .brain-task-row:not(:where([data-done], [data-historic])):hover .brain-task-tail",
    );
    expect(rule).toContain("color: var(--ink-2)");
  });
});
