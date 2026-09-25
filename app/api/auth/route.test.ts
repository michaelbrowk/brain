import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

function request(
  body: string,
  cookie?: string,
  headers?: Record<string, string>,
): NextRequest {
  return new NextRequest("https://brain.example/api/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body,
  });
}

const wrongGuess = (cookie?: string, headers?: Record<string, string>) =>
  request(JSON.stringify({ password: "definitely wrong" }), cookie, headers);
const rightGuess = (cookie?: string, headers?: Record<string, string>) =>
  request(JSON.stringify({ password: "correct horse" }), cookie, headers);

async function configure() {
  process.env.AUTH_PASSWORD_HASH = await bcrypt.hash("correct horse", 4);
  process.env.AUTH_SECRET = "test-secret-that-never-leaves-this-process";
}

describe("login rate limiting", () => {
  afterEach(() => {
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_SECRET;
    delete process.env.BRAIN_PUBLIC_ORIGIN;
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

    // The shared bucket never saw any of those five: all ten of its own still
    // reach bcrypt, and only the eleventh is refused.
    for (let index = 0; index < 10; index += 1) {
      await expect(POST(wrongGuess())).resolves.toMatchObject({ status: 401 });
    }
    await expect(POST(wrongGuess())).resolves.toMatchObject({ status: 429 });

    // A second device is untouched by either of them.
    const other = `${DEVICE_COOKIE}=${createDeviceCookie()}`;
    await expect(POST(rightGuess(other))).resolves.toMatchObject({
      status: 200,
    });
  });

  /** The device bucket ADDS a budget, it does not replace one. Keying on the
   *  cookie alone left a browser whose own five were spent — or whose cookie a
   *  stranger had copied and spent for it — with less than a browser carrying no
   *  cookie at all, which is the wrong way round for the one thing the cookie
   *  exists to protect. */
  it("falls through to the shared bucket when the device's own is spent", async () => {
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
      status: 200,
    });
  });

  it("refuses only when both the device's bucket and the shared one are spent", async () => {
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
    for (let index = 0; index < 10; index += 1) {
      await expect(POST(wrongGuess())).resolves.toMatchObject({ status: 401 });
    }

    const refused = await POST(rightGuess(device));
    expect(refused.status).toBe(429);
    // The sooner of the two windows: the first moment any budget exists again.
    expect(Number(refused.headers.get("Retry-After"))).toBeLessThanOrEqual(30);
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

  /** The device map is bounded, and what it does when it is full is the whole
   *  question: refusing a key it has no room for would hand the newest device a
   *  lockout, which is what the shared bucket's own refusal is there to avoid
   *  handing anyone. It evicts the oldest window instead — the one with the least
   *  of itself left to spend. */
  it("holds a thousand devices, then evicts the oldest rather than refusing the newest", async () => {
    await configure();
    // A real comparison per request would be a thousand bcrypt hashes for one
    // assertion about a Map.
    const compare = vi
      .spyOn(bcrypt, "compare")
      .mockImplementation(async (password) => password === "correct horse");
    const { POST } = await import("./route");
    const { createDeviceCookie, DEVICE_COOKIE } = await import(
      "@/lib/device-cookie"
    );
    const cookie = () => `${DEVICE_COOKIE}=${createDeviceCookie()}`;

    const first = cookie();
    await expect(POST(wrongGuess(first))).resolves.toMatchObject({ status: 401 });
    for (let index = 1; index < 1_024; index += 1) {
      await expect(POST(wrongGuess(cookie()))).resolves.toMatchObject({
        status: 401,
      });
    }

    // With the shared bucket spent as well, a denial is a denial: nothing is left
    // to fall through to.
    for (let index = 0; index < 10; index += 1) {
      await expect(POST(wrongGuess())).resolves.toMatchObject({ status: 401 });
    }

    // The first device's own window survived a thousand later ones, so its four
    // remaining comparisons are still its own and the fifth is refused. An
    // eviction that came early would have given it a fresh window instead.
    for (let index = 0; index < 4; index += 1) {
      await expect(POST(wrongGuess(first))).resolves.toMatchObject({
        status: 401,
      });
    }
    await expect(POST(rightGuess(first))).resolves.toMatchObject({ status: 429 });

    // And the device that arrives to a full map is admitted, not refused.
    await expect(POST(rightGuess(cookie()))).resolves.toMatchObject({
      status: 200,
    });
    expect(compare).toHaveBeenCalledTimes(1_024 + 10 + 4 + 1);
  });

  /** Before this gate, a page a visitor happened to open could POST a form with
   *  `enctype="text/plain"` to somebody's Brain and drain the shared budget from
   *  their browser, burning a bcrypt comparison per request on the way. No script
   *  and no reply needed: the request is the whole attack. */
  it("refuses a cross-site POST before it can spend a comparison", async () => {
    await configure();
    process.env.BRAIN_PUBLIC_ORIGIN = "https://brain.example";
    const compare = vi.spyOn(bcrypt, "compare");
    const { POST } = await import("./route");

    const foreign = await POST(
      rightGuess(undefined, { Origin: "https://evil.test" }),
    );
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toEqual({ error: "bad_origin" });

    const attested = await POST(
      rightGuess(undefined, { "Sec-Fetch-Site": "cross-site" }),
    );
    expect(attested.status).toBe(403);

    const plainText = await POST(
      rightGuess(undefined, {
        Origin: "https://brain.example",
        "Content-Type": "text/plain;charset=UTF-8",
      }),
    );
    expect(plainText.status).toBe(400);
    await expect(plainText.json()).resolves.toEqual({ error: "bad request" });

    // Nothing above reached bcrypt, and nothing above spent a budget: all ten of
    // the shared bucket's comparisons are still there.
    expect(compare).not.toHaveBeenCalled();
    for (let index = 0; index < 10; index += 1) {
      await expect(
        POST(wrongGuess(undefined, { Origin: "https://brain.example" })),
      ).resolves.toMatchObject({ status: 401 });
    }
    expect(compare).toHaveBeenCalledTimes(10);
  });

  it("admits the app's own form, and a client that sends no origin at all", async () => {
    await configure();
    process.env.BRAIN_PUBLIC_ORIGIN = "https://brain.example";
    const { POST } = await import("./route");

    // What the login form sends: same-origin JSON, with the Origin a browser
    // attaches to every POST.
    await expect(
      POST(
        rightGuess(undefined, {
          Origin: "https://brain.example",
          "Sec-Fetch-Site": "same-origin",
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });

    // What the standalone and compose smokes send: node `fetch`, which attaches
    // neither header. A client outside a browser is not what this gate is for,
    // and the rate budget is what bounds one that lies.
    await expect(POST(rightGuess())).resolves.toMatchObject({ status: 200 });

    // The owner who browses on the private name while BRAIN_PUBLIC_ORIGIN names
    // the address from outside. The browser says the request is same-origin, and
    // it is: refusing here would lock the owner out of their own Brain over a
    // hostname, which is not what this gate is for either.
    await expect(
      POST(
        rightGuess(undefined, {
          Origin: "http://brain.lan",
          "Sec-Fetch-Site": "same-origin",
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("compares the origin with the host when nothing is configured to compare it to", async () => {
    await configure();
    const { POST } = await import("./route");

    // An older browser or a header-stripping proxy sends no attestation, and an
    // installation that has set no public origin has nothing to check against but
    // the host the request was addressed to — the header nginx forwards as $host.
    await expect(
      POST(
        rightGuess(undefined, {
          Host: "brain.example",
          Origin: "https://brain.example",
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      POST(
        rightGuess(undefined, {
          Host: "brain.example",
          Origin: "https://evil.test",
        }),
      ),
    ).resolves.toMatchObject({ status: 403 });
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
