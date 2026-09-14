import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "account-adeadbeefdeadbeefdeadbeefdeadbeef";
const ID_ONE = "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d6f6e65";
const ID_TWO = "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d74776f";

let posted: unknown[] = [];

async function seam() {
  vi.resetModules();
  return import("./notifications-read");
}

beforeEach(() => {
  posted = [];
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({ read: 0 }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the read seam's batching", () => {
  it("sends one request for a run of threads, not one per thread", async () => {
    const { markMailNotificationRead } = await seam();
    markMailNotificationRead(ACCOUNT, "thread-one");
    markMailNotificationRead(ACCOUNT, "thread-two");
    // Bulk Done marks a thread per archive, each one a round trip apart, so
    // the window has to survive the gaps between them.
    await vi.advanceTimersByTimeAsync(200);
    markMailNotificationRead(ACCOUNT, "thread-three");
    expect(posted).toEqual([]);

    await vi.advanceTimersByTimeAsync(250);
    expect(posted).toHaveLength(1);
    expect((posted[0] as { ids: string[] }).ids).toEqual([
      ID_ONE,
      ID_TWO,
      "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d7468726565",
    ]);
  });

  it("counts one thread marked twice inside a window once", async () => {
    const { markMailNotificationRead } = await seam();
    markMailNotificationRead(ACCOUNT, "thread-one");
    markMailNotificationRead(ACCOUNT, "thread-one");
    await vi.advanceTimersByTimeAsync(250);
    expect(posted).toEqual([{ ids: [ID_ONE] }]);
  });

  it("sends nothing at all when nothing was marked", async () => {
    const { flushMailNotificationReads } = await seam();
    flushMailNotificationReads();
    await vi.advanceTimersByTimeAsync(500);
    expect(posted).toEqual([]);
  });

  it("does not wait out the window once a hundred threads are owed", async () => {
    const { markMailNotificationRead } = await seam();
    for (let index = 0; index < 100; index += 1) {
      markMailNotificationRead(ACCOUNT, `thread-${index}`);
    }
    // A reader holding the down arrow restarts the window on every keypress,
    // so the size is the second way out of it.
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toHaveLength(1);
    expect((posted[0] as { ids: string[] }).ids).toHaveLength(100);
  });

  it("lets a caller close its own run without waiting", async () => {
    const { markMailNotificationRead, flushMailNotificationReads } = await seam();
    markMailNotificationRead(ACCOUNT, "thread-one");
    flushMailNotificationReads();
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toEqual([{ ids: [ID_ONE] }]);

    // And the window it cancelled does not fire a second, empty request.
    await vi.advanceTimersByTimeAsync(500);
    expect(posted).toHaveLength(1);
  });

  it("says nothing for an account id no notification id can carry", async () => {
    const { markMailNotificationRead } = await seam();
    markMailNotificationRead("account a", "thread-one");
    await vi.advanceTimersByTimeAsync(500);
    expect(posted).toEqual([]);
  });

  it("does not throw at its caller when fetch throws rather than rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("blocked by the runtime");
      }),
    );
    const { markMailNotificationRead } = await seam();
    expect(() => markMailNotificationRead(ACCOUNT, "thread-one")).not.toThrow();
    // The window closes on a flush that swallows it too, so the timer callback
    // does not reject into an unhandled rejection either.
    await vi.advanceTimersByTimeAsync(500);
    expect(posted).toEqual([]);
  });
});

/** Walk the import graph the bundler would walk, over this tree's own modules
 *  only. A `zod` import anywhere in it is a schema construction in Mail's
 *  chunk: `notificationSchema` is built at module scope and `package.json`
 *  declares no `sideEffects`, so the bundler cannot prune it. */
async function localImportGraph(entry: string): Promise<Map<string, string>> {
  const root = process.cwd();
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const source = await readFile(path.join(root, file), "utf8");
    seen.set(file, source);
    for (const match of source.matchAll(/^\s*(?:import|export)[^"']*["']([^"']+)["']/gm)) {
      const specifier = match[1];
      let resolved: string | null = null;
      if (specifier.startsWith("@/")) resolved = specifier.slice(2);
      else if (specifier.startsWith("./") || specifier.startsWith("../")) {
        resolved = path.normalize(path.join(path.dirname(file), specifier));
      }
      if (resolved === null) continue;
      queue.push(resolved.endsWith(".ts") ? resolved : `${resolved}.ts`);
    }
  }
  return seen;
}

describe("what the seam drags into Mail's bundle", () => {
  it("reaches no zod-carrying module", async () => {
    const graph = await localImportGraph("components/notifications-read.ts");
    // The guard is only worth anything if it walked past the entry file.
    expect(graph.has("lib/notifications/ids.ts")).toBe(true);
    const carriers = [...graph]
      .filter(([, source]) => /from\s+["']zod["']/.test(source))
      .map(([file]) => file);
    expect(carriers).toEqual([]);
  });

  it("would notice a zod-carrying module, which is what makes the row above mean something", async () => {
    const graph = await localImportGraph("lib/notifications/store.ts");
    const carriers = [...graph]
      .filter(([, source]) => /from\s+["']zod["']/.test(source))
      .map(([file]) => file);
    expect(carriers).toContain("lib/notifications/model.ts");
  });
});
