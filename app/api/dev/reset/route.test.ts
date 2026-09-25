import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake store, because what this route is is three gates and an order: tasks
// before pages, because a linked task's `done` lives on a note line, and the
// trash emptied after the deletes that filled it. A real store would prove the
// store works, which `lib/store/store.test.ts` already does, and would not
// prove the order.
const allTasks = vi.fn();
const deleteTask = vi.fn();
const getTree = vi.fn();
const deletePage = vi.fn();
const emptyTrash = vi.fn();
vi.mock("@/lib/store", () => ({
  getStore: async () => ({ allTasks, deleteTask, getTree, deletePage, emptyTrash }),
}));

// The real notification store against a temp directory, the pattern
// app/api/notifications/route.test.ts uses: an emptied centre is the half of
// this route no owner surface can do, so it is the half worth asserting for
// real.
const dirHolder = { current: "" };
vi.mock("@/lib/notifications/state-dir", () => ({
  notificationStateDirectory: () => dirHolder.current,
}));

const { appendNotification, listNotifications } = await import(
  "@/lib/notifications/store"
);
const { POST } = await import("./route");

beforeEach(async () => {
  vi.clearAllMocks();
  dirHolder.current = await mkdtemp(path.join(os.tmpdir(), "brain-dev-reset-"));
  allTasks.mockReturnValue([]);
  getTree.mockReturnValue([]);
  vi.stubEnv("BRAIN_E2E_RESET", "1");
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dirHolder.current, { recursive: true, force: true });
});

const row = (id: string) => ({
  id,
  kind: "task-reminder" as const,
  at: "2026-09-14T09:00:00.000Z",
  title: "Water the plants",
  href: "/tasks",
});

describe("POST /api/dev/reset", () => {
  it("is not there at all without the harness seam", async () => {
    vi.stubEnv("BRAIN_E2E_RESET", "");
    const response = await POST();
    expect(response.status).toBe(404);
    expect(deletePage).not.toHaveBeenCalled();
  });

  it("is not there in production, seam or no seam", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST();
    expect(response.status).toBe(404);
    expect(deletePage).not.toHaveBeenCalled();
  });

  it("is not there for a seam set to anything but 1", async () => {
    vi.stubEnv("BRAIN_E2E_RESET", "true");
    expect((await POST()).status).toBe(404);
  });

  it("deletes every task, then every root page, then empties the trash", async () => {
    const order: string[] = [];
    allTasks.mockReturnValue([{ id: "task-a" }, { id: "task-b" }]);
    getTree.mockReturnValue([
      { id: "page-a", children: [{ id: "child", children: [] }] },
      { id: "page-b", children: [] },
    ]);
    deleteTask.mockImplementation(async (id: string) => void order.push(`task:${id}`));
    deletePage.mockImplementation(async (id: string) => void order.push(`page:${id}`));
    emptyTrash.mockImplementation(async () => void order.push("trash"));

    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      tasks: 2,
      pages: 2,
      notifications: 0,
    });
    // Only the roots: a deleted page takes its subtree with it, so asking for
    // the child as well would be a second delete of a page already in trash.
    expect(order).toEqual([
      "task:task-a",
      "task:task-b",
      "page:page-a",
      "page:page-b",
      "trash",
    ]);
  });

  it("empties the notification centre and counts what was in it", async () => {
    await appendNotification(row("a"), dirHolder.current);
    await appendNotification(row("b"), dirHolder.current);
    expect((await (await POST()).json()).notifications).toBe(2);
    expect(await listNotifications(dirHolder.current)).toEqual([]);
  });
});

describe("the route surface", () => {
  it("is not exempted in proxy.ts, so the owner session is a fourth gate", async () => {
    const proxy = await readFile(path.join(process.cwd(), "proxy.ts"), "utf8");
    expect(proxy).not.toContain("/api/dev");
  });
});
