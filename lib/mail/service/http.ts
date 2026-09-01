import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  MailServiceHealth,
  MailSystemAdmissionPort,
  MailSystemUsage,
} from "../ports";
import type { MailThreadSort, MailThreadView } from "../message-types";
import { MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY } from "../content-types";
import {
  MAIL_RESOURCE_LIMITS,
  mailRequestPhase,
  validateMailServiceHealth,
  writeMailLogRecord,
} from "../security";
import {
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER,
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE,
  MailAccountError,
  validateMailAccountConnectInput,
  validateMailAccountCreateInput,
  validateMailAccountPatchInput,
} from "./account-types";
import type {
  MailAccountService,
  MailAccountServiceV2,
} from "./accounts";
import {
  AtomicMailSystemAdmission,
  MailAdmissionError,
} from "./admission";
import { MAIL_SERVICE_HTTP_LIMITS } from "./limits";
import {
  GmailOAuthError,
} from "../providers/gmail/oauth";
import {
  GMAIL_OAUTH_SERVICE_PATHS,
} from "../providers/gmail/contract";
import type { GmailOAuthServiceRedirect } from "../providers/gmail/service-adapter";
import {
  MailDraftCodecError,
  validateMailDraftAccountId,
  validateMailDraftCreateInput,
  validateMailDraftDeleteInput,
  validateMailDraftId,
  validateMailDraftMutationInput,
} from "../draft-codec";
import {
  MailDraftError,
  type MailDraftService,
} from "./drafts";
import {
  MailMessageCodecError,
  validateMailListOptions,
  validateMailOperationId,
  validateMailResourceId,
  validateMailSearchInput,
  validateMailSendInput,
  validateMailSyncInput,
  validateMailSystemMailbox,
  validateMailThreadListFilter,
  validateMailThreadMutationInput,
} from "../message-codec";
import { MailCacheError } from "./message-cache";
import {
  MailProviderSyncError,
  type MailMessageService,
} from "./message-service";
import {
  MailSendError,
  type MailSendService,
} from "./outbound";
import {
  MailContentServiceError,
  type MailAttachmentDownload,
  type MailContentService,
} from "./content-coordinator";
import {
  MAIL_THREAD_STATE_CONTRACT_HEADER,
  mailThreadStateContractTier,
  projectMailThreadStateContract,
} from "../thread-contract";

interface GmailOAuthHttpAdapter {
  start(targetAccountId?: string | null): Promise<GmailOAuthServiceRedirect>;
  callback(
    rawQuery: string,
    cookieHeader: string | undefined,
    signal: AbortSignal,
  ): Promise<GmailOAuthServiceRedirect>;
}

export type MailServiceBuildIdentity = MailServiceHealth["build"];

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;

interface MailServiceHttpOptions {
  readonly build: MailServiceBuildIdentity;
  readonly admission?: MailSystemAdmissionPort;
  readonly accounts?: MailAccountService;
  readonly gmailOAuth?: GmailOAuthHttpAdapter;
  readonly messages?: MailMessageService;
  readonly send?: MailSendService;
  readonly drafts?: MailDraftService;
  readonly content?: MailContentService;
}

/**
 * Every stable error code this service can answer with, declared once and in
 * three groups, because the groups mean different things to the one caller
 * that reads them. Brain's client forwards a `relayed` code to the browser
 * unchanged — each exists to tell a surface something it can act on — so
 * `SAFE_SERVICE_ERROR_CODES` in `brain-mail-client.ts` has to hold every one
 * of them, and `proxies every relayed service error code` fails when it does
 * not. A `transport` code means the request never formed, or the route is one
 * only the public proxy reaches; the client collapses those on purpose. The
 * `admission` codes belong to the ledger's own routes, which no surface calls.
 *
 * `MailHttpError` accepts only a code from this set, so a code that reaches
 * the wire — as a literal below or relayed off a typed error class — is a code
 * declared here. A new code on a message, draft, send, content or account
 * route does not compile until it has a group, and does not pass the test
 * until the client forwards it. For a while the test grepped this file for
 * literals instead, and the twenty-one sites that relay `error.code` were
 * invisible to it; five `smtp_*` codes shipped that way with no place in the
 * forwarding set.
 */
export const MAIL_SERVICE_ERROR_CODES = Object.freeze({
  relayed: Object.freeze([
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
    "mail_content_unavailable",
    "mail_attachment_range_unsupported",
  ] as const),
  transport: Object.freeze([
    "headers_too_large",
    "headers_deadline_exceeded",
    "request_target_invalid",
    "request_invalid",
    "request_aborted",
    "request_deadline_exceeded",
    "request_body_forbidden",
    "request_body_too_large",
    "content_type_invalid",
    "content_length_invalid",
    "content_length_required",
    "json_invalid",
    "route_not_found",
    "method_not_allowed",
    "internal_error",
    // Gmail's browser redirects go through the public proxy, not the client.
    "gmail_oauth_unavailable",
  ] as const),
  admission: Object.freeze([
    "admission_invalid",
    "capacity_exceeded",
    "operation_already_reserved",
    "reservation_not_found",
    "reservation_invalid",
  ] as const),
});

export type MailServiceErrorCode =
  (typeof MAIL_SERVICE_ERROR_CODES)[keyof typeof MAIL_SERVICE_ERROR_CODES][number];

class MailHttpError extends Error {
  readonly status: number;
  readonly code: MailServiceErrorCode;
  readonly closeConnection: boolean;

  constructor(
    status: number,
    code: MailServiceErrorCode,
    closeConnection = false,
  ) {
    super(code);
    this.name = "MailHttpError";
    this.status = status;
    this.code = code;
    this.closeConnection = closeConnection;
  }
}

export function createMailServiceHttpServer(
  options: MailServiceHttpOptions,
): Server {
  const admission = options.admission ?? new AtomicMailSystemAdmission();
  const accounts = options.accounts;
  const gmailOAuth = options.gmailOAuth;
  const messages = options.messages;
  const send = options.send;
  const drafts = options.drafts;
  const content = options.content;
  const build = validateBuildIdentity(options.build);
  const server = createServer(
    {
      maxHeaderSize: MAIL_SERVICE_HTTP_LIMITS.maxHeaderBytes,
      headersTimeout: MAIL_SERVICE_HTTP_LIMITS.headersTimeoutMs,
      requestTimeout: MAIL_SERVICE_HTTP_LIMITS.accountConnectDeadlineMs,
      keepAliveTimeout: MAIL_SERVICE_HTTP_LIMITS.keepAliveTimeoutMs,
      connectionsCheckingInterval:
        MAIL_SERVICE_HTTP_LIMITS.connectionsCheckingIntervalMs,
    },
    (request, response) => {
      void handleRequest(
        request,
        response,
        build,
        admission,
        accounts,
        gmailOAuth,
        messages,
        send,
        drafts,
        content,
      );
    },
  );
  // Parse one sentinel header beyond the accepted limit so the handler can
  // reject overflow instead of silently accepting Node's truncated map.
  server.maxHeadersCount = MAIL_SERVICE_HTTP_LIMITS.maxHeaders + 1;
  server.maxRequestsPerSocket = MAIL_SERVICE_HTTP_LIMITS.maxRequestsPerSocket;
  server.maxConnections = MAIL_SERVICE_HTTP_LIMITS.maxConnections;
  server.on("clientError", (error, socket) => {
    if (!socket.writable) return;
    const errorCode = "code" in error ? error.code : undefined;
    const status =
      errorCode === "HPE_HEADER_OVERFLOW"
        ? 431
        : errorCode === "ERR_HTTP_REQUEST_TIMEOUT"
          ? 408
          : 400;
    const code: MailServiceErrorCode =
      status === 431
        ? "headers_too_large"
        : status === 408
          ? "headers_deadline_exceeded"
          : "request_invalid";
    const reason =
      status === 431
        ? "Request Header Fields Too Large"
        : status === 408
          ? "Request Timeout"
          : "Bad Request";
    const body = JSON.stringify({ apiVersion: 1, error: { code } });
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "Content-Type: application/json; charset=utf-8\r\n" +
        "Cache-Control: no-store\r\n" +
        "X-Content-Type-Options: nosniff\r\n" +
        "Connection: close\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  });
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  build: MailServiceBuildIdentity,
  admission: MailSystemAdmissionPort,
  accounts: MailAccountService | undefined,
  gmailOAuth: GmailOAuthHttpAdapter | undefined,
  messages: MailMessageService | undefined,
  send: MailSendService | undefined,
  drafts: MailDraftService | undefined,
  content: MailContentService | undefined,
): Promise<void> {
  const requestStartedAt = Date.now();
  const deadlineAt =
    requestStartedAt + MAIL_SERVICE_HTTP_LIMITS.requestDeadlineMs;
  const providerOperationDeadlineAt =
    requestStartedAt + MAIL_SERVICE_HTTP_LIMITS.providerOperationDeadlineMs;
  /*
    What a failure will be able to say about itself. Both are set as soon as the
    request is understood well enough to name them, so a throw from anywhere
    below still lands with its route and its account attached. A request that
    fails before its target parses logs \`unknown_route\` instead.
  */
  let requestPhase = "unknown_route";
  let requestAccountId: string | null = null;
  try {
    const method = request.method ?? "";
    if (
      request.rawHeaders.length / 2 > MAIL_SERVICE_HTTP_LIMITS.maxHeaders ||
      request.rawHeaders.reduce(
        (bytes, value) => bytes + Buffer.byteLength(value),
        0,
      ) > MAIL_SERVICE_HTTP_LIMITS.maxHeaderBytes
    ) {
      throw new MailHttpError(431, "headers_too_large", true);
    }
    if (!(request.url ?? "").startsWith("/")) {
      throw new MailHttpError(400, "request_target_invalid", true);
    }
    const url = new URL(request.url ?? "", "http://brain-mail.invalid");
    requestPhase = mailRequestPhase(method, url.pathname);
    // Most routes name their account in the query. The ones that carry it in a
    // body set it again below, once the body has been validated.
    requestAccountId = loggableAccountId(url);
    const threadReadPath = /^\/v1\/threads\/[A-Za-z0-9_-]{1,255}$/.test(
      url.pathname,
    );
    const mailboxThreadListPath =
      /^\/v1\/mailboxes\/[a-z]+\/threads$/.test(url.pathname);
    const mailboxThreadReadPath =
      /^\/v1\/mailboxes\/[a-z]+\/threads\/[A-Za-z0-9_-]{1,255}$/.test(
        url.pathname,
      );
    const messageContentPath =
      /^\/v1\/message-content\/[A-Za-z0-9_-]{1,255}$/.test(url.pathname);
    const attachmentPath =
      /^\/v1\/attachments\/attachment-a[0-9a-f]{32}$/.test(url.pathname);
    const draftReadPath =
      /^\/v1\/drafts\/draft-[0-9a-f-]{36}$/.test(url.pathname);
    const remoteImagePath =
      /^\/v1\/remote-images\/remote-image-a[0-9a-f]{32}$/.test(url.pathname);
    const allowsQuery =
      url.pathname === GMAIL_OAUTH_SERVICE_PATHS.callback ||
      url.pathname === GMAIL_OAUTH_SERVICE_PATHS.start ||
      (method === "GET" &&
        (url.pathname === "/v1/threads" ||
          threadReadPath ||
          mailboxThreadListPath ||
          mailboxThreadReadPath ||
          messageContentPath ||
          attachmentPath ||
          url.pathname === "/v1/drafts" ||
          draftReadPath ||
          remoteImagePath)) ||
      (method === "POST" && messageContentPath);
    if (url.hash || (url.search && !allowsQuery)) {
      throw new MailHttpError(404, "route_not_found");
    }

    if (url.pathname === GMAIL_OAUTH_SERVICE_PATHS.start) {
      if (method !== "POST") throw new MailHttpError(405, "method_not_allowed");
      if (!gmailOAuth) {
        throw new MailHttpError(503, "gmail_oauth_unavailable");
      }
      assertNoRequestBody(request);
      if (request.headers.cookie !== undefined) {
        throw new MailHttpError(400, "request_invalid", true);
      }
      writeRedirect(
        response,
        await beforeRequestDeadline(
          gmailOAuth.start(readOAuthTargetAccountId(url)),
          deadlineAt,
        ),
      );
      return;
    }

    if (url.pathname === GMAIL_OAUTH_SERVICE_PATHS.callback) {
      if (method !== "GET") throw new MailHttpError(405, "method_not_allowed");
      if (!gmailOAuth) {
        throw new MailHttpError(503, "gmail_oauth_unavailable");
      }
      assertNoRequestBody(request);
      const callbackDeadlineAt =
        requestStartedAt + MAIL_SERVICE_HTTP_LIMITS.accountConnectDeadlineMs;
      writeRedirect(
        response,
        await runAccountMutation(
          request,
          response,
          callbackDeadlineAt,
          ({ signal }) =>
            gmailOAuth.callback(url.search, request.headers.cookie, signal),
        ),
      );
      return;
    }

    if (url.pathname === "/v1/health") {
      if (method !== "GET") throw new MailHttpError(405, "method_not_allowed");
      assertNoRequestBody(request);
      const usage = await beforeRequestDeadline(
        admission.readUsage(),
        deadlineAt,
      );
      const accountCount = accounts
        ? await beforeRequestDeadline(
            accounts.accountCount
              ? accounts.accountCount()
              : accounts.status().then((status) => (status.configured ? 1 : 0)),
            deadlineAt,
          )
        : 0;
      const syncHealth = messages?.readBackgroundSyncHealth
        ? await beforeRequestDeadline(
            messages.readBackgroundSyncHealth(),
            deadlineAt,
          )
        : null;
      writeJson(
        response,
        200,
        createHealth(
          build,
          usage,
          accountCount,
          accounts?.localSchemaVersion ?? null,
          messages !== undefined,
          send !== undefined,
          syncHealth,
          requestStartedAt,
        ),
      );
      return;
    }

    const messageContentMatch =
      /^\/v1\/message-content\/([A-Za-z0-9_-]{1,255})$/.exec(url.pathname);
    if (messageContentMatch) {
      const service = requireContentService(content);
      const input = Object.freeze({
        accountId: readExactAccountQuery(url),
        messageId: messageContentMatch[1]!,
      });
      if (method === "GET") {
        assertNoRequestBody(request);
        writeJson(
          response,
          200,
          await beforeRequestDeadline(service.getContent(input), deadlineAt),
        );
        return;
      }
      if (method === "POST") {
        assertNoRequestBody(request);
        writeJson(
          response,
          202,
          await beforeRequestDeadline(service.requestContent(input), deadlineAt),
        );
        return;
      }
      throw new MailHttpError(405, "method_not_allowed");
    }

    const attachmentMatch =
      /^\/v1\/attachments\/(attachment-a[0-9a-f]{32})$/.exec(url.pathname);
    if (attachmentMatch) {
      if (method !== "GET") throw new MailHttpError(405, "method_not_allowed");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      assertNoRequestBody(request);
      if (request.headers.range !== undefined) {
        throw new MailHttpError(416, "mail_attachment_range_unsupported");
      }
      const service = requireContentService(content);
      await streamAttachmentRequest({
        request,
        response,
        admission,
        service,
        input: {
          accountId: readExactAccountQuery(url),
          attachmentId: attachmentMatch[1]!,
        },
        setupDeadlineAt: providerOperationDeadlineAt,
      });
      return;
    }

    const remoteImageMatch =
      /^\/v1\/remote-images\/(remote-image-a[0-9a-f]{32})$/.exec(
        url.pathname,
      );
    if (remoteImageMatch) {
      if (method !== "GET") throw new MailHttpError(405, "method_not_allowed");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      assertNoRequestBody(request);
      if (request.headers.range !== undefined) {
        throw new MailHttpError(416, "mail_attachment_range_unsupported");
      }
      const service = requireContentService(content);
      if (typeof service.downloadRemoteImage !== "function") {
        throw new MailHttpError(503, "mail_content_unavailable", true);
      }
      await streamAttachmentRequest({
        request,
        response,
        admission,
        service,
        input: {
          accountId: readExactAccountQuery(url),
          remoteImageId: remoteImageMatch[1]!,
        },
        setupDeadlineAt: providerOperationDeadlineAt,
      });
      return;
    }

    if (url.pathname === "/v1/threads") {
      if (method !== "GET") throw new MailHttpError(405, "method_not_allowed");
      assertNoRequestBody(request);
      const service = requireMessageService(messages);
      const query = readThreadListQuery(url);
      writeMailThreadJson(
        request,
        response,
        200,
        await beforeRequestDeadline(service.listThreads(query), deadlineAt),
      );
      return;
    }

    if (url.pathname === "/v1/search") {
      if (method !== "POST") throw new MailHttpError(405, "method_not_allowed");
      const service = requireMessageService(messages);
      const input = validateMailSearchInput(
        await readJsonBody(request, deadlineAt),
      );
      writeMailThreadJson(
        request,
        response,
        200,
        await beforeRequestDeadline(service.searchThreads(input), deadlineAt),
      );
      return;
    }

    const mailboxThreadListMatch =
      /^\/v1\/mailboxes\/([a-z]+)\/threads$/.exec(url.pathname);
    if (mailboxThreadListMatch) {
      if (method !== "GET") throw new MailHttpError(405, "method_not_allowed");
      assertNoRequestBody(request);
      const service = requireMessageService(messages);
      const query = readThreadListQuery(url);
      writeMailThreadJson(
        request,
        response,
        200,
        await beforeRequestDeadline(
          service.listMailboxThreads({
            ...query,
            mailboxId: validateMailSystemMailbox(mailboxThreadListMatch[1]),
          }),
          deadlineAt,
        ),
      );
      return;
    }

    const mailboxThreadReadMatch =
      /^\/v1\/mailboxes\/([a-z]+)\/threads\/([A-Za-z0-9_-]{1,255})$/.exec(
        url.pathname,
      );
    if (mailboxThreadReadMatch) {
      if (method !== "GET") throw new MailHttpError(405, "method_not_allowed");
      assertNoRequestBody(request);
      const service = requireMessageService(messages);
      const detail = await beforeRequestDeadline(
        service.getMailboxThread({
          accountId: readExactAccountQuery(url),
          mailboxId: validateMailSystemMailbox(mailboxThreadReadMatch[1]),
          threadId: validateMailResourceId(mailboxThreadReadMatch[2]),
        }),
        deadlineAt,
      );
      if (detail === null) throw new MailHttpError(404, "mail_thread_not_found");
      writeMailThreadJson(request, response, 200, detail);
      return;
    }

    const threadMatch = /^\/v1\/threads\/([A-Za-z0-9_-]{1,255})$/.exec(
      url.pathname,
    );
    if (threadMatch) {
      const service = requireMessageService(messages);
      const threadId = validateMailResourceId(threadMatch[1]);
      if (method === "GET") {
        assertNoRequestBody(request);
        const accountId = readExactAccountQuery(url);
        const detail = await beforeRequestDeadline(
          service.getThread({ accountId, threadId }),
          deadlineAt,
        );
        if (detail === null) throw new MailHttpError(404, "mail_thread_not_found");
        writeMailThreadJson(request, response, 200, detail);
        return;
      }
      if (method === "PATCH") {
        const mutation = validateMailThreadMutationInput(
          await readJsonBody(request, deadlineAt),
        );
        requestAccountId = mutation.accountId;
        writeMailThreadJson(
          request,
          response,
          200,
          await runAccountMutation(
            request,
            response,
            providerOperationDeadlineAt,
            ({ signal }) =>
              service.updateThread({ ...mutation, threadId }, signal),
          ),
        );
        return;
      }
      throw new MailHttpError(405, "method_not_allowed");
    }

    if (url.pathname === "/v1/sync") {
      if (method !== "POST") throw new MailHttpError(405, "method_not_allowed");
      const service = requireMessageService(messages);
      const input = validateMailSyncInput(await readJsonBody(request, deadlineAt));
      writeJson(
        response,
        200,
        await runAccountMutation(
          request,
          response,
          providerOperationDeadlineAt,
          ({ signal }) => service.sync(input, signal),
        ),
      );
      return;
    }

    if (url.pathname === "/v1/drafts") {
      const service = requireDraftService(drafts);
      if (method === "GET") {
        assertNoRequestBody(request);
        writeJson(
          response,
          200,
          await beforeRequestDeadline(
            service.list(readExactDraftAccountQuery(url)),
            deadlineAt,
          ),
        );
        return;
      }
      if (method === "POST") {
        const input = validateMailDraftCreateInput(
          await readJsonBody(
            request,
            deadlineAt,
            MAIL_SERVICE_HTTP_LIMITS.maxDraftBodyBytes,
          ),
        );
        const result = await runAccountMutation(
          request,
          response,
          deadlineAt,
          (context) => service.create(input, context),
        );
        writeJson(response, result.created ? 201 : 200, result);
        return;
      }
      throw new MailHttpError(405, "method_not_allowed");
    }

    const draftSendMatch =
      /^\/v1\/drafts\/(draft-[0-9a-f-]{36})\/send$/.exec(url.pathname);
    if (draftSendMatch) {
      if (method !== "POST") throw new MailHttpError(405, "method_not_allowed");
      const service = requireDraftService(drafts);
      const draftId = validateMailDraftId(draftSendMatch[1]);
      const mutation = validateMailDraftMutationInput(
        await readJsonBody(
          request,
          deadlineAt,
          MAIL_SERVICE_HTTP_LIMITS.maxDraftBodyBytes,
        ),
      );
      if (mutation.kind !== "send" || mutation.draftId !== draftId) {
        throw new MailDraftError("mail_draft_request_invalid");
      }
      writeJson(
        response,
        202,
        await runAccountMutation(
          request,
          response,
          providerOperationDeadlineAt,
          (context) => service.send(mutation, context),
        ),
      );
      return;
    }

    const draftMatch = /^\/v1\/drafts\/(draft-[0-9a-f-]{36})$/.exec(
      url.pathname,
    );
    if (draftMatch) {
      const service = requireDraftService(drafts);
      const draftId = validateMailDraftId(draftMatch[1]);
      if (method === "GET") {
        assertNoRequestBody(request);
        writeJson(
          response,
          200,
          await beforeRequestDeadline(
            service.read(readExactDraftAccountQuery(url), draftId),
            deadlineAt,
          ),
        );
        return;
      }
      if (method === "PATCH") {
        const mutation = validateMailDraftMutationInput(
          await readJsonBody(
            request,
            deadlineAt,
            MAIL_SERVICE_HTTP_LIMITS.maxDraftBodyBytes,
          ),
        );
        if (mutation.kind !== "patch" || mutation.draftId !== draftId) {
          throw new MailDraftError("mail_draft_request_invalid");
        }
        writeJson(
          response,
          200,
          await runAccountMutation(
            request,
            response,
            deadlineAt,
            (context) => service.mutate(mutation, context),
          ),
        );
        return;
      }
      if (method === "DELETE") {
        const deletion = validateMailDraftDeleteInput(
          await readJsonBody(request, deadlineAt),
        );
        if (deletion.draftId !== draftId) {
          throw new MailDraftError("mail_draft_request_invalid");
        }
        writeJson(
          response,
          200,
          await runAccountMutation(
            request,
            response,
            deadlineAt,
            (context) => service.delete(deletion, context),
          ),
        );
        return;
      }
      throw new MailHttpError(405, "method_not_allowed");
    }

    if (url.pathname === "/v1/send") {
      if (method !== "POST") throw new MailHttpError(405, "method_not_allowed");
      const service = requireSendService(send);
      const input = validateMailSendInput(
        await readJsonBody(
          request,
          deadlineAt,
          MAIL_SERVICE_HTTP_LIMITS.maxSendBodyBytes,
        ),
      );
      writeJson(
        response,
        202,
        await runAccountMutation(
          request,
          response,
          providerOperationDeadlineAt,
          (context) => service.send(input, context),
        ),
      );
      return;
    }

    const sendMatch = /^\/v1\/send\/([A-Za-z0-9_-]{1,128})$/.exec(
      url.pathname,
    );
    if (sendMatch) {
      if (method !== "GET") throw new MailHttpError(405, "method_not_allowed");
      assertNoRequestBody(request);
      const service = requireSendService(send);
      writeJson(
        response,
        200,
        await beforeRequestDeadline(
          service.status(validateMailOperationId(sendMatch[1])),
          deadlineAt,
        ),
      );
      return;
    }

    if (url.pathname === "/v2/accounts") {
      const accountsV2 = requireAccountsV2(accounts);
      if (method === "GET") {
        assertNoRequestBody(request);
        const status = wantsMailAccountCapabilities(request)
          ? await beforeRequestDeadline(
              accountsV2.listCapabilities(),
              deadlineAt,
            )
          : await beforeRequestDeadline(accountsV2.list(), deadlineAt);
        writeJson(
          response,
          200,
          status,
        );
        return;
      }
      if (method === "POST") {
        const connectDeadlineAt =
          requestStartedAt + MAIL_SERVICE_HTTP_LIMITS.accountConnectDeadlineMs;
        const input = validateMailAccountCreateInput(
          await readJsonBody(request, connectDeadlineAt),
        );
        writeJson(
          response,
          201,
          await runAccountMutation(
            request,
            response,
            connectDeadlineAt,
            (context) => accountsV2.add(input, context),
          ),
        );
        return;
      }
      throw new MailHttpError(405, "method_not_allowed");
    }

    const accountV2Match =
      /^\/v2\/accounts\/(account-a[0-9a-f]{32})$/.exec(url.pathname);
    if (accountV2Match) {
      const accountsV2 = requireAccountsV2(accounts);
      const accountId = accountV2Match[1];
      if (method === "PATCH") {
        const connectDeadlineAt =
          requestStartedAt + MAIL_SERVICE_HTTP_LIMITS.accountConnectDeadlineMs;
        const patch = validateMailAccountPatchInput(
          await readJsonBody(request, connectDeadlineAt),
        );
        writeJson(
          response,
          200,
          await runAccountMutation(
            request,
            response,
            connectDeadlineAt,
            (context) => accountsV2.update(accountId, patch, context),
          ),
        );
        return;
      }
      if (method === "DELETE") {
        assertNoRequestBody(request);
        writeJson(
          response,
          200,
          await runAccountMutation(request, response, deadlineAt, (context) =>
            accountsV2.remove(accountId, context),
          ),
        );
        return;
      }
      throw new MailHttpError(405, "method_not_allowed");
    }

    if (url.pathname === "/v1/account") {
      if (!accounts) throw new MailHttpError(503, "account_unavailable");
      if (method === "GET") {
        assertNoRequestBody(request);
        writeJson(
          response,
          200,
          await beforeRequestDeadline(accounts.status(), deadlineAt),
        );
        return;
      }
      if (method === "POST") {
        const connectDeadlineAt =
          requestStartedAt + MAIL_SERVICE_HTTP_LIMITS.accountConnectDeadlineMs;
        const body = await readJsonBody(request, connectDeadlineAt);
        const input = validateMailAccountConnectInput(body);
        writeJson(
          response,
          200,
          await runAccountMutation(request, response, connectDeadlineAt, (context) =>
            accounts.connect(input, context),
          ),
        );
        return;
      }
      if (method === "DELETE") {
        assertNoRequestBody(request);
        writeJson(
          response,
          200,
          await runAccountMutation(request, response, deadlineAt, (context) =>
            accounts.disconnect(context),
          ),
        );
        return;
      }
      throw new MailHttpError(405, "method_not_allowed");
    }

    if (url.pathname === "/v1/admission") {
      if (method !== "GET") throw new MailHttpError(405, "method_not_allowed");
      assertNoRequestBody(request);
      writeJson(response, 200, {
        apiVersion: 1,
        usage: await beforeRequestDeadline(admission.readUsage(), deadlineAt),
      });
      return;
    }

    if (url.pathname === "/v1/admission/reservations") {
      if (method !== "POST") throw new MailHttpError(405, "method_not_allowed");
      const body = await readJsonBody(request, deadlineAt);
      const reservation = validateReservationRequest(body);
      const result = await beforeRequestDeadline(
        admission.reserve(reservation.operationId, reservation.delta),
        deadlineAt,
      );
      writeJson(response, 201, { apiVersion: 1, ...result });
      return;
    }

    const releaseMatch = /^\/v1\/admission\/reservations\/(reservation-r[0-9a-f]{32})$/.exec(
      url.pathname,
    );
    if (releaseMatch) {
      if (method !== "DELETE") {
        throw new MailHttpError(405, "method_not_allowed");
      }
      assertNoRequestBody(request);
      await beforeRequestDeadline(
        admission.release(releaseMatch[1]),
        deadlineAt,
      );
      response.statusCode = 204;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end();
      return;
    }

    throw new MailHttpError(404, "route_not_found");
  } catch (error) {
    const httpError = toHttpError(error);
    if (response.headersSent || response.writableEnded || response.destroyed) {
      request.pause();
      response.shouldKeepAlive = false;
      if (!response.destroyed) response.destroy();
      logRequestFailure(httpError, requestPhase, requestAccountId);
      return;
    }
    if (httpError.closeConnection) {
      request.pause();
      response.shouldKeepAlive = false;
      response.setHeader("Connection", "close");
    }
    writeJson(response, httpError.status, {
      apiVersion: 1,
      error: { code: httpError.code },
    });
    logRequestFailure(httpError, requestPhase, requestAccountId);
  }
}

/**
 * Every answered failure, not only the ones that crashed.
 *
 * The threshold used to be 500, which made an outage loud and a refusal silent.
 * The refusals are the half worth having: a 409 saying an account's server has
 * no folder for an archive, a 404 for a thread the reader can still see, a 429
 * from a provider — each of them is a decision the service made about the
 * owner's mail, and each of them used to leave nothing behind. A record carries
 * the stable code, the route family and the account, all three already on the
 * section 13 allowlist. The projection drops anything else, including an
 * account id that does not look like one.
 */
function logRequestFailure(
  httpError: MailHttpError,
  phase: string,
  accountId: string | null,
): void {
  writeMailLogRecord({
    event: "mail_request_failed",
    errorCode: httpError.code,
    phase,
    ...(accountId === null ? {} : { accountId }),
  });
}

/**
 * The account a record may name: the one the query carries, and only when it
 * has the shape of one. The log projection admits any 128-character
 * identifier, which is wide enough for a token pasted into `accountId`, so
 * the shape is checked here rather than trusted there. The route refuses the
 * request either way; this is about what the refusal writes down.
 */
function loggableAccountId(url: URL): string | null {
  const accountId = url.searchParams.get("accountId");
  return accountId !== null && SAFE_ACCOUNT_ID.test(accountId)
    ? accountId
    : null;
}

function wantsMailAccountCapabilities(request: IncomingMessage): boolean {
  return (
    request.headers[MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER] ===
    MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE
  );
}

function createHealth(
  build: MailServiceBuildIdentity,
  usage: MailSystemUsage,
  accountCount = 0,
  localSchemaVersion: number | null = null,
  messagesConfigured = false,
  sendConfigured = false,
  syncHealth: {
    readonly lastSuccessfulAt: number | null;
    readonly lastErrorCode: string | null;
  } | null = null,
  now = Date.now(),
): MailServiceHealth {
  const activeAccounts = Math.max(accountCount, usage.accounts);
  const cacheSchemaVersion = messagesConfigured ? 1 : null;
  const lastErrorCode = syncHealth?.lastErrorCode ?? null;
  const lastSuccessfulAt = syncHealth?.lastSuccessfulAt ?? null;
  /*
    Readiness is an answer about the accounts, not a placeholder. The evidence
    the service has without dialling a provider is what the background sync
    already recorded: the oldest completed refresh across every account and
    hidden mailbox, and the worst error any of them holds — `readBackgroundSyncHealth`
    aggregates both, so one account in reauth is enough to speak here.

    A readiness may only claim `ready` once its schemas exist, and the
    validator refuses the pair otherwise. A service that reported `ready` before its
    cache was built would be making the same empty promise in the other
    direction. Receive additionally needs one completed sync — never having
    synced is not the same as being healthy. Send does not: a queue can accept
    a letter on an account whose first sync is still running, and only a
    recorded error (reauth included) takes that away.
  */
  const receiveReadiness =
    !messagesConfigured || activeAccounts === 0
      ? "not_configured"
      : lastErrorCode !== null ||
          lastSuccessfulAt === null ||
          localSchemaVersion === null ||
          cacheSchemaVersion === null
        ? "degraded"
        : "ready";
  const sendReadiness =
    !sendConfigured || activeAccounts === 0
      ? "not_configured"
      : lastErrorCode !== null || localSchemaVersion === null
        ? "degraded"
        : "ready";
  return validateMailServiceHealth({
    apiVersion: 1,
    build,
    status:
      receiveReadiness === "degraded" ||
      sendReadiness === "degraded" ||
      lastErrorCode !== null
        ? "degraded"
        : "ok",
    localSchemaVersion,
    cacheSchemaVersion,
    receiveReadiness,
    sendReadiness,
    activeAccounts,
    queuedSubmissions: usage.queuedSubmissions,
    lastSuccessfulSyncAgeMs:
      lastSuccessfulAt === null ? null : Math.max(0, now - lastSuccessfulAt),
    cachePressure: "normal",
    lastErrorCode,
  });
}

function validateBuildIdentity(
  build: MailServiceBuildIdentity,
): MailServiceBuildIdentity {
  return validateMailServiceHealth({
    apiVersion: 1,
    build,
    status: "ok",
    localSchemaVersion: null,
    cacheSchemaVersion: null,
    receiveReadiness: "not_configured",
    sendReadiness: "not_configured",
    activeAccounts: 0,
    queuedSubmissions: 0,
    lastSuccessfulSyncAgeMs: null,
    cachePressure: "normal",
    lastErrorCode: null,
  }).build;
}

async function readJsonBody(
  request: IncomingMessage,
  deadlineAt: number,
  maxBodyBytes = MAIL_SERVICE_HTTP_LIMITS.maxBodyBytes,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > MAIL_SERVICE_HTTP_LIMITS.maxDraftBodyBytes
  ) {
    throw new MailHttpError(400, "request_invalid", true);
  }
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw new MailHttpError(415, "content_type_invalid", true);
  }
  const declaredLength = request.headers["content-length"];
  if (request.headers["transfer-encoding"] !== undefined) {
    throw new MailHttpError(400, "content_length_invalid", true);
  }
  if (declaredLength === undefined) {
    throw new MailHttpError(411, "content_length_required", true);
  }
  if (
    typeof declaredLength !== "string" ||
    !/^\d+$/.test(declaredLength)
  ) {
    throw new MailHttpError(400, "content_length_invalid", true);
  }
  if (
    Number(declaredLength) > maxBodyBytes
  ) {
    throw new MailHttpError(413, "request_body_too_large", true);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  const body = await new Promise<Buffer>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const fail = (error: MailHttpError) => {
      cleanup();
      request.pause();
      chunks.forEach((chunk) => chunk.fill(0));
      chunks.length = 0;
      bytes = 0;
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        fail(new MailHttpError(413, "request_body_too_large", true));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      cleanup();
      try {
        const body = Buffer.concat(chunks, bytes);
        chunks.forEach((chunk) => chunk.fill(0));
        chunks.length = 0;
        resolve(body);
      } catch {
        chunks.forEach((chunk) => chunk.fill(0));
        chunks.length = 0;
        reject(new MailHttpError(400, "request_invalid", true));
      }
    };
    const onAborted = () => fail(new MailHttpError(400, "request_aborted", true));
    const onError = () => fail(new MailHttpError(400, "request_invalid", true));
    const timer = setTimeout(
      () => fail(new MailHttpError(408, "request_deadline_exceeded", true)),
      Math.max(0, deadlineAt - Date.now()),
    );
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text);
  } catch {
    throw new MailHttpError(400, "json_invalid", true);
  } finally {
    body.fill(0);
  }
}

async function beforeRequestDeadline<T>(
  action: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new MailHttpError(408, "request_deadline_exceeded", true),
            ),
          Math.max(0, deadlineAt - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runAccountMutation<T>(
  request: IncomingMessage,
  response: ServerResponse,
  deadlineAt: number,
  operation: (context: {
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnResponseClose = () => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", abort);
  response.once("close", abortOnResponseClose);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Give an already-transmitted FIN/RST one event-loop turn to surface after
    // body parsing, then close the tiny gap before the mutation is admitted.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (
      request.aborted ||
      request.socket.destroyed ||
      response.destroyed
    ) {
      controller.abort();
      throw new MailAccountError("imap_connection_timeout");
    }
    const action = operation({ deadlineAt, signal: controller.signal });
    timer = setTimeout(
      () => controller.abort(),
      Math.max(0, deadlineAt - Date.now()),
    );
    return await action;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.off("aborted", abort);
    response.off("close", abortOnResponseClose);
  }
}

function validateReservationRequest(value: unknown): {
  readonly operationId: string;
  readonly delta: Partial<MailSystemUsage>;
} {
  if (!isPlainRecord(value)) {
    throw new MailHttpError(400, "reservation_invalid");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "delta" || keys[1] !== "operationId") {
    throw new MailHttpError(400, "reservation_invalid");
  }
  if (typeof value.operationId !== "string" || !isPlainRecord(value.delta)) {
    throw new MailHttpError(400, "reservation_invalid");
  }
  return {
    operationId: value.operationId,
    delta: value.delta as Partial<MailSystemUsage>,
  };
}

function assertNoRequestBody(request: IncomingMessage): void {
  const length = request.headers["content-length"];
  if (
    request.headers["transfer-encoding"] !== undefined ||
    (length !== undefined && length !== "0")
  ) {
    throw new MailHttpError(400, "request_body_forbidden", true);
  }
}

function readOAuthTargetAccountId(url: URL): string | null {
  if (!url.search) return null;
  if (
    url.searchParams.size !== 1 ||
    url.searchParams.getAll("accountId").length !== 1
  ) {
    throw new MailHttpError(400, "request_invalid", true);
  }
  const accountId = url.searchParams.get("accountId");
  if (!accountId || !SAFE_ACCOUNT_ID.test(accountId)) {
    throw new MailHttpError(400, "request_invalid", true);
  }
  return accountId;
}

function readThreadListQuery(url: URL): {
  readonly accountId: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly view: MailThreadView | null;
  readonly sort: MailThreadSort;
} {
  assertExactQuery(
    url.searchParams,
    ["accountId"],
    ["cursor", "limit", "view", "sort"],
  );
  const accountId = url.searchParams.get("accountId");
  if (accountId === null) throw new MailHttpError(400, "mail_request_invalid");
  const cursor = url.searchParams.get("cursor");
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^\d{1,3}$/.test(rawLimit)) {
    throw new MailHttpError(400, "mail_request_invalid");
  }
  const options = validateMailListOptions({
    cursor,
    ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
  });
  const filter = validateMailThreadListFilter({
    view: url.searchParams.get("view"),
    sort: url.searchParams.get("sort"),
  });
  return Object.freeze({
    accountId: validateMailAccountQueryId(accountId),
    ...(options.cursor === null ? {} : { cursor: options.cursor }),
    limit: options.limit,
    view: filter.view,
    sort: filter.sort,
  });
}

function readExactAccountQuery(url: URL): string {
  assertExactQuery(url.searchParams, ["accountId"], []);
  const accountId = url.searchParams.get("accountId");
  if (accountId === null) throw new MailHttpError(400, "mail_request_invalid");
  return validateMailAccountQueryId(accountId);
}

function readExactDraftAccountQuery(url: URL): string {
  if (
    url.searchParams.getAll("accountId").length !== 1 ||
    [...url.searchParams.keys()].some((field) => field !== "accountId")
  ) {
    throw new MailHttpError(400, "mail_draft_request_invalid");
  }
  try {
    return validateMailDraftAccountId(url.searchParams.get("accountId"));
  } catch {
    throw new MailHttpError(400, "mail_draft_request_invalid");
  }
}

function assertExactQuery(
  search: URLSearchParams,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((field) => search.getAll(field).length !== 1) ||
    optional.some((field) => search.getAll(field).length > 1) ||
    [...search.keys()].some((field) => !allowed.has(field))
  ) {
    throw new MailHttpError(400, "mail_request_invalid");
  }
}

function validateMailAccountQueryId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) {
    throw new MailHttpError(400, "mail_request_invalid");
  }
  return value;
}

function toHttpError(error: unknown): MailHttpError {
  if (error instanceof MailHttpError) return error;
  if (error instanceof MailDraftCodecError) {
    return new MailHttpError(
      error.code === "mail_draft_request_invalid" ? 400 : 503,
      error.code === "mail_draft_request_invalid"
        ? error.code
        : "mail_draft_service_unavailable",
      error.code !== "mail_draft_request_invalid",
    );
  }
  if (error instanceof MailDraftError) {
    if (error.code === "mail_draft_request_invalid") {
      return new MailHttpError(400, error.code);
    }
    if (
      error.code === "mail_draft_account_not_found" ||
      error.code === "mail_draft_reply_target_not_found" ||
      error.code === "mail_draft_not_found"
    ) {
      return new MailHttpError(404, error.code);
    }
    if (
      error.code === "mail_draft_account_reauth_required" ||
      error.code === "mail_draft_capability_unavailable" ||
      error.code === "mail_draft_revision_conflict" ||
      error.code === "mail_draft_idempotency_conflict" ||
      error.code === "mail_draft_quota_exceeded" ||
      error.code === "mail_draft_state_invalid"
    ) {
      return new MailHttpError(409, error.code);
    }
    return new MailHttpError(503, error.code, true);
  }
  if (error instanceof MailMessageCodecError) {
    return new MailHttpError(
      error.code === "mail_request_invalid" ? 400 : 502,
      error.code === "mail_request_invalid"
        ? "mail_request_invalid"
        : "mail_sync_unavailable",
      error.code !== "mail_request_invalid",
    );
  }
  if (error instanceof MailSendError) {
    if (error.code === "mail_send_request_invalid") {
      return new MailHttpError(400, error.code);
    }
    if (
      error.code === "mail_send_account_not_found" ||
      error.code === "mail_send_reply_target_not_found" ||
      error.code === "mail_send_operation_not_found"
    ) {
      return new MailHttpError(404, error.code);
    }
    if (
      error.code === "mail_send_account_reauth_required" ||
      error.code === "mail_send_idempotency_conflict"
    ) {
      return new MailHttpError(409, error.code);
    }
    if (error.code === "mail_send_rate_limited") {
      return new MailHttpError(429, error.code);
    }
    return new MailHttpError(503, error.code, true);
  }
  if (error instanceof MailContentServiceError) {
    if (error.code === "mail_content_request_invalid") {
      return new MailHttpError(400, error.code);
    }
    if (
      error.code === "mail_content_account_not_found" ||
      error.code === "mail_content_message_not_found" ||
      error.code === "mail_content_attachment_not_found" ||
      error.code === "mail_content_remote_image_not_found"
    ) {
      return new MailHttpError(404, error.code);
    }
    return new MailHttpError(503, error.code, true);
  }
  if (error instanceof MailProviderSyncError) {
    if (error.code === "mail_provider_reauth_required") {
      return new MailHttpError(409, "mail_account_reauth_required");
    }
    if (error.code === "mail_provider_rate_limited") {
      return new MailHttpError(429, "mail_sync_rate_limited");
    }
    if (error.code === "mail_provider_mutation_unsupported") {
      // The server has no mailbox for this action. Retrying cannot find one.
      return new MailHttpError(409, "mail_thread_mutation_unsupported");
    }
    if (error.code === "mail_provider_thread_stale") {
      // The thread is not where the account last saw it. No retry brings the
      // handle back; the next sync rebuilds the list without it.
      return new MailHttpError(409, "mail_thread_stale");
    }
    return new MailHttpError(503, "mail_sync_unavailable", true);
  }
  if (error instanceof MailCacheError) {
    if (error.code === "mail_request_invalid") {
      return new MailHttpError(400, "mail_request_invalid");
    }
    if (error.code === "mail_sync_stale") {
      return new MailHttpError(409, "mail_sync_in_progress");
    }
    return new MailHttpError(503, "mail_sync_unavailable", true);
  }
  if (error instanceof GmailOAuthError) {
    return new MailHttpError(503, "gmail_oauth_unavailable", true);
  }
  if (error instanceof MailAdmissionError) {
    if (error.code === "capacity_exceeded") {
      return new MailHttpError(409, error.code);
    }
    if (error.code === "operation_already_reserved") {
      return new MailHttpError(409, error.code);
    }
    if (error.code === "reservation_not_found") {
      return new MailHttpError(404, error.code);
    }
    return new MailHttpError(400, error.code);
  }
  if (error instanceof MailAccountError) {
    if (error.code === "account_request_invalid") {
      return new MailHttpError(400, error.code);
    }
    if (error.code === "account_not_found") {
      return new MailHttpError(404, error.code);
    }
    if (
      error.code === "account_already_exists" ||
      error.code === "account_limit_reached" ||
      error.code === "account_selection_required"
    ) {
      return new MailHttpError(409, error.code);
    }
    if (
      error.code === "imap_dns_failed" ||
      error.code === "imap_tls_failed" ||
      error.code === "imap_connection_failed" ||
      error.code === "imap_authentication_failed" ||
      error.code === "smtp_dns_failed" ||
      error.code === "smtp_tls_failed" ||
      error.code === "smtp_connection_failed" ||
      error.code === "smtp_authentication_failed"
    ) {
      return new MailHttpError(422, error.code);
    }
    if (
      error.code === "imap_connection_timeout" ||
      error.code === "smtp_connection_timeout"
    ) {
      return new MailHttpError(408, error.code, true);
    }
    // Corrupt state, filesystem details, and wrapping-key availability all use
    // one public code. The API never reveals credential_key_invalid.
    return new MailHttpError(503, "account_unavailable", true);
  }
  return new MailHttpError(500, "internal_error", true);
}

function requireMessageService(
  messages: MailMessageService | undefined,
): MailMessageService {
  if (!messages) throw new MailHttpError(503, "mail_sync_unavailable");
  return messages;
}

function requireSendService(send: MailSendService | undefined): MailSendService {
  if (!send) throw new MailHttpError(503, "mail_send_service_unavailable");
  return send;
}

function requireDraftService(
  drafts: MailDraftService | undefined,
): MailDraftService {
  if (!drafts) throw new MailHttpError(503, "mail_draft_service_unavailable");
  return drafts;
}

function requireContentService(
  content: MailContentService | undefined,
): MailContentService {
  if (!content) throw new MailHttpError(503, "mail_content_unavailable");
  return content;
}

function requireAccountsV2(
  accounts: MailAccountService | undefined,
): MailAccountServiceV2 {
  if (
    !accounts ||
    accounts.localSchemaVersion !== 2 ||
    typeof (accounts as Partial<MailAccountServiceV2>).list !== "function" ||
    typeof (accounts as Partial<MailAccountServiceV2>).add !== "function" ||
    typeof (accounts as Partial<MailAccountServiceV2>).update !== "function" ||
    typeof (accounts as Partial<MailAccountServiceV2>).remove !== "function"
  ) {
    throw new MailHttpError(503, "account_unavailable");
  }
  return accounts as MailAccountServiceV2;
}

function writeMailThreadJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  writeJson(
    response,
    status,
    projectMailThreadStateContract(
      value,
      mailThreadStateContractTier(
        request.headers[MAIL_THREAD_STATE_CONTRACT_HEADER],
      ),
    ),
  );
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

async function streamAttachmentRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly admission: MailSystemAdmissionPort;
  readonly service: MailContentService;
  readonly input: {
    readonly accountId: string;
  } & (
    | { readonly attachmentId: string }
    | { readonly remoteImageId: string }
  );
  readonly setupDeadlineAt: number;
}): Promise<void> {
  const controller = new AbortController();
  let setupTimedOut = false;
  const abortClient = () => controller.abort();
  const abortResponse = () => {
    if (!options.response.writableFinished) controller.abort();
  };
  options.request.once("aborted", abortClient);
  options.response.once("close", abortResponse);
  const setupTimer = setTimeout(() => {
    setupTimedOut = true;
    controller.abort();
  }, Math.max(0, options.setupDeadlineAt - Date.now()));
  setupTimer.unref?.();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          setupTimedOut
            ? new MailHttpError(408, "request_deadline_exceeded", true)
            : new MailHttpError(400, "request_aborted", true),
        ),
      { once: true },
    );
  });

  let reservationId: string | null = null;
  let permitTransferred = false;
  let download: MailAttachmentDownload | null = null;
  let released = false;
  const releasePermit = async (): Promise<void> => {
    if (released || reservationId === null) return;
    released = true;
    await options.admission.release(reservationId).catch(() => {
      writeMailLogRecord({
        event: "mail_attachment_permit_release_failed",
        errorCode: "admission_unavailable",
      });
    });
  };

  try {
    const pendingReservation = options.admission.reserve(
      `attachment-download:${randomBytes(16).toString("hex")}`,
      {
        concurrentFetchStreams: 1,
        temporaryBytes: MAIL_RESOURCE_LIMITS.rawMessageBytes,
        openFileDescriptors: 2,
      },
    );
    let reservation;
    try {
      reservation = await Promise.race([pendingReservation, aborted]);
    } catch (error) {
      if (controller.signal.aborted) {
        void pendingReservation
          .then((late) => options.admission.release(late.reservationId))
          .catch(() => undefined);
      }
      throw error;
    }
    reservationId = reservation.reservationId;
    if (controller.signal.aborted) throw await aborted;

    const pending =
      "attachmentId" in options.input
        ? options.service.downloadAttachment({
            accountId: options.input.accountId,
            attachmentId: options.input.attachmentId,
            signal: controller.signal,
          })
        : options.service.downloadRemoteImage!({
            accountId: options.input.accountId,
            remoteImageId: options.input.remoteImageId,
            signal: controller.signal,
          });
    try {
      download = await Promise.race([pending, aborted]);
    } catch (error) {
      if (controller.signal.aborted) {
        permitTransferred = true;
        void pending
          .then((late) => late.dispose())
          .catch(() => undefined)
          .finally(releasePermit);
      }
      throw error;
    }
    clearTimeout(setupTimer);
    if (controller.signal.aborted) throw await aborted;
    await writeAttachment(options.response, download, controller);
  } finally {
    clearTimeout(setupTimer);
    options.request.off("aborted", abortClient);
    options.response.off("close", abortResponse);
    if (download !== null) await download.dispose().catch(() => undefined);
    if (!permitTransferred) await releasePermit();
  }
}

async function writeAttachment(
  response: ServerResponse,
  download: MailAttachmentDownload,
  controller: AbortController,
): Promise<void> {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  if (
    !isAsyncIterable(download.body) ||
    typeof download.dispose !== "function" ||
    !Number.isSafeInteger(download.bytes) ||
    download.bytes < 0 ||
    download.bytes > MAIL_RESOURCE_LIMITS.rawMessageBytes ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(
      download.mimeType,
    ) ||
    download.mimeType !== download.mimeType.toLowerCase()
  ) {
    throw new MailHttpError(503, "mail_content_unavailable", true);
  }
  const filename = safeAttachmentFilename(download.filename);
  response.statusCode = 200;
  response.setHeader("Content-Type", download.mimeType);
  response.setHeader("Content-Length", String(download.bytes));
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename.ascii}"; filename*=UTF-8''${filename.encoded}`,
  );
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
  );

  let streamTimedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = () => {
    streamTimedOut = true;
    controller.abort();
    response.destroy();
  };
  const resetIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(timeout, MAIL_SERVICE_HTTP_LIMITS.attachmentIdleTimeoutMs);
    idleTimer.unref?.();
  };
  const absoluteTimer = setTimeout(
    timeout,
    MAIL_SERVICE_HTTP_LIMITS.attachmentAbsoluteTimeoutMs,
  );
  absoluteTimer.unref?.();
  resetIdle();
  let total = 0;
  try {
    for await (const chunk of download.body) {
      if (
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength < 1 ||
        chunk.byteLength > 64 * 1024 ||
        total + chunk.byteLength > download.bytes
      ) {
        throw new MailHttpError(503, "mail_content_unavailable", true);
      }
      await writeResponseChunk(response, chunk, controller.signal);
      total += chunk.byteLength;
      resetIdle();
    }
    if (total !== download.bytes) {
      throw new MailHttpError(503, "mail_content_unavailable", true);
    }
    await endResponse(response, controller.signal);
  } catch (error) {
    response.destroy();
    if (streamTimedOut) {
      throw new MailHttpError(408, "request_deadline_exceeded", true);
    }
    throw error;
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    clearTimeout(absoluteTimer);
  }
}

function writeResponseChunk(
  response: ServerResponse,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    response.write(
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      (error) => finish(error ?? undefined),
    );
  });
}

function endResponse(
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
    const onClose = () => {
      if (!response.writableFinished) {
        finish(new MailHttpError(400, "request_aborted", true));
      }
    };
    const onError = (error: Error) => finish(error);
    signal.addEventListener("abort", onAbort, { once: true });
    response.once("close", onClose);
    response.once("error", onError);
    if (signal.aborted) {
      onAbort();
      return;
    }
    response.end(() => finish());
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function"
  );
}

function safeAttachmentFilename(value: string | null): {
  readonly ascii: string;
  readonly encoded: string;
} {
  const withoutControls = (value ?? "attachment")
    .normalize("NFC")
    .replace(/[\r\n\u0000-\u001f\u007f]/g, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  const unicode = truncateUtf8(withoutControls || "attachment", 180);
  const ascii = [...unicode]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0x20 && code <= 0x7e && character !== '"' && character !== "\\"
        ? character
        : "_";
    })
    .join("")
    .replace(/_+/g, "_") || "attachment";
  const encoded = encodeURIComponent(unicode).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return Object.freeze({ ascii, encoded });
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result || "attachment";
}

function writeRedirect(
  response: ServerResponse,
  redirect: GmailOAuthServiceRedirect,
): void {
  if (response.headersSent || response.writableEnded) return;
  response.statusCode = redirect.status;
  response.setHeader("Location", redirect.location);
  response.setHeader("Set-Cookie", redirect.setCookie);
  response.setHeader("Content-Length", "0");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
