import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  movePageWithBodyReport: vi.fn(),
  redactPageMeta: vi.fn((value: unknown) => value),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isNotFound: (error: unknown) =>
    error instanceof Error && error.name === "NotFoundError",
  redactPageMeta: mocks.redactPageMeta,
}));

import { POST } from "./route";

function request(value: unknown): NextRequest {
  return new NextRequest("https://brain.test/api/move", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-brain-client": "route-test",
    },
    body: JSON.stringify(value),
  });
}

describe("move POST", () => {
  beforeEach(() => {
    mocks.movePageWithBodyReport.mockReset().mockResolvedValue({
      meta: { id: "page", title: "Page" },
      unlinkedFrom: null,
    });
    mocks.getStore.mockReset().mockResolvedValue({
      movePageWithBodyReport: mocks.movePageWithBodyReport,
    });
    mocks.redactPageMeta.mockClear();
  });

  it("moves through one Store operation", async () => {
    const response = await POST(
      request({ id: "page", newParentId: "parent", beforeId: "sibling" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.movePageWithBodyReport).toHaveBeenCalledWith(
      "page",
      "parent",
      "sibling",
      "route-test",
    );
    expect(mocks.redactPageMeta).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      id: "page",
      unlinkedFrom: null,
    });
  });

  it("reports the page the move stopped being listed in", async () => {
    mocks.movePageWithBodyReport.mockResolvedValueOnce({
      meta: { id: "page", title: "Page" },
      unlinkedFrom: "old-parent",
    });
    const response = await POST(request({ id: "page", newParentId: "parent" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      unlinkedFrom: "old-parent",
    });
  });

  it("defaults omitted optional targets to top-level append", async () => {
    const response = await POST(request({ id: "page" }));

    expect(response.status).toBe(200);
    expect(mocks.movePageWithBodyReport).toHaveBeenCalledWith(
      "page",
      null,
      null,
      "route-test",
    );
  });

  it.each([
    ["missing id", {}],
    ["malformed id", { id: "bad.id" }],
    ["malformed parent", { id: "page", newParentId: "bad.id" }],
    ["malformed sibling", { id: "page", beforeId: "bad.id" }],
    ["wrong parent type", { id: "page", newParentId: 42 }],
  ])("rejects %s before opening the Store", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid request" });
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("maps missing pages to 404 and hides operational details", async () => {
    mocks.movePageWithBodyReport.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { name: "NotFoundError" }),
    );
    const missing = await POST(request({ id: "page" }));
    expect(missing.status).toBe(404);

    mocks.movePageWithBodyReport.mockRejectedValueOnce(
      new Error("sensitive path /srv/brain/data"),
    );
    const failed = await POST(request({ id: "page" }));
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: "move failed" });
  });
});
