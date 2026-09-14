import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isNotFound: (error: unknown) =>
    error instanceof Error && error.name === "NotFoundError",
  isTaskValidation: (error: unknown) =>
    error instanceof Error && error.name === "TaskValidationError",
  isTaskConflict: (error: unknown) =>
    error instanceof Error && error.name === "TaskConflictError",
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

function conflictError(currentWhen: string | undefined): Error {
  return Object.assign(new Error("this task has already moved on: reload and try again"), {
    name: "TaskConflictError",
    reason: "this task has already moved on: reload and try again",
    currentWhen,
  });
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
  mocks.getStore.mockReset().mockResolvedValue({
    getTask: mocks.getTask,
    updateTask: mocks.updateTask,
    deleteTask: mocks.deleteTask,
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

  /** A NAME ON THE LIST IS NOT A VALUE THE STORE CAN TAKE.
   *
   *  Most junk was caught downstream by the record schema, which reparses the
   *  whole record. `done` was the hole: `{"done":"yes"}` is neither `=== true`
   *  nor `=== false`, so it fell past every branch into the linked-completion
   *  path and wrote `[x]` into somebody's note off a value no schema had seen.
   *  Every value now goes through the record's own field parsers here, before
   *  the store is reached. */
  describe("the value behind the field name", () => {
    const refused: [string, Record<string, unknown>][] = [
      ["done as a string", { done: "yes" }],
      ["done as a number", { done: 1 }],
      ["when as a boolean", { when: true }],
      ["when as a date that is not one", { when: "2026-02-31" }],
      ["when as a loose day", { when: "2026-9-1" }],
      ["deadline as an instant", { deadline: "2026-09-13T09:00:00.000Z" }],
      ["category as an object", { category: { name: "Home" } }],
      ["category past its bound", { category: "x".repeat(201) }],
      ["repeat with an unknown freq", { repeat: { freq: "fortnightly" } }],
      ["repeat as a string", { repeat: "daily" }],
      ["expectedWhen as a number", { expectedWhen: 20260913 }],
      ["expectedWhen as a loose day", { expectedWhen: "13 Sep" }],
      ["title as a number", { title: 42 }],
    ];
    for (const [name, body] of refused) {
      it(`answers 400 with a reason for ${name}`, async () => {
        const res = await patch(body);
        expect(res.status).toBe(400);
        const answered = (await res.json()) as { error: string };
        // The one error shape, and a reason naming the field rather than a
        // bare "bad_body": a caller learns which value it built wrong.
        expect(answered.error).toContain(Object.keys(body)[0]);
        expect(mocks.updateTask).not.toHaveBeenCalled();
      });
    }

    const taken: [string, Record<string, unknown>][] = [
      ["done: true", { done: true }],
      ["done: false", { done: false }],
      ["when as a day", { when: TOMORROW }],
      ["when as the word", { when: "someday" }],
      ["when cleared", { when: null }],
      ["deadline as a day", { deadline: TOMORROW }],
      ["deadline cleared", { deadline: null }],
      ["category cleared", { category: null }],
      ["repeat stopped", { repeat: null }],
      ["repeat as a rule", { repeat: { freq: "weekly", byWeekday: ["mon"] } }],
      ["expectedWhen as a day", { expectedWhen: TODAY }],
      ["expectedWhen as null", { expectedWhen: null }],
    ];
    for (const [name, body] of taken) {
      it(`takes ${name} through to the store`, async () => {
        const res = await patch(body);
        expect(res.status).toBe(200);
        expect(mocks.updateTask).toHaveBeenCalledWith(
          TASK_ID,
          expect.objectContaining(body),
        );
      });
    }
  });
});

describe("DELETE /api/tasks/[id]", () => {
  it("answers 200 ok and hands the id to deleteTask", async () => {
    const res = await del();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.deleteTask).toHaveBeenCalledWith(TASK_ID, undefined);
  });

  it("answers 404 for an unknown id", async () => {
    mocks.deleteTask.mockRejectedValue(notFound());
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});


/** Completing a repeat is not idempotent, so the tick carries the instance the
 *  caller was looking at and a stale one is refused. */
describe("PATCH /api/tasks/[id], the instance that moved", () => {
  it("hands expectedWhen through to the store untouched", async () => {
    await patch({ done: true, expectedWhen: TODAY }, `?today=${TODAY}`);

    expect(mocks.updateTask).toHaveBeenCalledWith(TASK_ID, {
      done: true,
      expectedWhen: TODAY,
      today: TODAY,
      src: undefined,
    });

    // `null` is the instance filed under no day, and it is not the same as
    // sending nothing: nothing means no check at all.
    await patch({ done: true, expectedWhen: null }, `?today=${TODAY}`);
    expect(mocks.updateTask).toHaveBeenLastCalledWith(
      TASK_ID,
      expect.objectContaining({ expectedWhen: null }),
    );
  });

  it("answers 409 with the reason and where the task now stands", async () => {
    mocks.updateTask.mockRejectedValue(conflictError(TOMORROW));

    const res = await patch({ done: true, expectedWhen: TODAY }, `?today=${TODAY}`);

    // Nothing about the request is malformed, so it is not a 400: the task
    // moved, and the body says where to so a client can re-read without a
    // second round trip.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this task has already moved on: reload and try again",
      reason: "when_moved",
      currentWhen: TOMORROW,
    });
  });

  it("keeps a validation refusal a 400, so the two are never one answer", async () => {
    mocks.updateTask.mockRejectedValue(
      validation("a task that is already done cannot take a repeat rule"),
    );

    const res = await patch({ repeat: { freq: "daily" } });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("already done");
  });
});

describe("the clock on the patch surface", () => {
  it("accepts a time and an evening", async () => {
    const res = await patch({ when: TOMORROW, time: "13:00", evening: true });
    expect(res.status).toBe(200);
    expect(mocks.updateTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ when: TOMORROW, time: "13:00", evening: true }),
    );
  });

  it("accepts null for either, which is how a caller clears one", async () => {
    const res = await patch({ time: null, evening: null });
    expect(res.status).toBe(200);
    // The nulls have to REACH the store, which is where a clear happens. A
    // status on its own would pass for a route that took them and dropped them.
    expect(mocks.updateTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ time: null, evening: null }),
    );
  });

  it("refuses a time the field cannot hold, before the store is reached", async () => {
    const res = await patch({ time: "25:00" });
    expect(res.status).toBe(400);
    // The record's own parser wrote this sentence, not the route. When the
    // schema's wording changes the route's refusal changes with it, which is
    // the whole point of `refusePatchValues` reusing `taskRecordFields`.
    expect(await res.json()).toEqual({ error: 'time: write it as "HH:MM"' });
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("refuses evening: false, because the absence is the only other state", async () => {
    const res = await patch({ evening: false });
    expect(res.status).toBe(400);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  // The mark is the scheduler's, written through `markTaskReminded` and no
  // other way. Pinned by name rather than left to the nearest neighbour, which
  // refuses `page` for an unrelated reason: a later task that added the name to
  // `PATCH_FIELDS` would keep every other case green and hand the scheduler a
  // path that clears the mark it is setting.
  it("does not take the mark, which is the scheduler's", async () => {
    const res = await patch({ remindedAt: "2026-09-13T12:00:00.000Z" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_field" });
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
});
