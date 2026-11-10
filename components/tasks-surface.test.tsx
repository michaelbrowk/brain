// @vitest-environment jsdom

// The approved popup replaces inline capture/editing. These cases keep the
// task-store, source, keyboard and recurrence contracts while asserting the
// new navigation, draft and completion surfaces.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";
import type { TaskView } from "@/lib/tasks/model";
import type { TasksSurfaceProps } from "./tasks-surface";
import type { ToastOptions } from "./ui/primitives";

vi.mock("@/lib/client", () => ({ apiFetch: vi.fn(), CLIENT_ID: "test-client" }));
vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));
const { TasksSurface, emptyFor } = await import("./tasks-surface");
const { localDay, resetTasksStore, mutateTasks } = await import("./tasks-client");
const { emitTaskCommand } = await import("./tasks-commands");
const api = vi.mocked(apiFetch);
const NOON = new Date("2026-09-13T12:00:00.000Z");
const TODAY = localDay(NOON).today;
const pages = [{ id: "page-1", title: "Product brief", path: "Work / Product", icon: "🎁" }, { id: "page-2", title: "Research notes", path: "Work / Research", icon: "🔎" }];
let host: HTMLDivElement, root: Root, token = 0;
let records: TaskView[], categories: { name: string; icon?: string }[], bodies: Map<string, string>;
let detailOverride: Partial<TaskView> | undefined;
let detailFailure = false, patchFailure = false;
let writes: { url: string; method: string; body: Record<string, unknown> }[];
let toasts: { title: string; options?: ToastOptions }[];
function task(id: string, extra: Partial<TaskView> = {}): TaskView { return { id, title: id, created: "2026-09-01T09:00:00.000Z", updated: "2026-09-01T09:00:00.000Z", done: false, ...extra }; }
function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
function Harness(props: TasksSurfaceProps) { const [list, setList] = useState(props.list || null); return <TasksSurface {...props} list={list} onSelectList={setList} />; }
async function mount(items: TaskView[], props: Partial<TasksSurfaceProps> = {}) {
  records = items; bodies = new Map(items.map((entry) => [entry.id, "Original notes"]));
  api.mockImplementation(async (input, init) => {
    const url = String(input), method = init?.method || "GET";
    if (url.startsWith("/api/tasks?")) return response({ tasks: records });
    if (url === "/api/task-categories") {
      if (method === "GET") return response({ categories });
      const body = JSON.parse(String(init?.body)) as { name: string; icon?: string };
      const name = body.name.trim().replace(/\s+/g, " ");
      const saved = categories.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) || { name, icon: body.icon };
      if (!categories.includes(saved)) categories.push(saved);
      writes.push({ url, method, body }); return response({ category: saved });
    }
    if (url === "/api/tasks" && method === "POST") {
      const body = JSON.parse(String(init?.body)); writes.push({ url, method, body });
      const saved = task("created", body); records = [saved, ...records]; bodies.set(saved.id, body.body || ""); return response({ task: saved });
    }
    const id = url.match(/^\/api\/tasks\/([^?]+)/)?.[1];
    if (id) {
      const original = records.find((entry) => entry.id === id)!;
      if (method === "GET") return detailFailure ? response({ reason: "Notes unavailable" }, 503) : response({ task: { ...original, ...detailOverride }, body: bodies.get(id) || "", bodyRev: "rev-1" });
      const body = method === "DELETE" ? {} : JSON.parse(String(init?.body)); writes.push({ url, method, body });
      if (patchFailure) return response({ reason: "This task changed. Reopen it before saving." }, 409);
      if (method === "DELETE") { records = records.filter((entry) => entry.id !== id); return response({ ok: true }); }
      const saved = { ...original, ...body, ...(body.done === true ? { doneAt: NOON.toISOString() } : {}) };
      for (const key of Object.keys(saved)) if (saved[key] === null) delete saved[key];
      records = records.map((entry) => entry.id === id ? saved : entry);
      if (body.body !== undefined) bodies.set(id, body.body);
      return response({ task: saved });
    }
    throw new Error(`Unexpected API: ${method} ${url}`);
  });
  await act(async () => root.render(<Harness refreshToken={++token} pages={pages} onToast={(title, options) => toasts.push({ title, options })} {...props} />)); await settle();
}
const el = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === text)!;
async function click(node: HTMLElement) { expect(node).toBeTruthy(); await act(async () => node.click()); await settle(); }
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function key(value: string, target: EventTarget = window, options: KeyboardEventInit = {}) { await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }))); await settle(); }
async function open(id = "a") { await click(el(`[data-task-id="${id}"] .tasks-compact-open`)); }
async function save() { await click(el(".tasks-detail-primary-desktop")); }
const title = () => el<HTMLTextAreaElement>('[aria-label="Task title"]');
const notes = () => el<HTMLTextAreaElement>('[aria-label="Task notes"]');
const patches = () => writes.filter((write) => write.method === "PATCH");
const rowTitles = () => [...host.querySelectorAll(".tasks-compact-title")].map((node) => node.textContent);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOON);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("PointerEvent", MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  categories = [{ name: "Work", icon: "🎬" }, { name: "Personal" }]; writes = []; toasts = []; detailOverride = undefined; detailFailure = false; patchFailure = false;
  resetTasksStore(); api.mockReset(); window.history.replaceState(null, "", "/tasks");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetTasksStore(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("category navigation and list membership", () => {
  it("draws four count-free navigation views and preserves the blank rail heading", async () => { await mount([task("a", { when: TODAY })]); expect([...host.querySelectorAll(".tasks-rail-views .tree-row-title")].map((node) => node.textContent)).toEqual(["Inbox", "Today", "Upcoming", "All tasks"]); expect(el(".tasks-rail-spacer").textContent).toBe(""); expect(host.querySelector(".tasks-rail .tree-row-count")).toBeNull(); expect(host.querySelector(".brain-page-meta")).toBeNull(); });
  it("includes planned and deadline-overdue tasks exactly once in Today", async () => { await mount([task("both", { when: "2026-09-10", deadline: "2026-09-11" }), task("due", { deadline: TODAY }), task("future", { when: "2026-10-01" }), task("someday", { when: "someday" })]); expect(rowTitles()).toEqual(["both", "due"]); expect(host.querySelector('[data-task-id="both"] [data-overdue]')).not.toBeNull(); });
  it("groups Inbox and Upcoming by category without repeating category metadata", async () => { await mount([task("a", { category: "Work" }), task("b", { category: "Personal" })], { list: "inbox" }); expect([...host.querySelectorAll("h2")].map((node) => node.textContent)).toEqual(["Work", "Personal"]); expect(host.querySelector('[data-task-id="a"] .tasks-compact-meta')).toBeNull(); });
  it("keeps Someday reachable in All tasks", async () => { await mount([task("a", { when: "someday" })], { list: "all" }); expect(rowTitles()).toEqual(["a"]); expect(host.textContent).toContain("Someday"); });
  it("normalizes old category names for filtering and heading identity", async () => { await mount([task("a", { category: " work  " }), task("b", { category: "WORK" })], { list: { category: "Work" } }); expect(rowTitles()).toEqual(["a", "b"]); expect(el("h1").textContent).toBe("Work"); expect(host.querySelector("h2")).toBeNull(); });
  it("changes category through the real navigation without losing tasks", async () => { await mount([task("a", { category: "Personal" })]); await click([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Task categories"] button')].find((entry) => entry.textContent === "Personal")!); expect(el("h1").textContent).toBe("Personal"); expect(rowTitles()).toEqual(["a"]); });
  it("collapses one category independently", async () => { await mount([task("a", { category: "Work", when: TODAY }), task("b", { category: "Personal", when: TODAY })]); await click(el(".tasks-group-heading>button:last-child")); expect(rowTitles()).toEqual(["b"]); });
  it("shows loading failures and lets the task store retry", async () => { api.mockResolvedValue(response({ reason: "Offline" }, 503)); await act(async () => root.render(<TasksSurface refreshToken={++token} />)); await settle(); expect(host.textContent).toContain("Tasks could not load"); expect(button("Try again")).toBeTruthy(); });
});

describe("draft task form", () => {
  it("opens from metadata and keeps the checkbox outside the row button", async () => { await mount([task("a", { when: TODAY, deadline: "2026-10-01" })]); expect(el(".tasks-compact-open").querySelector('[role="checkbox"]')).toBeNull(); await click(el(".tasks-compact-meta")); expect(title().value).toBe("a"); expect(notes().value).toBe("Original notes"); });
  it("creates with the multiline header value and saves notes together", async () => { await mount([]); await click(button("Add task")); await fill(title(), "New header task"); await fill(notes(), "Detailed context"); await save(); expect(writes.find((write) => write.method === "POST")?.body).toMatchObject({ title: "New header task", body: "Detailed context", when: TODAY }); expect(el(".tasks-detail")).toBeNull(); expect(rowTitles()).toContain("New header task"); });
  it.each([["inbox", undefined], ["upcoming", "2026-09-14"], ["someday", "someday"], ["all", undefined]] as const)("seeds capture in %s correctly", async (list, when) => { await mount([], { list }); await click(button("Add task")); await fill(title(), "Created here"); await save(); expect(writes.find((write) => write.method === "POST")?.body.when).toBe(when); });
  it("creates in the selected category", async () => { await mount([], { list: { category: "Work" } }); await click(button("Add task")); await fill(title(), "Categorized"); await save(); expect(writes[0].body.category).toBe("Work"); });
  it("Cancel discards edits and reopening restores server notes", async () => { await mount([task("a", { when: TODAY })]); await open(); await fill(title(), "Discarded"); await fill(notes(), "Discarded notes"); await click(button("Cancel")); expect(writes).toEqual([]); await open(); expect(title().value).toBe("a"); expect(notes().value).toBe("Original notes"); });
  it("reads fresh metadata and omits unchanged fields on a notes-only save", async () => { await mount([task("a", { when: TODAY, category: "Personal" })]); detailOverride = { when: "2026-09-20", category: "Work", time: "15:30" }; await open(); expect(el('[aria-label="Category: Work"]')).toBeTruthy(); await fill(notes(), "Edited notes"); await save(); expect(patches()[0].body).toEqual({ body: "Edited notes", bodyRev: "rev-1" }); });
  it("commits header edits with Cmd+Enter", async () => { await mount([task("a", { when: TODAY })]); await open(); await fill(title(), "Updated header"); await key("Enter", title(), { metaKey: true }); expect(patches()[0].body.title).toBe("Updated header"); });
  it("keeps source-owned titles readonly and excludes title from PATCH", async () => { await mount([task("a", { when: TODAY, page: "page-1" })]); await open(); expect(title().readOnly).toBe(true); expect(el(".tasks-detail-source").textContent).toContain("Product brief"); await fill(notes(), "Task-only notes"); await save(); expect(patches()[0].body).toEqual({ body: "Task-only notes", bodyRev: "rev-1" }); });
  it("never saves an empty body when detail loading fails", async () => { await mount([task("a", { when: TODAY })]); detailFailure = true; await open(); expect(el<HTMLButtonElement>(".tasks-detail-primary-desktop").disabled).toBe(true); expect(el('[role="alert"]').textContent).toContain("Notes unavailable"); expect(writes).toEqual([]); });
  it("retains the complete draft after a conflict", async () => { await mount([task("a", { when: TODAY })]); await open(); await fill(notes(), "Keep this draft"); patchFailure = true; await save(); expect(notes().value).toBe("Keep this draft"); expect(el('[role="alert"]').textContent).toContain("This task changed"); expect(el<HTMLButtonElement>(".tasks-detail-primary-desktop").disabled).toBe(false); });
  it("opens a task named by global search without changing the list scope", async () => { window.history.replaceState(null, "", "/tasks?task=a"); await mount([task("a", { category: "Work", when: "2026-10-01" })], { list: { category: "Personal" } }); expect(title().value).toBe("a"); expect(window.location.search).toBe(""); expect(el("h1").textContent).toBe("Personal"); });
  it("clears an unknown task URL without creating a popup", async () => { window.history.replaceState(null, "", "/tasks?task=missing"); await mount([]); expect(window.location.search).toBe(""); expect(el(".tasks-detail")).toBeNull(); });
});

describe("categories and linked-page drafts", () => {
  it("creates a category inline and keeps it after task Cancel", async () => { await mount([]); await click(button("Add task")); await click(el('[aria-label="Category: No category"]')); await fill(el('[aria-label="Category name"]'), "  Product   Lab  "); await key("Enter", el('[aria-label="Category name"]')); expect(el('[aria-label="Category: Product Lab"]')).toBeTruthy(); await click(button("Cancel")); expect(host.querySelector('[aria-label="Task categories"]')?.textContent).toContain("Product Lab"); expect(writes.filter((write) => write.url === "/api/tasks")).toEqual([]); });
  it("selects a normalized duplicate without creating another entity", async () => { await mount([]); await click(button("Add task")); await click(el('[aria-label="Category: No category"]')); await fill(el('[aria-label="Category name"]'), " work "); await key("Enter", el('[aria-label="Category name"]')); expect(el('[aria-label="Category: Work"]')).toBeTruthy(); expect(writes).toEqual([]); });
  it("keeps empty category input from creating or submitting the task", async () => { await mount([]); await click(button("Add task")); await fill(title(), "Still a draft"); await click(el('[aria-label="Category: No category"]')); await fill(el('[aria-label="Category name"]'), "   "); await key("Enter", el('[aria-label="Category name"]')); expect(writes).toEqual([]); expect(el(".tasks-detail")).toBeTruthy(); });
  it("selects two actual pages and saves IDs independently from source", async () => { await mount([task("a", { when: TODAY, page: "source-note" })]); await open(); await click(button("Add page")); const choices = document.querySelectorAll<HTMLElement>(".tasks-page-option"); await click(choices[0]); await click(choices[1]); expect(document.querySelectorAll('.tasks-page-option[aria-checked="true"]')).toHaveLength(2); await click(button("Done")); await save(); expect(patches()[0].body.relatedPageIds).toEqual(["page-1", "page-2"]); expect(patches()[0].body.page).toBeUndefined(); });
  it("preserves missing references until explicitly removed", async () => { await mount([task("a", { when: TODAY, relatedPageIds: ["missing-page", "page-1"] })]); await open(); expect(el(".tasks-linked-list").textContent).toContain("Page unavailable"); await fill(notes(), "Keep references"); await save(); expect(patches()[0].body.relatedPageIds).toBeUndefined(); });
  it("removing a page does not submit, Cancel keeps persisted IDs", async () => { await mount([task("a", { when: TODAY, relatedPageIds: ["page-1", "page-2"] })]); await open(); await click(el('[aria-label="Remove linked page: Product brief"]')); expect(el(".tasks-detail")).toBeTruthy(); expect(writes).toEqual([]); await click(button("Cancel")); await open(); expect(document.querySelectorAll(".tasks-linked-list>li")).toHaveLength(2); });
  it("saves an explicit removal", async () => { await mount([task("a", { when: TODAY, relatedPageIds: ["page-1", "page-2"] })]); await open(); await click(el('[aria-label="Remove linked page: Product brief"]')); await save(); expect(patches()[0].body.relatedPageIds).toEqual(["page-2"]); });
  it("Escape closes the page picker before the task form", async () => { await mount([task("a", { when: TODAY })]); await open(); await click(button("Add page")); await key("Escape", el('[aria-label="Search pages"]')); expect(el(".tasks-page-picker")).toBeNull(); expect(el(".tasks-detail")).toBeTruthy(); await key("Escape", el(".tasks-detail")); expect(el(".tasks-detail")).toBeNull(); });
});

describe("completion, history and keyboard", () => {
  it("completes through the checkbox without opening a dialog and retains Undo", async () => { await mount([task("a", { when: TODAY })]); await click(el('.tasks-compact-row [role="checkbox"]')); expect(patches()[0].body).toEqual({ done: true }); expect(el(".tasks-detail")).toBeNull(); expect(toasts.at(-1)?.options?.actionLabel).toBe("Undo"); await act(async () => { await toasts.at(-1)?.options?.onAction?.(); }); await settle(); expect(patches().at(-1)?.body).toEqual({ done: false }); });
  it("opens Completed on demand and makes only the latest recurring completion untickable", async () => { await mount([task("a", { when: "2026-09-14", repeat: { freq: "daily" }, log: [{ scheduled: "2026-09-12", completedAt: "2026-09-12T12:00:00.000Z" }, { scheduled: TODAY, completedAt: NOON.toISOString() }] })], { list: "all" }); expect(rowTitles()).toHaveLength(1); await click(el(".tasks-completed-toggle")); expect(rowTitles()).toHaveLength(3); const history = document.querySelectorAll('.tasks-workspace-completed [role="checkbox"]'); expect(history[0].getAttribute("aria-disabled")).not.toBe("true"); expect(history[1].getAttribute("aria-disabled")).toBe("true"); });
  it.each([["t", TODAY], ["s", "someday"]])("keeps the %s schedule shortcut", async (keyName, when) => { await mount([task("a", { when: "2026-10-01" })], { list: "all" }); await act(async () => el<HTMLButtonElement>(".tasks-compact-open").focus()); await key(keyName); expect(patches()[0].body).toEqual({ when }); });
  it("preserves Tomorrow and completion chords separately", async () => { await mount([task("a", { when: TODAY })]); await act(async () => el<HTMLButtonElement>(".tasks-compact-open").focus()); await key("]", window, { metaKey: true }); expect(patches()[0].body).toEqual({ when: "2026-09-14" }); });
  it("leaves browser chords and keys inside the draft alone", async () => { await mount([task("a", { when: TODAY })]); await act(async () => el<HTMLButtonElement>(".tasks-compact-open").focus()); await key("t", window, { metaKey: true }); expect(writes).toEqual([]); await open(); await key("s", title()); expect(writes).toEqual([]); });
  it("moves the cursor with arrows but never under an inert surface", async () => { await mount([task("a", { when: TODAY }), task("b", { when: TODAY })]); host.setAttribute("inert", ""); await key("ArrowDown"); expect(host.querySelector("[data-selected] .tasks-compact-title")).toBeNull(); host.removeAttribute("inert"); await key("ArrowDown"); expect(document.activeElement?.getAttribute("aria-label")).toBe("a"); });
  it("palette task commands still use the common schedule action", async () => { await mount([task("a", { when: TODAY })]); await act(async () => el<HTMLButtonElement>(".tasks-compact-open").focus()); await act(async () => emitTaskCommand("move-someday")); await settle(); expect(patches()[0].body).toEqual({ when: "someday" }); });
  it("responds to external store updates without resetting an open draft", async () => { await mount([task("a", { when: TODAY })]); await open(); await fill(notes(), "Unsaved"); await act(async () => mutateTasks((items) => items.map((entry) => ({ ...entry, title: "External title" })))); expect(notes().value).toBe("Unsaved"); });
  it("keeps the existing empty-state vocabulary helper available to integrations", () => { expect(emptyFor({ kind: "list", list: "inbox" }, { doneToday: 0, upcomingThisWeek: 0 })).toMatchObject({ title: "Inbox is clear" }); });
});
