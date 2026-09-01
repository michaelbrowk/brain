import type { MailIncomingBlobStorePort } from "../../ports";
import {
  MailContentSourceError,
  type MailContentSourceFetchInput,
  type MailContentSourceFetchResult,
  type MailContentSourcePort,
} from "../../service/content-source";
import { GmailApiClient } from "./api-client";
import { GmailApiError } from "./api-types";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/;
const MAX_ABORT_TIMEOUT_MS = 0x7fff_ffff;

type AccountBlobStore = MailIncomingBlobStorePort & {
  readonly accountId: string;
};

export class GmailContentSourceAdapter implements MailContentSourcePort {
  private readonly accountId: string;
  private readonly client: GmailApiClient;
  private readonly blobStore: AccountBlobStore;
  private readonly now: () => number;

  constructor(options: {
    readonly accountId: string;
    readonly client: GmailApiClient;
    readonly blobStore: AccountBlobStore;
    readonly now?: () => number;
  }) {
    if (
      !SAFE_ACCOUNT_ID.test(options.accountId) ||
      options.blobStore.accountId !== options.accountId
    ) {
      throw permanentError();
    }
    this.accountId = options.accountId;
    this.client = options.client;
    this.blobStore = options.blobStore;
    this.now = options.now ?? Date.now;
  }

  async fetchRaw(
    input: MailContentSourceFetchInput,
  ): Promise<MailContentSourceFetchResult> {
    if (
      input.accountId !== this.accountId ||
      !SAFE_PROVIDER_ID.test(input.providerMessageId) ||
      !Number.isSafeInteger(input.deadlineAt) ||
      input.deadlineAt < 0 ||
      !(input.signal instanceof AbortSignal)
    ) {
      throw permanentError();
    }
    if (input.signal.aborted) {
      throw transientError();
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw transientError();
    }
    const remainingMs = input.deadlineAt - now;
    if (remainingMs <= 0) {
      throw transientError();
    }
    const deadlineSignal = AbortSignal.timeout(
      Math.min(remainingMs, MAX_ABORT_TIMEOUT_MS),
    );
    const signal = AbortSignal.any([input.signal, deadlineSignal]);
    try {
      const fetched = await this.client.getRawMessage(
        input.providerMessageId,
        this.blobStore,
        signal,
      );
      return Object.freeze({ descriptor: fetched.descriptor });
    } catch (error) {
      throw mapGmailContentError(error);
    }
  }
}

function mapGmailContentError(error: unknown): MailContentSourceError {
  if (error instanceof MailContentSourceError) return error;
  if (!(error instanceof GmailApiError)) return transientError();
  switch (error.code) {
    case "gmail_reauth_required":
      return new MailContentSourceError("mail_content_source_reauth_required");
    case "gmail_rate_limited":
      return new MailContentSourceError("mail_content_source_rate_limited");
    case "gmail_response_invalid":
      return new MailContentSourceError("mail_content_source_invalid_response");
    case "gmail_request_cancelled":
    case "gmail_request_timeout":
    case "gmail_service_unavailable":
      return transientError();
    case "gmail_request_invalid":
    case "gmail_permission_denied":
    case "gmail_not_found":
    case "gmail_conflict":
      return permanentError();
  }
}

function transientError(): MailContentSourceError {
  return new MailContentSourceError("mail_content_source_transient");
}

function permanentError(): MailContentSourceError {
  return new MailContentSourceError("mail_content_source_permanent");
}
