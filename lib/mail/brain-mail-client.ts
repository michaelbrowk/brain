import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";

import {
  validateMailContentAccountId,
  validateMailContentAttachmentId,
  validateMailContentMessageId,
  validateMailContentRemoteImageId,
  validateMailMessageContent,
} from "./content-codec";
import { MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY } from "./content-types";
import type { MailMessageContent } from "./content-types";
import {
  MAIL_DRAFT_LIMITS,
  validateMailDraftAccountId,
  validateMailDraftCreateInput,
  validateMailDraftCreateResponse,
  validateMailDraftDeleteInput,
  validateMailDraftDeleteResponse,
  validateMailDraftId,
  validateMailDraftListResponse,
  validateMailDraftMutationInput,
  validateMailDraftMutationResponse,
  validateMailDraftSendResponse,
  validateMailDraftDto,
} from "./draft-codec";
import type {
  MailDraftCreateInput,
  MailDraftCreateResponse,
  MailDraftDeleteInput,
  MailDraftDeleteResponse,
  MailDraftDto,
  MailDraftListResponse,
  MailDraftMutationInput,
  MailDraftMutationResponse,
  MailDraftSendResponse,
} from "./draft-types";
import {
  MAIL_RESOURCE_LIMITS,
  mailRequestPhase,
  writeMailLogRecord,
} from "./security";
import { MAIL_SERVICE_HTTP_LIMITS } from "./service/limits";
import {
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER,
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE,
  mailAccountCapabilities,
  type MailAccountCapabilities,
} from "./service/account-types";
import {
  MAIL_THREAD_STATE_CONTRACT_HEADER,
  MAIL_THREAD_STATE_CONTRACT_VALUE,
} from "./thread-contract";

import {
  validateMailAccountId,
  validateMailListOptions,
  validateMailMailboxThreadPage,
  validateMailOperationId,
  validateMailResourceId,
  validateMailSearchInput,
  validateMailSearchThreadPage,
  validateMailSendInput,
  validateMailSendOperation,
  validateMailSendResult,
  validateMailSyncInput,
  validateMailSyncResult,
  validateMailSystemMailbox,
  validateMailThreadDetail,
  validateMailThreadListFilter,
  validateMailThreadMutationInput,
  validateMailThreadMutationResult,
  validateMailThreadPage,
} from "./message-codec";
import type {
  MailMailboxThreadPage,
  MailSendInput,
  MailSendOperation,
  MailSendResult,
  MailSyncResult,
  MailSearchThreadPage,
  MailSystemMailbox,
  MailThreadDetail,
  MailThreadMutationInput,
  MailThreadMutationResult,
  MailThreadPage,
} from "./message-types";

const DEFAULT_SOCKET_PATH = "/run/brain-mail/brain-mail.sock";
const ACCOUNT_PATH = "/v1/account";
const ACCOUNTS_PATH = "/v2/accounts";
const THREADS_PATH = "/v1/threads";
const MAILBOXES_PATH = "/v1/mailboxes";
const SYNC_PATH = "/v1/sync";
const SEND_PATH = "/v1/send";
const DRAFTS_PATH = "/v1/drafts";
const MESSAGE_CONTENT_PATH = "/v1/message-content";
const ATTACHMENTS_PATH = "/v1/attachments";
const REMOTE_IMAGES_PATH = "/v1/remote-images";
const SEARCH_PATH = "/v1/search";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_THREAD_LIST_RESPONSE_BYTES = 512 * 1024;
const MAX_THREAD_DETAIL_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_DRAFT_DETAIL_RESPONSE_BYTES =
  MAIL_SERVICE_HTTP_LIMITS.maxDraftBodyBytes;
const MAX_CONNECTED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;

/**
 * The service error codes Brain forwards to the browser unchanged.
 *
 * Anything outside this set becomes `mail_service_invalid_response`, which is
 * the right answer for a transport or protocol code — those mean Brain's own
 * proxy sent something malformed and no surface can act on them. It is the
 * wrong answer for a code the service coined to explain a decision about the
 * owner's mail: the status and the meaning are both lost, the surface sees a
 * generic 502, and a refusal it knows how to explain arrives looking like an
 * outage. A new code on a message or account route belongs here in the same
 * commit that adds it — `proxies every stable service error code` in
 * `service/http-messages.test.ts` fails when one does not.
 */
export const SAFE_SERVICE_ERROR_CODES = new Set([
  "account_request_invalid",
  "account_not_found",
  "account_already_exists",
  "account_limit_reached",
  "account_selection_required",
  "account_unavailable",
  "imap_dns_failed",
  "imap_tls_failed",
  "imap_connection_failed",
  "imap_authentication_failed",
  "imap_connection_timeout",
  "smtp_dns_failed",
  "smtp_tls_failed",
  "smtp_connection_failed",
  "smtp_authentication_failed",
  "smtp_connection_timeout",
  "mail_request_invalid",
  "mail_account_not_found",
  "mail_account_reauth_required",
  "mail_thread_not_found",
  "mail_thread_mutation_unsupported",
  "mail_thread_stale",
  "mail_sync_in_progress",
  "mail_sync_rate_limited",
  "mail_sync_unavailable",
  "mail_send_request_invalid",
  "mail_send_account_not_found",
  "mail_send_account_reauth_required",
  "mail_send_reply_target_not_found",
  "mail_send_idempotency_conflict",
  "mail_send_operation_not_found",
  "mail_send_rate_limited",
  "mail_send_service_unavailable",
  "mail_draft_request_invalid",
  "mail_draft_account_not_found",
  "mail_draft_account_reauth_required",
  "mail_draft_capability_unavailable",
  "mail_draft_reply_target_not_found",
  "mail_draft_not_found",
  "mail_draft_revision_conflict",
  "mail_draft_idempotency_conflict",
  "mail_draft_quota_exceeded",
  "mail_draft_state_invalid",
  "mail_draft_service_unavailable",
  "mail_content_request_invalid",
  "mail_content_account_not_found",
  "mail_content_message_not_found",
  "mail_content_attachment_not_found",
  "mail_content_remote_image_not_found",
  "mail_content_remote_image_refused",
  "mail_content_unavailable",
  "mail_attachment_range_unsupported",
]);

export type MailTlsMode = "implicit" | "starttls";

export interface MailAccountConnectInput {
  readonly emailAddress: string;
  readonly imap: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: MailTlsMode;
    readonly username: string;
    /** An empty string keeps the saved password when an account already exists. */
    readonly password: string;
  };
  readonly smtp?: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: MailTlsMode;
    readonly username: string;
  };
}

export interface PublicMailAccount {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly imap: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: MailTlsMode;
    readonly username: string;
  };
  readonly smtp?: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: MailTlsMode;
    readonly username: string;
  };
  readonly connectedAt: number;
}

export interface MailAccountStatus {
  readonly apiVersion: 1;
  readonly configured: boolean;
  readonly account: PublicMailAccount | null;
}

export type MailAccountLifecycleStatus = "connected" | "reauth_required";

export interface PublicMailAccountBaseV2 {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly displayName: string | null;
  readonly status: MailAccountLifecycleStatus;
  readonly connectedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type PublicMailAccountV2 =
  | (PublicMailAccountBaseV2 & {
      readonly providerKind: "imap";
      readonly imap: PublicMailAccount["imap"];
      readonly smtp?: PublicMailAccount["smtp"];
    })
  | (PublicMailAccountBaseV2 & { readonly providerKind: "gmail" });

export type PublicMailAccountV3 = PublicMailAccountV2 & {
  readonly capabilities: MailAccountCapabilities;
};

export interface MailAccountsStatus {
  readonly apiVersion: 2;
  readonly accounts: readonly PublicMailAccountV2[];
}

export interface MailAccountsCapabilitiesStatus {
  readonly apiVersion: 3;
  readonly accounts: readonly PublicMailAccountV3[];
}

export interface MailAccountResult {
  readonly apiVersion: 2;
  readonly account: PublicMailAccountV2;
}

export interface MailAccountCreateInputV2 extends MailAccountConnectInput {
  readonly providerKind: "imap";
  readonly displayName?: string | null;
}

export interface MailAccountPatchInputV2 {
  readonly emailAddress?: string;
  readonly displayName?: string | null;
  readonly imap?: {
    readonly hostname?: string;
    readonly port?: number;
    readonly tls?: MailTlsMode;
    readonly username?: string;
    readonly password?: string | null;
  };
  readonly smtp?:
    | {
        readonly hostname?: string;
        readonly port?: number;
        readonly tls?: MailTlsMode;
        readonly username?: string;
      }
    | null;
}

export class BrainMailClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "BrainMailClientError";
    this.status = status;
    this.code = code;
  }
}

export interface MailAttachmentPayload {
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly bytes: number;
  readonly body: ReadableStream<Uint8Array>;
}

export interface BrainMailClient {
  status(signal?: AbortSignal): Promise<MailAccountStatus>;
  connect(
    input: MailAccountConnectInput,
    signal?: AbortSignal,
  ): Promise<MailAccountStatus>;
  disconnect(signal?: AbortSignal): Promise<MailAccountStatus>;
  listAccounts(signal?: AbortSignal): Promise<MailAccountsStatus>;
  listAccountCapabilities(
    signal?: AbortSignal,
  ): Promise<MailAccountsCapabilitiesStatus>;
  createAccount(
    input: MailAccountCreateInputV2,
    signal?: AbortSignal,
  ): Promise<MailAccountResult>;
  updateAccount(
    accountId: string,
    patch: MailAccountPatchInputV2,
    signal?: AbortSignal,
  ): Promise<MailAccountResult>;
  deleteAccount(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<MailAccountResult>;
  listThreads(
    accountId: string,
    options?: {
      readonly cursor?: string | null;
      readonly limit?: number;
      readonly view?: string | null;
      readonly sort?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<MailThreadPage>;
  listMailboxThreads(
    accountId: string,
    mailboxId: MailSystemMailbox,
    options?: {
      readonly cursor?: string | null;
      readonly limit?: number;
      readonly view?: string | null;
      readonly sort?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<MailMailboxThreadPage>;
  searchThreads(
    input: {
      readonly accountId: string;
      readonly mailboxId: MailSystemMailbox;
      readonly query: string;
      readonly cursor?: string | null;
      readonly limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<MailSearchThreadPage>;
  getThread(
    accountId: string,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<MailThreadDetail>;
  getMailboxThread(
    accountId: string,
    mailboxId: MailSystemMailbox,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<MailThreadDetail>;
  syncAccount(
    input: { readonly accountId: string; readonly maxItems: number },
    signal?: AbortSignal,
  ): Promise<MailSyncResult>;
  updateThread(
    threadId: string,
    mutation: MailThreadMutationInput,
    signal?: AbortSignal,
  ): Promise<MailThreadMutationResult>;
  createDraft(
    input: MailDraftCreateInput,
    signal?: AbortSignal,
  ): Promise<MailDraftCreateResponse>;
  listDrafts(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<MailDraftListResponse>;
  getDraft(
    accountId: string,
    draftId: string,
    signal?: AbortSignal,
  ): Promise<MailDraftDto>;
  updateDraft(
    draftId: string,
    mutation: MailDraftMutationInput,
    signal?: AbortSignal,
  ): Promise<MailDraftMutationResponse>;
  deleteDraft(
    draftId: string,
    input: MailDraftDeleteInput,
    signal?: AbortSignal,
  ): Promise<MailDraftDeleteResponse>;
  sendDraft(
    draftId: string,
    mutation: MailDraftMutationInput,
    signal?: AbortSignal,
  ): Promise<MailDraftSendResponse>;
  sendMessage(input: MailSendInput, signal?: AbortSignal): Promise<MailSendResult>;
  getSendOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MailSendOperation>;
  getMessageContent(
    accountId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<MailMessageContent>;
  requestMessageContent(
    accountId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<MailMessageContent>;
  downloadAttachment(
    accountId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<MailAttachmentPayload>;
  downloadRemoteImage(
    accountId: string,
    remoteImageId: string,
    signal?: AbortSignal,
  ): Promise<MailAttachmentPayload>;
}

export function createBrainMailClient(options?: {
  readonly socketPath?: string;
  readonly requestTimeoutMs?: number;
}): BrainMailClient {
  const socketPath = validateSocketPath(
    options?.socketPath ?? process.env.BRAIN_MAIL_SOCKET_PATH ?? DEFAULT_SOCKET_PATH,
  );
  const requestTimeoutMs = validateRequestTimeout(
    options?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  return Object.freeze({
    status: async (signal?: AbortSignal) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        ACCOUNT_PATH,
        "GET",
        undefined,
        validateMailAccountStatus,
        signal,
      ),
    connect: async (input: MailAccountConnectInput, signal?: AbortSignal) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        ACCOUNT_PATH,
        "POST",
        validateConnectInput(input),
        validateMailAccountStatus,
        signal,
      ),
    disconnect: async (signal?: AbortSignal) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        ACCOUNT_PATH,
        "DELETE",
        undefined,
        validateMailAccountStatus,
        signal,
      ),
    listAccounts: async (signal?: AbortSignal) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        ACCOUNTS_PATH,
        "GET",
        undefined,
        validateMailAccountsStatus,
        signal,
      ),
    listAccountCapabilities: async (signal?: AbortSignal) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        ACCOUNTS_PATH,
        "GET",
        undefined,
        validateMailAccountsCapabilitiesStatus,
        signal,
        MAX_RESPONSE_BYTES,
        {
          [MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER]:
            MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE,
        },
      ),
    createAccount: async (
      input: MailAccountCreateInputV2,
      signal?: AbortSignal,
    ) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        ACCOUNTS_PATH,
        "POST",
        validateCreateInputV2(input),
        validateMailAccountResult,
        signal,
      ),
    updateAccount: async (
      accountId: string,
      patch: MailAccountPatchInputV2,
      signal?: AbortSignal,
    ) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        accountPathV2(accountId),
        "PATCH",
        validatePatchInputV2(patch),
        validateMailAccountResult,
        signal,
      ),
    deleteAccount: async (accountId: string, signal?: AbortSignal) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        accountPathV2(accountId),
        "DELETE",
        undefined,
        validateMailAccountResult,
        signal,
      ),
    listThreads: async (
      accountId: string,
      options?: {
        readonly cursor?: string | null;
        readonly limit?: number;
        readonly view?: string | null;
        readonly sort?: string | null;
      },
      signal?: AbortSignal,
    ) => {
      const safeAccountId = validateMessageRequest(() =>
        validateMailAccountId(accountId),
      );
      const normalized = validateMessageRequest(() =>
        validateMailListOptions({
          cursor: options?.cursor,
          limit: options?.limit,
        }),
      );
      const filter = validateMessageRequest(() =>
        validateMailThreadListFilter({
          view: options?.view,
          sort: options?.sort,
        }),
      );
      const query = new URLSearchParams({
        accountId: safeAccountId,
        limit: String(normalized.limit),
      });
      if (normalized.cursor !== null) query.set("cursor", normalized.cursor);
      if (filter.view !== null) query.set("view", filter.view);
      if (filter.sort !== "date") query.set("sort", filter.sort);
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${THREADS_PATH}?${query}`,
        "GET",
        undefined,
        (value) => {
          const page = validateMailThreadPage(value);
          if (page.items.some((item) => item.accountId !== safeAccountId)) {
            throw invalidResponse();
          }
          return page;
        },
        signal,
        MAX_THREAD_LIST_RESPONSE_BYTES,
      );
    },
    listMailboxThreads: async (
      accountId: string,
      mailboxId: MailSystemMailbox,
      options?: {
        readonly cursor?: string | null;
        readonly limit?: number;
        readonly view?: string | null;
        readonly sort?: string | null;
      },
      signal?: AbortSignal,
    ) => {
      const safeAccountId = validateMessageRequest(() =>
        validateMailAccountId(accountId),
      );
      const safeMailboxId = validateMessageRequest(() =>
        validateMailSystemMailbox(mailboxId),
      );
      const normalized = validateMessageRequest(() =>
        validateMailListOptions({
          cursor: options?.cursor,
          limit: options?.limit,
        }),
      );
      const filter = validateMessageRequest(() =>
        validateMailThreadListFilter({
          view: options?.view,
          sort: options?.sort,
        }),
      );
      const query = new URLSearchParams({
        accountId: safeAccountId,
        limit: String(normalized.limit),
      });
      if (normalized.cursor !== null) query.set("cursor", normalized.cursor);
      if (filter.view !== null) query.set("view", filter.view);
      if (filter.sort !== "date") query.set("sort", filter.sort);
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${MAILBOXES_PATH}/${safeMailboxId}/threads?${query}`,
        "GET",
        undefined,
        (value) => {
          const page = validateMailMailboxThreadPage(value);
          if (
            page.mailboxId !== safeMailboxId ||
            page.items.some((item) => item.accountId !== safeAccountId)
          ) {
            throw invalidResponse();
          }
          return page;
        },
        signal,
        MAX_THREAD_LIST_RESPONSE_BYTES,
      );
    },
    searchThreads: async (
      input: {
        readonly accountId: string;
        readonly mailboxId: MailSystemMailbox;
        readonly query: string;
        readonly cursor?: string | null;
        readonly limit?: number;
      },
      signal?: AbortSignal,
    ) => {
      const normalized = validateMessageRequest(() =>
        validateMailSearchInput(input),
      );
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        SEARCH_PATH,
        "POST",
        normalized,
        (value) => {
          const page = validateMailSearchThreadPage(value);
          if (
            page.mailboxId !== normalized.mailboxId ||
            page.items.some((item) => item.accountId !== normalized.accountId)
          ) {
            throw invalidResponse();
          }
          return page;
        },
        signal,
        MAX_THREAD_LIST_RESPONSE_BYTES,
      );
    },
    getThread: async (
      accountId: string,
      threadId: string,
      signal?: AbortSignal,
    ) => {
      const safeAccountId = validateMessageRequest(() =>
        validateMailAccountId(accountId),
      );
      const safeThreadId = validateMessageRequest(() =>
        validateMailResourceId(threadId),
      );
      const query = new URLSearchParams({ accountId: safeAccountId });
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${THREADS_PATH}/${encodeURIComponent(safeThreadId)}?${query}`,
        "GET",
        undefined,
        validateMailThreadDetail,
        signal,
        MAX_THREAD_DETAIL_RESPONSE_BYTES,
      );
    },
    getMailboxThread: async (
      accountId: string,
      mailboxId: MailSystemMailbox,
      threadId: string,
      signal?: AbortSignal,
    ) => {
      const safeAccountId = validateMessageRequest(() =>
        validateMailAccountId(accountId),
      );
      const safeMailboxId = validateMessageRequest(() =>
        validateMailSystemMailbox(mailboxId),
      );
      const safeThreadId = validateMessageRequest(() =>
        validateMailResourceId(threadId),
      );
      const query = new URLSearchParams({ accountId: safeAccountId });
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${MAILBOXES_PATH}/${safeMailboxId}/threads/${encodeURIComponent(
          safeThreadId,
        )}?${query}`,
        "GET",
        undefined,
        (value) => {
          const detail = validateMailThreadDetail(value);
          if (
            detail.thread.accountId !== safeAccountId ||
            detail.thread.threadId !== safeThreadId
          ) {
            throw invalidResponse();
          }
          return detail;
        },
        signal,
        MAX_THREAD_DETAIL_RESPONSE_BYTES,
      );
    },
    syncAccount: async (
      input: { readonly accountId: string; readonly maxItems: number },
      signal?: AbortSignal,
    ) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        SYNC_PATH,
        "POST",
        validateMessageRequest(() => validateMailSyncInput(input)),
        validateMailSyncResult,
        signal,
      ),
    updateThread: async (
      threadId: string,
      mutation: MailThreadMutationInput,
      signal?: AbortSignal,
    ) => {
      const safeThreadId = validateMessageRequest(() =>
        validateMailResourceId(threadId),
      );
      const safeMutation = validateMessageRequest(() =>
        validateMailThreadMutationInput(mutation),
      );
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${THREADS_PATH}/${encodeURIComponent(safeThreadId)}`,
        "PATCH",
        safeMutation,
        (value) => {
          const result = validateMailThreadMutationResult(value);
          if (
            result.thread.accountId !== safeMutation.accountId ||
            result.thread.threadId !== safeThreadId
          ) {
            throw invalidResponse();
          }
          return result;
        },
        signal,
      );
    },
    createDraft: async (
      input: MailDraftCreateInput,
      signal?: AbortSignal,
    ) => {
      const safeInput = validateDraftRequest(() =>
        validateMailDraftCreateInput(input),
      );
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        DRAFTS_PATH,
        "POST",
        safeInput,
        (value) => {
          const result = validateMailDraftCreateResponse(value);
          if (
            result.draft.accountId !== safeInput.accountId ||
            result.draft.draftId !== safeInput.draftId
          ) {
            throw invalidResponse();
          }
          return result;
        },
        signal,
        MAX_DRAFT_DETAIL_RESPONSE_BYTES,
      );
    },
    listDrafts: async (accountId: string, signal?: AbortSignal) => {
      const safeAccountId = validateDraftRequest(() =>
        validateMailDraftAccountId(accountId),
      );
      const query = new URLSearchParams({ accountId: safeAccountId });
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${DRAFTS_PATH}?${query}`,
        "GET",
        undefined,
        (value) => {
          const result = validateMailDraftListResponse(value);
          if (result.drafts.some((draft) => draft.accountId !== safeAccountId)) {
            throw invalidResponse();
          }
          return result;
        },
        signal,
        MAIL_DRAFT_LIMITS.maxListResponseBytes,
      );
    },
    getDraft: async (
      accountId: string,
      draftId: string,
      signal?: AbortSignal,
    ) => {
      const safeAccountId = validateDraftRequest(() =>
        validateMailDraftAccountId(accountId),
      );
      const safeDraftId = validateDraftRequest(() =>
        validateMailDraftId(draftId),
      );
      const query = new URLSearchParams({ accountId: safeAccountId });
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${DRAFTS_PATH}/${safeDraftId}?${query}`,
        "GET",
        undefined,
        (value) => {
          const draft = validateMailDraftDto(value);
          if (
            draft.accountId !== safeAccountId ||
            draft.draftId !== safeDraftId
          ) {
            throw invalidResponse();
          }
          return draft;
        },
        signal,
        MAX_DRAFT_DETAIL_RESPONSE_BYTES,
      );
    },
    updateDraft: async (
      draftId: string,
      mutation: MailDraftMutationInput,
      signal?: AbortSignal,
    ) => {
      const safeDraftId = validateDraftRequest(() =>
        validateMailDraftId(draftId),
      );
      const safeMutation = validateDraftRequest(() =>
        validateMailDraftMutationInput(mutation),
      );
      if (safeMutation.kind !== "patch" || safeMutation.draftId !== safeDraftId) {
        throw new BrainMailClientError(400, "mail_draft_request_invalid");
      }
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${DRAFTS_PATH}/${safeDraftId}`,
        "PATCH",
        safeMutation,
        (value) => {
          const result = validateMailDraftMutationResponse(value);
          if (result.operationId !== null) throw invalidResponse();
          return result;
        },
        signal,
      );
    },
    deleteDraft: async (
      draftId: string,
      input: MailDraftDeleteInput,
      signal?: AbortSignal,
    ) => {
      const safeDraftId = validateDraftRequest(() =>
        validateMailDraftId(draftId),
      );
      const safeInput = validateDraftRequest(() =>
        validateMailDraftDeleteInput(input),
      );
      if (safeInput.draftId !== safeDraftId) {
        throw new BrainMailClientError(400, "mail_draft_request_invalid");
      }
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${DRAFTS_PATH}/${safeDraftId}`,
        "DELETE",
        safeInput,
        validateMailDraftDeleteResponse,
        signal,
      );
    },
    sendDraft: async (
      draftId: string,
      mutation: MailDraftMutationInput,
      signal?: AbortSignal,
    ) => {
      const safeDraftId = validateDraftRequest(() =>
        validateMailDraftId(draftId),
      );
      const safeMutation = validateDraftRequest(() =>
        validateMailDraftMutationInput(mutation),
      );
      if (safeMutation.kind !== "send" || safeMutation.draftId !== safeDraftId) {
        throw new BrainMailClientError(400, "mail_draft_request_invalid");
      }
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${DRAFTS_PATH}/${safeDraftId}/send`,
        "POST",
        safeMutation,
        (value) => {
          const result = validateMailDraftSendResponse(value);
          if (result.operationId !== safeMutation.sendOperationId) {
            throw invalidResponse();
          }
          return result;
        },
        signal,
      );
    },
    sendMessage: async (input: MailSendInput, signal?: AbortSignal) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        SEND_PATH,
        "POST",
        validateMessageRequest(() => validateMailSendInput(input)),
        validateMailSendResult,
        signal,
      ),
    getSendOperation: async (
      operationId: string,
      signal?: AbortSignal,
    ) =>
      requestMailService(
        socketPath,
        requestTimeoutMs,
        `${SEND_PATH}/${encodeURIComponent(
          validateMessageRequest(() => validateMailOperationId(operationId)),
        )}`,
        "GET",
        undefined,
        validateMailSendOperation,
        signal,
      ),
    getMessageContent: async (
      accountId: string,
      messageId: string,
      signal?: AbortSignal,
    ) => {
      const safeAccountId = validateContentRequest(() =>
        validateMailContentAccountId(accountId),
      );
      const safeMessageId = validateContentRequest(() =>
        validateMailContentMessageId(messageId),
      );
      const query = new URLSearchParams({ accountId: safeAccountId });
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${MESSAGE_CONTENT_PATH}/${encodeURIComponent(safeMessageId)}?${query}`,
        "GET",
        undefined,
        (value) => validateOwnedContent(value, safeAccountId, safeMessageId),
        signal,
        8 * 1024 * 1024,
      );
    },
    requestMessageContent: async (
      accountId: string,
      messageId: string,
      signal?: AbortSignal,
    ) => {
      const safeAccountId = validateContentRequest(() =>
        validateMailContentAccountId(accountId),
      );
      const safeMessageId = validateContentRequest(() =>
        validateMailContentMessageId(messageId),
      );
      const query = new URLSearchParams({ accountId: safeAccountId });
      return requestMailService(
        socketPath,
        requestTimeoutMs,
        `${MESSAGE_CONTENT_PATH}/${encodeURIComponent(safeMessageId)}?${query}`,
        "POST",
        undefined,
        (value) => validateOwnedContent(value, safeAccountId, safeMessageId),
        signal,
        8 * 1024 * 1024,
      );
    },
    downloadAttachment: async (
      accountId: string,
      attachmentId: string,
      signal?: AbortSignal,
    ) => {
      const safeAccountId = validateContentRequest(() =>
        validateMailContentAccountId(accountId),
      );
      const safeAttachmentId = validateContentRequest(() =>
        validateMailContentAttachmentId(attachmentId),
      );
      const query = new URLSearchParams({ accountId: safeAccountId });
      return requestMailAttachment(
        socketPath,
        requestTimeoutMs,
        `${ATTACHMENTS_PATH}/${safeAttachmentId}?${query}`,
        signal,
      );
    },
    downloadRemoteImage: async (
      accountId: string,
      remoteImageId: string,
      signal?: AbortSignal,
    ) => {
      const safeAccountId = validateContentRequest(() =>
        validateMailContentAccountId(accountId),
      );
      const safeRemoteImageId = validateContentRequest(() =>
        validateMailContentRemoteImageId(remoteImageId),
      );
      const query = new URLSearchParams({ accountId: safeAccountId });
      return requestMailAttachment(
        socketPath,
        requestTimeoutMs,
        `${REMOTE_IMAGES_PATH}/${safeRemoteImageId}?${query}`,
        signal,
      );
    },
  });
}

function validateMessageRequest<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new BrainMailClientError(400, "mail_request_invalid");
  }
}

function validateDraftRequest<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new BrainMailClientError(400, "mail_draft_request_invalid");
  }
}

function validateContentRequest<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new BrainMailClientError(400, "mail_content_request_invalid");
  }
}

function validateOwnedContent(
  value: unknown,
  accountId: string,
  messageId: string,
): MailMessageContent {
  const content = validateMailMessageContent(value);
  if (content.accountId !== accountId || content.messageId !== messageId) {
    throw invalidResponse();
  }
  return content;
}

export function validateMailAccountStatus(value: unknown): MailAccountStatus {
  if (!isExactRecord(value, ["apiVersion", "configured", "account"])) {
    throw invalidResponse();
  }
  if (value.apiVersion !== 1 || typeof value.configured !== "boolean") {
    throw invalidResponse();
  }
  if (!value.configured) {
    if (value.account !== null) throw invalidResponse();
    return Object.freeze({ apiVersion: 1, configured: false, account: null });
  }

  const account = validatePublicAccount(value.account);
  return Object.freeze({ apiVersion: 1, configured: true, account });
}

export function validateMailAccountsStatus(value: unknown): MailAccountsStatus {
  if (
    !isExactRecord(value, ["apiVersion", "accounts"]) ||
    value.apiVersion !== 2 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 3
  ) {
    throw invalidResponse();
  }
  const accounts = value.accounts.map(validatePublicAccountV2);
  if (new Set(accounts.map((account) => account.accountId)).size !== accounts.length) {
    throw invalidResponse();
  }
  return Object.freeze({ apiVersion: 2, accounts: Object.freeze(accounts) });
}

export function validateMailAccountsCapabilitiesStatus(
  value: unknown,
): MailAccountsCapabilitiesStatus {
  if (isPlainRecord(value) && value.apiVersion === 2) {
    const legacy = validateMailAccountsStatus(value);
    return Object.freeze({
      apiVersion: 3,
      accounts: Object.freeze(
        legacy.accounts.map((account) =>
          Object.freeze({
            ...account,
            capabilities: mailAccountCapabilities(
              account.providerKind,
              account.providerKind === "gmail" || account.smtp !== undefined,
            ),
          }),
        ),
      ),
    });
  }
  if (
    !isExactRecord(value, ["apiVersion", "accounts"]) ||
    value.apiVersion !== 3 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 3
  ) {
    throw invalidResponse();
  }
  const accounts = value.accounts.map(validatePublicAccountV3);
  if (new Set(accounts.map((account) => account.accountId)).size !== accounts.length) {
    throw invalidResponse();
  }
  return Object.freeze({ apiVersion: 3, accounts: Object.freeze(accounts) });
}

export function validateMailAccountResult(value: unknown): MailAccountResult {
  if (
    !isExactRecord(value, ["apiVersion", "account"]) ||
    value.apiVersion !== 2
  ) {
    throw invalidResponse();
  }
  return Object.freeze({
    apiVersion: 2,
    account: validatePublicAccountV2(value.account),
  });
}

async function requestMailService<T>(
  socketPath: string,
  requestTimeoutMs: number,
  requestPath: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body: unknown | undefined,
  validateSuccess: (value: unknown) => T,
  signal: AbortSignal | undefined,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  extraHeaders: Readonly<Record<string, string>> = Object.freeze({}),
): Promise<T> {
  let encoded: Buffer | undefined;
  if (body !== undefined) {
    const serialized = JSON.stringify(body);
    if (typeof serialized !== "string") throw invalidResponse();
    encoded = Buffer.from(serialized);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    let requestBodyWiped = false;
    const wipeRequestBody = () => {
      if (requestBodyWiped || encoded === undefined) return;
      requestBodyWiped = true;
      encoded.fill(0);
    };
    const beforeSettle = () => {
      if (absoluteTimer !== undefined) clearTimeout(absoluteTimer);
      wipeRequestBody();
    };
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      beforeSettle();
      resolve(value);
    };
    const fail = (error: BrainMailClientError) => {
      if (settled) return;
      settled = true;
      beforeSettle();
      logProxyFailure(error, method, requestPath);
      reject(error);
    };

    try {
      const request = httpRequest(
        {
          socketPath,
          path: requestPath,
          method,
          signal,
          headers:
            encoded === undefined
              ? {
                  Accept: "application/json",
                  [MAIL_THREAD_STATE_CONTRACT_HEADER]:
                    MAIL_THREAD_STATE_CONTRACT_VALUE,
                  ...extraHeaders,
                }
              : {
                  Accept: "application/json",
                  [MAIL_THREAD_STATE_CONTRACT_HEADER]:
                    MAIL_THREAD_STATE_CONTRACT_VALUE,
                  ...extraHeaders,
                  "Content-Type": "application/json; charset=utf-8",
                  "Content-Length": String(encoded.byteLength),
                },
        },
        (response) => {
          const contentType = response.headers["content-type"];
          const contentLength = response.headers["content-length"];
          if (
            contentType !== "application/json; charset=utf-8" ||
            typeof contentLength !== "string" ||
            !/^\d+$/.test(contentLength) ||
            Number(contentLength) > maxResponseBytes
          ) {
            response.resume();
            fail(invalidResponse());
            return;
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          const wipeResponseChunks = () => {
            for (const chunk of chunks) chunk.fill(0);
            chunks.length = 0;
          };
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > maxResponseBytes) {
              response.destroy();
              wipeResponseChunks();
              fail(invalidResponse());
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once("end", () => {
            if (settled || bytes !== Number(contentLength)) {
              wipeResponseChunks();
              if (!settled) fail(invalidResponse());
              return;
            }
            let payload: unknown;
            const responseBody = Buffer.concat(chunks, bytes);
            wipeResponseChunks();
            try {
              payload = JSON.parse(responseBody.toString("utf8"));
            } catch {
              fail(invalidResponse());
              return;
            } finally {
              responseBody.fill(0);
            }

            const status = response.statusCode ?? 502;
            if (status >= 200 && status < 300) {
              try {
                succeed(validateSuccess(payload));
              } catch (error) {
                fail(
                  error instanceof BrainMailClientError
                    ? error
                    : invalidResponse(),
                );
              }
              return;
            }

            try {
              const code = validateServiceError(payload);
              fail(
                new BrainMailClientError(
                  code === "mail_service_timeout"
                    ? 504
                    : safeServiceStatus(status),
                  code,
                ),
              );
            } catch {
              fail(invalidResponse());
            }
          });
          response.once("error", () => {
            wipeResponseChunks();
            fail(serviceUnavailable());
          });
          response.once("aborted", () => {
            wipeResponseChunks();
            fail(invalidResponse());
          });
        },
      );

      absoluteTimer = setTimeout(() => {
        request.destroy();
        fail(new BrainMailClientError(504, "mail_service_timeout"));
      }, requestTimeoutMs);
      request.once("error", (error) => {
        const code =
          signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
            ? "mail_request_cancelled"
            : "mail_service_unavailable";
        fail(
          new BrainMailClientError(
            code === "mail_request_cancelled" ? 408 : 503,
            code,
          ),
        );
      });
      if (encoded !== undefined) request.end(encoded, wipeRequestBody);
      else request.end();
    } catch {
      wipeRequestBody();
      fail(serviceUnavailable());
    }
  });
}

async function requestMailAttachment(
  socketPath: string,
  requestTimeoutMs: number,
  requestPath: string,
  signal: AbortSignal | undefined,
): Promise<MailAttachmentPayload> {
  return new Promise<MailAttachmentPayload>((resolve, reject) => {
    let settled = false;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    const beforeSettle = () => {
      if (absoluteTimer !== undefined) clearTimeout(absoluteTimer);
    };
    const succeed = (value: MailAttachmentPayload) => {
      if (settled) {
        void value.body.cancel().catch(() => undefined);
        return;
      }
      settled = true;
      beforeSettle();
      resolve(value);
    };
    const fail = (error: BrainMailClientError) => {
      if (settled) return;
      settled = true;
      beforeSettle();
      logProxyFailure(error, "GET", requestPath);
      reject(error);
    };

    try {
      const request = httpRequest(
        {
          socketPath,
          path: requestPath,
          method: "GET",
          signal,
          headers: { Accept: "*/*" },
        },
        (response) => {
          void (async () => {
            const status = response.statusCode ?? 502;
            const contentLength = response.headers["content-length"];
            if (
              typeof contentLength !== "string" ||
              !/^\d+$/.test(contentLength)
            ) {
              response.destroy();
              fail(invalidResponse());
              return;
            }
            const declaredBytes = Number(contentLength);
            const success = status >= 200 && status < 300;
            const maxBytes = success
              ? MAIL_RESOURCE_LIMITS.rawMessageBytes
              : MAX_RESPONSE_BYTES;
            if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
              response.destroy();
              fail(invalidResponse());
              return;
            }
            let errorBody: Buffer | null = null;
            try {
              if (!success) {
                errorBody = await collectResponseBody(
                  response,
                  declaredBytes,
                  maxBytes,
                );
                const contentType = response.headers["content-type"];
                if (contentType !== "application/json; charset=utf-8") {
                  throw invalidResponse();
                }
                let payload: unknown;
                try {
                  payload = JSON.parse(errorBody.toString("utf8"));
                } catch {
                  throw invalidResponse();
                }
                const code = validateServiceError(payload);
                throw new BrainMailClientError(
                  code === "mail_service_timeout"
                    ? 504
                    : safeServiceStatus(status),
                  code,
                );
              }
              const contentType = response.headers["content-type"];
              const contentDisposition = response.headers["content-disposition"];
              if (
                status !== 200 ||
                typeof contentType !== "string" ||
                !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(
                  contentType,
                ) ||
                contentType !== contentType.toLowerCase() ||
                typeof contentDisposition !== "string" ||
                !isSafeContentDisposition(contentDisposition) ||
                response.headers["cache-control"] !== "private, no-store" ||
                response.headers["x-content-type-options"] !== "nosniff" ||
                response.headers["cross-origin-resource-policy"] !== "same-origin" ||
                response.headers["content-security-policy"] !==
                  MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY ||
                response.headers["accept-ranges"] !== undefined ||
                response.headers["transfer-encoding"] !== undefined
              ) {
                throw invalidResponse();
              }
              const body = createAttachmentResponseStream({
                response,
                request,
                declaredBytes,
                signal,
              });
              const result = Object.freeze({
                contentType,
                contentDisposition,
                bytes: declaredBytes,
                body,
              });
              succeed(result);
            } catch (error) {
              response.destroy();
              fail(
                error instanceof BrainMailClientError
                  ? error
                  : invalidResponse(),
              );
            } finally {
              errorBody?.fill(0);
            }
          })();
        },
      );
      absoluteTimer = setTimeout(() => {
        request.destroy();
        fail(new BrainMailClientError(504, "mail_service_timeout"));
      }, requestTimeoutMs);
      request.once("error", (error) => {
        const code =
          signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
            ? "mail_request_cancelled"
            : "mail_service_unavailable";
        fail(
          new BrainMailClientError(
            code === "mail_request_cancelled" ? 408 : 503,
            code,
          ),
        );
      });
      request.end();
    } catch {
      fail(serviceUnavailable());
    }
  });
}

function createAttachmentResponseStream(options: {
  readonly response: IncomingMessage;
  readonly request: ClientRequest;
  readonly declaredBytes: number;
  readonly signal: AbortSignal | undefined;
}): ReadableStream<Uint8Array> {
  const iterator = options.response[Symbol.asyncIterator]();
  let total = 0;
  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (absoluteTimer !== undefined) clearTimeout(absoluteTimer);
    idleTimer = undefined;
    absoluteTimer = undefined;
    options.response.off("aborted", onAborted);
    options.response.off("error", onResponseError);
    options.request.off("error", onRequestError);
    options.signal?.removeEventListener("abort", onSignalAbort);
  };
  const stop = (error: BrainMailClientError) => {
    if (closed) return;
    closed = true;
    cleanup();
    options.response.destroy();
    options.request.destroy();
    controller?.error(error);
    void iterator.return?.().catch(() => undefined);
  };
  const timeout = () =>
    stop(new BrainMailClientError(504, "mail_service_timeout"));
  const resetIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      timeout,
      MAIL_SERVICE_HTTP_LIMITS.attachmentIdleTimeoutMs,
    );
    idleTimer.unref?.();
  };
  const onAborted = () => stop(invalidResponse());
  const onResponseError = () => stop(serviceUnavailable());
  const onRequestError = () => stop(serviceUnavailable());
  const onSignalAbort = () =>
    stop(new BrainMailClientError(408, "mail_request_cancelled"));

  return new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
        options.response.once("aborted", onAborted);
        options.response.once("error", onResponseError);
        options.request.once("error", onRequestError);
        options.signal?.addEventListener("abort", onSignalAbort, { once: true });
        absoluteTimer = setTimeout(
          timeout,
          MAIL_SERVICE_HTTP_LIMITS.attachmentAbsoluteTimeoutMs,
        );
        absoluteTimer.unref?.();
        resetIdle();
        if (options.signal?.aborted) onSignalAbort();
      },
      async pull(streamController) {
        if (closed) return;
        try {
          const next = await iterator.next();
          if (next.done) {
            if (total !== options.declaredBytes) throw invalidResponse();
            closed = true;
            cleanup();
            streamController.close();
            return;
          }
          const chunk = next.value;
          if (
            !(chunk instanceof Uint8Array) ||
            chunk.byteLength < 1 ||
            chunk.byteLength > 64 * 1024 ||
            total + chunk.byteLength > options.declaredBytes
          ) {
            throw invalidResponse();
          }
          total += chunk.byteLength;
          streamController.enqueue(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          );
          resetIdle();
        } catch (error) {
          stop(
            error instanceof BrainMailClientError ? error : invalidResponse(),
          );
        }
      },
      async cancel() {
        if (closed) return;
        closed = true;
        cleanup();
        options.response.destroy();
        options.request.destroy();
        await iterator.return?.().catch(() => undefined);
      },
    },
    { highWaterMark: 1 },
  );
}

async function collectResponseBody(
  response: AsyncIterable<Uint8Array>,
  declaredBytes: number,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      total += chunk.byteLength;
      if (total > maxBytes || total > declaredBytes) throw invalidResponse();
      chunks.push(Buffer.from(chunk));
    }
    if (total !== declaredBytes) throw invalidResponse();
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function isSafeContentDisposition(value: string): boolean {
  const match = /^attachment; filename="([\x20-\x21\x23-\x5b\x5d-\x7e]{1,180})"; filename\*=UTF-8''((?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+)$/.exec(
    value,
  );
  if (match === null || /[\\/]/.test(match[1]!)) return false;
  try {
    const decoded = decodeURIComponent(match[2]!);
    return (
      decoded.length > 0 &&
      Buffer.byteLength(decoded) <= 180 &&
      !/[\r\n\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(
        decoded,
      )
    );
  } catch {
    return false;
  }
}

function validateConnectInput(value: unknown): MailAccountConnectInput {
  if (
    !isRecordWithFields(value, ["emailAddress", "imap"], ["smtp"]) ||
    !isExactRecord(value.imap, ["hostname", "port", "tls", "username", "password"])
  ) {
    throw new BrainMailClientError(400, "account_request_invalid");
  }
  const emailAddress = boundedString(value.emailAddress, 320, false);
  const hostname = boundedString(value.imap.hostname, 253, false);
  const username = boundedString(value.imap.username, 512, true);
  const password = boundedString(value.imap.password, 4 * 1024, true, true);
  if (
    !emailAddress ||
    !hostname ||
    !username ||
    /[\u0000-\u0020\u007f]/.test(emailAddress) ||
    /[\u0000\r\n]/.test(hostname) ||
    /[\u0000\r\n]/.test(username) ||
    password.includes("\u0000") ||
    !Number.isSafeInteger(value.imap.port) ||
    (value.imap.port as number) < 1 ||
    (value.imap.port as number) > 65_535 ||
    (value.imap.tls !== "implicit" && value.imap.tls !== "starttls")
  ) {
    throw new BrainMailClientError(400, "account_request_invalid");
  }

  const smtp = Object.prototype.hasOwnProperty.call(value, "smtp")
    ? validateSmtpEndpoint(value.smtp, "request")
    : undefined;
  return Object.freeze({
    emailAddress,
    imap: Object.freeze({
      hostname,
      port: value.imap.port as number,
      tls: value.imap.tls,
      username,
      password,
    }),
    ...(smtp ? { smtp } : {}),
  });
}

function validateCreateInputV2(value: unknown): MailAccountCreateInputV2 {
  if (
    !isRecordWithFields(
      value,
      ["emailAddress", "imap", "providerKind"],
      ["displayName", "smtp"],
    ) ||
    value.providerKind !== "imap"
  ) {
    throw new BrainMailClientError(400, "account_request_invalid");
  }
  const input = validateConnectInput({
    emailAddress: value.emailAddress,
    imap: value.imap,
    ...(Object.prototype.hasOwnProperty.call(value, "smtp")
      ? { smtp: value.smtp }
      : {}),
  });
  if (input.imap.password.length === 0) {
    throw new BrainMailClientError(400, "account_request_invalid");
  }
  const displayName = validateDisplayName(value.displayName);
  return Object.freeze({
    ...input,
    providerKind: "imap",
    ...(displayName === undefined ? {} : { displayName }),
  });
}

function validatePatchInputV2(value: unknown): MailAccountPatchInputV2 {
  if (
    !isRecordWithFields(value, [], ["displayName", "emailAddress", "imap", "smtp"]) ||
    Reflect.ownKeys(value).length === 0
  ) {
    throw new BrainMailClientError(400, "account_request_invalid");
  }
  const patch: {
    emailAddress?: string;
    displayName?: string | null;
    imap?: {
      hostname?: string;
      port?: number;
      tls?: MailTlsMode;
      username?: string;
      password?: string | null;
    };
    smtp?:
      | {
          hostname?: string;
          port?: number;
          tls?: MailTlsMode;
          username?: string;
        }
      | null;
  } = {};
  if (Object.prototype.hasOwnProperty.call(value, "emailAddress")) {
    const emailAddress = boundedString(value.emailAddress, 320, false);
    if (
      !emailAddress ||
      /[\u0000-\u0020\u007f]/.test(emailAddress) ||
      !/^[^@]+@[^@.]+(?:\.[^@.]+)+$/.test(emailAddress)
    ) {
      throw new BrainMailClientError(400, "account_request_invalid");
    }
    patch.emailAddress = emailAddress;
  }
  if (Object.prototype.hasOwnProperty.call(value, "displayName")) {
    const displayName = validateDisplayName(value.displayName);
    patch.displayName = displayName ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(value, "imap")) {
    if (
      !isRecordWithFields(
        value.imap,
        [],
        ["hostname", "password", "port", "tls", "username"],
      ) ||
      Reflect.ownKeys(value.imap).length === 0
    ) {
      throw new BrainMailClientError(400, "account_request_invalid");
    }
    const imap: {
      hostname?: string;
      port?: number;
      tls?: MailTlsMode;
      username?: string;
      password?: string | null;
    } = {};
    if (Object.prototype.hasOwnProperty.call(value.imap, "hostname")) {
      const hostname = boundedString(value.imap.hostname, 253, false);
      if (!hostname || /[\u0000\r\n]/.test(hostname)) {
        throw new BrainMailClientError(400, "account_request_invalid");
      }
      imap.hostname = hostname;
    }
    if (Object.prototype.hasOwnProperty.call(value.imap, "port")) {
      if (
        !Number.isSafeInteger(value.imap.port) ||
        (value.imap.port as number) < 1 ||
        (value.imap.port as number) > 65_535
      ) {
        throw new BrainMailClientError(400, "account_request_invalid");
      }
      imap.port = value.imap.port as number;
    }
    if (Object.prototype.hasOwnProperty.call(value.imap, "tls")) {
      if (value.imap.tls !== "implicit" && value.imap.tls !== "starttls") {
        throw new BrainMailClientError(400, "account_request_invalid");
      }
      imap.tls = value.imap.tls;
    }
    if (Object.prototype.hasOwnProperty.call(value.imap, "username")) {
      const username = boundedString(value.imap.username, 512, true);
      if (!username || /[\u0000\r\n]/.test(username)) {
        throw new BrainMailClientError(400, "account_request_invalid");
      }
      imap.username = username;
    }
    if (Object.prototype.hasOwnProperty.call(value.imap, "password")) {
      if (value.imap.password === null || value.imap.password === "") {
        imap.password = null;
      } else {
        const password = boundedString(value.imap.password, 4 * 1024, true);
        if (!password || password.includes("\u0000")) {
          throw new BrainMailClientError(400, "account_request_invalid");
        }
        imap.password = password;
      }
    }
    patch.imap = Object.freeze(imap);
  }
  if (Object.prototype.hasOwnProperty.call(value, "smtp")) {
    if (value.smtp === null) {
      patch.smtp = null;
    } else {
      if (
        !isRecordWithFields(
          value.smtp,
          [],
          ["hostname", "port", "tls", "username"],
        ) ||
        Reflect.ownKeys(value.smtp).length === 0
      ) {
        throw new BrainMailClientError(400, "account_request_invalid");
      }
      const smtp: {
        hostname?: string;
        port?: number;
        tls?: MailTlsMode;
        username?: string;
      } = {};
      if (Object.prototype.hasOwnProperty.call(value.smtp, "hostname")) {
        const hostname = boundedString(value.smtp.hostname, 253, false);
        if (!hostname || /[\u0000\r\n]/.test(hostname)) {
          throw new BrainMailClientError(400, "account_request_invalid");
        }
        smtp.hostname = hostname;
      }
      if (Object.prototype.hasOwnProperty.call(value.smtp, "port")) {
        if (
          !Number.isSafeInteger(value.smtp.port) ||
          (value.smtp.port as number) < 1 ||
          (value.smtp.port as number) > 65_535
        ) {
          throw new BrainMailClientError(400, "account_request_invalid");
        }
        smtp.port = value.smtp.port as number;
      }
      if (Object.prototype.hasOwnProperty.call(value.smtp, "tls")) {
        if (value.smtp.tls !== "implicit" && value.smtp.tls !== "starttls") {
          throw new BrainMailClientError(400, "account_request_invalid");
        }
        smtp.tls = value.smtp.tls;
      }
      if (Object.prototype.hasOwnProperty.call(value.smtp, "username")) {
        const username = boundedString(value.smtp.username, 512, true);
        if (!username || /[\u0000\r\n]/.test(username)) {
          throw new BrainMailClientError(400, "account_request_invalid");
        }
        smtp.username = username;
      }
      patch.smtp = Object.freeze(smtp);
    }
  }
  return Object.freeze(patch);
}

function validatePublicAccount(value: unknown): PublicMailAccount {
  if (
    !isRecordWithFields(
      value,
      ["accountId", "emailAddress", "imap", "connectedAt"],
      ["smtp"],
    ) ||
    !isExactRecord(value.imap, ["hostname", "port", "tls", "username"]) ||
    typeof value.accountId !== "string" ||
    !SAFE_ACCOUNT_ID.test(value.accountId)
  ) {
    throw invalidResponse();
  }
  const emailAddress = boundedString(value.emailAddress, 320, false);
  const hostname = boundedString(value.imap.hostname, 253, false);
  const username = boundedString(value.imap.username, 512, true);
  if (
    !emailAddress ||
    !hostname ||
    !username ||
    /[\u0000-\u0020\u007f]/.test(emailAddress) ||
    /[\u0000\r\n]/.test(hostname) ||
    /[\u0000\r\n]/.test(username) ||
    !Number.isSafeInteger(value.imap.port) ||
    (value.imap.port as number) < 1 ||
    (value.imap.port as number) > 65_535 ||
    (value.imap.tls !== "implicit" && value.imap.tls !== "starttls") ||
    !Number.isSafeInteger(value.connectedAt) ||
    (value.connectedAt as number) < 0 ||
    (value.connectedAt as number) > Date.now() + MAX_CONNECTED_AT_FUTURE_SKEW_MS
  ) {
    throw invalidResponse();
  }

  const smtp = Object.prototype.hasOwnProperty.call(value, "smtp")
    ? validateSmtpEndpoint(value.smtp, "response")
    : undefined;
  return Object.freeze({
    accountId: value.accountId,
    emailAddress,
    imap: Object.freeze({
      hostname,
      port: value.imap.port as number,
      tls: value.imap.tls,
      username,
    }),
    ...(smtp ? { smtp } : {}),
    connectedAt: value.connectedAt as number,
  });
}

function validatePublicAccountV2(value: unknown): PublicMailAccountV2 {
  if (!isRecordWithFields(
    value,
    [
      "accountId",
      "connectedAt",
      "createdAt",
      "displayName",
      "emailAddress",
      "providerKind",
      "status",
      "updatedAt",
    ],
    ["imap", "smtp"],
  )) {
    throw invalidResponse();
  }
  const expectedKeys =
    value.providerKind === "imap"
      ? Object.prototype.hasOwnProperty.call(value, "smtp")
        ? 10
        : 9
      : 8;
  if (
    Reflect.ownKeys(value).length !== expectedKeys ||
    typeof value.accountId !== "string" ||
    !SAFE_ACCOUNT_ID.test(value.accountId) ||
    (value.providerKind !== "imap" && value.providerKind !== "gmail") ||
    (value.status !== "connected" && value.status !== "reauth_required") ||
    (value.displayName !== null && typeof value.displayName !== "string")
  ) {
    throw invalidResponse();
  }
  const displayName =
    value.displayName === null
      ? null
      : boundedString(value.displayName, 256, false);
  if (
    (value.displayName !== null &&
      (!displayName ||
        displayName !== value.displayName ||
        /[\u0000-\u001f\u007f]/.test(displayName)))
  ) {
    throw invalidResponse();
  }
  const emailAddress = boundedString(value.emailAddress, 320, false);
  if (
    !emailAddress ||
    /[\u0000-\u0020\u007f]/.test(emailAddress) ||
    !/^[^@]+@[^@.]+(?:\.[^@.]+)+$/.test(emailAddress)
  ) {
    throw invalidResponse();
  }
  const timestamps = [value.connectedAt, value.createdAt, value.updatedAt];
  if (
    timestamps.some(
      (timestamp) =>
        !Number.isSafeInteger(timestamp) ||
        (timestamp as number) < 0 ||
        (timestamp as number) > Date.now() + MAX_CONNECTED_AT_FUTURE_SKEW_MS,
    ) ||
    (value.updatedAt as number) < (value.createdAt as number)
  ) {
    throw invalidResponse();
  }
  const common = {
    accountId: value.accountId,
    emailAddress,
    displayName,
    status: value.status as MailAccountLifecycleStatus,
    connectedAt: value.connectedAt as number,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
  };
  if (value.providerKind === "gmail") {
    return Object.freeze({ ...common, providerKind: "gmail" });
  }
  if (!isExactRecord(value.imap, ["hostname", "port", "tls", "username"])) {
    throw invalidResponse();
  }
  const legacy = validatePublicAccount({
    accountId: value.accountId,
    emailAddress,
    connectedAt: value.connectedAt,
    imap: value.imap,
    ...(Object.prototype.hasOwnProperty.call(value, "smtp")
      ? { smtp: value.smtp }
      : {}),
  });
  return Object.freeze({
    ...common,
    providerKind: "imap",
    imap: legacy.imap,
    ...(legacy.smtp ? { smtp: legacy.smtp } : {}),
  });
}

function validatePublicAccountV3(value: unknown): PublicMailAccountV3 {
  if (
    !isPlainRecord(value) ||
    (value.providerKind !== "imap" && value.providerKind !== "gmail")
  ) {
    throw invalidResponse();
  }
  const fields = [
    "accountId",
    "capabilities",
    "connectedAt",
    "createdAt",
    "displayName",
    "emailAddress",
    "providerKind",
    "status",
    "updatedAt",
    ...(value.providerKind === "imap"
      ? [
          "imap",
          ...(Object.prototype.hasOwnProperty.call(value, "smtp")
            ? ["smtp"]
            : []),
        ]
      : []),
  ];
  if (!isExactRecord(value, fields)) throw invalidResponse();
  const account = validatePublicAccountV2(
    value.providerKind === "imap"
      ? {
          accountId: value.accountId,
          connectedAt: value.connectedAt,
          createdAt: value.createdAt,
          displayName: value.displayName,
          emailAddress: value.emailAddress,
          imap: value.imap,
          ...(Object.prototype.hasOwnProperty.call(value, "smtp")
            ? { smtp: value.smtp }
            : {}),
          providerKind: value.providerKind,
          status: value.status,
          updatedAt: value.updatedAt,
        }
      : {
          accountId: value.accountId,
          connectedAt: value.connectedAt,
          createdAt: value.createdAt,
          displayName: value.displayName,
          emailAddress: value.emailAddress,
          providerKind: value.providerKind,
          status: value.status,
          updatedAt: value.updatedAt,
        },
  );
  const capabilities = mailAccountCapabilities(
    account.providerKind,
    account.providerKind === "gmail" ||
      (account.smtp !== undefined &&
        isPlainRecord(value.capabilities) &&
        value.capabilities.send === true),
  );
  validateCapabilities(value.capabilities, capabilities);
  return Object.freeze({ ...account, capabilities });
}

function validateCapabilities(
  value: unknown,
  expected: MailAccountCapabilities,
): void {
  if (
    !isExactRecord(value, [
      "compose",
      "headerPreview",
      "listThreads",
      "mailboxes",
      "messageBodies",
      "reply",
      "send",
      "sync",
      "threadMutations",
    ]) ||
    !Array.isArray(value.mailboxes) ||
    value.mailboxes.length !== expected.mailboxes.length ||
    value.mailboxes.some((mailbox, index) => mailbox !== expected.mailboxes[index]) ||
    value.listThreads !== expected.listThreads ||
    value.sync !== expected.sync ||
    value.headerPreview !== expected.headerPreview ||
    value.messageBodies !== expected.messageBodies ||
    value.threadMutations !== expected.threadMutations ||
    value.compose !== expected.compose ||
    value.send !== expected.send ||
    value.reply !== expected.reply
  ) {
    throw invalidResponse();
  }
}

function validateServiceError(value: unknown): string {
  if (
    !isExactRecord(value, ["apiVersion", "error"]) ||
    value.apiVersion !== 1 ||
    !isExactRecord(value.error, ["code"]) ||
    typeof value.error.code !== "string"
  ) {
    throw invalidResponse();
  }
  if (value.error.code === "request_deadline_exceeded") {
    return "mail_service_timeout";
  }
  if (!SAFE_SERVICE_ERROR_CODES.has(value.error.code)) throw invalidResponse();
  return value.error.code;
}

function validateSocketPath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.length > 4096 ||
    value.includes("\u0000")
  ) {
    throw new BrainMailClientError(503, "mail_service_unavailable");
  }
  return value;
}

function validateRequestTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > REQUEST_TIMEOUT_MS) {
    throw new BrainMailClientError(503, "mail_service_unavailable");
  }
  return value;
}

function boundedString(
  value: unknown,
  maxBytes: number,
  preserveWhitespace: boolean,
  allowEmpty = false,
): string {
  if (typeof value !== "string") return "";
  const normalized = preserveWhitespace ? value : value.trim();
  if ((!allowEmpty && normalized.length === 0) || Buffer.byteLength(normalized) > maxBytes) {
    return "";
  }
  return normalized;
}

function validateSmtpEndpoint(
  value: unknown,
  mode: "request" | "response",
): NonNullable<MailAccountConnectInput["smtp"]> {
  const fail = (): never => {
    if (mode === "request") {
      throw new BrainMailClientError(400, "account_request_invalid");
    }
    throw invalidResponse();
  };
  if (!isExactRecord(value, ["hostname", "port", "tls", "username"])) {
    return fail();
  }
  const hostname = boundedString(value.hostname, 253, false);
  const username = boundedString(value.username, 512, true);
  if (
    !hostname ||
    !username ||
    /[\u0000\r\n]/.test(hostname) ||
    /[\u0000\r\n]/.test(username) ||
    !Number.isSafeInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    (value.tls !== "implicit" && value.tls !== "starttls")
  ) {
    return fail();
  }
  return Object.freeze({
    hostname,
    port: value.port as number,
    tls: value.tls,
    username,
  });
}

function validateDisplayName(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const displayName = boundedString(value, 256, false);
  if (!displayName || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw new BrainMailClientError(400, "account_request_invalid");
  }
  return displayName;
}

function accountPathV2(accountId: string): string {
  if (typeof accountId !== "string" || !SAFE_ACCOUNT_ID.test(accountId)) {
    throw new BrainMailClientError(400, "account_request_invalid");
  }
  return `${ACCOUNTS_PATH}/${accountId}`;
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key)) &&
    fields.every((field) => {
      const descriptor = descriptors[field];
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function isRecordWithFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const allowed = [...required, ...optional];
  return (
    required.every((field) => Object.prototype.hasOwnProperty.call(value, field)) &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        allowed.includes(key) &&
        descriptors[key] !== undefined &&
        "value" in descriptors[key],
    )
  );
}

function safeServiceStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

/**
 * The failures the mail service cannot record for itself.
 *
 * A code the service coined is already in the service's own log, so repeating
 * it here would only double the line. These three are the ones where the
 * service's answer was never heard: it did not respond in time, it could not be
 * reached, or it answered something this client refused to read. Each of them
 * reaches the browser as a bare 5xx and used to leave nothing behind on either
 * side of the socket.
 *
 * A cancelled request is not here. The browser dropping a read it no longer
 * needs is an ordinary thing that happens on every thread switch.
 */
/** Only ever used to split a service path from its query. */
const PHASE_BASE = "http://brain-mail.invalid";

const PROXY_OWNED_ERROR_CODES = new Set([
  "mail_service_invalid_response",
  "mail_service_timeout",
  "mail_service_unavailable",
]);

function logProxyFailure(
  error: BrainMailClientError,
  method: string,
  requestPath: string,
): void {
  if (!PROXY_OWNED_ERROR_CODES.has(error.code)) return;
  writeMailLogRecord({
    event: "mail_proxy_request_failed",
    errorCode: error.code,
    // The path holds thread and message ids. Only its family travels.
    phase: mailRequestPhase(method, new URL(requestPath, PHASE_BASE).pathname),
  });
}


function invalidResponse(): BrainMailClientError {
  return new BrainMailClientError(502, "mail_service_invalid_response");
}

function serviceUnavailable(): BrainMailClientError {
  return new BrainMailClientError(503, "mail_service_unavailable");
}
