import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  configureShare: vi.fn(),
  readShareScope: vi.fn(),
  hash: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isNotFound: (error: unknown) =>
    error instanceof Error && error.name === "NotFoundError",
  isShareScopeConflict: (error: unknown) =>
    error instanceof Error && error.name === "ShareScopeConflictError",
}));
vi.mock("bcryptjs", () => ({
  default: { hash: mocks.hash },
}));

import { GET, POST } from "./route";

const PAGE_ID = "page-a";
const TOKEN = "a".repeat(64);
const disclosed = {
  rootId: PAGE_ID,
  descendantCount: 2,
  overlappingRoots: [],
  scopeToken: TOKEN,
  public: false,
  shareLocked: false,
  shareExpiresAt: null,
  shareVersion: 0,
};
const enabled = {
  ...disclosed,
  scopeToken: "b".repeat(64),
  public: true,
  shareLocked: true,
  shareVersion: 1,
};

function request(method: "GET" | "POST", body?: Record<string, unknown>) {
  return new NextRequest(`https://brain.test/api/page/${PAGE_ID}/share`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-brain-client": "client-a",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("atomic subtree sharing route", () => {
  beforeEach(() => {
    mocks.configureShare.mockReset().mockResolvedValue(undefined);
    mocks.readShareScope.mockReset().mockResolvedValue(disclosed);
    mocks.hash.mockReset().mockResolvedValue("bcrypt-hash");
    mocks.getStore.mockReset().mockResolvedValue({
      configureShare: mocks.configureShare,
      readShareScope: mocks.readShareScope,
    });
  });

  it("returns the exact owner disclosure without mutating", async () => {
    const response = await GET(request("GET"), {
      params: Promise.resolve({ id: PAGE_ID }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(disclosed);
    expect(mocks.configureShare).not.toHaveBeenCalled();
  });

  it("applies password, expiry, and public authority together then reads back", async () => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    mocks.readShareScope.mockResolvedValueOnce(enabled);

    const response = await POST(
      request("POST", {
        enabled: true,
        expectedScopeToken: TOKEN,
        password: "secret",
        expiresAt,
      }),
      { params: Promise.resolve({ id: PAGE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.hash).toHaveBeenCalledWith("secret", 10);
    expect(mocks.configureShare).toHaveBeenCalledWith(PAGE_ID, {
      enabled: true,
      expectedScopeToken: TOKEN,
      sharePass: "bcrypt-hash",
      shareExpiresAt: expiresAt,
      src: "client-a",
    });
    expect(mocks.configureShare.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readShareScope.mock.invocationCallOrder[0],
    );
    await expect(response.json()).resolves.toEqual(enabled);
  });

  it("preserves existing password and expiry when replacements are omitted", async () => {
    const preserved = {
      ...enabled,
      shareExpiresAt: "2026-08-03T12:00:00.000Z",
    };
    mocks.readShareScope.mockResolvedValueOnce(preserved);

    const response = await POST(
      request("POST", {
        enabled: true,
        expectedScopeToken: TOKEN,
      }),
      { params: Promise.resolve({ id: PAGE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.configureShare).toHaveBeenCalledWith(PAGE_ID, {
      enabled: true,
      expectedScopeToken: TOKEN,
      sharePass: undefined,
      shareExpiresAt: undefined,
      src: "client-a",
    });
    await expect(response.json()).resolves.toEqual(preserved);
  });

  it("returns the refreshed scope on conflict and performs no read-back", async () => {
    const refreshed = { ...disclosed, descendantCount: 3, scopeToken: "c".repeat(64) };
    mocks.configureShare.mockRejectedValueOnce(
      Object.assign(new Error("share scope conflict"), {
        name: "ShareScopeConflictError",
        snapshot: refreshed,
      }),
    );

    const response = await POST(
      request("POST", {
        enabled: true,
        expectedScopeToken: TOKEN,
        password: null,
        expiresAt: null,
      }),
      { params: Promise.resolve({ id: PAGE_ID }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "scope changed",
      snapshot: refreshed,
    });
    expect(mocks.readShareScope).not.toHaveBeenCalled();
  });

  it("revokes without a stale scope token and returns a read-back", async () => {
    mocks.readShareScope.mockResolvedValueOnce(disclosed);

    const response = await POST(request("POST", { enabled: false }), {
      params: Promise.resolve({ id: PAGE_ID }),
    });

    expect(response.status).toBe(200);
    expect(mocks.configureShare).toHaveBeenCalledWith(PAGE_ID, {
      enabled: false,
      src: "client-a",
    });
    await expect(response.json()).resolves.toEqual(disclosed);
  });

  it.each([
    ["missing enable flag", { expectedScopeToken: TOKEN }],
    ["missing scope token", { enabled: true }],
    ["short scope token", { enabled: true, expectedScopeToken: "abc" }],
    [
      "oversize password",
      {
        enabled: true,
        expectedScopeToken: TOKEN,
        password: "🙂".repeat(19),
      },
    ],
  ])("rejects %s before touching the store", async (_label, body) => {
    const response = await POST(request("POST", body), {
      params: Promise.resolve({ id: PAGE_ID }),
    });

    expect(response.status).toBe(400);
    expect(mocks.getStore).not.toHaveBeenCalled();
    expect(mocks.configureShare).not.toHaveBeenCalled();
  });
});
