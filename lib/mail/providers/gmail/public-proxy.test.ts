import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GMAIL_OAUTH_TRANSACTION_COOKIE,
} from "./contract";
import {
  proxyGmailOAuthCallback,
  proxyGmailOAuthStart,
} from "./public-proxy";

const roots: string[] = [];
const servers: Server[] = [];
const PUBLIC_ORIGIN = "https://brain.test";
const OPAQUE_COOKIE_VALUE = "A".repeat(64);

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("public Gmail OAuth Unix-socket proxy", () => {
  it("forwards a top-level start and accepts only a strict __Host- cookie", async () => {
    let observed: IncomingMessage | undefined;
    const socketPath = await startService((request, response) => {
      observed = request;
      response.writeHead(303, {
        "Content-Length": "0",
        Location: googleAuthorizationLocation(),
        "Set-Cookie": startCookie(),
      });
      response.end();
    });
    const response = await proxyGmailOAuthStart(
      new Request(`${PUBLIC_ORIGIN}/api/mail/oauth/google/start`, {
        method: "POST",
        headers: { Origin: PUBLIC_ORIGIN },
      }),
      { socketPath, publicOrigin: PUBLIC_ORIGIN },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(googleAuthorizationLocation());
    expect(response.headers.get("Set-Cookie")).toBe(startCookie());
    expect(response.headers.get("Set-Cookie")).toContain(
      `${GMAIL_OAUTH_TRANSACTION_COOKIE}=`,
    );
    expect(response.headers.get("Set-Cookie")).toContain("Path=/");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=600");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("Secure");
    expect(response.headers.get("Set-Cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("Set-Cookie")).not.toContain("Domain=");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(observed?.method).toBe("POST");
    expect(observed?.url).toBe("/v1/oauth/gmail/start");
    expect(observed?.headers.cookie).toBeUndefined();
  });

  it("accepts an actual empty HTML form POST stream", async () => {
    const socketPath = await startService((_request, response) => {
      response.writeHead(303, {
        "Content-Length": "0",
        Location: googleAuthorizationLocation(),
        "Set-Cookie": startCookie(),
      });
      response.end();
    });
    const response = await proxyGmailOAuthStart(
      new Request(`${PUBLIC_ORIGIN}/api/mail/oauth/google/start`, {
        method: "POST",
        headers: {
          Origin: PUBLIC_ORIGIN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new Uint8Array(0),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      { socketPath, publicOrigin: PUBLIC_ORIGIN },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(googleAuthorizationLocation());
  });

  it.each([
    "http://brain.test/api/mail/oauth/google/start",
    "http://127.0.0.1:3020/api/mail/oauth/google/start",
    "https://127.0.0.1:3020/api/mail/oauth/google/start",
  ])("accepts a normalized standalone Next authority: %s", async (requestUrl) => {
    const socketPath = await startService((_request, response) => {
      response.writeHead(303, {
        "Content-Length": "0",
        Location: googleAuthorizationLocation(),
        "Set-Cookie": startCookie(),
      });
      response.end();
    });
    const response = await proxyGmailOAuthStart(
      new Request(requestUrl, {
        method: "POST",
        headers: {
          Origin: PUBLIC_ORIGIN,
        },
      }),
      { socketPath, publicOrigin: PUBLIC_ORIGIN },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(googleAuthorizationLocation());
  });

  it.each([
    "http://evil.test/api/mail/oauth/google/start",
    "https://evil.test/api/mail/oauth/google/start",
  ])("rejects an untrusted normalized authority: %s", async (requestUrl) => {
    const response = await proxyGmailOAuthStart(
      new Request(requestUrl, {
        method: "POST",
        headers: {
          Origin: PUBLIC_ORIGIN,
        },
      }),
      {
        socketPath: "/tmp/brain-mail-oauth-untrusted-authority.sock",
        publicOrigin: PUBLIC_ORIGIN,
      },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      `${PUBLIC_ORIGIN}/mail?gmail=error`,
    );
  });

  it("forwards one validated reconnect account without exposing it in a body", async () => {
    let observedUrl = "";
    let observedBodyBytes = 0;
    const socketPath = await startService((request, response) => {
      observedUrl = request.url ?? "";
      request.on("data", (chunk: Buffer) => {
        observedBodyBytes += chunk.length;
      });
      request.on("end", () => {
        response.writeHead(303, {
          "Content-Length": "0",
          Location: googleAuthorizationLocation(),
          "Set-Cookie": startCookie(),
        });
        response.end();
      });
    });
    const accountId = "account-a11111111111111111111111111111111";
    const response = await proxyGmailOAuthStart(
      new Request(`${PUBLIC_ORIGIN}/api/mail/oauth/google/start`, {
        method: "POST",
        headers: {
          Origin: PUBLIC_ORIGIN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ accountId }),
      }),
      { socketPath, publicOrigin: PUBLIC_ORIGIN },
    );

    expect(response.status).toBe(303);
    expect(observedUrl).toBe(
      `/v1/oauth/gmail/start?accountId=${accountId}`,
    );
    expect(observedBodyBytes).toBe(0);
  });

  it("rejects malformed reconnect form fields before opening the service", async () => {
    const deadSocket = "/tmp/brain-mail-oauth-invalid-form-never-opened.sock";
    for (const body of [
      "accountId=wrong",
      "accountId=account-a11111111111111111111111111111111&extra=1",
      "accountId=account-a11111111111111111111111111111111&accountId=account-a22222222222222222222222222222222",
    ]) {
      const response = await proxyGmailOAuthStart(
        new Request(`${PUBLIC_ORIGIN}/api/mail/oauth/google/start`, {
          method: "POST",
          headers: {
            Origin: PUBLIC_ORIGIN,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        }),
        { socketPath: deadSocket, publicOrigin: PUBLIC_ORIGIN },
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe(
        `${PUBLIC_ORIGIN}/mail?gmail=error`,
      );
    }
  });

  it.each([
    `${startCookie()}; Domain=brain.test`,
    startCookie(601),
    `${GMAIL_OAUTH_TRANSACTION_COOKIE}=${OPAQUE_COOKIE_VALUE}; Path=/; Max-Age=600; Secure; SameSite=Lax`,
  ])("rejects an unsafe service cookie without forwarding it: %s", async (cookie) => {
    const socketPath = await startService((_request, response) => {
      response.writeHead(303, {
        "Content-Length": "0",
        Location: googleAuthorizationLocation(),
        "Set-Cookie": cookie,
      });
      response.end();
    });
    const response = await proxyGmailOAuthStart(
      new Request(`${PUBLIC_ORIGIN}/api/mail/oauth/google/start`, {
        method: "POST",
        headers: { Origin: PUBLIC_ORIGIN },
      }),
      { socketPath, publicOrigin: PUBLIC_ORIGIN },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      `${PUBLIC_ORIGIN}/mail?gmail=error`,
    );
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("forwards only the opaque transaction cookie and clears it after success", async () => {
    let observedUrl = "";
    let observedCookie = "";
    const socketPath = await startService((request, response) => {
      observedUrl = request.url ?? "";
      observedCookie = request.headers.cookie ?? "";
      response.writeHead(303, {
        "Content-Length": "0",
        Location: `${PUBLIC_ORIGIN}/mail?gmail=connected`,
      });
      response.end();
    });
    const callback = new URL(
      `${PUBLIC_ORIGIN}/api/mail/oauth/google/callback`,
    );
    callback.searchParams.set("code", "CALLBACK_CODE_SECRET");
    callback.searchParams.set("iss", "https://accounts.google.com");
    callback.searchParams.set("state", "CALLBACK_STATE_SECRET");
    const response = await proxyGmailOAuthCallback(
      new Request(callback, {
        headers: {
          Cookie: `brain_session=session-secret; ${GMAIL_OAUTH_TRANSACTION_COOKIE}=${OPAQUE_COOKIE_VALUE}; unrelated=value`,
        },
      }),
      { socketPath, publicOrigin: PUBLIC_ORIGIN },
    );

    expect(observedUrl).toBe(
      "/v1/oauth/gmail/callback?code=CALLBACK_CODE_SECRET&iss=https%3A%2F%2Faccounts.google.com&state=CALLBACK_STATE_SECRET",
    );
    expect(observedCookie).toBe(
      `${GMAIL_OAUTH_TRANSACTION_COOKIE}=${OPAQUE_COOKIE_VALUE}`,
    );
    expect(observedCookie).not.toContain("brain_session");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      `${PUBLIC_ORIGIN}/mail?gmail=connected`,
    );
    expect(response.headers.get("Set-Cookie")).toBe(
      `${GMAIL_OAUTH_TRANSACTION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(JSON.stringify(Object.fromEntries(response.headers))).not.toContain(
      "CALLBACK_CODE_SECRET",
    );
    expect(JSON.stringify(Object.fromEntries(response.headers))).not.toContain(
      "CALLBACK_STATE_SECRET",
    );
  });

  it.each([
    "http://brain.test/api/mail/oauth/google/callback",
    "http://127.0.0.1:3020/api/mail/oauth/google/callback",
    "https://127.0.0.1:3020/api/mail/oauth/google/callback",
  ])(
    "accepts the callback through a normalized standalone Next authority: %s",
    async (requestUrl) => {
      let observedUrl = "";
      const socketPath = await startService((request, response) => {
        observedUrl = request.url ?? "";
        response.writeHead(303, {
          "Content-Length": "0",
          Location: `${PUBLIC_ORIGIN}/mail?gmail=connected`,
        });
        response.end();
      });
      const callback = new URL(requestUrl);
      callback.searchParams.set("code", "CALLBACK_CODE_SECRET");
      callback.searchParams.set("iss", "https://accounts.google.com");
      callback.searchParams.set("state", "CALLBACK_STATE_SECRET");
      const response = await proxyGmailOAuthCallback(
        new Request(callback, {
          headers: {
            Cookie: `${GMAIL_OAUTH_TRANSACTION_COOKIE}=${OPAQUE_COOKIE_VALUE}`,
          },
        }),
        { socketPath, publicOrigin: PUBLIC_ORIGIN },
      );

      expect(observedUrl).toBe(
        "/v1/oauth/gmail/callback?code=CALLBACK_CODE_SECRET&iss=https%3A%2F%2Faccounts.google.com&state=CALLBACK_STATE_SECRET",
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe(
        `${PUBLIC_ORIGIN}/mail?gmail=connected`,
      );
    },
  );

  it("clears the cookie and redirects to a stable error without query secrets", async () => {
    const socketPath = await startService((_request, response) => {
      response.writeHead(503, { "Content-Length": "0" });
      response.end();
    });
    const callback = `${PUBLIC_ORIGIN}/api/mail/oauth/google/callback?code=CALLBACK_CODE_SECRET&iss=${encodeURIComponent("https://accounts.google.com")}&state=CALLBACK_STATE_SECRET`;
    const response = await proxyGmailOAuthCallback(
      new Request(callback, {
        headers: {
          Cookie: `${GMAIL_OAUTH_TRANSACTION_COOKIE}=${OPAQUE_COOKIE_VALUE}`,
        },
      }),
      { socketPath, publicOrigin: PUBLIC_ORIGIN },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      `${PUBLIC_ORIGIN}/mail?gmail=error`,
    );
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const publicResponse = [
      response.headers.get("Location"),
      response.headers.get("Set-Cookie"),
      await response.text(),
    ].join("\n");
    expect(publicResponse).not.toContain("CALLBACK_CODE_SECRET");
    expect(publicResponse).not.toContain("CALLBACK_STATE_SECRET");
  });

  it("rejects wrong origin, duplicate callback fields and duplicate cookies", async () => {
    const deadSocket = "/tmp/brain-mail-oauth-test-never-opened.sock";
    const start = await proxyGmailOAuthStart(
      new Request(`${PUBLIC_ORIGIN}/api/mail/oauth/google/start`, {
        method: "POST",
        headers: { Origin: "https://evil.test" },
      }),
      { socketPath: deadSocket, publicOrigin: PUBLIC_ORIGIN },
    );
    expect(start.status).toBe(303);
    expect(start.headers.get("Location")).toBe(
      `${PUBLIC_ORIGIN}/mail?gmail=error`,
    );

    const callback = await proxyGmailOAuthCallback(
      new Request(
        `${PUBLIC_ORIGIN}/api/mail/oauth/google/callback?code=a&code=b&state=x`,
        {
          headers: {
            Cookie: `${GMAIL_OAUTH_TRANSACTION_COOKIE}=${OPAQUE_COOKIE_VALUE}; ${GMAIL_OAUTH_TRANSACTION_COOKIE}=${OPAQUE_COOKIE_VALUE}`,
          },
        },
      ),
      { socketPath: deadSocket, publicOrigin: PUBLIC_ORIGIN },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("Location")).toBe(
      `${PUBLIC_ORIGIN}/mail?gmail=error`,
    );
    expect(callback.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("keeps the Next route graph free of the Google secret and token endpoint", async () => {
    const sources = await Promise.all(
      [
        "app/api/mail/oauth/google/start/route.ts",
        "app/api/mail/oauth/google/callback/route.ts",
        "lib/mail/providers/gmail/public-proxy.ts",
        "lib/mail/providers/gmail/contract.ts",
      ].map((file) => readFile(path.join(process.cwd(), file), "utf8")),
    );
    const publicGraph = sources.join("\n");
    for (const forbidden of [
      "GMAIL_OAUTH_CLIENT_SECRET",
      "oauth2.googleapis.com/token",
      "GoogleGmailOAuthTokenClient",
      "readGmailOAuthConfig",
      'from "./oauth"',
    ]) {
      expect(publicGraph).not.toContain(forbidden);
    }
  });
});

async function startService(
  listener: RequestListener,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-gmail-oauth-proxy-"));
  roots.push(root);
  const socketPath = path.join(root, "mail.sock");
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return socketPath;
}

function startCookie(maxAge = 600): string {
  return `${GMAIL_OAUTH_TRANSACTION_COOKIE}=${OPAQUE_COOKIE_VALUE}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function googleAuthorizationLocation(): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("client_id", "test-client");
  url.searchParams.set("code_challenge", "test-challenge");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", "test-nonce");
  url.searchParams.set("redirect_uri", `${PUBLIC_ORIGIN}/api/mail/oauth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email gmail.modify");
  url.searchParams.set("state", "test-state");
  return url.toString();
}
