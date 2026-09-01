import {
  fingerprintMailDraftDelete,
  fingerprintMailDraftCreate,
  fingerprintMailDraftMutation,
  mailDraftToDto,
  validateMailDraftAccountId,
  validateMailDraftCreateInput,
  validateMailDraftDeleteInput,
  validateMailDraftId,
  validateMailDraftListResponse,
  validateMailDraftMutationInput,
  validateStoredMailDraft,
} from "../draft-codec";
import {
  MAIL_DRAFT_API_VERSION,
  MailDraftError,
  type MailDraftCreateInput,
  type MailDraftCreateResponse,
  type MailDraftDeleteInput,
  type MailDraftDeleteResponse,
  type MailDraftDto,
  type MailDraftListResponse,
  type MailDraftMutationInput,
  type MailDraftMutationResult,
  type MailDraftMutationResponse,
  type MailDraftSendResponse,
  type MailDraftSummaryDto,
  type MailDraftThreadingContext,
  type StoredMailDraft,
} from "../draft-types";
import { validateMailSendInput } from "../message-codec";
import type {
  MailSendInput,
  MailSendOperation,
} from "../message-types";
import { parseMailRecipientFields } from "../recipients";
import { mailAccountCapabilities } from "./account-types";
import {
  createMailSendSubmissionProposal,
  mailSendSubmissionReplayProposal,
  MailSendError,
  type MailReplyContext,
  type MailReplyContextResolver,
  type MailSendAccount,
  type MailSendAccountResolver,
  type MailSendRequestContext,
  type MailSendStore,
  type StoredMailSendSubmission,
} from "./outbound";

export { MailDraftError } from "../draft-types";

export interface MailDraftCreateResult {
  readonly created: boolean;
  readonly draft: StoredMailDraft;
}

export interface MailDraftDeleteResult {
  readonly replayed: boolean;
}

export interface MailDraftStore {
  createDraft(
    draft: StoredMailDraft,
    requestFingerprint: string,
    request?: MailSendRequestContext,
  ): Promise<MailDraftCreateResult>;
  readDraft(accountId: string, draftId: string): Promise<StoredMailDraft | null>;
  listDrafts(accountId: string): Promise<readonly StoredMailDraft[]>;
  listDraftSummaries(
    accountId: string,
  ): Promise<readonly MailDraftSummaryDto[]>;
  applyDraftMutation(
    mutation: MailDraftMutationInput,
    requestFingerprint: string,
    updatedAt: number,
    request?: MailSendRequestContext,
  ): Promise<MailDraftMutationResult>;
  deleteDraft(
    deletion: MailDraftDeleteInput,
    requestFingerprint: string,
    deletedAt: number,
    request?: MailSendRequestContext,
  ): Promise<MailDraftDeleteResult>;
}

export interface MailDraftSendCommitResult extends MailDraftMutationResult {
  readonly operationId: string;
  readonly created: boolean;
  readonly submission: StoredMailSendSubmission;
}

/**
 * The mutation receipt and its matching outbox row must share one SQLite
 * commit. `submission` is a trusted internal proposal, never an HTTP body.
 */
export interface MailDraftSendStore {
  commitDraftSend(
    mutation: MailDraftMutationInput,
    requestFingerprint: string,
    submission: StoredMailSendSubmission,
    updatedAt: number,
    request?: MailSendRequestContext,
  ): Promise<MailDraftSendCommitResult>;
}

export interface MailDraftSendProcessor {
  processOperation(
    operationId: string,
    request: MailSendRequestContext,
  ): Promise<MailSendOperation>;
}

export interface MailDraftService {
  create(
    value: unknown,
    request: MailSendRequestContext,
  ): Promise<MailDraftCreateResponse>;
  read(accountId: unknown, draftId: unknown): Promise<MailDraftDto>;
  list(accountId: unknown): Promise<MailDraftListResponse>;
  mutate(
    value: unknown,
    request: MailSendRequestContext,
  ): Promise<MailDraftMutationResponse>;
  delete(
    value: unknown,
    request: MailSendRequestContext,
  ): Promise<MailDraftDeleteResponse>;
  send(
    value: unknown,
    request: MailSendRequestContext,
  ): Promise<MailDraftSendResponse>;
}

type MailDraftRuntimeStore = MailDraftStore &
  MailDraftSendStore &
  Pick<MailSendStore, "readByOperationId">;

/** Provider-neutral local draft orchestration. Provider Drafts are out of scope. */
export class ProviderNeutralMailDraftService implements MailDraftService {
  private readonly store: MailDraftRuntimeStore;
  private readonly accounts: MailSendAccountResolver;
  private readonly replies: MailReplyContextResolver;
  private readonly sender: MailDraftSendProcessor;
  private readonly now: () => number;

  constructor(options: {
    readonly store: MailDraftRuntimeStore;
    readonly accounts: MailSendAccountResolver;
    readonly replies: MailReplyContextResolver;
    readonly sender: MailDraftSendProcessor;
    readonly now?: () => number;
  }) {
    if (
      !options.store ||
      !options.accounts ||
      !options.replies ||
      !options.sender ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw unavailable();
    }
    this.store = options.store;
    this.accounts = options.accounts;
    this.replies = options.replies;
    this.sender = options.sender;
    this.now = options.now ?? Date.now;
  }

  async create(
    value: unknown,
    request: MailSendRequestContext,
  ): Promise<MailDraftCreateResponse> {
    const input = validateMailDraftCreateInput(value);
    this.assertRequestActive(request);
    const account = await this.readAccount(input.accountId);
    this.assertRequestActive(request);
    assertIntentCapabilities(account, input.intent.kind);

    const existing = await this.storeCall(() =>
      this.store.readDraft(input.accountId, input.draftId),
    );
    const threading =
      existing === null
        ? await this.resolveCreateThreading(input)
        : existing.threading;
    const timestamp = this.readNow();
    const draft = validateStoredMailDraft(
      initialDraft(input, threading, timestamp),
    );
    this.assertRequestActive(request);
    const result = await this.storeCall(() =>
      this.store.createDraft(
        draft,
        fingerprintMailDraftCreate(input),
        request,
      ),
    );
    return Object.freeze({
      apiVersion: MAIL_DRAFT_API_VERSION,
      created: result.created,
      draft: mailDraftToDto(validateStoredMailDraft(result.draft)),
    });
  }

  async read(accountId: unknown, draftId: unknown): Promise<MailDraftDto> {
    const account = validateMailDraftAccountId(accountId);
    const id = validateMailDraftId(draftId);
    await this.readAccount(account);
    const draft = await this.storeCall(() => this.store.readDraft(account, id));
    if (draft === null) throw new MailDraftError("mail_draft_not_found");
    return mailDraftToDto(validateStoredMailDraft(draft));
  }

  async list(accountId: unknown): Promise<MailDraftListResponse> {
    const account = validateMailDraftAccountId(accountId);
    await this.readAccount(account);
    const drafts = await this.storeCall(() =>
      this.store.listDraftSummaries(account),
    );
    return validateMailDraftListResponse({
      apiVersion: MAIL_DRAFT_API_VERSION,
      drafts: Object.freeze(drafts),
    });
  }

  async mutate(
    value: unknown,
    request: MailSendRequestContext,
  ): Promise<MailDraftMutationResponse> {
    const input = validateMailDraftMutationInput(value);
    this.assertRequestActive(request);
    if (input.kind !== "patch") {
      throw new MailDraftError("mail_draft_state_invalid");
    }
    await this.readAccount(input.accountId);
    this.assertRequestActive(request);
    const result = await this.storeCall(() =>
      this.store.applyDraftMutation(
        input,
        fingerprintMailDraftMutation(input),
        this.readNow(),
        request,
      ),
    );
    return Object.freeze({
      apiVersion: MAIL_DRAFT_API_VERSION,
      replayed: result.replayed,
      appliedRevision: result.appliedRevision,
      operationId: result.operationId,
    });
  }

  async delete(
    value: unknown,
    request: MailSendRequestContext,
  ): Promise<MailDraftDeleteResponse> {
    const input = validateMailDraftDeleteInput(value);
    this.assertRequestActive(request);
    await this.readAccount(input.accountId);
    this.assertRequestActive(request);
    const result = await this.storeCall(() =>
      this.store.deleteDraft(
        input,
        fingerprintMailDraftDelete(input),
        this.readNow(),
        request,
      ),
    );
    return Object.freeze({
      apiVersion: MAIL_DRAFT_API_VERSION,
      deleted: true,
      replayed: result.replayed,
    });
  }

  async send(
    value: unknown,
    request: MailSendRequestContext,
  ): Promise<MailDraftSendResponse> {
    const mutation = validateMailDraftMutationInput(value);
    if (mutation.kind !== "send") {
      throw new MailDraftError("mail_draft_request_invalid");
    }
    this.assertRequestActive(request);
    const account = await this.readAccount(mutation.accountId);
    this.assertRequestActive(request);

    let proposal = await this.storeCall(() =>
      this.store.readByOperationId(mutation.sendOperationId),
    );
    let committedAt: number;
    if (proposal === null) {
      if (account.status === "reauth_required") {
        throw new MailDraftError("mail_draft_account_reauth_required");
      }
      assertBaseSendCapabilities(account);
      const draft = await this.storeCall(() =>
        this.store.readDraft(mutation.accountId, mutation.draftId),
      );
      if (draft === null) throw new MailDraftError("mail_draft_not_found");
      assertIntentCapabilities(account, draft.intent.kind);
      if (draft.attachments.length !== 0) {
        throw new MailDraftError("mail_draft_state_invalid");
      }
      committedAt = this.readNow();
      try {
        proposal = createMailSendSubmissionProposal({
          account,
          input: mailSendInputFromDraft(draft, mutation.sendIdempotencyKey),
          reply: replyContextFromDraft(draft),
          operationId: mutation.sendOperationId,
          createdAt: committedAt,
        });
      } catch (error) {
        if (
          !(error instanceof MailDraftError) &&
          !(error instanceof MailSendError)
        ) {
          throw new MailDraftError("mail_draft_request_invalid");
        }
        throw mapSendError(error);
      }
    } else {
      if (
        proposal.accountId !== mutation.accountId ||
        proposal.operationId !== mutation.sendOperationId ||
        proposal.idempotencyKey !== mutation.sendIdempotencyKey
      ) {
        throw new MailDraftError("mail_draft_idempotency_conflict");
      }
      committedAt = proposal.createdAt;
      proposal = mailSendSubmissionReplayProposal(proposal);
    }

    this.assertRequestActive(request);
    const committed = await this.storeCall(() =>
      this.store.commitDraftSend(
        mutation,
        fingerprintMailDraftMutation(mutation),
        proposal!,
        committedAt,
        request,
      ),
    );
    if (
      committed.operationId !== mutation.sendOperationId ||
      committed.submission.operationId !== mutation.sendOperationId ||
      committed.submission.accountId !== mutation.accountId ||
      committed.submission.idempotencyKey !== mutation.sendIdempotencyKey
    ) {
      throw unavailable();
    }

    let status = committed.submission.status;
    if (!committed.replayed) {
      try {
        const operation = await this.sender.processOperation(
          committed.operationId,
          request,
        );
        if (operation.operationId !== committed.operationId) throw unavailable();
        status = operation.status;
      } catch {
        // The atomic handoff already succeeded. The background worker owns the
        // durable queued operation, so a synchronous delivery failure is safe.
      }
    }
    return Object.freeze({
      apiVersion: MAIL_DRAFT_API_VERSION,
      replayed: committed.replayed,
      appliedRevision: committed.appliedRevision,
      operationId: committed.operationId,
      created: committed.created,
      status,
    });
  }

  private async resolveCreateThreading(
    input: MailDraftCreateInput,
  ): Promise<MailDraftThreadingContext | null> {
    if (input.intent.kind === "compose" || input.intent.kind === "forward") {
      return null;
    }
    let reply: MailReplyContext | null;
    try {
      reply = await this.replies.resolveReplyContext(
        input.accountId,
        input.intent.sourceMessageId,
      );
    } catch {
      throw unavailable();
    }
    if (reply === null) {
      throw new MailDraftError("mail_draft_reply_target_not_found");
    }
    return Object.freeze({
      providerThreadId: reply.providerThreadId,
      rfcMessageId: reply.rfcMessageId,
      references: Object.freeze([...reply.references]),
    });
  }

  private async readAccount(accountId: string): Promise<MailSendAccount> {
    let account: MailSendAccount | null;
    try {
      account = await this.accounts.readSendAccount(accountId);
    } catch {
      throw unavailable();
    }
    if (account === null || account.accountId !== accountId) {
      throw new MailDraftError("mail_draft_account_not_found");
    }
    return account;
  }

  private async storeCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MailDraftError) throw error;
      throw unavailable();
    }
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
    return value;
  }

  private assertRequestActive(request: MailSendRequestContext): void {
    if (
      request.signal.aborted ||
      !Number.isSafeInteger(request.deadlineAt) ||
      this.readNow() >= request.deadlineAt
    ) {
      throw unavailable();
    }
  }
}

function initialDraft(
  input: MailDraftCreateInput,
  threading: MailDraftThreadingContext | null,
  timestamp: number,
): StoredMailDraft {
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    draftId: input.draftId,
    accountId: input.accountId,
    revision: 0,
    state: "editing" as const,
    intent: input.intent,
    threading,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    attachments: Object.freeze([]),
    sendIdempotencyKey: null,
    sendOperationId: null,
    sendErrorCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    sentAt: null,
  });
}

function assertBaseSendCapabilities(account: MailSendAccount): void {
  const capabilities = mailAccountCapabilities(
    account.providerKind,
    account.sendConfigured,
  );
  if (!capabilities.send) {
    throw new MailDraftError("mail_draft_capability_unavailable");
  }
}

function assertIntentCapabilities(
  account: MailSendAccount,
  intent: StoredMailDraft["intent"]["kind"],
): void {
  const capabilities = mailAccountCapabilities(
    account.providerKind,
    account.sendConfigured,
  );
  const supported =
    intent === "reply" || intent === "reply_all"
      ? capabilities.reply && capabilities.send
      : capabilities.compose && capabilities.send;
  if (!supported) {
    throw new MailDraftError("mail_draft_capability_unavailable");
  }
}

/**
 * The one derivation of a send input from a stored draft. The outbox re-runs it
 * inside the commit transaction to prove the submission still matches the
 * draft, so both sides must normalize recipients identically — a second parser
 * here produced a fingerprint mismatch and a permanent idempotency conflict for
 * any address the writer typed with a capital letter.
 */
export function mailSendInputFromDraft(
  draft: StoredMailDraft,
  idempotencyKey: string,
): MailSendInput {
  const replyMode =
    draft.intent.kind === "reply" || draft.intent.kind === "reply_all";
  const recipients = parseMailRecipientFields({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
  });
  if (!recipients.ok) {
    throw new MailDraftError("mail_draft_request_invalid");
  }
  try {
    return validateMailSendInput({
      accountId: draft.accountId,
      idempotencyKey,
      mode: replyMode ? "reply" : "compose",
      to: [...recipients.recipients.to],
      cc: [...recipients.recipients.cc],
      bcc: [...recipients.recipients.bcc],
      subject: draft.subject,
      text: draft.text,
      replyToMessageId: replyMode ? draft.intent.sourceMessageId : null,
    });
  } catch {
    throw new MailDraftError("mail_draft_request_invalid");
  }
}

function replyContextFromDraft(draft: StoredMailDraft): MailReplyContext | null {
  if (draft.intent.kind !== "reply" && draft.intent.kind !== "reply_all") {
    return null;
  }
  if (draft.threading === null || draft.threading.rfcMessageId === null) {
    throw new MailDraftError("mail_draft_state_invalid");
  }
  return Object.freeze({
    providerThreadId: draft.threading.providerThreadId,
    rfcMessageId: draft.threading.rfcMessageId,
    references: Object.freeze([...draft.threading.references]),
  });
}

function mapSendError(error: unknown): MailDraftError {
  if (error instanceof MailDraftError) return error;
  if (error instanceof MailSendError) {
    if (error.code === "mail_send_request_invalid") {
      return new MailDraftError("mail_draft_request_invalid");
    }
    if (error.code === "mail_send_account_not_found") {
      return new MailDraftError("mail_draft_account_not_found");
    }
    if (error.code === "mail_send_account_reauth_required") {
      return new MailDraftError("mail_draft_account_reauth_required");
    }
    if (error.code === "mail_send_reply_target_not_found") {
      return new MailDraftError("mail_draft_reply_target_not_found");
    }
    if (error.code === "mail_send_idempotency_conflict") {
      return new MailDraftError("mail_draft_idempotency_conflict");
    }
  }
  return unavailable();
}

function unavailable(): MailDraftError {
  return new MailDraftError("mail_draft_service_unavailable");
}
