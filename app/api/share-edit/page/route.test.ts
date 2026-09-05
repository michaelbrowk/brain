import { afterEach, describe, expect, it, vi } from "vitest";
import {
  jsonBody,
  mockShareEditModules,
  restoreShareEditModules,
  ROOT_ID,
  SHARE_VERSION,
  SRC,
  TARGET_ID,
  VISITOR_NAME,
  visitorRequest,
} from "@/test/share-edit-request";

async function post(
  body: unknown,
  store: Record<string, unknown>,
  options: {
    parent?: string | null;
    declareLength?: boolean;
    contentLength?: number;
    text?: () => Promise<string>;
  } = {},
) {
  const { resolve } = mockShareEditModules(store);
  const { POST } = await import("./route");
  const json = jsonBody(body, options);
  if (options.contentLength !== undefined) {
    json.headers["Content-Length"] = String(options.contentLength);
  }
  const parent = options.parent === undefined ? TARGET_ID : options.parent;
  const path =
    parent === null
      ? "/api/share-edit/page"
      : `/api/share-edit/page?parent=${encodeURIComponent(parent)}`;
  const req = await visitorRequest(path, { method: "POST", ...json });
  if (options.text) Object.defineProperty(req, "text", { value: options.text });
  const res = await POST(req);
  return { res, resolve };
}

describe("POST /api/share-edit/page", () => {
  afterEach(restoreShareEditModules);

  it("creates a subpage under the parent named on the URL and returns its id", async () => {
    const createSharedSubpage = vi.fn().mockResolvedValue({
      id: "new-1",
      title: "A note",
      updatedByName: VISITOR_NAME,
    });
    const { res } = await post({ title: "A note" }, { createSharedSubpage });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "new-1" });
    expect(createSharedSubpage).toHaveBeenCalledWith({
      rootId: ROOT_ID,
      parentId: TARGET_ID,
      shareVersion: SHARE_VERSION,
      title: "A note",
      visitorName: VISITOR_NAME,
      src: SRC,
    });
  });

  it("answers the 200-descendant ceiling with 409 subtree_full", async () => {
    const { ShareSubtreeFullError } = await import("@/lib/store");
    const { res } = await post(
      { title: "one too many" },
      {
        createSharedSubpage: vi
          .fn()
          .mockRejectedValue(new ShareSubtreeFullError()),
      },
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "subtree_full" });
  });

  it("bounds the title to 200 characters, strips control characters and falls back to Untitled", async () => {
    const cases: Array<[string, string]> = [
      ["a".repeat(250), "a".repeat(200)],
      ["  Notes \nfromAda  ", "Notes fromAda"],
      ["   ", "Untitled"],
    ];
    for (const [given, expected] of cases) {
      const createSharedSubpage = vi.fn().mockResolvedValue({ id: "new-1" });
      const { res } = await post({ title: given }, { createSharedSubpage });
      expect(res.status).toBe(200);
      expect(createSharedSubpage).toHaveBeenCalledWith(
        expect.objectContaining({ title: expected }),
      );
      restoreShareEditModules();
    }
  });

  it("refuses a missing or malformed parent before reading the body or touching the Store", async () => {
    const createSharedSubpage = vi.fn();
    for (const parent of [null, "", "not a page id!"]) {
      const text = vi.fn();
      const { res, resolve } = await post(
        { title: "x" },
        { createSharedSubpage },
        { parent, text },
      );
      expect(res.status, String(parent)).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "missing_share_context",
      });
      expect(text).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      restoreShareEditModules();
    }
    expect(createSharedSubpage).not.toHaveBeenCalled();
  });

  it("refuses a body without a title string, and only after the guard has passed", async () => {
    const createSharedSubpage = vi.fn();
    for (const body of ["not json", {}, { title: ["x"] }, { title: 7 }]) {
      const { res, resolve } = await post(body, { createSharedSubpage });
      expect(res.status, JSON.stringify(body)).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad request" });
      expect(resolve).toHaveBeenCalledTimes(1);
      restoreShareEditModules();
    }
    expect(createSharedSubpage).not.toHaveBeenCalled();
  });

  it("refuses a body over 4 KiB before req.text() is ever awaited, declared or not", async () => {
    const createSharedSubpage = vi.fn();
    const text = vi.fn();
    const declared = await post(
      { title: "x" },
      { createSharedSubpage },
      { contentLength: 4 * 1024 + 1, text },
    );
    expect(declared.res.status).toBe(413);
    await expect(declared.res.json()).resolves.toEqual({ error: "too_large" });
    expect(text).not.toHaveBeenCalled();
    expect(declared.resolve).toHaveBeenCalledTimes(1);

    restoreShareEditModules();
    const undeclared = await post(
      { title: "x".repeat(4 * 1024) },
      { createSharedSubpage },
      { declareLength: false },
    );
    expect(undeclared.res.status).toBe(413);
    expect(createSharedSubpage).not.toHaveBeenCalled();
  });

  it("exports no DELETE and no PATCH", async () => {
    const handlers = await import("./route");
    expect("DELETE" in handlers).toBe(false);
    expect("PATCH" in handlers).toBe(false);
    expect("GET" in handlers).toBe(false);
    expect(typeof handlers.POST).toBe("function");
  });
});
