import { describe, expect, it } from "vitest";
import {
  clearStickerDraft,
  confirmStickerDraft,
  decodeStickerDraft,
  loadStickerDraft,
  persistStickerDraft,
  saveStickerDraft,
  stickerDraftKey,
  type StickerDraft,
} from "./sticker-draft";

const draft = (operationId = "op-1"): StickerDraft => ({
  version: 1,
  pageId: "page-1",
  operationId,
  updatedAt: 42,
  expected: [],
  stickers: [{ id: "sticker-1", x: 12, y: 24, text: "Keep me" }],
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
};

describe("sticker drafts", () => {
  it("round-trips a valid draft", () => {
    const storage = memoryStorage();
    expect(persistStickerDraft(storage, draft())).toBe(true);
    expect(loadStickerDraft(storage, "page-1")).toEqual(draft());
  });

  it("rejects malformed and cross-page drafts", () => {
    expect(decodeStickerDraft("{")).toBeNull();
    expect(
      decodeStickerDraft(
        JSON.stringify({ ...draft(), stickers: [{ id: "bad", x: "12" }] }),
      ),
    ).toBeNull();

    const storage = memoryStorage();
    storage.setItem(stickerDraftKey("page-2"), JSON.stringify(draft()));
    expect(loadStickerDraft(storage, "page-2")).toBeNull();
  });

  it("clears only the confirmed operation", () => {
    const storage = memoryStorage();
    persistStickerDraft(storage, draft("newer"));

    expect(clearStickerDraft(storage, "page-1", "older")).toBe(false);
    expect(loadStickerDraft(storage, "page-1")?.operationId).toBe("newer");
    expect(clearStickerDraft(storage, "page-1", "newer")).toBe(true);
    expect(loadStickerDraft(storage, "page-1")).toBeNull();
  });

  it.each([
    {
      label: "newer content",
      newer: [{ id: "sticker-1", x: 30, y: 40, text: "C" }],
    },
    {
      label: "A-B-A content",
      newer: [] as StickerDraft["stickers"],
    },
  ])(
    "advances the newer draft baseline after an overlapping ACK: $label",
    async ({ newer }) => {
      const storage = memoryStorage();
      const older = draft("older");
      persistStickerDraft(storage, older);
      let resolveOlder!: (response: Response) => void;
      const olderResponse = new Promise<Response>((resolve) => {
        resolveOlder = resolve;
      });
      const savingOlder = saveStickerDraft(
        storage,
        "page-1",
        () => olderResponse,
      );

      persistStickerDraft(storage, {
        ...draft("newer"),
        stickers: newer,
      });
      resolveOlder(new Response(null, { status: 200 }));
      await expect(savingOlder).resolves.toBe("saved");
      expect(loadStickerDraft(storage, "page-1")).toMatchObject({
        operationId: "newer",
        expected: older.stickers,
        stickers: newer,
      });

      let newerBody: unknown;
      await expect(
        saveStickerDraft(storage, "page-1", async (_input, init) => {
          newerBody = JSON.parse(String(init?.body));
          return new Response(null, { status: 200 });
        }),
      ).resolves.toBe("saved");
      expect(newerBody).toEqual({
        stickers: newer,
        expected: { stickers: older.stickers },
      });
      expect(loadStickerDraft(storage, "page-1")).toBeNull();
    },
  );

  it("fails closed if an overlapping ACK cannot advance the newer baseline", () => {
    const current = draft("newer");
    const storage = {
      getItem: () => JSON.stringify(current),
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };

    expect(confirmStickerDraft(storage, draft("older"))).toBe(false);
  });

  it("recovers a failed baseline handoff only after proving the ACK on the server", async () => {
    const values = new Map<string, string>();
    let blockSet = false;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blockSet) throw new Error("quota");
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    };
    const older = draft("older");
    persistStickerDraft(storage, older);
    let resolveOlder!: (response: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    const calls: Array<{ method: string; body?: unknown }> = [];
    const savingOlder = saveStickerDraft(storage, "page-1", (_input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        ...(init?.body
          ? { body: JSON.parse(String(init.body)) as unknown }
          : {}),
      });
      return olderResponse;
    });

    persistStickerDraft(storage, {
      ...draft("newer"),
      stickers: [{ id: "sticker-1", x: 50, y: 60, text: "C" }],
    });
    blockSet = true;
    resolveOlder(new Response(null, { status: 200 }));

    let recoveryStep = 0;
    const result = await savingOlder.then(async (initialResult) => {
      if (initialResult !== "retry") return initialResult;
      return saveStickerDraft(storage, "page-1", async (_input, init) => {
        recoveryStep += 1;
        if (!init) {
          return new Response(
            JSON.stringify({ meta: { stickers: older.stickers } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        calls.push({
          method: init.method ?? "PATCH",
          body: JSON.parse(String(init.body)) as unknown,
        });
        return new Response(null, { status: 200 });
      });
    });

    expect(result).toBe("saved");
    expect(recoveryStep).toBe(2);
    expect(calls.at(-1)).toEqual({
      method: "PATCH",
      body: {
        stickers: [{ id: "sticker-1", x: 50, y: 60, text: "C" }],
        expected: { stickers: older.stickers },
      },
    });
    expect(loadStickerDraft(storage, "page-1")).toBeNull();
  });

  it("does not rebase a failed handoff over an unrelated server value", async () => {
    const storage = memoryStorage();
    const older = draft("older-conflict");
    persistStickerDraft(storage, older);
    const savingOlder = saveStickerDraft(
      storage,
      "page-1",
      async () => new Response(null, { status: 200 }),
    );
    persistStickerDraft(storage, draft("newer-conflict"));
    const originalSet = storage.setItem;
    storage.setItem = () => {
      throw new Error("quota");
    };
    await expect(savingOlder).resolves.toBe("retry");
    storage.setItem = originalSet;

    await expect(
      saveStickerDraft(storage, "page-1", async (_input, init) => {
        expect(init).toBeUndefined();
        return new Response(
          JSON.stringify({
            meta: {
              stickers: [{ id: "external", x: 1, y: 2, text: "External" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    ).resolves.toBe("conflict");
    expect(loadStickerDraft(storage, "page-1")).not.toBeNull();
  });

  it("fails closed when storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(persistStickerDraft(storage, draft())).toBe(false);
    expect(loadStickerDraft(storage, "page-1")).toBeNull();
    expect(clearStickerDraft(storage, "page-1", "op-1")).toBe(false);
  });

  it("keeps the draft after a network failure", async () => {
    const storage = memoryStorage();
    persistStickerDraft(storage, draft());

    expect(
      await saveStickerDraft(storage, "page-1", async () => {
        throw new Error("offline");
      }),
    ).toBe("retry");
    expect(loadStickerDraft(storage, "page-1")).toEqual(draft());
  });

  it("sends the original sticker value as a field precondition", async () => {
    const storage = memoryStorage();
    persistStickerDraft(storage, draft());
    let body: unknown;

    await expect(
      saveStickerDraft(storage, "page-1", async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(null, { status: 200 });
      }),
    ).resolves.toBe("saved");

    expect(body).toEqual({
      stickers: draft().stickers,
      expected: { stickers: [] },
    });
  });

  it("does not clear a newer operation when an older response arrives", async () => {
    const storage = memoryStorage();
    persistStickerDraft(storage, draft("older"));
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>((done) => {
      resolve = done;
    });
    const saving = saveStickerDraft(storage, "page-1", () => response);

    persistStickerDraft(storage, draft("newer"));
    resolve(new Response(null, { status: 200 }));

    await expect(saving).resolves.toBe("saved");
    expect(loadStickerDraft(storage, "page-1")?.operationId).toBe("newer");
  });

  it("settles a draft that ends where it started without a request", async () => {
    const storage = memoryStorage();
    const unchanged = { ...draft(), expected: draft().stickers };
    persistStickerDraft(storage, unchanged);
    let calls = 0;

    await expect(
      saveStickerDraft(storage, "page-1", async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      }),
    ).resolves.toBe("idle");

    expect(calls).toBe(0);
    expect(loadStickerDraft(storage, "page-1")).toBeNull();
  });

  it("settles a lost-ACK draft the server already holds instead of conflicting", async () => {
    const storage = memoryStorage();
    persistStickerDraft(storage, draft());
    const calls: string[] = [];
    const fetcher =
      (serverStickers: StickerDraft["stickers"]) =>
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init?.method ?? "GET");
        if (init?.method === "PATCH")
          return new Response(null, { status: 409 });
        return new Response(
          JSON.stringify({ meta: { stickers: serverStickers } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

    await expect(
      saveStickerDraft(
        storage,
        "page-1",
        fetcher([{ id: "external", x: 1, y: 2, text: "External" }]),
      ),
    ).resolves.toBe("conflict");
    expect(calls).toEqual(["PATCH", "GET"]);
    expect(loadStickerDraft(storage, "page-1")).toEqual(draft());

    await expect(
      saveStickerDraft(storage, "page-1", fetcher(draft().stickers)),
    ).resolves.toBe("idle");
    expect(loadStickerDraft(storage, "page-1")).toBeNull();
  });

  it("clears the exact confirmed operation", async () => {
    const storage = memoryStorage();
    persistStickerDraft(storage, draft());

    await expect(
      saveStickerDraft(
        storage,
        "page-1",
        async () => new Response(null, { status: 200 }),
      ),
    ).resolves.toBe("saved");
    expect(loadStickerDraft(storage, "page-1")).toBeNull();
  });
});
