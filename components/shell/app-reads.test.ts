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
    // Strict: `toEqual` treats a key whose value is undefined as absent, so
    // it would pass against a meta this handed straight through.
    expect(answer.meta).toStrictEqual({ id: "b", title: "Words", icon: "📄", updated: "y" });
  });

  it("hands over an allowlisted meta, not whatever the route left in it", async () => {
    apiFetch.mockResolvedValue(
      json({
        meta: {
          id: "b",
          title: "Words",
          icon: "📄",
          kind: "app",
          created: "c",
          updated: "u",
          updatedBy: "me",
          tags: ["spanish"],
          status: "doing",
          category: "Language",
          view: "board",
          sections: ["A"],
          pinned: true,
          // Everything below is the notebook's own business. An app holds
          // every page id from read.tree, so a pass-through here would be
          // the whole notebook's share posture, one request at a time.
          order: "a1",
          cover: "/api/attachment/cover.png",
          public: true,
          shareLocked: true,
          shareExpiresAt: "2027-01-01",
          shareEdit: true,
          shareVersion: 3,
          sharedUnder: "root9",
          notionId: "n1",
          notionSourceHash: "h",
          collection: { version: 1 },
          collectionRow: { values: {} },
          app: { entry: "app/index.html", owns: ["c"] },
          deleted: "2026-01-01",
        },
        markdown: "x",
        rev: "r",
      }),
    );
    const answer = (await createAppReads(() => TREE as never)({
      ...envelope,
      type: "read.page",
      id: "b",
    })) as { meta: Record<string, unknown> };
    expect(answer.meta).toStrictEqual({
      id: "b",
      title: "Words",
      icon: "📄",
      kind: "app",
      created: "c",
      updated: "u",
      updatedBy: "me",
      tags: ["spanish"],
      status: "doing",
      category: "Language",
      view: "board",
      sections: ["A"],
      pinned: true,
    });
  });

  it("refuses a page that is not there in the MCP's own word", async () => {
    apiFetch.mockResolvedValue(json({ error: "not found" }, 404));
    // An id the live tree holds, so the 404 branch is what answers rather
    // than the tree guard in front of it.
    await expect(
      createAppReads(() => TREE as never)({ ...envelope, type: "read.page", id: "b" }),
    ).rejects.toMatchObject({ reason: "not_found" });
    expect(apiFetch).toHaveBeenCalledWith("/api/page/b");
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

  it("says the same sentence when a body is not the JSON it asked for", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    } as unknown as Response);
    await expect(
      createAppReads(() => TREE as never)({ ...envelope, type: "read.pages", query: "hola" }),
    ).rejects.toMatchObject({
      reason: "store_failed",
      message: "Brain could not answer that request",
    });
  });

  it("leaves a request that is not a read to the next layer", async () => {
    expect(
      await createAppReads(() => TREE as never)({ ...envelope, type: "state.get" }),
    ).toBeUndefined();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  const node = (id: string, children: unknown[] = []) => ({
    id,
    parentId: null,
    title: id,
    hasChildren: children.length > 0,
    children,
  });

  it("refuses a page the live tree does not hold, without fetching its body", async () => {
    const reads = createAppReads(() => [node("a")] as never);
    await expect(reads({ ...envelope, type: "read.page", id: "trashed" })).rejects.toMatchObject({
      reason: "not_found",
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("reads a page the live tree holds", async () => {
    apiFetch.mockResolvedValue(json({ meta: { id: "a", title: "Spanish" }, markdown: "x", rev: "r" }));
    const answer = (await createAppReads(() => [node("a")] as never)({
      ...envelope,
      type: "read.page",
      id: "a",
    })) as { rev: string };
    expect(apiFetch).toHaveBeenCalledWith("/api/page/a");
    expect(answer.rev).toBe("r");
  });

  it("follows the tree as it changes, in both directions", async () => {
    // The whole of M15 in one case. A set cached at the first read.tree would
    // answer both of these the way the notebook looked an hour ago.
    let tree = [node("a")];
    const reads = createAppReads(() => tree as never);
    await reads({ ...envelope, type: "read.tree" });

    // a page deleted after the app read the tree
    tree = [];
    await expect(reads({ ...envelope, type: "read.page", id: "a" })).rejects.toMatchObject({
      reason: "not_found",
    });

    // and a page created after it
    apiFetch.mockResolvedValue(json({ meta: { id: "b", title: "New" }, markdown: "x", rev: "r" }));
    tree = [node("b")];
    await expect(reads({ ...envelope, type: "read.page", id: "b" })).resolves.toBeTruthy();
  });

  it("finds a page at any depth of the tree", async () => {
    apiFetch.mockResolvedValue(json({ meta: { id: "c", title: "Deep" }, markdown: "x", rev: "r" }));
    const deep = () => [node("a", [node("b", [node("c")])])] as never;
    await expect(
      createAppReads(deep)({ ...envelope, type: "read.page", id: "c" }),
    ).resolves.toBeTruthy();
  });
});
