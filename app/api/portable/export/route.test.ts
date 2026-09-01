import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  buildPortableArchive: vi.fn(),
  portableFileName: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));
vi.mock("@/lib/portable/model", () => ({
  buildPortableArchive: mocks.buildPortableArchive,
  portableFileName: mocks.portableFileName,
}));

import { GET } from "./route";

describe("portable export route", () => {
  beforeEach(() => {
    mocks.getStore.mockReset().mockResolvedValue({ id: "store" });
    mocks.buildPortableArchive.mockReset().mockResolvedValue({
      bytes: new Uint8Array([31, 139, 8, 0]),
      manifest: { title: "Project Notes" },
    });
    mocks.portableFileName
      .mockReset()
      .mockReturnValue("project-notes.brain.tar.gz");
  });

  it("exports a selected subtree as a private gzip download", async () => {
    const response = await GET(
      new NextRequest(
        "https://brain.test/api/portable/export?id=selected-page",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="project-notes.brain.tar.gz"',
    );
    expect(mocks.buildPortableArchive).toHaveBeenCalledWith(
      { id: "store" },
      { rootId: "selected-page" },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([31, 139, 8, 0]),
    );
  });

  it("returns not found without exposing internals", async () => {
    mocks.buildPortableArchive.mockRejectedValue(
      new Error("portable export root was not found"),
    );

    const response = await GET(
      new NextRequest(
        "https://brain.test/api/portable/export?id=missing-page",
      ),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "page not found" });
  });
});
