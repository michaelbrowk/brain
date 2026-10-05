import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailThreadBatchPress, MailThreadListItem } from "../message-types";
import type { GmailApiClient } from "../providers/gmail/api-client";
import { GmailMailSyncAdapter } from "../providers/gmail/sync-adapter";
import { MAIL_CHANGE_ALL_MAILBOXES, type MailServiceChange } from "./change-feed-ring";
import {
  type CachedProviderMessage,
  type CachedProviderThread,
  MailCacheError,
  SqliteMailMessageCache,
} from "./message-cache";
import {
  AccountMailMessageService,
  type MailProviderBatchOutcome,
  type MailProviderSyncPort,
  MailProviderSyncError,
} from "./message-service";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("account mail message service", () => {
  it("exposes a mailbox snapshot without provider History or generation fields", async () => {
    const fixture = await createService({});
    vi.spyOn(fixture.cache, "listMailboxThreads").mockReturnValue({
      apiVersion: 1,
      mailboxId: "sent",
      items: [threadFixture("thread-sent", 2000).thread],
      nextCursor: null,
      availability: {
        status: "available",
        activeGeneration: 7,
        observedHistoryId: "123456",
        lastSuccessfulAt: 2000,
        windowTruncated: true,
      },
    });

    const page = await fixture.service.listMailboxThreads({
      accountId: ACCOUNT_ID,
      mailboxId: "sent",
      limit: 20,
    });

    expect(page).toEqual({
      apiVersion: 1,
      mailboxId: "sent",
      items: [threadFixture("thread-sent", 2000).thread],
      nextCursor: null,
      availability: {
        status: "available",
        lastSuccessfulAt: 2000,
        windowTruncated: true,
      },
    });
    expect(JSON.stringify(page)).not.toMatch(/123456|activeGeneration/);
    fixture.cache.close();
  });

  it("resumes a bounded initial page while exposing the downloaded first page", async () => {
    const fixture = await createService({
      listInitialThreads: vi
        .fn<MailProviderSyncPort["listInitialThreads"]>()
        .mockResolvedValueOnce({
          threads: [threadFixture("thread-a", 1000)],
          nextPageToken: "page-two",
        })
        .mockResolvedValueOnce({
          threads: [threadFixture("thread-b", 2000)],
          nextPageToken: null,
        }),
    });

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toEqual({
      apiVersion: 1,
      status: "syncing",
      changedCount: 1,
      hasMore: true,
    });
    expect(
      (
        await fixture.service.listThreads({ accountId: ACCOUNT_ID, limit: 10 })
      ).items.map((item) => item.threadId),
    ).toEqual(["thread-a"]);

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle", hasMore: false });
    expect(fixture.provider.listInitialThreads).toHaveBeenNthCalledWith(
      2,
      { pageToken: "page-two", maxItems: 20 },
      expect.any(AbortSignal),
    );
    expect((await fixture.service.listThreads({ accountId: ACCOUNT_ID, limit: 10 })).items
      .map((item) => item.threadId)).toEqual(["thread-b", "thread-a"]);
    fixture.cache.close();
  });

  it("restarts one initial generation when its provider cursor becomes stale", async () => {
    const getSyncAnchor = vi
      .fn<MailProviderSyncPort["getSyncAnchor"]>()
      .mockResolvedValueOnce("100")
      .mockResolvedValueOnce("200");
    const listInitialThreads = vi
      .fn<MailProviderSyncPort["listInitialThreads"]>()
      .mockRejectedValueOnce(
        new MailProviderSyncError("mail_provider_cursor_invalid"),
      )
      .mockResolvedValueOnce({
        threads: [threadFixture("thread-after-reset", 2000)],
        nextPageToken: null,
      });
    const fixture = await createService({ getSyncAnchor, listInitialThreads });

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toEqual({
      apiVersion: 1,
      status: "idle",
      changedCount: 1,
      hasMore: false,
    });

    expect(getSyncAnchor).toHaveBeenCalledTimes(2);
    expect(listInitialThreads).toHaveBeenNthCalledWith(
      2,
      { pageToken: null, maxItems: 20 },
      expect.any(AbortSignal),
    );
    expect(fixture.cache.readSyncState()).toMatchObject({
      activeGeneration: 1,
      stagedGeneration: null,
      historyId: "200",
      status: "idle",
    });
    expect(
      (
        await fixture.service.listThreads({ accountId: ACCOUNT_ID, limit: 10 })
      ).items.map((item) => item.threadId),
    ).toEqual(["thread-after-reset"]);
    fixture.cache.close();
  });

  it("applies incremental refresh and read mutation without advancing a fake cursor", async () => {
    const updated = threadFixture("thread-a", 3000, false);
    const fixture = await createService({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [threadFixture("thread-a", 1000)],
        nextPageToken: null,
      }),
      listChanges: vi.fn().mockResolvedValue({
        changedThreadIds: ["thread-a", "thread-a"],
        nextPageToken: null,
        resultingHistoryId: "200",
      }),
      getThread: vi.fn().mockResolvedValue(updated),
    });
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    await expect(fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }))
      .resolves.toMatchObject({ changedCount: 1, status: "idle" });
    expect(fixture.cache.readSyncState().historyId).toBe("200");

    await expect(
      fixture.service.updateThread(
        { accountId: ACCOUNT_ID, threadId: "thread-a", read: true },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ thread: { unread: false } });
    expect(fixture.provider.setThreadRead).toHaveBeenCalledWith(
      "thread-a",
      true,
      expect.any(AbortSignal),
    );
    expect(fixture.cache.readSyncState().historyId).toBe("200");
    fixture.cache.close();
  });

  it("dispatches every system action before the exact provider refresh and cache write", async () => {
    const refreshed = mailboxThreadFixture("thread-a", 3000, ["trash"]);
    const order: string[] = [];
    const fixture = await createService({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [threadFixture("thread-a", 1000)],
        nextPageToken: null,
      }),
      getThread: vi.fn(async () => {
        order.push("refresh");
        return refreshed;
      }),
      trashThread: vi.fn(async () => {
        order.push("provider");
      }),
    });
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    const replace = fixture.cache.replaceActiveThread.bind(fixture.cache);
    vi.spyOn(fixture.cache, "replaceActiveThread").mockImplementation((value) => {
      order.push("cache");
      replace(value);
    });

    await expect(
      fixture.service.updateThread(
        { accountId: ACCOUNT_ID, threadId: "thread-a", trash: true },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ thread: { threadId: "thread-a" } });

    expect(order).toEqual(["provider", "refresh", "cache"]);
    expect(fixture.provider.trashThread).toHaveBeenCalledWith(
      "thread-a",
      expect.any(AbortSignal),
    );
    expect(
      (await fixture.service.listThreads({ accountId: ACCOUNT_ID, limit: 10 }))
        .items,
    ).toEqual([]);
    fixture.cache.close();
  });

  // Archive is the one removal the surface can take back: a bulk "Done" over
  // a section moves dozens of threads at once, and an undo that only fixed the
  // list while the mailbox stayed emptied would be a lie.
  it("routes archive by its flag — true archives, false brings the thread back", async () => {
    const fixture = await createService({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [threadFixture("thread-a", 1000)],
        nextPageToken: null,
      }),
      getThread: vi
        .fn()
        .mockResolvedValue(mailboxThreadFixture("thread-a", 3000, ["all"])),
    });
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    const signal = new AbortController().signal;

    await fixture.service.updateThread(
      { accountId: ACCOUNT_ID, threadId: "thread-a", archive: true },
      signal,
    );
    expect(fixture.provider.archiveThread).toHaveBeenCalledWith(
      "thread-a",
      expect.any(AbortSignal),
    );
    expect(fixture.provider.unarchiveThread).not.toHaveBeenCalled();

    await fixture.service.updateThread(
      { accountId: ACCOUNT_ID, threadId: "thread-a", archive: false },
      signal,
    );
    expect(fixture.provider.unarchiveThread).toHaveBeenCalledWith(
      "thread-a",
      expect.any(AbortSignal),
    );
    expect(fixture.provider.archiveThread).toHaveBeenCalledTimes(1);
    fixture.cache.close();
  });

  it.each([
    ["empty", { accountId: ACCOUNT_ID, threadId: "thread-a" }],
    [
      "unknown",
      { accountId: ACCOUNT_ID, threadId: "thread-a", unknown: true },
    ],
    [
      "ambiguous",
      {
        accountId: ACCOUNT_ID,
        threadId: "thread-a",
        trash: true,
        starred: true,
      },
    ],
  ])("rejects a %s direct service mutation before any provider call", async (_name, input) => {
    const fixture = await createService({});

    await expect(
      fixture.service.updateThread(
        input as never,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "mail_cache_invalid" });

    expect(fixture.provider.setThreadRead).not.toHaveBeenCalled();
    expect(fixture.provider.archiveThread).not.toHaveBeenCalled();
    expect(fixture.provider.unarchiveThread).not.toHaveBeenCalled();
    expect(fixture.provider.trashThread).not.toHaveBeenCalled();
    expect(fixture.provider.restoreThread).not.toHaveBeenCalled();
    expect(fixture.provider.setThreadSpam).not.toHaveBeenCalled();
    expect(fixture.provider.setThreadStarred).not.toHaveBeenCalled();
    expect(fixture.provider.getThread).not.toHaveBeenCalled();
    fixture.cache.close();
  });

  it("dispatches restore, spam, and starred values to their exact provider methods", async () => {
    const refreshed = threadFixture("thread-a", 3000, false);
    const fixture = await createService({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [threadFixture("thread-a", 1000)],
        nextPageToken: null,
      }),
      getThread: vi.fn().mockResolvedValue(refreshed),
    });
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    const signal = new AbortController().signal;

    await fixture.service.updateThread(
      { accountId: ACCOUNT_ID, threadId: "thread-a", restore: true },
      signal,
    );
    await fixture.service.updateThread(
      { accountId: ACCOUNT_ID, threadId: "thread-a", spam: true },
      signal,
    );
    await fixture.service.updateThread(
      { accountId: ACCOUNT_ID, threadId: "thread-a", spam: false },
      signal,
    );
    await fixture.service.updateThread(
      { accountId: ACCOUNT_ID, threadId: "thread-a", starred: true },
      signal,
    );
    await fixture.service.updateThread(
      { accountId: ACCOUNT_ID, threadId: "thread-a", starred: false },
      signal,
    );

    expect(fixture.provider.restoreThread).toHaveBeenCalledWith("thread-a", signal);
    expect(fixture.provider.setThreadSpam).toHaveBeenNthCalledWith(
      1,
      "thread-a",
      true,
      signal,
    );
    expect(fixture.provider.setThreadSpam).toHaveBeenNthCalledWith(
      2,
      "thread-a",
      false,
      signal,
    );
    expect(fixture.provider.setThreadStarred).toHaveBeenNthCalledWith(
      1,
      "thread-a",
      true,
      signal,
    );
    expect(fixture.provider.setThreadStarred).toHaveBeenNthCalledWith(
      2,
      "thread-a",
      false,
      signal,
    );
    fixture.cache.close();
  });

  it("fails closed on provider or refresh failure and repairs through an idempotent retry", async () => {
    const refreshed = mailboxThreadFixture("thread-a", 3000, ["trash"]);
    const trashThread = vi
      .fn()
      .mockRejectedValueOnce(
        new MailProviderSyncError("mail_provider_rate_limited"),
      )
      .mockResolvedValue(undefined);
    const getThread = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(refreshed);
    const fixture = await createService({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [threadFixture("thread-a", 1000)],
        nextPageToken: null,
      }),
      trashThread,
      getThread,
    });
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    const replace = vi.spyOn(fixture.cache, "replaceActiveThread");
    const input = {
      accountId: ACCOUNT_ID,
      threadId: "thread-a",
      trash: true,
    } as const;

    await expect(
      fixture.service.updateThread(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "mail_provider_rate_limited" });
    expect(getThread).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    await expect(
      fixture.service.updateThread(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "mail_provider_response_invalid" });
    expect(replace).not.toHaveBeenCalled();

    await expect(
      fixture.service.updateThread(input, new AbortController().signal),
    ).resolves.toMatchObject({ thread: { threadId: "thread-a" } });
    expect(trashThread).toHaveBeenCalledTimes(3);
    expect(replace).toHaveBeenCalledTimes(1);
    fixture.cache.close();
  });

  it("repairs the cache when the provider succeeded but the first cache write failed", async () => {
    const refreshed = mailboxThreadFixture("thread-a", 3000, ["trash"]);
    const fixture = await createService({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [threadFixture("thread-a", 1000)],
        nextPageToken: null,
      }),
      trashThread: vi.fn().mockResolvedValue(undefined),
      getThread: vi.fn().mockResolvedValue(refreshed),
    });
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });

    const replace = fixture.cache.replaceActiveThread.bind(fixture.cache);
    let realWrites = 0;
    vi.spyOn(fixture.cache, "replaceActiveThread")
      .mockImplementationOnce(() => {
        throw new MailCacheError("mail_cache_unavailable");
      })
      .mockImplementation((value) => {
        realWrites += 1;
        replace(value);
      });
    const input = {
      accountId: ACCOUNT_ID,
      threadId: "thread-a",
      trash: true,
    } as const;

    await expect(
      fixture.service.updateThread(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "mail_cache_unavailable" });
    expect(
      (await fixture.service.listThreads({ accountId: ACCOUNT_ID, limit: 10 }))
        .items.map((thread) => thread.threadId),
    ).toEqual(["thread-a"]);

    await expect(
      fixture.service.updateThread(input, new AbortController().signal),
    ).resolves.toMatchObject({ thread: { threadId: "thread-a" } });
    expect(fixture.provider.trashThread).toHaveBeenCalledTimes(2);
    expect(fixture.provider.getThread).toHaveBeenCalledTimes(2);
    expect(realWrites).toBe(1);
    expect(
      (await fixture.service.listThreads({ accountId: ACCOUNT_ID, limit: 10 }))
        .items,
    ).toEqual([]);
    fixture.cache.close();
  });

  it.each([
    ["another account", { accountId: "account-affffffffffffffffffffffffffffffff" }],
    ["another thread", { threadId: "thread-other" }],
  ])("rejects a provider refresh bound to %s before the cache write", async (_name, override) => {
    const fixture = await createService({
      listInitialThreads: vi.fn().mockResolvedValue({
        threads: [threadFixture("thread-a", 1000)],
        nextPageToken: null,
      }),
      getThread: vi.fn().mockResolvedValue({
        ...threadFixture("thread-a", 3000),
        thread: {
          ...threadFixture("thread-a", 3000).thread,
          ...override,
        },
      }),
    });
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    const replace = vi.spyOn(fixture.cache, "replaceActiveThread");

    await expect(
      fixture.service.updateThread(
        { accountId: ACCOUNT_ID, threadId: "thread-a", starred: true },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_response_invalid" });
    expect(replace).not.toHaveBeenCalled();
    fixture.cache.close();
  });

  it("projects a provider invalid grant into reauth_required", async () => {
    const fixture = await createService({
      getSyncAnchor: vi.fn().mockRejectedValue(
        new MailProviderSyncError("mail_provider_reauth_required"),
      ),
    });
    await expect(fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }))
      .resolves.toEqual({
        apiVersion: 1,
        status: "reauth_required",
        changedCount: 0,
        hasMore: false,
      });
    expect(fixture.cache.readSyncState().status).toBe("reauth_required");
    fixture.cache.close();
  });

  it("resumes a staged initial generation after a bounded provider failure", async () => {
    let now = 1_000;
    const getSyncAnchor = vi.fn().mockResolvedValue("100");
    const fixture = await createService({
      getSyncAnchor,
      listInitialThreads: vi
        .fn()
        .mockRejectedValueOnce(
          new MailProviderSyncError("mail_provider_unavailable"),
        )
        .mockResolvedValueOnce({
          threads: [threadFixture("thread-a", 1000)],
          nextPageToken: null,
        }),
    }, { now: () => now });
    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).rejects.toMatchObject({ code: "mail_provider_unavailable" });
    expect(fixture.cache.readSyncState()).toMatchObject({
      stagedGeneration: 1,
      status: "backoff",
    });
    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "backoff", hasMore: false });
    expect(fixture.provider.listInitialThreads).toHaveBeenCalledTimes(1);
    now = 31_000;
    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle", hasMore: false });
    expect(getSyncAnchor).toHaveBeenCalledTimes(1);
    fixture.cache.close();
  });

  it("honors provider Retry-After and does not count shutdown aborts", async () => {
    let now = 5_000;
    const controller = new AbortController();
    const listInitialThreads = vi
      .fn<MailProviderSyncPort["listInitialThreads"]>()
      .mockRejectedValueOnce(
        new MailProviderSyncError("mail_provider_rate_limited", 120_000),
      )
      .mockImplementationOnce(async () => {
        controller.abort(new Error("shutdown"));
        throw controller.signal.reason;
      });
    const fixture = await createService(
      { listInitialThreads },
      { now: () => now },
    );

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).rejects.toMatchObject({ code: "mail_provider_rate_limited" });
    expect(fixture.cache.readBackgroundSyncState()).toMatchObject({
      failureCount: 1,
      retryAt: 125_000,
    });
    now = 124_999;
    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "backoff" });
    expect(listInitialThreads).toHaveBeenCalledTimes(1);

    now = 125_000;
    await expect(
      fixture.service.syncAccount(
        ACCOUNT_ID,
        { maxItems: 20 },
        controller.signal,
      ),
    ).rejects.toThrow("shutdown");
    expect(fixture.cache.readBackgroundSyncState()).toMatchObject({
      failureCount: 1,
      retryAt: 125_000,
    });
    fixture.cache.close();
  });

  it("keeps public sync Inbox-only", async () => {
    const fixture = await createService({});

    await expect(
      fixture.service.sync(
        { accountId: ACCOUNT_ID, maxItems: 20 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "idle", hasMore: false });

    expect(fixture.provider.listMailboxThreads).not.toHaveBeenCalled();
    expect(
      fixture.cache.readMailboxHydrationStates().map((state) => state.status),
    ).toEqual([
      "uninitialized",
      "uninitialized",
      "uninitialized",
      "uninitialized",
      "uninitialized",
    ]);
    fixture.cache.close();
  });

  it("runs one hidden bounded page after a completed Inbox sync without changing its result", async () => {
    const hiddenThread = mailboxThreadFixture("thread-sent", 2000, ["all", "sent"]);
    const fixture = await createService({
      listMailboxThreads: vi.fn().mockResolvedValue({
        threads: [hiddenThread],
        listedCount: 1,
        nextPageToken: null,
      }),
    });

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 7 }),
    ).resolves.toEqual({
      apiVersion: 1,
      status: "idle",
      changedCount: 0,
      hasMore: false,
    });
    expect(fixture.provider.listMailboxThreads).toHaveBeenCalledTimes(1);
    expect(fixture.provider.listMailboxThreads).toHaveBeenCalledWith(
      { mailboxId: "sent", pageToken: null, maxItems: 20 },
      expect.any(AbortSignal),
    );
    expect(fixture.cache.readMailboxHydrationStates()[0]).toMatchObject({
      mailboxId: "sent",
      crawlComplete: true,
      listedThreadCount: 1,
    });
    expect(
      await fixture.service.listThreads({ accountId: ACCOUNT_ID, limit: 10 }),
    ).toMatchObject({ items: [] });
    fixture.cache.close();
  });

  it("reports hidden continuation separately and uses the background page budget", async () => {
    const fixture = await createService({
      listMailboxThreads: vi.fn().mockResolvedValue({
        threads: [],
        listedCount: 0,
        nextPageToken: "next-sent-page",
      }),
    });

    await expect(
      fixture.service.runBackgroundSyncStep(
        ACCOUNT_ID,
        { maxItems: 5 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      result: {
        apiVersion: 1,
        status: "idle",
        changedCount: 0,
        hasMore: false,
      },
      hasMore: true,
    });
    expect(fixture.provider.listMailboxThreads).toHaveBeenCalledWith(
      { mailboxId: "sent", pageToken: null, maxItems: 5 },
      expect.any(AbortSignal),
    );
    fixture.cache.close();
  });

  it("skips hidden mailbox hydration for providers without that capability", async () => {
    const fixture = await createService(
      {},
      { hydrateHiddenMailboxes: false },
    );

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 5 }),
    ).resolves.toMatchObject({ status: "idle", hasMore: false });
    await expect(
      fixture.service.runBackgroundSyncStep(
        ACCOUNT_ID,
        { maxItems: 5 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      result: {
        apiVersion: 1,
        status: "idle",
        changedCount: 0,
        hasMore: false,
      },
      hasMore: false,
    });
    expect(fixture.provider.listMailboxThreads).not.toHaveBeenCalled();
    fixture.cache.close();
  });

  it("hydrates hidden mailboxes in order and publishes each completed snapshot before moving on", async () => {
    const fixture = await createService({});

    for (let pass = 0; pass < 9; pass += 1) {
      await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    }

    expect(
      vi.mocked(fixture.provider.listMailboxThreads).mock.calls.map(
        ([input]) => input.mailboxId,
      ),
    ).toEqual(["sent", "starred", "spam", "trash", "all"]);
    expect(fixture.cache.readMailboxHydrationStates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mailboxId: "sent", status: "idle" }),
        expect.objectContaining({ mailboxId: "starred", status: "idle" }),
        expect.objectContaining({ mailboxId: "spam", status: "idle" }),
        expect.objectContaining({ mailboxId: "trash", status: "idle" }),
        expect.objectContaining({ mailboxId: "all", crawlComplete: true }),
      ]),
    );
    fixture.cache.close();
  });

  it("drains one pending refresh page before publishing a crawled mailbox", async () => {
    const refreshed = mailboxThreadFixture("thread-refresh", 3000, ["all", "sent"]);
    const fixture = await createService({
      getThread: vi.fn().mockResolvedValue(refreshed),
    });
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    vi.spyOn(fixture.cache, "readPendingThreadRefreshes").mockReturnValue([
      Object.freeze({ threadId: "thread-refresh", queuedAt: 42 }),
    ]);
    const apply = vi
      .spyOn(fixture.cache, "applyPendingThreadRefreshes")
      .mockReturnValue(0);
    const complete = vi
      .spyOn(fixture.cache, "completeMailboxHydration")
      .mockImplementation(() => undefined);

    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });

    expect(fixture.provider.getThread).toHaveBeenCalledWith(
      "thread-refresh",
      expect.any(AbortSignal),
    );
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        mailboxId: "sent",
        changes: [
          expect.objectContaining({
            kind: "upsert",
            queuedAt: 42,
            value: refreshed,
          }),
        ],
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ mailboxId: "sent" }),
    );
    fixture.cache.close();
  });

  it("drains more than one pending refresh page before publishing a crawled mailbox", async () => {
    const threadIds = Array.from(
      { length: 25 },
      (_, index) => `thread-refresh-${index}`,
    );
    const fixture = await createService({
      listChanges: vi
        .fn<MailProviderSyncPort["listChanges"]>()
        .mockResolvedValueOnce({
          changedThreadIds: threadIds,
          nextPageToken: null,
          resultingHistoryId: "150",
        })
        .mockResolvedValue({
          changedThreadIds: [],
          nextPageToken: null,
          resultingHistoryId: "150",
        }),
      getThread: vi.fn().mockImplementation(async (threadId: string) =>
        mailboxThreadFixture(threadId, 3000, ["all", "sent"]),
      ),
    });

    // First pass completes Inbox and crawls the empty Sent snapshot. The next
    // pass observes 25 races, drains only the bounded first 20, and must keep
    // the snapshot staged while five refreshes remain.
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });

    expect(fixture.cache.readPendingThreadRefreshes(20)).toHaveLength(5);
    expect(fixture.cache.readMailboxHydrationStates()[0]).toMatchObject({
      mailboxId: "sent",
      activeGeneration: 0,
      stagedGeneration: 1,
      status: "syncing",
      crawlComplete: true,
      postCrawlHistoryId: "150",
    });

    // A later background pass drains the final five and only then publishes.
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });

    expect(fixture.cache.readPendingThreadRefreshes(20)).toEqual([]);
    expect(fixture.cache.readMailboxHydrationStates()[0]).toMatchObject({
      mailboxId: "sent",
      activeGeneration: 1,
      stagedGeneration: null,
      activeObservedHistoryId: "150",
      status: "idle",
    });
    expect(fixture.provider.getThread).toHaveBeenCalledTimes(50);
    fixture.cache.close();
  });

  it("restarts a stale post-crawl barrier without publishing it", async () => {
    const fixture = await createService({});
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    vi.spyOn(fixture.cache, "markPostCrawlHistoryObserved").mockReturnValue(false);
    const restart = vi.spyOn(fixture.cache, "restartStaleMailboxHydration");
    const complete = vi.spyOn(fixture.cache, "completeMailboxHydration");

    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });

    expect(restart).toHaveBeenCalledWith("sent");
    expect(complete).not.toHaveBeenCalled();
    expect(fixture.provider.getThread).not.toHaveBeenCalled();
    fixture.cache.close();
  });

  it("records a hidden provider failure per mailbox and returns the Inbox result", async () => {
    const fixture = await createService({
      listMailboxThreads: vi
        .fn()
        .mockRejectedValue(
          new MailProviderSyncError("mail_provider_unavailable"),
        ),
    });

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toEqual({
      apiVersion: 1,
      status: "idle",
      changedCount: 0,
      hasMore: false,
    });
    expect(fixture.cache.readMailboxHydrationStates()[0]).toMatchObject({
      mailboxId: "sent",
      status: "backoff",
    });
    fixture.cache.close();
  });

  it("promotes hidden Gmail rate limits into the shared durable backoff", async () => {
    let now = 1_000;
    const listMailboxThreads = vi
      .fn<MailProviderSyncPort["listMailboxThreads"]>()
      .mockRejectedValue(
        new MailProviderSyncError("mail_provider_rate_limited", 120_000),
      );
    const fixture = await createService(
      { listMailboxThreads },
      { now: () => now },
    );

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle", hasMore: false });
    expect(fixture.cache.readBackgroundSyncState()).toMatchObject({
      syncStatus: "backoff",
      failureCount: 1,
      retryAt: 121_000,
      lastErrorCode: "mail_provider_rate_limited",
    });
    now = 120_999;
    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "backoff", hasMore: false });
    expect(listMailboxThreads).toHaveBeenCalledTimes(1);
    fixture.cache.close();
  });

  it("does not let a repeatedly failing Sent crawl starve later mailboxes", async () => {
    const listMailboxThreads = vi
      .fn<MailProviderSyncPort["listMailboxThreads"]>()
      .mockImplementation(async ({ mailboxId }) => {
        if (mailboxId === "sent") {
          throw new MailProviderSyncError("mail_provider_unavailable");
        }
        return { threads: [], listedCount: 0, nextPageToken: null };
      });
    const fixture = await createService({ listMailboxThreads });

    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    expect(fixture.cache.readMailboxHydrationStates()[0]).toMatchObject({
      mailboxId: "sent",
      status: "backoff",
      stagedGeneration: null,
    });

    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });

    expect(
      listMailboxThreads.mock.calls.map(([input]) => input.mailboxId),
    ).toEqual(["sent", "starred"]);
    expect(fixture.cache.readMailboxHydrationStates()[1]).toMatchObject({
      mailboxId: "starred",
      status: "syncing",
      crawlComplete: true,
    });
    fixture.cache.close();
  });

  it("continues healthy hidden mailboxes without hot-looping a failed one", async () => {
    const listMailboxThreads = vi
      .fn<MailProviderSyncPort["listMailboxThreads"]>()
      .mockImplementation(async ({ mailboxId }) => {
        if (mailboxId === "sent") {
          throw new MailProviderSyncError("mail_provider_unavailable");
        }
        return { threads: [], listedCount: 0, nextPageToken: null };
      });
    const fixture = await createService({ listMailboxThreads });
    const signal = new AbortController().signal;
    const continuations: boolean[] = [];

    for (let step = 0; step < 9; step += 1) {
      const result = await fixture.service.runBackgroundSyncStep(
        ACCOUNT_ID,
        { maxItems: 5 },
        signal,
      );
      continuations.push(result.hasMore);
    }

    expect(continuations).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(
      listMailboxThreads.mock.calls.map(([input]) => input.mailboxId),
    ).toEqual(["sent", "starred", "spam", "trash", "all"]);
    fixture.cache.close();
  });

  it("retries an abandoned transient mailbox only after healthy mailboxes finish", async () => {
    let sentAttempts = 0;
    const listMailboxThreads = vi
      .fn<MailProviderSyncPort["listMailboxThreads"]>()
      .mockImplementation(async ({ mailboxId }) => {
        if (mailboxId === "sent" && sentAttempts++ === 0) {
          throw new MailProviderSyncError("mail_provider_unavailable");
        }
        return { threads: [], listedCount: 0, nextPageToken: null };
      });
    const fixture = await createService({ listMailboxThreads });

    for (let pass = 0; pass < 11; pass += 1) {
      await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    }

    expect(
      listMailboxThreads.mock.calls.map(([input]) => input.mailboxId),
    ).toEqual(["sent", "starred", "spam", "trash", "all", "sent"]);
    expect(fixture.cache.readMailboxHydrationStates()[0]).toMatchObject({
      mailboxId: "sent",
      activeGeneration: 1,
      stagedGeneration: null,
      status: "idle",
    });
    fixture.cache.close();
  });

  it("round-robins failed mailbox retries so a permanent failure cannot starve recovery", async () => {
    let starredAttempts = 0;
    const listMailboxThreads = vi
      .fn<MailProviderSyncPort["listMailboxThreads"]>()
      .mockImplementation(async ({ mailboxId }) => {
        if (mailboxId === "sent") {
          throw new MailProviderSyncError("mail_provider_unavailable");
        }
        if (mailboxId === "starred" && starredAttempts++ === 0) {
          throw new MailProviderSyncError("mail_provider_unavailable");
        }
        return { threads: [], listedCount: 0, nextPageToken: null };
      });
    const fixture = await createService({ listMailboxThreads });

    for (let pass = 0; pass < 20; pass += 1) {
      await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    }

    const attempts = listMailboxThreads.mock.calls.map(
      ([input]) => input.mailboxId,
    );
    expect(attempts.filter((mailboxId) => mailboxId === "sent").length).toBeGreaterThan(1);
    expect(attempts.filter((mailboxId) => mailboxId === "starred")).toHaveLength(2);
    expect(fixture.cache.readMailboxHydrationStates()[1]).toMatchObject({
      mailboxId: "starred",
      activeGeneration: 1,
      stagedGeneration: null,
      status: "idle",
    });
    fixture.cache.close();
  });

  it("still returns the Inbox result when hidden failure recording also fails", async () => {
    const fixture = await createService({
      listMailboxThreads: vi
        .fn()
        .mockRejectedValue(
          new MailProviderSyncError("mail_provider_unavailable"),
        ),
    });
    vi.spyOn(fixture.cache, "markMailboxHydrationFailure").mockImplementation(
      () => {
        throw new Error("cache unavailable");
      },
    );

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle", hasMore: false });
    fixture.cache.close();
  });

  it("does not swallow shutdown aborts from hidden hydration", async () => {
    const controller = new AbortController();
    const fixture = await createService({
      listMailboxThreads: vi.fn().mockImplementation(async () => {
        controller.abort(new Error("shutdown"));
        throw controller.signal.reason;
      }),
    });
    const markFailure = vi.spyOn(fixture.cache, "markMailboxHydrationFailure");

    await expect(
      fixture.service.syncAccount(
        ACCOUNT_ID,
        { maxItems: 20 },
        controller.signal,
      ),
    ).rejects.toThrow("shutdown");
    expect(markFailure).not.toHaveBeenCalled();
    fixture.cache.close();
  });
});

describe("account mail message service change records", () => {
  it("records a sync when an initial generation is published, not for a staged page", async () => {
    const changes: MailServiceChange[] = [];
    const fixture = await createService(
      {
        listInitialThreads: vi
          .fn<MailProviderSyncPort["listInitialThreads"]>()
          .mockResolvedValueOnce({
            threads: [threadFixture("thread-a", 1000)],
            nextPageToken: "page-two",
          })
          .mockResolvedValueOnce({ threads: [], nextPageToken: null }),
      },
      { hydrateHiddenMailboxes: false, onChange: (change) => changes.push(change) },
    );

    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    expect(changes).toEqual([]);
    // The last page brings nothing of its own, and the generation it
    // completes is still news.
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    expect(changes).toEqual([
      { accountId: ACCOUNT_ID, mailboxIds: MAIL_CHANGE_ALL_MAILBOXES, kind: "sync" },
    ]);
    fixture.cache.close();
  });

  it("records an incremental page that changed threads and stays quiet for one that did not", async () => {
    const changes: MailServiceChange[] = [];
    const listChanges = vi
      .fn<MailProviderSyncPort["listChanges"]>()
      .mockResolvedValueOnce({
        changedThreadIds: ["thread-a"],
        nextPageToken: null,
        resultingHistoryId: "200",
      })
      .mockResolvedValueOnce({
        changedThreadIds: [],
        nextPageToken: null,
        resultingHistoryId: "200",
      });
    const fixture = await createService(
      {
        listInitialThreads: vi.fn().mockResolvedValue({
          threads: [threadFixture("thread-a", 1000)],
          nextPageToken: null,
        }),
        listChanges,
        getThread: vi.fn().mockResolvedValue(threadFixture("thread-a", 3000, false)),
      },
      { hydrateHiddenMailboxes: false, onChange: (change) => changes.push(change) },
    );
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    changes.length = 0;

    await fixture.service.runBackgroundSyncStep(ACCOUNT_ID, { maxItems: 20 });
    expect(changes).toEqual([
      { accountId: ACCOUNT_ID, mailboxIds: MAIL_CHANGE_ALL_MAILBOXES, kind: "sync" },
    ]);
    await fixture.service.runBackgroundSyncStep(ACCOUNT_ID, { maxItems: 20 });
    expect(changes).toHaveLength(1);
    fixture.cache.close();
  });

  it("records a mutation once the provider and the cache both have it", async () => {
    const changes: MailServiceChange[] = [];
    const fixture = await createService(
      {
        listInitialThreads: vi.fn().mockResolvedValue({
          threads: [threadFixture("thread-a", 1000)],
          nextPageToken: null,
        }),
        getThread: vi.fn().mockResolvedValue(threadFixture("thread-a", 1000, false)),
        setThreadStarred: vi
          .fn<MailProviderSyncPort["setThreadStarred"]>()
          .mockRejectedValueOnce(new MailProviderSyncError("mail_provider_unavailable"))
          .mockResolvedValue(undefined),
      },
      { hydrateHiddenMailboxes: false, onChange: (change) => changes.push(change) },
    );
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    changes.length = 0;

    await expect(
      fixture.service.updateThread(
        { accountId: ACCOUNT_ID, threadId: "thread-a", starred: true },
        new AbortController().signal,
      ),
    ).rejects.toThrow("mail_provider_unavailable");
    expect(changes).toEqual([]);
    await fixture.service.updateThread(
      { accountId: ACCOUNT_ID, threadId: "thread-a", read: true },
      new AbortController().signal,
    );
    expect(changes).toEqual([
      { accountId: ACCOUNT_ID, mailboxIds: MAIL_CHANGE_ALL_MAILBOXES, kind: "mutation" },
    ]);
    fixture.cache.close();
  });

  it("records each hidden mailbox as its snapshot is published", async () => {
    const changes: MailServiceChange[] = [];
    const fixture = await createService({}, { onChange: (change) => changes.push(change) });

    for (let pass = 0; pass < 9; pass += 1) {
      await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    }

    expect(
      changes.filter((change) => change.mailboxIds.length === 1).map((change) => change.mailboxIds),
    ).toEqual([["sent"], ["starred"], ["spam"], ["trash"]]);
    fixture.cache.close();
  });

  it("keeps the sync's answer when the observer throws", async () => {
    const fixture = await createService(
      {
        listInitialThreads: vi.fn().mockResolvedValue({
          threads: [threadFixture("thread-a", 1000)],
          nextPageToken: null,
        }),
      },
      {
        hydrateHiddenMailboxes: false,
        onChange: () => {
          throw new Error("observer");
        },
      },
    );

    await expect(
      fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 }),
    ).resolves.toMatchObject({ status: "idle", changedCount: 1 });
    fixture.cache.close();
  });
});

describe("account mail message service batch archive", () => {
  const signal = () => new AbortController().signal;

  async function seeded(
    overrides: Partial<MailProviderSyncPort>,
    ids: readonly string[],
    changes?: MailServiceChange[],
  ) {
    const fixture = await createService(
      {
        listInitialThreads: vi.fn().mockResolvedValue({
          threads: ids.map((threadId) => threadFixture(threadId, 1000)),
          nextPageToken: null,
        }),
        ...overrides,
      },
      {
        hydrateHiddenMailboxes: false,
        ...(changes ? { onChange: (change: MailServiceChange) => changes.push(change) } : {}),
      },
    );
    await fixture.service.syncAccount(ACCOUNT_ID, { maxItems: 20 });
    if (changes) changes.length = 0;
    return fixture;
  }

  /** What a press saw of the seeded threads: one unread message at 1000. */
  function pressed(
    ids: readonly string[],
    overrides: Partial<Omit<MailThreadBatchPress, "threadId">> = {},
  ): MailThreadBatchPress[] {
    return ids.map((threadId) => ({
      threadId,
      messageCount: 1,
      lastMessageAt: 1000,
      unread: true,
      ...overrides,
    }));
  }

  /** The thread as a provider reads it after an archive, and after a flag. */
  function archivedFixture(threadId: string, unread: boolean, sentAt = 1000): CachedProviderThread {
    const base = mailboxThreadFixture(threadId, sentAt, ["all"]);
    return Object.freeze({
      ...base,
      thread: Object.freeze({ ...base.thread, unread }),
      messages: Object.freeze(
        base.messages.map((message) => Object.freeze({ ...message, unread, inInbox: false })),
      ),
    });
  }

  it("archives and then marks read thread by thread where the provider has no batch, under one gate and one change record", async () => {
    const ids = ["thread-a", "thread-b", "thread-c"];
    const flagged = new Set<string>();
    const order: string[] = [];
    const changes: MailServiceChange[] = [];
    const fixture = await seeded(
      {
        archiveThread: vi.fn(async (threadId: string) => {
          order.push(`archive ${threadId}`);
        }),
        setThreadRead: vi.fn(async (threadId: string) => {
          order.push(`read ${threadId}`);
          flagged.add(threadId);
        }),
        getThread: vi.fn(async (threadId: string) => {
          order.push(`get ${threadId}`);
          return archivedFixture(threadId, !flagged.has(threadId));
        }),
        setThreadStarred: vi.fn(async () => {
          order.push("star");
        }),
      },
      ids,
      changes,
    );

    const batch = fixture.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(ids), archive: true, read: true },
      signal(),
    );
    // A mutation asked for meanwhile waits for the whole batch, not for one
    // thread of it: the gate is taken once.
    const star = fixture.service.updateThread(
      { accountId: ACCOUNT_ID, threadId: "thread-b", starred: true },
      signal(),
    );
    const result = await batch;
    await star;

    expect(order).toEqual([
      ...ids.flatMap((id) => [`archive ${id}`, `get ${id}`, `read ${id}`, `get ${id}`]),
      "star",
      "get thread-b",
    ]);
    expect(result.results).toEqual(
      ids.map((threadId) => ({
        threadId,
        status: "done",
        thread: expect.objectContaining({ threadId, unread: false }),
        markedRead: true,
      })),
    );
    // One record for the batch, one for the star.
    expect(changes).toEqual([
      { accountId: ACCOUNT_ID, mailboxIds: MAIL_CHANGE_ALL_MAILBOXES, kind: "mutation" },
      { accountId: ACCOUNT_ID, mailboxIds: MAIL_CHANGE_ALL_MAILBOXES, kind: "mutation" },
    ]);
    expect((await fixture.service.listThreads({ accountId: ACCOUNT_ID, limit: 10 })).items).toEqual(
      [],
    );
    fixture.cache.close();
  });

  it("puts a thread that got mail while it was archived back in the Inbox, unflagged, in the same request", async () => {
    let unarchived = false;
    const fixture = await seeded(
      {
        getThread: vi.fn(async (threadId: string) =>
          threadId === "thread-a" && unarchived
            ? threadFixture(threadId, 2000)
            : archivedFixture(threadId, true, threadId === "thread-a" ? 2000 : 1000),
        ),
        unarchiveThread: vi.fn(async () => {
          unarchived = true;
        }),
      },
      ["thread-a", "thread-b", "thread-c"],
    );

    const renewed = await fixture.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(["thread-a"]), archive: true, read: true },
      signal(),
    );
    const withoutRead = await fixture.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(["thread-b"]), archive: true },
      signal(),
    );
    // Read when it was pressed: the flag is not for it, whatever it is now.
    const readAtPress = await fixture.service.archiveThreads(
      {
        accountId: ACCOUNT_ID,
        threads: pressed(["thread-c"], { unread: false }),
        archive: true,
        read: true,
      },
      signal(),
    );

    expect(renewed.results[0]).toMatchObject({
      status: "renewed",
      thread: { lastMessageAt: 2000, unread: true },
    });
    expect(fixture.provider.unarchiveThread).toHaveBeenCalledWith("thread-a", expect.anything());
    expect(withoutRead.results[0]).toMatchObject({ status: "done", markedRead: false });
    expect(readAtPress.results[0]).toMatchObject({ status: "done", markedRead: false });
    expect(fixture.provider.setThreadRead).not.toHaveBeenCalled();
    fixture.cache.close();
  });

  it("leaves alone a thread whose cached copy holds a reply the press did not see, and asks the provider nothing", async () => {
    // The background sync cached the reply after the press. The provider's
    // batch names the messages the cache holds, so sending this thread would
    // archive the reply and mark it read: it is not sent.
    const archiveThreads = vi.fn<NonNullable<MailProviderSyncPort["archiveThreads"]>>(
      async () => new Map(),
    );
    const fixture = await seeded({ archiveThreads }, ["thread-a", "thread-b"]);
    fixture.cache.replaceActiveThread(threadFixture("thread-a", 2000));

    const result = await fixture.service.archiveThreads(
      {
        accountId: ACCOUNT_ID,
        threads: pressed(["thread-a", "thread-b"]),
        archive: true,
        read: true,
      },
      signal(),
    );

    expect(result.results[0]).toMatchObject({
      threadId: "thread-a",
      status: "renewed",
      thread: { lastMessageAt: 2000 },
    });
    expect(archiveThreads.mock.calls[0]![0].threads.map((thread) => thread.threadId)).toEqual([
      "thread-b",
    ]);
    expect(fixture.provider.archiveThread).not.toHaveBeenCalledWith("thread-a", expect.anything());
    fixture.cache.close();
  });

  it("does not count a letter deleted elsewhere as new mail", async () => {
    const fixture = await seeded(
      { getThread: vi.fn(async (threadId: string) => archivedFixture(threadId, true)) },
      ["thread-a"],
    );
    const result = await fixture.service.archiveThreads(
      {
        accountId: ACCOUNT_ID,
        threads: pressed(["thread-a"], { messageCount: 2 }),
        archive: true,
        read: true,
      },
      signal(),
    );
    expect(result.results[0]).toMatchObject({ status: "done", markedRead: true });
    fixture.cache.close();
  });

  it("answers each thread for itself: stale, failed, and done side by side", async () => {
    const fixture = await seeded(
      {
        archiveThread: vi.fn(async (threadId: string) => {
          if (threadId === "thread-b") {
            throw new MailProviderSyncError("mail_provider_thread_stale");
          }
          if (threadId === "thread-c") {
            throw new MailProviderSyncError("mail_provider_rate_limited", 1000);
          }
        }),
        getThread: vi.fn(async (threadId: string) => archivedFixture(threadId, true)),
      },
      ["thread-a", "thread-b", "thread-c"],
    );

    const result = await fixture.service.archiveThreads(
      {
        accountId: ACCOUNT_ID,
        threads: pressed(["thread-a", "thread-b", "thread-c"]),
        archive: true,
      },
      signal(),
    );

    expect(result.results.map((item) => [item.threadId, item.status])).toEqual([
      ["thread-a", "done"],
      ["thread-b", "stale"],
      ["thread-c", "failed"],
    ]);
    expect(result.results[2]).toEqual({
      threadId: "thread-c",
      status: "failed",
      errorCode: "mail_sync_rate_limited",
    });
    fixture.cache.close();
  });

  it("refuses the whole batch when the account cannot archive, and only before anything moved", async () => {
    const refusal = new MailProviderSyncError(
      "mail_provider_mutation_unsupported",
      null,
      "no_mailbox_for_role",
    );
    const first = await seeded(
      { archiveThread: vi.fn().mockRejectedValue(refusal) },
      ["thread-a", "thread-b"],
    );
    await expect(
      first.service.archiveThreads(
        { accountId: ACCOUNT_ID, threads: pressed(["thread-a", "thread-b"]), archive: true },
        signal(),
      ),
    ).rejects.toBe(refusal);
    expect(first.provider.archiveThread).toHaveBeenCalledTimes(1);
    first.cache.close();

    const later = await seeded(
      {
        archiveThread: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(refusal),
        getThread: vi.fn(async (threadId: string) => archivedFixture(threadId, true)),
      },
      ["thread-a", "thread-b"],
    );
    const result = await later.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(["thread-a", "thread-b"]), archive: true },
      signal(),
    );
    expect(result.results).toEqual([
      expect.objectContaining({ threadId: "thread-a", status: "done" }),
      {
        threadId: "thread-b",
        status: "failed",
        errorCode: "mail_thread_mutation_unsupported",
      },
    ]);
    later.cache.close();
  });

  it("reports the threads the deadline left unreached as failed, and keeps what landed", async () => {
    const controller = new AbortController();
    const changes: MailServiceChange[] = [];
    const fixture = await seeded(
      {
        archiveThread: vi.fn(async (threadId: string) => {
          // The deadline passes while the first thread is out.
          if (threadId === "thread-a") controller.abort();
        }),
        getThread: vi.fn(async (threadId: string) => archivedFixture(threadId, true)),
      },
      ["thread-a", "thread-b", "thread-c"],
      changes,
    );

    const result = await fixture.service.archiveThreads(
      {
        accountId: ACCOUNT_ID,
        threads: pressed(["thread-a", "thread-b", "thread-c"]),
        archive: true,
      },
      controller.signal,
    );

    expect(result.results).toEqual([
      expect.objectContaining({ threadId: "thread-a", status: "done" }),
      { threadId: "thread-b", status: "failed", errorCode: "request_deadline_exceeded" },
      { threadId: "thread-c", status: "failed", errorCode: "request_deadline_exceeded" },
    ]);
    expect(fixture.provider.archiveThread).toHaveBeenCalledTimes(1);
    expect(changes).toHaveLength(1);
    fixture.cache.close();
  });

  it("answers every thread failed when the gate does not open before the deadline", async () => {
    const fixture = await seeded({}, ["thread-a"]);
    const controller = new AbortController();
    controller.abort();

    const result = await fixture.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(["thread-a"]), archive: true },
      controller.signal,
    );

    expect(result.results).toEqual([
      { threadId: "thread-a", status: "failed", errorCode: "request_deadline_exceeded" },
    ]);
    expect(fixture.provider.archiveThread).not.toHaveBeenCalled();
    fixture.cache.close();
  });

  it("hands the provider's batch the cached messages and its cursor, applies what it confirms, and takes the rest thread by thread", async () => {
    const changes: MailServiceChange[] = [];
    const archiveThreads = vi.fn<NonNullable<MailProviderSyncPort["archiveThreads"]>>(
      async () =>
        new Map<string, MailProviderBatchOutcome>([
          ["thread-a", { status: "applied", messageIds: ["message-thread-a"], markedRead: true }],
          [
            "thread-b",
            { status: "done", thread: threadFixture("thread-b", 2000), markedRead: false },
          ],
        ]),
    );
    const fixture = await seeded(
      {
        archiveThreads,
        getThread: vi.fn(async (threadId: string) => archivedFixture(threadId, false)),
      },
      ["thread-a", "thread-b", "thread-c"],
      changes,
    );

    const result = await fixture.service.archiveThreads(
      {
        accountId: ACCOUNT_ID,
        threads: [
          ...pressed(["thread-a", "thread-b"]),
          ...pressed(["thread-c"], { unread: false }),
          ...pressed(["thread-x"]),
        ],
        archive: true,
        read: true,
      },
      signal(),
    );

    // The read flag is asked for the threads unread at the press only.
    expect(archiveThreads).toHaveBeenCalledWith(
      {
        threads: [
          {
            threadId: "thread-a",
            messages: [{ messageId: "message-thread-a", unread: true }],
            read: true,
          },
          {
            threadId: "thread-b",
            messages: [{ messageId: "message-thread-b", unread: true }],
            read: true,
          },
          {
            threadId: "thread-c",
            messages: [{ messageId: "message-thread-c", unread: true }],
            read: false,
          },
          { threadId: "thread-x", messages: null, read: true },
        ],
        cursor: "100",
      },
      expect.any(AbortSignal),
    );
    // What the batch left goes the per-thread way, in the same request.
    expect(vi.mocked(fixture.provider.archiveThread).mock.calls.map((call) => call[0])).toEqual([
      "thread-c",
      "thread-x",
    ]);
    expect(result.results).toEqual([
      {
        threadId: "thread-a",
        status: "done",
        thread: expect.objectContaining({ threadId: "thread-a", unread: false }),
        markedRead: true,
      },
      // Gmail left the reply in the Inbox: the thread is answered as it
      // stands, with nothing more sent for it.
      {
        threadId: "thread-b",
        status: "renewed",
        thread: expect.objectContaining({ threadId: "thread-b", lastMessageAt: 2000 }),
      },
      expect.objectContaining({ threadId: "thread-c", status: "done" }),
      expect.objectContaining({ threadId: "thread-x", status: "done" }),
    ]);
    // The confirmed archive is in the cache without a read of the thread; the
    // renewed one is in the Inbox with its reply.
    expect(
      (await fixture.service.listThreads({ accountId: ACCOUNT_ID, limit: 10 })).items.map(
        (item) => item.threadId,
      ),
    ).toEqual(["thread-b"]);
    expect(fixture.provider.getThread).not.toHaveBeenCalledWith("thread-a", expect.anything());
    expect(changes).toHaveLength(1);
    fixture.cache.close();
  });

  /** A reply lands between the read flag and the read back after it. */
  function replyAfterTheFlag(order: string[]) {
    let reads = 0;
    return {
      archiveThread: vi.fn(async () => {
        order.push("archive");
      }),
      setThreadRead: vi.fn(async (_threadId: string, read: boolean) => {
        order.push(`read ${read}`);
      }),
      getThread: vi.fn(async (threadId: string) => {
        reads += 1;
        order.push("get");
        if (reads === 1) return archivedFixture(threadId, true);
        if (reads === 2) return archivedFixture(threadId, false, 2000);
        return threadFixture(threadId, 2000);
      }),
    };
  }

  it("takes the read flag off before it puts back a thread a reply reached after the flag", async () => {
    const order: string[] = [];
    const fixture = await seeded(
      {
        ...replyAfterTheFlag(order),
        unarchiveThread: vi.fn(async () => {
          order.push("unarchive");
        }),
      },
      ["thread-a"],
    );

    const result = await fixture.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(["thread-a"]), archive: true, read: true },
      signal(),
    );

    // The reply first: it is the one a reader would miss.
    expect(order).toEqual([
      "archive",
      "get",
      "read true",
      "get",
      "read false",
      "unarchive",
      "get",
    ]);
    expect(result.results[0]).toMatchObject({
      status: "renewed",
      thread: { lastMessageAt: 2000, unread: true },
    });
    fixture.cache.close();
  });

  it("answers done, read flag and new mail in it, when putting the thread back fails", async () => {
    const order: string[] = [];
    const fixture = await seeded(
      {
        ...replyAfterTheFlag(order),
        unarchiveThread: vi
          .fn()
          .mockRejectedValue(new MailProviderSyncError("mail_provider_unavailable")),
      },
      ["thread-a"],
    );

    const result = await fixture.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(["thread-a"]), archive: true, read: true },
      signal(),
    );

    // Brain's take-back is the last word: it needs to see both.
    expect(result.results[0]).toMatchObject({
      status: "done",
      markedRead: true,
      thread: { lastMessageAt: 2000 },
    });
    fixture.cache.close();
  });

  it("does not claim a read flag that failed, and keeps the archive that landed", async () => {
    const fixture = await seeded(
      {
        getThread: vi.fn(async (threadId: string) => archivedFixture(threadId, true)),
        setThreadRead: vi.fn().mockRejectedValue(new MailProviderSyncError("mail_provider_unavailable")),
      },
      ["thread-a"],
    );
    const result = await fixture.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(["thread-a"]), archive: true, read: true },
      signal(),
    );
    expect(result.results[0]).toMatchObject({ status: "done", markedRead: false });
    fixture.cache.close();
  });

  it("answers every thread failed when the provider's batch never got going, and spends no per-thread call", async () => {
    const fixture = await seeded(
      {
        archiveThreads: vi.fn().mockRejectedValue(new MailProviderSyncError("mail_provider_unavailable")),
      },
      ["thread-a", "thread-b"],
    );
    const result = await fixture.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(["thread-a", "thread-b"]), archive: true },
      signal(),
    );
    expect(result.results).toEqual([
      { threadId: "thread-a", status: "failed", errorCode: "mail_sync_unavailable" },
      { threadId: "thread-b", status: "failed", errorCode: "mail_sync_unavailable" },
    ]);
    expect(fixture.provider.archiveThread).not.toHaveBeenCalled();
    fixture.cache.close();
  });

  it("writes no change record when nothing in the batch moved", async () => {
    const changes: MailServiceChange[] = [];
    const fixture = await seeded(
      {
        archiveThread: vi.fn().mockRejectedValue(new MailProviderSyncError("mail_provider_thread_stale")),
      },
      ["thread-a", "thread-b"],
      changes,
    );
    // One left alone because its cached copy already has a reply, one stale.
    fixture.cache.replaceActiveThread(threadFixture("thread-a", 2000));
    changes.length = 0;
    const result = await fixture.service.archiveThreads(
      { accountId: ACCOUNT_ID, threads: pressed(["thread-a", "thread-b"]), archive: true },
      signal(),
    );
    expect(result.results.map((item) => item.status)).toEqual(["renewed", "stale"]);
    expect(changes).toEqual([]);
    fixture.cache.close();
  });

  it("costs a fifteen-thread Gmail Done four provider calls, where the per-thread path costs sixty", async () => {
    const ids = Array.from({ length: 15 }, (_value, index) => `thread-${index}`);
    const flagged = new Set<string>();
    const calls: string[] = [];
    const gmailThread = (threadId: string) => ({
      id: threadId,
      snippet: null,
      historyId: "300",
      messages: [
        {
          id: `message-${threadId}`,
          threadId,
          labelIds: flagged.has(threadId) ? [] : ["UNREAD"],
          snippet: null,
          historyId: "300",
          internalDate: "1000",
          sizeEstimate: null,
          payload: null,
        },
      ],
    });
    const client = {
      batchModifyMessages: vi.fn(async () => void calls.push("messages.batchModify")),
      listHistory: vi.fn(async () => {
        calls.push("history.list");
        return { items: [], nextPageToken: null, historyId: "300" };
      }),
      getThread: vi.fn(async (threadId: string) => {
        calls.push("threads.get");
        return gmailThread(threadId);
      }),
      archiveThread: vi.fn(async () => void calls.push("threads.modify")),
      markThreadRead: vi.fn(async (threadId: string) => {
        calls.push("threads.modify");
        flagged.add(threadId);
      }),
    } as unknown as GmailApiClient;
    const gmail = new GmailMailSyncAdapter(ACCOUNT_ID, client);
    // The same adapter with its batch taken away: what 0.20.3 sent.
    const perThread: Partial<MailProviderSyncPort> = {
      getThread: (threadId, signal) => gmail.getThread(threadId, signal),
      archiveThread: (threadId, signal) => gmail.archiveThread(threadId, signal),
      setThreadRead: (threadId, read, signal) => gmail.setThreadRead(threadId, read, signal),
    };
    const input = {
      accountId: ACCOUNT_ID,
      threads: pressed(ids),
      archive: true as const,
      read: true as const,
    };

    const before = await seeded(perThread, ids);
    await before.service.archiveThreads(input, signal());
    const beforeCalls = calls.splice(0).length;
    before.cache.close();
    flagged.clear();

    const after = await seeded(
      {
        getThread: (threadId, signal) => gmail.getThread(threadId, signal),
        archiveThreads: (batch, signal) => gmail.archiveThreads(batch, signal),
      },
      ids,
    );
    const result = await after.service.archiveThreads(input, signal());

    expect(beforeCalls).toBe(60);
    expect(calls).toEqual([
      "messages.batchModify",
      "history.list",
      "messages.batchModify",
      "history.list",
    ]);
    expect(result.results.every((item) => item.status === "done" && item.markedRead)).toBe(true);
    expect((await after.service.listThreads({ accountId: ACCOUNT_ID, limit: 20 })).items).toEqual([]);
    after.cache.close();
  });
});

async function createService(
  overrides: Partial<MailProviderSyncPort>,
  options: {
    readonly now?: () => number;
    readonly hydrateHiddenMailboxes?: boolean;
    readonly onChange?: (change: MailServiceChange) => void;
  } = {},
): Promise<{
  readonly service: AccountMailMessageService;
  readonly cache: SqliteMailMessageCache;
  readonly provider: MailProviderSyncPort;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-service-"));
  roots.push(root);
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { mode: 0o700 });
  const cache = new SqliteMailMessageCache({ cacheRoot, accountId: ACCOUNT_ID });
  await cache.initialize();
  const provider: MailProviderSyncPort = {
    getSyncAnchor: vi.fn().mockResolvedValue("100"),
    listInitialThreads: vi.fn().mockResolvedValue({ threads: [], nextPageToken: null }),
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
  return {
    cache,
    provider,
    service: new AccountMailMessageService({
      accountId: ACCOUNT_ID,
      cache,
      provider,
      reauthErrorCode: "gmail_reauth_required",
      now: options.now,
      hydrateHiddenMailboxes: options.hydrateHiddenMailboxes,
      onChange: options.onChange,
    }),
  };
}

function mailboxThreadFixture(
  threadId: string,
  sentAt: number,
  mailboxes: CachedProviderThread["mailboxes"],
): CachedProviderThread {
  const base = threadFixture(threadId, sentAt, false);
  return Object.freeze({
    ...base,
    inInbox: mailboxes.includes("inbox"),
    mailboxes: Object.freeze([...mailboxes]),
  });
}

function threadFixture(
  threadId: string,
  sentAt: number,
  unread = true,
): CachedProviderThread {
  const message: CachedProviderMessage = Object.freeze({
    accountId: ACCOUNT_ID,
    messageId: `message-${threadId}`,
    threadId,
    from: Object.freeze({ name: "Sender", address: "sender@example.test" }),
    replyTo: Object.freeze([]),
    to: Object.freeze([{ name: null, address: "reader@example.test" }]),
    cc: Object.freeze([]),
    subject: `Subject ${threadId}`,
    sentAt,
    unread,
    inInbox: true,
    snippet: `Snippet ${threadId}`,
    textBody: `Body ${threadId}`,
    htmlBody: null,
    hasAttachments: false,
    rfcMessageId: `<${threadId}@example.test>`,
    references: Object.freeze([]),
    listMessage: false,
    category: "people",
    sizeEstimate: null,
  });
  const thread: MailThreadListItem = Object.freeze({
    accountId: ACCOUNT_ID,
    threadId,
    subject: message.subject,
    participants: Object.freeze([message.from!]),
    snippet: message.snippet,
    lastMessageAt: sentAt,
    messageCount: 1,
    unread,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
    newSender: false,
  });
  return Object.freeze({
    thread,
    messages: Object.freeze([message]),
    inInbox: true,
    mailboxes: Object.freeze(["all", "inbox"] as const),
  });
}
