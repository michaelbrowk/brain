import { describe, expect, it, vi } from "vitest";

import type { MailIncomingBlobStorePort } from "../../ports";
import { MailContentSourceError } from "../../service/content-source";
import type { GmailApiClient } from "./api-client";
import { GmailContentSourceAdapter } from "./content-source-adapter";
import { GmailApiError, type GmailApiErrorCode } from "./api-types";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const DESCRIPTOR = Object.freeze({ sha256: "a".repeat(64), bytes: 3 });

describe("Gmail provider-neutral content source", () => {
  it("returns only the verified account blob descriptor", async () => {
    const store = blobStoreFixture();
    const getRawMessage = vi.fn().mockResolvedValue({
      id: "message-a",
      sizeEstimate: 3,
      descriptor: DESCRIPTOR,
    });
    const adapter = new GmailContentSourceAdapter({
      accountId: ACCOUNT_ID,
      client: { getRawMessage } as unknown as GmailApiClient,
      blobStore: store,
      now: () => 100,
    });
    const callerSignal = new AbortController().signal;

    await expect(
      adapter.fetchRaw({
        accountId: ACCOUNT_ID,
        providerMessageId: "message-a",
        signal: callerSignal,
        deadlineAt: 1_000,
      }),
    ).resolves.toEqual({ descriptor: DESCRIPTOR });
    expect(getRawMessage).toHaveBeenCalledWith(
      "message-a",
      store,
      expect.any(AbortSignal),
    );
  });

  it.each<readonly [GmailApiErrorCode, MailContentSourceError["code"]]>([
    ["gmail_reauth_required", "mail_content_source_reauth_required"],
    ["gmail_rate_limited", "mail_content_source_rate_limited"],
    ["gmail_response_invalid", "mail_content_source_invalid_response"],
    ["gmail_service_unavailable", "mail_content_source_transient"],
    ["gmail_request_timeout", "mail_content_source_transient"],
    ["gmail_permission_denied", "mail_content_source_permanent"],
    ["gmail_not_found", "mail_content_source_permanent"],
  ])("maps %s to %s", async (gmailCode, contentCode) => {
    const adapter = adapterWithFailure(new GmailApiError(gmailCode));

    await expect(
      adapter.fetchRaw({
        accountId: ACCOUNT_ID,
        providerMessageId: "message-a",
        signal: new AbortController().signal,
        deadlineAt: 1_000,
      }),
    ).rejects.toEqual(new MailContentSourceError(contentCode));
  });

  it("fails closed on a crossed account, unsafe id, expired deadline, or abort", async () => {
    const getRawMessage = vi.fn();
    const adapter = new GmailContentSourceAdapter({
      accountId: ACCOUNT_ID,
      client: { getRawMessage } as unknown as GmailApiClient,
      blobStore: blobStoreFixture(),
      now: () => 100,
    });
    const active = new AbortController().signal;

    await expect(
      adapter.fetchRaw({
        accountId: "account-a22222222222222222222222222222222",
        providerMessageId: "message-a",
        signal: active,
        deadlineAt: 1_000,
      }),
    ).rejects.toEqual(
      new MailContentSourceError("mail_content_source_permanent"),
    );
    await expect(
      adapter.fetchRaw({
        accountId: ACCOUNT_ID,
        providerMessageId: "../message-a",
        signal: active,
        deadlineAt: 1_000,
      }),
    ).rejects.toEqual(
      new MailContentSourceError("mail_content_source_permanent"),
    );
    await expect(
      adapter.fetchRaw({
        accountId: ACCOUNT_ID,
        providerMessageId: "message-a",
        signal: active,
        deadlineAt: 100,
      }),
    ).rejects.toEqual(
      new MailContentSourceError("mail_content_source_transient"),
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      adapter.fetchRaw({
        accountId: ACCOUNT_ID,
        providerMessageId: "message-a",
        signal: aborted.signal,
        deadlineAt: 1_000,
      }),
    ).rejects.toEqual(
      new MailContentSourceError("mail_content_source_transient"),
    );
    expect(getRawMessage).not.toHaveBeenCalled();
  });

  it("rejects a blob store for another account at construction", () => {
    const store = blobStoreFixture();
    Object.defineProperty(store, "accountId", {
      value: "account-a22222222222222222222222222222222",
    });

    expect(
      () =>
        new GmailContentSourceAdapter({
          accountId: ACCOUNT_ID,
          client: {} as GmailApiClient,
          blobStore: store,
        }),
    ).toThrow(new MailContentSourceError("mail_content_source_permanent"));
  });
});

function adapterWithFailure(error: GmailApiError): GmailContentSourceAdapter {
  return new GmailContentSourceAdapter({
    accountId: ACCOUNT_ID,
    client: {
      getRawMessage: vi.fn().mockRejectedValue(error),
    } as unknown as GmailApiClient,
    blobStore: blobStoreFixture(),
    now: () => 100,
  });
}

function blobStoreFixture(): MailIncomingBlobStorePort & {
  readonly accountId: string;
} {
  return {
    accountId: ACCOUNT_ID,
    has: vi.fn(),
    put: vi.fn(),
    putIncoming: vi.fn(),
    read: vi.fn(),
    remove: vi.fn(),
  };
}
