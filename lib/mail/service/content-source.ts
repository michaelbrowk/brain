import type { MailBlobDescriptor } from "../ports";

export type MailContentSourceErrorCode =
  | "mail_content_source_reauth_required"
  | "mail_content_source_rate_limited"
  | "mail_content_source_transient"
  | "mail_content_source_permanent"
  | "mail_content_source_invalid_response";

export class MailContentSourceError extends Error {
  constructor(readonly code: MailContentSourceErrorCode) {
    super(code);
    this.name = "MailContentSourceError";
  }
}

export interface MailContentSourceFetchInput {
  readonly accountId: string;
  readonly providerMessageId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

export interface MailContentSourceFetchResult {
  readonly descriptor: MailBlobDescriptor;
}

/** Provider-neutral boundary used by the content coordinator. */
export interface MailContentSourcePort {
  fetchRaw(
    input: MailContentSourceFetchInput,
  ): Promise<MailContentSourceFetchResult>;
}
