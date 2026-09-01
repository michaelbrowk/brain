import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MultiMailAccountStore } from "./account-store";
import type {
  StoredGmailMailAccount,
  StoredImapMailAccount,
} from "./account-types";
import type { ImapSessionClient } from "./imapflow-adapter";
import type { CachedProviderThread } from "./message-cache";
import {
  type MailProviderSyncPort,
  MailProviderSyncError,
} from "./message-service";
import {
  MultiAccountMailMessageService,
  createProductionMailProviderFactory,
  type MailProviderFactory,
} from "./message-service-registry";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("multi-account message registry", () => {
  it("builds the production IMAP receive adapter instead of an unavailable stub", async () => {
    const account = imapAccountFixture();
    const mailbox = {
      path: "INBOX",
      delimiter: "/",
      flags: new Set<string>(),
      uidValidity: BigInt(77),
      uidNext: 1,
      exists: 0,
    };
    const client = {
      mailbox,
      getMailboxLock: vi.fn().mockResolvedValue({
        path: "INBOX",
        release: vi.fn(),
      }),
    } as unknown as ImapSessionClient;
    const imapSessions = {
      async withSession<T>(
        expected: StoredImapMailAccount,
        _signal: AbortSignal,
        operation: (value: ImapSessionClient) => Promise<T>,
      ): Promise<T> {
        expect(expected).toBe(account);
        return operation(client);
      },
    };
    const withSession = vi.spyOn(imapSessions, "withSession");
    const factory = createProductionMailProviderFactory({
      store: storeFixture(),
      environment: {},
      imapSessions,
    });

    const created = await factory.create(account);

    await expect(
      created.provider.listInitialThreads(
        { pageToken: null, maxItems: 20 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ threads: [], nextPageToken: null });
    expect(withSession).toHaveBeenCalledOnce();
  });

  it("aborts and drains an in-flight sync before account cache invalidation returns", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "brain-mail-registry-"));
    roots.push(stateDirectory);
    const started = deferred<void>();
    const provider: MailProviderSyncPort = {
      getSyncAnchor: vi.fn(async (signal) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        throw new Error("unreachable");
      }),
      listInitialThreads: vi.fn(),
      listMailboxThreads: vi.fn(),
      listChanges: vi.fn(),
      getThread: vi.fn(),
      setThreadRead: vi.fn(),
      archiveThread: vi.fn(),
      unarchiveThread: vi.fn(),
      trashThread: vi.fn(),
      restoreThread: vi.fn(),
      setThreadSpam: vi.fn(),
      setThreadStarred: vi.fn(),
    };
    const destroy = vi.fn();
    const providerFactory: MailProviderFactory = {
      create: vi.fn().mockResolvedValue({ provider, destroy }),
    };
    const service = new MultiAccountMailMessageService({
      stateDirectory,
      store: storeFixture(),
      providerFactory,
    });

    const sync = service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    await started.promise;
    const invalidation = service.invalidateAccount(ACCOUNT_ID);
    await expect(sync).rejects.toBeTruthy();
    await expect(invalidation).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(1);
    await expect(
      service.listThreads({ accountId: ACCOUNT_ID, limit: 20 }),
    ).rejects.toMatchObject({ code: "account_not_found" });

    service.restoreInvalidatedAccount(ACCOUNT_ID);
    await expect(
      service.listThreads({ accountId: ACCOUNT_ID, limit: 20 }),
    ).resolves.toMatchObject({ apiVersion: 1, items: [] });
    await service.close();
  });

  it("unparks reauth only after the stored credential version changes", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "brain-mail-registry-"));
    roots.push(stateDirectory);
    let stored = gmailAccountFixture(1);
    const store = storeFixture();
    vi.mocked(store.listAccounts).mockImplementation(async () => [stored]);
    vi.mocked(store.readAccount).mockImplementation(async () => stored);
    const reauthProvider = providerFixture({
      getSyncAnchor: vi
        .fn()
        .mockRejectedValue(
          new MailProviderSyncError("mail_provider_reauth_required"),
        ),
    });
    const healthyProvider = providerFixture({});
    const destroyFirst = vi.fn();
    const providerFactory: MailProviderFactory = {
      create: vi
        .fn()
        .mockResolvedValueOnce({ provider: reauthProvider, destroy: destroyFirst })
        .mockResolvedValueOnce({ provider: healthyProvider }),
    };
    const service = new MultiAccountMailMessageService({
      stateDirectory,
      store,
      providerFactory,
    });

    await expect(
      service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "reauth_required" });
    await expect(service.readBackgroundSyncHealth()).resolves.toEqual({
      lastSuccessfulAt: null,
      lastErrorCode: "gmail_reauth_required",
    });
    await expect(
      service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "reauth_required" });
    expect(providerFactory.create).toHaveBeenCalledTimes(1);

    stored = gmailAccountFixture(2);
    await expect(
      service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle" });
    await expect(service.readBackgroundSyncHealth()).resolves.toEqual({
      lastSuccessfulAt: expect.any(Number),
      lastErrorCode: null,
    });
    stored = gmailAccountFixture(2, "reauth_required");
    await expect(service.readBackgroundSyncHealth()).resolves.toEqual({
      lastSuccessfulAt: expect.any(Number),
      lastErrorCode: "gmail_reauth_required",
    });
    await expect(service.listAccountIds()).resolves.toEqual([]);
    expect(destroyFirst).toHaveBeenCalledTimes(1);
    expect(providerFactory.create).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it("reports provider-aware reauth health for IMAP accounts", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "brain-mail-registry-"));
    roots.push(stateDirectory);
    const stored = imapAccountFixture(
      1,
      "imap.example.test",
      1,
      "reauth_required",
    );
    const store = storeFixture();
    vi.mocked(store.listAccounts).mockResolvedValue([stored]);
    vi.mocked(store.readAccount).mockResolvedValue(stored);
    const service = new MultiAccountMailMessageService({
      stateDirectory,
      store,
      providerFactory: {
        create: vi.fn().mockResolvedValue({ provider: providerFixture({}) }),
      },
    });

    await expect(service.readBackgroundSyncHealth()).resolves.toEqual({
      lastSuccessfulAt: null,
      lastErrorCode: "mail_provider_reauth_required",
    });
    await service.close();
  });

  it("persists provider-aware health when a live IMAP sync needs reauth", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "brain-mail-registry-"));
    roots.push(stateDirectory);
    const stored = imapAccountFixture();
    const store = storeFixture();
    vi.mocked(store.listAccounts).mockResolvedValue([stored]);
    vi.mocked(store.readAccount).mockResolvedValue(stored);
    const service = new MultiAccountMailMessageService({
      stateDirectory,
      store,
      providerFactory: {
        create: vi.fn().mockResolvedValue({
          provider: providerFixture({
            getSyncAnchor: vi
              .fn()
              .mockRejectedValue(
                new MailProviderSyncError("mail_provider_reauth_required"),
              ),
          }),
        }),
      },
    });

    await expect(
      service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "reauth_required" });
    await expect(service.readBackgroundSyncHealth()).resolves.toEqual({
      lastSuccessfulAt: null,
      lastErrorCode: "mail_provider_reauth_required",
    });
    await service.close();
  });

  it("does not reuse cached rows after an IMAP mailbox switch across restart", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "brain-mail-registry-"));
    roots.push(stateDirectory);
    let stored = imapAccountFixture(1, "old.example.test");
    const store = storeFixture();
    vi.mocked(store.listAccounts).mockImplementation(async () => [stored]);
    vi.mocked(store.readAccount).mockImplementation(async () => stored);
    const oldProvider = providerFixture({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [cachedThreadFixture("old-mailbox-thread")],
        nextPageToken: null,
      }),
    });
    const newProvider = providerFixture({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [cachedThreadFixture("new-mailbox-thread")],
        nextPageToken: null,
      }),
    });
    const providerFactory: MailProviderFactory = {
      create: vi.fn(async (account) => ({
        provider:
          account.providerKind === "imap" &&
          account.account.endpoint.hostname === "old.example.test"
            ? oldProvider
            : newProvider,
      })),
    };
    const first = new MultiAccountMailMessageService({
      stateDirectory,
      store,
      providerFactory,
    });

    await expect(
      first.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle" });
    await expect(
      first.listThreads({ accountId: ACCOUNT_ID, limit: 20 }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ threadId: "old-mailbox-thread" })],
    });
    await first.close();

    stored = imapAccountFixture(2, "new.example.test");
    const second = new MultiAccountMailMessageService({
      stateDirectory,
      store,
      providerFactory,
    });
    await expect(
      second.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle" });
    await expect(
      second.listThreads({ accountId: ACCOUNT_ID, limit: 20 }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ threadId: "new-mailbox-thread" })],
    });
    expect(oldProvider.listChanges).not.toHaveBeenCalled();
    expect(newProvider.listChanges).not.toHaveBeenCalled();
    expect(oldProvider.listMailboxThreads).not.toHaveBeenCalled();
    expect(newProvider.listMailboxThreads).not.toHaveBeenCalled();
    await second.close();
  });

  it("keeps the IMAP rollback guard bound after a credential edit and sync", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "brain-mail-registry-"));
    roots.push(stateDirectory);
    let stored = imapAccountFixture(1, "imap.example.test", 1);
    const store = storeFixture();
    vi.mocked(store.listAccounts).mockImplementation(async () => [stored]);
    vi.mocked(store.readAccount).mockImplementation(async () => stored);
    const firstProvider = providerFixture({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [cachedThreadFixture("before-credential-edit")],
        nextPageToken: null,
      }),
    });
    const secondProvider = providerFixture({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [cachedThreadFixture("after-credential-edit")],
        nextPageToken: null,
      }),
    });
    const providerFactory: MailProviderFactory = {
      create: vi
        .fn()
        .mockResolvedValueOnce({ provider: firstProvider })
        .mockResolvedValueOnce({ provider: secondProvider }),
    };
    const service = new MultiAccountMailMessageService({
      stateDirectory,
      store,
      providerFactory,
    });

    await expect(
      service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle" });
    stored = imapAccountFixture(2, "imap.example.test", 1);
    await expect(
      service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle" });
    await service.close();

    const database = new DatabaseSync(
      path.join(stateDirectory, "cache", ACCOUNT_ID, "messages.sqlite3"),
      {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
      },
    );
    try {
      expect(
        database
          .prepare(
            `SELECT provider_kind, transport_binding_version
               FROM provider_cache_binding
              WHERE account_id = ?`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({
        provider_kind: "imap",
        transport_binding_version: 1,
      });
      expect(
        database
          .prepare(
            `SELECT credential_version
               FROM background_sync_control
              WHERE account_id = ?`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({ credential_version: 2 });
      expect(
        database
          .prepare(
            `SELECT thread_id
               FROM threads
              WHERE account_id = ?
              ORDER BY thread_id ASC`,
          )
          .all(ACCOUNT_ID),
      ).toEqual([{ thread_id: "after-credential-edit" }]);
      expect(
        database
          .prepare(
            `SELECT name
               FROM sqlite_master
              WHERE type = 'trigger'
                AND name = 'reset_imap_snapshot_on_legacy_credential_rebind'`,
          )
          .get(),
      ).toEqual({ name: "reset_imap_snapshot_on_legacy_credential_rebind" });
    } finally {
      database.close();
    }
  });
});

function storeFixture(): MultiMailAccountStore {
  const stored = gmailAccountFixture();
  return {
    localSchemaVersion: 2,
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    countAccounts: vi.fn().mockResolvedValue(1),
    listAccounts: vi.fn().mockResolvedValue([stored]),
    readAccount: vi.fn().mockResolvedValue(stored),
    loadProvisionedAccount: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    loadGmailCredential: vi.fn().mockResolvedValue(null),
    deleteAccount: vi.fn().mockResolvedValue(true),
  };
}

function imapAccountFixture(
  version = 1,
  hostname = "imap.example.test",
  transportBindingVersion = version,
  status: StoredImapMailAccount["status"] = "connected",
): StoredImapMailAccount {
  return Object.freeze({
    account: Object.freeze({
      accountId: ACCOUNT_ID,
      emailAddress: "reader@example.test",
      endpoint: Object.freeze({
        hostname,
        port: 993,
        tls: "implicit" as const,
      }),
      username: "reader@example.test",
      credentialRef: Object.freeze({
        id: "credential-r11111111111111111111111111111111",
        version,
      }),
      transportBindingRef: Object.freeze({
        id: "binding-r11111111111111111111111111111111",
        version: transportBindingVersion,
      }),
      connectedAt: 1,
    }),
    providerKind: "imap",
    displayName: null,
    status,
    createdAt: 1,
    updatedAt: 1,
  });
}

function cachedThreadFixture(threadId: string): CachedProviderThread {
  return Object.freeze({
    thread: Object.freeze({
      accountId: ACCOUNT_ID,
      threadId,
      subject: threadId,
      participants: Object.freeze([]),
      snippet: null,
      lastMessageAt: 1_000,
      messageCount: 1,
      unread: true,
      starred: false,
      hasAttachments: false,
      listMessage: false,
      sizeBytes: 0,
      category: "people" as const,
    }),
    messages: Object.freeze([
      Object.freeze({
        accountId: ACCOUNT_ID,
        messageId: `${threadId}-message`,
        threadId,
        from: null,
        replyTo: Object.freeze([]),
        to: Object.freeze([]),
        cc: Object.freeze([]),
        subject: threadId,
        sentAt: 1_000,
        unread: true,
        inInbox: true,
        snippet: null,
        textBody: null,
        htmlBody: null,
        hasAttachments: false,
        rfcMessageId: null,
        references: Object.freeze([]),
        listMessage: false,
        category: "people" as const,
        sizeEstimate: null,
      }),
    ]),
    inInbox: true,
    mailboxes: Object.freeze(["all" as const, "inbox" as const]),
  });
}

function gmailAccountFixture(
  version = 1,
  status: StoredGmailMailAccount["status"] = "connected",
): StoredGmailMailAccount {
  return Object.freeze({
    account: Object.freeze({
      accountId: ACCOUNT_ID,
      emailAddress: "reader@example.test",
      subject: "subject",
      credentialRef: Object.freeze({
        id: "credential-r11111111111111111111111111111111",
        version,
      }),
      connectedAt: 1,
      grantedAt: 1,
    }),
    providerKind: "gmail",
    displayName: null,
    status,
    createdAt: 1,
    updatedAt: 1,
  });
}

function providerFixture(
  overrides: Partial<MailProviderSyncPort>,
): MailProviderSyncPort {
  return {
    getSyncAnchor: vi.fn().mockResolvedValue("100"),
    listInitialThreads: vi.fn().mockResolvedValue({
      threads: [],
      nextPageToken: null,
    }),
    listMailboxThreads: vi.fn().mockResolvedValue({
      threads: [],
      listedCount: 0,
      nextPageToken: null,
    }),
    listChanges: vi.fn().mockResolvedValue({
      changedThreadIds: [],
      nextPageToken: null,
      resultingHistoryId: "100",
    }),
    getThread: vi.fn().mockResolvedValue(null),
    setThreadRead: vi.fn().mockResolvedValue(undefined),
    archiveThread: vi.fn().mockResolvedValue(undefined),
    unarchiveThread: vi.fn().mockResolvedValue(undefined),
    trashThread: vi.fn().mockResolvedValue(undefined),
    restoreThread: vi.fn().mockResolvedValue(undefined),
    setThreadSpam: vi.fn().mockResolvedValue(undefined),
    setThreadStarred: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
