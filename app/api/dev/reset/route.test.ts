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
const ORIGIN = "https://brain.example";
const originHolder = { current: ORIGIN as string | null };
vi.mock("@/lib/store", () => ({
  getStore: async () => ({ allTasks, deleteTask, getTree, deletePage, emptyTrash }),
  configuredPublicOrigin: () => originHolder.current,
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
  originHolder.current = ORIGIN;
  vi.stubEnv("BRAIN_E2E_RESET", "1");
  vi.stubEnv("NODE_ENV", "development");
});

/** The request the harness makes: a same-origin `fetch` out of a page, which
 *  the Fetch spec gives an `Origin` because the method is not GET. */
function post(origin: string | null = ORIGIN): Promise<Response> {
  return POST(
    new Request("https://brain.example/api/dev/reset", {
      method: "POST",
      headers: origin === null ? {} : { origin },
    }),
  );
}

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
    const response = await post();
    expect(response.status).toBe(404);
    expect(deletePage).not.toHaveBeenCalled();
  });

  it("is not there in production, seam or no seam", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await post();
    expect(response.status).toBe(404);
    expect(deletePage).not.toHaveBeenCalled();
  });

  // The gate is an allowlist, the form `app/dev/glass/page.tsx` uses. A
  // denylist on "production" reads every other spelling as unlocked, and there
  // are plenty: unset (a bare `node server.js`), `prod`, `Production`,
  // `staging`. Each of those is a host that is not a test runner.
  it("is not there for any environment but development and test", async () => {
    for (const value of ["", "prod", "Production", "staging", "PRODUCTION"]) {
      vi.stubEnv("NODE_ENV", value);
      expect((await post()).status, value).toBe(404);
    }
    expect(deletePage).not.toHaveBeenCalled();
    for (const value of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", value);
      expect((await post()).status, value).toBe(200);
    }
  });

  it("is not there for a seam set to anything but 1", async () => {
    vi.stubEnv("BRAIN_E2E_RESET", "true");
    expect((await post()).status).toBe(404);
  });

  // The session cookie is `sameSite: "lax"`, so a cross-SITE post carries no
  // cookie and never reaches here. What this closes is the same-site residue:
  // another dev server on localhost, or a sibling host under one registrable
  // domain. The rule is `lib/share-origin.ts`'s, the one the visitor write
  // surface applies, and a write does not let the fetch-metadata attestation
  // decide: no Origin is a refusal.
  it("refuses a post that carries no Origin", async () => {
    const response = await post(null);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "bad_origin" });
    expect(deletePage).not.toHaveBeenCalled();
    expect(emptyTrash).not.toHaveBeenCalled();
  });

  it("refuses a post from another origin", async () => {
    expect((await post("https://attacker.example")).status).toBe(403);
    expect(emptyTrash).not.toHaveBeenCalled();
  });

  it("refuses every post when no public origin is configured", async () => {
    originHolder.current = null;
    expect((await post()).status).toBe(403);
    expect((await post(null)).status).toBe(403);
    expect(emptyTrash).not.toHaveBeenCalled();
  });

  // The seam decides before the origin does, so a locked instance answers the
  // same 404 to every caller and discloses nothing about what it would check
  // next.
  it("answers the locked 404 before it looks at the Origin", async () => {
    vi.stubEnv("BRAIN_E2E_RESET", "");
    expect((await post(null)).status).toBe(404);
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

    const response = await post();
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
    expect((await (await post()).json()).notifications).toBe(2);
    expect(await listNotifications(dirHolder.current)).toEqual([]);
  });
});

describe("the route surface", () => {
  it("is not exempted in proxy.ts, so the owner session is a fourth gate", async () => {
    const proxy = await readFile(path.join(process.cwd(), "proxy.ts"), "utf8");
    expect(proxy).not.toContain("/api/dev");
  });

  // THE VERB IS A GATE, AND ABSENCE IS THE WHOLE OF IT.
  //
  // Next answers 405 for a verb the module does not export, so "only a POST"
  // is a promise about this module's export list and nothing else holds it: an
  // `export const GET = POST` makes a wipe reachable from an <img src> or a
  // click on a link, neither of which carries an Origin a check could refuse
  // before the wipe — a GET is the one shape browsers send bare. Pinned as the
  // exact set, the way `lib/module-gate.test.ts` pins its route list, so a verb
  // added here has to be argued for rather than discovered.
  // `handlers` and not `module`: `@next/next/no-assign-module-variable` refuses
  // that binding anywhere in a file Next bundles, the same rule `proxy.ts` names.
  it("exports no handler but POST, which is what answers 405 to the rest", async () => {
    const handlers = await import("./route");
    expect(Object.keys(handlers).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(handlers.dynamic).toBe("force-dynamic");
    expect(handlers.runtime).toBe("nodejs");
  });
});
