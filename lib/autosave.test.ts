import { describe, expect, it, vi } from "vitest";
import {
  canResumeConflictedDraft,
  createKeyedQueue,
  decodeDraft,
  encodeDraft,
  encodeSaveRequest,
  isDraftOperation,
  latchDraftConflict,
  persistDraft,
  SaveRequestError,
  saveMarkdown,
} from "./autosave";

describe("canResumeConflictedDraft", () => {
  it("resumes a latched metadata-only conflict", () => {
    expect(
      canResumeConflictedDraft(
        { markdown: "local edit", baseMarkdown: "server body" },
        "server body\n",
      ),
    ).toBe(true);
  });

  it("resumes when the local body is already committed", () => {
    expect(
      canResumeConflictedDraft(
        { markdown: "already saved\n", baseMarkdown: null },
        "already saved",
      ),
    ).toBe(true);
  });

  it("keeps a real content conflict latched", () => {
    expect(
      canResumeConflictedDraft(
        { markdown: "local edit", baseMarkdown: "old body" },
        "new remote body",
      ),
    ).toBe(false);
  });
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("saveMarkdown", () => {
  it("uses the revision returned by one save for the next save", async () => {
    let revision = "rev-0";
    const bodies: Array<{
      markdown: string;
      rev: string;
      baseMarkdown?: string;
    }> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        markdown: string;
        rev: string;
        baseMarkdown?: string;
      };
      bodies.push(body);
      return response({ rev: `rev-${bodies.length}` });
    });

    const save = (markdown: string) =>
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown,
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
      });

    await save("first");
    await save("second");

    expect(bodies).toEqual([
      { markdown: "first", rev: "rev-0" },
      { markdown: "second", rev: "rev-1" },
    ]);
    expect(revision).toBe("rev-2");
  });

  it("retries a metadata-only conflict against the unchanged base body", async () => {
    let revision = "stale-meta-rev";
    let baseMarkdown = "server body";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({}, 409))
      .mockResolvedValueOnce(
        response({ markdown: "server body", rev: "fresh-meta-rev" }),
      )
      .mockResolvedValueOnce(response({ rev: "saved-rev" }));

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "local edit",
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
        getBaseMarkdown: () => baseMarkdown,
        setBaseMarkdown: (next) => {
          baseMarkdown = next;
        },
        wait: async () => {},
      }),
    ).resolves.toBe("saved-rev");

    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      markdown: "local edit",
      rev: "stale-meta-rev",
      baseMarkdown: "server body",
    });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      markdown: "local edit",
      rev: "fresh-meta-rev",
      baseMarkdown: "server body",
    });
    expect(baseMarkdown).toBe("local edit");
  });

  it("recovers a schema-v2 conflict from a trusted historical base", async () => {
    let revision = "stale-v2-rev";
    let baseMarkdown: string | undefined;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          error: "conflict",
          currentRev: "fresh-meta-rev",
          baseMarkdown: "server body",
        }, 409),
      )
      .mockResolvedValueOnce(
        response({ markdown: "server body", rev: "fresh-meta-rev" }),
      )
      .mockResolvedValueOnce(response({ rev: "saved-rev" }));

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "legacy local edit",
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
        getBaseMarkdown: () => baseMarkdown,
        setBaseMarkdown: (next) => {
          baseMarkdown = next;
        },
        wait: async () => {},
      }),
    ).resolves.toBe("saved-rev");

    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      markdown: "legacy local edit",
      rev: "stale-v2-rev",
    });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      markdown: "legacy local edit",
      rev: "fresh-meta-rev",
      baseMarkdown: "server body",
    });
    expect(baseMarkdown).toBe("legacy local edit");
  });

  it("keeps a schema-v2 draft when the current body diverged from history", async () => {
    let revision = "stale-v2-rev";
    let baseMarkdown: string | undefined;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ baseMarkdown: "historical body" }, 409),
      )
      .mockResolvedValueOnce(
        response({ markdown: "remote body", rev: "remote-rev" }),
      );

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "legacy local edit",
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
        getBaseMarkdown: () => baseMarkdown,
        setBaseMarkdown: (next) => {
          baseMarkdown = next;
        },
        wait: async () => {},
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(revision).toBe("stale-v2-rev");
    expect(baseMarkdown).toBeUndefined();
  });

  it("does not retry when the server body diverged from the known base", async () => {
    let revision = "stale";
    let baseMarkdown = "original body";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ baseMarkdown: "remote edit" }, 409),
      )
      .mockResolvedValueOnce(
        response({ markdown: "remote edit", rev: "remote-rev" }),
      );

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "local edit",
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
        getBaseMarkdown: () => baseMarkdown,
        setBaseMarkdown: (next) => {
          baseMarkdown = next;
        },
        wait: async () => {},
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(revision).toBe("stale");
    expect(baseMarkdown).toBe("original body");
  });

  it("does not trust a baseline changed while refreshing a conflict", async () => {
    let revision = "stale";
    let baseMarkdown = "original body";
    const writes: Array<{
      markdown: string;
      rev: string;
      baseMarkdown?: string;
    }> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes.push(
          JSON.parse(String(init.body)) as {
            markdown: string;
            rev: string;
            baseMarkdown?: string;
          },
        );
        return response({}, 409);
      }

      // Simulate an SSE/reload callback landing while the conflict refresh is
      // in flight. This newer body was not the baseline of the rejected PUT.
      baseMarkdown = "remote body";
      return response({ markdown: "remote body", rev: "remote-rev" });
    });

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "stale local edit",
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
        getBaseMarkdown: () => baseMarkdown,
        setBaseMarkdown: (next) => {
          baseMarkdown = next;
        },
        wait: async () => {},
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(writes).toEqual([
      {
        markdown: "stale local edit",
        rev: "stale",
        baseMarkdown: "original body",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(revision).toBe("stale");
    expect(baseMarkdown).toBe("remote body");
  });

  it("does not clobber a newer live baseline when conflict refresh returns the old body", async () => {
    let revision = "stale";
    let baseMarkdown = "original body";
    const writes: Array<{
      markdown: string;
      rev: string;
      baseMarkdown?: string;
    }> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes.push(
          JSON.parse(String(init.body)) as {
            markdown: string;
            rev: string;
            baseMarkdown?: string;
          },
        );
        return response({}, 409);
      }

      baseMarkdown = "newer live body";
      return response({ markdown: "original body", rev: "refresh-rev" });
    });

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "stale local edit",
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
        getBaseMarkdown: () => baseMarkdown,
        setBaseMarkdown: (next) => {
          baseMarkdown = next;
        },
        wait: async () => {},
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(writes).toEqual([
      {
        markdown: "stale local edit",
        rev: "stale",
        baseMarkdown: "original body",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(revision).toBe("stale");
    expect(baseMarkdown).toBe("newer live body");
  });

  it("preserves the server body and rejects a real 409 conflict", async () => {
    let revision = "stale";
    const writes: Array<{ markdown: string; rev: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)) as { markdown: string; rev: string });
        return response({}, 409);
      }
      expect(String(input)).toBe("/api/page/page-a");
      return response({ markdown: "MCP body", rev: "server-rev" });
    });

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "local body",
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
        wait: async () => {},
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(writes).toEqual([{ markdown: "local body", rev: "stale" }]);
    expect(revision).toBe("stale");
  });

  it("requires an explicit PUT after a same-body 409 refresh", async () => {
    let revision = "stale";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({}, 409))
      .mockResolvedValueOnce(
        response({ markdown: "already saved", rev: "confirmed-rev" }),
      )
      .mockResolvedValueOnce(response({ rev: "explicit-rev" }));

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "already saved\n",
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
        wait: async () => {},
      }),
    ).resolves.toBe("explicit-rev");
    expect(revision).toBe("explicit-rev");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      markdown: "already saved\n",
      rev: "confirmed-rev",
    });
  });

  it("uses the same trailing-whitespace canonicalization as the Store", async () => {
    let revision = "stale";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({}, 409))
      .mockResolvedValueOnce(
        response({ markdown: "already saved", rev: "confirmed-rev" }),
      )
      .mockResolvedValueOnce(response({ rev: "explicit-rev" }));

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "already saved   \n",
        getRevision: () => revision,
        setRevision: (next) => {
          revision = next;
        },
        wait: async () => {},
      }),
    ).resolves.toBe("explicit-rev");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("surfaces a retryable network failure after bounded attempts", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      saveMarkdown({
        fetcher,
        id: "page-a",
        markdown: "kept in local draft",
        getRevision: () => "rev-0",
        setRevision: () => {},
        wait: async () => {},
      }),
    ).rejects.toBeInstanceOf(SaveRequestError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("encodeSaveRequest", () => {
  it("keeps the baseline for a normal request", () => {
    expect(JSON.parse(encodeSaveRequest("local", "rev-a", "base"))).toEqual({
      markdown: "local",
      rev: "rev-a",
      baseMarkdown: "base",
    });
  });

  it("drops only the optional baseline above the keepalive budget", () => {
    const markdown = "x".repeat(32 * 1024);
    expect(
      JSON.parse(encodeSaveRequest(markdown, "rev-a", markdown, 60 * 1024)),
    ).toEqual({ markdown, rev: "rev-a" });
  });
});

describe("draft encoding", () => {
  it("keeps markdown and its base revision together", () => {
    expect(
      decodeDraft(encodeDraft("local body", "rev-a", "tab-a:1")),
    ).toEqual({
      markdown: "local body",
      revision: "rev-a",
      operationId: "tab-a:1",
      updatedAt: expect.any(Number),
      baseMarkdown: null,
      conflicted: false,
      sources: [],
    });
  });

  it("loads a legacy raw markdown draft without inventing a revision", () => {
    expect(decodeDraft("legacy markdown")).toEqual({
      markdown: "legacy markdown",
      revision: null,
      operationId: null,
      updatedAt: null,
      baseMarkdown: null,
      conflicted: false,
      sources: [],
    });
  });

  it("loads a schema-v2 draft without inventing a server base", () => {
    expect(
      decodeDraft(
        JSON.stringify({
          version: 2,
          markdown: "local body",
          revision: "stale-rev",
          operationId: "tab-a:1",
          updatedAt: 123,
        }),
      ),
    ).toEqual({
      markdown: "local body",
      revision: "stale-rev",
      operationId: "tab-a:1",
      updatedAt: 123,
      baseMarkdown: null,
      conflicted: false,
      sources: [],
    });
  });

  it("keeps the server base with a schema-v3 draft", () => {
    expect(
      decodeDraft(
        encodeDraft("local body", "rev-a", "tab-a:1", 123, "server body"),
      ),
    ).toEqual({
      markdown: "local body",
      revision: "rev-a",
      operationId: "tab-a:1",
      updatedAt: 123,
      baseMarkdown: "server body",
      conflicted: false,
      sources: [],
    });
  });

  it("keeps a genuine conflict latched with the exact markdown body", () => {
    const markdown =
      "Local paragraph\n\n![](/api/media/conflict-image.png)\n\n";

    expect(
      decodeDraft(
        encodeDraft(
          markdown,
          "stale-rev",
          "tab-a:conflict",
          123,
          "server body",
          true,
        ),
      ),
    ).toEqual({
      markdown,
      revision: "stale-rev",
      operationId: "tab-a:conflict",
      updatedAt: 123,
      baseMarkdown: "server body",
      conflicted: true,
      sources: [],
    });
  });

  it("a late conflict preserves a newer operation byte for byte", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const newerMarkdown =
      "Newer B body\n\n![](/api/media/newer-image.png)\n\n<br />";
    storage.setItem(
      "page-x",
      encodeDraft(
        newerMarkdown,
        "rev-b",
        "tab-x:operation-b",
        456,
        "base-b",
      ),
    );

    const result = latchDraftConflict(storage, "page-x", {
      markdown: "Older A body",
      revision: "rev-a",
      operationId: "tab-x:operation-a",
      updatedAt: 123,
      baseMarkdown: "base-a",
    });

    expect(result.persisted).toBe(true);
    expect(result.draft).toEqual({
      markdown: newerMarkdown,
      revision: "rev-b",
      operationId: "tab-x:operation-b",
      updatedAt: 456,
      baseMarkdown: "base-b",
      conflicted: true,
      sources: [],
    });
    expect(decodeDraft(storage.getItem("page-x")!)).toEqual(result.draft);
  });

  it("keeps adopted draft sources when the same operation is conflict-latched", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    storage.setItem(
      "page-x",
      encodeDraft(
        "Local body",
        "stale-rev",
        "tab-x:operation-a",
        123,
        "base body",
        false,
        [{ key: "brain-draft-v2:page-x:old-tab", operationId: "old-tab:1" }],
      ),
    );

    const result = latchDraftConflict(storage, "page-x", {
      markdown: "Local body",
      revision: "stale-rev",
      operationId: "tab-x:operation-a",
      updatedAt: 456,
      baseMarkdown: "base body",
      sources: [
        { key: "brain-draft-v2:page-x:new-tab", operationId: "new-tab:1" },
      ],
    });

    expect(result.persisted).toBe(true);
    expect(result.draft.sources).toEqual([
      { key: "brain-draft-v2:page-x:old-tab", operationId: "old-tab:1" },
      { key: "brain-draft-v2:page-x:new-tab", operationId: "new-tab:1" },
    ]);
    expect(decodeDraft(storage.getItem("page-x")!).sources).toEqual(
      result.draft.sources,
    );
  });

  it("reports when a conflict draft could not be stored but returns its memory copy", () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new DOMException("quota", "QuotaExceededError");
      }),
    };

    const result = latchDraftConflict(storage, "page-x", {
      markdown: "Exact in-memory draft",
      revision: "stale-rev",
      operationId: "tab-x:memory-only",
      updatedAt: 123,
      baseMarkdown: "server base",
    });

    expect(result.persisted).toBe(false);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(result.draft).toEqual({
      markdown: "Exact in-memory draft",
      revision: "stale-rev",
      operationId: "tab-x:memory-only",
      updatedAt: 123,
      baseMarkdown: "server base",
      conflicted: true,
      sources: [],
    });
  });

  it("retains every adopted source across many reloads", () => {
    const sources = Array.from({ length: 12 }, (_, index) => ({
      key: `brain-draft-v2:page-x:tab-${index}`,
      operationId: `tab-${index}:operation`,
    }));

    expect(
      decodeDraft(
        encodeDraft(
          "Local body",
          "stale-rev",
          "tab-x:operation",
          123,
          "base body",
          true,
          sources,
        ),
      ).sources,
    ).toEqual(sources);
  });

  it("falls back to a body-only draft when the full baseline exceeds quota", () => {
    const writes: string[] = [];
    const storage = {
      setItem: vi.fn((_key: string, value: string) => {
        writes.push(value);
        if (writes.length === 1) throw new DOMException("quota", "QuotaExceededError");
      }),
    };

    expect(
      persistDraft(
        storage,
        "draft-key",
        "local body",
        "rev-a",
        "tab-a:1",
        123,
        "large server body",
        true,
      ),
    ).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(decodeDraft(writes[1])).toMatchObject({
      markdown: "local body",
      revision: "rev-a",
      operationId: "tab-a:1",
      baseMarkdown: null,
      conflicted: true,
    });
  });

  it("distinguishes identical A-B-A bodies by edit operation", () => {
    const newest = encodeDraft("same body", "rev-b", "tab-a:3");

    expect(isDraftOperation(newest, "tab-a:1")).toBe(false);
    expect(isDraftOperation(newest, "tab-a:3")).toBe(true);
  });
});

describe("createKeyedQueue", () => {
  it("serializes saves for one page without blocking a different page", async () => {
    const queue = createKeyedQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = queue.run("page-a", async () => {
      order.push("a:first:start");
      await gate;
      order.push("a:first:end");
    });
    const second = queue.run("page-a", async () => {
      order.push("a:second");
    });
    const otherPage = queue.run("page-b", async () => {
      order.push("b:first");
    });

    await otherPage;
    expect(order).toEqual(["a:first:start", "b:first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a:first:start", "b:first", "a:first:end", "a:second"]);
  });

  it("stops calling a key busy once its work has finished", async () => {
    const queue = createKeyedQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = queue.run("page-a", () => gate);
    expect(queue.has("page-a")).toBe(true);

    release();
    await running;
    // Awaiting the task alone is not enough — the queue still holds its tail
    // for a turn, which is what made a just-saved page read as busy.
    await queue.settled("page-a");
    expect(queue.has("page-a")).toBe(false);
  });

  it("survives a failed task and an idle key", async () => {
    const queue = createKeyedQueue();
    const failing = queue.run("page-a", async () => {
      throw new Error("save failed");
    });
    await expect(failing).rejects.toThrow("save failed");
    await expect(queue.settled("page-a")).resolves.toBeUndefined();
    await expect(queue.settled("never-used")).resolves.toBeUndefined();
    expect(queue.has("page-a")).toBe(false);
  });
});
