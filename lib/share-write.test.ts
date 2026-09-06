import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShareEditToken, shareEditCookieName } from "@/lib/auth";
import { SHARE_VID_HEADER, violatesShareRouteRule } from "./share-write";

const ORIGIN = "https://brain.test";
const VID = "vid123456789";

function granted() {
  return {
    kind: "granted" as const,
    root: { meta: { id: "root-1", public: true, shareEdit: true, shareVersion: 2 } },
    target: { meta: { id: "page-9" } },
    shareVersion: 2,
    directChildren: [],
  };
}

/** The seven leaves a visitor route may reach, and six it may not. The live
 *  Store carries both sets, so a guard that hands `run` the instance hands it
 *  the second set too. */
const ALLOWED_LEAVES = [
  "readPage",
  "readDirectChildren",
  "isDeleted",
  "isWithinSubtree",
  "writeSharedPage",
  "createSharedSubpage",
  "saveSharedAttachment",
] as const;

const FORBIDDEN_LEAVES = [
  "deletePage",
  "purgePage",
  "movePage",
  "renamePage",
  "updateMeta",
  "historicalMarkdownForRev",
] as const;

function liveStoreMock(): Record<string, ReturnType<typeof vi.fn>> {
  const store: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of [...ALLOWED_LEAVES, ...FORBIDDEN_LEAVES]) {
    store[name] = vi.fn(() => `${name} ran`);
  }
  return store;
}

/** Every store method is a spy, so "the store was never touched" is provable. */
function storeMock(access: unknown = granted()) {
  const resolve = vi.fn().mockResolvedValue(access);
  const live = liveStoreMock();
  const getStore = vi.fn().mockResolvedValue(live);
  vi.doMock("@/lib/store", () => ({
    getStore,
    configuredPublicOrigin: () => ORIGIN,
  }));
  vi.doMock("@/lib/share-access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/share-access")>(
      "@/lib/share-access",
    );
    return { ...actual, resolveShareAccess: resolve };
  });
  return { resolve, getStore, live };
}

async function request(
  overrides: {
    root?: string;
    v?: string;
    origin?: string | null;
    cookie?: string;
    vid?: string | null;
    fetchSite?: string;
  } = {},
) {
  const url = new URL("https://brain.test/api/share-edit/page/page-9");
  url.searchParams.set("root", overrides.root ?? "root-1");
  url.searchParams.set("v", overrides.v ?? "2");
  const headers = new Headers({ "Content-Type": "application/json" });
  if (overrides.origin !== null) headers.set("Origin", overrides.origin ?? ORIGIN);
  if (overrides.fetchSite) headers.set("Sec-Fetch-Site", overrides.fetchSite);
  const cookie =
    overrides.cookie ??
    `${shareEditCookieName("root-1")}=${await createShareEditToken("root-1", 2, VID, "Ada")}`;
  if (cookie) headers.set("cookie", cookie);
  if (overrides.vid !== null) headers.set(SHARE_VID_HEADER, overrides.vid ?? VID);
  return new NextRequest(url, { method: "PUT", headers, body: "{}" });
}

/** A request whose edit cookie and double submit carry the given `vid`, the
 *  way a visitor who re-minted their cookie would arrive. */
async function requestAs(vid: string, root = "root-1") {
  return request({
    root,
    cookie: `${shareEditCookieName(root)}=${await createShareEditToken(root, 2, vid, "Ada")}`,
    vid,
  });
}

const run = vi.fn(async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 }),
);

describe("share-write refusal order", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "share-write-secret");
    run.mockClear();
  });
  afterEach(() => {
    vi.doUnmock("@/lib/store");
    vi.doUnmock("@/lib/share-access");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses a missing share context before anything else", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const url = new URL("https://brain.test/api/share-edit/page/page-9");
    const res = await guard(
      new NextRequest(url, { method: "PUT" }),
      { targetId: "page-9", bucket: "write" },
      run,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "missing_share_context" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getStore).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a foreign origin before the cookie is even read", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const res = await guard(
      await request({ origin: "https://evil.test", cookie: "" }),
      { targetId: "page-9", bucket: "write" },
      run,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "bad_origin" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getStore).not.toHaveBeenCalled();
  });

  it("lets a same-origin read through without an Origin header", async () => {
    // A same-origin GET carries no Origin at all, and a script cannot add one
    // (it is a forbidden header name), so a read leans on the browser's
    // fetch-metadata attestation instead.
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const res = await guard(
      await request({ origin: null, fetchSite: "same-origin" }),
      { targetId: "page-9", bucket: "read" },
      run,
    );
    expect(res.status).toBe(200);
    expect(getStore).toHaveBeenCalledTimes(1);
  });

  it("lets a read through when neither Origin nor the attestation arrived, because the double submit already proves it", async () => {
    // The conflict refresh is a same-origin fetch() GET, which carries no
    // Origin at all: the Fetch spec appends one only for a CORS-tainted or a
    // non-GET request, and a script cannot add it. So the whole refusal rested
    // on Sec-Fetch-Site, and behind a proxy that strips it the 409 became a
    // 403, which the editor reads as "unsaved" with no conflict banner and no
    // Reload. What still refuses a stranger here is step 4: a cross-site page
    // cannot read the HttpOnly edit cookie, so it cannot echo the vid.
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const res = await guard(
      await request({ origin: null }),
      { targetId: "page-9", bucket: "read" },
      run,
    );
    expect(res.status).toBe(200);
    expect(getStore).toHaveBeenCalledTimes(1);
  });

  it("still refuses a read whose double submit is missing, however it arrived", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const res = await guard(
      await request({ origin: null, vid: null }),
      { targetId: "page-9", bucket: "read" },
      run,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "vid_mismatch" });
    expect(getStore).not.toHaveBeenCalled();
  });

  it("refuses a read the browser attests is cross-site, and a foreign Origin whatever the attestation says", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const crossSite = await guard(
      await request({ origin: null, fetchSite: "cross-site" }),
      { targetId: "page-9", bucket: "read" },
      run,
    );
    const foreign = await guard(
      await request({ origin: "https://evil.test", fetchSite: "same-origin" }),
      { targetId: "page-9", bucket: "read" },
      run,
    );
    for (const res of [crossSite, foreign]) {
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "bad_origin" });
    }
    expect(getStore).not.toHaveBeenCalled();
  });

  it("keeps the strict Origin check on every mutating bucket", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    for (const bucket of ["write", "upload", "create"] as const) {
      const res = await guard(
        await request({ origin: null, fetchSite: "same-origin" }),
        { targetId: "page-9", bucket },
        run,
      );
      expect(res.status, bucket).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "bad_origin" });
    }
    expect(getStore).not.toHaveBeenCalled();
  });

  it("answers a missing or wrong-version cookie with the uniform 404, without the store", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");

    const none = await guard(
      await request({ cookie: "" }),
      { targetId: "page-9", bucket: "write" },
      run,
    );
    const stale = await guard(
      await request({ v: "3" }),
      { targetId: "page-9", bucket: "write" },
      run,
    );

    for (const res of [none, stale]) {
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "not found" });
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(getStore).not.toHaveBeenCalled();
  });

  it("refuses a double-submit mismatch with 403, still without the store", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const res = await guard(
      await request({ vid: "not-the-vid" }),
      { targetId: "page-9", bucket: "write" },
      run,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "vid_mismatch" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getStore).not.toHaveBeenCalled();
  });

  it("spends the per-root bucket before the per-visitor one, and 429s without the store", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    let last: Response | undefined;
    for (let i = 0; i < 61; i += 1) {
      last = await guard(await request(), { targetId: "page-9", bucket: "write" }, run);
    }
    expect(last!.status).toBe(429);
    await expect(last!.json()).resolves.toEqual({ error: "share_edit_rate" });
    expect(last!.headers.get("Retry-After")).toBeTruthy();
    expect(last!.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getStore).toHaveBeenCalledTimes(60);
  });

  it("keeps the per-visitor limit per visitor while the root has budget", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    let last: Response | undefined;
    for (let i = 0; i < 11; i += 1) {
      last = await guard(await requestAs("vid-a"), { targetId: "page-9", bucket: "create" }, run);
    }
    expect(last!.status).toBe(429);
    const other = await guard(
      await requestAs("vid-b"),
      { targetId: "page-9", bucket: "create" },
      run,
    );
    expect(other.status).toBe(200);
    expect(getStore).toHaveBeenCalledTimes(11);
  });

  it("holds a visitor who rotates their identity at the per-root ceiling", async () => {
    // The mint hands out a fresh vid thirty times a minute, so a per-visitor
    // bucket on its own is no ceiling. Thirty-one distinct vids, none of them
    // near the per-visitor limit of ten, still stop at the root's thirty.
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const res = await guard(
        await requestAs(`vid-${i}`),
        { targetId: "page-9", bucket: "create" },
        run,
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(200));
    expect(statuses[30]).toBe(429);
    expect(getStore).toHaveBeenCalledTimes(30);
  });

  it("does not let two abused roots lock a third root's visitor out of the read map", async () => {
    // Root-first accounting caps new visitor entries at the root limit per
    // root per window, so two roots driven to their read ceiling with a fresh
    // vid each time put 1,200 entries in the visitor map. A map that fails
    // closed at 1,024 would answer a third root's first visitor 429.
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    for (const root of ["root-a", "root-b"]) {
      for (let i = 0; i < 600; i += 1) {
        const res = await guard(
          await requestAs(`vid-${i}`, root),
          { targetId: "page-9", bucket: "read" },
          run,
        );
        expect(res.status, `${root} #${i}`).toBe(200);
      }
    }
    const third = await guard(
      await requestAs("vid-c", "root-c"),
      { targetId: "page-9", bucket: "read" },
      run,
    );
    expect(third.status).toBe(200);
    expect(getStore).toHaveBeenCalledTimes(1201);
  });

  it("spends the root bucket first, so a visitor past their own limit still drains the root", async () => {
    // One vid sends thirty creates: ten pass, twenty are refused by the
    // visitor bucket, but every one of the thirty was charged to the root
    // first. A fresh vid then finds the root spent. That is the pinned order:
    // the visitor map can only ever grow as fast as the root allows.
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    for (let i = 0; i < 30; i += 1) {
      await guard(await requestAs("vid-a"), { targetId: "page-9", bucket: "create" }, run);
    }
    expect(getStore).toHaveBeenCalledTimes(10);
    const fresh = await guard(
      await requestAs("vid-b"),
      { targetId: "page-9", bucket: "create" },
      run,
    );
    expect(fresh.status).toBe(429);
    expect(getStore).toHaveBeenCalledTimes(10);
  });

  it("keeps the read and write buckets apart, so a reload loop cannot block a save", async () => {
    const { getStore } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    let last: Response | undefined;
    for (let i = 0; i < 121; i += 1) {
      last = await guard(await request(), { targetId: "page-9", bucket: "read" }, run);
    }
    expect(last!.status).toBe(429);
    const save = await guard(await request(), { targetId: "page-9", bucket: "write" }, run);
    expect(save.status).toBe(200);
    expect(getStore).toHaveBeenCalledTimes(121);
  });

  it("collapses all seven authority failures into byte-identical 404s", async () => {
    const bodies: string[] = [];
    const headers: string[] = [];
    for (const failure of [
      "existence",
      "authority",
      "expiry",
      "version",
      "subtree",
      "root-liveness",
      "target-liveness",
    ]) {
      vi.resetModules();
      const resolve = vi.fn();
      vi.doMock("@/lib/store", () => ({
        getStore: async () => ({ marker: failure }),
        configuredPublicOrigin: () => ORIGIN,
      }));
      vi.doMock("@/lib/share-access", async () => {
        const actual = await vi.importActual<typeof import("@/lib/share-access")>(
          "@/lib/share-access",
        );
        return { ...actual, resolveShareAccess: resolve };
      });
      // The class must come from the module instance the guard will import:
      // resetModules() above gave share-access a fresh identity, and an error
      // from the previous one would not satisfy the guard's instanceof.
      const { ShareAccessNotFoundError } = await import("@/lib/share-access");
      resolve.mockRejectedValue(new ShareAccessNotFoundError());
      const { withShareWrite: guard } = await import("./share-write");
      const res = await guard(
        await request(),
        { targetId: "page-9", bucket: "read" },
        run,
      );
      expect(res.status).toBe(404);
      bodies.push(await res.text());
      headers.push(JSON.stringify([...res.headers].sort()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(new Set(headers).size).toBe(1);
  });

  it("refuses an editable-off root as the same 404", async () => {
    storeMock({ ...granted(), root: { meta: { id: "root-1", public: true, shareVersion: 2 } } });
    const { withShareWrite: guard } = await import("./share-write");
    const res = await guard(await request(), { targetId: "page-9", bucket: "write" }, run);
    expect(res.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("forwards the read cookie and never opens the password gate", async () => {
    const { resolve } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const edit = await createShareEditToken("root-1", 2, VID, "Ada");
    const req = await request({
      cookie: `${shareEditCookieName("root-1")}=${edit}; brain_share_root-1=read-cookie-value`,
    });
    const res = await guard(req, { targetId: "page-9", bucket: "write" }, run);
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][1]).toEqual({
      rootId: "root-1",
      targetId: "page-9",
      requestedVersion: "2",
      token: "read-cookie-value",
    });
  });

  it("answers a busy store with 503 and Retry-After: 1", async () => {
    const { ShareAccessBusyError } = await import("@/lib/share-access");
    const resolve = vi.fn().mockRejectedValue(new ShareAccessBusyError());
    vi.doMock("@/lib/store", () => ({
      getStore: async () => ({}),
      configuredPublicOrigin: () => ORIGIN,
    }));
    vi.doMock("@/lib/share-access", async () => {
      const actual = await vi.importActual<typeof import("@/lib/share-access")>(
        "@/lib/share-access",
      );
      return { ...actual, resolveShareAccess: resolve };
    });
    const { withShareWrite: guard } = await import("./share-write");
    const res = await guard(await request(), { targetId: "page-9", bucket: "write" }, run);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("hands the run callback the context and the store, and passes its response through", async () => {
    const { live } = storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const seen: unknown[] = [];
    const res = await guard(
      await request(),
      { targetId: "page-9", bucket: "write" },
      async (ctx, store) => {
        seen.push(ctx);
        store.isDeleted("page-9");
        return new Response(JSON.stringify({ rev: "abc" }), { status: 200 });
      },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ rev: "abc" });
    expect(seen[0]).toEqual({
      rootId: "root-1",
      targetId: "page-9",
      shareVersion: 2,
      vid: VID,
      name: "Ada",
    });
    // The handle is not the Store, so what proves it reached the Store is the
    // call landing on the live spy.
    expect(live.isDeleted).toHaveBeenCalledWith("page-9");
  });

  it("hands the run callback a handle without the raw mutators", async () => {
    storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    let handle: object | null = null;
    const res = await guard(
      await request(),
      { targetId: "page-9", bucket: "write" },
      async (_ctx, store) => {
        handle = store;
        // Checked by tsc, never run: each directive fails the typecheck the
        // day one of these reappears on the handle.
        const unreachable = () => {
          // @ts-expect-error: a visitor route cannot delete
          void store.deletePage;
          // @ts-expect-error: a visitor route cannot purge
          void store.purgePage;
          // @ts-expect-error: a visitor route cannot move
          void store.movePage;
          // @ts-expect-error: a visitor route cannot rename
          void store.renamePage;
          // @ts-expect-error: a visitor route cannot touch metadata
          void store.updateMeta;
        };
        void unreachable;
        return new Response("{}", { status: 200 });
      },
    );
    expect(res.status).toBe(200);
    // The runtime half. A Pick<> is erased at build time, so the type
    // directives above say nothing about the value: this does. A cast is all
    // it costs a future route to reach a forbidden leaf on a handle that is
    // the live Store.
    expect(handle).not.toBeNull();
    const value = handle as unknown as Record<string, unknown>;
    for (const leaf of FORBIDDEN_LEAVES) {
      expect(leaf in value, leaf).toBe(false);
      expect(value[leaf], leaf).toBeUndefined();
    }
    expect(Object.keys(value).sort()).toEqual([...ALLOWED_LEAVES].sort());
  });

  it("refuses a fifth simultaneous write with 503 and lets it through once one finishes", async () => {
    storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let allStarted!: () => void;
    const fourStarted = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    const slow = async () => {
      started += 1;
      if (started === 4) allStarted();
      await held;
      return new Response("{}", { status: 200 });
    };
    const four = Array.from({ length: 4 }, async () =>
      guard(await request(), { targetId: "page-9", bucket: "write" }, slow),
    );
    await fourStarted;
    const fifth = await guard(
      await request(),
      { targetId: "page-9", bucket: "write" },
      slow,
    );
    expect(fifth.status).toBe(503);
    expect(fifth.headers.get("Retry-After")).toBe("1");
    release();
    await Promise.all(four);
    const after = await guard(
      await request(),
      { targetId: "page-9", bucket: "write" },
      async () => new Response("{}", { status: 200 }),
    );
    expect(after.status).toBe(200);
  });

  it("lets a read through while four writes hold every slot", async () => {
    storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let allStarted!: () => void;
    const fourStarted = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    const slow = async () => {
      started += 1;
      if (started === 4) allStarted();
      await held;
      return new Response("{}", { status: 200 });
    };
    const four = Array.from({ length: 4 }, async () =>
      guard(await request(), { targetId: "page-9", bucket: "write" }, slow),
    );
    await fourStarted;
    const read = await guard(await request(), { targetId: "page-9", bucket: "read" }, run);
    expect(read.status).toBe(200);
    release();
    await Promise.all(four);
  });

  it("gives the slot back when the run callback throws", async () => {
    storeMock();
    const { withShareWrite: guard } = await import("./share-write");
    const boom = async () => {
      throw new Error("leaf failed");
    };
    for (let i = 0; i < 4; i += 1) {
      await expect(
        guard(await request(), { targetId: "page-9", bucket: "write" }, boom),
      ).rejects.toThrow("leaf failed");
    }
    const after = await guard(await request(), { targetId: "page-9", bucket: "write" }, run);
    expect(after.status).toBe(200);
  });
});

describe("the /api/share-edit route rule", () => {
  it("flags a route that reaches for the raw Store or exports a mutator", () => {
    expect(
      violatesShareRouteRule(
        'import { withShareWrite } from "@/lib/share-write";\nexport async function PUT() {}\n',
      ),
    ).toBeNull();
    expect(
      violatesShareRouteRule('import { getStore } from "@/lib/store";\n'),
    ).toBe("imports getStore instead of going through lib/share-write.ts");
    expect(
      violatesShareRouteRule(
        'import { withShareWrite } from "@/lib/share-write";\nexport async function DELETE() {}\n',
      ),
    ).toBe("exports a DELETE handler");
    expect(
      violatesShareRouteRule(
        'import { withShareWrite } from "@/lib/share-write";\nexport async function PATCH() {}\n',
      ),
    ).toBe("exports a PATCH handler");
    expect(
      violatesShareRouteRule("export async function PUT() {}\n"),
    ).toBe("does not go through withShareWrite");
  });

  it("flags every shape a DELETE or PATCH export can take", () => {
    const ok = 'import { withShareWrite } from "@/lib/share-write";\n';
    for (const line of [
      "export const DELETE = handler;",
      "export let PATCH = handler;",
      "export var PATCH = handler;",
      "export function DELETE() {}",
      "export async function PATCH() {}",
      "export { del as DELETE };",
      "export { PUT, patch as PATCH };",
      "export { DELETE };",
      "export {\n  del as DELETE,\n};",
    ]) {
      const verb = line.includes("DELETE") ? "DELETE" : "PATCH";
      expect(violatesShareRouteRule(`${ok}${line}\n`), line).toBe(
        `exports a ${verb} handler`,
      );
    }
    expect(violatesShareRouteRule(`${ok}export * from "./handlers";\n`)).toBe(
      "re-exports with export *",
    );
    expect(
      violatesShareRouteRule(`${ok}export { DELETE as remove };\nexport async function PUT() {}\n`),
    ).toBeNull();
  });

  it("reads getStore and withShareWrite in code, not in comments", () => {
    const ok =
      'import { withShareWrite } from "@/lib/share-write";\nexport async function PUT() {}\n';
    expect(violatesShareRouteRule(`// never call getStore here\n${ok}`)).toBeNull();
    expect(violatesShareRouteRule(`/* getStore is\n   off limits */\n${ok}`)).toBeNull();
    expect(
      violatesShareRouteRule(`${ok}const u = "https://x.test"; getStore();\n`),
    ).toBe("imports getStore instead of going through lib/share-write.ts");
    expect(
      violatesShareRouteRule(`${ok}const s = "// not a comment"; getStore();\n`),
    ).toBe("imports getStore instead of going through lib/share-write.ts");
    expect(
      violatesShareRouteRule("// withShareWrite\nexport async function PUT() {}\n"),
    ).toBe("does not go through withShareWrite");
  });

  it("holds for exactly the three route files under app/api/share-edit/", async () => {
    // Three files, four handlers: GET and PUT share one. A fourth file here
    // is a new visitor surface and has to be argued for, not discovered.
    const root = path.join(import.meta.dirname, "..", "app", "api", "share-edit");
    const files = await shareRouteFiles(root);
    expect(files.map((file) => path.relative(root, file)).sort()).toEqual([
      path.join("page", "[id]", "route.ts"),
      path.join("page", "route.ts"),
      path.join("upload", "route.ts"),
    ]);
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      expect(violatesShareRouteRule(source), file).toBeNull();
    }
  });

  it("would catch a bare getStore in a nested route.ts under that prefix", async () => {
    // Against a throwaway tree of the same shape: the walk finds a nested
    // route.ts, ignores every other file, and the rule rejects it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "share-edit-rule-"));
    try {
      const nested = path.join(dir, "page", "[id]");
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(dir, "layout.ts"), 'import { getStore } from "@/lib/store";\n');
      await fs.writeFile(
        path.join(nested, "route.ts"),
        'import { getStore } from "@/lib/store";\nexport async function PUT() {}\n',
      );
      const files = await shareRouteFiles(dir);
      expect(files).toEqual([path.join(nested, "route.ts")]);
      expect(violatesShareRouteRule(await fs.readFile(files[0], "utf8"))).toBe(
        "imports getStore instead of going through lib/share-write.ts",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/** Every `route.ts` under `root`. A missing tree is a failure, not an empty
 *  list: the exact-shape assertion above must never pass vacuously. */
async function shareRouteFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "route.ts") files.push(full);
    }
  };
  await walk(root);
  return files.sort();
}
