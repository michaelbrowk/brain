import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SHARE_WRITE_BYTES } from "@/lib/store/share-limits";
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

const ctx = { params: Promise.resolve({ id: TARGET_ID }) };
const PATH = `/api/share-edit/page/${TARGET_ID}`;

async function get(store: Record<string, unknown>) {
  mockShareEditModules(store);
  const { GET } = await import("./route");
  return GET(await visitorRequest(PATH), ctx);
}

async function put(
  body: unknown,
  store: Record<string, unknown> | (() => Promise<Record<string, unknown>>),
  options: { declareLength?: boolean } = {},
) {
  mockShareEditModules(store);
  const { PUT } = await import("./route");
  return PUT(
    await visitorRequest(PATH, { method: "PUT", ...jsonBody(body, options) }),
    ctx,
  );
}

describe("GET /api/share-edit/page/[id]", () => {
  afterEach(restoreShareEditModules);

  it("answers the body, the rev and the title, and nothing else of the meta", async () => {
    const readPage = vi.fn().mockResolvedValue({
      meta: {
        id: TARGET_ID,
        title: "Notes",
        sharePass: "hash",
        updatedByName: "Bob",
      },
      markdown: "hello",
      rev: "abcdefabcdef",
    });
    const res = await get({ readPage });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      markdown: "hello",
      rev: "abcdefabcdef",
      title: "Notes",
    });
    expect(readPage).toHaveBeenCalledWith(TARGET_ID);
  });

  it("404s a page that vanished between the guard and the read", async () => {
    const { NotFoundError } = await import("@/lib/store");
    const res = await get({
      readPage: vi.fn().mockRejectedValue(new NotFoundError(TARGET_ID)),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not found" });
  });
});

describe("PUT /api/share-edit/page/[id]", () => {
  afterEach(restoreShareEditModules);

  it("writes through writeSharedPage with the visitor's name and answers with the rev", async () => {
    const writeSharedPage = vi.fn().mockResolvedValue({
      meta: { id: TARGET_ID },
      markdown: "hello",
      rev: "abcdefabcdef",
    });
    const res = await put(
      { markdown: "hello", rev: "000000000000", baseMarkdown: "hell" },
      { writeSharedPage },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ rev: "abcdefabcdef" });
    expect(writeSharedPage).toHaveBeenCalledWith({
      rootId: ROOT_ID,
      targetId: TARGET_ID,
      shareVersion: SHARE_VERSION,
      markdown: "hello",
      expectedRev: "000000000000",
      expectedMarkdown: "hell",
      visitorName: VISITOR_NAME,
      src: SRC,
    });
  });

  it("answers a stale rev with the owner's exact 409 shape", async () => {
    const { RevConflictError } = await import("@/lib/store");
    const res = await put(
      { markdown: "hello", rev: "000000000000", baseMarkdown: "hell" },
      {
        writeSharedPage: vi
          .fn()
          .mockRejectedValue(new RevConflictError("ffffffffffff", "000000000000")),
      },
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "conflict",
      currentRev: "ffffffffffff",
    });
  });

  it("never resolves a visitor's stale rev through git history", async () => {
    // The owner's route hands a legacy 12-hex rev without a baseMarkdown to
    // the page's git history. A visitor gets no such lookup: past bodies of
    // a page are not part of what a link grants, and the handle the guard
    // passes has no history leaf to call.
    const { RevConflictError } = await import("@/lib/store");
    const historicalMarkdownForRev = vi.fn().mockResolvedValue("old body");
    const res = await put(
      { markdown: "hello", rev: "000000000000" },
      {
        writeSharedPage: vi
          .fn()
          .mockRejectedValue(new RevConflictError("ffffffffffff", "000000000000")),
        historicalMarkdownForRev,
      },
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "conflict",
      currentRev: "ffffffffffff",
    });
    expect(historicalMarkdownForRev).not.toHaveBeenCalled();
  });

  it("answers a fabricated attachment reference with 422", async () => {
    const { ShareAttachmentScopeError } = await import("@/lib/store");
    const res = await put(
      { markdown: "![](/_attachments-v2/x00000000001.png)" },
      {
        writeSharedPage: vi
          .fn()
          .mockRejectedValue(new ShareAttachmentScopeError("x00000000001.png")),
      },
    );
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: "attachment_not_yours" });
  });

  it("refuses a body over the cap without calling the Store, declared or not", async () => {
    const writeSharedPage = vi.fn();
    const body = { markdown: "x".repeat(MAX_SHARE_WRITE_BYTES + 1) };

    const declared = await put(body, { writeSharedPage });
    expect(declared.status).toBe(413);
    await expect(declared.json()).resolves.toEqual({ error: "too_large" });

    restoreShareEditModules();
    const undeclared = await put(body, { writeSharedPage }, { declareLength: false });
    expect(undeclared.status).toBe(413);
    await expect(undeclared.json()).resolves.toEqual({ error: "too_large" });

    expect(writeSharedPage).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON or carries no markdown string", async () => {
    const writeSharedPage = vi.fn();
    for (const body of ["not json", { rev: "000000000000" }, { markdown: 7 }]) {
      const res = await put(body, { writeSharedPage });
      expect(res.status, JSON.stringify(body)).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad request" });
      restoreShareEditModules();
    }
    expect(writeSharedPage).not.toHaveBeenCalled();
  });

  it("answers a busy store with 503", async () => {
    const res = await put({ markdown: "hello" }, async () => {
      const { ShareAccessBusyError } = await import("@/lib/share-access");
      return {
        writeSharedPage: vi.fn().mockRejectedValue(new ShareAccessBusyError()),
      };
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
  });

  it("404s a write the leaf refused inside the queue", async () => {
    const res = await put({ markdown: "hello" }, async () => {
      const { ShareAccessNotFoundError } = await import("@/lib/share-access");
      return {
        writeSharedPage: vi
          .fn()
          .mockRejectedValue(new ShareAccessNotFoundError()),
      };
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not found" });
  });

  it("exports no DELETE and no PATCH", async () => {
    const handlers = await import("./route");
    expect("DELETE" in handlers).toBe(false);
    expect("PATCH" in handlers).toBe(false);
    expect(typeof handlers.GET).toBe("function");
    expect(typeof handlers.PUT).toBe("function");
  });
});
