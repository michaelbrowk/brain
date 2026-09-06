import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShareToken, verifyShareEditToken } from "@/lib/auth";

const ORIGIN = "https://brain.example";

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

  it("answers 404 before bcrypt when the public link has no password", async () => {
    const compare = vi.fn();
    vi.doMock("bcryptjs", () => ({ default: { compare } }));
    vi.doMock("@/lib/store", () => ({
      getStore: async () => ({
        readPage: async () => ({
          meta: { id: "shared-page", public: true, shareVersion: 3 },
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

describe("the edit mint", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "mint-secret");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", ORIGIN);
  });

  afterEach(() => {
    vi.doUnmock("@/lib/store");
    vi.doUnmock("@/lib/auth");
    vi.doUnmock("bcryptjs");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function editRequest(
    body: Record<string, unknown>,
    cookie?: string,
    headers: Record<string, string> = {},
  ) {
    return new NextRequest("https://brain.example/api/share-auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: JSON.stringify({ intent: "edit", ...body }),
    });
  }

  function readRequest(password: string) {
    return new NextRequest("https://brain.example/api/share-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "root-1", password }),
    });
  }

  function mockRoot(meta: Record<string, unknown>) {
    vi.doMock("@/lib/store", () => ({
      getStore: async () => ({
        readPage: async () => ({ meta: { id: "root-1", ...meta } }),
        isDeleted: () => false,
      }),
      isNotFound: () => false,
      configuredPublicOrigin: () => ORIGIN,
    }));
  }

  it("refuses a cross-site mint, so no page can plant an edit cookie in a stranger's browser", async () => {
    // A cross-site <form enctype="text/plain"> POST is a request a browser
    // will make with the victim's cookies and no script. Without this the
    // mint set brain_edit_share_<root> carrying an attacker-chosen display
    // name, and the victim skipped the name dialog and edited under it.
    mockRoot({ public: true, shareEdit: true, shareVersion: 2 });
    const { POST } = await import("./route");

    for (const origin of ["https://evil.test", "null"]) {
      const res = await POST(
        editRequest({ id: "root-1", name: "Ada" }, undefined, { Origin: origin }),
      );
      expect(res.status, origin).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "bad_origin" });
      expect(res.cookies.get("brain_edit_share_root-1")).toBeUndefined();
    }
  });

  it("refuses a mint that did not declare JSON, which is what a cross-site form cannot declare", async () => {
    mockRoot({ public: true, shareEdit: true, shareVersion: 2 });
    const { POST } = await import("./route");
    const res = await POST(
      editRequest({ id: "root-1", name: "Ada" }, undefined, {
        "Content-Type": "text/plain;charset=UTF-8",
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad request" });
    expect(res.cookies.get("brain_edit_share_root-1")).toBeUndefined();
  });

  it("mints an edit cookie on an unlocked editable root and sets no read cookie", async () => {
    mockRoot({ public: true, shareEdit: true, shareVersion: 2 });
    const { POST } = await import("./route");

    const res = await POST(editRequest({ id: "root-1", name: "  Ada  " }));

    expect(res.status).toBe(200);
    const cookie = res.cookies.get("brain_edit_share_root-1");
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
    expect(cookie?.maxAge).toBe(12 * 60 * 60);
    expect(res.cookies.get("brain_share_root-1")).toBeUndefined();
    await expect(
      verifyShareEditToken(cookie!.value, "root-1", 2),
    ).resolves.toMatchObject({ name: "Ada" });
  });

  it("does not exhaust the bcrypt bucket: thirty unlocked mints all succeed", async () => {
    mockRoot({ public: true, shareEdit: true, shareVersion: 2 });
    const { POST } = await import("./route");
    for (let i = 0; i < 30; i += 1) {
      const res = await POST(editRequest({ id: "root-1", name: `V${i}` }));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(editRequest({ id: "root-1", name: "V30" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("refuses a root that is not editable, with the same 404 as a missing one", async () => {
    mockRoot({ public: true, shareVersion: 2 });
    const { POST } = await import("./route");
    const res = await POST(editRequest({ id: "root-1", name: "Ada" }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not found" });
  });

  it("refuses an empty name with the route's existing 400", async () => {
    mockRoot({ public: true, shareEdit: true, shareVersion: 2 });
    const { POST } = await import("./route");
    const res = await POST(editRequest({ id: "root-1", name: "   " }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad request" });
  });

  it("takes a valid read cookie in place of the password on a locked root", async () => {
    mockRoot({
      public: true,
      shareEdit: true,
      sharePass: "bcrypt-hash",
      shareVersion: 2,
    });
    const read = await createShareToken("root-1", 2);
    const { POST } = await import("./route");

    const res = await POST(
      editRequest({ id: "root-1", name: "Ada" }, `brain_share_root-1=${read}`),
    );

    expect(res.status).toBe(200);
    expect(res.cookies.get("brain_edit_share_root-1")?.value).toBeTruthy();
  });

  it("refuses a read cookie minted at an earlier shareVersion", async () => {
    mockRoot({
      public: true,
      shareEdit: true,
      sharePass: "bcrypt-hash",
      shareVersion: 3,
    });
    const stale = await createShareToken("root-1", 2);
    const { POST } = await import("./route");

    const res = await POST(
      editRequest({ id: "root-1", name: "Ada" }, `brain_share_root-1=${stale}`),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "wrong password" });
  });

  it("sets both cookies when it verified the password itself, and resets the read bucket", async () => {
    const compare = vi.fn().mockResolvedValue(false);
    vi.doMock("bcryptjs", () => ({ default: { compare } }));
    mockRoot({
      public: true,
      shareEdit: true,
      sharePass: "bcrypt-hash",
      shareVersion: 2,
    });
    const { POST } = await import("./route");

    for (let i = 0; i < 4; i += 1) {
      const miss = await POST(
        editRequest({ id: "root-1", name: "Ada", password: "wrong" }),
      );
      expect(miss.status).toBe(401);
    }
    compare.mockResolvedValueOnce(true);
    const res = await POST(
      editRequest({ id: "root-1", name: "Ada", password: "hunter2" }),
    );

    expect(res.status).toBe(200);
    expect(res.cookies.get("brain_edit_share_root-1")?.value).toBeTruthy();
    expect(res.cookies.get("brain_share_root-1")?.value).toBeTruthy();

    // The success reset the shared bucket the way the read path does: five
    // more guesses through the read path all reach bcrypt instead of a 429.
    for (let i = 0; i < 5; i += 1) {
      const miss = await POST(readRequest("wrong"));
      expect(miss.status).toBe(401);
    }
    expect(compare).toHaveBeenCalledTimes(10);
  });

  it("spends the read path's bcrypt budget on a password guess, so the mint widens nothing", async () => {
    const compare = vi.fn().mockResolvedValue(false);
    vi.doMock("bcryptjs", () => ({ default: { compare } }));
    mockRoot({
      public: true,
      shareEdit: true,
      sharePass: "bcrypt-hash",
      shareVersion: 2,
    });
    const { POST } = await import("./route");

    for (let i = 0; i < 5; i += 1) {
      const res = await POST(
        editRequest({ id: "root-1", name: "Ada", password: "wrong" }),
      );
      expect(res.status).toBe(401);
    }
    compare.mockResolvedValue(true);
    const blocked = await POST(
      editRequest({ id: "root-1", name: "Ada", password: "correct" }),
    );
    expect(blocked.status).toBe(429);
    expect(compare).toHaveBeenCalledTimes(5);

    // The same five guesses have locked the read path too: one budget per page.
    const readBlocked = await POST(readRequest("correct"));
    expect(readBlocked.status).toBe(429);
    expect(compare).toHaveBeenCalledTimes(5);
  });

  it("refuses a locked root with neither a password nor a read cookie", async () => {
    mockRoot({
      public: true,
      shareEdit: true,
      sharePass: "bcrypt-hash",
      shareVersion: 2,
    });
    const { POST } = await import("./route");
    const res = await POST(editRequest({ id: "root-1", name: "Ada" }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "wrong password" });
  });

  it("leaves a request without intent byte for byte as it was", async () => {
    vi.doMock("bcryptjs", () => ({ default: { compare: async () => false } }));
    mockRoot({ public: true, sharePass: "bcrypt-hash", shareVersion: 1 });
    const { POST } = await import("./route");

    const res = await POST(
      new NextRequest("https://brain.example/api/share-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "root-1", password: "nope" }),
      }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "wrong password" });
  });
});
