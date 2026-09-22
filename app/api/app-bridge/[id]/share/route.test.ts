import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveShareAccess = vi.fn();
const isWithinSubtree = vi.fn();
const isDeleted = vi.fn();
const getTree = vi.fn();
const readPage = vi.fn();

vi.mock("@/lib/store", () => ({
  getStore: async () => ({ isWithinSubtree, isDeleted, getTree, readPage }),
  isNotFound: (e: unknown) => e instanceof Error && e.name === "NotFoundError",
}));
vi.mock("@/lib/share-access", () => ({
  resolveShareAccess,
  ShareAccessBusyError: class extends Error {},
  ShareAccessNotFoundError: class extends Error {},
}));

// Imported after the mocks, the way every other route suite here does it: a
// static import would evaluate the route before the doubles above exist.
const route = await import("./route");

const params = Promise.resolve({ id: "app1" });

function get(query: string) {
  return new NextRequest(new URL(`/api/app-bridge/app1/share${query}`, "https://brain.example"));
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveShareAccess.mockResolvedValue({ kind: "granted", shareVersion: 2 });
  isWithinSubtree.mockReturnValue(true);
  isDeleted.mockReturnValue(false);
  getTree.mockReturnValue([
    {
      id: "root1", parentId: null, title: "Spanish", hasChildren: true,
      children: [{ id: "app1", parentId: "root1", title: "Trainer", kind: "app", hasChildren: false, children: [] }],
    },
    { id: "outside", parentId: null, title: "Private", hasChildren: false, children: [] },
  ]);
  readPage.mockResolvedValue({ meta: { id: "app1", title: "Trainer" }, markdown: "d", rev: "r" });
});

describe("a visitor's read side", () => {
  it("answers the shared subtree only", async () => {
    isWithinSubtree.mockImplementation((_root: string, target: string) => target !== "outside");
    const res = await route.GET(get("?root=root1&v=2"), { params });
    const body = (await res.json()) as { tree: { id: string }[] };
    expect(body.tree.map((node) => node.id)).toEqual(["root1", "app1"]);
  });

  it("answers a page inside the subtree", async () => {
    const res = await route.GET(get("?root=root1&v=2&page=app1"), { params });
    expect(await res.json()).toMatchObject({ rev: "r" });
  });

  it("refuses a page outside it, and reads nothing on the way", async () => {
    isWithinSubtree.mockImplementation((_root: string, target: string) => target !== "outside");
    const res = await route.GET(get("?root=root1&v=2&page=outside"), { params });
    expect(res.status).toBe(404);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("refuses a page the owner has since deleted", async () => {
    isDeleted.mockImplementation((target: string) => target === "app1");
    const res = await route.GET(get("?root=root1&v=2&page=app1"), { params });
    expect(res.status).toBe(404);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("refuses a grant that does not reach the app", async () => {
    const { ShareAccessNotFoundError } = await import("@/lib/share-access");
    resolveShareAccess.mockRejectedValue(new ShareAccessNotFoundError());
    expect((await route.GET(get("?root=root1&v=2"), { params })).status).toBe(404);
  });

  it("refuses a visitor naming no root or no version, before it asks anything", async () => {
    expect((await route.GET(get("?v=2"), { params })).status).toBe(404);
    expect((await route.GET(get("?root=root1"), { params })).status).toBe(404);
    expect(resolveShareAccess).not.toHaveBeenCalled();
  });

  it("refuses a password gate rather than answering past it", async () => {
    resolveShareAccess.mockResolvedValue({ kind: "password-required", shareVersion: 2 });
    expect((await route.GET(get("?root=root1&v=2"), { params })).status).toBe(404);
  });

  it("comes back in a second when the notes folder is mid-write", async () => {
    const { ShareAccessBusyError } = await import("@/lib/share-access");
    resolveShareAccess.mockRejectedValue(new ShareAccessBusyError());
    const res = await route.GET(get("?root=root1&v=2"), { params });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
  });

  it("refuses a stale share version", async () => {
    await route.GET(get("?root=root1&v=1"), { params });
    expect(resolveShareAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestedVersion: "1" }),
    );
  });

  it("hands over the page's title and body and nothing else about it", async () => {
    readPage.mockResolvedValue({
      meta: {
        id: "app1",
        title: "Trainer",
        icon: "🇪🇸",
        kind: "app",
        shareLocked: true,
        notionId: "n1",
        collection: { view: "table" },
        updatedBy: "claude",
      },
      markdown: "d",
      rev: "r",
    });
    const res = await route.GET(get("?root=root1&v=2&page=app1"), { params });
    expect(await res.json()).toStrictEqual({
      meta: { id: "app1", title: "Trainer", icon: "🇪🇸", kind: "app" },
      markdown: "d",
      rev: "r",
    });
  });

  it("has no write verb at all, which is the guarantee", () => {
    expect(route).not.toHaveProperty("PUT");
    expect(route).not.toHaveProperty("POST");
    expect(route).not.toHaveProperty("PATCH");
    expect(route).not.toHaveProperty("DELETE");
  });
});
