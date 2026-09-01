import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

function request(body: string): NextRequest {
  return new NextRequest("https://brain.example/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("login rate limiting", () => {
  afterEach(() => {
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_SECRET;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("stops invoking bcrypt after the global comparison cap", async () => {
    process.env.AUTH_PASSWORD_HASH = await bcrypt.hash("correct horse", 4);
    process.env.AUTH_SECRET = "test-secret-that-never-leaves-this-process";
    const compare = vi.spyOn(bcrypt, "compare");
    const { POST } = await import("./route");

    for (let index = 0; index < 8; index += 1) {
      await expect(POST(request("{"))).resolves.toMatchObject({ status: 400 });
    }
    expect(compare).not.toHaveBeenCalled();

    for (let index = 0; index < 5; index += 1) {
      await expect(
        POST(
        request(JSON.stringify({ password: "definitely wrong" })),
        ),
      ).resolves.toMatchObject({ status: 401 });
    }

    const blockedCorrect = await POST(
      request(JSON.stringify({ password: "correct horse" })),
    );
    expect(blockedCorrect.status).toBe(429);
    expect(blockedCorrect.headers.get("Retry-After")).toBeTruthy();
    expect(compare).toHaveBeenCalledTimes(5);
  });

  it("creates a session when the correct password is within the cap", async () => {
    process.env.AUTH_PASSWORD_HASH = await bcrypt.hash("correct horse", 4);
    process.env.AUTH_SECRET = "test-secret-that-never-leaves-this-process";
    const { POST } = await import("./route");

    const correct = await POST(
      request(JSON.stringify({ password: "correct horse" })),
    );

    expect(correct.status).toBe(200);
    expect(correct.headers.get("set-cookie")).toContain("brain_session=");
  });
});

describe("logout everywhere", () => {
  afterEach(() => {
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_SECRET;
    delete process.env.BRAIN_AUTH_STATE_DIR;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("requires a live session to bump the epoch, then kills all cookies", async () => {
    process.env.AUTH_SECRET = "test-secret-that-never-leaves-this-process";
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    process.env.BRAIN_AUTH_STATE_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "brain-auth-route-"),
    );
    const { DELETE } = await import("./route");
    const { createSession, verifySession } = await import("@/lib/auth");

    // anonymous caller cannot revoke the owner's sessions
    const anonymous = await DELETE(
      new NextRequest("https://brain.example/api/auth", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "everywhere" }),
      }),
    );
    expect(anonymous.status).toBe(401);

    const session = await createSession();
    await expect(verifySession(session)).resolves.toBe(true);
    const authed = await DELETE(
      new NextRequest("https://brain.example/api/auth", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          cookie: `brain_session=${session}`,
        },
        body: JSON.stringify({ scope: "everywhere" }),
      }),
    );
    expect(authed.status).toBe(200);
    await expect(verifySession(session)).resolves.toBe(false);
  });

  it("keeps the plain logout unauthenticated and epoch-free", async () => {
    process.env.AUTH_SECRET = "test-secret-that-never-leaves-this-process";
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    process.env.BRAIN_AUTH_STATE_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "brain-auth-route-plain-"),
    );
    const { DELETE } = await import("./route");
    const { createSession, verifySession } = await import("@/lib/auth");
    const session = await createSession();

    const response = await DELETE(
      new NextRequest("https://brain.example/api/auth", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    // another device's cookie stays valid — only the caller's cookie cleared
    await expect(verifySession(session)).resolves.toBe(true);
  });
});
