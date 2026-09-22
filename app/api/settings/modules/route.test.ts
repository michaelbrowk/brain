import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readModules, resetOwnerSettingsCache, setModules } from "@/lib/owner-settings";
import { brainEvents } from "@/lib/store/events";
import { GET, PUT } from "./route";

// The mail service is a socket that is not there in a test, and the cases
// below are about the setting rather than about the other process. The
// service's own describe at the foot of this file replaces this per case.
vi.mock("@/lib/mail/module-sync", () => ({
  tellMailServiceAboutModules: async () => true,
}));

// The real settings file against a temp state directory rather than a mock:
// the route is validation over it, and what matters is that the switch the
// owner flipped is the switch the next read answers.
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-modules-route-"));
  process.env.BRAIN_SETTINGS_STATE_DIR = dir;
  resetOwnerSettingsCache(dir);
});

afterEach(async () => {
  delete process.env.BRAIN_SETTINGS_STATE_DIR;
  resetOwnerSettingsCache(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

async function put(body: string) {
  return PUT(
    new NextRequest("https://brain.test/api/settings/modules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
}

describe("GET /api/settings/modules", () => {
  it("answers both modules on before anything is written", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ mail: true, tasks: true });
  });

  it("answers what was written", async () => {
    await setModules({ mail: false }, dir);
    expect(await (await GET()).json()).toEqual({ mail: false, tasks: true });
  });
});

describe("PUT /api/settings/modules", () => {
  it("turns one module off and answers the pair that stands", async () => {
    const response = await put(JSON.stringify({ mail: false }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mail: false, tasks: true });
    expect(await readModules(dir)).toEqual({ mail: false, tasks: true });
  });

  it("takes both keys at once", async () => {
    await put(JSON.stringify({ mail: false, tasks: false }));
    expect(await readModules(dir)).toEqual({ mail: false, tasks: false });
  });

  // Every open tab re-renders off this one event, so it carries the booleans
  // rather than making each tab ask.
  it("broadcasts the change on the live channel", async () => {
    const seen: Record<string, unknown>[] = [];
    const listen = (event: Record<string, unknown>) => seen.push(event);
    brainEvents.on("change", listen);
    try {
      await put(JSON.stringify({ tasks: false }));
    } finally {
      brainEvents.off("change", listen);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "modules",
      id: "modules",
      modules: { mail: true, tasks: false },
    });
    // No `src`: the tab that flipped the switch has to re-render too, and the
    // shell's own-echo guard drops anything carrying its own client id.
    expect(seen[0].src).toBeUndefined();
  });

  it("writes nothing and broadcasts nothing when nothing changes", async () => {
    await setModules({ mail: false }, dir);
    const before = await fs.stat(path.join(dir, "owner.json"));
    const seen: unknown[] = [];
    const listen = (event: unknown) => seen.push(event);
    brainEvents.on("change", listen);
    try {
      const response = await put(JSON.stringify({ mail: false }));
      expect(await response.json()).toEqual({ mail: false, tasks: true });
    } finally {
      brainEvents.off("change", listen);
    }
    expect(seen).toEqual([]);
    expect((await fs.stat(path.join(dir, "owner.json"))).mtimeMs).toBe(before.mtimeMs);
  });

  it.each([
    ['{"mail":"off"}', "bad_modules"],
    ['{"mail":1}', "bad_modules"],
    ['{"mail":null}', "bad_modules"],
    ["{}", "bad_modules"],
    ['{"notes":false}', "bad_modules"],
    ["[]", "bad_body"],
    ["not json", "bad_body"],
  ])("refuses %s with %s", async (body, error) => {
    const response = await put(body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(error);
    expect(await readModules(dir)).toEqual({ mail: true, tasks: true });
  });

  it("names the cure in a sentence the settings row can show", async () => {
    const body = (await (await put('{"mail":"off"}')).json()) as { reason?: string };
    expect(typeof body.reason).toBe("string");
    expect(body.reason).not.toContain("—");
  });

  it("does not reach the notes store", async () => {
    // The settings file is not a note. Nothing here enters `mutate()`, so the
    // one-writer invariant is untouched by a switch.
    const source = await fs.readFile(path.join(import.meta.dirname, "route.ts"), "utf8");
    expect(source).not.toContain("getStore");
  });
});

/** THE OTHER PROCESS. The mail service cannot read the settings file, so the
 *  switch reaches it over its socket, and the socket is a thing that fails.
 *  What the owner asked for is written either way: the setting is the truth
 *  and the startup call is the repair. */
describe("PUT /api/settings/modules and the mail service", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/mail/module-sync");
  });

  async function putWith(told: () => Promise<boolean>, body: unknown) {
    vi.doMock("@/lib/mail/module-sync", () => ({
      tellMailServiceAboutModules: told,
    }));
    const { PUT: handler } = await import("./route");
    return handler(
      new NextRequest("https://brain.test/api/settings/modules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("tells the service the pause, and still answers the pair", async () => {
    const told = vi.fn(async () => true);
    const response = await putWith(told, { mail: false });
    expect(await response.json()).toEqual({ mail: false, tasks: true });
    expect(told).toHaveBeenCalledTimes(1);
  });

  it("writes the setting anyway when the service does not answer, and says so", async () => {
    const response = await putWith(
      vi.fn(async () => false),
      { mail: false },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mail: false,
      tasks: true,
      mailService: "unreachable",
    });
    expect(await readModules(dir)).toEqual({ mail: false, tasks: true });
  });

  it("does not ask the service when only Tasks moved", async () => {
    const told = vi.fn(async () => true);
    await putWith(told, { tasks: false });
    expect(told).not.toHaveBeenCalled();
  });

  it("does not ask the service when nothing changed", async () => {
    await setModules({ mail: false }, dir);
    const told = vi.fn(async () => true);
    await putWith(told, { mail: false });
    expect(told).not.toHaveBeenCalled();
  });

  // `changed` is true when EITHER switch moved, so this body would PATCH off
  // the tasks half alone if the condition read that flag instead of comparing
  // the mail switch before against after.
  it("does not ask the service when only Tasks moved inside a two-key body", async () => {
    await setModules({ mail: false }, dir);
    const told = vi.fn(async () => true);
    await putWith(told, { mail: false, tasks: false });
    expect(told).not.toHaveBeenCalled();
  });
});

/** THE VALUE ON THE WIRE, not just the fact of a call.
 *
 *  The route hands the pair it wrote to `tellMailServiceAboutModules`, and
 *  this is the only place that is checked end to end: the real module-sync
 *  runs, and it is the mail client underneath that is replaced. Without it,
 *  a version that read the file before the write instead of after would pass
 *  every other case in this file and leave the service syncing with Mail off.
 */
describe("PUT /api/settings/modules and the value the socket is handed", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/mail/brain-mail-client");
  });

  async function putThroughTheRealSync(body: unknown) {
    const setSyncEnabled = vi.fn(async () => ({ paused: true }));
    vi.resetModules();
    // The module under test stays real; the socket underneath it does not.
    vi.doUnmock("@/lib/mail/module-sync");
    vi.doMock("@/lib/mail/brain-mail-client", () => ({
      createBrainMailClient: () => ({ setSyncEnabled }),
    }));
    const { PUT: handler } = await import("./route");
    const response = await handler(
      new NextRequest("https://brain.test/api/settings/modules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { response, setSyncEnabled };
  }

  it("sends the service the switch the PUT just wrote, both ways", async () => {
    const off = await putThroughTheRealSync({ mail: false });
    expect(off.response.status).toBe(200);
    expect(await off.response.json()).toEqual({ mail: false, tasks: true });
    expect(off.setSyncEnabled).toHaveBeenCalledTimes(1);
    expect(off.setSyncEnabled).toHaveBeenCalledWith(false);
    expect(await readModules(dir)).toEqual({ mail: false, tasks: true });

    const on = await putThroughTheRealSync({ mail: true });
    expect(await on.response.json()).toEqual({ mail: true, tasks: true });
    expect(on.setSyncEnabled).toHaveBeenCalledWith(true);
    expect(await readModules(dir)).toEqual({ mail: true, tasks: true });
  });
});
