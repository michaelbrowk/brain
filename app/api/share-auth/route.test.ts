import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

function request(password: string): NextRequest {
  return new NextRequest("https://brain.example/api/share-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "shared-page", password }),
  });
}

describe("shared-page password rate limiting", () => {
  afterEach(() => {
    vi.doUnmock("bcryptjs");
    vi.doUnmock("@/lib/store");
    vi.doUnmock("@/lib/auth");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("stops invoking bcrypt after the per-page comparison cap", async () => {
    const compare = vi.fn().mockResolvedValue(false);
    const readPage = vi.fn().mockResolvedValue({
      meta: {
        id: "shared-page",
        public: true,
        sharePass: "bcrypt-hash",
        shareVersion: 1,
      },
    });
    vi.doMock("bcryptjs", () => ({ default: { compare } }));
    vi.doMock("@/lib/store", () => ({
      getStore: async () => ({ readPage, isDeleted: () => false }),
      isNotFound: () => false,
    }));
    vi.doMock("@/lib/auth", () => ({
      createShareToken: vi.fn(),
    }));
    const { POST } = await import("./route");

    for (let index = 0; index < 5; index += 1) {
      await expect(POST(request("wrong"))).resolves.toMatchObject({
        status: 401,
      });
    }

    compare.mockResolvedValue(true);
    const blockedCorrect = await POST(request("correct"));

    expect(blockedCorrect.status).toBe(429);
    expect(blockedCorrect.headers.get("Retry-After")).toBeTruthy();
    expect(compare).toHaveBeenCalledTimes(5);
  });

  it("sets a root-path page-scoped cookie so shared attachments can verify it", async () => {
    const compare = vi.fn().mockResolvedValue(true);
    vi.doMock("bcryptjs", () => ({ default: { compare } }));
    vi.doMock("@/lib/store", () => ({
      getStore: async () => ({
        readPage: async () => ({
          meta: {
            id: "shared-page",
            public: true,
            sharePass: "bcrypt-hash",
            shareVersion: 3,
          },
        }),
        isDeleted: () => false,
      }),
      isNotFound: () => false,
    }));
    vi.doMock("@/lib/auth", () => ({
      createShareToken: async () => "share-token",
    }));
    const { POST } = await import("./route");

    const response = await POST(request("correct"));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Path=/");
  });

  it("fails closed before bcrypt when the public link has expired", async () => {
    const compare = vi.fn();
    vi.doMock("bcryptjs", () => ({ default: { compare } }));
    vi.doMock("@/lib/store", () => ({
      getStore: async () => ({
        readPage: async () => ({
          meta: {
            id: "shared-page",
            public: true,
            sharePass: "bcrypt-hash",
            shareVersion: 3,
            shareExpiresAt: "2000-01-01T00:00:00.000Z",
          },
        }),
        isDeleted: () => false,
      }),
      isNotFound: () => false,
    }));
    vi.doMock("@/lib/auth", () => ({
      createShareToken: vi.fn(),
    }));
    const { POST } = await import("./route");

    const response = await POST(request("correct"));

    expect(response.status).toBe(404);
    expect(compare).not.toHaveBeenCalled();
  });
});
