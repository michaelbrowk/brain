// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";
import type { TaskView } from "@/lib/tasks/model";
import { planTaskMove, type TaskMoveInput } from "@/lib/tasks/order";
import type { ToastOptions } from "./ui/primitives";
import type { TaskDropIntent } from "./tasks-drag-intent";

vi.mock("@/lib/client", () => ({ apiFetch: vi.fn(), CLIENT_ID: "test-client" }));
vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));
vi.mock("./tasks-drag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tasks-drag")>();
  return { ...actual, TasksDragProvider: (props: Parameters<typeof actual.TasksDragProvider>[0]) => {
    moveFromDrag = props.onMove;
    return <actual.TasksDragProvider {...props} />;
  } };
});
const { TasksSurface } = await import("./tasks-surface");
const { localDay, resetTasksStore, mutateTasks } = await import("./tasks-client");
const api = vi.mocked(apiFetch);
const now = new Date("2026-11-11T12:00:00Z");
const today = localDay(now).today;
const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({ id, title: id, done: false, created: "2026-11-01T10:00:00Z", updated: "2026-11-01T10:00:00Z", category: "Work", when: today, ...extra });
let host: HTMLDivElement, root: Root, records: TaskView[], writes: { id: string; input: TaskMoveInput }[], toasts: { title: string; options?: ToastOptions }[];
let finish: ((status?: number) => void) | null;
let paused: boolean;
let reloadPaused: boolean;
let finishReloads: (() => void)[];
let moveFromDrag: (id: string, intent: TaskDropIntent) => void;
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
const titles = () => [...host.querySelectorAll(".tasks-compact-title")].map((node) => node.textContent);
async function mount(items: TaskView[], options: { hiddenIds?: string[] } = {}) {
  records = items;
  const hiddenIds = new Set(options.hiddenIds);
  api.mockImplementation(async (url, init) => {
    if (String(url).startsWith("/api/tasks?")) {
      const tasks = records.filter((entry) => !hiddenIds.has(entry.id));
      return reloadPaused ? new Promise<Response>((resolve) => finishReloads.push(() => resolve(response({ tasks })))) : response({ tasks });
    }
    if (url === "/api/task-categories") return response({ categories: [{ name: "Work" }, { name: "Empty" }] });
    const id = String(url).match(/^\/api\/tasks\/([^/]+)\/move$/)?.[1];
    if (id) {
      const input = JSON.parse(String(init?.body)) as TaskMoveInput; writes.push({ id, input });
      const status = paused ? await new Promise<number>((resolve) => { finish = (status = 200) => resolve(status); }) : 200;
      if (status !== 200) return response({ reason: "Move refused" }, status);
      const result = planTaskMove(records, id, input); records = result.tasks;
      return response({ task: result.task });
    }
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  await act(async () => root.render(<TasksSurface list="today" onToast={(title, options) => toasts.push({ title, options })} />)); await settle();
}
async function reorder(id: string, direction: "ArrowUp" | "ArrowDown") {
  const target = host.querySelector<HTMLButtonElement>(`[data-row-key="${id}"] .tasks-compact-open`)!;
  await act(async () => { target.focus(); target.dispatchEvent(new KeyboardEvent("keydown", { key: direction, code: direction, altKey: true, shiftKey: true, bubbles: true, cancelable: true })); });
  await settle();
}
async function drop(id: string, category: string, beforeId: string | null) {
  await act(async () => moveFromDrag(id, { category, beforeId, targetId: beforeId ? `row:${beforeId}` : `category:${category}` }));
  await settle();
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("PointerEvent", MouseEvent); HTMLElement.prototype.scrollIntoView = vi.fn();
  resetTasksStore(); api.mockReset(); records = []; writes = []; toasts = []; finish = null; paused = false; reloadPaused = false; finishReloads = [];
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetTasksStore(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("persisted Tasks reordering", () => {
  it("optimistically reorders, serializes pending moves, then exposes one working Undo", async () => {
    await mount([task("a"), task("b"), task("c")]); paused = true;
    await reorder("c", "ArrowUp"); expect(titles()).toEqual(["a", "c", "b"]); expect(writes).toHaveLength(1);
    await reorder("c", "ArrowUp"); expect(writes).toHaveLength(1); expect(toasts).toHaveLength(0);
    paused = false; await act(async () => finish?.()); await settle(); expect(toasts).toHaveLength(1); expect(toasts[0].title).toBe("Task moved");
    await act(async () => toasts[0].options?.onAction?.()); await settle();
    expect(titles()).toEqual(["a", "b", "c"]); expect(writes).toHaveLength(2); expect(toasts[1].title).toBe("Move undone");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("c moved");
  });
  it("refuses stale Undo after a later placement instead of overwriting it", async () => {
    await mount([task("a"), task("b")]); await reorder("b", "ArrowUp");
    const undo = toasts[0].options?.onAction;
    records = records.map((task) => task.id === "b" ? { ...task, category: "Other", order: "z0" } : task);
    await act(async () => mutateTasks((tasks) => tasks.map((task) => task.id === "b" ? { ...task, category: "Other", order: "z0" } : task)));
    await act(async () => undo?.()); await settle();
    expect(writes).toHaveLength(1);
    expect(records.find((task) => task.id === "b")).toMatchObject({ category: "Other", order: "z0" });
    expect(toasts[1]).toMatchObject({ title: "This task changed. Its move can no longer be undone.", options: { urgent: true } });
  });
  it.each(["before", "after"])("keeps a coherent order and supports Undo %s a reload with different server ranks", async (undoWhen) => {
    await mount([
      task("old", { order: "a0", done: true, doneAt: "2026-09-01T10:00:00Z" }),
      task("a", { order: "a1", created: "2026-11-03T10:00:00Z" }),
      task("b", { order: "a2", created: "2026-11-02T10:00:00Z" }),
      task("c", { order: "a3", created: "2026-11-01T10:00:00Z" }),
    ], { hiddenIds: ["old"] });
    expect(titles()).toEqual(["a", "b", "c"]);
    reloadPaused = true;
    await drop("a", "Work", "c");
    // The visible optimistic ranks are b:a0,a:a1,c:a2, while the server also
    // ranks the hidden completion and returns a:a2. Mixing just that saved
    // rank into the visible set would place c before a until GET finishes.
    expect(records.find((entry) => entry.id === "a")?.order).toBe("a2");
    expect(finishReloads).toHaveLength(1);
    expect(titles()).toEqual(["b", "a", "c"]);
    if (undoWhen === "after") {
      reloadPaused = false;
      await act(async () => finishReloads.splice(0).forEach((finish) => finish())); await settle();
      expect(titles()).toEqual(["b", "a", "c"]);
    }
    await act(async () => toasts[0].options?.onAction?.()); await settle();
    expect(writes[1]).toEqual({ id: "a", input: { category: "Work", beforeId: "b", today } });
    expect(titles()).toEqual(["a", "b", "c"]);
    expect(toasts[1].title).toBe("Move undone");
    reloadPaused = false;
    await act(async () => finishReloads.splice(0).forEach((finish) => finish())); await settle();
    expect(titles()).toEqual(["a", "b", "c"]);
  });
  it("refuses stale Undo when a later sibling move changes order but retains the moved task's rank", async () => {
    await mount([task("a", { order: "a0" }), task("b", { order: "a1" }), task("c", { order: "a2" })]);
    await drop("a", "Work", "c");
    const undo = toasts[0].options?.onAction;
    expect(titles()).toEqual(["b", "a", "c"]);
    records = records.map((entry) => entry.id === "b" ? { ...entry, order: "a3" } : entry);
    await act(async () => mutateTasks((tasks) => tasks.map((entry) => entry.id === "b" ? { ...entry, order: "a3" } : entry)));
    expect(titles()).toEqual(["a", "c", "b"]);
    await act(async () => undo?.()); await settle();
    expect(writes).toHaveLength(1);
    expect(titles()).toEqual(["a", "c", "b"]);
    expect(toasts[1]).toMatchObject({ title: "This task changed. Its move can no longer be undone.", options: { urgent: true } });
  });
  it("undoes a same-category move to the exact position before an inline completion", async () => {
    await mount([task("a", { order: "a0" }), task("done", { order: "a1", done: true, doneAt: now.toISOString() }), task("b", { order: "a2" })]);
    await reorder("a", "ArrowDown");
    expect(titles()).toEqual(["done", "b", "a"]);
    await act(async () => toasts[0].options?.onAction?.()); await settle();
    expect(writes[1]).toEqual({ id: "a", input: { category: "Work", beforeId: "done", today } });
    expect(titles()).toEqual(["a", "done", "b"]);
    expect(toasts[1].title).toBe("Move undone");
  });
  it("undoes a cross-category drop to the exact position before an inline completion", async () => {
    await mount([task("a", { order: "a0" }), task("done", { order: "a1", done: true, doneAt: now.toISOString() }), task("b", { order: "a2" }), task("other", { category: "Empty", order: "a0" })]);
    await drop("a", "Empty", null);
    expect(records.find((entry) => entry.id === "a")?.category).toBe("Empty");
    await act(async () => toasts[0].options?.onAction?.()); await settle();
    expect(writes[1]).toEqual({ id: "a", input: { category: "Work", beforeId: "done", today } });
    expect(records.find((entry) => entry.id === "a")?.category).toBe("Work");
    expect(titles()).toEqual(["a", "done", "b", "other"]);
    expect(toasts[1].title).toBe("Move undone");
  });
  it("persists a drop across only a completed sibling and can undo it", async () => {
    await mount([task("a", { order: "a0" }), task("done", { order: "a1", done: true, doneAt: now.toISOString() }), task("b", { order: "a2" })]);
    await drop("a", "Work", "b");
    expect(writes).toEqual([{ id: "a", input: { category: "Work", beforeId: "b", today } }]);
    expect(titles()).toEqual(["done", "a", "b"]);
    await act(async () => toasts[0].options?.onAction?.()); await settle();
    expect(writes[1]).toEqual({ id: "a", input: { category: "Work", beforeId: "done", today } });
    expect(titles()).toEqual(["a", "done", "b"]);
  });
  it("keeps future hidden tasks in relative order and never changes dates", async () => {
    await mount([task("a", { order: "a0" }), task("hidden", { when: "2026-12-01", order: "a1" }), task("b", { order: "a2" }), task("c", { order: "a3" })]);
    await reorder("c", "ArrowUp"); expect(titles()).toEqual(["a", "c", "b"]);
    expect(writes).toEqual([{ id: "c", input: { category: "Work", beforeId: "b", today } }]);
    expect(records.find((task) => task.id === "hidden")?.when).toBe("2026-12-01");
    expect(records.find((task) => task.id === "c")?.when).toBe(today);
  });
  it("rolls back a refused move while preserving a concurrent title change", async () => {
    await mount([task("a"), task("b")]); paused = true;
    await reorder("b", "ArrowUp"); expect(titles()).toEqual(["b", "a"]);
    records = records.map((task) => task.id === "b" ? { ...task, title: "Edited while saving" } : task);
    await act(async () => mutateTasks((tasks) => tasks.map((task) => task.id === "b" ? { ...task, title: "Edited while saving" } : task)));
    await act(async () => finish?.(503)); await settle();
    expect(titles()).toEqual(["a", "Edited while saving"]); expect(toasts).toHaveLength(1); expect(toasts[0]).toMatchObject({ title: "Move refused", options: { urgent: true } });
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Task move could not be saved.");
  });
  it("does not mix category ranks when deciding group order", async () => {
    await mount([task("first", { category: "Work", order: "z0", created: "2026-10-01T10:00:00Z" }), task("second", { category: "Personal", order: "a0", created: "2026-10-02T10:00:00Z" }), task("third", { category: "Work", order: "a0", created: "2026-10-03T10:00:00Z" })]);
    expect([...host.querySelectorAll("h2")].map((node) => node.textContent)).toEqual(["Work", "Personal"]);
    expect(titles()).toEqual(["third", "first", "second"]);
  });
  it("does not write when the requested keyboard move is beyond the category boundary", async () => {
    await mount([task("a"), task("b")]); await reorder("a", "ArrowUp"); await reorder("b", "ArrowDown"); expect(writes).toHaveLength(0); expect(toasts).toHaveLength(0);
    expect([...host.querySelectorAll('[aria-label="Task categories"] button')].some((node) => node.textContent === "No category")).toBe(true);
  });
  it("reorders only open siblings without dropping an inline completion from the category order", async () => {
    await mount([task("a", { order: "a0" }), task("done", { order: "a1", done: true, doneAt: now.toISOString() }), task("b", { order: "a2" })]);
    expect(titles()).toEqual(["a", "done", "b"]);
    await reorder("done", "ArrowUp"); await reorder("b", "ArrowDown");
    expect(writes).toHaveLength(0); expect(toasts).toHaveLength(0);
    await reorder("a", "ArrowDown");
    expect(writes).toEqual([{ id: "a", input: { category: "Work", beforeId: null, today } }]);
    expect(titles()).toEqual(["done", "b", "a"]);
    expect(records.find((entry) => entry.id === "done")).toMatchObject({ done: true, doneAt: now.toISOString() });
    expect(records.find((entry) => entry.id === "done")?.order).toBeDefined();
    await reorder("a", "ArrowUp");
    expect(writes[1]).toEqual({ id: "a", input: { category: "Work", beforeId: "b", today } });
    expect(titles()).toEqual(["done", "a", "b"]);
  });
});
