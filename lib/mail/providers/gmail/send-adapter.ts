import { admitOutgoingRawMessage } from "../../security";
import type {
  MailSendProvider,
  MailSendProviderHooks,
  MailSendProviderMessage,
  MailSendProviderOutcome,
  MailSendRequestContext,
} from "../../service/outbound";
import {
  GmailAccessTokenError,
  parseGmailRetryAfterMs,
  type GmailAccessTokenPort,
} from "./api-types";

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send?fields=id%2CthreadId";
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_GMAIL_ERROR_REASONS = 16;
const SAFE_RESOURCE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const RETRYABLE_GMAIL_403_REASONS = new Set([
  "backendError",
  "dailyLimitExceeded",
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

export interface GmailSendAccessTokenLease {
  readonly tokenPort: GmailAccessTokenPort;
  /** Wipes any account-scoped cached access token owned by this lease. */
  destroy(): void;
}

export type GmailSendAccessTokenLeaseFactory = (
  accountId: string,
) => GmailSendAccessTokenLease;

interface ActiveGmailSend {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly finish: () => void;
}

/**
 * Production multi-account boundary. It creates an account-bound token lease
 * for each send, serializes provider submissions to the configured process
 * limit of one, and exposes an abort/drain barrier for account deletion.
 */
export class MultiAccountGmailSendAdapter implements MailSendProvider {
  readonly providerKind = "gmail" as const;
  private readonly createTokenLease: GmailSendAccessTokenLeaseFactory;
  private readonly request: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly invalidatedAccounts = new Set<string>();
  private readonly activeByAccount = new Map<string, Set<ActiveGmailSend>>();
  private sendTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: {
    readonly createTokenLease: GmailSendAccessTokenLeaseFactory;
    readonly request?: typeof fetch;
    readonly requestTimeoutMs?: number;
  }) {
    if (typeof options.createTokenLease !== "function") {
      throw new Error("gmail send token factory is invalid");
    }
    this.createTokenLease = options.createTokenLease;
    this.request = options.request ?? fetch;
    this.requestTimeoutMs = validateTimeout(options.requestTimeoutMs ?? 15_000);
  }

  send(
    message: MailSendProviderMessage,
    hooks: MailSendProviderHooks,
    context: MailSendRequestContext,
  ): Promise<MailSendProviderOutcome> {
    const accountId = validateAccountId(message.accountId);
    if (this.closed || this.invalidatedAccounts.has(accountId)) {
      return Promise.reject(new GmailAccessTokenError("refresh_unavailable"));
    }

    const operation = createActiveSend();
    const active = this.activeByAccount.get(accountId) ?? new Set<ActiveGmailSend>();
    active.add(operation);
    this.activeByAccount.set(accountId, active);

    let started = false;
    const execute = () => {
      started = true;
      return this.sendUnlocked(accountId, message, hooks, context, operation);
    };
    const scheduled = this.sendTail.then(execute, execute);
    this.sendTail = scheduled.then(
      () => undefined,
      () => undefined,
    );

    // A send waiting behind another account must be cancellable. Otherwise
    // account deletion (or worker shutdown) can deadlock behind unrelated
    // provider work before this operation has even acquired the serial slot.
    const pendingSignal = AbortSignal.any([
      context.signal,
      operation.controller.signal,
    ]);
    let cancelPending!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelPending = () => {
        if (!started) {
          reject(new GmailAccessTokenError("refresh_unavailable"));
        }
      };
      pendingSignal.addEventListener("abort", cancelPending, { once: true });
      if (pendingSignal.aborted) cancelPending();
    });
    return Promise.race([scheduled, cancelled]).finally(() => {
      pendingSignal.removeEventListener("abort", cancelPending);
      active.delete(operation);
      if (active.size === 0) this.activeByAccount.delete(accountId);
      operation.finish();
    });
  }

  /** Await before the account store renames cache/<accountId>. */
  async invalidateAccount(accountId: string): Promise<void> {
    const id = validateAccountId(accountId);
    this.invalidatedAccounts.add(id);
    const active = [...(this.activeByAccount.get(id) ?? [])];
    for (const operation of active) operation.controller.abort();
    await Promise.all(active.map((operation) => operation.done));
  }

  /** Rollback hook when the authoritative account delete did not commit. */
  async restoreInvalidatedAccount(accountId: string): Promise<void> {
    if (this.closed) throw new GmailAccessTokenError("refresh_unavailable");
    const id = validateAccountId(accountId);
    const active = [...(this.activeByAccount.get(id) ?? [])];
    await Promise.all(active.map((operation) => operation.done));
    this.invalidatedAccounts.delete(id);
  }

  /** Aborts and drains every account-bound send/token lease. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.activeByAccount.values()].flatMap((value) => [
      ...value,
    ]);
    for (const operation of active) operation.controller.abort();
    await Promise.all(active.map((operation) => operation.done));
    await this.sendTail.catch(() => undefined);
    this.activeByAccount.clear();
  }

  private async sendUnlocked(
    accountId: string,
    message: MailSendProviderMessage,
    hooks: MailSendProviderHooks,
    context: MailSendRequestContext,
    operation: ActiveGmailSend,
  ): Promise<MailSendProviderOutcome> {
    if (
      this.closed ||
      this.invalidatedAccounts.has(accountId) ||
      operation.controller.signal.aborted
    ) {
      throw new GmailAccessTokenError("refresh_unavailable");
    }
    let lease: GmailSendAccessTokenLease | null = null;
    try {
      lease = validateTokenLease(this.createTokenLease(accountId));
      const adapter = new GmailSendAdapter({
        tokenPort: lease.tokenPort,
        request: this.request,
        requestTimeoutMs: this.requestTimeoutMs,
      });
      return await adapter.send(message, hooks, {
        deadlineAt: context.deadlineAt,
        signal: AbortSignal.any([context.signal, operation.controller.signal]),
      });
    } finally {
      lease?.destroy();
    }
  }
}

export class GmailSendAdapter implements MailSendProvider {
  readonly providerKind = "gmail" as const;
  private readonly tokenPort: GmailAccessTokenPort;
  private readonly request: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: {
    readonly tokenPort: GmailAccessTokenPort;
    readonly request?: typeof fetch;
    readonly requestTimeoutMs?: number;
  }) {
    this.tokenPort = options.tokenPort;
    this.request = options.request ?? fetch;
    this.requestTimeoutMs = validateTimeout(options.requestTimeoutMs ?? 15_000);
  }

  async send(
    message: MailSendProviderMessage,
    hooks: MailSendProviderHooks,
    context: MailSendRequestContext,
  ): Promise<MailSendProviderOutcome> {
    validateMessage(message);
    if (
      context.signal.aborted ||
      !Number.isSafeInteger(context.deadlineAt) ||
      Date.now() >= context.deadlineAt
    ) {
      return retryable("mail_send_service_unavailable", null);
    }

    const raw = message.rawRfc2822.toString("base64url");
    const body = JSON.stringify(
      message.providerThreadId === null
        ? { raw }
        : { raw, threadId: message.providerThreadId },
    );

    let deliveryStarted = false;
    let safeToRetry = true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = context.deadlineAt - Date.now();
      if (remaining <= 0 || context.signal.aborted) {
        return safeToRetry
          ? retryable("mail_send_service_unavailable", null)
          : deliveryUnknown();
      }
      const timeoutSignal = AbortSignal.timeout(
        Math.min(this.requestTimeoutMs, Math.max(1, remaining)),
      );
      const signal = AbortSignal.any([context.signal, timeoutSignal]);
      let token: Buffer | null = null;
      try {
        token = await this.readAccessToken(attempt === 1, signal);
        if (!deliveryStarted) {
          // Once this durable barrier resolves, any lost/invalid success
          // response is ambiguous. The service must never retry it
          // automatically.
          await hooks.beforeDelivery();
          deliveryStarted = true;
        }
        safeToRetry = false;
        let response: Response;
        try {
          response = await this.request(GMAIL_SEND_URL, {
            method: "POST",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token.toString("utf8")}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            body,
            cache: "no-store",
            redirect: "error",
            signal,
          });
        } catch {
          return deliveryUnknown();
        }

        if (response.status === 401) {
          await discardResponse(response);
          safeToRetry = true;
          // Gmail's 401 is a definite non-delivery, so one retry with a
          // forcibly refreshed token cannot duplicate this request. There is
          // deliberately no third attempt. The durable delivery-risk marker
          // remains set: if the refreshed request loses its response, the
          // operation becomes delivery_unknown instead of being sent again.
          if (attempt === 0) continue;
          return rejected("mail_send_account_reauth_required");
        }
        if (response.status === 429) {
          const retryAfterMs = parseGmailRetryAfterMs(
            response.headers.get("Retry-After"),
            Date.now(),
          );
          await discardResponse(response);
          safeToRetry = true;
          return retryable("mail_send_rate_limited", retryAfterMs);
        }
        if (response.status >= 500) {
          await discardResponse(response);
          return deliveryUnknown();
        }
        if (response.status === 403) {
          const retryAfterMs = parseGmailRetryAfterMs(
            response.headers.get("Retry-After"),
            Date.now(),
          );
          const responseBody = await readBoundedJson(response).catch(() => null);
          if (hasRetryableGmail403Reason(responseBody)) {
            safeToRetry = true;
            return retryable("mail_send_rate_limited", retryAfterMs);
          }
          return rejected("mail_send_account_reauth_required");
        }
        if (response.status !== 200) {
          await discardResponse(response);
          return rejected("mail_send_request_invalid");
        }
        if (!isJsonContentType(response.headers.get("Content-Type"))) {
          await discardResponse(response);
          return deliveryUnknown();
        }
        const value = await readBoundedJson(response).catch(() => null);
        const accepted = validateAcceptedResponse(value, message.providerThreadId);
        return accepted ?? deliveryUnknown();
      } catch (error) {
        if (error instanceof GmailAccessTokenError) {
          if (error.code === "invalid_grant") {
            return rejected("mail_send_account_reauth_required");
          }
          return safeToRetry
            ? retryable("mail_send_service_unavailable", error.retryAfterMs)
            : deliveryUnknown();
        }
        return safeToRetry
          ? retryable("mail_send_service_unavailable", null)
          : deliveryUnknown();
      } finally {
        token?.fill(0);
      }
    }
    return rejected("mail_send_account_reauth_required");
  }

  private async readAccessToken(
    forceRefresh: boolean,
    signal: AbortSignal,
  ): Promise<Buffer> {
    let token: Buffer;
    try {
      token = await this.tokenPort.getAccessToken({ forceRefresh }, signal);
    } catch (error) {
      if (error instanceof GmailAccessTokenError) throw error;
      throw new GmailAccessTokenError("refresh_unavailable");
    }
    if (
      !Buffer.isBuffer(token) ||
      token.byteLength === 0 ||
      token.byteLength > MAX_ACCESS_TOKEN_BYTES ||
      token.includes(0) ||
      token.includes(10) ||
      token.includes(13)
    ) {
      if (Buffer.isBuffer(token)) token.fill(0);
      throw new GmailAccessTokenError("refresh_unavailable");
    }
    return token;
  }
}

function validateMessage(message: MailSendProviderMessage): void {
  if (
    !SAFE_ACCOUNT_ID.test(message.accountId) ||
    !Buffer.isBuffer(message.rawRfc2822) ||
    message.rawRfc2822.byteLength === 0 ||
    message.providerThreadId !== null &&
      !SAFE_RESOURCE_ID.test(message.providerThreadId)
  ) {
    throw new Error("gmail send message is invalid");
  }
  admitOutgoingRawMessage(message.rawRfc2822.byteLength);
}

function validateAccountId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) {
    throw new Error("gmail send account is invalid");
  }
  return value;
}

function validateTokenLease(value: GmailSendAccessTokenLease): GmailSendAccessTokenLease {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.tokenPort?.getAccessToken !== "function" ||
    typeof value.destroy !== "function"
  ) {
    throw new GmailAccessTokenError("refresh_unavailable");
  }
  return value;
}

function createActiveSend(): ActiveGmailSend {
  const controller = new AbortController();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return Object.freeze({ controller, done, finish });
}

function validateAcceptedResponse(
  value: unknown,
  requestedThreadId: string | null,
): Extract<MailSendProviderOutcome, { readonly kind: "accepted" }> | null {
  if (
    !isExactRecord(value, ["id", "threadId"]) ||
    typeof value.id !== "string" ||
    !SAFE_RESOURCE_ID.test(value.id) ||
    typeof value.threadId !== "string" ||
    !SAFE_RESOURCE_ID.test(value.threadId) ||
    (requestedThreadId !== null && value.threadId !== requestedThreadId)
  ) {
    return null;
  }
  return Object.freeze({
    kind: "accepted",
    providerMessageId: value.id,
    providerThreadId: value.threadId,
  });
}

function rejected(
  errorCode: Extract<MailSendProviderOutcome, { readonly kind: "rejected" }>["errorCode"],
): MailSendProviderOutcome {
  return Object.freeze({ kind: "rejected", errorCode });
}

function retryable(
  errorCode: Extract<
    MailSendProviderOutcome,
    { readonly kind: "retryable_rejection" }
  >["errorCode"],
  retryAfterMs: number | null,
): MailSendProviderOutcome {
  return Object.freeze({
    kind: "retryable_rejection",
    errorCode,
    retryAfterMs,
  });
}

function deliveryUnknown(): MailSendProviderOutcome {
  return Object.freeze({
    kind: "delivery_unknown",
    errorCode: "mail_send_service_unavailable",
  });
}

function hasRetryableGmail403Reason(value: unknown): boolean {
  if (!isJsonRecord(value) || !isJsonRecord(value.error)) return false;
  const errors = value.error.errors;
  if (!Array.isArray(errors) || errors.length > MAX_GMAIL_ERROR_REASONS) {
    return false;
  }
  return errors.some(
    (entry) =>
      isJsonRecord(entry) &&
      typeof entry.reason === "string" &&
      RETRYABLE_GMAIL_403_REASONS.has(entry.reason),
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const bytes = await readBoundedBody(response);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    bytes.fill(0);
  }
}

async function discardResponse(response: Response): Promise<void> {
  try {
    const bytes = await readBoundedBody(response);
    bytes.fill(0);
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("gmail send response is invalid");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("gmail send response is invalid");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        next.value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new Error("gmail send response is invalid");
      }
      chunks.push(next.value.slice());
      next.value.fill(0);
    }
    if (declared !== null && total !== Number(declared)) {
      throw new Error("gmail send response is invalid");
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;|$)/i.test(value);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new Error("gmail send timeout is invalid");
  }
  return value;
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}
