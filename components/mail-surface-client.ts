import type {
  MailAddress,
  MailMailboxThreadPage,
  MailMessageDto,
  MailSendInput,
  MailSendOperation,
  MailSendResult,
  MailSendStatus,
  MailSearchThreadPage,
  MailSystemMailbox,
  MailThreadDetail,
  MailThreadListItem,
  MailThreadMutationInput,
  MailThreadPage,
  MailThreadSort,
  MailThreadView,
} from "@/lib/mail/message-types";
import type {
  MailContentAttachmentDto,
  MailMessageContent,
} from "@/lib/mail/content-types";
import {
  MAIL_THREAD_STATE_CONTRACT_HEADER,
  MAIL_THREAD_STATE_CONTRACT_VALUE,
} from "@/lib/mail/thread-contract";
import { normalizeMailSearchQueryText } from "@/lib/mail/search-query";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_RESOURCE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ATTACHMENT_ID = /^attachment-a[0-9a-f]{32}$/;
const SAFE_DRAFT_ID =
  /^draft-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_DRAFT_ADDRESS_FIELD_BYTES = 64 * 1024;
const MAX_DRAFT_SUBJECT_BYTES = 998;
const MAX_DRAFT_TEXT_BYTES = 1024 * 1024;
const MAX_DRAFT_SUMMARIES =
  100 /* editing quota */ + 100 /* retained sent tombstones */;
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const MAX_ERROR_BODY_CHARS = 4096;
const UTF8 = new TextEncoder();

/**
 * A Mail API call that came back with a non-2xx status. The Mail service picks
 * each status and code deliberately (400 for a rejected request, 409 for a
 * revision or state conflict, 429 for a rate limit, 5xx for a real outage), and
 * the browser needs both to tell a permanent refusal apart from an ambiguous
 * one. `code` is `null` when the body carried no recognizable error envelope.
 */
export class MailApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super("mail unavailable");
    this.name = "MailApiError";
    this.status = status;
    this.code = code;
  }
}

export type {
  MailAddress,
  MailMailboxThreadPage,
  MailMessageDto,
  MailSendInput,
  MailSendOperation,
  MailSendResult,
  MailSearchThreadPage,
  MailSystemMailbox,
  MailThreadDetail,
  MailThreadListItem,
  MailThreadPage,
} from "@/lib/mail/message-types";

export type MailAccountStatus = "connected" | "reauth_required";

export type MailAccountCapabilities = {
  readonly mailboxes: readonly MailSystemMailbox[];
  readonly listThreads: boolean;
  readonly sync: boolean;
  readonly headerPreview: boolean;
  readonly messageBodies: boolean;
  readonly threadMutations: boolean;
  readonly compose: boolean;
  readonly send: boolean;
  readonly reply: boolean;
};

export type PublicMailAccountBase = {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly displayName: string | null;
  readonly status: MailAccountStatus;
  readonly connectedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly capabilities: MailAccountCapabilities;
};

export type MailAccountEndpoint = {
  readonly hostname: string;
  readonly port: number;
  readonly tls: "implicit" | "starttls";
  readonly username: string;
};

export type PublicMailAccount =
  | (PublicMailAccountBase & {
      readonly providerKind: "imap";
      readonly imap: MailAccountEndpoint;
      /** Present only for a custom domain that can also submit mail. */
      readonly smtp?: MailAccountEndpoint;
    })
  | (PublicMailAccountBase & {
      readonly providerKind: "gmail";
    });

export type MailDraftIntent =
  | { readonly kind: "compose" }
  | {
      readonly kind: "reply" | "reply_all" | "forward";
      readonly sourceMessageId: string;
    };

export type MailDraftState =
  | "editing"
  | "submitting"
  | "failed"
  | "delivery_unknown"
  | "sent";

export interface MailDraft {
  readonly draftId: string;
  readonly accountId: string;
  readonly revision: number;
  readonly state: MailDraftState;
  readonly intent: MailDraftIntent;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly text: string;
  readonly updatedAt: number;
}

export interface MailDraftSummary {
  readonly draftId: string;
  readonly accountId: string;
  readonly revision: number;
  readonly state: MailDraftState;
  readonly intent: MailDraftIntent;
  readonly subject: string;
  readonly updatedAt: number;
}

/**
 * A draft belongs in the Drafts list unless it is a `sent` tombstone. The store
 * keeps up to 100 scrubbed tombstones alongside the live drafts, and those must
 * stay hidden — everything else is a message the writer still owns.
 */
export function isListedDraft(draft: MailDraftSummary): boolean {
  return draft.state !== "sent";
}

/** Only an idle draft can be reopened. The service refuses to patch the rest. */
export function isResumableDraft(draft: MailDraftSummary): boolean {
  return draft.state === "editing" || draft.state === "failed";
}

/**
 * The service refuses to delete a draft that is mid-submission. A
 * `delivery_unknown` draft is deletable in the store, but removing it is a
 * manual action on an ambiguous send that Brain has not decided yet
 * (docs/mail-architecture.md §16), so it stays read-only here too.
 */
export function isDeletableDraft(draft: MailDraftSummary): boolean {
  return draft.state === "editing" || draft.state === "failed";
}

export interface MailDraftCreateInput {
  readonly draftId: string;
  readonly accountId: string;
  readonly intent: MailDraftIntent;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly text: string;
}

export interface MailDraftPatchInput {
  readonly accountId: string;
  readonly draftId: string;
  readonly mutationId: string;
  readonly expectedRevision: number;
  readonly patch: {
    readonly to?: string;
    readonly cc?: string;
    readonly bcc?: string;
    readonly subject?: string;
    readonly text?: string;
  };
}

export interface MailDraftDeleteInput {
  readonly accountId: string;
  readonly draftId: string;
  readonly mutationId: string;
  readonly expectedRevision: number;
}

export interface MailDraftSendInput {
  readonly accountId: string;
  readonly draftId: string;
  readonly mutationId: string;
  readonly expectedRevision: number;
  readonly sendIdempotencyKey: string;
  readonly sendOperationId: string;
}

export interface MailDraftMutationResult {
  readonly replayed: boolean;
  readonly appliedRevision: number;
}

export interface MailDraftDeleteResult {
  readonly replayed: boolean;
}

export interface MailDraftSendResult {
  readonly replayed: boolean;
  readonly appliedRevision: number;
  readonly operationId: string;
  readonly created: boolean;
  readonly status: MailSendStatus;
}

export interface MailSurfaceClient {
  loadAccounts(signal?: AbortSignal): Promise<readonly PublicMailAccount[]>;
  listThreads(
    input: {
      readonly accountId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly view?: MailThreadView;
      readonly sort?: MailThreadSort;
    },
    signal?: AbortSignal,
  ): Promise<MailThreadPage>;
  listMailboxThreads(
    input: {
      readonly accountId: string;
      readonly mailboxId: MailSystemMailbox;
      readonly cursor?: string;
      readonly limit?: number;
      readonly view?: MailThreadView;
      readonly sort?: MailThreadSort;
    },
    signal?: AbortSignal,
  ): Promise<MailMailboxThreadPage>;
  searchThreads(
    input: {
      readonly accountId: string;
      readonly mailboxId: MailSystemMailbox;
      readonly query: string;
      readonly cursor?: string;
      readonly limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<MailSearchThreadPage>;
  readThread(
    input: { readonly accountId: string; readonly threadId: string },
    signal?: AbortSignal,
  ): Promise<MailThreadDetail>;
  readMailboxThread(
    input: {
      readonly accountId: string;
      readonly mailboxId: MailSystemMailbox;
      readonly threadId: string;
    },
    signal?: AbortSignal,
  ): Promise<MailThreadDetail>;
  getMessageContent(
    input: { readonly accountId: string; readonly messageId: string },
    signal?: AbortSignal,
  ): Promise<MailMessageContent>;
  requestMessageContent(
    input: { readonly accountId: string; readonly messageId: string },
    signal?: AbortSignal,
  ): Promise<MailMessageContent>;
  sync(input: { readonly accountId: string }, signal?: AbortSignal): Promise<void>;
  updateThread(
    input: MailThreadMutationInput & { readonly threadId: string },
    signal?: AbortSignal,
  ): Promise<void>;
  send(input: MailSendInput, signal?: AbortSignal): Promise<MailSendResult>;
  createDraft(
    input: MailDraftCreateInput,
    signal?: AbortSignal,
    options?: { readonly keepalive?: boolean },
  ): Promise<MailDraft>;
  listDrafts(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<readonly MailDraftSummary[]>;
  getDraft(
    input: { readonly accountId: string; readonly draftId: string },
    signal?: AbortSignal,
  ): Promise<MailDraft>;
  patchDraft(
    input: MailDraftPatchInput,
    signal?: AbortSignal,
    options?: { readonly keepalive?: boolean },
  ): Promise<MailDraftMutationResult>;
  deleteDraft(
    input: MailDraftDeleteInput,
    signal?: AbortSignal,
  ): Promise<MailDraftDeleteResult>;
  sendDraft(
    input: MailDraftSendInput,
    signal?: AbortSignal,
  ): Promise<MailDraftSendResult>;
  getSendOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MailSendOperation>;
}

export const defaultMailSurfaceClient: MailSurfaceClient = {
  async loadAccounts(signal) {
    const payload = await requestJson("/api/mail/accounts/capabilities", { signal });
    return readAccounts(payload);
  },

  async listThreads(input, signal) {
    const search = new URLSearchParams({
      accountId: input.accountId,
      limit: String(input.limit ?? 50),
    });
    if (input.cursor) search.set("cursor", input.cursor);
    if (input.view) search.set("view", input.view);
    if (input.sort && input.sort !== "date") search.set("sort", input.sort);
    const payload = await requestJson(`/api/mail/threads?${search}`, {
      headers: mailThreadStateHeaders(),
      signal,
    });
    return readThreadPage(payload, input.accountId);
  },

  async listMailboxThreads(input, signal) {
    const search = new URLSearchParams({
      accountId: input.accountId,
      limit: String(input.limit ?? 50),
    });
    if (input.cursor) search.set("cursor", input.cursor);
    if (input.view) search.set("view", input.view);
    if (input.sort && input.sort !== "date") search.set("sort", input.sort);
    const payload = await requestJson(
      `/api/mail/mailboxes/${input.mailboxId}/threads?${search}`,
      { headers: mailThreadStateHeaders(), signal },
    );
    return readMailboxThreadPage(payload, input.mailboxId, input.accountId);
  },

  async searchThreads(input, signal) {
    const query = normalizeMailSearchQueryText(input.query);
    if (query === null) throw new Error("invalid mail search query");
    const payload = await requestJson("/api/mail/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...mailThreadStateHeaders(),
      },
      body: JSON.stringify({
        accountId: input.accountId,
        mailboxId: input.mailboxId,
        query,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit ?? 50,
      }),
      signal,
    });
    return readSearchThreadPage(
      payload,
      input.mailboxId,
      input.accountId,
    );
  },

  async readThread(input, signal) {
    const search = new URLSearchParams({ accountId: input.accountId });
    const payload = await requestJson(
      `/api/mail/threads/${encodeURIComponent(input.threadId)}?${search}`,
      { headers: mailThreadStateHeaders(), signal },
    );
    return readThreadDetail(payload, input);
  },

  async readMailboxThread(input, signal) {
    const search = new URLSearchParams({ accountId: input.accountId });
    const payload = await requestJson(
      `/api/mail/mailboxes/${input.mailboxId}/threads/${encodeURIComponent(input.threadId)}?${search}`,
      { headers: mailThreadStateHeaders(), signal },
    );
    return readThreadDetail(payload, input);
  },

  async getMessageContent(input, signal) {
    const payload = await requestJson(messageContentUrl(input), { signal });
    return readMessageContent(payload, input);
  },

  async requestMessageContent(input, signal) {
    const payload = await requestJson(messageContentUrl(input), {
      method: "POST",
      signal,
    });
    return readMessageContent(payload, input);
  },

  async sync(input, signal) {
    const payload = await requestJson("/api/mail/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, maxItems: 20 }),
      signal,
    });
    readSyncResult(payload);
  },

  async updateThread(input, signal) {
    const { threadId, ...mutation } = input;
    const payload = await requestJsonWithin(
      `/api/mail/threads/${encodeURIComponent(threadId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...mailThreadStateHeaders(),
        },
        body: JSON.stringify(mutation),
        signal,
      },
      MAIL_MUTATION_TIMEOUT_MS,
    );
    readThreadMutationResult(payload);
  },

  async send(input, signal) {
    const payload = await requestJson("/api/mail/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    return readSendResult(payload);
  },

  async createDraft(input, signal, options) {
    const payload = await requestJson("/api/mail/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draftId: input.draftId,
        accountId: input.accountId,
        intent: input.intent,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
      }),
      signal,
      keepalive: options?.keepalive,
    });
    return readDraftCreateResponse(payload, input);
  },

  async listDrafts(accountId, signal) {
    const search = new URLSearchParams({ accountId });
    const payload = await requestJson(`/api/mail/drafts?${search}`, { signal });
    return readDraftList(payload, accountId);
  },

  async getDraft(input, signal) {
    if (!isDraftId(input.draftId)) throw new Error("invalid mail draft request");
    const search = new URLSearchParams({ accountId: input.accountId });
    const payload = await requestJson(
      `/api/mail/drafts/${encodeURIComponent(input.draftId)}?${search}`,
      { signal },
    );
    return readDraft(payload, input);
  },

  async patchDraft(input, signal, options) {
    if (!isDraftId(input.draftId)) throw new Error("invalid mail draft request");
    const payload = await requestJson(
      `/api/mail/drafts/${encodeURIComponent(input.draftId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "patch",
          accountId: input.accountId,
          draftId: input.draftId,
          mutationId: input.mutationId,
          expectedRevision: input.expectedRevision,
          patch: input.patch,
        }),
        signal,
        keepalive: options?.keepalive,
      },
    );
    return readDraftMutationResult(payload);
  },

  async deleteDraft(input, signal) {
    if (!isDraftId(input.draftId)) throw new Error("invalid mail draft request");
    const payload = await requestJson(
      `/api/mail/drafts/${encodeURIComponent(input.draftId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: input.accountId,
          draftId: input.draftId,
          mutationId: input.mutationId,
          expectedRevision: input.expectedRevision,
        }),
        signal,
      },
    );
    return readDraftDeleteResult(payload);
  },

  async sendDraft(input, signal) {
    if (!isDraftId(input.draftId)) throw new Error("invalid mail draft request");
    const payload = await requestJson(
      `/api/mail/drafts/${encodeURIComponent(input.draftId)}/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "send",
          accountId: input.accountId,
          draftId: input.draftId,
          mutationId: input.mutationId,
          expectedRevision: input.expectedRevision,
          sendIdempotencyKey: input.sendIdempotencyKey,
          sendOperationId: input.sendOperationId,
        }),
        signal,
      },
    );
    return readDraftSendResult(payload, input);
  },

  async getSendOperation(operationId, signal) {
    if (!SAFE_OPERATION_ID.test(operationId)) {
      throw new Error("invalid mail send operation request");
    }
    const payload = await requestJson(
      `/api/mail/send/${encodeURIComponent(operationId)}`,
      { signal },
    );
    return readSendOperation(payload, operationId);
  },
};

function mailThreadStateHeaders(): Record<string, string> {
  return {
    [MAIL_THREAD_STATE_CONTRACT_HEADER]: MAIL_THREAD_STATE_CONTRACT_VALUE,
  };
}

/**
 * How long one thread mutation may go unanswered before the client gives up.
 *
 * Every hop below has a deadline of its own — the mail service holds a
 * provider operation to 10s and the route's proxy gives up at 12s — so a
 * mutation that is merely slow is answered, with an error, inside those. This
 * is the bound for the hop none of them can cover: a PATCH that never gets an
 * answer at all. Without it a bulk action awaiting that request held the mail
 * mutation lock for good, and the Undo that waited on the same loop hung with
 * it. Fifteen seconds sits above the chain so a slow answer still arrives as
 * itself rather than as this.
 */
export const MAIL_MUTATION_TIMEOUT_MS = 15_000;

/** The clock gave up on a mutation, as opposed to the caller or the server. */
export function isMailMutationTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/**
 * `requestJson` under a deadline. The caller's own signal still aborts first
 * and keeps its reason; the clock aborts with a `TimeoutError`, which is the
 * platform's own name for it (`AbortSignal.timeout` throws the same), spelled
 * by hand so the timer is one this module owns and clears.
 */
async function requestJsonWithin(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const caller = init.signal ?? null;
  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller?.aborted) onCallerAbort();
  else caller?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `mail mutation unanswered after ${timeoutMs}ms`,
          "TimeoutError",
        ),
      ),
    timeoutMs,
  );
  try {
    return await requestJson(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  }
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  // The ok check comes first. A proxy 502 or any non-JSON error body must still
  // surface its status instead of throwing a parse error from this line.
  if (!response.ok) {
    throw new MailApiError(response.status, await readMailApiErrorCode(response));
  }
  return (await response.json()) as unknown;
}

/**
 * The Mail routes answer a failure with `{apiVersion, error: {code}}` — version
 * 1 for drafts and send, 2 for accounts. The version is irrelevant here, so
 * this reads the code out of either shape and yields `null` for anything else.
 */
async function readMailApiErrorCode(response: Response): Promise<string | null> {
  try {
    const raw = await response.text();
    if (raw.length > MAX_ERROR_BODY_CHARS) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const error = (value as Record<string, unknown>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return null;
    const code = (error as Record<string, unknown>).code;
    if (typeof code !== "string" || !isSafeErrorCode(code)) return null;
    return code;
  } catch {
    // A non-JSON body still carries a truthful status, which is what matters.
    return null;
  }
}

function isSafeErrorCode(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[a-z0-9_]+$/.test(value);
}

function readAccounts(value: unknown): readonly PublicMailAccount[] {
  if (
    !isExactRecord(value, ["apiVersion", "accounts"]) ||
    value.apiVersion !== 3 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 3
  ) {
    throw new Error("invalid mail accounts");
  }
  return value.accounts.map(readAccount);
}

function readAccount(value: unknown): PublicMailAccount {
  if (!isRecord(value) || (value.providerKind !== "imap" && value.providerKind !== "gmail")) {
    throw new Error("invalid mail account");
  }
  const hasSmtp =
    value.providerKind === "imap" &&
    Object.prototype.hasOwnProperty.call(value, "smtp");
  const fields = [
    "accountId",
    "capabilities",
    "emailAddress",
    "displayName",
    "status",
    "connectedAt",
    "createdAt",
    "updatedAt",
    "providerKind",
    ...(value.providerKind === "imap" ? ["imap"] : []),
    ...(hasSmtp ? ["smtp"] : []),
  ];
  if (
    !isExactRecord(value, fields) ||
    !isAccountId(value.accountId) ||
    !isText(value.emailAddress, 320) ||
    (value.displayName !== null && !isText(value.displayName, 255)) ||
    (value.status !== "connected" && value.status !== "reauth_required") ||
    !isTimestamp(value.connectedAt) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw new Error("invalid mail account");
  }
  const base: PublicMailAccountBase = {
    accountId: value.accountId,
    emailAddress: value.emailAddress,
    displayName: value.displayName,
    status: value.status,
    connectedAt: value.connectedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    capabilities: readCapabilities(value.capabilities, value.providerKind, hasSmtp),
  };
  if (value.providerKind === "gmail") return { ...base, providerKind: "gmail" };
  const imap = readEndpoint(value.imap);
  if (!hasSmtp) return { ...base, providerKind: "imap", imap };
  return { ...base, providerKind: "imap", imap, smtp: readEndpoint(value.smtp) };
}

function readEndpoint(value: unknown): MailAccountEndpoint {
  if (
    !isExactRecord(value, ["hostname", "port", "tls", "username"]) ||
    !isText(value.hostname, 255) ||
    !Number.isSafeInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    (value.tls !== "implicit" && value.tls !== "starttls") ||
    !isText(value.username, 320)
  ) {
    throw new Error("invalid mail account");
  }
  return {
    hostname: value.hostname,
    port: value.port as number,
    tls: value.tls,
    username: value.username,
  };
}

/**
 * A custom-domain IMAP account can send once it carries an SMTP transport, so
 * the capability set is not decided by the provider alone. The service still
 * owns the answer — it withholds `send` while SMTP submission is not ready —
 * and an account with no SMTP transport may never claim it.
 *
 * `threadMutations` is read rather than derived. Both providers mutate threads
 * today, and a service that withholds the capability can only take UI away, so
 * trusting it here fails closed: the surface stops offering actions the account
 * says it cannot perform.
 */
function readCapabilities(
  value: unknown,
  providerKind: "imap" | "gmail",
  hasSmtp: boolean,
): MailAccountCapabilities {
  const gmail = providerKind === "gmail";
  const expectedMailboxes: readonly MailSystemMailbox[] = gmail
    ? ["inbox", "starred", "sent", "all", "spam", "trash"]
    : ["inbox"];
  const canSend =
    gmail || (hasSmtp && isRecord(value) && value.send === true);
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
    value.mailboxes.length !== expectedMailboxes.length ||
    value.mailboxes.some((mailbox, index) => mailbox !== expectedMailboxes[index]) ||
    value.listThreads !== true ||
    value.sync !== true ||
    value.headerPreview !== true ||
    value.messageBodies !== true ||
    typeof value.threadMutations !== "boolean" ||
    value.compose !== canSend ||
    value.send !== canSend ||
    value.reply !== canSend
  ) {
    throw new Error("invalid mail account capabilities");
  }
  return Object.freeze({
    mailboxes: Object.freeze([...expectedMailboxes]),
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: value.threadMutations,
    compose: canSend,
    send: canSend,
    reply: canSend,
  });
}

function readThreadPage(
  value: unknown,
  expectedAccountId: string,
): MailThreadPage {
  if (
    !isExactRecord(value, ["apiVersion", "items", "nextCursor", "sync"]) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    (value.nextCursor !== null &&
      (!isText(value.nextCursor, 2_048) || !/^[A-Za-z0-9_-]+$/.test(value.nextCursor)))
  ) {
    throw new Error("invalid mail thread list");
  }
  const items = value.items.map(readThreadListItem);
  if (
    items.some((item) => item.accountId !== expectedAccountId) ||
    new Set(items.map((item) => `${item.accountId}\u0000${item.threadId}`)).size !==
    items.length
  ) {
    throw new Error("invalid mail thread list");
  }
  return {
    apiVersion: 1,
    items,
    nextCursor: value.nextCursor,
    sync: readSyncStatus(value.sync),
  };
}

function readMailboxThreadPage(
  value: unknown,
  expectedMailboxId: MailSystemMailbox,
  expectedAccountId: string,
): MailMailboxThreadPage {
  if (
    !isExactRecord(value, [
      "apiVersion",
      "mailboxId",
      "items",
      "nextCursor",
      "availability",
    ]) ||
    value.apiVersion !== 1 ||
    value.mailboxId !== expectedMailboxId ||
    !isMailSystemMailbox(value.mailboxId) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    (value.nextCursor !== null &&
      (!isText(value.nextCursor, 2_048) || !/^[A-Za-z0-9_-]+$/.test(value.nextCursor)))
  ) {
    throw new Error("invalid mail mailbox thread list");
  }
  const items = value.items.map(readThreadListItem);
  if (
    items.some((item) => item.accountId !== expectedAccountId) ||
    new Set(items.map((item) => `${item.accountId}\u0000${item.threadId}`)).size !==
    items.length
  ) {
    throw new Error("invalid mail mailbox thread list");
  }
  return {
    apiVersion: 1,
    mailboxId: value.mailboxId,
    items,
    nextCursor: value.nextCursor,
    availability: readMailboxAvailability(value.availability),
  };
}

function readSearchThreadPage(
  value: unknown,
  expectedMailboxId: MailSystemMailbox,
  expectedAccountId: string,
): MailSearchThreadPage {
  if (
    !isExactRecord(value, [
      "apiVersion",
      "mailboxId",
      "scope",
      "items",
      "nextCursor",
      "availability",
      "indexStatus",
      "resultsTruncated",
    ]) ||
    value.apiVersion !== 1 ||
    value.mailboxId !== expectedMailboxId ||
    value.scope !== "headers_and_previews" ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    (value.nextCursor !== null &&
      (!isText(value.nextCursor, 2_048) ||
        !/^[A-Za-z0-9_-]+$/.test(value.nextCursor))) ||
    (value.indexStatus !== "building" && value.indexStatus !== "ready") ||
    typeof value.resultsTruncated !== "boolean"
  ) {
    throw new Error("invalid mail search thread list");
  }
  const availability = readMailboxAvailability(value.availability);
  const items = value.items.map(readThreadListItem);
  if (
    items.some((item) => item.accountId !== expectedAccountId) ||
    new Set(items.map((item) => `${item.accountId}\u0000${item.threadId}`)).size !==
      items.length ||
    (value.indexStatus === "building" &&
      (value.nextCursor !== null || value.resultsTruncated !== true)) ||
    (availability.status === "unavailable" &&
      (items.length !== 0 ||
        value.nextCursor !== null ||
        value.resultsTruncated !== true)) ||
    (availability.status === "available" &&
      availability.windowTruncated &&
      value.resultsTruncated !== true)
  ) {
    throw new Error("invalid mail search thread list");
  }
  return {
    apiVersion: 1,
    mailboxId: expectedMailboxId,
    scope: "headers_and_previews",
    items,
    nextCursor: value.nextCursor,
    availability,
    indexStatus: value.indexStatus,
    resultsTruncated: value.resultsTruncated,
  };
}

function readMailboxAvailability(
  value: unknown,
): MailMailboxThreadPage["availability"] {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("invalid mail mailbox availability");
  }
  if (
    value.status === "available" &&
    isExactRecord(value, ["status", "lastSuccessfulAt", "windowTruncated"]) &&
    isTimestamp(value.lastSuccessfulAt) &&
    typeof value.windowTruncated === "boolean"
  ) {
    return {
      status: "available",
      lastSuccessfulAt: value.lastSuccessfulAt,
      windowTruncated: value.windowTruncated,
    };
  }
  if (
    value.status === "unavailable" &&
    isExactRecord(value, ["status", "reason", "lastSuccessfulAt", "windowTruncated"]) &&
    isMailboxUnavailableReason(value.reason) &&
    isNullableTimestamp(value.lastSuccessfulAt) &&
    value.windowTruncated === null
  ) {
    return {
      status: "unavailable",
      reason: value.reason,
      lastSuccessfulAt: value.lastSuccessfulAt,
      windowTruncated: null,
    };
  }
  throw new Error("invalid mail mailbox availability");
}

function readThreadListItem(value: unknown): MailThreadListItem {
  const baseFields = [
    "accountId",
    "threadId",
    "subject",
    "participants",
    "snippet",
    "lastMessageAt",
    "messageCount",
    "unread",
    "hasAttachments",
  ];
  const hasStarred =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "starred");
  // The two view fields ship together: a response carrying exactly one of
  // them is malformed, unlike starred's independently optional flag.
  const hasListMessage =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "listMessage");
  const hasSizeBytes =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "sizeBytes");
  if (hasListMessage !== hasSizeBytes) throw new Error("invalid mail thread");
  // category travels alone like starred, unlike the paired view fields.
  const hasCategory =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "category");
  if (
    !isExactRecord(value, [
      ...baseFields,
      ...(hasStarred ? ["starred"] : []),
      ...(hasListMessage ? ["listMessage", "sizeBytes"] : []),
      ...(hasCategory ? ["category"] : []),
    ]) ||
    !isAccountId(value.accountId) ||
    !isResourceId(value.threadId) ||
    !isNullableText(value.subject, 998) ||
    !Array.isArray(value.participants) ||
    value.participants.length > 100 ||
    !isNullableText(value.snippet, 4 * 1_024) ||
    !isNullableTimestamp(value.lastMessageAt) ||
    !Number.isSafeInteger(value.messageCount) ||
    (value.messageCount as number) < 1 ||
    (value.messageCount as number) > 200 ||
    typeof value.unread !== "boolean" ||
    (hasStarred && typeof value.starred !== "boolean") ||
    (hasListMessage &&
      (typeof value.listMessage !== "boolean" ||
        !Number.isSafeInteger(value.sizeBytes) ||
        (value.sizeBytes as number) < 0)) ||
    (hasCategory &&
      value.category !== "people" &&
      value.category !== "notification" &&
      value.category !== "newsletter") ||
    typeof value.hasAttachments !== "boolean"
  ) {
    throw new Error("invalid mail thread");
  }
  return {
    accountId: value.accountId,
    threadId: value.threadId,
    subject: value.subject,
    participants: value.participants.map(readAddress),
    snippet: value.snippet,
    lastMessageAt: value.lastMessageAt,
    messageCount: value.messageCount as number,
    unread: value.unread,
    starred: hasStarred ? (value.starred as boolean) : false,
    hasAttachments: value.hasAttachments,
    listMessage: hasListMessage ? (value.listMessage as boolean) : false,
    sizeBytes: hasListMessage ? (value.sizeBytes as number) : 0,
    category: hasCategory
      ? (value.category as MailThreadListItem["category"])
      : "people",
  };
}

function readThreadDetail(
  value: unknown,
  expected: { readonly accountId: string; readonly threadId: string },
): MailThreadDetail {
  if (
    !isExactRecord(value, ["apiVersion", "thread", "messages"]) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.messages) ||
    value.messages.length > 200
  ) {
    throw new Error("invalid mail thread detail");
  }
  const thread = readThreadListItem(value.thread);
  const messages = value.messages.map(readMessage);
  if (
    thread.accountId !== expected.accountId ||
    thread.threadId !== expected.threadId ||
    messages.some(
      (message) =>
        message.accountId !== thread.accountId || message.threadId !== thread.threadId,
    ) ||
    new Set(messages.map((message) => message.messageId)).size !== messages.length
  ) {
    throw new Error("invalid mail thread binding");
  }
  return { apiVersion: 1, thread, messages };
}

function readMessage(value: unknown): MailMessageDto {
  if (
    !isExactRecord(value, [
      "accountId",
      "messageId",
      "threadId",
      "from",
      "replyTo",
      "to",
      "cc",
      "subject",
      "sentAt",
      "unread",
      "inInbox",
      "snippet",
      "textBody",
      "htmlBody",
      "hasAttachments",
    ]) ||
    !isAccountId(value.accountId) ||
    !isResourceId(value.messageId) ||
    !isResourceId(value.threadId) ||
    (value.from !== null && !isRecord(value.from)) ||
    !Array.isArray(value.replyTo) ||
    !Array.isArray(value.to) ||
    !Array.isArray(value.cc) ||
    value.replyTo.length > 100 ||
    value.to.length + value.cc.length > 100 ||
    !isNullableText(value.subject, 998) ||
    !isNullableTimestamp(value.sentAt) ||
    typeof value.unread !== "boolean" ||
    typeof value.inInbox !== "boolean" ||
    !isNullableText(value.snippet, 4 * 1_024) ||
    !isNullableText(value.textBody, 1_024 * 1_024) ||
    !isNullableText(value.htmlBody, 2 * 1_024 * 1_024) ||
    typeof value.hasAttachments !== "boolean"
  ) {
    throw new Error("invalid mail message");
  }
  return {
    accountId: value.accountId,
    messageId: value.messageId,
    threadId: value.threadId,
    from: value.from === null ? null : readAddress(value.from),
    replyTo: value.replyTo.map(readAddress),
    to: value.to.map(readAddress),
    cc: value.cc.map(readAddress),
    subject: value.subject,
    sentAt: value.sentAt,
    unread: value.unread,
    inInbox: value.inInbox,
    snippet: value.snippet,
    textBody: value.textBody,
    htmlBody: value.htmlBody,
    hasAttachments: value.hasAttachments,
  };
}

function readMessageContent(
  value: unknown,
  input: { readonly accountId: string; readonly messageId: string },
): MailMessageContent {
  if (
    !isRecord(value) ||
    value.apiVersion !== 1 ||
    !isAccountId(value.accountId) ||
    !isResourceId(value.messageId) ||
    value.accountId !== input.accountId ||
    value.messageId !== input.messageId ||
    typeof value.state !== "string"
  ) {
    throw new Error("invalid mail content");
  }
  const base = {
    apiVersion: 1 as const,
    accountId: value.accountId,
    messageId: value.messageId,
  };
  if (
    value.state === "not_requested" ||
    value.state === "fetching" ||
    value.state === "transient" ||
    value.state === "permanent"
  ) {
    if (!isExactRecord(value, ["apiVersion", "accountId", "messageId", "state"])) {
      throw new Error("invalid mail content");
    }
    return { ...base, state: value.state };
  }
  if (
    value.state !== "ready" ||
    !isExactRecord(value, [
      "apiVersion",
      "accountId",
      "attachments",
      "htmlBody",
      "messageId",
      "state",
      "textBody",
    ]) ||
    !isNullableText(value.textBody, 2 * 1_024 * 1_024) ||
    !isNullableText(value.htmlBody, 1_024 * 1_024) ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > 256
  ) {
    throw new Error("invalid mail content");
  }
  const attachments = value.attachments.map(readContentAttachment);
  if (new Set(attachments.map((attachment) => attachment.attachmentId)).size !== attachments.length) {
    throw new Error("invalid mail content");
  }
  return {
    ...base,
    state: "ready",
    textBody: value.textBody,
    htmlBody: value.htmlBody,
    attachments,
  };
}

function readContentAttachment(value: unknown): MailContentAttachmentDto {
  if (
    !isExactRecord(value, [
      "attachmentId",
      "bytes",
      "contentId",
      "disposition",
      "filename",
      "mimeType",
    ]) ||
    typeof value.attachmentId !== "string" ||
    !SAFE_ATTACHMENT_ID.test(value.attachmentId) ||
    !isNullableText(value.filename, 1_024) ||
    typeof value.mimeType !== "string" ||
    !MIME_TYPE.test(value.mimeType) ||
    value.mimeType !== value.mimeType.toLowerCase() ||
    (value.disposition !== "attachment" && value.disposition !== "inline") ||
    !isNullableText(value.contentId, 998) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > 40 * 1_024 * 1_024
  ) {
    throw new Error("invalid mail attachment");
  }
  return {
    attachmentId: value.attachmentId,
    filename: value.filename,
    mimeType: value.mimeType,
    disposition: value.disposition,
    contentId: value.contentId,
    bytes: value.bytes as number,
  };
}

function readAddress(value: unknown): MailAddress {
  if (
    !isExactRecord(value, ["name", "address"]) ||
    (value.name !== null && !isText(value.name, 256)) ||
    !isText(value.address, 320) ||
    !isEmail(value.address)
  ) {
    throw new Error("invalid mail address");
  }
  return { name: value.name, address: value.address };
}

function readSyncStatus(value: unknown): MailThreadPage["sync"] {
  if (
    !isExactRecord(value, ["status", "lastSuccessfulAt"]) ||
    (value.status !== "idle" &&
      value.status !== "syncing" &&
      value.status !== "backoff" &&
      value.status !== "cache_full" &&
      value.status !== "reauth_required") ||
    !isNullableTimestamp(value.lastSuccessfulAt)
  ) {
    throw new Error("invalid mail sync status");
  }
  return { status: value.status, lastSuccessfulAt: value.lastSuccessfulAt };
}

function readSendResult(value: unknown): MailSendResult {
  if (
    !isExactRecord(value, ["apiVersion", "operationId", "created", "status"]) ||
    value.apiVersion !== 1 ||
    !isText(value.operationId, 128) ||
    !SAFE_OPERATION_ID.test(value.operationId) ||
    typeof value.created !== "boolean" ||
    (value.status !== "queued" &&
      value.status !== "sending" &&
      value.status !== "sent" &&
      value.status !== "failed" &&
      value.status !== "delivery_unknown")
  ) {
    throw new Error("invalid mail send result");
  }
  return {
    apiVersion: 1,
    operationId: value.operationId,
    created: value.created,
    status: value.status,
  };
}

function readSendOperation(
  value: unknown,
  expectedOperationId: string,
): MailSendOperation {
  if (
    !isExactRecord(value, ["apiVersion", "operationId", "status"]) ||
    value.apiVersion !== 1 ||
    value.operationId !== expectedOperationId ||
    !isDraftSendStatus(value.status)
  ) {
    throw new Error("invalid mail send operation");
  }
  return {
    apiVersion: 1,
    operationId: expectedOperationId,
    status: value.status,
  };
}

function readSyncResult(value: unknown): void {
  if (
    !isExactRecord(value, ["apiVersion", "changedCount", "hasMore", "status"]) ||
    value.apiVersion !== 1 ||
    !Number.isSafeInteger(value.changedCount) ||
    (value.changedCount as number) < 0 ||
    (value.changedCount as number) > 20 ||
    typeof value.hasMore !== "boolean" ||
    (value.status !== "idle" &&
      value.status !== "syncing" &&
      value.status !== "backoff" &&
      value.status !== "reauth_required")
  ) {
    throw new Error("invalid mail sync result");
  }
}

function readThreadMutationResult(value: unknown): void {
  if (
    !isExactRecord(value, ["apiVersion", "thread"]) ||
    value.apiVersion !== 1
  ) {
    throw new Error("invalid mail thread mutation");
  }
  readThreadListItem(value.thread);
}

function readDraftCreateResponse(
  value: unknown,
  expected: { readonly accountId: string; readonly draftId: string },
): MailDraft {
  if (
    !isExactRecord(value, ["apiVersion", "created", "draft"]) ||
    value.apiVersion !== 1 ||
    typeof value.created !== "boolean"
  ) {
    throw new Error("invalid mail draft");
  }
  return readDraft(value.draft, expected);
}

function readDraft(
  value: unknown,
  expected: { readonly accountId: string; readonly draftId: string },
): MailDraft {
  if (
    !isExactRecord(value, [
      "accountId",
      "apiVersion",
      "attachments",
      "bcc",
      "cc",
      "createdAt",
      "draftId",
      "intent",
      "revision",
      "sendErrorCode",
      "sendOperationId",
      "sentAt",
      "state",
      "subject",
      "text",
      "to",
      "updatedAt",
    ]) ||
    value.apiVersion !== 1 ||
    !isAccountId(value.accountId) ||
    value.accountId !== expected.accountId ||
    !isDraftId(value.draftId) ||
    value.draftId !== expected.draftId ||
    !isDraftRevision(value.revision) ||
    !isDraftState(value.state) ||
    !Array.isArray(value.attachments) ||
    value.attachments.length !== 0 ||
    !isNullableBoundedText(value.sendOperationId, 128) ||
    !isNullableBoundedText(value.sendErrorCode, 128) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isNullableTimestamp(value.sentAt) ||
    !isDraftFieldText(value.to, MAX_DRAFT_ADDRESS_FIELD_BYTES) ||
    !isDraftFieldText(value.cc, MAX_DRAFT_ADDRESS_FIELD_BYTES) ||
    !isDraftFieldText(value.bcc, MAX_DRAFT_ADDRESS_FIELD_BYTES) ||
    !isDraftFieldText(value.subject, MAX_DRAFT_SUBJECT_BYTES) ||
    !isDraftFieldText(value.text, MAX_DRAFT_TEXT_BYTES)
  ) {
    throw new Error("invalid mail draft");
  }
  return {
    draftId: value.draftId,
    accountId: value.accountId,
    revision: value.revision,
    state: value.state,
    intent: readDraftIntent(value.intent),
    to: value.to,
    cc: value.cc,
    bcc: value.bcc,
    subject: value.subject,
    text: value.text,
    updatedAt: value.updatedAt,
  };
}

function readDraftList(
  value: unknown,
  expectedAccountId: string,
): readonly MailDraftSummary[] {
  if (
    !isExactRecord(value, ["apiVersion", "drafts"]) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.drafts) ||
    value.drafts.length > MAX_DRAFT_SUMMARIES
  ) {
    throw new Error("invalid mail draft list");
  }
  const drafts = value.drafts.map((draft) =>
    readDraftSummary(draft, expectedAccountId),
  );
  if (new Set(drafts.map((draft) => draft.draftId)).size !== drafts.length) {
    throw new Error("invalid mail draft list");
  }
  return drafts;
}

function readDraftSummary(
  value: unknown,
  expectedAccountId: string,
): MailDraftSummary {
  if (
    !isExactRecord(value, [
      "accountId",
      "apiVersion",
      "createdAt",
      "draftId",
      "intent",
      "revision",
      "sendErrorCode",
      "sendOperationId",
      "sentAt",
      "state",
      "subject",
      "updatedAt",
    ]) ||
    value.apiVersion !== 1 ||
    !isAccountId(value.accountId) ||
    value.accountId !== expectedAccountId ||
    !isDraftId(value.draftId) ||
    !isDraftRevision(value.revision) ||
    !isDraftState(value.state) ||
    !isNullableBoundedText(value.sendOperationId, 128) ||
    !isNullableBoundedText(value.sendErrorCode, 128) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isNullableTimestamp(value.sentAt) ||
    !isDraftFieldText(value.subject, MAX_DRAFT_SUBJECT_BYTES)
  ) {
    throw new Error("invalid mail draft list");
  }
  return {
    draftId: value.draftId,
    accountId: value.accountId,
    revision: value.revision,
    state: value.state,
    intent: readDraftIntent(value.intent),
    subject: value.subject,
    updatedAt: value.updatedAt,
  };
}

function readDraftIntent(value: unknown): MailDraftIntent {
  if (isExactRecord(value, ["kind"]) && value.kind === "compose") {
    return { kind: "compose" };
  }
  if (
    isExactRecord(value, ["kind", "sourceMessageId"]) &&
    (value.kind === "reply" ||
      value.kind === "reply_all" ||
      value.kind === "forward") &&
    isText(value.sourceMessageId, 512)
  ) {
    return { kind: value.kind, sourceMessageId: value.sourceMessageId };
  }
  throw new Error("invalid mail draft");
}

function readDraftMutationResult(value: unknown): MailDraftMutationResult {
  if (
    !isExactRecord(value, [
      "apiVersion",
      "appliedRevision",
      "operationId",
      "replayed",
    ]) ||
    value.apiVersion !== 1 ||
    typeof value.replayed !== "boolean" ||
    !isDraftRevision(value.appliedRevision) ||
    value.operationId !== null
  ) {
    throw new Error("invalid mail draft mutation");
  }
  return { replayed: value.replayed, appliedRevision: value.appliedRevision };
}

function readDraftDeleteResult(value: unknown): MailDraftDeleteResult {
  if (
    !isExactRecord(value, ["apiVersion", "deleted", "replayed"]) ||
    value.apiVersion !== 1 ||
    value.deleted !== true ||
    typeof value.replayed !== "boolean"
  ) {
    throw new Error("invalid mail draft delete");
  }
  return { replayed: value.replayed };
}

function readDraftSendResult(
  value: unknown,
  expected: MailDraftSendInput,
): MailDraftSendResult {
  if (
    !isExactRecord(value, [
      "apiVersion",
      "appliedRevision",
      "created",
      "operationId",
      "replayed",
      "status",
    ]) ||
    value.apiVersion !== 1 ||
    typeof value.replayed !== "boolean" ||
    typeof value.created !== "boolean" ||
    !isDraftRevision(value.appliedRevision) ||
    !isText(value.operationId, 128) ||
    !SAFE_OPERATION_ID.test(value.operationId) ||
    value.operationId !== expected.sendOperationId ||
    !isDraftSendStatus(value.status)
  ) {
    throw new Error("invalid mail draft send");
  }
  return {
    replayed: value.replayed,
    appliedRevision: value.appliedRevision,
    operationId: value.operationId,
    created: value.created,
    status: value.status,
  };
}

function isDraftId(value: unknown): value is string {
  return typeof value === "string" && SAFE_DRAFT_ID.test(value);
}

function isDraftRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDraftState(value: unknown): value is MailDraftState {
  return (
    value === "editing" ||
    value === "submitting" ||
    value === "failed" ||
    value === "delivery_unknown" ||
    value === "sent"
  );
}

function isDraftSendStatus(value: unknown): value is MailSendStatus {
  return (
    value === "queued" ||
    value === "sending" ||
    value === "sent" ||
    value === "failed" ||
    value === "delivery_unknown"
  );
}

function isDraftFieldText(value: unknown, maxBytes: number): value is string {
  return isBoundedString(value, maxBytes, true);
}

function isNullableBoundedText(
  value: unknown,
  maxBytes: number,
): value is string | null {
  return value === null || isBoundedString(value, maxBytes, false);
}

function isNullableText(value: unknown, maxLength: number): value is string | null {
  return value === null || isBoundedString(value, maxLength, true);
}

function isText(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength, false);
}

function isBoundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty: boolean,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\u0000") &&
    UTF8.encode(value).byteLength <= maxBytes
  );
}

function isAccountId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ACCOUNT_ID.test(value);
}

function isMailSystemMailbox(value: unknown): value is MailSystemMailbox {
  return (
    value === "inbox" ||
    value === "all" ||
    value === "sent" ||
    value === "starred" ||
    value === "spam" ||
    value === "trash"
  );
}

function isMailboxUnavailableReason(
  value: unknown,
): value is Extract<
  MailMailboxThreadPage["availability"],
  { readonly status: "unavailable" }
>["reason"] {
  return (
    value === "global_syncing" ||
    value === "mailbox_uninitialized" ||
    value === "mailbox_syncing" ||
    value === "mailbox_backoff" ||
    value === "mailbox_cache_capacity" ||
    value === "mailbox_reauth_required" ||
    value === "history_mismatch"
  );
}

function isResourceId(value: unknown): value is string {
  return typeof value === "string" && SAFE_RESOURCE_ID.test(value);
}

function isEmail(value: string): boolean {
  return !/[\u0000-\u0020\u007f]/.test(value) && /^[^@]+@[^@.]+(?:\.[^@.]+)+$/.test(value);
}

function messageContentUrl(input: { readonly accountId: string; readonly messageId: string }): string {
  if (!isAccountId(input.accountId) || !isResourceId(input.messageId)) {
    throw new Error("invalid mail content request");
  }
  const search = new URLSearchParams({ accountId: input.accountId });
  return `/api/mail/message-content/${encodeURIComponent(input.messageId)}?${search}`;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key)) &&
    fields.every((field) => {
      const descriptor = descriptors[field];
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}
