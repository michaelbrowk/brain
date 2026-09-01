import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailThreadListItem } from "../message-types";
import {
  type CachedProviderMessage,
  type CachedProviderThread,
  MailCacheError,
  SqliteMailMessageCache,
} from "./message-cache";
import {
  AccountMailMessageService,
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

async function createService(
  overrides: Partial<MailProviderSyncPort>,
  options: {
    readonly now?: () => number;
    readonly hydrateHiddenMailboxes?: boolean;
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
  });
  return Object.freeze({
    thread,
    messages: Object.freeze([message]),
    inInbox: true,
    mailboxes: Object.freeze(["all", "inbox"] as const),
  });
}
