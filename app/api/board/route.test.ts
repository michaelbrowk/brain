import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  mutateBoard: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isNotFound: (error: unknown) =>
    error instanceof Error && error.name === "NotFoundError",
}));

import { POST } from "./route";

function request(value: unknown): NextRequest {
  return new NextRequest("https://brain.test/api/board", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-brain-client": "route-test",
    },
    body: JSON.stringify(value),
  });
}

describe("board POST", () => {
  beforeEach(() => {
    mocks.mutateBoard.mockReset().mockResolvedValue(undefined);
    mocks.getStore.mockReset().mockResolvedValue({
      mutateBoard: mocks.mutateBoard,
    });
  });

  it.each([
    {
      operation: "move-card",
      boardId: "board",
      cardId: "card",
      status: "Done",
      beforeId: null,
    },
    {
      operation: "rename-column",
      boardId: "board",
      from: "Todo",
      to: "Next",
    },
    {
      operation: "delete-column",
      boardId: "board",
      name: "Done",
      fallback: "Todo",
    },
  ])("runs $operation as one Store mutation", async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(mocks.mutateBoard).toHaveBeenCalledWith(body, "route-test");
  });

  it.each([
    {},
    { operation: "move-card", boardId: "board", cardId: "card", status: "Done" },
    { operation: "move-card", boardId: "bad.id", cardId: "card", status: "Done", beforeId: null },
    { operation: "rename-column", boardId: "board", from: "Todo" },
    { operation: "delete-column", boardId: "board", name: "Done" },
  ])("rejects malformed input before opening the Store", async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("fails closed without exposing Store details", async () => {
    mocks.mutateBoard.mockRejectedValueOnce(new Error("/srv/brain/private"));
    const response = await POST(
      request({
        operation: "rename-column",
        boardId: "board",
        from: "Todo",
        to: "Next",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "board changed",
    });
  });
});
