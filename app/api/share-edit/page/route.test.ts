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

const PATH = "/api/share-edit/page";

async function post(
  body: unknown,
  store: Record<string, unknown>,
  options: { declareLength?: boolean; contentLength?: number } = {},
) {
  const { resolve } = mockShareEditModules(store);
  const { POST } = await import("./route");
  const json = jsonBody(body, options);
  if (options.contentLength !== undefined) {
    json.headers["Content-Length"] = String(options.contentLength);
  }
  const res = await POST(await visitorRequest(PATH, { method: "POST", ...json }));
  return { res, resolve };
}

describe("POST /api/share-edit/page", () => {
  afterEach(restoreShareEditModules);

  it("creates a subpage under a parent inside the subtree and returns its id", async () => {
    const createSharedSubpage = vi.fn().mockResolvedValue({
      id: "new-1",
      title: "A note",
      updatedByName: VISITOR_NAME,
    });
    const { res } = await post(
      { parentId: TARGET_ID, title: "A note" },
      { createSharedSubpage },
    );

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
      { parentId: TARGET_ID, title: "one too many" },
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
      ["  Notes\u0000\nfrom\u001bAda  ", "NotesfromAda"],
      ["   ", "Untitled"],
    ];
    for (const [given, expected] of cases) {
      const createSharedSubpage = vi.fn().mockResolvedValue({ id: "new-1" });
      const { res } = await post(
        { parentId: TARGET_ID, title: given },
        { createSharedSubpage },
      );
      expect(res.status).toBe(200);
      expect(createSharedSubpage).toHaveBeenCalledWith(
        expect.objectContaining({ title: expected }),
      );
      restoreShareEditModules();
    }
  });

  it("refuses a body without a string parentId and title before the guard runs", async () => {
    const createSharedSubpage = vi.fn();
    for (const body of [
      "not json",
      { title: "no parent" },
      { parentId: TARGET_ID },
      { parentId: 7, title: "x" },
      { parentId: TARGET_ID, title: ["x"] },
    ]) {
      const { res, resolve } = await post(body, { createSharedSubpage });
      expect(res.status, JSON.stringify(body)).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad request" });
      expect(resolve).not.toHaveBeenCalled();
      restoreShareEditModules();
    }
    expect(createSharedSubpage).not.toHaveBeenCalled();
  });

  it("refuses a body over 4 KiB before reading it and before the guard runs", async () => {
    const createSharedSubpage = vi.fn();
    const declared = await post(
      { parentId: TARGET_ID, title: "x" },
      { createSharedSubpage },
      { contentLength: 4 * 1024 + 1 },
    );
    expect(declared.res.status).toBe(413);
    await expect(declared.res.json()).resolves.toEqual({ error: "too_large" });
    expect(declared.resolve).not.toHaveBeenCalled();

    restoreShareEditModules();
    const undeclared = await post(
      { parentId: TARGET_ID, title: "x".repeat(4 * 1024) },
      { createSharedSubpage },
      { declareLength: false },
    );
    expect(undeclared.res.status).toBe(413);
    expect(undeclared.resolve).not.toHaveBeenCalled();
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
