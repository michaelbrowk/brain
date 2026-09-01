import { describe, expect, it, vi } from "vitest";

import {
  GmailOAuthError,
  GmailOAuthFlow,
  GmailOAuthTransactionCodec,
  GMAIL_OAUTH_SCOPES,
  InMemoryGmailOAuthTransactionStore,
  type GmailIdTokenVerifier,
  type GmailOAuthConfig,
  type GmailOAuthGrant,
  type GmailOAuthTokenClient,
} from "./oauth";
import {
  createOptionalGmailOAuthServiceAdapter,
  GmailOAuthServiceAdapter,
  type GmailOAuthGrantSink,
  type GmailOAuthLogRecord,
} from "./service-adapter";
import { projectMailLogRecord } from "../../security";

const NOW = 1_800_000_000_000;
const CONFIG: GmailOAuthConfig = Object.freeze({
  clientId: "123456789-brainmailtest.apps.googleusercontent.com",
  clientSecret: "test-only-client-secret",
  publicOrigin: "https://brain.test",
  redirectUri: "https://brain.test/api/mail/oauth/google/callback",
});

describe("brain-mail Gmail OAuth service adapter", () => {
  it("returns the exact authorization redirect and protected transaction cookie", async () => {
    const fixture = createAdapter();
    const started = await fixture.adapter.start();

    expect(started.status).toBe(303);
    expect(new URL(started.location).origin).toBe("https://accounts.google.com");
    expect(started.setCookie).toMatch(
      /^__Host-brain-gmail-oauth=[A-Za-z0-9_-]+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(started.setCookie).not.toContain("Domain=");
  });

  it("persists once, redirects to Mail and wipes both token buffers", async () => {
    let observed: GmailOAuthGrant | null = null;
    let copiedAccess = "";
    let copiedRefresh = "";
    const sink: GmailOAuthGrantSink = {
      isReady: () => true,
      validateReconnectTarget: vi.fn(async () => undefined),
      persistGrant: vi.fn(async (grant, targetAccountId) => {
        expect(targetAccountId).toBeNull();
        observed = grant;
        copiedAccess = grant.accessToken.toString("utf8");
        copiedRefresh = grant.refreshToken.toString("utf8");
      }),
    };
    const fixture = createAdapter(sink);
    const started = await fixture.adapter.start();
    const authorization = new URL(started.location);
    const transactionCookie = started.setCookie.split(";", 1)[0];
    const result = await fixture.adapter.callback(
      callbackQuery(`code=test-code&state=${authorization.searchParams.get("state")}`),
      `brain-session=session-cookie; ${transactionCookie}; brain-theme=dark`,
      new AbortController().signal,
    );

    expect(result).toEqual({
      status: 303,
      location: "https://brain.test/mail?gmail=connected",
      setCookie:
        "__Host-brain-gmail-oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    });
    expect(copiedAccess).toBe("test-access-token");
    expect(copiedRefresh).toBe("test-refresh-token");
    expect(observed).not.toBeNull();
    expect((observed as unknown as GmailOAuthGrant).accessToken.every((byte) => byte === 0)).toBe(true);
    expect((observed as unknown as GmailOAuthGrant).refreshToken.every((byte) => byte === 0)).toBe(true);
    expect(sink.persistGrant).toHaveBeenCalledTimes(1);

    const replay = await fixture.adapter.callback(
      callbackQuery(`code=test-code&state=${authorization.searchParams.get("state")}`),
      started.setCookie.split(";", 1)[0],
      new AbortController().signal,
    );
    expect(replay.location).toBe("https://brain.test/mail?gmail=error");
    expect(sink.persistGrant).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicated transaction cookie among unrelated Brain cookies", async () => {
    const fixture = createAdapter();
    const started = await fixture.adapter.start();
    const authorization = new URL(started.location);
    const transactionCookie = started.setCookie.split(";", 1)[0];
    const result = await fixture.adapter.callback(
      callbackQuery(`code=test-code&state=${authorization.searchParams.get("state")}`),
      `brain-session=session-cookie; ${transactionCookie}; ${transactionCookie}`,
      new AbortController().signal,
    );

    expect(result.location).toBe("https://brain.test/mail?gmail=error");
    expect(fixture.tokenClient.exchange).not.toHaveBeenCalled();
    expect(fixture.sink.persistGrant).not.toHaveBeenCalled();
  });

  it("maps consent denial to cancelled without calling the sink", async () => {
    const fixture = createAdapter();
    const started = await fixture.adapter.start();
    const state = new URL(started.location).searchParams.get("state");
    const result = await fixture.adapter.callback(
      callbackQuery(
        `error=access_denied&error_description=provider-detail&state=${state}`,
      ),
      started.setCookie.split(";", 1)[0],
      new AbortController().signal,
    );

    expect(result.location).toBe("https://brain.test/mail?gmail=cancelled");
    expect(result.location).not.toContain("provider-detail");
    expect(fixture.sink.persistGrant).not.toHaveBeenCalled();
  });

  it("validates and persists the reconnect target bound into the transaction", async () => {
    const accountId = "account-a11111111111111111111111111111111";
    const sink: GmailOAuthGrantSink = {
      isReady: () => true,
      validateReconnectTarget: vi.fn(async () => undefined),
      persistGrant: vi.fn(async () => undefined),
    };
    const fixture = createAdapter(sink);
    const started = await fixture.adapter.start(accountId);
    const state = new URL(started.location).searchParams.get("state");
    const result = await fixture.adapter.callback(
      callbackQuery(`code=test-code&state=${state}`),
      started.setCookie.split(";", 1)[0],
      new AbortController().signal,
    );

    expect(result.location).toBe("https://brain.test/mail?gmail=connected");
    expect(sink.validateReconnectTarget).toHaveBeenCalledWith(accountId);
    expect(sink.persistGrant).toHaveBeenCalledWith(
      expect.any(Object),
      accountId,
      expect.any(AbortSignal),
    );
  });

  it("fails closed before start when persistence is unavailable", async () => {
    const fixture = createAdapter({
      isReady: () => false,
      validateReconnectTarget: vi.fn(),
      persistGrant: vi.fn(),
    });
    await expect(fixture.adapter.start()).rejects.toEqual(
      new GmailOAuthError("gmail_oauth_unavailable"),
    );
    expect(fixture.tokenClient.exchange).not.toHaveBeenCalled();
  });

  it("disables absent Gmail config but fails startup for an incomplete opt-in", async () => {
    const sink = createAdapter().sink;
    await expect(
      createOptionalGmailOAuthServiceAdapter(
        {
          GMAIL_OAUTH_CLIENT_ID:
            "123456789-brainmailtest.apps.googleusercontent.com",
          BRAIN_PUBLIC_ORIGIN: "https://brain.test",
          CREDENTIALS_DIRECTORY: "/missing/brain-mail-credentials",
        },
        sink,
        () => NOW,
      ),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_unavailable"));
    await expect(
      createOptionalGmailOAuthServiceAdapter(
        { BRAIN_PUBLIC_ORIGIN: "https://brain.test" },
        sink,
        () => NOW,
      ),
    ).resolves.toBeUndefined();
  });

  it("wipes a grant and returns a safe redirect if persistence fails", async () => {
    let observed: GmailOAuthGrant | null = null;
    const sink: GmailOAuthGrantSink = {
      isReady: () => true,
      validateReconnectTarget: vi.fn(async () => undefined),
      persistGrant: vi.fn(async (grant) => {
        observed = grant;
        throw new Error("storage detail that must not escape");
      }),
    };
    const fixture = createAdapter(sink);
    const started = await fixture.adapter.start();
    const state = new URL(started.location).searchParams.get("state");
    const result = await fixture.adapter.callback(
      callbackQuery(`code=test-code&state=${state}`),
      started.setCookie.split(";", 1)[0],
      new AbortController().signal,
    );

    expect(result.location).toBe("https://brain.test/mail?gmail=error");
    expect(JSON.stringify(result)).not.toContain("storage detail");
    expect((observed as unknown as GmailOAuthGrant).accessToken.every((byte) => byte === 0)).toBe(true);
    expect((observed as unknown as GmailOAuthGrant).refreshToken.every((byte) => byte === 0)).toBe(true);
  });

  it("does not consume a callback while the sink is unavailable", async () => {
    let ready = true;
    const sink: GmailOAuthGrantSink = {
      isReady: () => ready,
      validateReconnectTarget: vi.fn(async () => undefined),
      persistGrant: vi.fn(async () => undefined),
    };
    const fixture = createAdapter(sink);
    const started = await fixture.adapter.start();
    const state = new URL(started.location).searchParams.get("state");
    ready = false;
    const unavailable = await fixture.adapter.callback(
      callbackQuery(`code=test-code&state=${state}`),
      started.setCookie.split(";", 1)[0],
      new AbortController().signal,
    );
    expect(unavailable.location).toBe("https://brain.test/mail?gmail=error");
    expect(fixture.tokenClient.exchange).not.toHaveBeenCalled();
  });

  it("emits exactly one connected diagnostic record without an errorCode", async () => {
    const fixture = createAdapter();
    const started = await fixture.adapter.start();
    const state = new URL(started.location).searchParams.get("state");
    const result = await fixture.adapter.callback(
      callbackQuery(`code=test-code&state=${state}`),
      started.setCookie.split(";", 1)[0],
      new AbortController().signal,
    );

    expect(result.location).toBe("https://brain.test/mail?gmail=connected");
    expectDiagnosticRecords(fixture.logRecords, [
      { event: "gmail_oauth_callback", phase: "connected" },
    ]);
    expect(Object.keys(fixture.logRecords[0])).toEqual(["event", "phase"]);
    expect("errorCode" in fixture.logRecords[0]).toBe(false);
  });

  it("logs phase unavailable when the sink is not ready", async () => {
    const fixture = createAdapter({
      isReady: () => false,
      validateReconnectTarget: vi.fn(),
      persistGrant: vi.fn(),
    });
    const result = await fixture.adapter.callback(
      callbackQuery("code=test-code&state=any"),
      "__Host-brain-gmail-oauth=AAAAAAAAAAAAAAAA",
      new AbortController().signal,
    );

    expect(result.location).toBe("https://brain.test/mail?gmail=error");
    expectDiagnosticRecords(fixture.logRecords, [
      {
        event: "gmail_oauth_callback",
        phase: "unavailable",
        errorCode: "gmail_oauth_unavailable",
      },
    ]);
  });

  it("maps request-stage failures to phase request", async () => {
    const badQuery = createAdapter();
    await badQuery.adapter.callback(
      "code=missing-question-mark",
      "__Host-brain-gmail-oauth=AAAAAAAAAAAAAAAA",
      new AbortController().signal,
    );
    expectDiagnosticRecords(badQuery.logRecords, [
      {
        event: "gmail_oauth_callback",
        phase: "request",
        errorCode: "gmail_oauth_request_invalid",
      },
    ]);

    const badCookie = createAdapter();
    await badCookie.adapter.callback(
      callbackQuery("code=test-code&state=any"),
      undefined,
      new AbortController().signal,
    );
    expectDiagnosticRecords(badCookie.logRecords, [
      {
        event: "gmail_oauth_callback",
        phase: "request",
        errorCode: "gmail_oauth_state_invalid",
      },
    ]);
  });

  it("maps exchange-stage transaction and provider failures to phase exchange", async () => {
    const cases = [
      {
        query: "code=test-code&state=wrong-state",
        errorCode: "gmail_oauth_state_invalid",
        outcome: "error",
      },
      {
        query: "error=server_error",
        errorCode: "gmail_oauth_provider_error",
        outcome: "error",
      },
      {
        query: "error=access_denied",
        errorCode: "gmail_oauth_provider_denied",
        outcome: "cancelled",
      },
    ] as const;
    for (const testCase of cases) {
      const fixture = createAdapter();
      const started = await fixture.adapter.start();
      const state = new URL(started.location).searchParams.get("state");
      const query = testCase.query.includes("state=")
        ? testCase.query
        : `${testCase.query}&state=${state}`;
      const result = await fixture.adapter.callback(
        callbackQuery(query),
        started.setCookie.split(";", 1)[0],
        new AbortController().signal,
      );

      expect(result.location).toBe(
        `https://brain.test/mail?gmail=${testCase.outcome}`,
      );
      expectDiagnosticRecords(fixture.logRecords, [
        {
          event: "gmail_oauth_callback",
          phase: "exchange",
          errorCode: testCase.errorCode,
        },
      ]);
    }
  });

  it("maps token, scope and identity failures to phase exchange", async () => {
    const cases = [
      {
        errorCode: "gmail_oauth_token_invalid",
        overrides: {
          tokenClient: {
            exchange: vi.fn(async () => {
              throw new GmailOAuthError("gmail_oauth_token_invalid");
            }),
          },
        },
      },
      {
        errorCode: "gmail_oauth_scope_invalid",
        overrides: {
          tokenClient: {
            exchange: vi.fn(async () => ({
              accessToken: Buffer.from("test-access-token"),
              refreshToken: Buffer.from("test-refresh-token"),
              expiresInSeconds: 3_600,
              idToken: "test-id-token",
              scopes: ["openid", "email"] as readonly string[],
            })),
          },
        },
      },
      {
        errorCode: "gmail_oauth_identity_invalid",
        overrides: {
          idTokenVerifier: {
            verify: vi.fn(async () => {
              throw new GmailOAuthError("gmail_oauth_identity_invalid");
            }),
          },
        },
      },
    ] as const;
    for (const testCase of cases) {
      const fixture = createAdapter(undefined, testCase.overrides);
      const started = await fixture.adapter.start();
      const state = new URL(started.location).searchParams.get("state");
      const result = await fixture.adapter.callback(
        callbackQuery(`code=test-code&state=${state}`),
        started.setCookie.split(";", 1)[0],
        new AbortController().signal,
      );

      expect(result.location).toBe("https://brain.test/mail?gmail=error");
      expect(fixture.sink.persistGrant).not.toHaveBeenCalled();
      expectDiagnosticRecords(fixture.logRecords, [
        {
          event: "gmail_oauth_callback",
          phase: "exchange",
          errorCode: testCase.errorCode,
        },
      ]);
    }
  });

  it("maps a persistence failure to phase persist with grant_persist_failed", async () => {
    const sink: GmailOAuthGrantSink = {
      isReady: () => true,
      validateReconnectTarget: vi.fn(async () => undefined),
      persistGrant: vi.fn(async () => {
        throw new Error("storage detail that must not escape");
      }),
    };
    const fixture = createAdapter(sink);
    const started = await fixture.adapter.start();
    const state = new URL(started.location).searchParams.get("state");
    const result = await fixture.adapter.callback(
      callbackQuery(`code=test-code&state=${state}`),
      started.setCookie.split(";", 1)[0],
      new AbortController().signal,
    );

    expect(result.location).toBe("https://brain.test/mail?gmail=error");
    expectDiagnosticRecords(fixture.logRecords, [
      {
        event: "gmail_oauth_callback",
        phase: "persist",
        errorCode: "grant_persist_failed",
      },
    ]);
    expect(JSON.stringify(fixture.logRecords)).not.toContain("storage detail");
  });

  it("drops hostile token-like fields at the mail log projector", () => {
    const projected = projectMailLogRecord({
      event: "gmail_oauth_callback",
      phase: "exchange",
      errorCode: "gmail_oauth_token_invalid",
      code: "4/hostile-authorization-code",
      state: "hostile-state-value",
      nonce: "hostile-nonce-value",
      cookie: "__Host-brain-gmail-oauth=hostile-cookie",
      accessToken: "ya29.hostile-access-token",
      refreshToken: "1//hostile-refresh-token",
      idToken: "hostile.id.token",
      clientSecret: "hostile-client-secret",
      emailAddress: "person@gmail.com",
      subject: "google-subject-1",
      callbackUrl:
        "https://brain.test/api/mail/oauth/google/callback?code=hostile",
    });

    expect(projected).not.toBeNull();
    expect(Object.keys(projected ?? {})).toEqual(["event", "phase", "errorCode"]);
    expect(projected).toEqual({
      event: "gmail_oauth_callback",
      phase: "exchange",
      errorCode: "gmail_oauth_token_invalid",
    });
    expect(JSON.stringify(projected)).not.toContain("hostile");
    expect(JSON.stringify(projected)).not.toContain("gmail.com");
  });
});

function callbackQuery(parameters: string): string {
  return `?${parameters}&iss=${encodeURIComponent("https://accounts.google.com")}`;
}

function createAdapter(
  sink?: GmailOAuthGrantSink,
  overrides?: {
    readonly tokenClient?: GmailOAuthTokenClient;
    readonly idTokenVerifier?: GmailIdTokenVerifier;
  },
) {
  const tokenClient: GmailOAuthTokenClient = overrides?.tokenClient ?? {
    exchange: vi.fn(async () => ({
      accessToken: Buffer.from("test-access-token"),
      refreshToken: Buffer.from("test-refresh-token"),
      expiresInSeconds: 3_600,
      idToken: "test-id-token",
      scopes: GMAIL_OAUTH_SCOPES,
    })),
  };
  const idTokenVerifier: GmailIdTokenVerifier = overrides?.idTokenVerifier ?? {
    verify: vi.fn(async () => ({
      subject: "google-subject-1",
      emailAddress: "person@gmail.com",
    })),
  };
  const flow = new GmailOAuthFlow(
    CONFIG,
    new GmailOAuthTransactionCodec(Buffer.alloc(32, 11)),
    new InMemoryGmailOAuthTransactionStore(),
    tokenClient,
    idTokenVerifier,
    () => NOW,
  );
  const selectedSink =
    sink ??
    ({
      isReady: () => true,
      validateReconnectTarget: vi.fn(async () => undefined),
      persistGrant: vi.fn(async () => undefined),
    } satisfies GmailOAuthGrantSink);
  const logRecords: GmailOAuthLogRecord[] = [];
  return {
    tokenClient,
    sink: selectedSink,
    logRecords,
    adapter: new GmailOAuthServiceAdapter(flow, selectedSink, () => NOW, (record) => {
      logRecords.push(record);
    }),
  };
}

function expectDiagnosticRecords(
  records: readonly GmailOAuthLogRecord[],
  expected: readonly GmailOAuthLogRecord[],
): void {
  expect(records).toEqual(expected);
  for (const record of records) {
    expect(
      Object.keys(record).every((key) =>
        ["event", "phase", "errorCode"].includes(key),
      ),
    ).toBe(true);
  }
}
