import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPage: vi.fn(),
  getStore: vi.fn(),
  redactPageMeta: vi.fn((value: unknown) => value),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isNotFound: (error: unknown) =>
    error instanceof Error && error.name === "NotFoundError",
  isQuickCaptureConflict: (error: unknown) =>
    error instanceof Error && error.name === "QuickCaptureConflictError",
  redactPageMeta: mocks.redactPageMeta,
}));

import { POST } from "./route";

function request(value: unknown): NextRequest {
  return new NextRequest("https://brain.test/api/page", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-brain-client": "route-test",
    },
    body: JSON.stringify(value),
  });
}

describe("page POST quick-capture idempotency", () => {
  beforeEach(() => {
    mocks.createPage.mockReset().mockResolvedValue({
      id: "created-page",
      title: "Thought",
    });
    mocks.getStore.mockReset().mockResolvedValue({
      createPage: mocks.createPage,
    });
  });

  it("derives the same namespaced page id for retries of one capture key", async () => {
    const body = {
      parentId: null,
      title: "Thought",
      idempotencyKey: "capture_operation_1234567890",
    };
    await POST(request(body));
    await POST(request(body));

    expect(mocks.createPage).toHaveBeenCalledTimes(2);
    const firstId = mocks.createPage.mock.calls[0][2].id;
    const secondId = mocks.createPage.mock.calls[1][2].id;
    const firstFingerprint =
      mocks.createPage.mock.calls[0][2].quickCaptureFingerprint;
    const secondFingerprint =
      mocks.createPage.mock.calls[1][2].quickCaptureFingerprint;
    expect(firstId).toBe(secondId);
    expect(firstId).toMatch(/^quickcapture_[A-Za-z0-9_-]{32}$/);
    expect(firstFingerprint).toBe(secondFingerprint);
    expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds one capture key to one exact payload and maps conflicts to 409", async () => {
    const key = "capture_operation_1234567890";
    await POST(
      request({
        parentId: null,
        title: "First thought",
        idempotencyKey: key,
      }),
    );
    await POST(
      request({
        parentId: null,
        title: "Different thought",
        idempotencyKey: key,
      }),
    );

    const first = mocks.createPage.mock.calls[0][2];
    const second = mocks.createPage.mock.calls[1][2];
    expect(first.id).toBe(second.id);
    expect(first.quickCaptureFingerprint).not.toBe(
      second.quickCaptureFingerprint,
    );

    mocks.createPage.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), {
        name: "QuickCaptureConflictError",
      }),
    );
    const conflict = await POST(
      request({
        parentId: null,
        title: "Different thought",
        idempotencyKey: key,
      }),
    );
    expect(conflict.status).toBe(409);
    // The conflict names the page the key already made. The id is derived
    // from the key alone, so it is the one every attempt of this capture was
    // given — the client opens it instead of retrying forever.
    await expect(conflict.json()).resolves.toEqual({
      error: "quick capture conflict",
      id: first.id,
    });
  });

  it.each([
    "short",
    "contains spaces but is long enough",
    "x".repeat(129),
  ])("rejects an invalid capture key before opening the Store", async (key) => {
    const response = await POST(
      request({
        parentId: null,
        title: "Thought",
        idempotencyKey: key,
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("bounds only idempotent quick-capture titles", async () => {
    const response = await POST(
      request({
        parentId: null,
        title: "x".repeat(501),
        idempotencyKey: "capture_operation_1234567890",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("takes the deterministic path on shape alone, with no capture flag", async () => {
    // The guard used to require the body to declare `inbox: true` alongside
    // the key. The Inbox is gone, so the shape is the whole gate: a root
    // parent, a bounded title, a well-formed key.
    const response = await POST(
      request({
        parentId: null,
        title: "Thought",
        idempotencyKey: "capture_operation_1234567890",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createPage).toHaveBeenCalledWith(
      null,
      "Thought",
      expect.objectContaining({
        id: expect.stringMatching(/^quickcapture_[A-Za-z0-9_-]{32}$/),
        quickCaptureFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(mocks.createPage.mock.calls[0][2]).not.toHaveProperty("inbox");
  });

  it("still refuses a non-root parent on the deterministic path", async () => {
    const response = await POST(
      request({
        parentId: "somewhere",
        title: "Thought",
        idempotencyKey: "capture_operation_1234567890",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("keeps ordinary page creation backward compatible", async () => {
    const response = await POST(
      request({ parentId: null, title: "Ordinary page" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createPage).toHaveBeenCalledWith(
      null,
      "Ordinary page",
      expect.not.objectContaining({
        id: expect.anything(),
        quickCaptureFingerprint: expect.anything(),
      }),
    );
  });
});
