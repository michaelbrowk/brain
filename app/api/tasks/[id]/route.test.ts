import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  writePage: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isNotFound: (error: unknown) =>
    error instanceof Error && error.name === "NotFoundError",
  isTaskValidation: (error: unknown) =>
    error instanceof Error && error.name === "TaskValidationError",
}));

import { DELETE, GET, PATCH } from "./route";

const TODAY = "2026-09-13";
const TOMORROW = "2026-09-14";
const TASK_ID = "task-alpha";
const PAGE_ID = "page-one";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: "Buy milk",
    done: false,
    created: "2026-09-13T09:00:00.000Z",
    updated: "2026-09-13T09:00:00.000Z",
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("page not found: x"), { name: "NotFoundError" });
}

function validation(reason: string): Error {
  return Object.assign(new Error(reason), { name: "TaskValidationError", reason });
}

const ctx = (id = TASK_ID) => ({ params: Promise.resolve({ id }) });

async function get(id = TASK_ID, query = "") {
  return GET(new NextRequest(`https://brain.test/api/tasks/${id}${query}`), ctx(id));
}

async function patch(body: Record<string, unknown>, query = "", id = TASK_ID) {
  return PATCH(
    new NextRequest(`https://brain.test/api/tasks/${id}${query}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(id),
  );
}

async function del(id = TASK_ID, query = "") {
  return DELETE(
    new NextRequest(`https://brain.test/api/tasks/${id}${query}`, {
      method: "DELETE",
    }),
    ctx(id),
  );
}

beforeEach(() => {
  mocks.getTask.mockReset().mockReturnValue(task());
  mocks.updateTask.mockReset().mockResolvedValue(task());
  mocks.deleteTask.mockReset().mockResolvedValue(undefined);
  mocks.writePage.mockReset();
  mocks.getStore.mockReset().mockResolvedValue({
    getTask: mocks.getTask,
    updateTask: mocks.updateTask,
    deleteTask: mocks.deleteTask,
    writePage: mocks.writePage,
  });
});

describe("GET /api/tasks/[id]", () => {
  it("returns the record", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task: task() });
  });

  it("refuses a list query no single record derives", async () => {
    for (const query of [`?today=${TODAY}`, "?offset=240"]) {
      const res = await get(TASK_ID, query);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/^unexpected_/);
    }
    expect(mocks.getTask).not.toHaveBeenCalled();
  });

  it("answers 400 for an id that is not a task id", async () => {
    const res = await get("../escape");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_id" });
    expect(mocks.getTask).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/tasks/[id]", () => {
  it("changes when without touching title on a linked task", async () => {
    mocks.updateTask.mockResolvedValue(
      task({ when: TOMORROW, page: PAGE_ID }),
    );

    const res = await patch({ when: TOMORROW });

    expect(res.status).toBe(200);
    expect(mocks.updateTask).toHaveBeenCalledWith(TASK_ID, {
      when: TOMORROW,
      src: undefined,
    });
    expect((await res.json()).task.title).toBe("Buy milk");
  });

  it("requires ?today= when the patch is { done: true } on a repeating task", async () => {
    mocks.updateTask.mockRejectedValue(validation("bad_today"));

    const withoutToday = await patch({ done: true });
    expect(withoutToday.status).toBe(400);
    expect(await withoutToday.json()).toEqual({ error: "bad_today" });

    mocks.updateTask.mockResolvedValue(task({ done: true }));
    const withToday = await patch({ done: true }, `?today=${TODAY}`);
    expect(withToday.status).toBe(200);
    expect(mocks.updateTask).toHaveBeenLastCalledWith(TASK_ID, {
      done: true,
      today: TODAY,
      src: undefined,
    });
  });

  it("refuses an offset, which no patch derives", async () => {
    const res = await patch({ when: TOMORROW }, "?offset=240");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unexpected_offset" });
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("answers 400 bad_today for a malformed today before the store is reached", async () => {
    const res = await patch({ done: true }, "?today=2026-9-1");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_today" });
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown id and never leaks whether the file exists", async () => {
    mocks.updateTask.mockRejectedValue(notFound());

    const res = await patch({ when: TOMORROW });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("refuses a field it does not own", async () => {
    const res = await patch({ page: "page-two" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_field" });
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tasks/[id]", () => {
  it("removes the record and leaves the note line an ordinary checkbox", async () => {
    const res = await del();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.deleteTask).toHaveBeenCalledWith(TASK_ID, undefined);
    // A deleted task never deletes or rewrites the line it pointed at.
    expect(mocks.writePage).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown id", async () => {
    mocks.deleteTask.mockRejectedValue(notFound());
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
