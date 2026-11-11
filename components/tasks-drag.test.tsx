// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskView } from "@/lib/tasks/model";
import { TasksDragProvider, TasksCategoryDrop, useTaskCategoryDrop } from "./tasks-drag";
import { TasksCompactRow } from "./tasks-compact-row";

const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({ id, title: id, done: false, created: "2026-11-01T10:00:00Z", updated: "2026-11-01T10:00:00Z", category: "Work", ...extra });
const tasks = [task("a"), task("b")];
let host: HTMLDivElement, root: Root;
const move = vi.fn(), open = vi.fn(), complete = vi.fn(async () => {}), select = vi.fn(), expand = vi.fn();
const box = (left: number, top: number, width: number, height: number): DOMRect => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
function Rail() {
  const { setNodeRef, dropInto } = useTaskCategoryDrop("Empty", "rail");
  return <button ref={setNodeRef} data-rail data-drop-into={dropInto ? "" : undefined}>Empty</button>;
}
function Harness({ items = tasks, historic = false }: { items?: TaskView[]; historic?: boolean }) {
  const [dragging, setDragging] = useState(false);
  const row = (entry: TaskView, key = entry.id) => <TasksCompactRow key={key} task={entry} rowKey={key} historic={historic} today="2026-11-11" offsetMinutes={0} selected={false} reduce onOpen={open} onSelect={select} onComplete={complete} onReopen={complete} />;
  return <TasksDragProvider tasks={items.filter((entry) => !entry.done)} disabled={false} onMove={move} onActiveChange={setDragging} onExpandCategory={expand} renderOverlay={(entry) => <span>{entry.title}</span>}><div data-surface data-dragging={dragging ? "" : undefined}><Rail /><TasksCategoryDrop category="Work"><ul>{items.map((entry) => row(entry, historic ? `${entry.id}@history` : entry.id))}</ul></TasksCategoryDrop></div></TasksDragProvider>;
}
const rowButton = (id = "a") => host.querySelector<HTMLButtonElement>(`[data-task-id="${id}"] .tasks-compact-open`)!;
const active = () => host.querySelector("[data-surface][data-dragging]") !== null;
async function dispatch(target: EventTarget, event: Event) { await act(async () => target.dispatchEvent(event)); }
async function advance(ms: number) { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); }
async function mouse(type: string, x = 200, y = 120, target: EventTarget = document, extras: MouseEventInit = {}) { await dispatch(target, new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...extras })); }
async function touch(type: "touchstart" | "touchmove" | "touchend", x: number, y: number, target: EventTarget = rowButton()) {
  const finger = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y } as Touch;
  const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [finger], changedTouches: [finger], targetTouches: type === "touchend" ? [] : [finger] });
  await dispatch(target, event); return event;
}
async function pointer(type: string, pointerType: "touch" | "mouse", target = rowButton()) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 200, clientY: 120, button: 0 });
  Object.defineProperty(event, "pointerType", { value: pointerType }); await dispatch(target, event);
}
async function mount(items = tasks, historic = false) { await act(async () => root.render(<Harness items={items} historic={historic} />)); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
    if (id) return box(100, id === "a" ? 100 : 144, 400, 44);
    if (this.hasAttribute("data-rail")) return box(10, 100, 70, 40);
    if (this.classList.contains("tasks-workspace-group")) return box(100, 80, 400, 120);
    return box(0, 0, 600, 400);
  });
  move.mockClear(); open.mockClear(); complete.mockClear(); select.mockClear(); expand.mockClear();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); vi.advanceTimersByTime(60); }); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("task hold gesture", () => {
  it("keeps a quick click and the checkbox independent from dragging", async () => {
    await mount(); await mouse("mousedown", 200, 120, rowButton()); await mouse("mouseup");
    await dispatch(rowButton(), new MouseEvent("click", { bubbles: true }));
    expect(active()).toBe(false); expect(open).toHaveBeenCalledTimes(1); expect(move).not.toHaveBeenCalled();
    const checkbox = host.querySelector<HTMLElement>('[role="checkbox"]')!;
    await mouse("mousedown", 110, 120, checkbox); await advance(250); expect(active()).toBe(false);
    await mouse("mouseup"); await dispatch(checkbox, new MouseEvent("click", { bubbles: true })); expect(complete).toHaveBeenCalledTimes(1);
  });
  it("activates at 220ms, keeps its slot and cancels a stationary release", async () => {
    await mount(); await mouse("mousedown", 200, 120, rowButton()); await advance(219); expect(active()).toBe(false);
    await advance(1); expect(active()).toBe(true); expect(host.querySelector('[data-task-id="a"][data-dragging]')).not.toBeNull();
    expect(host.querySelectorAll(".tasks-compact-item")).toHaveLength(2);
    expect(document.querySelector('[data-testid="tasks-drag-overlay"][inert][aria-hidden="true"]')).not.toBeNull();
    await mouse("mouseup"); expect(active()).toBe(false); expect(move).not.toHaveBeenCalled();
  });
  it("moves after a target row and suppresses the release click", async () => {
    await mount(); await mouse("mousedown", 200, 120, rowButton()); await advance(220);
    await mouse("mousemove", 200, 180); await mouse("mouseup", 200, 180);
    await dispatch(rowButton(), new MouseEvent("click", { bubbles: true }));
    expect(move).toHaveBeenCalledWith("a", expect.objectContaining({ category: "Work", beforeId: null, edge: "after" })); expect(open).not.toHaveBeenCalled();
  });
  it("keeps the full boundary and leading gutter marker pinned to the target while it scrolls", async () => {
    await mount(); await mouse("mousedown", 200, 120, rowButton()); await advance(220);
    await mouse("mousemove", 200, 180);
    const cue = document.querySelector<HTMLElement>(".tasks-drag-insertion")!;
    const overlay = document.querySelector('[data-testid="tasks-drag-overlay"]')!;
    const marker = document.querySelector<HTMLElement>(".tasks-drag-marker")!;
    expect(cue.parentElement).toBe(document.body);
    expect(marker.parentElement).toBe(document.body);
    expect(overlay.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll(".tree-insert[data-edge]")).toHaveLength(1);
    expect(cue.querySelector(".tree-insert")?.getAttribute("data-edge")).toBe("after");
    expect([cue.style.left, cue.style.top, cue.style.width, cue.style.height]).toEqual(["100px", "144px", "400px", "44px"]);
    expect([marker.style.left, marker.style.top, marker.style.width]).toEqual(["88px", "187px", "12px"]);
    vi.spyOn(host.querySelector<HTMLElement>('[data-task-id="b"]')!, "getBoundingClientRect").mockReturnValue(box(100, 114, 400, 44));
    await advance(20);
    expect(cue.style.top).toBe("114px");
    expect(marker.style.top).toBe("157px");
    vi.spyOn(host.querySelector<HTMLElement>('[data-task-id="b"]')!, "getBoundingClientRect").mockReturnValue(box(16, 114, 320, 44));
    await advance(20);
    expect([marker.style.left, marker.style.width]).toEqual(["4px", "12px"]);
    await mouse("mouseup", 200, 180); expect(document.querySelector(".tasks-drag-insertion")).toBeNull();
  });
  it("keeps a completed task's detail button enabled without draggable semantics", async () => {
    await mount([task("a", { done: true })]);
    const button = rowButton();
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.hasAttribute("aria-roledescription")).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    await dispatch(button, new MouseEvent("click", { bubbles: true })); expect(open).toHaveBeenCalledTimes(1);
    await mouse("mousedown", 200, 120, button); await advance(250); expect(active()).toBe(false);
    await mouse("mouseup"); expect(move).not.toHaveBeenCalled();
  });
  it("clamps only preview X continuously while the raw pointer still chooses a rail category", async () => {
    await mount(); await mouse("mousedown", 200, 120, rowButton()); await advance(220);
    const preview = () => document.querySelector<HTMLElement>('[data-testid="tasks-drag-overlay"]')!.parentElement!.style.transform;
    await mouse("mousemove", 240, 132);
    expect(preview()).toContain("translate3d(40px, 12px, 0)");
    // The clamp applies before entering the rail too, without a target-driven jump.
    await mouse("mousemove", 180, 132);
    expect(preview()).toContain("translate3d(0px, 12px, 0)");
    await mouse("mousemove", 40, 128);
    expect(preview()).toContain("translate3d(0px, 8px, 0)");
    expect(host.querySelector("[data-rail][data-drop-into]")).not.toBeNull();
    await mouse("mouseup", 40, 128);
    expect(move).toHaveBeenCalledWith("a", expect.objectContaining({ category: "Empty", beforeId: null }));
  });
  it("uses only actual category targets and cancels outside the Tasks targets", async () => {
    await mount(); await mouse("mousedown", 200, 120, rowButton()); await advance(220);
    await mouse("mousemove", 40, 120); expect(host.querySelector("[data-rail][data-drop-into]")).not.toBeNull();
    await mouse("mouseup", 40, 120); expect(move).toHaveBeenCalledWith("a", expect.objectContaining({ category: "Empty", beforeId: null }));
    await advance(60); move.mockClear(); await mouse("mousedown", 200, 120, rowButton()); await advance(220);
    await mouse("mousemove", 550, 300); await mouse("mouseup", 550, 300); expect(move).not.toHaveBeenCalled();
  });
  it("Escape cancels a moved drag", async () => {
    await mount(); await mouse("mousedown", 200, 120, rowButton()); await advance(220); await mouse("mousemove", 200, 180);
    await dispatch(document, new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    expect(active()).toBe(false); expect(move).not.toHaveBeenCalled();
  });
  it("never starts with right-click, ctrl-click, completed, or history rows", async () => {
    await mount(); await mouse("mousedown", 200, 120, rowButton(), { button: 2 }); await advance(250); expect(active()).toBe(false);
    await mouse("mouseup"); await mouse("mousedown", 200, 120, rowButton(), { ctrlKey: true }); await advance(250); expect(active()).toBe(false);
    await mouse("mouseup"); await mount([task("a", { done: true })]); await mouse("mousedown", 200, 120, rowButton()); await advance(250); expect(active()).toBe(false);
    await mouse("mouseup"); await mount([task("a")], true); await mouse("mousedown", 200, 120, rowButton()); await advance(250); expect(active()).toBe(false);
  });
  it("allows a fast touch scroll without preventing its native movement or starting a drag", async () => {
    await mount(); await pointer("pointerdown", "touch"); await touch("touchstart", 200, 120);
    await advance(40); const movement = await touch("touchmove", 200, 145); await pointer("pointermove", "touch"); await advance(800);
    expect(movement.defaultPrevented).toBe(false); expect(active()).toBe(false); expect(document.querySelector('[role="menu"]')).toBeNull();
    await touch("touchend", 200, 145); expect(move).not.toHaveBeenCalled();
  });
  it("keeps Radix's long-press menu closed during touch dragging", async () => {
    await mount(); await pointer("pointerdown", "touch"); await touch("touchstart", 200, 120); await advance(220); expect(active()).toBe(true);
    await advance(600); expect(document.querySelector('[role="menu"]')).toBeNull();
    const movement = await touch("touchmove", 200, 180); expect(movement.defaultPrevented).toBe(true);
    await touch("touchend", 200, 180); expect(move).toHaveBeenCalledWith("a", expect.objectContaining({ beforeId: null, edge: "after" }));
  });
});
