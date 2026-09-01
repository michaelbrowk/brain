import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MultiMailAccountStore } from "../../service/account-store";
import type { StoredGmailMailAccount } from "../../service/account-types";
import { GMAIL_OAUTH_SCOPES } from "./oauth";
import { GmailAccessTokenError } from "./api-types";
import { StoredGmailAccessTokenPort } from "./access-token-port";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stored Gmail access token port", () => {
  it("refreshes the selected encrypted credential, caches briefly, and wipes owned buffers", async () => {
    const credentials = await credentialDirectory();
    const observedRefreshTokens: Buffer[] = [];
    const store = storeFixture(observedRefreshTokens);
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: "fresh-access-token",
        expires_in: 3600,
        id_token: "header.payload.signature",
        future_extension: { ignored: true },
        scope: GMAIL_OAUTH_SCOPES.join(" "),
        token_type: "Bearer",
      }),
    );
    const port = new StoredGmailAccessTokenPort({
      accountId: ACCOUNT_ID,
      store,
      environment: {
        CREDENTIALS_DIRECTORY: credentials,
        GMAIL_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
      },
      request,
      now: () => 1000,
    });

    const first = await port.getAccessToken(
      { forceRefresh: false },
      new AbortController().signal,
    );
    const second = await port.getAccessToken(
      { forceRefresh: false },
      new AbortController().signal,
    );
    expect(first.toString("utf8")).toBe("fresh-access-token");
    expect(second.toString("utf8")).toBe("fresh-access-token");
    expect(request).toHaveBeenCalledTimes(1);
    expect(observedRefreshTokens).toHaveLength(1);
    expect(observedRefreshTokens[0].every((byte) => byte === 0)).toBe(true);
    first.fill(0);
    second.fill(0);
    port.destroy();
  });

  it("maps invalid_grant and marks only that account for reconnect", async () => {
    const credentials = await credentialDirectory();
    const store = storeFixture();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: "invalid_grant" }, 400),
    );
    const port = new StoredGmailAccessTokenPort({
      accountId: ACCOUNT_ID,
      store,
      environment: {
        CREDENTIALS_DIRECTORY: credentials,
        GMAIL_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
      },
      request,
      now: () => 2000,
    });

    await expect(
      port.getAccessToken({ forceRefresh: false }, new AbortController().signal),
    ).rejects.toEqual(new GmailAccessTokenError("invalid_grant"));
    expect(store.updateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: "gmail",
        status: "reauth_required",
        updatedAt: 2000,
      }),
      expect.any(AbortSignal),
    );
  });

  it.each([
    { status: 429, retryAfter: "120", expectedMs: 120_000 },
    {
      status: 503,
      retryAfter: "Thu, 01 Jan 1970 00:02:01 GMT",
      expectedMs: 120_000,
    },
  ])(
    "preserves bounded Retry-After from OAuth refresh HTTP $status",
    async ({ status, retryAfter, expectedMs }) => {
      const credentials = await credentialDirectory();
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          { error: "temporarily_unavailable", private_detail: "do not leak" },
          status,
          { "Retry-After": retryAfter },
        ),
      );
      const port = new StoredGmailAccessTokenPort({
        accountId: ACCOUNT_ID,
        store: storeFixture(),
        environment: {
          CREDENTIALS_DIRECTORY: credentials,
          GMAIL_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
        },
        request,
        now: () => 1_000,
      });

      await expect(
        port.getAccessToken(
          { forceRefresh: false },
          new AbortController().signal,
        ),
      ).rejects.toEqual(
        new GmailAccessTokenError("refresh_unavailable", expectedMs),
      );
    },
  );
});

async function credentialDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-gmail-token-"));
  roots.push(root);
  await writeFile(path.join(root, "gmail-oauth-client-secret"), "test-client-secret", {
    mode: 0o600,
  });
  return root;
}

function storeFixture(observed: Buffer[] = []): MultiMailAccountStore {
  const stored = gmailAccountFixture();
  return {
    localSchemaVersion: 2,
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    countAccounts: vi.fn().mockResolvedValue(1),
    listAccounts: vi.fn().mockResolvedValue([stored]),
    readAccount: vi.fn().mockResolvedValue(stored),
    loadProvisionedAccount: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    loadGmailCredential: vi.fn(async () => {
      const refreshToken = Buffer.from("test-refresh-token");
      observed.push(refreshToken);
      return {
        stored,
        credential: Object.freeze({
          credentialVersion: 1,
          provider: "gmail",
          subject: "google-subject",
          emailAddress: "reader@example.test",
          scopes: GMAIL_OAUTH_SCOPES,
          refreshToken,
          grantedAt: 500,
        }),
      };
    }),
    deleteAccount: vi.fn().mockResolvedValue(true),
  };
}

function gmailAccountFixture(): StoredGmailMailAccount {
  return Object.freeze({
    account: Object.freeze({
      accountId: ACCOUNT_ID,
      emailAddress: "reader@example.test",
      subject: "google-subject",
      credentialRef: Object.freeze({
        id: "credential-r11111111111111111111111111111111",
        version: 1,
      }),
      connectedAt: 500,
      grantedAt: 500,
    }),
    providerKind: "gmail",
    displayName: null,
    status: "connected",
    createdAt: 500,
    updatedAt: 500,
  });
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}
