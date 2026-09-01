import { describe, expect, it, vi } from "vitest";

import type {
  MailSendProviderHooks,
  MailSendProviderMessage,
} from "../../service/outbound";
import {
  GmailAccessTokenError,
  type GmailAccessTokenPort,
} from "./api-types";
import {
  GmailSendAdapter,
  MultiAccountGmailSendAdapter,
} from "./send-adapter";

const SECOND_ACCOUNT_ID = `account-a${"2".repeat(32)}`;

describe("Gmail send adapter", () => {
  it("submits canonical base64url raw mail and preserves the reply thread", async () => {
    const events: string[] = [];
    const tokens: Buffer[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      events.push("request");
      const url = new URL(String(input));
      expect(url.origin).toBe("https://gmail.googleapis.com");
      expect(url.pathname).toBe("/gmail/v1/users/me/messages/send");
      expect(url.searchParams.get("fields")).toBe("id,threadId");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer cached-access-token",
      );
      const body = JSON.parse(String(init?.body)) as {
        raw: string;
        threadId: string;
      };
      expect(body.threadId).toBe("gmail-thread-parent");
      expect(Buffer.from(body.raw, "base64url")).toEqual(message().rawRfc2822);
      return jsonResponse({
        id: "gmail-message-reply",
        threadId: "gmail-thread-parent",
      });
    });
    const adapter = new GmailSendAdapter({
      tokenPort: tokenPort(tokens, events),
      request,
    });

    const outcome = await adapter.send(
      message({ providerThreadId: "gmail-thread-parent" }),
      hooks(events),
      context(),
    );

    expect(outcome).toEqual({
      kind: "accepted",
      providerMessageId: "gmail-message-reply",
      providerThreadId: "gmail-thread-parent",
    });
    expect(events).toEqual(["token:false", "barrier", "request"]);
    expect(tokens.every((token) => token.every((byte) => byte === 0))).toBe(true);
  });

  it("refreshes exactly once after 401 and wipes both access tokens", async () => {
    const events: string[] = [];
    const tokens: Buffer[] = [];
    const authorizations: string[] = [];
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      return authorizations.length === 1
        ? jsonResponse({ error: {} }, { status: 401 })
        : jsonResponse({ id: "gmail-message-1", threadId: "gmail-thread-1" });
    });
    const adapter = new GmailSendAdapter({
      tokenPort: tokenPort(tokens, events),
      request,
    });

    const outcome = await adapter.send(message(), hooks(events), context());

    expect(outcome.kind).toBe("accepted");
    expect(events).toEqual(["token:false", "barrier", "token:true"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(authorizations).toEqual([
      "Bearer cached-access-token",
      "Bearer fresh-access-token",
    ]);
    expect(events.filter((event) => event === "barrier")).toHaveLength(1);
    expect(tokens).toHaveLength(2);
    expect(tokens.every((token) => token.every((byte) => byte === 0))).toBe(true);
  });

  it("does not mark delivery risk when the first token cannot be loaded", async () => {
    const barrier = vi.fn(async () => undefined);
    const request = vi.fn<typeof fetch>();
    const adapter = new GmailSendAdapter({
      tokenPort: {
        getAccessToken: vi.fn(async () => {
          throw new GmailAccessTokenError("invalid_grant");
        }),
      },
      request,
    });

    await expect(adapter.send(message(), { beforeDelivery: barrier }, context())).resolves.toEqual({
      kind: "rejected",
      errorCode: "mail_send_account_reauth_required",
    });
    expect(barrier).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a temporary token outage retryable before delivery", async () => {
    const barrier = vi.fn(async () => undefined);
    const request = vi.fn<typeof fetch>();
    const adapter = new GmailSendAdapter({
      tokenPort: {
        getAccessToken: vi.fn(async () => {
          throw new GmailAccessTokenError("refresh_unavailable", 90_000);
        }),
      },
      request,
    });

    await expect(
      adapter.send(message(), { beforeDelivery: barrier }, context()),
    ).resolves.toEqual({
      kind: "retryable_rejection",
      errorCode: "mail_send_service_unavailable",
      retryAfterMs: 90_000,
    });
    expect(barrier).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "transport loss",
      response: () => Promise.reject(new Error("socket included a secret")),
    },
    {
      name: "provider 5xx",
      response: () =>
        Promise.resolve(jsonResponse({ detail: "private" }, { status: 503 })),
    },
    {
      name: "malformed success",
      response: () =>
        Promise.resolve(
          jsonResponse({ id: "other", threadId: "wrong-thread" }),
        ),
    },
  ])("returns delivery_unknown after $name", async ({ response }) => {
    const adapter = new GmailSendAdapter({
      tokenPort: tokenPort(),
      request: vi.fn<typeof fetch>().mockImplementation(response),
    });

    const outcome = await adapter.send(
      message({ providerThreadId: "gmail-thread-parent" }),
      hooks(),
      context(),
    );

    expect(outcome).toEqual({
      kind: "delivery_unknown",
      errorCode: "mail_send_service_unavailable",
    });
    expect(JSON.stringify(outcome)).not.toMatch(/secret|private|wrong-thread/);
  });

  it.each([
    [401, "mail_send_account_reauth_required"],
    [403, "mail_send_account_reauth_required"],
    [404, "mail_send_request_invalid"],
  ])("maps a definite HTTP %i response to %s", async (status, errorCode) => {
    const request =
      status === 401
        ? vi
            .fn<typeof fetch>()
            .mockResolvedValue(jsonResponse({ error: {} }, { status }))
        : vi
            .fn<typeof fetch>()
            .mockResolvedValue(jsonResponse({ error: {} }, { status }));
    const adapter = new GmailSendAdapter({
      tokenPort: tokenPort(),
      request,
    });

    const outcome = await adapter.send(message(), hooks(), context());

    expect(outcome).toEqual({ kind: "rejected", errorCode });
    expect(request).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
  });

  it("keeps a rate-limited request retryable and respects Retry-After", async () => {
    const adapter = new GmailSendAdapter({
      tokenPort: tokenPort(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          { error: {} },
          { status: 429, headers: { "Retry-After": "120" } },
        ),
      ),
    });

    await expect(
      adapter.send(message(), hooks(), context()),
    ).resolves.toEqual({
      kind: "retryable_rejection",
      errorCode: "mail_send_rate_limited",
      retryAfterMs: 120_000,
    });
  });

  it.each([
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "quotaExceeded",
  ])("keeps Gmail 403 %s retryable", async (reason) => {
    const adapter = new GmailSendAdapter({
      tokenPort: tokenPort(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          { error: { errors: [{ reason }] } },
          { status: 403, headers: { "Retry-After": "45" } },
        ),
      ),
    });

    await expect(
      adapter.send(message(), hooks(), context()),
    ).resolves.toEqual({
      kind: "retryable_rejection",
      errorCode: "mail_send_rate_limited",
      retryAfterMs: 45_000,
    });
  });

  it("keeps a Gmail 403 permission failure terminal", async () => {
    const adapter = new GmailSendAdapter({
      tokenPort: tokenPort(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          { error: { errors: [{ reason: "insufficientPermissions" }] } },
          { status: 403 },
        ),
      ),
    });

    await expect(
      adapter.send(message(), hooks(), context()),
    ).resolves.toEqual({
      kind: "rejected",
      errorCode: "mail_send_account_reauth_required",
    });
  });

  it("rejects an unsafe provider thread before loading a token", async () => {
    const port = tokenPort();
    const adapter = new GmailSendAdapter({
      tokenPort: port,
      request: vi.fn<typeof fetch>(),
    });
    await expect(
      adapter.send(
        message({ providerThreadId: "bad/thread" }),
        hooks(),
        context(),
      ),
    ).rejects.toThrow(/invalid/i);
    expect(port.getAccessToken).not.toHaveBeenCalled();
  });
});

describe("multi-account Gmail send adapter", () => {
  it("binds each message to its own short-lived account token lease", async () => {
    const created: string[] = [];
    const destroyed: string[] = [];
    const authorizations: string[] = [];
    const adapter = new MultiAccountGmailSendAdapter({
      createTokenLease: (accountId) => {
        created.push(accountId);
        return {
          tokenPort: {
            getAccessToken: vi.fn(async () =>
              Buffer.from(`token-${accountId.slice(-1)}`),
            ),
          },
          destroy: vi.fn(() => destroyed.push(accountId)),
        };
      },
      request: vi.fn<typeof fetch>(async (_input, init) => {
        const authorization =
          new Headers(init?.headers).get("Authorization") ?? "";
        authorizations.push(authorization);
        const suffix = authorization.endsWith("1") ? "1" : "2";
        return jsonResponse({
          id: `gmail-message-${suffix}`,
          threadId: `gmail-thread-${suffix}`,
        });
      }),
    });

    await expect(adapter.send(message(), hooks(), context())).resolves.toMatchObject({
      kind: "accepted",
      providerMessageId: "gmail-message-1",
    });
    await expect(
      adapter.send(
        message({ accountId: SECOND_ACCOUNT_ID }),
        hooks(),
        context(),
      ),
    ).resolves.toMatchObject({
      kind: "accepted",
      providerMessageId: "gmail-message-2",
    });

    expect(created).toEqual([message().accountId, SECOND_ACCOUNT_ID]);
    expect(destroyed).toEqual(created);
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"]);
    await adapter.close();
  });

  it("aborts and drains an active account lease before invalidation resolves", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const destroy = vi.fn();
    let requestCount = 0;
    const adapter = new MultiAccountGmailSendAdapter({
      createTokenLease: () => ({ tokenPort: tokenPort(), destroy }),
      request: vi.fn<typeof fetch>(async (_input, init) => {
        requestCount += 1;
        if (requestCount > 1) {
          return jsonResponse({
            id: "gmail-message-restored",
            threadId: "gmail-thread-restored",
          });
        }
        requestStarted();
        return await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      }),
    });

    const sending = adapter.send(message(), hooks(), context());
    await started;
    await adapter.invalidateAccount(message().accountId);

    await expect(sending).resolves.toEqual({
      kind: "delivery_unknown",
      errorCode: "mail_send_service_unavailable",
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    await expect(
      adapter.send(message(), hooks(), context()),
    ).rejects.toEqual(new GmailAccessTokenError("refresh_unavailable"));
    await adapter.restoreInvalidatedAccount(message().accountId);
    await expect(
      adapter.send(message(), hooks(), context()),
    ).resolves.toMatchObject({
      kind: "accepted",
      providerMessageId: "gmail-message-restored",
    });
    expect(destroy).toHaveBeenCalledTimes(2);
    await adapter.close();
  });

  it("cancels a queued account before an unrelated slow send releases the slot", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<Response>();
    const created: string[] = [];
    const request = vi.fn<typeof fetch>(async () => {
      firstStarted.resolve();
      return releaseFirst.promise;
    });
    const adapter = new MultiAccountGmailSendAdapter({
      createTokenLease: (accountId) => {
        created.push(accountId);
        return { tokenPort: tokenPort(), destroy: vi.fn() };
      },
      request,
    });

    const first = adapter.send(
      message({ accountId: SECOND_ACCOUNT_ID }),
      hooks(),
      context(),
    );
    await firstStarted.promise;
    const queued = adapter.send(message(), hooks(), context());

    await adapter.invalidateAccount(message().accountId);
    await expect(queued).rejects.toEqual(
      new GmailAccessTokenError("refresh_unavailable"),
    );
    expect(created).toEqual([SECOND_ACCOUNT_ID]);
    expect(request).toHaveBeenCalledTimes(1);

    releaseFirst.resolve(
      jsonResponse({ id: "gmail-message-2", threadId: "gmail-thread-2" }),
    );
    await expect(first).resolves.toMatchObject({ kind: "accepted" });
    await adapter.close();
  });
});

function message(
  override: Partial<MailSendProviderMessage> = {},
): MailSendProviderMessage {
  return {
    operationId: "send-00000000-0000-4000-8000-000000000001",
    accountId: `account-a${"1".repeat(32)}`,
    messageId: "<brain.1@example.com>",
    envelope: {
      from: "me@example.com",
      to: ["friend@example.net"],
      cc: [],
      bcc: [],
    },
    rawRfc2822: Buffer.from(
      "From: me@example.com\r\nTo: friend@example.net\r\n\r\nBody\r\n",
      "utf8",
    ),
    providerThreadId: null,
    ...override,
  };
}

function context() {
  return {
    deadlineAt: Date.now() + 60_000,
    signal: new AbortController().signal,
  };
}

function hooks(events: string[] = []): MailSendProviderHooks {
  return {
    beforeDelivery: vi.fn(async () => {
      events.push("barrier");
    }),
  };
}

function tokenPort(
  observed: Buffer[] = [],
  events: string[] = [],
): GmailAccessTokenPort {
  return {
    getAccessToken: vi.fn(async ({ forceRefresh }) => {
      events.push(`token:${forceRefresh}`);
      const token = Buffer.from(
        forceRefresh ? "fresh-access-token" : "cached-access-token",
      );
      observed.push(token);
      return token;
    }),
  };
}

function jsonResponse(
  value: unknown,
  init: {
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
