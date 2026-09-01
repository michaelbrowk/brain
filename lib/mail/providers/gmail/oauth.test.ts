import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  GmailOAuthError,
  GmailOAuthFlow,
  GmailOAuthTransactionCodec,
  GoogleGmailOAuthTokenClient,
  GMAIL_OAUTH_SCOPES,
  InMemoryGmailOAuthTransactionStore,
  readGmailOAuthConfig,
  validateGoogleIdentityClaims,
  type GmailIdTokenVerifier,
  type GmailOAuthConfig,
  type GmailOAuthTokenClient,
  type GoogleTokenGrant,
} from "./oauth";

const NOW = 1_800_000_000_000;
const CLIENT_ID =
  "123456789-brainmailtest.apps.googleusercontent.com";
const CONFIG: GmailOAuthConfig = Object.freeze({
  clientId: CLIENT_ID,
  clientSecret: "test-only-client-secret",
  publicOrigin: "https://brain.test",
  redirectUri: "https://brain.test/api/mail/oauth/google/callback",
});

describe("Gmail OAuth transaction flow", () => {
  it("starts a top-level offline flow with PKCE, state, nonce and exact scopes", () => {
    const fixture = createFlow();
    const started = fixture.flow.start();
    const authorization = new URL(started.authorizationUrl);

    expect(authorization.origin + authorization.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(authorization.searchParams.get("prompt")).toBe(
      "consent select_account",
    );
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      CONFIG.redirectUri,
    );
    expect(authorization.searchParams.get("scope")).toBe(
      GMAIL_OAUTH_SCOPES.join(" "),
    );
    expect(authorization.searchParams.get("state")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(authorization.searchParams.get("nonce")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(started.transactionCookieValue).not.toContain(
      authorization.searchParams.get("state")!,
    );
    expect(started.transactionCookieValue).not.toContain(
      authorization.searchParams.get("nonce")!,
    );
  });

  it("binds the authorization code to PKCE and returns wipeable token buffers", async () => {
    const fixture = createFlow();
    const started = fixture.flow.start();
    const authorization = new URL(started.authorizationUrl);
    const completion = await fixture.flow.complete(
      callbackUrl(authorization.searchParams.get("state")!),
      started.transactionCookieValue,
      new AbortController().signal,
    );

    expect(fixture.tokenClient.exchange).toHaveBeenCalledTimes(1);
    const exchange = vi.mocked(fixture.tokenClient.exchange).mock.calls[0][0];
    expect(exchange.code).toBe("test-authorization-code");
    expect(exchange.config.redirectUri).toBe(CONFIG.redirectUri);
    expect(exchange.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(
      createHash("sha256")
        .update(exchange.codeVerifier, "ascii")
        .digest("base64url"),
    ).toBe(authorization.searchParams.get("code_challenge"));
    expect(fixture.idTokenVerifier.verify).toHaveBeenCalledWith(
      "test-id-token",
      {
        clientId: CLIENT_ID,
        nonce: authorization.searchParams.get("nonce"),
      },
      expect.any(AbortSignal),
    );
    expect(completion.targetAccountId).toBeNull();
    expect(completion.grant).toMatchObject({
      provider: "gmail",
      subject: "google-subject-1",
      emailAddress: "person@gmail.com",
      accessTokenExpiresAt: NOW + 3_600_000,
      grantedAt: NOW,
    });
    expect(completion.grant.accessToken.toString("utf8")).toBe("test-access-token");
    expect(completion.grant.refreshToken.toString("utf8")).toBe("test-refresh-token");
    completion.grant.accessToken.fill(0);
    completion.grant.refreshToken.fill(0);
  });

  it("keeps a reconnect target inside the encrypted one-time transaction", async () => {
    const fixture = createFlow();
    const accountId = "account-a11111111111111111111111111111111";
    const started = fixture.flow.start(accountId);
    expect(started.transactionCookieValue).not.toContain(accountId);
    const authorization = new URL(started.authorizationUrl);
    const completion = await fixture.flow.complete(
      callbackUrl(authorization.searchParams.get("state")!),
      started.transactionCookieValue,
      new AbortController().signal,
    );

    expect(completion.targetAccountId).toBe(accountId);
    completion.grant.accessToken.fill(0);
    completion.grant.refreshToken.fill(0);
    expect(() => fixture.flow.start("wrong-account")).toThrow(
      new GmailOAuthError("gmail_oauth_request_invalid"),
    );
  });

  it("consumes a transaction once and rejects a replay before token exchange", async () => {
    const fixture = createFlow();
    const started = fixture.flow.start();
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const callback = callbackUrl(state);
    const first = await fixture.flow.complete(
      callback,
      started.transactionCookieValue,
      new AbortController().signal,
    );
    first.grant.accessToken.fill(0);
    first.grant.refreshToken.fill(0);

    await expect(
      fixture.flow.complete(
        callback,
        started.transactionCookieValue,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_state_invalid"));
    expect(fixture.tokenClient.exchange).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong state, redirect, callback fields and expired transactions", async () => {
    const wrongState = createFlow();
    const wrongStateStart = wrongState.flow.start();
    await expect(
      wrongState.flow.complete(
        callbackUrl("A".repeat(43)),
        wrongStateStart.transactionCookieValue,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_state_invalid"));

    const wrongRedirect = createFlow();
    const wrongRedirectStart = wrongRedirect.flow.start();
    const state = new URL(wrongRedirectStart.authorizationUrl).searchParams.get(
      "state",
    )!;
    await expect(
      wrongRedirect.flow.complete(
        `https://evil.test/api/mail/oauth/google/callback?code=x&state=${state}`,
        wrongRedirectStart.transactionCookieValue,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_request_invalid"));
    await expect(
      wrongRedirect.flow.complete(
        `${callbackUrl(state)}&code=duplicate`,
        wrongRedirectStart.transactionCookieValue,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_request_invalid"));

    let clock = NOW;
    const expired = createFlow(() => clock);
    const expiredStart = expired.flow.start();
    clock += 10 * 60_000;
    await expect(
      expired.flow.complete(
        callbackUrl(
          new URL(expiredStart.authorizationUrl).searchParams.get("state")!,
        ),
        expiredStart.transactionCookieValue,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_state_invalid"));
  });

  it("rejects missing or broader scopes before accepting an identity", async () => {
    for (const scopes of [
      ["openid", "email"],
      [...GMAIL_OAUTH_SCOPES, "https://mail.google.com/"],
    ]) {
      const fixture = createFlow(undefined, tokenGrant({ scopes }));
      const started = fixture.flow.start();
      await expect(
        fixture.flow.complete(
          callbackUrl(
            new URL(started.authorizationUrl).searchParams.get("state")!,
          ),
          started.transactionCookieValue,
          new AbortController().signal,
        ),
      ).rejects.toEqual(new GmailOAuthError("gmail_oauth_scope_invalid"));
      expect(fixture.idTokenVerifier.verify).not.toHaveBeenCalled();
    }
  });

  it("accepts Google's equivalent email scope in a real token shape", async () => {
    for (const scopes of [
      [
        "openid",
        "email",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
    ]) {
      const fixture = createFlow(undefined, tokenGrant({ scopes }));
      const started = fixture.flow.start();
      const completion = await fixture.flow.complete(
        callbackUrl(new URL(started.authorizationUrl).searchParams.get("state")!),
        started.transactionCookieValue,
        new AbortController().signal,
      );
      expect(completion.grant.scopes).toBe(GMAIL_OAUTH_SCOPES);
      completion.grant.accessToken.fill(0);
      completion.grant.refreshToken.fill(0);
    }
  });

  it("consumes a denied callback without exposing the provider description", async () => {
    const fixture = createFlow();
    const started = fixture.flow.start();
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const denied = `${CONFIG.redirectUri}?error=access_denied&error_description=${encodeURIComponent(
      "provider detail with authorization code-like text",
    )}&iss=${encodeURIComponent("https://accounts.google.com")}&state=${state}`;
    await expect(
      fixture.flow.complete(
        denied,
        started.transactionCookieValue,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_provider_denied"));
    await expect(
      fixture.flow.complete(
        denied,
        started.transactionCookieValue,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_state_invalid"));
    expect(fixture.tokenClient.exchange).not.toHaveBeenCalled();
  });
});

describe("Google token and identity validation", () => {
  it("requires a refresh token and exact returned scopes", async () => {
    for (const change of [
      { refresh_token: undefined },
      { scope: "openid email" },
    ]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            access_token: "test-access-token",
            expires_in: 3_600,
            id_token: "test-id-token",
            refresh_token: "test-refresh-token",
            scope: GMAIL_OAUTH_SCOPES.join(" "),
            token_type: "Bearer",
            ...change,
          },
          { headers: { "Content-Type": "application/json" } },
        ),
      );
      const client = new GoogleGmailOAuthTokenClient(request, () => NOW);
      await expect(
        client.exchange(
          {
            code: "test-code",
            codeVerifier: "v".repeat(43),
            config: CONFIG,
          },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(GmailOAuthError);
    }
  });

  it("posts the verifier and exact redirect only to Google's token endpoint", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          access_token: "test-access-token",
          expires_in: 3_600,
          id_token: "test-id-token",
          refresh_token: "test-refresh-token",
          scope: GMAIL_OAUTH_SCOPES.join(" "),
          token_type: "Bearer",
        },
        { headers: { "Content-Type": "application/json; charset=utf-8" } },
      ),
    );
    const client = new GoogleGmailOAuthTokenClient(request, () => NOW);
    const grant = await client.exchange(
      {
        code: "test-code",
        codeVerifier: "v".repeat(43),
        config: CONFIG,
      },
      new AbortController().signal,
    );

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init?.redirect).toBe("error");
    const body = init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      client_id: CLIENT_ID,
      client_secret: "test-only-client-secret",
      code: "test-code",
      code_verifier: "v".repeat(43),
      grant_type: "authorization_code",
      redirect_uri: CONFIG.redirectUri,
    });
    grant.accessToken.fill(0);
    grant.refreshToken.fill(0);
  });

  it.each([
    ["wrong issuer", { iss: "https://evil.test" }],
    ["wrong audience", { aud: "another-client" }],
    ["wrong nonce", { nonce: "another-nonce" }],
    ["unverified email", { email_verified: false }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      validateGoogleIdentityClaims(
        {
          iss: "https://accounts.google.com",
          aud: CLIENT_ID,
          nonce: "expected-nonce",
          sub: "google-subject-1",
          email: "person@gmail.com",
          email_verified: true,
          ...override,
        },
        { clientId: CLIENT_ID, nonce: "expected-nonce" },
      ),
    ).toThrow(new GmailOAuthError("gmail_oauth_identity_invalid"));
  });
});

describe("Gmail OAuth runtime inputs", () => {
  it("derives one exact HTTPS callback and decodes a 32-byte key", () => {
    const environment = {
      BRAIN_PUBLIC_ORIGIN: "https://brain.test",
      GMAIL_OAUTH_CLIENT_ID: CLIENT_ID,
    };
    expect(
      readGmailOAuthConfig(environment, Buffer.from("test-secret")),
    ).toEqual({
      clientId: CLIENT_ID,
      clientSecret: "test-secret",
      publicOrigin: "https://brain.test",
      redirectUri: CONFIG.redirectUri,
    });
  });

  it.each([
    { BRAIN_PUBLIC_ORIGIN: "http://brain.test" },
    { BRAIN_PUBLIC_ORIGIN: "https://brain.test/path" },
    { GMAIL_OAUTH_CLIENT_ID: "not-a-google-web-client" },
  ])("fails closed for invalid configuration %#", (override) => {
    expect(() =>
      readGmailOAuthConfig({
        BRAIN_PUBLIC_ORIGIN: "https://brain.test",
        GMAIL_OAUTH_CLIENT_ID: CLIENT_ID,
        ...override,
      }, Buffer.from("test-secret")),
    ).toThrow(new GmailOAuthError("gmail_oauth_unavailable"));
  });

  it("rejects an empty, multiline or non-UTF-8 client-secret credential", () => {
    for (const value of [Buffer.alloc(0), Buffer.from("secret\n"), Buffer.from([0xff])]) {
      expect(() =>
        readGmailOAuthConfig(
          {
            BRAIN_PUBLIC_ORIGIN: "https://brain.test",
            GMAIL_OAUTH_CLIENT_ID: CLIENT_ID,
          },
          value,
        ),
      ).toThrow(new GmailOAuthError("gmail_oauth_unavailable"));
    }
  });
});

function createFlow(
  now: (() => number) | undefined = () => NOW,
  grant: GoogleTokenGrant = tokenGrant(),
) {
  const tokenClient: GmailOAuthTokenClient = {
    exchange: vi.fn(async () => ({
      ...grant,
      accessToken: Buffer.from(grant.accessToken),
      refreshToken: Buffer.from(grant.refreshToken),
    })),
  };
  const idTokenVerifier: GmailIdTokenVerifier = {
    verify: vi.fn(async () => ({
      subject: "google-subject-1",
      emailAddress: "person@gmail.com",
    })),
  };
  const codec = new GmailOAuthTransactionCodec(Buffer.alloc(32, 11));
  const store = new InMemoryGmailOAuthTransactionStore();
  return {
    tokenClient,
    idTokenVerifier,
    flow: new GmailOAuthFlow(
      CONFIG,
      codec,
      store,
      tokenClient,
      idTokenVerifier,
      now,
    ),
  };
}

function tokenGrant(
  override: Partial<GoogleTokenGrant> = {},
): GoogleTokenGrant {
  return {
    accessToken: Buffer.from("test-access-token"),
    refreshToken: Buffer.from("test-refresh-token"),
    expiresInSeconds: 3_600,
    idToken: "test-id-token",
    scopes: GMAIL_OAUTH_SCOPES,
    ...override,
  };
}

function callbackUrl(state: string): string {
  const callback = new URL(CONFIG.redirectUri);
  callback.searchParams.set("code", "test-authorization-code");
  callback.searchParams.set("iss", "https://accounts.google.com");
  callback.searchParams.set("state", state);
  return callback.toString();
}
