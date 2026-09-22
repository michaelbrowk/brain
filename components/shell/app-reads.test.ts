// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/client", () => ({ apiFetch, CLIENT_ID: "test-client" }));

const { createAppReads } = await import("./app-reads");

function json(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

const envelope = { v: 1 as const, rid: "r1" };

beforeEach(() => vi.clearAllMocks());

describe("the app's read side", () => {
  const TREE = [
    {
      id: "a",
      parentId: null,
      title: "Spanish",
      icon: "🇪🇸",
      order: "a0",
      created: "x",
      updated: "y",
      shareLocked: true,
      shareExpiresAt: "2027-01-01",
      notionId: "secret",
      collection: { version: 1 },
      hasChildren: true,
      children: [
        {
          id: "b",
          parentId: "a",
          title: "Trainer",
          kind: "app",
          order: "a1",
          created: "x",
          updated: "y",
          hasChildren: false,
          children: [],
        },
      ],
    },
  ];

  it("answers read.tree with ids, titles, icons, kinds and parents only", async () => {
    const answer = (await createAppReads(() => TREE as never)({
      ...envelope,
      type: "read.tree",
    })) as { tree: unknown[] };

    // The shell already holds this answer, so nothing is fetched for it.
    expect(apiFetch).not.toHaveBeenCalled();
    expect(answer.tree).toEqual([
      { id: "a", parentId: null, title: "Spanish", icon: "🇪🇸" },
      { id: "b", parentId: "a", title: "Trainer", kind: "app" },
    ]);
  });

  it("answers read.page with the meta, the markdown and the rev", async () => {
    apiFetch.mockResolvedValue(
      json({
        meta: { id: "b", title: "Words", icon: "📄", kind: undefined, updated: "y" },
        markdown: "| word |",
        rev: "abc",
      }),
    );
    const answer = (await createAppReads(() => TREE as never)({
      ...envelope,
      type: "read.page",
      id: "b",
    })) as {
      meta: Record<string, unknown>;
      markdown: string;
      rev: string;
    };
    expect(apiFetch).toHaveBeenCalledWith("/api/page/b");
    expect(answer.markdown).toBe("| word |");
    expect(answer.rev).toBe("abc");
    expect(answer.meta).toEqual({ id: "b", title: "Words", icon: "📄", updated: "y" });
  });

  it("refuses a page that is not there in the MCP's own word", async () => {
    apiFetch.mockResolvedValue(json({ error: "not found" }, 404));
    await expect(
      createAppReads(() => TREE as never)({ ...envelope, type: "read.page", id: "gone" }),
    ).rejects.toMatchObject({ reason: "not_found" });
  });

  it("answers read.pages with the hits the search route gave", async () => {
    apiFetch.mockResolvedValue(json({ hits: [{ id: "b", title: "Words", snippet: {} }] }));
    const answer = (await createAppReads(() => TREE as never)({
      ...envelope,
      type: "read.pages",
      query: "hola",
    })) as { hits: unknown[] };
    expect(apiFetch).toHaveBeenCalledWith("/api/search?q=hola");
    expect(answer.hits).toHaveLength(1);
  });

  it("calls the notes folder failing what the MCP calls it", async () => {
    apiFetch.mockResolvedValue(json({ error: "boom" }, 500));
    await expect(
      createAppReads(() => TREE as never)({ ...envelope, type: "read.pages", query: "hola" }),
    ).rejects.toMatchObject({
      reason: "store_failed",
    });
  });

  it("leaves a request that is not a read to the next layer", async () => {
    expect(
      await createAppReads(() => TREE as never)({ ...envelope, type: "state.get" }),
    ).toBeUndefined();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
