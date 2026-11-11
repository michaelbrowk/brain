// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskView } from "@/lib/tasks/model";
import type { ToastOptions } from "./ui/primitives";
import { useTaskActions, type TaskActions } from "./tasks-actions";

const mocks = vi.hoisted(() => ({ patchTask: vi.fn(), reloadTasks: vi.fn(), records: [] as TaskView[] }));
vi.mock("./tasks-client", () => ({
  patchTask: mocks.patchTask,
  reloadTasks: mocks.reloadTasks,
  liveTask: (id: string) => mocks.records.find((task) => task.id === id),
  mutateTasks: (update: (tasks: readonly TaskView[]) => TaskView[]) => { mocks.records = update(mocks.records); },
  TaskRequestError: class extends Error {},
}));
const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({ id, title: id, done: false, created: "2026-11-11T08:00:00Z", updated: "2026-11-11T08:00:00Z", ...extra });
let root: Root;
let host: HTMLDivElement;
let actions: TaskActions;
const toasts: {title: string; options?: ToastOptions}[] = [];
const onToast = (title: string, options?: ToastOptions) => { toasts.push({title, options}); };
function Capture() {
  const captured = useTaskActions({ today: "2026-11-11", offsetMinutes: 240, onToast });
  useEffect(() => { actions = captured; }, [captured]);
  return null;
}
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); mocks.records = []; toasts.length = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Capture />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function undo() { await act(async () => { toasts.at(-1)?.options?.onAction?.(); await Promise.resolve(); await Promise.resolve(); }); }

describe("category completion snapshot", () => {
  it("completes each open id once, including future and linked tasks, and advances a repeat only once", async () => {
    const plain = task("plain", {when: "2026-12-01"});
    const linked = task("linked", {page: "source"});
    const repeat = task("repeat", {when: "2026-11-11", repeat: {freq: "daily"}});
    mocks.records = [plain, linked, repeat, task("done", {done: true})];
    mocks.patchTask.mockImplementation(async (id, patch) => ({...mocks.records.find(t => t.id === id), ...patch, ...(id === "repeat" ? {done: false, when: "2026-11-12"} : {})}));
    await act(async () => actions.completeTasks([...mocks.records, plain]));
    expect(mocks.patchTask.mock.calls).toEqual([
      ["plain", {done: true}, undefined], ["linked", {done: true}, undefined],
      ["repeat", {done: true, expectedWhen: "2026-11-11"}, "2026-11-11"],
    ]);
    expect(toasts.at(-1)).toMatchObject({title: "3 tasks completed", options: {actionLabel: "Undo"}});
    expect(new Set(toasts.map(t => t.options?.id)).size).toBe(1);
    expect(mocks.records.find(t => t.id === "repeat")).toMatchObject({done: false, when: "2026-11-12"});
    mocks.patchTask.mockClear();
    await undo();
    expect(mocks.patchTask.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ["plain", {done: false}], ["linked", {done: false}], ["repeat", {done: false, expectedWhen: "2026-11-12"}],
    ]);
  });

  it("reports partial failure, continues the captured set, and undoes only successful writes", async () => {
    mocks.records = [task("first"), task("failed"), task("last")];
    mocks.patchTask.mockImplementation(async (id, patch) => {
      if (id === "failed") throw new Error("source page unavailable");
      return {...mocks.records.find(t => t.id === id), ...patch};
    });
    await act(async () => actions.completeTasks(mocks.records));
    expect(toasts.at(-1)).toMatchObject({title: "2 tasks completed · 1 couldn’t be completed", options: {urgent: true, actionLabel: "Undo"}});
    expect(mocks.reloadTasks).toHaveBeenCalledTimes(1);
    mocks.patchTask.mockClear(); await undo();
    expect(mocks.patchTask.mock.calls.map(call => call[0])).toEqual(["first", "last"]);
    expect(toasts.at(-1)?.title).toBe("2 tasks restored");
  });

  it("guards duplicate invocation while requests are pending", async () => {
    const entry = task("once"); mocks.records = [entry];
    let finish!: (task: TaskView) => void;
    mocks.patchTask.mockImplementation(() => new Promise<TaskView>(resolve => { finish = resolve; }));
    await act(async () => {
      const first = actions.completeTasks([entry]);
      await actions.completeTasks([entry]);
      expect(mocks.patchTask).toHaveBeenCalledTimes(1);
      finish({...entry, done: true}); await first;
    });
  });

  it("does not silently undo a newer repeat occurrence or report a failed undo as success", async () => {
    const entry = task("repeat", {when: "2026-11-11", repeat: {freq: "daily"}}); mocks.records = [entry];
    mocks.patchTask.mockResolvedValueOnce({...entry, when: "2026-11-12"});
    await act(async () => actions.completeTasks([entry]));
    mocks.records = [{...entry, when: "2026-11-13"}];
    mocks.patchTask.mockRejectedValueOnce(new Error("stale expectedWhen"));
    await undo();
    expect(mocks.patchTask).toHaveBeenLastCalledWith("repeat", {done: false, expectedWhen: "2026-11-12"});
    expect(toasts.at(-1)).toMatchObject({title: "0 tasks restored · 1 couldn’t be restored", options: {urgent: true}});
    expect(mocks.reloadTasks).toHaveBeenCalledTimes(1);
  });

  it("leaves an already-completed or empty set unchanged", async () => {
    await act(async () => actions.completeTasks([task("done", {done: true})]));
    expect(mocks.patchTask).not.toHaveBeenCalled(); expect(toasts).toHaveLength(0);
  });
});
