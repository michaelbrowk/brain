import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchNotes } = vi.hoisted(() => ({ searchNotes: vi.fn() }));

vi.mock("@/lib/search", () => ({ searchNotes }));

import { GET } from "./route";

describe("GET /api/search", () => {
  beforeEach(() => {
    searchNotes.mockReset();
  });

  it("returns hits from the full-text backend", async () => {
    const hits = [
      {
        id: "page-1",
        title: "Result",
        snippet: { before: "", match: "Result", after: "" },
      },
    ];
    searchNotes.mockResolvedValue(hits);

    const response = await GET(
      request("https://brain.example/api/search?q=result"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ hits });
  });

  it("reports backend failure instead of a false empty result", async () => {
    searchNotes.mockRejectedValue(new Error("ripgrep failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(
      request("https://brain.example/api/search?q=result"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "search_unavailable",
    });
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("rejects an oversized query before invoking ripgrep", async () => {
    const response = await GET(
      request(`https://brain.example/api/search?q=${"x".repeat(513)}`),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_query" });
    expect(searchNotes).not.toHaveBeenCalled();
  });
});

function request(url: string) {
  return {
    nextUrl: new URL(url),
  } as Parameters<typeof GET>[0];
}
