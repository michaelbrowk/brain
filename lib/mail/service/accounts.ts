import { randomBytes } from "node:crypto";

import {
  MailAccountError,
  type MailAccountCreateInput,
  type MailAccountConnectInput,
  type MailAccountPatchInput,
  type MailAccountResult,
  type MailAccountStatus,
  type MailAccountsCapabilitiesStatus,
  type MailAccountsStatus,
  type ProvisionedImapAccount,
  type StoredImapMailAccount,
  type StoredMailAccount,
  MAX_MAIL_ACCOUNTS,
  publicMailAccount,
  publicMailAccountV2,
  publicMailAccountV3,
  validateMailAccountConnectInput,
  validateMailAccountCreateInput,
  validateMailAccountPatchInput,
} from "./account-types";
import type {
  MailAccountStore,
  MultiMailAccountStore,
} from "./account-store";
import type { ImapCredentialVerifier } from "./imapflow-adapter";
import type { SmtpCredentialVerifier } from "./smtp-transport";

export interface MailAccountService {
  readonly localSchemaVersion?: number;
  status(): Promise<MailAccountStatus>;
  connect(
    input: MailAccountConnectInput,
    request: { readonly deadlineAt: number; readonly signal: AbortSignal },
  ): Promise<MailAccountStatus>;
  disconnect(request: MailAccountRequestContext): Promise<MailAccountStatus>;
  accountCount?(): Promise<number>;
}

export interface MailAccountServiceV2 extends MailAccountService {
  readonly localSchemaVersion: 2;
  accountCount(): Promise<number>;
  list(): Promise<MailAccountsStatus>;
  listCapabilities(): Promise<MailAccountsCapabilitiesStatus>;
  add(
    input: MailAccountCreateInput,
    request: MailAccountRequestContext,
  ): Promise<MailAccountResult>;
  update(
    accountId: string,
    patch: MailAccountPatchInput,
    request: MailAccountRequestContext,
  ): Promise<MailAccountResult>;
  remove(
    accountId: string,
    request: MailAccountRequestContext,
  ): Promise<MailAccountResult>;
}

export interface MailAccountRequestContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface MailAccountRemovalGuard {
  /** Block new account work, abort in-flight work, and close account files. */
  invalidateAccount(accountId: string): Promise<void>;
  /** Re-open the account lease only when the authoritative delete did not commit. */
  restoreInvalidatedAccount(accountId: string): void | Promise<void>;
}

export interface MailAccountProtocolMutationGuard {
  /**
   * Run one transport or credential mutation while account work is blocked.
   * The guard must restore the account runtime before this promise settles.
   */
  run<T>(
    accountId: string,
    options: { readonly preservesBindings: boolean },
    operation: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Coordinates every account-scoped runtime layer before the authoritative
 * account store removes credentials and renames the shared cache directory.
 * Partial invalidation rolls back immediately so a failed layer cannot leave
 * an otherwise connected account half-disabled.
 */
export class CompositeMailAccountRemovalGuard
  implements MailAccountRemovalGuard
{
  private readonly layers: readonly MailAccountRemovalGuard[];

  constructor(layers: readonly MailAccountRemovalGuard[]) {
    if (layers.length === 0 || new Set(layers).size !== layers.length) {
      throw new MailAccountError("account_state_unavailable");
    }
    this.layers = Object.freeze([...layers]);
  }

  async invalidateAccount(accountId: string): Promise<void> {
    const completed: MailAccountRemovalGuard[] = [];
    try {
      for (const layer of this.layers) {
        await layer.invalidateAccount(accountId);
        completed.push(layer);
      }
    } catch (error) {
      let rollbackFailed = false;
      for (const layer of completed.reverse()) {
        try {
          await layer.restoreInvalidatedAccount(accountId);
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        throw new MailAccountError("account_state_unavailable");
      }
      throw error;
    }
  }

  async restoreInvalidatedAccount(accountId: string): Promise<void> {
    let restoreFailed = false;
    for (const layer of [...this.layers].reverse()) {
      try {
        await layer.restoreInvalidatedAccount(accountId);
      } catch {
        restoreFailed = true;
      }
    }
    if (restoreFailed) {
      throw new MailAccountError("account_state_unavailable");
    }
  }
}

export class SingleMailAccountService implements MailAccountService {
  private readonly store: MailAccountStore;
  private readonly verifier: ImapCredentialVerifier;
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly store: MailAccountStore;
    readonly verifier: ImapCredentialVerifier;
    readonly now?: () => number;
  }) {
    this.store = options.store;
    this.verifier = options.verifier;
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<MailAccountStatus> {
    return statusFromAccount(await this.store.readAccount());
  }

  async connect(
    input: MailAccountConnectInput,
    request: { readonly deadlineAt: number; readonly signal: AbortSignal },
  ): Promise<MailAccountStatus> {
    return this.mutate(request, async () => {
      this.assertRequestActive(request);
      const loaded = await this.store.loadProvisionedAccount();
      let password: Buffer | undefined;
      try {
        this.assertRequestActive(request);
        if (input.imap.password === null && !loaded) {
          throw new MailAccountError("account_request_invalid");
        }
        if (
          input.imap.password === null &&
          loaded &&
          !sameConnectionIdentity(loaded.account, input)
        ) {
          // Reusing a saved password is safe only for metadata edits. Otherwise
          // a same-origin request could redirect the credential to a new host.
          throw new MailAccountError("account_request_invalid");
        }
        password =
          input.imap.password === null
            ? loaded!.password
            : Buffer.from(input.imap.password, "utf8");
        if (loaded && loaded.password !== password) loaded.password.fill(0);
        const account = nextProvisionedAccount(
          loaded?.account ?? null,
          input,
          this.now(),
        );
        await this.verifier.verify({
          endpoint: account.endpoint,
          username: account.username,
          password,
          deadlineAt: request.deadlineAt,
          signal: request.signal,
        });
        this.assertRequestActive(request);
        await this.store.save(account, password, request.signal);
        return statusFromAccount(account);
      } finally {
        password?.fill(0);
        loaded?.password.fill(0);
      }
    });
  }

  async disconnect(request: MailAccountRequestContext): Promise<MailAccountStatus> {
    return this.mutate(request, async () => {
      // A timed-out DELETE may have waited behind another mutation. Re-check
      // inside the queue so it cannot delete state after the client saw 408.
      this.assertRequestActive(request);
      // This is intentionally local-only. No IMAP session is opened and no
      // DELETE, EXPUNGE, mailbox, flag, or message operation exists here.
      await this.store.disconnect();
      return statusFromAccount(null);
    });
  }

  private assertRequestActive(request: MailAccountRequestContext): void {
    if (
      request.signal.aborted ||
      !Number.isSafeInteger(request.deadlineAt) ||
      this.now() >= request.deadlineAt
    ) {
      throw new MailAccountError("imap_connection_timeout");
    }
  }

  private async mutate<T>(
    request: MailAccountRequestContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    let started = false;
    const execute = () => {
      started = true;
      return operation();
    };
    const run = this.mutationTail.then(execute, execute);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );

    // Cancellation is immediate only while this mutation is waiting for the
    // queue. Once operation() starts, its own commit boundary decides whether
    // to abort or finish, so the HTTP response cannot lie about a late write.
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        if (!started) {
          finish(() => reject(new MailAccountError("imap_connection_timeout")));
        }
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
      if (request.signal.aborted) onAbort();
    });
  }
}

export class MultiMailAccountService implements MailAccountServiceV2 {
  readonly localSchemaVersion = 2 as const;
  private readonly store: MultiMailAccountStore;
  private readonly verifier: ImapCredentialVerifier;
  private readonly smtpVerifier: SmtpCredentialVerifier | undefined;
  private readonly removalGuard: MailAccountRemovalGuard | undefined;
  private readonly protocolMutationGuard:
    | MailAccountProtocolMutationGuard
    | undefined;
  private readonly smtpSubmissionReady: () => boolean;
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly store: MultiMailAccountStore;
    readonly verifier: ImapCredentialVerifier;
    readonly smtpVerifier?: SmtpCredentialVerifier;
    readonly removalGuard?: MailAccountRemovalGuard;
    readonly protocolMutationGuard?: MailAccountProtocolMutationGuard;
    readonly smtpSubmissionReady?: boolean | (() => boolean);
    readonly now?: () => number;
  }) {
    this.store = options.store;
    this.verifier = options.verifier;
    this.smtpVerifier = options.smtpVerifier;
    this.removalGuard = options.removalGuard;
    this.protocolMutationGuard = options.protocolMutationGuard;
    const smtpSubmissionReady = options.smtpSubmissionReady;
    this.smtpSubmissionReady =
      typeof smtpSubmissionReady === "function"
        ? smtpSubmissionReady
        : () => smtpSubmissionReady ?? true;
    this.now = options.now ?? Date.now;
  }

  async accountCount(): Promise<number> {
    return this.store.countAccounts();
  }

  async list(): Promise<MailAccountsStatus> {
    const accounts = (await this.store.listAccounts()).map(publicMailAccountV2);
    return Object.freeze({ apiVersion: 2, accounts: Object.freeze(accounts) });
  }

  async listCapabilities(): Promise<MailAccountsCapabilitiesStatus> {
    const accounts = (await this.store.listAccounts()).map((stored) =>
      publicMailAccountV3(stored, this.smtpSubmissionReady()),
    );
    return Object.freeze({ apiVersion: 3, accounts: Object.freeze(accounts) });
  }

  async add(
    rawInput: MailAccountCreateInput,
    request: MailAccountRequestContext,
  ): Promise<MailAccountResult> {
    const input = validateMailAccountCreateInput(rawInput);
    return this.mutate(request, () => this.addUnlocked(input, request));
  }

  async update(
    accountId: string,
    rawPatch: MailAccountPatchInput,
    request: MailAccountRequestContext,
  ): Promise<MailAccountResult> {
    const patch = validateMailAccountPatchInput(rawPatch);
    return this.mutate(request, () =>
      this.updateUnlocked(accountId, patch, request),
    );
  }

  async remove(
    accountId: string,
    request: MailAccountRequestContext,
  ): Promise<MailAccountResult> {
    return this.mutate(request, () => this.removeUnlocked(accountId, request));
  }

  async status(): Promise<MailAccountStatus> {
    const firstImap = (await this.store.listAccounts()).find(
      (stored) => stored.providerKind === "imap",
    );
    return statusFromAccount(
      firstImap?.providerKind === "imap" ? firstImap.account : null,
    );
  }

  async connect(
    input: MailAccountConnectInput,
    request: MailAccountRequestContext,
  ): Promise<MailAccountStatus> {
    const validated = validateMailAccountConnectInput(input);
    return this.mutate(request, async () => {
      const current = await this.store.listAccounts();
      if (current.length > 1 || current.some((stored) => stored.providerKind !== "imap")) {
        throw new MailAccountError("account_selection_required");
      }
      const first = current[0] ?? null;
      const result = first
        ? await this.updateUnlocked(
          first.account.accountId,
          validateMailAccountPatchInput({
            emailAddress: validated.emailAddress,
            imap: validated.imap,
            ...(validated.smtp ? { smtp: validated.smtp } : {}),
          }),
            request,
          )
        : await this.addUnlocked(
            validateMailAccountCreateInput({
              ...validated,
              providerKind: "imap",
              displayName: null,
            }),
            request,
          );
      return statusFromPublicV2(result.account);
    });
  }

  async disconnect(request: MailAccountRequestContext): Promise<MailAccountStatus> {
    return this.mutate(request, async () => {
      const current = await this.store.listAccounts();
      if (current.length > 1 || current.some((stored) => stored.providerKind !== "imap")) {
        throw new MailAccountError("account_selection_required");
      }
      const first = current[0] ?? null;
      if (!first) return statusFromAccount(null);
      await this.removeUnlocked(first.account.accountId, request);
      return statusFromAccount(null);
    });
  }

  private async addUnlocked(
    input: MailAccountCreateInput,
    request: MailAccountRequestContext,
  ): Promise<MailAccountResult> {
    this.assertRequestActive(request);
    const current = await this.store.listAccounts();
    if (current.length >= MAX_MAIL_ACCOUNTS) {
      throw new MailAccountError("account_limit_reached");
    }
    if (
      current.some(
        (stored) =>
          normalizedEmail(stored.account.emailAddress) ===
            normalizedEmail(input.emailAddress),
      )
    ) {
      throw new MailAccountError("account_already_exists");
    }
    if (input.imap.password === null) {
      throw new MailAccountError("account_request_invalid");
    }
    const connectedAt = this.now();
    const account = nextProvisionedAccount(null, input, connectedAt);
    const stored: StoredMailAccount = Object.freeze({
      account,
      providerKind: "imap",
      displayName: input.displayName,
      status: "connected",
      createdAt: connectedAt,
      updatedAt: connectedAt,
    });
    const password = Buffer.from(input.imap.password, "utf8");
    try {
      await this.verifier.verify({
        endpoint: account.endpoint,
        username: account.username,
        password,
        deadlineAt: request.deadlineAt,
        signal: request.signal,
      });
      if (account.smtp) {
        if (!this.smtpVerifier) {
          throw new MailAccountError("account_state_unavailable");
        }
        await this.smtpVerifier.verify({
          endpoint: account.smtp.endpoint,
          username: account.smtp.username,
          password,
          deadlineAt: request.deadlineAt,
          signal: request.signal,
        });
      }
      this.assertRequestActive(request);
      await this.store.save(stored, password, request.signal);
      return accountResult(stored);
    } finally {
      password.fill(0);
    }
  }

  private async updateUnlocked(
    accountId: string,
    patch: MailAccountPatchInput,
    request: MailAccountRequestContext,
  ): Promise<MailAccountResult> {
    this.assertRequestActive(request);
    const current = await this.store.readAccount(accountId);
    if (!current) throw new MailAccountError("account_not_found");
    if (current.providerKind !== "imap") {
      throw new MailAccountError("account_request_invalid");
    }
    if (patch.emailAddress !== undefined) {
      const normalized = normalizedEmail(patch.emailAddress);
      const duplicate = (await this.store.listAccounts()).some(
        (stored) =>
          stored.account.accountId !== accountId &&
          normalizedEmail(stored.account.emailAddress) === normalized,
      );
      if (duplicate) throw new MailAccountError("account_already_exists");
    }
    const updatedAt = this.now();
    if (
      patch.emailAddress === undefined &&
      patch.imap === undefined &&
      patch.smtp === undefined
    ) {
      const stored: StoredMailAccount = Object.freeze({
        ...current,
        displayName: patch.displayName ?? null,
        updatedAt,
      });
      await this.store.updateMetadata(stored, request.signal);
      return accountResult(stored);
    }

    const operation = () =>
      this.updateConnectionUnlocked(current, patch, request, updatedAt);
    return this.protocolMutationGuard
      ? this.protocolMutationGuard.run(
          accountId,
          {
            preservesBindings: patchPreservesProtocolBindings(
              current.account,
              patch,
            ),
          },
          operation,
        )
      : operation();
  }

  private async updateConnectionUnlocked(
    current: StoredImapMailAccount,
    patch: MailAccountPatchInput,
    request: MailAccountRequestContext,
    updatedAt: number,
  ): Promise<MailAccountResult> {
    const accountId = current.account.accountId;
    this.assertRequestActive(request);
    const loaded = await this.store.loadProvisionedAccount(accountId);
    if (!loaded) throw new MailAccountError("account_not_found");
    let password: Buffer | undefined;
    try {
      this.assertRequestActive(request);
      const mergedSmtp = mergeSmtpPatch(current.account, patch.smtp);
      const merged = validateMailAccountConnectInput({
        emailAddress: patch.emailAddress ?? current.account.emailAddress,
        imap: {
          hostname: patch.imap?.hostname ?? current.account.endpoint.hostname,
          port: patch.imap?.port ?? current.account.endpoint.port,
          tls: patch.imap?.tls ?? current.account.endpoint.tls,
          username: patch.imap?.username ?? current.account.username,
          password: patch.imap?.password ?? null,
        },
        ...(mergedSmtp ? { smtp: mergedSmtp } : {}),
      });
      if (
        merged.imap.password === null &&
        !sameConnectionIdentity(current.account, merged)
      ) {
        throw new MailAccountError("account_request_invalid");
      }
      password =
        merged.imap.password === null
          ? loaded.password
          : Buffer.from(merged.imap.password, "utf8");
      if (password !== loaded.password) loaded.password.fill(0);
      const account = nextProvisionedAccount(
        current.account,
        merged,
        updatedAt,
      );
      const stored: StoredMailAccount = Object.freeze({
        account,
        providerKind: "imap",
        displayName:
          patch.displayName === undefined ? current.displayName : patch.displayName,
        status: "connected",
        createdAt: current.createdAt,
        updatedAt,
      });
      await this.verifier.verify({
        endpoint: account.endpoint,
        username: account.username,
        password,
        deadlineAt: request.deadlineAt,
        signal: request.signal,
      });
      if (account.smtp) {
        if (!this.smtpVerifier) {
          throw new MailAccountError("account_state_unavailable");
        }
        await this.smtpVerifier.verify({
          endpoint: account.smtp.endpoint,
          username: account.smtp.username,
          password,
          deadlineAt: request.deadlineAt,
          signal: request.signal,
        });
      }
      this.assertRequestActive(request);
      await this.store.save(stored, password, request.signal);
      return accountResult(stored);
    } finally {
      password?.fill(0);
      loaded.password.fill(0);
    }
  }

  private async removeUnlocked(
    accountId: string,
    request: MailAccountRequestContext,
  ): Promise<MailAccountResult> {
    this.assertRequestActive(request);
    const current = await this.store.readAccount(accountId);
    if (!current) throw new MailAccountError("account_not_found");
    let invalidated = false;
    try {
      if (this.removalGuard) {
        await this.removalGuard.invalidateAccount(accountId);
        invalidated = true;
      }
      if (!(await this.store.deleteAccount(accountId))) {
        throw new MailAccountError("account_not_found");
      }
    } catch (error) {
      if (invalidated) {
        try {
          await this.removalGuard?.restoreInvalidatedAccount(accountId);
        } catch {
          throw new MailAccountError("account_state_unavailable");
        }
      }
      throw error;
    }
    return accountResult(current);
  }

  private assertRequestActive(request: MailAccountRequestContext): void {
    if (
      request.signal.aborted ||
      !Number.isSafeInteger(request.deadlineAt) ||
      this.now() >= request.deadlineAt
    ) {
      throw new MailAccountError("imap_connection_timeout");
    }
  }

  private async mutate<T>(
    request: MailAccountRequestContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    let started = false;
    const execute = () => {
      started = true;
      return operation();
    };
    const run = this.mutationTail.then(execute, execute);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        if (!started) {
          finish(() => reject(new MailAccountError("imap_connection_timeout")));
        }
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
      if (request.signal.aborted) onAbort();
    });
  }
}

function sameConnectionIdentity(
  previous: ProvisionedImapAccount,
  input: MailAccountConnectInput,
): boolean {
  const imapIsUnchanged =
    previous.endpoint.hostname === input.imap.hostname &&
    previous.endpoint.port === input.imap.port &&
    previous.endpoint.tls === input.imap.tls &&
    previous.username === input.imap.username;
  if (!imapIsUnchanged) return false;

  // Removing SMTP cannot disclose the saved secret. Adding SMTP or changing
  // its destination must require the password again so a same-origin request
  // cannot redirect an existing credential to another server.
  if (!input.smtp) return true;
  if (!previous.smtp) return false;
  return (
    previous.smtp.endpoint.hostname === input.smtp.hostname &&
    previous.smtp.endpoint.port === input.smtp.port &&
    previous.smtp.endpoint.tls === input.smtp.tls &&
    previous.smtp.username === input.smtp.username
  );
}

function patchPreservesProtocolBindings(
  previous: ProvisionedImapAccount,
  patch: MailAccountPatchInput,
): boolean {
  if (
    (patch.imap?.hostname !== undefined &&
      patch.imap.hostname !== previous.endpoint.hostname) ||
    (patch.imap?.port !== undefined &&
      patch.imap.port !== previous.endpoint.port) ||
    (patch.imap?.tls !== undefined &&
      patch.imap.tls !== previous.endpoint.tls) ||
    (patch.imap?.username !== undefined &&
      patch.imap.username !== previous.username)
  ) {
    return false;
  }
  if (patch.smtp === undefined) return true;
  if (patch.smtp === null) return previous.smtp === undefined;
  if (!previous.smtp) return false;
  return (
    (patch.smtp.hostname === undefined ||
      patch.smtp.hostname === previous.smtp.endpoint.hostname) &&
    (patch.smtp.port === undefined ||
      patch.smtp.port === previous.smtp.endpoint.port) &&
    (patch.smtp.tls === undefined ||
      patch.smtp.tls === previous.smtp.endpoint.tls) &&
    (patch.smtp.username === undefined ||
      patch.smtp.username === previous.smtp.username)
  );
}

function mergeSmtpPatch(
  previous: ProvisionedImapAccount,
  patch: MailAccountPatchInput["smtp"],
): MailAccountConnectInput["smtp"] | undefined {
  if (patch === null) return undefined;
  if (patch === undefined) {
    return previous.smtp
      ? {
          ...previous.smtp.endpoint,
          username: previous.smtp.username,
        }
      : undefined;
  }
  if (
    !previous.smtp &&
    (patch.hostname === undefined ||
      patch.port === undefined ||
      patch.tls === undefined ||
      patch.username === undefined)
  ) {
    throw new MailAccountError("account_request_invalid");
  }
  return {
    hostname: patch.hostname ?? previous.smtp!.endpoint.hostname,
    port: patch.port ?? previous.smtp!.endpoint.port,
    tls: patch.tls ?? previous.smtp!.endpoint.tls,
    username: patch.username ?? previous.smtp!.username,
  };
}

function nextProvisionedAccount(
  previous: ProvisionedImapAccount | null,
  input: MailAccountConnectInput,
  connectedAt: number,
): ProvisionedImapAccount {
  if (!Number.isSafeInteger(connectedAt) || connectedAt < 0) {
    throw new MailAccountError("account_state_unavailable");
  }
  const nextCredentialVersion = (previous?.credentialRef.version ?? 0) + 1;
  const nextBindingVersion = (previous?.transportBindingRef.version ?? 0) + 1;
  const nextCredentialRefId =
    previous?.credentialRef.id ??
    `credential-r${randomBytes(16).toString("hex")}`;
  const nextSmtpBindingVersion = input.smtp
    ? (previous?.smtp?.transportBindingRef.version ?? 0) + 1
    : undefined;
  if (
    !Number.isSafeInteger(nextCredentialVersion) ||
    !Number.isSafeInteger(nextBindingVersion) ||
    (nextSmtpBindingVersion !== undefined &&
      !Number.isSafeInteger(nextSmtpBindingVersion))
  ) {
    throw new MailAccountError("account_state_unavailable");
  }
  return Object.freeze({
    accountId: previous?.accountId ?? `account-a${randomBytes(16).toString("hex")}`,
    emailAddress: input.emailAddress,
    endpoint: Object.freeze({
      hostname: input.imap.hostname,
      port: input.imap.port,
      tls: input.imap.tls,
    }),
    username: input.imap.username,
    credentialRef: Object.freeze({
      id: nextCredentialRefId,
      version: nextCredentialVersion,
    }),
    transportBindingRef: Object.freeze({
      id:
        previous?.transportBindingRef.id ??
        `binding-r${randomBytes(16).toString("hex")}`,
      version: nextBindingVersion,
    }),
    ...(input.smtp
      ? {
          smtp: Object.freeze({
            endpoint: Object.freeze({
              hostname: input.smtp.hostname,
              port: input.smtp.port,
              tls: input.smtp.tls,
            }),
            username: input.smtp.username,
            credentialRef: Object.freeze({
              id: nextCredentialRefId,
              version: nextCredentialVersion,
            }),
            transportBindingRef: Object.freeze({
              id:
                previous?.smtp?.transportBindingRef.id ??
                `binding-r${randomBytes(16).toString("hex")}`,
              version: nextSmtpBindingVersion!,
            }),
          }),
        }
      : {}),
    connectedAt,
  });
}

function statusFromAccount(
  account: ProvisionedImapAccount | null,
): MailAccountStatus {
  return Object.freeze({
    apiVersion: 1,
    configured: account !== null,
    account: account ? publicMailAccount(account) : null,
  });
}

function accountResult(stored: StoredMailAccount): MailAccountResult {
  return Object.freeze({ apiVersion: 2, account: publicMailAccountV2(stored) });
}

function statusFromPublicV2(
  account: MailAccountResult["account"],
): MailAccountStatus {
  if (account.providerKind !== "imap") {
    throw new MailAccountError("account_state_invalid");
  }
  return Object.freeze({
    apiVersion: 1,
    configured: true,
    account: Object.freeze({
      accountId: account.accountId,
      emailAddress: account.emailAddress,
      imap: account.imap,
      ...(account.smtp ? { smtp: account.smtp } : {}),
      connectedAt: account.connectedAt,
    }),
  });
}

function normalizedEmail(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}
