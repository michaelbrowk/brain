import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStore: vi.fn(), scopes: ["brain:read", "brain:write"] }));
vi.mock("@/lib/store", async (original) => ({
  ...await original<typeof import("@/lib/store")>(),
  getStore: mocks.getStore,
}));
vi.mock("@/lib/oauth/server", () => ({
  verifyMcpBearerToken: async (token: string) => ({
    token, clientId: "brain-legacy-bearer", scopes: mocks.scopes,
    resource: new URL("https://brain.example.test/api/mcp"),
  }),
}));
vi.mock("@/lib/owner-settings", async (original) => ({
  ...await original<typeof import("@/lib/owner-settings")>(),
  readTimeZone: async () => null,
  readModules: async () => ({ mail: true, tasks: true }),
  peekModules: () => ({ mail: true, tasks: true }),
}));

import { Store } from "@/lib/store/store";
import type { TaskView } from "@/lib/tasks/model";
import type { TaskCategory } from "@/lib/tasks/details";
import { readMcpActivity } from "@/lib/mcp/activity-log";
import { flushTaskActivityForTests } from "./task-tools";
import { POST } from "./route";

type Details = { task: TaskView; body: string; bodyRev: string };
let requestId = 0;
async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>, expectedStatus = 200) {
  const response = await POST(new Request("https://brain.example.test/api/mcp", {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", authorization: "Bearer test-machine-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
  }));
  expect(response.status).toBe(expectedStatus);
  const wire = await response.text();
  const data = wire.split("\n").find((line) => line.startsWith("data: "));
  const envelope = JSON.parse(data?.slice(6) ?? wire) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: unknown };
  const text = envelope.result?.content?.[0]?.text ?? "";
  let payload: T | undefined;
  try { payload = JSON.parse(text) as T; } catch { /* Schema refusals are SDK text, not domain JSON. */ }
  return { payload, isError: !response.ok || !!envelope.result?.isError || !!envelope.error, text, wire, authenticate: response.headers.get("WWW-Authenticate") };
}
async function success<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await call<T>(name, args);
  expect(result.isError, result.text).toBe(false);
  expect(result.payload).toBeDefined();
  return result.payload!;
}

describe("MCP task parity through the real Store", () => {
  let root: string;
  let store: Store;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-task-parity-"));
    vi.stubEnv("BRAIN_MCP_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("BRAIN_SETTINGS_STATE_DIR", path.join(root, "settings"));
    vi.stubEnv("BRAIN_NOTIFICATIONS_STATE_DIR", path.join(root, "notifications"));
    vi.stubEnv("BRAIN_OAUTH_STATE_DIR", path.join(root, "oauth"));
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("MCP_TOKEN_NAME", "Parity test");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
    store = new Store(path.join(root, "notes"));
    await store.init();
    mocks.getStore.mockReset();
    mocks.getStore.mockImplementation(async () => store);
    mocks.scopes = ["brain:read", "brain:write"];
  });
  afterEach(async () => {
    await flushTaskActivityForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("round-trips Markdown notes and related pages through MCP and a fresh Store", async () => {
    const first = await store.createPage(null, "Launch context");
    const second = await store.createPage(null, "Review checklist");
    const body = "---\nuser frontmatter\n---\nContext without a trailing newline";
    const created = await success<{ task: TaskView }>("create_task", { title: "Review launch", body, relatedPageIds: [first.id, second.id] });
    const initial = await success<Details>("get_task", { id: created.task.id });
    expect(initial).toMatchObject({ body, task: { title: "Review launch", relatedPageIds: [first.id, second.id] } });
    expect(initial.bodyRev).toMatch(/^[a-f0-9]{12}$/);
    expect(initial.task.page).toBeUndefined();
    expect(initial.task.anchor).toBeUndefined();
    await success("update_task", { id: created.task.id, category: "Team" });
    expect((await success<Details>("get_task", { id: created.task.id })).body).toBe(body);
    await success("update_task", { id: created.task.id, body: "Updated notes", bodyRev: initial.bodyRev, relatedPageIds: [second.id] });
    store = new Store(path.join(root, "notes"));
    await store.init();
    const reloaded = await success<Details>("get_task", { id: created.task.id });
    expect(reloaded).toMatchObject({ body: "Updated notes", task: { category: "Team", relatedPageIds: [second.id], done: false } });
    expect(reloaded.bodyRev).not.toBe(initial.bodyRev);
  });

  it("refuses a stale body revision without partially changing metadata or related pages", async () => {
    const page = await store.createPage(null, "Context");
    const { task } = await success<{ task: TaskView }>("create_task", { title: "Original", category: "Team", when: "2026-11-10", body: "First", relatedPageIds: [page.id] });
    const initial = await success<Details>("get_task", { id: task.id });
    await success("update_task", { id: task.id, body: "Saved elsewhere", bodyRev: initial.bodyRev });
    const current = await success<Details>("get_task", { id: task.id });
    const stale = await call("update_task", { id: task.id, title: "Must not land", category: "Must not land", when: "2027-01-01", body: "Stale notes", bodyRev: initial.bodyRev, relatedPageIds: null });
    expect(stale.isError).toBe(true);
    expect(stale.payload).toMatchObject({ reason: "conflict", currentBodyRev: current.bodyRev });
    expect(await success<Details>("get_task", { id: task.id })).toEqual(current);
    await flushTaskActivityForTests();
    expect((await readMcpActivity(20)).find((entry) => entry.tool === "update_task" && entry.outcome === "conflict")).toMatchObject({ task: task.id });
  });

  it("promotes a source checkbox with context without transferring its title or completion", async () => {
    const source = await store.createPage(null, "Source note", { markdown: "- [ ] Review launch\n" });
    const context = await store.createPage(null, "Supporting page", { markdown: "Unrelated context\n" });
    const originalSource = (await store.readPage(source.id)).markdown;
    const { task } = await success<{ task: TaskView }>("promote_task_line", { page: source.id, line: 0, when: "2026-11-10", body: "Private task notes", relatedPageIds: [context.id] });
    const initial = await success<Details>("get_task", { id: task.id });
    expect(initial).toMatchObject({ body: "Private task notes", task: { title: "Review launch", done: false, page: source.id, relatedPageIds: [context.id] } });
    expect(initial.task.anchor).toBeDefined();
    await success("update_task", { id: task.id, body: "Changed context", bodyRev: initial.bodyRev, relatedPageIds: [] });
    const updated = await success<Details>("get_task", { id: task.id });
    expect(updated.task).toMatchObject({ title: initial.task.title, page: source.id, anchor: initial.task.anchor, done: false });
    expect(updated.task.relatedPageIds).toBeUndefined();
    expect((await store.readPage(source.id)).markdown).toBe(originalSource);
    await success("complete_task", { id: task.id, today: "2026-11-10", offsetMinutes: 0 });
    expect((await store.readPage(source.id)).markdown).toContain("- [x] Review launch");
    expect((await store.readPage(context.id)).markdown).toContain("Unrelated context");
  });

  it("creates normalized empty categories, persists emoji changes and reloads the catalog", async () => {
    expect(await success("list_task_categories", {})).toEqual({ categories: [] });
    const first = await success<{ category: TaskCategory }>("create_task_category", { name: "  Design   reviews  ", icon: "✨" });
    expect(first.category).toEqual({ name: "Design reviews", icon: "✨" });
    expect(await success("create_task_category", { name: "ＤＥＳＩＧＮ reviews", icon: "🎨" })).toEqual(first);
    expect(await success("update_task_category", { name: " design reviews ", icon: "🎬" })).toEqual({ category: { name: "Design reviews", icon: "🎬" } });
    store = new Store(path.join(root, "notes"));
    await store.init();
    expect(await success("list_task_categories", {})).toEqual({ categories: [{ name: "Design reviews", icon: "🎬" }] });
    await success("update_task_category", { name: "Design reviews", icon: null });
    expect(await success("list_task_categories", {})).toEqual({ categories: [{ name: "Design reviews" }] });
    expect(store.listTasks("2026-11-10", { offsetMinutes: 0 })).toEqual([]);
  });

  it("clears notes with an empty string and links with either null or an empty array", async () => {
    const page = await store.createPage(null, "Context");
    const { task } = await success<{ task: TaskView }>("create_task", { title: "Clear fields", body: "Notes", relatedPageIds: [page.id] });
    const initial = await success<Details>("get_task", { id: task.id });
    await success("update_task", { id: task.id, body: "", bodyRev: initial.bodyRev, relatedPageIds: null });
    const cleared = await success<Details>("get_task", { id: task.id });
    expect(cleared.body).toBe("");
    expect(cleared.task.relatedPageIds).toBeUndefined();
    await success("update_task", { id: task.id, relatedPageIds: [page.id] });
    await success("update_task", { id: task.id, relatedPageIds: [] });
    expect((await success<Details>("get_task", { id: task.id })).task.relatedPageIds).toBeUndefined();
  });

  it("enforces strict field shapes and refuses unmatched body revisions without changing the task", async () => {
    const { task } = await success<{ task: TaskView }>("create_task", { title: "Guarded", body: "Keep these notes" });
    const initial = await success<Details>("get_task", { id: task.id });
    for (const args of [{ body: "No revision" }, { bodyRev: initial.bodyRev }]) {
      const refused = await call("update_task", { id: task.id, title: "Must not land", ...args });
      expect(refused.isError).toBe(true);
      expect(refused.payload?.reason).toMatch(/body|revision/i);
      expect(await success<Details>("get_task", { id: task.id })).toEqual(initial);
    }
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["create_task", { title: "Invalid", body: null }],
      ["create_task", { title: "Invalid", body: "x".repeat(100_001) }],
      ["create_task", { title: "Invalid", relatedPageIds: null }],
      ["create_task", { title: "Invalid", relatedPageIds: ["same", "same"] }],
      ["create_task", { title: "Invalid", relatedPageIds: Array.from({ length: 65 }, (_, i) => `page-${i}`) }],
      ["update_task", { id: task.id, body: null, bodyRev: initial.bodyRev }],
      ["update_task", { id: task.id, body: "Invalid revision", bodyRev: "not-a-revision" }],
      ["update_task", { id: task.id, note: "Unknown field" }],
      ["create_task_category", { name: "Team", icon: null }],
      ["create_task_category", { name: "Team", arbitrary: true }],
      ["update_task_category", { name: "Team" }],
      ["update_task_category", { name: "Team", icon: false }],
      ["list_task_categories", { unknown: true }],
    ];
    for (const [name, args] of invalid) {
      const result = await call(name, args);
      expect(result.isError, `${name}: ${JSON.stringify(args).slice(0, 100)}`).toBe(true);
      expect(result.wire).toContain("Invalid arguments");
    }
    expect(await success<Details>("get_task", { id: task.id })).toEqual(initial);
    const empty = await call("create_task_category", { name: "   " });
    expect(empty.isError).toBe(true);
    expect(await success("list_task_categories", {})).toEqual({ categories: [] });
  });

  it("refuses missing related pages atomically on create, promote and update", async () => {
    const { task } = await success<{ task: TaskView }>("create_task", { title: "Keep me", body: "Original" });
    const source = await store.createPage(null, "Source", { markdown: "- [ ] Untouched\n" });
    const initial = await success<Details>("get_task", { id: task.id });
    for (const [name, args] of [
      ["create_task", { title: "Missing context" }],
      ["promote_task_line", { page: source.id, line: 0 }],
      ["update_task", { id: task.id, title: "Must not land", body: "Must not land", bodyRev: initial.bodyRev }],
    ] as const) {
      const result = await call(name, { ...args, relatedPageIds: ["missing-page"] });
      expect(result.isError).toBe(true);
      expect(result.payload?.reason).toMatch(/page.*not found/i);
    }
    expect(await success<Details>("get_task", { id: task.id })).toEqual(initial);
    expect(store.listTasks("2026-11-10", { offsetMinutes: 0 }).map((entry) => entry.id)).toEqual([task.id]);
    expect((await store.readPage(source.id)).markdown).toContain("- [ ] Untouched");
  });

  it("all includes every active list and only the caller's 30-day completed window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    const inbox = await store.createTask({ title: "Inbox" });
    const today = await store.createTask({ title: "Today", when: "2026-11-10" });
    const upcoming = await store.createTask({ title: "Future", when: "2026-12-01" });
    const someday = await store.createTask({ title: "Someday", when: "someday" });
    const old = await store.createTask({ title: "Old completion" });
    const boundary = await store.createTask({ title: "Boundary completion" });
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    await store.updateTask(old.id, { done: true });
    // The existing window starts on 11 Oct; Dubai has crossed that date
    // while UTC still falls outside it.
    vi.setSystemTime(new Date("2026-10-10T23:30:00Z"));
    await store.updateTask(boundary.id, { done: true });
    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    const active = [inbox.id, today.id, upcoming.id, someday.id];
    const utc = await success<{ tasks: TaskView[] }>("list_tasks", { list: "all", today: "2026-11-10", offsetMinutes: 0 });
    expect(utc.tasks.map((entry) => entry.id).sort()).toEqual(active.sort());
    const local = await success<{ tasks: TaskView[] }>("list_tasks", { list: "all", today: "2026-11-10", offsetMinutes: 240 });
    expect(local.tasks.map((entry) => entry.id).sort()).toEqual([...active, boundary.id].sort());
    expect((await call("list_tasks", { list: "all", page: "source" })).payload?.reason).toBe("unexpected_list");
  });

  it("keeps category writes scoped and activity free of body, titles, categories and linked-page content", async () => {
    const page = await store.createPage(null, "Secret context title");
    await success("create_task_category", { name: "Secret category name", icon: "✨" });
    await success("update_task_category", { name: "Secret category name", icon: null });
    const { task } = await success<{ task: TaskView }>("create_task", { title: "Secret task title", body: "Secret note contents", relatedPageIds: [page.id] });
    const details = await success<Details>("get_task", { id: task.id });
    await success("update_task", { id: task.id, body: "Changed secret notes", bodyRev: details.bodyRev, relatedPageIds: [] });
    await flushTaskActivityForTests();
    const entries = await readMcpActivity(20);
    expect(entries.map((entry) => entry.tool).sort()).toEqual(["create_task", "update_task", "create_task_category", "update_task_category"].sort());
    expect(entries.every((entry) => entry.outcome === "ok")).toBe(true);
    expect(entries.find((entry) => entry.tool === "update_task")?.change).toBe("body+relatedPageIds");
    const serialized = JSON.stringify(entries);
    for (const secret of ["Secret context title", "Secret category name", "Secret task title", "Secret note contents", "Changed secret notes", page.id]) expect(serialized).not.toContain(secret);
    mocks.scopes = ["brain:read"];
    expect((await success<{ categories: TaskCategory[] }>("list_task_categories", {})).categories).toHaveLength(1);
    for (const [name, args] of [["create_task_category", { name: "Forbidden" }], ["update_task_category", { name: "Secret category name", icon: "🎨" }]] as const) {
      const refused = await call(name, args, 403);
      expect(refused.isError).toBe(true);
      expect(refused.authenticate).toContain('scope="brain:write"');
    }
    expect(await success("list_task_categories", {})).toEqual({ categories: [{ name: "Secret category name" }] });
  });
});
