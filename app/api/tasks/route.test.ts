import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readTimeZone, resetOwnerSettingsCache } from "@/lib/owner-settings";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  listTasks: vi.fn(),
  listLogbook: vi.fn(),
  createTask: vi.fn(),
  pageTasks: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isNotFound: (error: unknown) =>
    error instanceof Error && error.name === "NotFoundError",
  isTaskValidation: (error: unknown) =>
    error instanceof Error && error.name === "TaskValidationError",
}));

import { GET, POST } from "./route";

const TODAY = "2026-09-13";
const TASK_ID = "task-alpha";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: "Water the plants",
    done: false,
    created: "2026-09-13T09:00:00.000Z",
    updated: "2026-09-13T09:00:00.000Z",
    ...overrides,
  };
}

function validation(reason: string): Error {
  return Object.assign(new Error(reason), { name: "TaskValidationError", reason });
}

async function get(query: string) {
  return GET(new NextRequest(`https://brain.test/api/tasks${query}`));
}

async function post(body: Record<string, unknown>, query = "") {
  return POST(
    new NextRequest(`https://brain.test/api/tasks${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  mocks.listTasks.mockReset().mockReturnValue([task()]);
  mocks.listLogbook.mockReset().mockReturnValue([]);
  mocks.createTask.mockReset().mockResolvedValue(task());
  mocks.pageTasks.mockReset().mockReturnValue([task({ page: "page-one" })]);
  mocks.getStore.mockReset().mockResolvedValue({
    listTasks: mocks.listTasks,
    listLogbook: mocks.listLogbook,
    createTask: mocks.createTask,
    pageTasks: mocks.pageTasks,
  });
});

describe("GET /api/tasks", () => {
  it("answers 400 bad_today when ?today= is absent", async () => {
    const res = await get("");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_today" });
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });

  it("answers 400 bad_today for 2026-9-1, for tomorrow-ish text, and for an empty value", async () => {
    for (const value of ["2026-9-1", "tomorrow", "", "2026-09-13T00:00:00Z"]) {
      const res = await get(`?today=${encodeURIComponent(value)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_today" });
    }
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });

  it("never derives a date from the server clock", async () => {
    // The guarantee is source-level: a default anywhere in the file is a
    // server-side today, which flips the list at 03:00 in Moscow.
    for (const file of [
      "route.ts",
      "shared.ts",
      path.join("[id]", "route.ts"),
    ]) {
      const raw = await fs.readFile(path.join(import.meta.dirname, file), "utf8");
      // Comments may name the call a client makes; the guarantee is about the
      // code that runs on the server.
      const source = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source).not.toContain("new Date(");
      expect(source).not.toContain("Date.now(");
    }
    await get(`?today=${TODAY}&offset=0`);
    expect(mocks.listTasks).toHaveBeenCalledWith(TODAY, { offsetMinutes: 0 });
  });

  it("returns one list when ?list= is given and every open task plus the logbook window when it is not", async () => {
    const one = await get(`?today=${TODAY}&list=today`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ tasks: [task()] });
    expect(mocks.listTasks).toHaveBeenCalledWith(TODAY, { list: "today" });

    await get(`?today=${TODAY}&offset=240`);
    expect(mocks.listTasks).toHaveBeenLastCalledWith(TODAY, {
      offsetMinutes: 240,
    });

    const bad = await get(`?today=${TODAY}&list=everything`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad_list" });
  });

  it("needs the reader's offset for any read that can return a completion", async () => {
    // The Logbook day of a UTC instant is the reader's, so a read that can
    // hand one back cannot be answered without their offset.
    for (const query of [
      `?today=${TODAY}`,
      `?today=${TODAY}&list=logbook`,
      `?today=${TODAY}&offset=`,
      `?today=${TODAY}&offset=abc`,
      `?today=${TODAY}&offset=99999`,
      `?today=${TODAY}&list=today&offset=90000`,
    ]) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_offset" });
    }
    expect(mocks.listTasks).not.toHaveBeenCalled();

    // A list that cannot hold a completion is answered without one.
    const res = await get(`?today=${TODAY}&list=today`);
    expect(res.status).toBe(200);
    expect(mocks.listTasks).toHaveBeenCalledWith(TODAY, { list: "today" });

    await get(`?today=${TODAY}&list=logbook&offset=-300`);
    expect(mocks.listLogbook).toHaveBeenLastCalledWith(TODAY, {
      offsetMinutes: -300,
    });
  });

  it("answers ?list=logbook with entries, each keyed by its own completion", async () => {
    // A repeating record is never done, so this list cannot be a filter over
    // records. The store derives one row per completion and the route hands
    // the order through; a caller here has no records to derive from.
    //
    // And the rows carry the key, because the id does not: a daily task
    // finished on two days is two rows of ONE record, and an agent keying on
    // `id` would collapse the history into one.
    const completion = (when: string, doneAt: string) => ({
      key: `task-words:${doneAt}`,
      task: task({ id: "task-words", repeat: { freq: "daily" }, done: true, when, doneAt }),
      untickable: when === TODAY,
    });
    const rows = [
      completion(TODAY, `${TODAY}T09:00:00.000Z`),
      completion("2026-09-12", "2026-09-12T09:00:00.000Z"),
    ];
    mocks.listLogbook.mockReturnValue(rows);

    const res = await get(`?today=${TODAY}&list=logbook&offset=0`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries?: unknown; tasks?: unknown };
    expect(body.entries).toEqual(rows);
    expect(body.tasks).toBeUndefined();
    expect(mocks.listLogbook).toHaveBeenCalledWith(TODAY, { offsetMinutes: 0 });
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });

  it("passes ?category= through to the logbook read", async () => {
    await get(`?today=${TODAY}&list=logbook&offset=0&category=home`);
    expect(mocks.listLogbook).toHaveBeenCalledWith(TODAY, {
      offsetMinutes: 0,
      category: "home",
    });
  });

  it("filters by ?category= and collates the groups", async () => {
    const ordered = [task({ id: "task-beta" }), task()];
    mocks.listTasks.mockReturnValue(ordered);

    const res = await get(`?today=${TODAY}&list=today&category=home`);

    expect(mocks.listTasks).toHaveBeenCalledWith(TODAY, {
      list: "today",
      category: "home",
    });
    // The store collates; the route hands the order through untouched.
    expect((await res.json()).tasks.map((t: { id: string }) => t.id)).toEqual([
      "task-beta",
      TASK_ID,
    ]);
  });

  it("answers ?page= with every record of that page and derives no list", async () => {
    // The note's own decoration lookup. It needs the records of ONE page,
    // linked or detached, done or open, whatever their age: a completion
    // older than the Logbook window still has its line in the note, and its
    // word has to keep reading Done rather than offering "+ Task" again.
    const res = await get("?page=page-one");

    expect(res.status).toBe(200);
    expect((await res.json()).tasks.map((t: { id: string }) => t.id)).toEqual([
      TASK_ID,
    ]);
    expect(mocks.pageTasks).toHaveBeenCalledWith("page-one");
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });

  it("refuses today, offset, list and category beside ?page=", async () => {
    // No list is derived here, so the reader's day and offset have nothing to
    // do, and a filter would quietly narrow a lookup that must be complete.
    const cases: [string, string][] = [
      [`?page=page-one&today=${TODAY}`, "unexpected_today"],
      ["?page=page-one&offset=0", "unexpected_offset"],
      ["?page=page-one&list=today", "unexpected_list"],
      ["?page=page-one&category=home", "unexpected_category"],
    ];
    for (const [query, error] of cases) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(mocks.pageTasks).not.toHaveBeenCalled();
  });

  it("refuses a page id the page id rule does not allow", async () => {
    for (const value of ["", "with space", "../escaped", "a".repeat(129)]) {
      const res = await get(`?page=${encodeURIComponent(value)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_page" });
    }
    expect(mocks.pageTasks).not.toHaveBeenCalled();
  });
});

describe("POST /api/tasks", () => {
  it("mints an id and returns 201 with the record", async () => {
    const res = await post({ title: "Water the plants", when: TODAY });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ task: task() });
    expect(mocks.createTask).toHaveBeenCalledWith({
      title: "Water the plants",
      when: TODAY,
    });
  });

  it("refuses a client-supplied id", async () => {
    const res = await post({ id: "chosen", title: "Water the plants" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "id_is_minted" });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("refuses a repeat together with a page", async () => {
    mocks.createTask.mockRejectedValue(
      validation("repeat: repeat and page cannot both be set on one task"),
    );

    const res = await post({
      title: "Learn words",
      page: "page-one",
      repeat: { freq: "daily" },
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("repeat and page");
  });

  it("refuses a page that is not there or is in the trash", async () => {
    for (const reason of ["page not found: page-missing", "page is in the trash: page-one"]) {
      mocks.createTask.mockRejectedValue(validation(reason));
      const res = await post({ title: "Buy milk", page: "page-one" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: reason });
    }
  });

  it("refuses today, which no create needs", async () => {
    const res = await post({ title: "Water the plants" }, `?today=${TODAY}`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unexpected_today" });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("refuses a body that is not an object", async () => {
    const res = await POST(
      new NextRequest("https://brain.test/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_body" });
  });

  it("creates a task with a time and an evening", async () => {
    const res = await post({
      title: "Water the plants",
      when: "2026-09-13",
      time: "13:00",
      evening: true,
    });
    expect(res.status).toBe(201);
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ time: "13:00", evening: true }),
    );
  });
});

describe("the task routes are owner-only by shape", () => {
  it("is listed in no proxy bypass and has no share-edit surface", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
    const proxySource = await fs.readFile(
      path.join(repoRoot, "proxy.ts"),
      "utf8",
    );
    expect(proxySource).not.toContain("/api/tasks");

    const shareEditDir = path.join(repoRoot, "app", "api", "share-edit");
    const names = await fs.readdir(shareEditDir, { recursive: true });
    for (const name of names) {
      const file = path.join(shareEditDir, String(name));
      if (!(await fs.stat(file)).isFile()) continue;
      expect((await fs.readFile(file, "utf8")).toLowerCase()).not.toContain(
        "task",
      );
    }
  });
});

describe("the zone the client offers with its list request", () => {
  // A reminder fires from a server timer with no request to read, so the zone
  // has to be on disk before the first one is due. The list request is the one
  // call every client makes, and it carries the browser's own answer.
  let zoneDir: string;

  beforeEach(async () => {
    zoneDir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-tasks-zone-"));
    process.env.BRAIN_SETTINGS_STATE_DIR = zoneDir;
    resetOwnerSettingsCache();
  });

  afterEach(async () => {
    delete process.env.BRAIN_SETTINGS_STATE_DIR;
    await fs.rm(zoneDir, { recursive: true, force: true });
    resetOwnerSettingsCache();
  });

  it("captures the zone the client offers with its list request", async () => {
    await get(`?today=${TODAY}&offset=0&zone=Europe%2FLisbon`);
    expect(await readTimeZone(zoneDir)).toBe("Europe/Lisbon");
  });

  it("never overwrites a zone that is already set", async () => {
    await get(`?today=${TODAY}&offset=0&zone=Europe%2FLisbon`);
    await get(`?today=${TODAY}&offset=0&zone=Asia%2FDubai`);
    expect(await readTimeZone(zoneDir)).toBe("Europe/Lisbon");
  });

  it("answers the list even when the zone offered is nonsense", async () => {
    const res = await get(`?today=${TODAY}&offset=0&zone=Mars%2FOlympus`);
    expect(res.status).toBe(200);
    expect(await readTimeZone(zoneDir)).toBeNull();
  });

  it("captures nothing when no zone is offered", async () => {
    const res = await get(`?today=${TODAY}&offset=0`);
    expect(res.status).toBe(200);
    expect(await readTimeZone(zoneDir)).toBeNull();
  });

  it("captures nothing from a request the day gate refused", async () => {
    const res = await get(`?today=tomorrow&offset=0&zone=Europe%2FLisbon`);
    expect(res.status).toBe(400);
    expect(await readTimeZone(zoneDir)).toBeNull();
  });
});
