import { describe, expect, it, vi } from "vitest";
import { NotFoundError, RevConflictError, type Page } from "@/lib/store";
import { pageWriteConflictResponse, resolvePageWrite } from "./page-write";

const PAGE: Page = {
  meta: {
    id: "page-a",
    title: "A",
    order: "a0",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
  },
  markdown: "body",
  rev: "f6e5d4c3b2a1",
};
const STALE = "a1b2c3d4e5f6";
const CURRENT = "f6e5d4c3b2a1";

function history(base: string | null = "server base") {
  return { historicalMarkdownForRev: vi.fn().mockResolvedValue(base) };
}

const conflict = () => new RevConflictError(CURRENT, STALE);

describe("resolvePageWrite", () => {
  it("hands back the written page", async () => {
    const store = history();
    await expect(
      resolvePageWrite(store, { id: "page-a" }, async () => PAGE),
    ).resolves.toEqual({ status: "ok", page: PAGE });
    expect(store.historicalMarkdownForRev).not.toHaveBeenCalled();
  });

  it("resolves a legacy exact revision through the page's own history", async () => {
    const store = history();
    await expect(
      resolvePageWrite(store, { id: "page-a", rev: STALE }, () =>
        Promise.reject(conflict()),
      ),
    ).resolves.toEqual({
      status: "conflict",
      currentRev: CURRENT,
      baseMarkdown: "server base",
    });
    expect(store.historicalMarkdownForRev).toHaveBeenCalledWith("page-a", STALE);
  });

  it("stays a plain conflict when history has no such revision or fails", async () => {
    await expect(
      resolvePageWrite(history(null), { id: "page-a", rev: STALE }, () =>
        Promise.reject(conflict()),
      ),
    ).resolves.toEqual({ status: "conflict", currentRev: CURRENT });

    const failing = {
      historicalMarkdownForRev: vi.fn().mockRejectedValue(new Error("git")),
    };
    await expect(
      resolvePageWrite(failing, { id: "page-a", rev: STALE }, () =>
        Promise.reject(conflict()),
      ),
    ).resolves.toEqual({ status: "conflict", currentRev: CURRENT });
  });

  it("does not consult history when the client already supplied a base", async () => {
    const store = history();
    await expect(
      resolvePageWrite(
        store,
        { id: "page-a", rev: STALE, baseMarkdown: "known base" },
        () => Promise.reject(conflict()),
      ),
    ).resolves.toEqual({ status: "conflict", currentRev: CURRENT });
    expect(store.historicalMarkdownForRev).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["short", "a".repeat(11)],
    ["uppercase", "A".repeat(12)],
    ["non-hex", "g".repeat(12)],
    ["not a string", 12],
  ])("fails closed for a %s revision", async (_label, rev) => {
    const store = history();
    await expect(
      resolvePageWrite(store, { id: "page-a", rev }, () =>
        Promise.reject(conflict()),
      ),
    ).resolves.toEqual({ status: "conflict", currentRev: CURRENT });
    expect(store.historicalMarkdownForRev).not.toHaveBeenCalled();
  });

  it("names a missing page and rethrows anything else", async () => {
    await expect(
      resolvePageWrite(history(), { id: "page-a" }, () =>
        Promise.reject(new NotFoundError("page-a")),
      ),
    ).resolves.toEqual({ status: "not-found" });
    const io = new Error("disk");
    await expect(
      resolvePageWrite(history(), { id: "page-a" }, () => Promise.reject(io)),
    ).rejects.toBe(io);
  });
});

describe("pageWriteConflictResponse", () => {
  it("is a 409 with the base only when there is one", async () => {
    const bare = pageWriteConflictResponse({
      status: "conflict",
      currentRev: CURRENT,
    });
    expect(bare.status).toBe(409);
    await expect(bare.json()).resolves.toEqual({
      error: "conflict",
      currentRev: CURRENT,
    });

    const based = pageWriteConflictResponse({
      status: "conflict",
      currentRev: CURRENT,
      baseMarkdown: "server base",
    });
    await expect(based.json()).resolves.toEqual({
      error: "conflict",
      currentRev: CURRENT,
      baseMarkdown: "server base",
    });
  });
});
