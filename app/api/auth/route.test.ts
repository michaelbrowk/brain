import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

function request(body: string, cookie?: string): NextRequest {
  return new NextRequest("https://brain.example/api/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
}

const wrongGuess = (cookie?: string) =>
  request(JSON.stringify({ password: "definitely wrong" }), cookie);
const rightGuess = (cookie?: string) =>
  request(JSON.stringify({ password: "correct horse" }), cookie);

async function configure() {
  process.env.AUTH_PASSWORD_HASH = await bcrypt.hash("correct horse", 4);
  process.env.AUTH_SECRET = "test-secret-that-never-leaves-this-process";
}

describe("login rate limiting", () => {
  afterEach(() => {
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_SECRET;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("stops invoking bcrypt after the shared comparison cap", async () => {
    await configure();
    const compare = vi.spyOn(bcrypt, "compare");
    const { POST } = await import("./route");

    for (let index = 0; index < 8; index += 1) {
      await expect(POST(request("{"))).resolves.toMatchObject({ status: 400 });
    }
    expect(compare).not.toHaveBeenCalled();

    for (let index = 0; index < 10; index += 1) {
      await expect(POST(wrongGuess())).resolves.toMatchObject({ status: 401 });
    }

    const blockedCorrect = await POST(rightGuess());
    expect(blockedCorrect.status).toBe(429);
    expect(blockedCorrect.headers.get("Retry-After")).toBeTruthy();
    expect(compare).toHaveBeenCalledTimes(10);
  });

  /** The defect this replaced: one bucket, keyed on a constant, consumed before
   *  bcrypt and reset only by a success. A stranger sending wrong passwords at
   *  the cap kept the owner out for as long as they cared to keep sending, and
   *  no move the owner had from the login screen shortened it. */
  it("lets a device that has logged in before through a stranger's flood", async () => {
    await configure();
    const { POST } = await import("./route");
    const { createDeviceCookie, DEVICE_COOKIE } = await import(
      "@/lib/device-cookie"
    );
    const device = `${DEVICE_COOKIE}=${createDeviceCookie()}`;

    for (let index = 0; index < 10; index += 1) {
      await expect(POST(wrongGuess())).resolves.toMatchObject({ status: 401 });
    }
    await expect(POST(rightGuess())).resolves.toMatchObject({ status: 429 });

    const throughTheFlood = await POST(rightGuess(device));
    expect(throughTheFlood.status).toBe(200);
    expect(throughTheFlood.cookies.get("brain_session")?.value).toBeTruthy();
  });

  it("spends only its own bucket on a wrong password from a known device", async () => {
    await configure();
    const { POST } = await import("./route");
    const { createDeviceCookie, DEVICE_COOKIE } = await import(
      "@/lib/device-cookie"
    );
    const device = `${DEVICE_COOKIE}=${createDeviceCookie()}`;

    for (let index = 0; index < 5; index += 1) {
      await expect(POST(wrongGuess(device))).resolves.toMatchObject({
        status: 401,
      });
    }
    await expect(POST(rightGuess(device))).resolves.toMatchObject({
      status: 429,
    });

    // The shared bucket never saw any of it, and neither did a second device.
    await expect(POST(wrongGuess())).resolves.toMatchObject({ status: 401 });
    const other = `${DEVICE_COOKIE}=${createDeviceCookie()}`;
    await expect(POST(rightGuess(other))).resolves.toMatchObject({
      status: 200,
    });
  });

  it("counts a forged device cookie against the shared bucket", async () => {
    await configure();
    const { POST } = await import("./route");
    const { createDeviceCookie, DEVICE_COOKIE } = await import(
      "@/lib/device-cookie"
    );
    const forged = `${DEVICE_COOKIE}=deadbeef.${Buffer.alloc(32).toString("base64url")}`;

    for (let index = 0; index < 10; index += 1) {
      await expect(POST(wrongGuess(forged))).resolves.toMatchObject({
        status: 401,
      });
    }
    await expect(POST(rightGuess(forged))).resolves.toMatchObject({
      status: 429,
    });
    // An unsigned cookie buys a stranger the bucket a stranger already had, and
    // costs the owner nothing.
    await expect(
      POST(rightGuess(`${DEVICE_COOKIE}=${createDeviceCookie()}`)),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("sets the device cookie on every success, never on a failure", async () => {
    await configure();
    const { POST } = await import("./route");
    const { deviceBucketKey } = await import("@/lib/device-cookie");

    const first = await POST(rightGuess());
    const minted = first.cookies.get("brain_device");
    expect(minted?.value).toBeTruthy();
    expect(deviceBucketKey(minted!.value)).not.toBeNull();
    expect(minted).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
    });
    expect(first.headers.get("set-cookie")).toContain("brain_device=");

    // Refreshed rather than replaced: a new value on every login would hand the
    // same browser a new bucket on every login.
    const again = await POST(rightGuess(`brain_device=${minted!.value}`));
    expect(again.status).toBe(200);
    expect(again.cookies.get("brain_device")?.value).toBe(minted!.value);
    expect(again.cookies.get("brain_device")?.maxAge).toBe(365 * 24 * 60 * 60);

    // A wrong password mints nothing: the cookie says a login succeeded on this
    // browser, and a stranger's guess is not that.
    const refused = await POST(wrongGuess());
    expect(refused.status).toBe(401);
    expect(refused.cookies.get("brain_device")).toBeUndefined();
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

/** A `Secure` cookie is only accepted from a potentially-trustworthy origin, and
 *  of the private names Brain now invites, only `localhost`, `127.0.0.1` and
 *  `[::1]` are. So on `http://brain.lan` the login POST answered 200 and the
 *  browser threw the cookie away: the password screen came back, every time,
 *  with nothing anywhere saying why. */
describe("the session cookie's Secure flag follows the configured origin", () => {
  afterEach(() => {
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_SECRET;
    delete process.env.BRAIN_PUBLIC_ORIGIN;
    vi.resetModules();
  });

  const login = async (origin: string | undefined) => {
    process.env.AUTH_PASSWORD_HASH = await bcrypt.hash("correct horse", 4);
    process.env.AUTH_SECRET = "test-secret-that-never-leaves-this-process";
    if (origin === undefined) delete process.env.BRAIN_PUBLIC_ORIGIN;
    else process.env.BRAIN_PUBLIC_ORIGIN = origin;
    vi.resetModules();
    const { POST } = await import("./route");
    const response = await POST(
      request(JSON.stringify({ password: "correct horse" })),
    );
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie") ?? "";
  };

  it.each([
    "http://brain.lan",
    "http://192.168.1.10:3000",
    "http://127.0.0.1:3020",
  ])("drops it on the plain-http private origin %s", async (origin) => {
    expect(await login(origin)).not.toContain("Secure");
  });

  it("keeps it on an https origin", async () => {
    expect(await login("https://brain.example.com")).toContain("Secure");
  });

  it("keeps it when no origin is configured at all", async () => {
    expect(await login(undefined)).toContain("Secure");
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
