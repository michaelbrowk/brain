import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  nestPageRef: vi.fn(),
  redactPage: vi.fn((value: unknown) => value),
  redactPageMeta: vi.fn((value: unknown) => value),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isRevConflict: (error: unknown) =>
    error instanceof Error && error.name === "RevConflictError",
  isNotFound: (error: unknown) =>
    error instanceof Error && error.name === "NotFoundError",
  isPageRefNestValidation: (error: unknown) =>
    error instanceof Error && error.name === "PageRefNestValidationError",
  redactPage: mocks.redactPage,
  redactPageMeta: mocks.redactPageMeta,
}));

import { POST } from "./route";

const body = {
  sourceId: "source-page",
  targetId: "target-page",
  parentPageId: "parent-page",
  expectedParentRev: "a1b2c3d4e5f6",
  sourceOccurrence: 0,
  sourceFingerprint: "[Source](/p/source-page)",
};

function request(value: unknown = body): NextRequest {
  return new NextRequest("https://brain.test/api/page-ref/nest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-brain-client": "route-test",
    },
    body: JSON.stringify(value),
  });
}

describe("page-ref nest POST", () => {
  beforeEach(() => {
    mocks.nestPageRef.mockReset().mockResolvedValue({
      removed: true,
      moved: { id: body.sourceId, sharePass: "secret" },
      parent: {
        meta: { id: body.parentPageId, sharePass: "secret" },
        markdown: "body",
        rev: "f6e5d4c3b2a1",
      },
    });
    mocks.getStore.mockReset().mockResolvedValue({
      nestPageRef: mocks.nestPageRef,
    });
    mocks.redactPage.mockClear();
    mocks.redactPageMeta.mockClear();
  });

  it("returns the redacted move and authoritative parent page", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toMatchObject({
      removed: true,
    });
    expect(mocks.nestPageRef).toHaveBeenCalledWith(
      body.sourceId,
      body.targetId,
      body.parentPageId,
      body.expectedParentRev,
      body.sourceOccurrence,
      body.sourceFingerprint,
      "route-test",
      "sibling",
    );
    expect(mocks.redactPageMeta).toHaveBeenCalledWith(
      expect.objectContaining({ id: body.sourceId }),
    );
    expect(mocks.redactPage).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: "body" }),
    );
  });

  it("returns an authoritative cleanup-only result through the same API contract", async () => {
    const targetRef = `[Target](/p/${body.targetId})`;
    mocks.nestPageRef.mockResolvedValueOnce({
      removed: true,
      // An already nested source is returned unchanged; the route must not
      // require a second operation mode or fabricate a hierarchy mutation.
      moved: { id: body.sourceId, title: "Source" },
      parent: {
        meta: { id: body.parentPageId, title: "Parent" },
        markdown: targetRef,
        rev: "f6e5d4c3b2a1",
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      removed: true,
      moved: { id: body.sourceId, title: "Source" },
      parent: {
        meta: { id: body.parentPageId, title: "Parent" },
        markdown: targetRef,
        rev: "f6e5d4c3b2a1",
      },
    });
    expect(mocks.nestPageRef).toHaveBeenCalledWith(
      body.sourceId,
      body.targetId,
      body.parentPageId,
      body.expectedParentRev,
      body.sourceOccurrence,
      body.sourceFingerprint,
      "route-test",
      "sibling",
    );
  });

  it.each([
    ["missing field", { ...body, targetId: undefined }],
    ["malformed id", { ...body, sourceId: "bad.id" }],
    ["malformed revision", { ...body, expectedParentRev: "stale" }],
    ["half synthesized", { ...body, sourceOccurrence: null }],
    ["negative occurrence", { ...body, sourceOccurrence: -1 }],
    ["invalid scope", { ...body, scope: "outside" }],
  ])("rejects a %s before opening the Store", async (_label, value) => {
    const response = await POST(request(value));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid request" });
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("returns the current revision for a stale parent", async () => {
    mocks.nestPageRef.mockRejectedValueOnce(
      Object.assign(new Error("rev conflict"), {
        name: "RevConflictError",
        currentRev: "f6e5d4c3b2a1",
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "conflict",
      currentRev: "f6e5d4c3b2a1",
    });
  });

  it("returns 404 when any referenced page is missing", async () => {
    mocks.nestPageRef.mockRejectedValueOnce(
      Object.assign(new Error("page not found"), { name: "NotFoundError" }),
    );

    const response = await POST(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });

  it("accepts a synthesized ref as an explicit nullable pair", async () => {
    mocks.nestPageRef.mockResolvedValueOnce({
      removed: false,
      moved: { id: body.sourceId },
      parent: {
        meta: { id: body.parentPageId },
        markdown: "body",
        rev: body.expectedParentRev,
      },
    });

    const response = await POST(
      request({
        ...body,
        sourceOccurrence: null,
        sourceFingerprint: null,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ removed: false });
    expect(mocks.nestPageRef).toHaveBeenLastCalledWith(
      body.sourceId,
      body.targetId,
      body.parentPageId,
      body.expectedParentRev,
      null,
      null,
      "route-test",
      "sibling",
    );
  });

  it("passes an explicit tree scope to the Store", async () => {
    const response = await POST(request({ ...body, scope: "tree" }));

    expect(response.status).toBe(200);
    expect(mocks.nestPageRef).toHaveBeenLastCalledWith(
      body.sourceId,
      body.targetId,
      body.parentPageId,
      body.expectedParentRev,
      body.sourceOccurrence,
      body.sourceFingerprint,
      "route-test",
      "tree",
    );
  });

  it("returns validation failures as 400 and operational failures as 500", async () => {
    mocks.nestPageRef.mockRejectedValueOnce(
      Object.assign(new Error("selection mismatch"), {
        name: "PageRefNestValidationError",
      }),
    );
    const validation = await POST(request());
    expect(validation.status).toBe(400);
    await expect(validation.json()).resolves.toEqual({
      error: "selection mismatch",
    });

    mocks.nestPageRef.mockRejectedValueOnce(new Error("rename failed"));
    const operational = await POST(request());
    expect(operational.status).toBe(500);
    await expect(operational.json()).resolves.toEqual({
      error: "page-ref nesting failed",
    });
  });
});
