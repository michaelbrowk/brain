import path from "node:path";

import type {
  MailMailboxThreadPage,
  MailSearchThreadPage,
  MailSyncResult,
  MailSystemMailbox,
  MailThreadDetail,
  MailThreadMutationInput,
  MailThreadMutationResult,
  MailThreadPage,
} from "../message-types";
import { GmailApiClient } from "../providers/gmail/api-client";
import { StoredGmailAccessTokenPort } from "../providers/gmail/access-token-port";
import { GmailMailSyncAdapter } from "../providers/gmail/sync-adapter";
import { ImapMailSyncAdapter } from "../providers/imap/sync-adapter";
import type { MultiMailAccountStore } from "./account-store";
import { MailAccountError, type StoredMailAccount } from "./account-types";
import { CompleteSetMailDnsResolver } from "./dns";
import {
  ImapFlowReadSessionFactory,
  type ImapSessionClient,
} from "./imapflow-adapter";
import {
  type MailReplyContext,
  selectWorstMailSyncError,
  SqliteMailMessageCache,
} from "./message-cache";
import {
  AccountMailMessageService,
  type MailBackgroundSyncStep,
  type MailBackgroundSyncHealth,
  type MailMessageService,
  type MailProviderSyncPort,
  MailProviderSyncError,
} from "./message-service";

export interface MailProviderFactory {
  create(
    account: StoredMailAccount,
  ): Promise<{
    readonly provider: MailProviderSyncPort;
    readonly destroy?: () => void;
  }>;
}

interface RegistryEntry {
  readonly credentialVersion: number;
  readonly providerKind: StoredMailAccount["providerKind"];
  readonly transportBindingVersion: number | null;
  readonly cache: SqliteMailMessageCache;
  readonly service: AccountMailMessageService;
  readonly destroyProvider: (() => void) | undefined;
  readonly lifecycle: AbortController;
  activeOperations: number;
  readonly drained: Array<() => void>;
}

export class MultiAccountMailMessageService implements MailMessageService {
  private readonly stateDirectory: string;
  private readonly store: MultiMailAccountStore;
  private readonly providerFactory: MailProviderFactory;
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly invalidatedAccounts = new Set<string>();
  private resolutionTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly stateDirectory: string;
    readonly store: MultiMailAccountStore;
    readonly providerFactory: MailProviderFactory;
  }) {
    if (!path.isAbsolute(options.stateDirectory) || path.resolve(options.stateDirectory) !== options.stateDirectory) {
      throw new MailProviderSyncError("mail_provider_unavailable");
    }
    this.stateDirectory = options.stateDirectory;
    this.store = options.store;
    this.providerFactory = options.providerFactory;
  }

  async readBackgroundSyncHealth(): Promise<MailBackgroundSyncHealth> {
    const accounts = await this.store.listAccounts();
    if (accounts.length === 0) {
      return Object.freeze({ lastSuccessfulAt: null, lastErrorCode: null });
    }
    const states = await Promise.all(
      accounts.map((account) =>
        this.withEntry(account.account.accountId, (entry) =>
          entry.service.readBackgroundSyncHealth(),
        ),
      ),
    );
    const successful = states.map((state) => state.lastSuccessfulAt);
    return Object.freeze({
      lastSuccessfulAt: successful.every(
        (value): value is number => value !== null,
      )
        ? Math.min(...successful)
        : null,
      lastErrorCode: selectWorstMailSyncError(
        states.map((state) => state.lastErrorCode).concat(
          accounts.map((account) =>
            account.status === "reauth_required"
              ? account.providerKind === "gmail"
                ? "gmail_reauth_required"
                : "mail_provider_reauth_required"
              : null,
          ),
        ),
      ),
    });
  }

  async listThreads(input: {
    readonly accountId: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<MailThreadPage> {
    return this.withEntry(input.accountId, (entry) => entry.service.listThreads(input));
  }

  async listMailboxThreads(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<MailMailboxThreadPage> {
    return this.withEntry(input.accountId, (entry) =>
      entry.service.listMailboxThreads(input),
    );
  }

  async searchThreads(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly query: string;
    readonly cursor?: string | null;
    readonly limit: number;
  }): Promise<MailSearchThreadPage> {
    return this.withEntry(input.accountId, (entry) =>
      entry.service.searchThreads(input),
    );
  }

  async getThread(input: {
    readonly accountId: string;
    readonly threadId: string;
  }): Promise<MailThreadDetail | null> {
    return this.withEntry(input.accountId, (entry) => entry.service.getThread(input));
  }

  async getMailboxThread(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly threadId: string;
  }): Promise<MailThreadDetail | null> {
    return this.withEntry(input.accountId, (entry) =>
      entry.service.getMailboxThread(input),
    );
  }

  async sync(
    input: { readonly accountId: string; readonly maxItems: number },
    signal: AbortSignal,
  ): Promise<MailSyncResult> {
    return this.withEntry(input.accountId, (entry, lifecycleSignal) =>
      entry.service.sync(input, AbortSignal.any([signal, lifecycleSignal])),
    );
  }

  async syncAccount(
    accountId: string,
    options: { readonly maxItems: number },
    signal?: AbortSignal,
  ): Promise<MailSyncResult> {
    const callerSignal = signal ?? new AbortController().signal;
    return this.withEntry(accountId, (entry, lifecycleSignal) =>
      entry.service.syncAccount(
        accountId,
        options,
        AbortSignal.any([callerSignal, lifecycleSignal]),
      ),
    );
  }

  async runBackgroundSyncStep(
    accountId: string,
    options: { readonly maxItems: number },
    signal?: AbortSignal,
  ): Promise<MailBackgroundSyncStep> {
    const callerSignal = signal ?? new AbortController().signal;
    return this.withEntry(accountId, (entry, lifecycleSignal) =>
      entry.service.runBackgroundSyncStep(
        accountId,
        options,
        AbortSignal.any([callerSignal, lifecycleSignal]),
      ),
    );
  }

  async listAccountIds(): Promise<readonly string[]> {
    const accounts = await this.store.listAccounts();
    return Object.freeze(
      accounts
        .filter((account) => account.status === "connected")
        .map((account) => account.account.accountId),
    );
  }

  async updateThread(
    input: MailThreadMutationInput & { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<MailThreadMutationResult> {
    return this.withEntry(input.accountId, (entry, lifecycleSignal) =>
      entry.service.updateThread(input, AbortSignal.any([signal, lifecycleSignal])),
    );
  }

  async readReplyContext(
    accountId: string,
    messageId: string,
  ): Promise<MailReplyContext | null> {
    return this.withEntry(accountId, (entry) => entry.cache.readReplyContext(messageId));
  }

  /**
   * Must run before account-store cache rename. It prevents new leases, aborts
   * active provider work, waits for every cache transaction to settle, then
   * closes SQLite so DELETE cannot race a late writer.
   */
  async invalidateAccount(accountId: string): Promise<void> {
    const execute = async () => {
      this.invalidatedAccounts.add(accountId);
      const entry = this.entries.get(accountId);
      if (!entry) return;
      entry.lifecycle.abort(new MailAccountError("account_not_found"));
      if (entry.activeOperations > 0) {
        await new Promise<void>((resolve) => entry.drained.push(resolve));
      }
      this.destroyEntry(entry);
      this.entries.delete(accountId);
    };
    const run = this.resolutionTail.then(execute, execute);
    this.resolutionTail = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  /** Call only when account-store DELETE failed before commit. */
  restoreInvalidatedAccount(accountId: string): void {
    this.invalidatedAccounts.delete(accountId);
  }

  async close(): Promise<void> {
    const execute = async () => {
      for (const [accountId, entry] of this.entries) {
        this.invalidatedAccounts.add(accountId);
        entry.lifecycle.abort(new MailProviderSyncError("mail_provider_unavailable"));
      }
      const active = [...this.entries.values()].filter(
        (entry) => entry.activeOperations > 0,
      );
      await Promise.all(
        active.map(
          (entry) => new Promise<void>((resolve) => entry.drained.push(resolve)),
        ),
      );
      for (const entry of this.entries.values()) this.destroyEntry(entry);
      this.entries.clear();
    };
    const run = this.resolutionTail.then(execute, execute);
    this.resolutionTail = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async withEntry<T>(
    accountId: string,
    operation: (entry: RegistryEntry, lifecycleSignal: AbortSignal) => Promise<T> | T,
  ): Promise<T> {
    let leased: RegistryEntry | null = null;
    const claim = async () => {
      if (this.invalidatedAccounts.has(accountId)) {
        throw new MailAccountError("account_not_found");
      }
      const entry = await this.resolveUnlocked(accountId);
      entry.activeOperations += 1;
      leased = entry;
    };
    const run = this.resolutionTail.then(claim, claim);
    this.resolutionTail = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
    if (leased === null) {
      throw new MailProviderSyncError("mail_provider_unavailable");
    }
    const entry = leased as RegistryEntry;
    try {
      return await operation(entry, entry.lifecycle.signal);
    } finally {
      entry.activeOperations -= 1;
      if (entry.activeOperations === 0) {
        for (const resolve of entry.drained.splice(0)) resolve();
      }
    }
  }

  private async resolveUnlocked(accountId: string): Promise<RegistryEntry> {
    const account = await this.store.readAccount(accountId);
    if (!account) {
      const stale = this.entries.get(accountId);
      if (stale) {
        this.destroyEntry(stale);
        this.entries.delete(accountId);
      }
      throw new MailAccountError("account_not_found");
    }
    const credentialVersion = account.account.credentialRef.version;
    const transportBindingVersion = providerTransportBindingVersion(account);
    const current = this.entries.get(accountId);
    if (
      current &&
      current.credentialVersion === credentialVersion &&
      current.providerKind === account.providerKind &&
      current.transportBindingVersion === transportBindingVersion
    ) {
      return current;
    }
    if (current) {
      current.lifecycle.abort(
        new MailProviderSyncError("mail_provider_reauth_required"),
      );
      if (current.activeOperations > 0) {
        await new Promise<void>((resolve) => current.drained.push(resolve));
      }
      this.destroyEntry(current);
    }
    const created = await this.createEntry(account);
    this.entries.set(accountId, created);
    return created;
  }

  private async createEntry(account: StoredMailAccount): Promise<RegistryEntry> {
    const cache = new SqliteMailMessageCache({
      cacheRoot: path.join(this.stateDirectory, "cache"),
      accountId: account.account.accountId,
    });
    let destroyProvider: (() => void) | undefined;
    try {
      await cache.initialize();
      const transportBindingVersion = providerTransportBindingVersion(account);
      cache.bindBackgroundSyncCredential(
        account.account.credentialRef.version,
        Date.now(),
      );
      cache.bindProviderCacheIdentity({
        providerKind: account.providerKind,
        transportBindingVersion,
      });
      const provider = await this.providerFactory.create(account);
      destroyProvider = provider.destroy;
      return {
        credentialVersion: account.account.credentialRef.version,
        providerKind: account.providerKind,
        transportBindingVersion,
        cache,
        service: new AccountMailMessageService({
          accountId: account.account.accountId,
          cache,
          provider: provider.provider,
          reauthErrorCode:
            account.providerKind === "gmail"
              ? "gmail_reauth_required"
              : "mail_provider_reauth_required",
          hydrateHiddenMailboxes: account.providerKind === "gmail",
        }),
        destroyProvider,
        lifecycle: new AbortController(),
        activeOperations: 0,
        drained: [],
      };
    } catch (error) {
      destroyProvider?.();
      cache.close();
      throw error;
    }
  }

  private destroyEntry(entry: RegistryEntry): void {
    entry.destroyProvider?.();
    entry.cache.close();
  }
}

function providerTransportBindingVersion(
  account: StoredMailAccount,
): number | null {
  return account.providerKind === "imap"
    ? account.account.transportBindingRef.version
    : null;
}
export function createProductionMailProviderFactory(options: {
  readonly store: MultiMailAccountStore;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly request?: typeof fetch;
  readonly imapProviderFactory?: MailProviderFactory;
  readonly imapSessions?: {
    withSession<T>(
      expected: Extract<StoredMailAccount, { readonly providerKind: "imap" }>,
      signal: AbortSignal,
      operation: (client: ImapSessionClient) => Promise<T>,
    ): Promise<T>;
  };
}): MailProviderFactory {
  const imapSessions =
    options.imapSessions ??
    new ImapFlowReadSessionFactory({
      dns: new CompleteSetMailDnsResolver(),
      store: options.store,
    });
  return Object.freeze({
    async create(account: StoredMailAccount) {
      if (account.providerKind === "imap") {
        if (options.imapProviderFactory) {
          return options.imapProviderFactory.create(account);
        }
        return Object.freeze({
          provider: new ImapMailSyncAdapter(account, imapSessions),
        });
      }
      const tokenPort = new StoredGmailAccessTokenPort({
        accountId: account.account.accountId,
        store: options.store,
        environment: options.environment,
        request: options.request,
      });
      const client = new GmailApiClient({ tokenPort, request: options.request });
      return Object.freeze({
        provider: new GmailMailSyncAdapter(account.account.accountId, client),
        destroy: () => tokenPort.destroy(),
      });
    },
  });
}
