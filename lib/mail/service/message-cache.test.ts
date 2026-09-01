import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { MailThreadCategory, MailThreadListItem } from "../message-types";
import {
  type CachedProviderMessage,
  type CachedProviderThread,
  type MailCacheHydratableMailbox,
  type MailCacheMailbox,
  MailCacheError,
  selectWorstMailSyncError,
  SqliteMailMessageCache,
} from "./message-cache";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("per-account message cache", () => {
  it("resets a pre-migration Gmail snapshot before incomplete Reply-To can be used", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-reply-to", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    const rollbackDatabase = new DatabaseSync(databasePath);
    rollbackDatabase.exec("ALTER TABLE messages DROP COLUMN reply_to_complete");
    rollbackDatabase.exec("ALTER TABLE messages DROP COLUMN reply_to_json");
    rollbackDatabase.close();

    const rolledForward = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await rolledForward.initialize();
    withDatabase(databasePath, (database) => {
      expect(
        database
          .prepare(
            "SELECT reply_to_json, reply_to_complete FROM messages WHERE account_id = ?",
          )
          .get(ACCOUNT_ID),
      ).toEqual({ reply_to_json: "[]", reply_to_complete: 0 });
    });
    expect(
      rolledForward.bindProviderCacheIdentity({
        providerKind: "gmail",
        transportBindingVersion: null,
      }),
    ).toEqual({ reset: true });
    expect(rolledForward.getThread("thread-reply-to")).toBeNull();
    expect(rolledForward.readSyncState()).toMatchObject({
      activeGeneration: 0,
      stagedGeneration: null,
      historyId: null,
      status: "idle",
    });
    expect(
      rolledForward.searchThreads({
        mailboxId: "inbox",
        query: "reply",
        limit: 10,
      }).items,
    ).toEqual([]);
    rolledForward.close();
  });

  it("detects old-runtime Gmail writes after rollback and resets the snapshot", async () => {
    const fixture = await createCache();
    expect(
      fixture.cache.bindProviderCacheIdentity({
        providerKind: "gmail",
        transportBindingVersion: null,
      }),
    ).toEqual({ reset: false });
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-rollback-write", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database
        .prepare("DELETE FROM messages WHERE account_id = ?")
        .run(ACCOUNT_ID);
      database
        .prepare(
          `INSERT INTO messages(
             account_id, generation, message_id, thread_id, from_json,
             to_json, cc_json, subject, sent_at, unread, in_inbox, snippet,
             text_body, html_body, rfc_message_id, references_json,
             has_attachments
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ACCOUNT_ID,
          generation,
          "message-thread-rollback-write",
          "thread-rollback-write",
          JSON.stringify({ name: "Sender", address: "sender@example.test" }),
          JSON.stringify([{ name: null, address: "reader@example.test" }]),
          "[]",
          "Subject thread-rollback-write",
          1_000,
          1,
          1,
          "Snippet thread-rollback-write",
          "Body thread-rollback-write",
          null,
          "<thread-rollback-write@example.test>",
          "[]",
          0,
        );
      expect(
        database
          .prepare(
            "SELECT reply_to_json, reply_to_complete FROM messages WHERE account_id = ?",
          )
          .get(ACCOUNT_ID),
      ).toEqual({ reply_to_json: "[]", reply_to_complete: 0 });
    });

    const rolledForward = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await rolledForward.initialize();
    expect(
      rolledForward.bindProviderCacheIdentity({
        providerKind: "gmail",
        transportBindingVersion: null,
      }),
    ).toEqual({ reset: true });
    expect(rolledForward.listThreads({ limit: 10 }).items).toEqual([]);
    expect(
      rolledForward.searchThreads({
        mailboxId: "inbox",
        query: "rollback",
        limit: 10,
      }).items,
    ).toEqual([]);
    rolledForward.close();
  });

  it("makes the first initial page readable while later pages continue", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      "next-page",
    );

    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["thread-a"]);
    expect(fixture.cache.getThread("thread-a")?.messages[0].textBody).toBe(
      "Body thread-a",
    );
    expect(fixture.cache.readReplyContext("message-thread-a")).toEqual({
      providerThreadId: "thread-a",
      rfcMessageId: "<thread-a@example.test>",
      references: [],
    });
    expect(fixture.cache.readSyncState()).toMatchObject({
      activeGeneration: 0,
      stagedGeneration: 1,
      pageToken: "next-page",
      status: "syncing",
    });

    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-b", 2000)],
      "next-page",
      null,
    );
    fixture.cache.completeInitial(generation, 3000);

    const page = fixture.cache.listThreads({ limit: 1 });
    expect(page.items.map((thread) => thread.threadId)).toEqual(["thread-b"]);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fixture.cache.listThreads({ cursor: page.nextCursor!, limit: 1 }).items)
      .toEqual([expect.objectContaining({ threadId: "thread-a" })]);
    expect(fixture.cache.getThread("thread-a")?.messages[0].textBody).toBe("Body thread-a");
    expect(fixture.cache.readReplyContext("message-thread-a")).toEqual({
      providerThreadId: "thread-a",
      rfcMessageId: "<thread-a@example.test>",
      references: [],
    });
    fixture.cache.close();
  });

  it("keeps the old complete generation readable during a later rebuild", async () => {
    const fixture = await createCache();
    const firstGeneration = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      firstGeneration,
      [threadFixture("old-thread", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(firstGeneration, 2000);

    const rebuildGeneration = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(
      rebuildGeneration,
      [threadFixture("new-thread-a", 3000)],
      null,
      "next-rebuild-page",
    );

    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["old-thread"]);
    expect(fixture.cache.getThread("new-thread-a")).toBeNull();
    expect(fixture.cache.readReplyContext("message-new-thread-a")).toBeNull();
    expect(fixture.cache.readReplyContext("message-old-thread")).toMatchObject({
      providerThreadId: "old-thread",
    });

    fixture.cache.putInitialPage(
      rebuildGeneration,
      [threadFixture("new-thread-b", 4000)],
      "next-rebuild-page",
      null,
    );
    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["old-thread"]);

    fixture.cache.completeInitial(rebuildGeneration, 5000);
    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["new-thread-b", "new-thread-a"]);
    expect(fixture.cache.readReplyContext("message-old-thread")).toBeNull();
    fixture.cache.close();
  });

  it("rejects a pagination cursor after the readable generation changes", async () => {
    const fixture = await createCache();
    const firstGeneration = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      firstGeneration,
      [threadFixture("old-a", 2000), threadFixture("old-b", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(firstGeneration, 2500);
    const firstPage = fixture.cache.listThreads({ limit: 1 });
    expect(firstPage.nextCursor).not.toBeNull();

    const secondGeneration = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(
      secondGeneration,
      [threadFixture("new-a", 3000), threadFixture("new-b", 1500)],
      null,
      null,
    );
    fixture.cache.completeInitial(secondGeneration, 3500);

    expect(() =>
      fixture.cache.listThreads({ cursor: firstPage.nextCursor!, limit: 1 }),
    ).toThrow("mail_sync_stale");
    fixture.cache.close();
  });

  it("commits changed rows and the Gmail history cursor atomically", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);

    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [
        { kind: "upsert", value: threadFixture("thread-b", 3000) },
        { kind: "delete", threadId: "thread-a" },
      ],
      nextPageToken: "history-page-two",
      resultingHistoryId: "150",
      now: 4000,
    });
    expect(fixture.cache.readSyncState()).toMatchObject({
      historyId: "100",
      pageToken: "history-page-two",
      status: "syncing",
    });
    expect(fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId))
      .toEqual(["thread-b"]);

    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: "history-page-two",
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "150",
      now: 5000,
    });
    expect(fixture.cache.readSyncState()).toMatchObject({
      historyId: "150",
      pageToken: null,
      status: "idle",
      lastSuccessfulAt: 5000,
    });
    expect(() =>
      fixture.cache.applyIncrementalPage({
        expectedHistoryId: "100",
        expectedPageToken: null,
        changes: [],
        nextPageToken: null,
        resultingHistoryId: "151",
        now: 6000,
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    fixture.cache.close();
  });

  it("publishes Inbox membership with the legacy initial generation", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000, ["all", "inbox", "sent", "starred"])],
      null,
      null,
    );

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, generation, "thread-a")).toEqual([
        "all",
        "inbox",
        "sent",
        "starred",
      ]);
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: 0,
        staged_thread_generation: generation,
        initial_anchor_history_id: "100",
        status: "syncing",
      });
    });

    fixture.cache.completeInitial(generation, 2000);
    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => ({
        threadId: item.threadId,
        starred: item.starred,
      })),
    ).toEqual([{ threadId: "thread-a", starred: true }]);
    expect(fixture.cache.readSyncState()).toMatchObject({
      activeGeneration: generation,
      historyId: "100",
      status: "idle",
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: generation,
        staged_thread_generation: null,
        observed_history_id: "100",
        status: "idle",
        last_successful_at: 2000,
      });
      expect(mailboxState(database, "sent")).toMatchObject({
        active_thread_generation: 0,
        staged_thread_generation: generation,
        observed_history_id: null,
        status: "uninitialized",
      });
    });
    fixture.cache.close();
  });

  it("resumes an initial page after reopen without losing staged Inbox rows", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000, ["all", "inbox", "sent"])],
      null,
      "next-page",
    );
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.resumeInitial()).toBe(generation);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, generation, "thread-a")).toEqual([
        "all",
        "inbox",
        "sent",
      ]);
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: 0,
        staged_thread_generation: generation,
        initial_anchor_history_id: "100",
        page_token: "next-page",
        status: "syncing",
      });
    });
    reopened.putInitialPage(
      generation,
      [threadFixture("thread-b", 2000, ["all", "inbox", "starred"])],
      "next-page",
      null,
    );
    reopened.completeInitial(generation, 3000);
    expect(
      reopened.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["thread-b", "thread-a"]);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, generation, "thread-a")).toEqual([
        "all",
        "inbox",
        "sent",
      ]);
      expect(mailboxesFor(database, generation, "thread-b")).toEqual([
        "all",
        "inbox",
        "starred",
      ]);
    });
    reopened.close();

  });

  it("rebuilds staged Inbox memberships after a rebuild crashes", async () => {
    const fixture = await createCache();
    const firstGeneration = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      firstGeneration,
      [threadFixture("old-thread", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(firstGeneration, 2000);

    const rebuildGeneration = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(
      rebuildGeneration,
      [threadFixture("new-thread-a", 3000, ["all", "inbox", "sent"])],
      null,
      "next-rebuild-page",
    );
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.resumeInitial()).toBe(rebuildGeneration);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(
        mailboxesFor(database, rebuildGeneration, "new-thread-a"),
      ).toEqual(["all", "inbox", "sent"]);
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: firstGeneration,
        staged_thread_generation: rebuildGeneration,
        observed_history_id: "100",
        initial_anchor_history_id: "200",
        page_token: "next-rebuild-page",
        status: "syncing",
      });
    });

    reopened.putInitialPage(
      rebuildGeneration,
      [threadFixture("new-thread-b", 4000, ["all", "inbox", "starred"])],
      "next-rebuild-page",
      null,
    );
    reopened.completeInitial(rebuildGeneration, 5000);
    expect(
      reopened.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["new-thread-b", "new-thread-a"]);
    expect(reopened.getThread("old-thread")).toBeNull();
    reopened.close();
  });

  it("keeps an active Sent snapshot across a cursor-invalid Inbox rebuild", async () => {
    const fixture = await createCache();
    const firstGeneration = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      firstGeneration,
      [threadFixture("old-inbox", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(firstGeneration, 2000);
    fixture.cache.replaceActiveThread(
      threadFixture("sent-only", 1500, ["all", "sent"]),
    );
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = '100', status = 'idle',
                  last_successful_at = 2000
            WHERE account_id = ? AND mailbox_id = 'sent'`,
        )
        .run(firstGeneration, ACCOUNT_ID);
    });

    const rebuildGeneration = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(
      rebuildGeneration,
      [
        threadFixture("new-inbox", 3000, [
          "all",
          "inbox",
          "sent",
          "starred",
        ]),
      ],
      null,
      null,
    );
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, firstGeneration, "sent-only")).toEqual([
        "sent",
      ]);
      expect(mailboxesFor(database, rebuildGeneration, "new-inbox")).toEqual([
        "all",
        "inbox",
        "starred",
      ]);
      expect(mailboxState(database, "sent")).toMatchObject({
        active_thread_generation: firstGeneration,
        staged_thread_generation: null,
        observed_history_id: "100",
        status: "idle",
      });
    });

    fixture.cache.completeInitial(rebuildGeneration, 4000);
    fixture.cache.close();
    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, firstGeneration, "sent-only")).toEqual([
        "sent",
      ]);
      expect(mailboxesFor(database, firstGeneration, "old-inbox")).toEqual([]);
      expect(mailboxesFor(database, rebuildGeneration, "new-inbox")).toEqual([
        "all",
        "inbox",
        "starred",
      ]);
      expect(mailboxState(database, "sent")).toMatchObject({
        active_thread_generation: firstGeneration,
        staged_thread_generation: null,
        observed_history_id: "100",
        status: "idle",
      });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    reopened.applyIncrementalPage({
      expectedHistoryId: "200",
      expectedPageToken: null,
      changes: [
        {
          kind: "upsert",
          value: threadFixture("new-inbox", 5000, [
            "all",
            "inbox",
            "sent",
            "starred",
          ]),
        },
      ],
      nextPageToken: null,
      resultingHistoryId: "250",
      now: 5000,
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, firstGeneration, "sent-only")).toEqual([
        "sent",
      ]);
      expect(mailboxesFor(database, rebuildGeneration, "new-inbox")).toEqual([
        "all",
        "inbox",
        "starred",
      ]);
      expect(mailboxState(database, "sent")).toMatchObject({
        active_thread_generation: firstGeneration,
        observed_history_id: "100",
      });
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: rebuildGeneration,
        observed_history_id: "250",
      });
    });
    reopened.close();

    // Simulate a rollback to the old v1 runtime, which knows only the global
    // generation and can remove the retained Sent generation.
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare("DELETE FROM threads WHERE account_id = ? AND generation = ?")
        .run(ACCOUNT_ID, firstGeneration);
    });
    const recoveredAfterRollback = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await recoveredAfterRollback.initialize();
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxState(database, "sent")).toMatchObject({
        active_thread_generation: 0,
        staged_thread_generation: null,
        observed_history_id: null,
        status: "uninitialized",
      });
      expect(
        database
          .prepare(
            `SELECT thread_id FROM thread_mailboxes
              WHERE account_id = ? AND mailbox_id = 'sent'`,
          )
          .all(ACCOUNT_ID),
      ).toEqual([]);
    });
    recoveredAfterRollback.close();
  });

  it("moves memberships during incremental pages and publishes only the final cursor", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);

    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [
        {
          kind: "upsert",
          value: threadFixture("thread-a", 3000, ["all", "sent"]),
        },
        {
          kind: "upsert",
          value: threadFixture("thread-b", 4000, ["all", "inbox", "starred"]),
        },
      ],
      nextPageToken: "history-page-two",
      resultingHistoryId: "150",
      now: 4500,
    });

    expect(fixture.cache.readSyncState()).toMatchObject({
      historyId: "100",
      pageToken: "history-page-two",
    });
    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["thread-b"]);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, generation, "thread-a")).toEqual([
        "all",
        "sent",
      ]);
      expect(mailboxesFor(database, generation, "thread-b")).toEqual([
        "all",
        "inbox",
        "starred",
      ]);
      expect(mailboxState(database, "inbox")).toMatchObject({
        observed_history_id: "100",
        status: "idle",
        last_successful_at: 2000,
      });
    });

    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: "history-page-two",
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "150",
      now: 5000,
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: generation,
        staged_thread_generation: null,
        observed_history_id: "150",
        status: "idle",
        last_successful_at: 5000,
      });
    });
    fixture.cache.close();
  });

  it("replaces an active thread and its memberships without moving History", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);

    fixture.cache.replaceActiveThread(
      threadFixture("thread-a", 3000, ["all", "sent"]),
    );
    expect(fixture.cache.listThreads({ limit: 10 }).items).toEqual([]);
    expect(fixture.cache.readSyncState()).toMatchObject({ historyId: "100" });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, generation, "thread-a")).toEqual([
        "all",
        "sent",
      ]);
      expect(mailboxState(database, "inbox")).toMatchObject({
        observed_history_id: "100",
      });
    });

    fixture.cache.replaceActiveThread(
      threadFixture("thread-a", 4000, ["all", "inbox", "starred"]),
    );
    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["thread-a"]);
    expect(fixture.cache.readSyncState()).toMatchObject({ historyId: "100" });
    fixture.cache.close();
  });

  it("projects system actions from refreshed provider memberships without inventing folders", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);

    for (const [name, mailboxes] of [
      ["trash", ["trash"]],
      ["restore", ["all", "inbox"]],
      ["spam", ["spam"]],
      ["not-spam", ["all"]],
      ["star", ["all", "inbox", "starred"]],
      ["unstar", ["all", "inbox"]],
    ] as const) {
      fixture.cache.replaceActiveThread(
        threadFixture("thread-a", 3000, mailboxes),
      );
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        expect(mailboxesFor(database, generation, "thread-a"), name).toEqual(
          [...mailboxes].sort(),
        );
      });
      expect(
        fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
        name,
      ).toEqual(
        (mailboxes as readonly string[]).includes("inbox")
          ? ["thread-a"]
          : [],
      );
    }

    expect(fixture.cache.readSyncState().historyId).toBe("100");
    fixture.cache.close();
  });

  it.each([
    {
      expectedStatus: "backoff",
      errorCode: "gmail_rate_limited",
      apply: (cache: SqliteMailMessageCache) =>
        cache.markBackoff("gmail_rate_limited"),
    },
    {
      expectedStatus: "reauth_required",
      errorCode: "gmail_reauth_required",
      apply: (cache: SqliteMailMessageCache) =>
        cache.markReauthRequired("gmail_reauth_required"),
    },
  ])(
    "mirrors $expectedStatus across the legacy and active mailbox snapshots",
    async ({ expectedStatus, errorCode, apply }) => {
      const fixture = await createCache();
      const generation = fixture.cache.beginInitial("100");
      fixture.cache.putInitialPage(
        generation,
        [threadFixture("thread-a", 1000, ["all", "inbox", "sent"])],
        null,
        null,
      );
      fixture.cache.completeInitial(generation, 2000);
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        database
          .prepare(
            `UPDATE mailbox_sync_state
                SET active_thread_generation = ?, staged_thread_generation = NULL,
                    observed_history_id = '100', status = 'idle',
                    last_successful_at = 2000
              WHERE account_id = ? AND mailbox_id = 'sent'`,
          )
          .run(generation, ACCOUNT_ID);
      });

      apply(fixture.cache);
      expect(fixture.cache.readSyncState()).toMatchObject({
        status: expectedStatus,
      });
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        expect(mailboxState(database, "inbox")).toMatchObject({
          status: expectedStatus,
          last_error_code: errorCode,
        });
        expect(mailboxState(database, "sent")).toMatchObject({
          status: expectedStatus,
          last_error_code: errorCode,
        });
        expect(mailboxState(database, "starred")).toMatchObject({
          status: "uninitialized",
          last_error_code: null,
        });
      });
      fixture.cache.close();
    },
  );

  it("recovers a partial incremental page after reopen without publishing it", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [
        {
          kind: "upsert",
          value: threadFixture("thread-a", 3000, ["all", "sent"]),
        },
        {
          kind: "upsert",
          value: threadFixture("thread-b", 4000, ["all", "inbox", "starred"]),
        },
      ],
      nextPageToken: "history-page-two",
      resultingHistoryId: "150",
      now: 4500,
    });
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.readSyncState()).toMatchObject({
      historyId: "100",
      pageToken: "history-page-two",
      status: "syncing",
    });
    expect(
      reopened.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["thread-b"]);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, generation, "thread-a")).toEqual([
        "all",
        "sent",
      ]);
      expect(mailboxesFor(database, generation, "thread-b")).toEqual([
        "all",
        "inbox",
        "starred",
      ]);
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: generation,
        staged_thread_generation: null,
        observed_history_id: "100",
        status: "idle",
      });
      expect(mailboxState(database, "sent")).toMatchObject({
        active_thread_generation: 0,
        staged_thread_generation: generation,
        observed_history_id: null,
        status: "uninitialized",
      });
    });

    reopened.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: "history-page-two",
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "150",
      now: 5000,
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: generation,
        staged_thread_generation: null,
        observed_history_id: "150",
        status: "idle",
      });
      expect(mailboxesFor(database, generation, "thread-a")).toEqual([
        "all",
        "sent",
      ]);
      expect(mailboxesFor(database, generation, "thread-b")).toEqual([
        "all",
        "inbox",
        "starred",
      ]);
    });
    reopened.close();
  });

  it("preserves a partial History page through backoff and reopen", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [
        {
          kind: "upsert",
          value: threadFixture("thread-a", 3000, ["all", "sent"]),
        },
        {
          kind: "upsert",
          value: threadFixture("thread-b", 4000, ["all", "inbox", "starred"]),
        },
      ],
      nextPageToken: "history-page-two",
      resultingHistoryId: "150",
      now: 4500,
    });
    fixture.cache.markBackoff("gmail_rate_limited");
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.readSyncState()).toMatchObject({
      historyId: "100",
      pageToken: "history-page-two",
      status: "backoff",
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(historyCycle(database)).toEqual({
        start_history_id: "100",
        next_page_token: "history-page-two",
      });
      expect(mailboxesFor(database, generation, "thread-a")).toEqual([
        "all",
        "sent",
      ]);
      expect(mailboxesFor(database, generation, "thread-b")).toEqual([
        "all",
        "inbox",
        "starred",
      ]);
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: generation,
        observed_history_id: "100",
        status: "backoff",
        last_error_code: "gmail_rate_limited",
      });
    });
    reopened.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: "history-page-two",
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "150",
      now: 5000,
    });
    expect(reopened.readSyncState()).toMatchObject({
      historyId: "150",
      pageToken: null,
      status: "idle",
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(historyCycle(database)).toBeUndefined();
    });
    reopened.close();
  });

  it("withholds non-Inbox promotion when an old runtime started the History cycle", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000, ["all", "inbox", "sent"])],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.close();
    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = '100', status = 'idle',
                  last_successful_at = 2000
            WHERE account_id = ? AND mailbox_id = 'sent'`,
        )
        .run(generation, ACCOUNT_ID);
      database
        .prepare(
          `UPDATE sync_state
              SET page_token = 'old-runtime-page-two', status = 'syncing'
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
      expect(historyCycle(database)).toBeUndefined();
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    reopened.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: "old-runtime-page-two",
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "150",
      now: 3000,
    });
    reopened.close();
    withDatabase(databasePath, (database) => {
      expect(mailboxState(database, "inbox")).toMatchObject({
        observed_history_id: "150",
        last_successful_at: 3000,
      });
      expect(mailboxState(database, "sent")).toMatchObject({
        observed_history_id: "100",
        last_successful_at: 2000,
      });
      expect(historyCycle(database)).toBeUndefined();
    });
  });

  it("invalidates proof when an old runtime processes a middle History page", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000, ["all", "inbox", "sent"])],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = '100', status = 'idle',
                  last_successful_at = 2000
            WHERE account_id = ? AND mailbox_id = 'sent'`,
        )
        .run(generation, ACCOUNT_ID);
    });
    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [],
      nextPageToken: "new-runtime-page-two",
      resultingHistoryId: "150",
      now: 2500,
    });
    fixture.cache.close();
    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      expect(historyCycle(database)).toEqual({
        start_history_id: "100",
        next_page_token: "new-runtime-page-two",
      });
      database
        .prepare(
          `UPDATE sync_state
              SET page_token = 'old-runtime-page-three'
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    withDatabase(databasePath, (database) => {
      expect(historyCycle(database)).toBeUndefined();
    });
    reopened.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: "old-runtime-page-three",
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "150",
      now: 3000,
    });
    reopened.close();
    withDatabase(databasePath, (database) => {
      expect(mailboxState(database, "inbox")).toMatchObject({
        observed_history_id: "150",
      });
      expect(mailboxState(database, "sent")).toMatchObject({
        observed_history_id: "100",
      });
    });
  });

  it.each(["backoff", "reauth_required"] as const)(
    "keeps new-runtime History proof through %s and restart",
    async (failureMode) => {
      const fixture = await createCache();
      const generation = fixture.cache.beginInitial("100");
      fixture.cache.putInitialPage(
        generation,
        [threadFixture("thread-a", 1000, ["all", "inbox", "sent"])],
        null,
        null,
      );
      fixture.cache.completeInitial(generation, 2000);
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        database
          .prepare(
            `UPDATE mailbox_sync_state
                SET active_thread_generation = ?, staged_thread_generation = NULL,
                    observed_history_id = '100', status = 'idle',
                    last_successful_at = 2000
              WHERE account_id = ? AND mailbox_id = 'sent'`,
          )
          .run(generation, ACCOUNT_ID);
      });
      fixture.cache.applyIncrementalPage({
        expectedHistoryId: "100",
        expectedPageToken: null,
        changes: [],
        nextPageToken: "history-page-two",
        resultingHistoryId: "150",
        now: 2500,
      });
      fixture.cache.applyIncrementalPage({
        expectedHistoryId: "100",
        expectedPageToken: "history-page-two",
        changes: [],
        nextPageToken: "history-page-three",
        resultingHistoryId: "150",
        now: 2600,
      });
      if (failureMode === "backoff") {
        fixture.cache.markBackoff("gmail_rate_limited");
      } else {
        fixture.cache.markReauthRequired("gmail_reauth_required");
      }
      fixture.cache.close();

      const reopened = new SqliteMailMessageCache({
        cacheRoot: fixture.cacheRoot,
        accountId: ACCOUNT_ID,
      });
      await reopened.initialize();
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        expect(historyCycle(database)).toEqual({
          start_history_id: "100",
          next_page_token: "history-page-three",
        });
      });
      reopened.applyIncrementalPage({
        expectedHistoryId: "100",
        expectedPageToken: "history-page-three",
        changes: [],
        nextPageToken: null,
        resultingHistoryId: "150",
        now: 3000,
      });
      reopened.close();
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        expect(mailboxState(database, "sent")).toMatchObject({
          observed_history_id: "150",
          status: "idle",
          last_successful_at: 3000,
        });
        expect(historyCycle(database)).toBeUndefined();
      });
    },
  );

  it("rolls back a partial page when the History proof marker cannot commit", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database.exec(`
        CREATE TRIGGER fail_history_cycle_insert
        BEFORE INSERT ON mailbox_history_cycle
        BEGIN
          SELECT RAISE(ABORT, 'marker write failed');
        END;
      `);
    });

    expect(() =>
      fixture.cache.applyIncrementalPage({
        expectedHistoryId: "100",
        expectedPageToken: null,
        changes: [
          { kind: "upsert", value: threadFixture("thread-b", 3000) },
        ],
        nextPageToken: "history-page-two",
        resultingHistoryId: "150",
        now: 3000,
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_cache_unavailable" }));
    expect(fixture.cache.readSyncState()).toMatchObject({
      historyId: "100",
      pageToken: null,
      status: "idle",
    });
    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["thread-a"]);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(historyCycle(database)).toBeUndefined();
    });
    fixture.cache.close();
  });

  it("adds mailbox tables to a legacy v1 cache without breaking rollback", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database.exec(`
        DROP TABLE mailbox_retry_cursor;
        DROP TABLE mailbox_snapshot_metadata;
        DROP TABLE mailbox_hydration_progress;
        DROP TABLE mailbox_history_cycle;
        DROP TABLE pending_thread_refresh;
        DROP TABLE thread_mailboxes;
        DROP TABLE mailbox_sync_state;
        ALTER TABLE threads DROP COLUMN starred;
      `);
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.listThreads({ limit: 10 }).items[0]?.starred).toBe(false);
    reopened.close();

    withDatabase(databasePath, (database) => {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(
        database
          .prepare(
            `SELECT name
               FROM sqlite_schema
              WHERE type = 'table'
                AND name IN (
                  'mailbox_hydration_progress',
                  'mailbox_history_cycle',
                  'mailbox_retry_cursor',
                  'mailbox_snapshot_metadata',
                  'mailbox_sync_state',
                  'pending_thread_refresh',
                  'thread_mailboxes'
                )
              ORDER BY name ASC`,
          )
          .all()
          .map((row) => row.name),
      ).toEqual([
        "mailbox_history_cycle",
        "mailbox_hydration_progress",
        "mailbox_retry_cursor",
        "mailbox_snapshot_metadata",
        "mailbox_sync_state",
        "pending_thread_refresh",
        "thread_mailboxes",
      ]);
      expect(
        database
          .prepare(
            `SELECT mailbox_id
               FROM thread_mailboxes
              WHERE account_id = ? AND generation = ?
              ORDER BY mailbox_id ASC`,
          )
          .all(ACCOUNT_ID, generation)
          .map((row) => row.mailbox_id),
      ).toEqual(["all", "inbox"]);
      expect(
        database
          .prepare(
            `SELECT active_thread_generation, staged_thread_generation,
                    observed_history_id, status
               FROM mailbox_sync_state
              WHERE account_id = ? AND mailbox_id = 'inbox'`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({
        active_thread_generation: generation,
        staged_thread_generation: null,
        observed_history_id: "100",
        status: "idle",
      });
      expect(
        database
          .prepare(
            `SELECT active_thread_generation, staged_thread_generation,
                    observed_history_id, status
               FROM mailbox_sync_state
              WHERE account_id = ? AND mailbox_id = 'all'`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({
        active_thread_generation: 0,
        staged_thread_generation: generation,
        observed_history_id: null,
        status: "uninitialized",
      });
      expect(
        database
          .prepare(
            `SELECT active_thread_generation, staged_thread_generation,
                    observed_history_id, status
               FROM mailbox_sync_state
              WHERE account_id = ? AND mailbox_id = 'sent'`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({
        active_thread_generation: 0,
        staged_thread_generation: null,
        observed_history_id: null,
        status: "uninitialized",
      });

      // These are the exact checks the previous v1 runtime performs. Extra
      // tables must remain invisible to it during a rollback.
      expect(database.prepare("SELECT account_id FROM sync_state").all()).toEqual([
        { account_id: ACCOUNT_ID },
      ]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  it("adds and reconciles star state across rollback changes", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = '100', status = 'idle',
                  last_successful_at = 2000
            WHERE account_id = ? AND mailbox_id = 'starred'`,
        )
        .run(generation, ACCOUNT_ID);
      database
        .prepare(
          `INSERT INTO thread_mailboxes(
             account_id, mailbox_id, generation, thread_id
           ) VALUES (?, 'starred', ?, 'thread-a')`,
        )
        .run(ACCOUNT_ID, generation);
      database
        .prepare(
          `INSERT INTO mailbox_snapshot_metadata(
             account_id, mailbox_id, thread_generation,
             listed_thread_count, window_truncated
           ) VALUES (?, 'starred', ?, 1, 0)`,
        )
        .run(ACCOUNT_ID, generation);
      database.exec("ALTER TABLE threads DROP COLUMN starred");
    });
    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();

    expect(reopened.listThreads({ limit: 10 }).items[0]?.starred).toBe(true);
    withDatabase(databasePath, (database) => {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(
        database
          .prepare("PRAGMA table_info(threads)")
          .all()
          .find((column) => column.name === "starred")?.dflt_value,
      ).toBe("0");
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    reopened.close();

    // A rollback runtime only knows the mailbox membership tables. Reopening
    // the newer runtime must repair the additive column even though it already
    // exists from the previous upgrade.
    withDatabase(databasePath, (database) => {
      database
        .prepare(
          `DELETE FROM thread_mailboxes
            WHERE account_id = ? AND mailbox_id = 'starred'
              AND generation = ? AND thread_id = 'thread-a'`,
        )
        .run(ACCOUNT_ID, generation);
      expect(
        database
          .prepare(
            `SELECT starred FROM threads
              WHERE account_id = ? AND thread_id = 'thread-a'`,
          )
          .get(ACCOUNT_ID)?.starred,
      ).toBe(1);
    });

    const reopenedAfterUnstar = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopenedAfterUnstar.initialize();
    expect(reopenedAfterUnstar.listThreads({ limit: 10 }).items[0]?.starred).toBe(
      false,
    );
    reopenedAfterUnstar.close();

    withDatabase(databasePath, (database) => {
      database
        .prepare(
          `INSERT INTO thread_mailboxes(
             account_id, mailbox_id, generation, thread_id
           ) VALUES (?, 'starred', ?, 'thread-a')`,
        )
        .run(ACCOUNT_ID, generation);
      expect(
        database
          .prepare(
            `SELECT starred FROM threads
              WHERE account_id = ? AND thread_id = 'thread-a'`,
          )
          .get(ACCOUNT_ID)?.starred,
      ).toBe(0);
    });

    const reopenedAfterStar = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopenedAfterStar.initialize();
    expect(reopenedAfterStar.listThreads({ limit: 10 }).items[0]?.starred).toBe(
      true,
    );
    reopenedAfterStar.close();
  });

  it("preserves star state when absence comes from a truncated snapshot", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database
        .prepare(
          `UPDATE threads SET starred = 1
            WHERE account_id = ? AND generation = ? AND thread_id = 'thread-a'`,
        )
        .run(ACCOUNT_ID, generation);
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = '100', status = 'idle',
                  last_successful_at = 2000
            WHERE account_id = ? AND mailbox_id = 'starred'`,
        )
        .run(generation, ACCOUNT_ID);
      database
        .prepare(
          `INSERT INTO mailbox_snapshot_metadata(
             account_id, mailbox_id, thread_generation,
             listed_thread_count, window_truncated
           ) VALUES (?, 'starred', ?, 0, 1)`,
        )
        .run(ACCOUNT_ID, generation);
      database
        .prepare(
          `DELETE FROM thread_mailboxes
            WHERE account_id = ? AND mailbox_id = 'starred'
              AND generation = ? AND thread_id = 'thread-a'`,
        )
        .run(ACCOUNT_ID, generation);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.listThreads({ limit: 10 }).items[0]?.starred).toBe(true);
    reopened.close();
  });

  it("repairs Inbox without discarding non-Inbox after a legacy history advance", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = '100', status = 'idle',
                  last_successful_at = 2000
            WHERE account_id = ? AND mailbox_id = 'sent'`,
        )
        .run(generation, ACCOUNT_ID);
      database
        .prepare(
          `INSERT INTO thread_mailboxes(
             account_id, mailbox_id, generation, thread_id
           ) VALUES (?, 'sent', ?, 'thread-a')`,
        )
        .run(ACCOUNT_ID, generation);
      database
        .prepare(
          "UPDATE sync_state SET history_id = '200' WHERE account_id = ?",
        )
        .run(ACCOUNT_ID);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    reopened.close();

    withDatabase(databasePath, (database) => {
      expect(
        database
          .prepare(
            `SELECT mailbox_id
               FROM thread_mailboxes
              WHERE account_id = ?
              ORDER BY mailbox_id ASC`,
          )
          .all(ACCOUNT_ID),
      ).toEqual([
        { mailbox_id: "all" },
        { mailbox_id: "inbox" },
        { mailbox_id: "sent" },
      ]);
      expect(
        database
          .prepare(
            `SELECT active_thread_generation, staged_thread_generation,
                    observed_history_id, status
               FROM mailbox_sync_state
              WHERE account_id = ? AND mailbox_id = 'inbox'`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({
        active_thread_generation: generation,
        staged_thread_generation: null,
        observed_history_id: "200",
        status: "idle",
      });
      expect(
        database
          .prepare(
            `SELECT active_thread_generation, staged_thread_generation,
                    observed_history_id, status
               FROM mailbox_sync_state
              WHERE account_id = ? AND mailbox_id = 'sent'`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({
        active_thread_generation: generation,
        staged_thread_generation: null,
        observed_history_id: "100",
        status: "idle",
      });
    });

    const continued = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await continued.initialize();
    continued.applyIncrementalPage({
      expectedHistoryId: "200",
      expectedPageToken: null,
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "250",
      now: 3000,
    });
    continued.close();
    withDatabase(databasePath, (database) => {
      expect(mailboxState(database, "inbox")).toMatchObject({
        active_thread_generation: generation,
        observed_history_id: "250",
        last_successful_at: 3000,
      });
      expect(mailboxState(database, "sent")).toMatchObject({
        active_thread_generation: generation,
        observed_history_id: "100",
        last_successful_at: 2000,
      });
    });
  });

  it("reconciles a legacy archive even when the history cursor is unchanged", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database
        .prepare(
          `UPDATE threads
              SET in_inbox = 0
            WHERE account_id = ? AND generation = ? AND thread_id = 'thread-a'`,
        )
        .run(ACCOUNT_ID, generation);
      database
        .prepare(
          `UPDATE messages
              SET in_inbox = 0
            WHERE account_id = ? AND generation = ? AND thread_id = 'thread-a'`,
        )
        .run(ACCOUNT_ID, generation);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    reopened.close();

    withDatabase(databasePath, (database) => {
      expect(
        database
          .prepare(
            "SELECT mailbox_id FROM thread_mailboxes WHERE account_id = ?",
          )
          .all(ACCOUNT_ID),
      ).toEqual([{ mailbox_id: "all" }]);
      expect(
        database
          .prepare(
            `SELECT active_thread_generation, staged_thread_generation,
                    observed_history_id, status
               FROM mailbox_sync_state
              WHERE account_id = ? AND mailbox_id = 'inbox'`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({
        active_thread_generation: generation,
        staged_thread_generation: null,
        observed_history_id: "100",
        status: "idle",
      });
    });
  });

  it("preserves exact mailbox state during partial legacy pagination", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = '100', status = 'idle',
                  last_successful_at = 2000
            WHERE account_id = ? AND mailbox_id = 'sent'`,
        )
        .run(generation, ACCOUNT_ID);
      database
        .prepare(
          `INSERT INTO thread_mailboxes(
             account_id, mailbox_id, generation, thread_id
           ) VALUES (?, 'sent', ?, 'thread-a')`,
        )
        .run(ACCOUNT_ID, generation);
      database
        .prepare(
          "UPDATE sync_state SET page_token = 'next-page', status = 'syncing' WHERE account_id = ?",
        )
        .run(ACCOUNT_ID);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    reopened.close();

    withDatabase(databasePath, (database) => {
      expect(
        database
          .prepare(
            `SELECT mailbox_id
               FROM thread_mailboxes
              WHERE account_id = ?
              ORDER BY mailbox_id ASC`,
          )
          .all(ACCOUNT_ID),
      ).toEqual([
        { mailbox_id: "all" },
        { mailbox_id: "inbox" },
        { mailbox_id: "sent" },
      ]);
      expect(
        database
          .prepare(
            `SELECT active_thread_generation, staged_thread_generation,
                    observed_history_id, status
               FROM mailbox_sync_state
              WHERE account_id = ? AND mailbox_id = 'inbox'`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({
        active_thread_generation: generation,
        staged_thread_generation: null,
        observed_history_id: "100",
        status: "idle",
      });
    });
  });

  it.each([
    { status: "backoff", errorCode: "gmail_rate_limited" },
    { status: "reauth_required", errorCode: "gmail_reauth_required" },
  ])(
    "preserves the last complete Inbox while the legacy cache is $status",
    async ({ status, errorCode }) => {
      const fixture = await createCache();
      const generation = fixture.cache.beginInitial("100");
      fixture.cache.putInitialPage(
        generation,
        [threadFixture("thread-a", 1000)],
        null,
        null,
      );
      fixture.cache.completeInitial(generation, 2000);
      fixture.cache.close();

      const databasePath = cacheDatabasePath(fixture.cacheRoot);
      withDatabase(databasePath, (database) => {
        database
          .prepare(
            `UPDATE sync_state
                SET status = ?, last_error_code = ?
              WHERE account_id = ?`,
          )
          .run(status, errorCode, ACCOUNT_ID);
      });

      const reopened = new SqliteMailMessageCache({
        cacheRoot: fixture.cacheRoot,
        accountId: ACCOUNT_ID,
      });
      await reopened.initialize();
      reopened.close();

      withDatabase(databasePath, (database) => {
        expect(
          database
            .prepare(
              `SELECT active_thread_generation, staged_thread_generation,
                      observed_history_id, status
                 FROM mailbox_sync_state
                WHERE account_id = ? AND mailbox_id = 'inbox'`,
            )
            .get(ACCOUNT_ID),
        ).toEqual({
          active_thread_generation: generation,
          staged_thread_generation: null,
          observed_history_id: "100",
          status: "idle",
        });
      });
    },
  );

  it("keeps refresh markers when a cached thread is deleted", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.close();

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `INSERT INTO pending_thread_refresh(account_id, thread_id, queued_at)
           VALUES (?, 'thread-a', 3000)`,
        )
        .run(ACCOUNT_ID);
      database
        .prepare(
          `DELETE FROM threads
            WHERE account_id = ? AND generation = ? AND thread_id = 'thread-a'`,
        )
        .run(ACCOUNT_ID, generation);

      expect(
        database
          .prepare(
            "SELECT thread_id, queued_at FROM pending_thread_refresh WHERE account_id = ?",
          )
          .all(ACCOUNT_ID),
      ).toEqual([{ thread_id: "thread-a", queued_at: 3000 }]);
      expect(
        database
          .prepare(
            "SELECT thread_id FROM thread_mailboxes WHERE account_id = ?",
          )
          .all(ACCOUNT_ID),
      ).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  it("isolates a hidden Sent crawl from published Inbox and Starred snapshots", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [
        threadFixture("overlap", 1000, [
          "all",
          "inbox",
          "starred",
        ]),
      ],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);

    const starred = fixture.cache.beginOrResumeMailboxHydration("starred");
    expect(starred).toMatchObject({ stagedGeneration: generation });
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "starred",
      generation,
      expectedPageToken: null,
      threads: [
        threadFixture("overlap", 2100, ["all", "inbox", "starred"]),
      ],
      listedCount: 1,
      nextPageToken: null,
    });
    expect(fixture.cache.markPostCrawlHistoryObserved("starred")).toBe(true);
    fixture.cache.completeMailboxHydration({
      mailboxId: "starred",
      generation,
      expectedHistoryId: "100",
      now: 2200,
    });

    let starredBefore: Record<string, unknown> | undefined;
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      starredBefore = mailboxState(database, "starred");
    });
    expect(fixture.cache.beginOrResumeMailboxHydration("sent")).toMatchObject({
      stagedGeneration: generation,
    });
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation,
      expectedPageToken: null,
      threads: [
        threadFixture("overlap", 3000, ["all", "sent"]),
        // Gmail can return a newly-created Inbox thread while the hidden crawl
        // is in flight. History, not this crawl, owns its Inbox visibility.
        threadFixture("new-race", 4000, ["all", "inbox", "sent"]),
      ],
      listedCount: 2,
      nextPageToken: "sent-page-two",
    });

    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["overlap"]);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxState(database, "starred")).toEqual(starredBefore);
      expect(mailboxesFor(database, generation, "overlap")).toEqual([
        "all",
        "inbox",
        "sent",
        "starred",
      ]);
      expect(mailboxesFor(database, generation, "new-race")).toEqual(["sent"]);
      expect(
        database
          .prepare(
            `SELECT thread_id, in_inbox
               FROM threads
              WHERE account_id = ? AND generation = ?
                AND thread_id IN ('new-race', 'overlap')
              ORDER BY thread_id ASC`,
          )
          .all(ACCOUNT_ID, generation),
      ).toEqual([
        { thread_id: "new-race", in_inbox: 0 },
        { thread_id: "overlap", in_inbox: 1 },
      ]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    fixture.cache.close();
  });

  it("resumes a non-empty hidden mailbox page after a crash without publishing it", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("inbox-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation,
      expectedPageToken: null,
      threads: [threadFixture("sent-a", 3000, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: "sent-page-two",
    });
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(
      reopened
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      activeGeneration: 0,
      stagedGeneration: generation,
      hydrationObservedHistoryId: "100",
      pageToken: "sent-page-two",
      pagesCompleted: 1,
      listedThreadCount: 1,
      crawlComplete: false,
    });
    expect(reopened.beginOrResumeMailboxHydration("sent")).toMatchObject({
      stagedGeneration: generation,
      pageToken: "sent-page-two",
    });
    expect(reopened.listThreads({ limit: 10 }).items.map((item) => item.threadId))
      .toEqual(["inbox-a"]);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, generation, "sent-a")).toEqual(["sent"]);
      expect(mailboxState(database, "sent")).toMatchObject({
        active_thread_generation: 0,
        staged_thread_generation: generation,
        page_token: "sent-page-two",
        status: "syncing",
      });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    reopened.close();
  });

  it("restarts a legacy hidden hydration that exceeds the current recent window", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 1000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation,
      expectedPageToken: null,
      threads: [],
      listedCount: 20,
      nextPageToken: "sent-page-two",
    });
    fixture.cache.close();

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE mailbox_hydration_progress
              SET pages_completed = 302, listed_thread_count = 1510
            WHERE account_id = ? AND mailbox_id = 'sent'`,
        )
        .run(ACCOUNT_ID);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(
      reopened
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      activeGeneration: 0,
      stagedGeneration: null,
      status: "uninitialized",
      pagesCompleted: 0,
      listedThreadCount: 0,
    });
    expect(reopened.beginOrResumeMailboxHydration("sent")).toMatchObject({
      stagedGeneration: generation,
      status: "syncing",
    });
    reopened.close();
  });

  it("advances hydration only after a proven History cycle and drains the barrier queue", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("inbox-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation,
      expectedPageToken: null,
      threads: [threadFixture("sent-a", 2500, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: null,
    });
    expect(() =>
      fixture.cache.completeMailboxHydration({
        mailboxId: "sent",
        generation,
        expectedHistoryId: "100",
        now: 2600,
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));

    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [
        {
          kind: "upsert",
          value: threadFixture("race-a", 3000, ["all", "inbox", "sent"]),
        },
      ],
      nextPageToken: "history-page-two",
      resultingHistoryId: "150",
      now: 3000,
    });
    expect(
      fixture.cache
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      hydrationObservedHistoryId: "100",
      postCrawlHistoryId: null,
    });
    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: "history-page-two",
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "150",
      now: 3100,
    });
    expect(fixture.cache.markPostCrawlHistoryObserved("sent")).toBe(true);
    const pending = fixture.cache.readPendingThreadRefreshes(20);
    expect(pending).toEqual([
      expect.objectContaining({ threadId: "race-a", queuedAt: 3000 }),
    ]);
    expect(() =>
      fixture.cache.completeMailboxHydration({
        mailboxId: "sent",
        generation,
        expectedHistoryId: "150",
        now: 3200,
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    expect(
      fixture.cache.applyPendingThreadRefreshes({
        mailboxId: "sent",
        generation,
        expectedHistoryId: "150",
        changes: [
          {
            kind: "upsert",
            queuedAt: pending[0]!.queuedAt,
            value: threadFixture("race-a", 3300, ["all", "inbox", "sent"]),
          },
        ],
      }),
    ).toBe(0);
    fixture.cache.completeMailboxHydration({
      mailboxId: "sent",
      generation,
      expectedHistoryId: "150",
      now: 3400,
    });
    expect(
      fixture.cache
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      activeGeneration: generation,
      stagedGeneration: null,
      activeObservedHistoryId: "150",
      status: "idle",
      activeListedThreadCount: 1,
      activeWindowTruncated: false,
    });
    fixture.cache.close();
  });

  it("drops only hidden progress on queue overflow and still commits the Inbox History page", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("inbox-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      const insert = database.prepare(
        `INSERT INTO pending_thread_refresh(account_id, thread_id, queued_at)
         VALUES (?, ?, ?)`,
      );
      for (let index = 0; index < 1000; index += 1) {
        insert.run(ACCOUNT_ID, `overflow-${index}`, index);
      }
    });

    expect(() =>
      fixture.cache.applyIncrementalPage({
        expectedHistoryId: "100",
        expectedPageToken: null,
        changes: [
          {
            kind: "upsert",
            value: threadFixture("overflow-new", 3000),
          },
        ],
        nextPageToken: null,
        resultingHistoryId: "150",
        now: 3000,
      }),
    ).not.toThrow();
    expect(fixture.cache.readSyncState()).toMatchObject({
      historyId: "150",
      pageToken: null,
      status: "idle",
      lastSuccessfulAt: 3000,
    });
    expect(fixture.cache.readPendingThreadRefreshes(20)).toEqual([]);
    expect(
      fixture.cache
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      activeGeneration: 0,
      stagedGeneration: null,
      hydrationObservedHistoryId: null,
      status: "uninitialized",
    });
    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((item) => item.threadId),
    ).toEqual(["overflow-new", "inbox-a"]);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    fixture.cache.close();
  }, 15_000);

  it("bounds All Mail to 200 listed threads and retains truncation metadata", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("inbox-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.beginOrResumeMailboxHydration("all");
    let expectedPageToken: string | null = null;
    for (let page = 1; page <= 10; page += 1) {
      const nextPageToken = page === 10 ? "provider-has-more" : `all-${page + 1}`;
      const state = fixture.cache.putMailboxHydrationPage({
        mailboxId: "all",
        generation,
        expectedPageToken,
        threads: [],
        listedCount: 20,
        nextPageToken,
      });
      expectedPageToken = nextPageToken;
      if (page < 10) expect(state.crawlComplete).toBe(false);
    }
    const staged = fixture.cache
      .readMailboxHydrationStates()
      .find((state) => state.mailboxId === "all");
    expect(staged).toMatchObject({
      pageToken: null,
      pagesCompleted: 10,
      listedThreadCount: 200,
      crawlComplete: true,
      windowTruncated: true,
    });
    expect(fixture.cache.markPostCrawlHistoryObserved("all")).toBe(true);
    fixture.cache.completeMailboxHydration({
      mailboxId: "all",
      generation,
      expectedHistoryId: "100",
      now: 3000,
    });
    expect(
      fixture.cache
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "all"),
    ).toMatchObject({
      activeGeneration: generation,
      activeListedThreadCount: 200,
      activeWindowTruncated: true,
    });
    fixture.cache.close();
  });

  it("publishes a truncated Sent page cap and allows Starred to start next", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 1000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    let expectedPageToken: string | null = null;
    for (let page = 1; page <= 10; page += 1) {
      const nextPageToken = `sent-page-${page + 1}`;
      const state = fixture.cache.putMailboxHydrationPage({
        mailboxId: "sent",
        generation,
        expectedPageToken,
        threads: [],
        listedCount: 20,
        nextPageToken,
      });
      expectedPageToken = nextPageToken;
      if (page < 10) expect(state.crawlComplete).toBe(false);
    }
    expect(
      fixture.cache
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      pageToken: null,
      pagesCompleted: 10,
      listedThreadCount: 200,
      crawlComplete: true,
      windowTruncated: true,
    });
    expect(fixture.cache.markPostCrawlHistoryObserved("sent")).toBe(true);
    fixture.cache.completeMailboxHydration({
      mailboxId: "sent",
      generation,
      expectedHistoryId: "100",
      now: 2000,
    });
    expect(
      fixture.cache
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      activeListedThreadCount: 200,
      activeWindowTruncated: true,
      status: "idle",
    });
    expect(fixture.cache.beginOrResumeMailboxHydration("starred")).toMatchObject({
      mailboxId: "starred",
      stagedGeneration: generation,
      status: "syncing",
    });
    fixture.cache.close();
  });

  it("enforces one active hidden hydration per account in both API and SQLite", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 2000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    expect(() => fixture.cache.beginOrResumeMailboxHydration("starred"))
      .toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(() =>
        database
          .prepare(
            `INSERT INTO mailbox_hydration_progress(
               account_id, mailbox_id, thread_generation,
               observed_history_id, pages_completed, listed_thread_count,
               crawl_complete, window_truncated, post_crawl_history_id
             ) VALUES (?, 'starred', ?, '100', 0, 0, 0, 0, NULL)`,
          )
          .run(ACCOUNT_ID, generation),
      ).toThrow();
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    fixture.cache.close();
  });

  it.each([
    {
      reauth: false,
      status: "backoff" as const,
      errorCode: "gmail_rate_limited",
    },
    {
      reauth: true,
      status: "reauth_required" as const,
      errorCode: "gmail_reauth_required",
    },
  ])(
    "abandons failed staged hydration while preserving $status and later mailbox progress",
    async ({ reauth, status, errorCode }) => {
      const fixture = await createCache();
      const firstGeneration = fixture.cache.beginInitial("100");
      fixture.cache.putInitialPage(firstGeneration, [], null, null);
      fixture.cache.completeInitial(firstGeneration, 1000);
      publishMailbox(
        fixture.cache,
        "sent",
        firstGeneration,
        "100",
        [threadFixture("sent-old", 1100, ["sent"])],
        1200,
      );

      const secondGeneration = fixture.cache.beginInitial("200");
      fixture.cache.putInitialPage(secondGeneration, [], null, null);
      fixture.cache.completeInitial(secondGeneration, 2000);
      fixture.cache.beginOrResumeMailboxHydration("sent");
      fixture.cache.putMailboxHydrationPage({
        mailboxId: "sent",
        generation: secondGeneration,
        expectedPageToken: null,
        threads: [threadFixture("sent-partial", 2100, ["sent"])],
        listedCount: 1,
        nextPageToken: "sent-page-two",
      });
      fixture.cache.markMailboxHydrationFailure("sent", errorCode, reauth);

      fixture.cache.abandonFailedMailboxHydration("sent");
      fixture.cache.abandonFailedMailboxHydration("sent");

      expect(
        fixture.cache
          .readMailboxHydrationStates()
          .find((state) => state.mailboxId === "sent"),
      ).toMatchObject({
        activeGeneration: firstGeneration,
        stagedGeneration: null,
        activeObservedHistoryId: "100",
        hydrationObservedHistoryId: null,
        initialAnchorHistoryId: null,
        pageToken: null,
        status,
        lastSuccessfulAt: 1200,
        pagesCompleted: 0,
        listedThreadCount: 0,
      });
      expect(fixture.cache.beginOrResumeMailboxHydration("sent")).toBeNull();
      expect(fixture.cache.beginOrResumeMailboxHydration("starred")).toMatchObject({
        mailboxId: "starred",
        stagedGeneration: secondGeneration,
        status: "syncing",
      });
      fixture.cache.putMailboxHydrationPage({
        mailboxId: "starred",
        generation: secondGeneration,
        expectedPageToken: null,
        threads: [],
        listedCount: 0,
        nextPageToken: null,
      });
      expect(fixture.cache.markPostCrawlHistoryObserved("starred")).toBe(true);
      fixture.cache.completeMailboxHydration({
        mailboxId: "starred",
        generation: secondGeneration,
        expectedHistoryId: "200",
        now: 2200,
      });

      fixture.cache.rearmFailedMailboxHydration("sent");
      fixture.cache.rearmFailedMailboxHydration("sent");
      expect(
        fixture.cache
          .readMailboxHydrationStates()
          .find((state) => state.mailboxId === "sent"),
      ).toMatchObject({
        activeGeneration: firstGeneration,
        stagedGeneration: null,
        activeObservedHistoryId: "100",
        status: "idle",
      });
      expect(fixture.cache.beginOrResumeMailboxHydration("sent")).toMatchObject({
        mailboxId: "sent",
        stagedGeneration: secondGeneration,
        status: "syncing",
      });
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        expect(mailboxesFor(database, firstGeneration, "sent-old")).toEqual([
          "sent",
        ]);
        expect(mailboxesFor(database, secondGeneration, "sent-partial")).toEqual(
          [],
        );
        expect(
          database
            .prepare(
              `SELECT last_error_code
                 FROM mailbox_sync_state
                WHERE account_id = ? AND mailbox_id = 'sent'`,
            )
            .get(ACCOUNT_ID),
        ).toEqual({ last_error_code: null });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      });
      fixture.cache.close();
    },
  );

  it("rearms an abandoned first hydration as uninitialized", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 1000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.markMailboxHydrationFailure(
      "sent",
      "gmail_rate_limited",
    );
    fixture.cache.abandonFailedMailboxHydration("sent");

    fixture.cache.rearmFailedMailboxHydration("sent");
    fixture.cache.rearmFailedMailboxHydration("sent");

    expect(
      fixture.cache
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      activeGeneration: 0,
      stagedGeneration: null,
      activeObservedHistoryId: null,
      status: "uninitialized",
      lastSuccessfulAt: null,
    });
    expect(fixture.cache.beginOrResumeMailboxHydration("sent")).toMatchObject({
      mailboxId: "sent",
      stagedGeneration: generation,
      status: "syncing",
    });
    fixture.cache.close();
  });

  it("persists fair failed-mailbox retry selection across reopen", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 1000);
    for (const mailboxId of ["sent", "starred"] as const) {
      fixture.cache.beginOrResumeMailboxHydration(mailboxId);
      fixture.cache.markMailboxHydrationFailure(
        mailboxId,
        "gmail_rate_limited",
      );
      fixture.cache.abandonFailedMailboxHydration(mailboxId);
    }

    expect(
      fixture.cache.selectFailedMailboxForRetry(["sent", "starred"]),
    ).toBe("sent");
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.selectFailedMailboxForRetry(["starred", "sent"])).toBe(
      "starred",
    );
    expect(reopened.selectFailedMailboxForRetry(["sent", "starred"])).toBe(
      "sent",
    );
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(
        database
          .prepare(
            `SELECT next_mailbox_index
               FROM mailbox_retry_cursor
              WHERE account_id = ?`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({ next_mailbox_index: 1 });
      expect(() =>
        database
          .prepare(
            `UPDATE mailbox_retry_cursor
                SET next_mailbox_index = 99
              WHERE account_id = ?`,
          )
          .run(ACCOUNT_ID),
      ).toThrow();
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    reopened.close();
  });

  it("does not let a permanently failing Sent mailbox starve Starred retry", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 1000);
    for (const mailboxId of ["sent", "starred"] as const) {
      fixture.cache.beginOrResumeMailboxHydration(mailboxId);
      fixture.cache.markMailboxHydrationFailure(
        mailboxId,
        "gmail_rate_limited",
      );
      fixture.cache.abandonFailedMailboxHydration(mailboxId);
    }

    expect(
      fixture.cache.selectFailedMailboxForRetry(["sent", "starred"]),
    ).toBe("sent");
    fixture.cache.rearmFailedMailboxHydration("sent");
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.markMailboxHydrationFailure("sent", "gmail_rate_limited");
    fixture.cache.abandonFailedMailboxHydration("sent");

    expect(
      fixture.cache.selectFailedMailboxForRetry(["sent", "starred"]),
    ).toBe("starred");
    fixture.cache.rearmFailedMailboxHydration("starred");
    expect(fixture.cache.beginOrResumeMailboxHydration("starred")).toMatchObject({
      mailboxId: "starred",
      stagedGeneration: generation,
      status: "syncing",
    });
    expect(fixture.cache.selectFailedMailboxForRetry([])).toBeNull();
    expect(() =>
      fixture.cache.selectFailedMailboxForRetry(["sent", "sent"]),
    ).toThrowError(expect.objectContaining({ code: "mail_cache_invalid" }));
    expect(() =>
      fixture.cache.selectFailedMailboxForRetry(["trash"]),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    fixture.cache.close();
  });

  it("cascades the persisted retry cursor with its account row", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 1000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.markMailboxHydrationFailure("sent", "gmail_rate_limited");
    fixture.cache.abandonFailedMailboxHydration("sent");
    expect(fixture.cache.selectFailedMailboxForRetry(["sent"])).toBe("sent");
    fixture.cache.close();

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare("DELETE FROM sync_state WHERE account_id = ?")
        .run(ACCOUNT_ID);
      expect(
        database
          .prepare(
            "SELECT next_mailbox_index FROM mailbox_retry_cursor WHERE account_id = ?",
          )
          .all(ACCOUNT_ID),
      ).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  it("preserves a published hidden snapshot when a cursor-invalid rebuild clears staging", async () => {
    const fixture = await createCache();
    const firstGeneration = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(firstGeneration, [], null, null);
    fixture.cache.completeInitial(firstGeneration, 1000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation: firstGeneration,
      expectedPageToken: null,
      threads: [threadFixture("sent-old", 1200, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: null,
    });
    fixture.cache.markPostCrawlHistoryObserved("sent");
    fixture.cache.completeMailboxHydration({
      mailboxId: "sent",
      generation: firstGeneration,
      expectedHistoryId: "100",
      now: 1300,
    });

    const secondGeneration = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(secondGeneration, [], null, null);
    fixture.cache.completeInitial(secondGeneration, 2000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation: secondGeneration,
      expectedPageToken: null,
      threads: [threadFixture("sent-new", 2200, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: "sent-page-two",
    });

    const thirdGeneration = fixture.cache.beginInitial("300");
    expect(thirdGeneration).toBe(secondGeneration + 1);
    expect(fixture.cache.readPendingThreadRefreshes(20)).toEqual([]);
    expect(
      fixture.cache
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      activeGeneration: firstGeneration,
      stagedGeneration: null,
      activeObservedHistoryId: "100",
      hydrationObservedHistoryId: null,
      status: "idle",
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, firstGeneration, "sent-old")).toEqual([
        "sent",
      ]);
      expect(mailboxesFor(database, secondGeneration, "sent-new")).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    fixture.cache.close();
  });

  it("drops stale staging but retains the published snapshot after an old v1 cursor advance", async () => {
    const fixture = await createCache();
    const firstGeneration = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(firstGeneration, [], null, null);
    fixture.cache.completeInitial(firstGeneration, 1000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation: firstGeneration,
      expectedPageToken: null,
      threads: [threadFixture("sent-old", 1100, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: null,
    });
    fixture.cache.markPostCrawlHistoryObserved("sent");
    fixture.cache.completeMailboxHydration({
      mailboxId: "sent",
      generation: firstGeneration,
      expectedHistoryId: "100",
      now: 1200,
    });

    const secondGeneration = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(secondGeneration, [], null, null);
    fixture.cache.completeInitial(secondGeneration, 2000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation: secondGeneration,
      expectedPageToken: null,
      threads: [threadFixture("sent-new", 2100, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: "sent-page-two",
    });
    fixture.cache.close();

    // Simulate the previous v1 runtime moving only the legacy global cursor.
    // It does not know the additive hydration tables.
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE sync_state
              SET history_id = '250', status = 'idle', page_token = NULL,
                  last_successful_at = 2500
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
      database
        .prepare(
          `INSERT INTO pending_thread_refresh(account_id, thread_id, queued_at)
           VALUES (?, 'old-v1-race', 2400)`,
        )
        .run(ACCOUNT_ID);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.readSyncState()).toMatchObject({ historyId: "250" });
    expect(reopened.readPendingThreadRefreshes(20)).toEqual([]);
    expect(
      reopened
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      activeGeneration: firstGeneration,
      stagedGeneration: null,
      activeObservedHistoryId: "100",
      hydrationObservedHistoryId: null,
      status: "idle",
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, firstGeneration, "sent-old")).toEqual([
        "sent",
      ]);
      expect(mailboxesFor(database, secondGeneration, "sent-new")).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    reopened.close();
  });

  it("rehydrates a same-generation snapshot after an old v1 cursor advance", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 1000);
    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation,
      expectedPageToken: null,
      threads: [threadFixture("sent-old", 1100, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: null,
    });
    fixture.cache.markPostCrawlHistoryObserved("sent");
    fixture.cache.completeMailboxHydration({
      mailboxId: "sent",
      generation,
      expectedHistoryId: "100",
      now: 1200,
    });
    fixture.cache.close();

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE sync_state
              SET history_id = '150', status = 'idle', page_token = NULL,
                  last_successful_at = 1500
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
    });
    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.beginOrResumeMailboxHydration("sent")).toMatchObject({
      activeGeneration: 0,
      stagedGeneration: generation,
      hydrationObservedHistoryId: "150",
      status: "syncing",
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, generation, "sent-old")).toEqual([]);
    });
    reopened.putMailboxHydrationPage({
      mailboxId: "sent",
      generation,
      expectedPageToken: null,
      threads: [threadFixture("sent-new", 1600, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: null,
    });
    expect(reopened.markPostCrawlHistoryObserved("sent")).toBe(true);
    reopened.completeMailboxHydration({
      mailboxId: "sent",
      generation,
      expectedHistoryId: "150",
      now: 1700,
    });
    expect(
      reopened
        .readMailboxHydrationStates()
        .find((state) => state.mailboxId === "sent"),
    ).toMatchObject({
      activeGeneration: generation,
      stagedGeneration: null,
      activeObservedHistoryId: "150",
      status: "idle",
    });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(mailboxesFor(database, generation, "sent-new")).toEqual(["sent"]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    reopened.close();
  });

  it("reports unavailable instead of exposing an uninitialized or staged mailbox", async () => {
    const fixture = await createCache();
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "inbox", limit: 10 }),
    ).toMatchObject({
      mailboxId: "inbox",
      items: [],
      nextCursor: null,
      availability: {
        status: "unavailable",
        reason: "mailbox_uninitialized",
        windowTruncated: null,
      },
    });

    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("inbox-a", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2000);
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "inbox", limit: 10 }),
    ).toMatchObject({
      items: [expect.objectContaining({ threadId: "inbox-a" })],
      availability: {
        status: "available",
        activeGeneration: generation,
        observedHistoryId: "100",
        windowTruncated: false,
      },
    });

    fixture.cache.beginOrResumeMailboxHydration("sent");
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation,
      expectedPageToken: null,
      threads: [threadFixture("sent-partial", 3000, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: "sent-page-two",
    });
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "sent", limit: 10 }),
    ).toMatchObject({
      items: [],
      nextCursor: null,
      availability: {
        status: "unavailable",
        reason: "mailbox_syncing",
        windowTruncated: null,
      },
    });
    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((thread) => thread.threadId),
    ).toEqual(["inbox-a"]);
    fixture.cache.close();
  });

  it.each(["sent", "spam", "trash"] as const)(
    "reads a published %s-only thread without widening legacy Inbox detail",
    async (mailboxId) => {
      const fixture = await createCache();
      const generation = fixture.cache.beginInitial("100");
      fixture.cache.putInitialPage(generation, [], null, null);
      fixture.cache.completeInitial(generation, 1000);
      publishMailbox(
        fixture.cache,
        mailboxId,
        generation,
        "100",
        [threadFixture(`${mailboxId}-only`, 1100, [mailboxId])],
        1200,
      );

      expect(
        fixture.cache.getMailboxThread({
          mailboxId,
          threadId: `${mailboxId}-only`,
        }),
      ).toMatchObject({
        thread: { threadId: `${mailboxId}-only` },
        messages: [
          {
            messageId: `message-${mailboxId}-only`,
            textBody: `Body ${mailboxId}-only`,
          },
        ],
      });
      expect(fixture.cache.getThread(`${mailboxId}-only`)).toBeNull();
      fixture.cache.close();
    },
  );

  it("requires active membership in the requested mailbox", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 1000);
    publishMailbox(
      fixture.cache,
      "sent",
      generation,
      "100",
      [threadFixture("sent-only", 1100, ["sent"])],
      1200,
    );
    publishMailbox(fixture.cache, "spam", generation, "100", [], 1300);

    const result = fixture.cache.getMailboxThread({
      mailboxId: "spam",
      threadId: "sent-only",
    });
    expect(result).toBeNull();
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "spam", limit: 10 }).items,
    ).toEqual([]);
    fixture.cache.close();
  });

  it("uses the same fail-closed mailbox gate for staged and stale snapshots", async () => {
    const fixture = await createCache();
    const firstGeneration = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(firstGeneration, [], null, null);
    fixture.cache.completeInitial(firstGeneration, 1000);
    publishMailbox(
      fixture.cache,
      "sent",
      firstGeneration,
      "100",
      [threadFixture("sent-old", 1100, ["sent"])],
      1200,
    );

    const rebuildGeneration = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(
      rebuildGeneration,
      [threadFixture("inbox-partial", 2000)],
      null,
      "inbox-page-two",
    );
    expect(() =>
      fixture.cache.getMailboxThread({
        mailboxId: "sent",
        threadId: "sent-old",
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "sent", limit: 10 })
        .availability,
    ).toMatchObject({ status: "unavailable", reason: "global_syncing" });
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE sync_state
              SET staged_generation = NULL, initial_anchor_history_id = NULL,
                  page_token = NULL, status = 'idle', history_id = '150'
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
    });
    expect(() =>
      reopened.getMailboxThread({
        mailboxId: "sent",
        threadId: "sent-old",
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    expect(
      reopened.listMailboxThreads({ mailboxId: "sent", limit: 10 }).availability,
    ).toMatchObject({ status: "unavailable", reason: "history_mismatch" });
    reopened.close();
  });

  it("withholds every published mailbox while the global Inbox rebuild is staged", async () => {
    const fixture = await createCache();
    const firstGeneration = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      firstGeneration,
      [threadFixture("inbox-old", 1000)],
      null,
      null,
    );
    fixture.cache.completeInitial(firstGeneration, 1500);
    publishMailbox(
      fixture.cache,
      "sent",
      firstGeneration,
      "100",
      [threadFixture("sent-old", 1200, ["all", "sent"])],
      1600,
    );

    const rebuildGeneration = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(
      rebuildGeneration,
      [threadFixture("inbox-new-partial", 2000)],
      null,
      "inbox-page-two",
    );
    for (const mailboxId of ["inbox", "sent"] as const) {
      expect(
        fixture.cache.listMailboxThreads({ mailboxId, limit: 10 }),
      ).toMatchObject({
        items: [],
        nextCursor: null,
        availability: {
          status: "unavailable",
          reason: "global_syncing",
          windowTruncated: null,
        },
      });
    }
    // Backward-compatible Inbox reads retain their established old-generation
    // behavior; only the new strict mailbox reader withholds staged data.
    expect(
      fixture.cache.listThreads({ limit: 10 }).items.map((thread) => thread.threadId),
    ).toEqual(["inbox-old"]);
    fixture.cache.close();
  });

  it("withholds an old active snapshot while its replacement is staged", async () => {
    const fixture = await createCache();
    const firstGeneration = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(firstGeneration, [], null, null);
    fixture.cache.completeInitial(firstGeneration, 1000);
    publishMailbox(
      fixture.cache,
      "sent",
      firstGeneration,
      "100",
      [threadFixture("sent-old", 1100, ["all", "sent"])],
      1200,
    );

    const secondGeneration = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(secondGeneration, [], null, null);
    fixture.cache.completeInitial(secondGeneration, 2000);
    expect(fixture.cache.beginOrResumeMailboxHydration("sent")).toMatchObject({
      activeGeneration: firstGeneration,
      stagedGeneration: secondGeneration,
      status: "syncing",
    });
    fixture.cache.putMailboxHydrationPage({
      mailboxId: "sent",
      generation: secondGeneration,
      expectedPageToken: null,
      threads: [threadFixture("sent-new-partial", 2100, ["all", "sent"])],
      listedCount: 1,
      nextPageToken: "sent-page-two",
    });

    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "sent", limit: 10 }),
    ).toMatchObject({
      items: [],
      nextCursor: null,
      availability: {
        status: "unavailable",
        reason: "mailbox_syncing",
        windowTruncated: null,
      },
    });
    expect(() =>
      fixture.cache.getMailboxThread({
        mailboxId: "sent",
        threadId: "sent-old",
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    fixture.cache.close();
  });

  it("reports history mismatch and published mailbox failure states explicitly", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, [], null, null);
    fixture.cache.completeInitial(generation, 1000);
    publishMailbox(
      fixture.cache,
      "sent",
      generation,
      "100",
      [threadFixture("sent-a", 1100, ["all", "sent"])],
      1200,
    );
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "sent", limit: 10 }),
    ).toMatchObject({
      items: [expect.objectContaining({ threadId: "sent-a" })],
      availability: {
        status: "available",
        observedHistoryId: "100",
        windowTruncated: false,
      },
    });

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE sync_state
              SET history_id = '150', status = 'idle', page_token = NULL,
                  last_successful_at = 1500
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
    });
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "sent", limit: 10 }),
    ).toMatchObject({
      items: [],
      availability: {
        status: "unavailable",
        reason: "history_mismatch",
        windowTruncated: null,
      },
    });

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE sync_state
              SET history_id = '100', status = 'idle', last_successful_at = 1600
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
    });
    fixture.cache.markBackoff("gmail_rate_limited");
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "sent", limit: 10 }),
    ).toMatchObject({
      availability: {
        status: "unavailable",
        reason: "mailbox_backoff",
      },
    });
    expect(() =>
      fixture.cache.getMailboxThread({
        mailboxId: "sent",
        threadId: "sent-a",
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    fixture.cache.markReauthRequired("gmail_reauth_required");
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "sent", limit: 10 }),
    ).toMatchObject({
      availability: {
        status: "unavailable",
        reason: "mailbox_reauth_required",
      },
    });
    expect(() =>
      fixture.cache.getMailboxThread({
        mailboxId: "sent",
        threadId: "sent-a",
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    fixture.cache.close();
  });

  it("paginates only a published truncated snapshot with snapshot-bound cursors", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("inbox-a", 500)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 1000);
    fixture.cache.beginOrResumeMailboxHydration("all");
    let expectedPageToken: string | null = null;
    for (let page = 1; page <= 10; page += 1) {
      const nextPageToken =
        page === 10 ? "provider-has-more" : `all-page-${page + 1}`;
      fixture.cache.putMailboxHydrationPage({
        mailboxId: "all",
        generation,
        expectedPageToken,
        threads:
          page === 1
            ? [
                threadFixture("all-a", 3000, ["all"]),
                threadFixture("all-b", 2000, ["all"]),
                threadFixture("all-c", 1000, ["all"]),
              ]
            : [],
        listedCount: 20,
        nextPageToken,
      });
      expectedPageToken = nextPageToken;
    }
    expect(fixture.cache.markPostCrawlHistoryObserved("all")).toBe(true);
    fixture.cache.completeMailboxHydration({
      mailboxId: "all",
      generation,
      expectedHistoryId: "100",
      now: 4000,
    });

    const first = fixture.cache.listMailboxThreads({
      mailboxId: "all",
      limit: 2,
    });
    expect(first.items.map((thread) => thread.threadId)).toEqual([
      "all-a",
      "all-b",
    ]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const cursorPayload = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(cursorPayload).toEqual({
      v: 2,
      m: "all",
      s: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      t: 2000,
      i: "all-b",
    });
    expect(cursorPayload).not.toHaveProperty("g");
    expect(cursorPayload).not.toHaveProperty("h");
    expect(cursorPayload).not.toHaveProperty("observedHistoryId");
    expect(first.availability).toEqual({
      status: "available",
      activeGeneration: generation,
      observedHistoryId: "100",
      lastSuccessfulAt: 4000,
      windowTruncated: true,
    });
    expect(
      fixture.cache.listMailboxThreads({
        mailboxId: "all",
        cursor: first.nextCursor!,
        limit: 2,
      }).items.map((thread) => thread.threadId),
    ).toEqual(["all-c"]);
    const tamperedCursor = Buffer.from(
      JSON.stringify({ ...cursorPayload, t: 1999 }),
      "utf8",
    ).toString("base64url");
    expect(() =>
      fixture.cache.listMailboxThreads({
        mailboxId: "all",
        cursor: tamperedCursor,
        limit: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    expect(() =>
      fixture.cache.listMailboxThreads({
        mailboxId: "all",
        cursor: "e30",
        limit: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_request_invalid" }));
    expect(() =>
      fixture.cache.listMailboxThreads({
        mailboxId: "inbox",
        cursor: first.nextCursor!,
        limit: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "150",
      now: 5000,
    });
    expect(() =>
      fixture.cache.listMailboxThreads({
        mailboxId: "all",
        cursor: first.nextCursor!,
        limit: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    for (const limit of [0, 101, 1.5]) {
      expect(() =>
        fixture.cache.listMailboxThreads({ mailboxId: "all", limit }),
      ).toThrowError(expect.objectContaining({ code: "mail_cache_invalid" }));
    }
    fixture.cache.close();
  });

  it("stores the database only below the selected account cache directory", async () => {
    const fixture = await createCache();
    fixture.cache.close();
    const databasePath = path.join(
      fixture.cacheRoot,
      ACCOUNT_ID,
      "messages.sqlite3",
    );
    await expect(readFile(databasePath)).resolves.toBeInstanceOf(Buffer);

    // This is the same account-scoped directory the existing account store
    // atomically renames before local disconnect commits.
    await rm(path.join(fixture.cacheRoot, ACCOUNT_ID), { recursive: true });
    await expect(readFile(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists exponential provider backoff and opens exactly at retryAt", async () => {
    const fixture = await createCache();
    fixture.cache.bindBackgroundSyncCredential(1, 500);
    fixture.cache.recordSyncFailure({
      now: 1_000,
      errorCode: "mail_provider_rate_limited",
      retryAfterMs: null,
    });
    expect(fixture.cache.readBackgroundSyncState()).toMatchObject({
      credentialVersion: 1,
      syncStatus: "backoff",
      failureCount: 1,
      retryAt: 31_000,
    });
    expect(fixture.cache.beginSyncAttempt(30_999)).toEqual({
      allowed: false,
      status: "backoff",
      retryAt: 31_000,
    });
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.readBackgroundSyncState()).toMatchObject({
      failureCount: 1,
      retryAt: 31_000,
    });
    expect(reopened.beginSyncAttempt(31_000)).toEqual({ allowed: true });
    reopened.recordSyncFailure({
      now: 31_000,
      errorCode: "mail_provider_unavailable",
      retryAfterMs: null,
    });
    expect(reopened.readBackgroundSyncState()).toMatchObject({
      failureCount: 2,
      retryAt: 91_000,
    });
    reopened.beginSyncAttempt(91_000);
    reopened.recordSyncSuccess();
    expect(reopened.readBackgroundSyncState()).toMatchObject({
      syncStatus: "idle",
      failureCount: 0,
      retryAt: null,
    });
    reopened.close();
  });

  it("drops an IMAP snapshot when the persisted transport binding changes", async () => {
    const fixture = await createCache();
    expect(
      fixture.cache.bindProviderCacheIdentity({
        providerKind: "imap",
        transportBindingVersion: 1,
      }),
    ).toEqual({ reset: false });
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("old-mailbox-thread", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(
      reopened.bindProviderCacheIdentity({
        providerKind: "imap",
        transportBindingVersion: 2,
      }),
    ).toEqual({ reset: true });
    expect(reopened.readSyncState()).toMatchObject({
      activeGeneration: 0,
      stagedGeneration: null,
      historyId: null,
      status: "idle",
    });
    expect(reopened.listThreads({ limit: 10 }).items).toEqual([]);
    reopened.close();
  });

  it("fails closed when a rollback runtime rebinds an IMAP credential", async () => {
    const fixture = await createCache();
    fixture.cache.bindProviderCacheIdentity({
      providerKind: "imap",
      transportBindingVersion: 1,
    });
    fixture.cache.bindBackgroundSyncCredential(1, 500);
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("old-rollback-mailbox-thread", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      // Simulate the previous runtime, which rotates only the legacy
      // credential binding and does not know provider_cache_binding.
      database
        .prepare(
          `UPDATE background_sync_control
              SET credential_version = 2
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
      expect(
        database
          .prepare(
            `SELECT active_generation, staged_generation, history_id, status
               FROM sync_state
              WHERE account_id = ?`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({
        active_generation: 0,
        staged_generation: null,
        history_id: null,
        status: "idle",
      });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM threads WHERE account_id = ?")
          .get(ACCOUNT_ID)?.count,
      ).toBe(0);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM mailbox_sync_state WHERE account_id = ?",
          )
          .get(ACCOUNT_ID)?.count,
      ).toBe(6);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM provider_cache_binding WHERE account_id = ?",
          )
          .get(ACCOUNT_ID)?.count,
      ).toBe(0);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.listThreads({ limit: 10 }).items).toEqual([]);
    expect(reopened.readSyncState()).toMatchObject({
      activeGeneration: 0,
      stagedGeneration: null,
      historyId: null,
      status: "idle",
    });
    expect(reopened.readBackgroundSyncState()).toMatchObject({
      credentialVersion: 2,
      failureCount: 0,
      retryAt: null,
    });
    expect(
      reopened.bindProviderCacheIdentity({
        providerKind: "imap",
        transportBindingVersion: 2,
      }),
    ).toEqual({ reset: false });
    reopened.close();
  });

  it("preserves a pre-binding Gmail snapshot during the additive migration", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("gmail-thread", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(
      reopened.bindProviderCacheIdentity({
        providerKind: "gmail",
        transportBindingVersion: null,
      }),
    ).toEqual({ reset: false });
    expect(
      reopened.listThreads({ limit: 10 }).items.map((thread) => thread.threadId),
    ).toEqual(["gmail-thread"]);
    reopened.close();

    const restarted = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await restarted.initialize();
    expect(
      restarted.bindProviderCacheIdentity({
        providerKind: "gmail",
        transportBindingVersion: null,
      }),
    ).toEqual({ reset: false });
    expect(
      restarted.listThreads({ limit: 10 }).items.map((thread) => thread.threadId),
    ).toEqual(["gmail-thread"]);
    restarted.close();
  });

  it("reports hidden mailbox failures and the oldest complete sync", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-health", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 10_000);
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = '100', initial_anchor_history_id = NULL,
                  page_token = NULL, status = 'idle', last_successful_at = 9_000,
                  last_error_code = NULL
            WHERE account_id = ? AND mailbox_id <> 'inbox'`,
        )
        .run(generation, ACCOUNT_ID);
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET status = 'backoff', last_successful_at = 8_000,
                  last_error_code = 'mail_provider_rate_limited'
            WHERE account_id = ? AND mailbox_id = 'spam'`,
        )
        .run(ACCOUNT_ID);
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET status = 'reauth_required',
                  last_error_code = 'mail_provider_reauth_required'
            WHERE account_id = ? AND mailbox_id = 'starred'`,
        )
        .run(ACCOUNT_ID);
    });

    expect(fixture.cache.readBackgroundSyncHealth()).toEqual({
      lastSuccessfulAt: 8_000,
      lastErrorCode: "mail_provider_reauth_required",
    });
    fixture.cache.close();
  });

  it("keeps the Inbox success age before hidden mailboxes hydrate", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-health-inbox", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 10_000);

    expect(fixture.cache.readBackgroundSyncHealth()).toEqual({
      lastSuccessfulAt: 10_000,
      lastErrorCode: null,
    });
    fixture.cache.close();
  });

  it("fails closed when hidden mailbox health rows are missing or malformed", async () => {
    const missing = await createCache();
    withDatabase(cacheDatabasePath(missing.cacheRoot), (database) => {
      database
        .prepare(
          "DELETE FROM mailbox_sync_state WHERE account_id = ? AND mailbox_id = 'spam'",
        )
        .run(ACCOUNT_ID);
    });
    expect(() => missing.cache.readBackgroundSyncHealth()).toThrow(
      new MailCacheError("mail_cache_invalid"),
    );
    missing.cache.close();

    const malformed = await createCache();
    withDatabase(cacheDatabasePath(malformed.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET last_error_code = 'provider-error'
            WHERE account_id = ? AND mailbox_id = 'spam'`,
        )
        .run(ACCOUNT_ID);
    });
    expect(() => malformed.cache.readBackgroundSyncHealth()).toThrow(
      new MailCacheError("mail_cache_invalid"),
    );
    malformed.cache.close();
  });

  it("keeps reauth parked until a newer credential version resumes the staged page", async () => {
    const fixture = await createCache();
    fixture.cache.bindBackgroundSyncCredential(1, 500);
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1000)],
      null,
      "page-two",
    );
    fixture.cache.markReauthRequired("gmail_reauth_required");
    expect(fixture.cache.beginSyncAttempt(2_000)).toEqual({
      allowed: false,
      status: "reauth_required",
      retryAt: null,
    });
    fixture.cache.bindBackgroundSyncCredential(1, 2_000);
    expect(fixture.cache.beginSyncAttempt(2_001)).toEqual({
      allowed: false,
      status: "reauth_required",
      retryAt: null,
    });

    fixture.cache.bindBackgroundSyncCredential(2, 3_000);
    expect(fixture.cache.readSyncState()).toMatchObject({
      stagedGeneration: generation,
      pageToken: "page-two",
      status: "syncing",
    });
    expect(fixture.cache.readBackgroundSyncState()).toMatchObject({
      credentialVersion: 2,
      failureCount: 0,
      retryAt: null,
      lastErrorCode: null,
    });
    expect(fixture.cache.beginSyncAttempt(3_000)).toEqual({ allowed: true });
    fixture.cache.close();
  });

  it("migrates a v1 backoff cache without bumping user_version", async () => {
    const fixture = await createCache();
    fixture.cache.close();
    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database.exec("DROP TABLE background_sync_control");
      database
        .prepare(
          `UPDATE sync_state
              SET status = 'backoff', last_error_code = 'mail_provider_unavailable'
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
    });
    const before = Date.now();
    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    reopened.bindBackgroundSyncCredential(7, before);
    const state = reopened.readBackgroundSyncState();
    expect(state).toMatchObject({
      credentialVersion: 7,
      syncStatus: "backoff",
      failureCount: 1,
    });
    expect(state.retryAt).toBeGreaterThanOrEqual(before + 30_000);
    withDatabase(databasePath, (database) => {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    });
    reopened.close();
  });

  it("searches cached headers and previews with safe AND-prefix terms and mailbox isolation", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [
        searchThreadFixture("subject-hit", 4_000, {
          subject: "Quarterly launch review",
          snippet: "ordinary preview",
        }),
        searchThreadFixture("preview-hit", 3_000, {
          subject: "Weekly note",
          snippet: "Quarterly launch details",
        }),
        searchThreadFixture("sent-only", 2_000, {
          subject: "Quarterly launch sent",
          mailboxes: ["all", "sent"],
        }),
        searchThreadFixture("wrong-second-term", 1_000, {
          subject: "Quarterly planning",
        }),
      ],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 5_000);

    const page = fixture.cache.searchThreads({
      mailboxId: "inbox",
      query: "QUART lau!!!",
      limit: 20,
    });
    expect(page).toMatchObject({
      mailboxId: "inbox",
      scope: "headers_and_previews",
      indexStatus: "ready",
      nextCursor: null,
      resultsTruncated: false,
    });
    expect(page.items.map((item) => item.threadId)).toEqual([
      "subject-hit",
      "preview-hit",
    ]);
    expect(
      fixture.cache.searchThreads({
        mailboxId: "inbox",
        query: "name address",
        limit: 20,
      }).items,
    ).toEqual([]);
    publishMailbox(
      fixture.cache,
      "all",
      generation,
      "100",
      [
        searchThreadFixture("subject-hit", 4_000, {
          subject: "Quarterly launch review",
          snippet: "ordinary preview",
        }),
      ],
      6_000,
    );
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE mailbox_snapshot_metadata SET window_truncated = 1
            WHERE account_id = ? AND mailbox_id = 'all'`,
        )
        .run(ACCOUNT_ID);
    });
    expect(
      fixture.cache.searchThreads({
        mailboxId: "all",
        query: "quarterly",
        limit: 20,
      }).resultsTruncated,
    ).toBe(true);
    fixture.cache.close();
  });

  it("invalidates search cursors after query changes and same-generation replacement", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [
        searchThreadFixture("alpha-a", 3_000, { subject: "Alpha project" }),
        searchThreadFixture("alpha-b", 2_000, { subject: "Alpha project" }),
        searchThreadFixture("alpha-c", 1_000, { subject: "Alpha project" }),
      ],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 4_000);
    publishMailbox(
      fixture.cache,
      "sent",
      generation,
      "100",
      [
        searchThreadFixture("alpha-a", 3_000, {
          subject: "Alpha project",
          mailboxes: ["all", "inbox", "sent"],
        }),
        searchThreadFixture("alpha-b", 2_000, {
          subject: "Alpha project",
          mailboxes: ["all", "inbox", "sent"],
        }),
        searchThreadFixture("alpha-c", 1_000, {
          subject: "Alpha project",
          mailboxes: ["all", "inbox", "sent"],
        }),
      ],
      4_500,
    );
    const first = fixture.cache.searchThreads({
      mailboxId: "inbox",
      query: "alpha",
      limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();
    const terminalOffsetCursor = Buffer.from(
      JSON.stringify({ v: 1, f: "a".repeat(43), o: 500 }),
      "utf8",
    ).toString("base64url");
    for (const cursor of ["e30", "A", terminalOffsetCursor]) {
      expect(() =>
        fixture.cache.searchThreads({
          mailboxId: "inbox",
          query: "alpha",
          cursor,
          limit: 1,
        }),
      ).toThrowError(expect.objectContaining({ code: "mail_request_invalid" }));
    }
    expect(() =>
      fixture.cache.searchThreads({
        mailboxId: "sent",
        query: "alpha",
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).toThrow("mail_sync_stale");
    expect(() =>
      fixture.cache.searchThreads({
        mailboxId: "inbox",
        query: "project",
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).toThrow("mail_sync_stale");

    fixture.cache.replaceActiveThread(
      searchThreadFixture("alpha-c", 5_000, { subject: "Alpha refreshed" }),
    );
    expect(() =>
      fixture.cache.searchThreads({
        mailboxId: "inbox",
        query: "alpha",
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).toThrow("mail_sync_stale");

    const refreshed = fixture.cache.searchThreads({
      mailboxId: "inbox",
      query: "alpha",
      limit: 1,
    });
    expect(refreshed.nextCursor).not.toBeNull();
    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "101",
      now: 6_000,
    });
    expect(() =>
      fixture.cache.searchThreads({
        mailboxId: "inbox",
        query: "alpha",
        cursor: refreshed.nextCursor,
        limit: 1,
      }),
    ).toThrow("mail_sync_stale");
    fixture.cache.close();
  });

  it("keeps backfill and result windows bounded and reports partial results honestly", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      Array.from({ length: 502 }, (_, index) =>
        searchThreadFixture(`bounded-${String(index).padStart(3, "0")}`, index, {
          subject: "Bounded common match",
        }),
      ),
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 6_000);

    const building = fixture.cache.searchThreads({
      mailboxId: "inbox",
      query: "bounded",
      limit: 100,
    });
    expect(building).toMatchObject({
      indexStatus: "building",
      nextCursor: null,
      resultsTruncated: true,
    });
    expect(building.items.length).toBe(100);

    let page = fixture.cache.searchThreads({
      mailboxId: "inbox",
      query: "bounded",
      limit: 100,
    });
    expect(page).toMatchObject({ indexStatus: "ready", resultsTruncated: true });
    let returned = page.items.length;
    while (page.nextCursor !== null) {
      page = fixture.cache.searchThreads({
        mailboxId: "inbox",
        query: "bounded",
        cursor: page.nextCursor,
        limit: 100,
      });
      returned += page.items.length;
    }
    expect(returned).toBe(500);
    expect(page.resultsTruncated).toBe(true);
    fixture.cache.close();
  });

  it("rebuilds stale search data after an older runtime changes cached headers", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [searchThreadFixture("rollback-row", 1_000, { subject: "Before rollback" })],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    expect(
      fixture.cache.searchThreads({
        mailboxId: "inbox",
        query: "before",
        limit: 10,
      }).items,
    ).toHaveLength(1);
    fixture.cache.close();

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database
        .prepare(
          `UPDATE threads SET subject = 'After rollback'
            WHERE account_id = ? AND generation = ? AND thread_id = ?`,
        )
        .run(ACCOUNT_ID, generation, "rollback-row");
    });
    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(
      reopened.searchThreads({
        mailboxId: "inbox",
        query: "before",
        limit: 10,
      }).items,
    ).toEqual([]);
    expect(
      reopened.searchThreads({
        mailboxId: "inbox",
        query: "after",
        limit: 10,
      }).items.map((item) => item.threadId),
    ).toEqual(["rollback-row"]);
    reopened.close();
  });

  it("rolls back a same-generation header update when search revision persistence fails", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [searchThreadFixture("atomic-row", 1_000, { subject: "Stable header" })],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.searchThreads({ mailboxId: "inbox", query: "stable", limit: 10 });
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database.exec(`
        CREATE TRIGGER fail_search_revision
        BEFORE UPDATE OF revision ON mail_search_state
        BEGIN
          SELECT RAISE(ABORT, 'search revision failed');
        END;
      `);
    });

    expect(() =>
      fixture.cache.replaceActiveThread(
        searchThreadFixture("atomic-row", 3_000, { subject: "Broken header" }),
      ),
    ).toThrow();
    expect(
      fixture.cache.searchThreads({
        mailboxId: "inbox",
        query: "stable",
        limit: 10,
      }).items.map((item) => item.threadId),
    ).toEqual(["atomic-row"]);
    expect(
      fixture.cache.searchThreads({
        mailboxId: "inbox",
        query: "broken",
        limit: 10,
      }).items,
    ).toEqual([]);
    fixture.cache.close();
  });

  it("accepts an older rollback runtime's successful sync on roll-forward", async () => {
    const fixture = await createCache();
    fixture.cache.recordSyncFailure({
      now: 1_000,
      errorCode: "mail_provider_unavailable",
      retryAfterMs: null,
    });
    fixture.cache.close();
    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      // Simulate the previous runtime, which knows sync_state but not the
      // additive background_sync_control table.
      database
        .prepare(
          `UPDATE sync_state
              SET status = 'idle', last_error_code = NULL
            WHERE account_id = ?`,
        )
        .run(ACCOUNT_ID);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.readBackgroundSyncState()).toMatchObject({
      syncStatus: "idle",
      failureCount: 0,
      retryAt: null,
      lastErrorCode: null,
    });
    expect(reopened.beginSyncAttempt(2_000)).toEqual({ allowed: true });
    reopened.close();
  });

  it("creates new cache databases with incremental auto_vacuum", async () => {
    const fixture = await createCache();
    fixture.cache.close();
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(database.prepare("PRAGMA auto_vacuum").get()).toEqual({
        auto_vacuum: 2,
      });
    });
  });

  it("keeps admission open when reclaimable freelist pages inflate the file", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, bulkThreadFixtures(), null, null);
    fixture.cache.completeInitial(generation, 2_000);

    // With every bulk page still live, the huge write must be refused.
    const hugeThread = threadWithBody(
      "thread-huge",
      9_000,
      255 * 1024 * 1024,
    );
    expect(() =>
      fixture.cache.putInitialPage(999, [hugeThread], null, null),
    ).toThrowError(expect.objectContaining({ code: "mail_cache_capacity" }));
    fixture.cache.close();

    // Free the bulk pages without vacuuming, so the file keeps its high-water
    // page count while nearly all of it sits on the freelist.
    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database.exec("DELETE FROM messages");
      database.exec("DELETE FROM threads");
      const pageSize = database.prepare("PRAGMA page_size").get()
        ?.page_size as number;
      const pageCount = database.prepare("PRAGMA page_count").get()
        ?.page_count as number;
      const freelistCount = database.prepare("PRAGMA freelist_count").get()
        ?.freelist_count as number;
      expect(pageCount * pageSize).toBeGreaterThan(5 * 1024 * 1024);
      expect(freelistCount * pageSize).toBeGreaterThan(4 * 1024 * 1024);
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    // Same file size, same huge write. Admission now passes, so the stale
    // generation is the first check to reject.
    expect(() =>
      reopened.putInitialPage(999, [hugeThread], null, null),
    ).toThrowError(expect.objectContaining({ code: "mail_sync_stale" }));
    reopened.close();
  });

  it("returns generation-cleanup space to the filesystem", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, bulkThreadFixtures(), null, null);
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();
    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    let bulkPageCount = 0;
    withDatabase(databasePath, (database) => {
      bulkPageCount = database.prepare("PRAGMA page_count").get()
        ?.page_count as number;
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    const next = reopened.beginInitial("200");
    reopened.putInitialPage(next, [threadFixture("thread-small", 3_000)], null, null);
    reopened.completeInitial(next, 4_000);
    reopened.close();

    withDatabase(databasePath, (database) => {
      const pageCount = database.prepare("PRAGMA page_count").get()
        ?.page_count as number;
      expect(database.prepare("PRAGMA freelist_count").get()).toEqual({
        freelist_count: 0,
      });
      expect(pageCount).toBeLessThan(bulkPageCount / 4);
    });
  });

  it("leaves a database created without auto_vacuum untouched", async () => {
    const fixture = await createCache();
    fixture.cache.close();
    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database.exec("PRAGMA auto_vacuum = NONE");
      database.exec("VACUUM");
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    const generation = reopened.beginInitial("100");
    reopened.putInitialPage(generation, [threadFixture("thread-a", 1_000)], null, null);
    reopened.completeInitial(generation, 2_000);
    reopened.close();
    withDatabase(databasePath, (database) => {
      expect(database.prepare("PRAGMA auto_vacuum").get()).toEqual({
        auto_vacuum: 0,
      });
    });
  });

  it("ranks mail_cache_capacity above transient provider errors", () => {
    expect(
      selectWorstMailSyncError([
        "mail_provider_rate_limited",
        "mail_cache_capacity",
        "mail_provider_unavailable",
      ]),
    ).toBe("mail_cache_capacity");
    expect(
      selectWorstMailSyncError(["mail_cache_capacity", "gmail_reauth_required"]),
    ).toBe("gmail_reauth_required");
    expect(
      selectWorstMailSyncError(["some_unknown_error", "mail_cache_capacity"]),
    ).toBe("mail_cache_capacity");
  });

  it("names a capacity-stalled sync instead of a generic retry", async () => {
    const fixture = await createCache();
    fixture.cache.recordSyncFailure({
      now: 1_000,
      errorCode: "mail_provider_unavailable",
      retryAfterMs: null,
    });
    expect(fixture.cache.listThreads({ limit: 10 }).sync.status).toBe("backoff");
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "inbox", limit: 10 })
        .availability,
    ).toMatchObject({ status: "unavailable", reason: "mailbox_backoff" });

    fixture.cache.recordSyncFailure({
      now: 2_000,
      errorCode: "mail_cache_capacity",
      retryAfterMs: null,
    });
    expect(fixture.cache.listThreads({ limit: 10 }).sync.status).toBe(
      "cache_full",
    );
    expect(
      fixture.cache.listMailboxThreads({ mailboxId: "inbox", limit: 10 })
        .availability,
    ).toMatchObject({
      status: "unavailable",
      reason: "mailbox_cache_capacity",
    });
    fixture.cache.close();
  });
});

describe("smart views and thread-list sorting", () => {
  it("adds the view columns to a pre-view cache and heals a partial upgrade", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-view", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      database.exec("ALTER TABLE threads DROP COLUMN list_message");
      database.exec("ALTER TABLE threads DROP COLUMN size_bytes");
      database.exec("ALTER TABLE threads DROP COLUMN sort_sender");
    });

    const upgraded = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await upgraded.initialize();
    upgraded.close();
    withDatabase(databasePath, (database) => {
      expect(
        database
          .prepare(
            `SELECT list_message, size_bytes, sort_sender
               FROM threads WHERE account_id = ?`,
          )
          .get(ACCOUNT_ID),
      ).toEqual({ list_message: 0, size_bytes: 0, sort_sender: "sender" });
      // A partially applied upgrade heals column by column.
      database.exec("ALTER TABLE threads DROP COLUMN size_bytes");
    });
    const healed = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await healed.initialize();
    healed.close();

    // The upgraded threads table matches a fresh one column for column. Only
    // the physical order may differ after an out-of-order heal, so the
    // comparison sorts by name.
    const fresh = await createCache();
    fresh.cache.close();
    const columnsOf = (path: string) => {
      let columns: unknown;
      withDatabase(path, (database) => {
        columns = database
          .prepare("PRAGMA table_info(threads)")
          .all()
          .map((column) => ({
            name: column.name,
            type: column.type,
            notnull: column.notnull,
            dflt_value: column.dflt_value,
          }))
          .sort((left, right) =>
            String(left.name).localeCompare(String(right.name)),
          );
      });
      return columns;
    };
    expect(columnsOf(databasePath)).toEqual(
      columnsOf(cacheDatabasePath(fresh.cacheRoot)),
    );
  });

  it("persists and updates the three view columns through upsert", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [
        viewThreadFixture("thread-list", {
          sentAt: 1_000,
          unread: true,
          hasAttachments: false,
          listMessage: true,
          sizeEstimate: 4_096,
          senderName: "Ada Lovelace",
        }),
      ],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    const read = (field: string) => {
      let value: unknown;
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        value = database
          .prepare(
            `SELECT list_message, size_bytes, sort_sender
               FROM threads WHERE account_id = ? AND thread_id = ?`,
          )
          .get(ACCOUNT_ID, "thread-list")?.[field];
      });
      return value;
    };
    expect(read("list_message")).toBe(1);
    expect(read("size_bytes")).toBe(4_096);
    expect(read("sort_sender")).toBe("ada lovelace");
    expect(fixture.cache.listThreads({ limit: 10 }).items[0]).toMatchObject({
      listMessage: true,
      sizeBytes: 4_096,
    });
    expect(fixture.cache.getThread("thread-list")?.thread).toMatchObject({
      listMessage: true,
      sizeBytes: 4_096,
    });

    fixture.cache.replaceActiveThread(
      viewThreadFixture("thread-list", {
        sentAt: 1_500,
        unread: true,
        hasAttachments: false,
        listMessage: false,
        sizeEstimate: null,
        senderName: null,
        senderAddress: "other@example.test",
      }),
    );
    expect(read("list_message")).toBe(0);
    expect(read("size_bytes")).toBe(0);
    expect(read("sort_sender")).toBe("other@example.test");
    fixture.cache.close();
  });

  it("normalizes the sender sort key deterministically", async () => {
    const cases: ReadonlyArray<{
      readonly threadId: string;
      readonly senderName: string | null;
      readonly senderAddress?: string;
      readonly noParticipants?: boolean;
      readonly expected: string;
    }> = [
      // The display name wins over the address when present.
      {
        threadId: "sender-name",
        senderName: "Ada Lovelace",
        expected: "ada lovelace",
      },
      // A missing or blank name falls back to the address.
      {
        threadId: "sender-address",
        senderName: "   ",
        senderAddress: "zed@example.test",
        expected: "zed@example.test",
      },
      // NFKC folds fullwidth compatibility forms before lowercasing.
      { threadId: "sender-nfkc", senderName: "ＫＡＴＥ", expected: "kate" },
      // Leading quote characters and whitespace are stripped.
      {
        threadId: "sender-quoted",
        senderName: '"Bob Craft',
        expected: "bob craft",
      },
      // Control characters are removed.
      {
        threadId: "sender-control",
        senderName: "Bo\u0007b",
        expected: "bob",
      },
      // The key is truncated to 128 characters.
      {
        threadId: "sender-long",
        senderName: "x".repeat(200),
        expected: "x".repeat(128),
      },
      // No participants means an empty key that sorts first.
      {
        threadId: "sender-none",
        senderName: null,
        noParticipants: true,
        expected: "",
      },
    ];
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      cases.map((entry, index) =>
        viewThreadFixture(entry.threadId, {
          sentAt: 1_000 + index,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: entry.senderName,
          ...(entry.senderAddress === undefined
            ? {}
            : { senderAddress: entry.senderAddress }),
          ...(entry.noParticipants === undefined
            ? {}
            : { noParticipants: entry.noParticipants }),
        }),
      ),
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      for (const entry of cases) {
        expect(
          database
            .prepare(
              `SELECT sort_sender FROM threads
                WHERE account_id = ? AND thread_id = ?`,
            )
            .get(ACCOUNT_ID, entry.threadId)?.sort_sender,
        ).toBe(entry.expected);
      }
    });
  });

  it("repairs blank sender keys from cached participants on open", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [
        threadFixture("thread-repair", 1_000),
        viewThreadFixture("thread-empty", {
          sentAt: 900,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: null,
          noParticipants: true,
        }),
      ],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    // A rollback runtime INSERTs rows with the column default.
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database.exec("UPDATE threads SET sort_sender = ''");
    });
    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    reopened.close();
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      expect(
        database
          .prepare(
            `SELECT thread_id, sort_sender FROM threads
              WHERE account_id = ? ORDER BY thread_id ASC`,
          )
          .all(ACCOUNT_ID),
      ).toEqual([
        { thread_id: "thread-empty", sort_sender: "" },
        { thread_id: "thread-repair", sort_sender: "sender" },
      ]);
    });
  });

  it("fills empty thread snippets from the newest message snippet on open", async () => {
    const multiBase = threadFixture("thread-multi", 1_000);
    const older = Object.freeze({
      ...multiBase.messages[0]!,
      messageId: "message-multi-old",
      sentAt: 900,
      snippet: "Older message snippet",
    });
    const newer = Object.freeze({
      ...multiBase.messages[0]!,
      messageId: "message-multi-new",
      sentAt: 1_000,
      snippet: "Newest message snippet",
    });
    const multi = Object.freeze({
      ...multiBase,
      thread: Object.freeze({ ...multiBase.thread, messageCount: 2 }),
      messages: Object.freeze([older, newer]),
    });
    const bareBase = threadFixture("thread-bare", 700);
    const bare = Object.freeze({
      ...bareBase,
      thread: Object.freeze({ ...bareBase.thread, snippet: null }),
      messages: Object.freeze([
        Object.freeze({ ...bareBase.messages[0]!, snippet: null }),
      ]),
    });
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [multi, threadFixture("thread-single", 800), threadFixture("thread-keep", 600), bare],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    // The threads.get field-mask bug left thread snippets NULL; a non-empty
    // snippet must never be overwritten by the repair.
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database.exec("UPDATE threads SET snippet = NULL WHERE thread_id <> 'thread-keep'");
      database.exec("UPDATE threads SET snippet = 'Existing snippet' WHERE thread_id = 'thread-keep'");
    });
    const readSnippets = () => {
      let value: unknown;
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        value = database
          .prepare(
            `SELECT thread_id, snippet FROM threads
              WHERE account_id = ? ORDER BY thread_id ASC`,
          )
          .all(ACCOUNT_ID);
      });
      return value;
    };
    const expected = [
      { thread_id: "thread-bare", snippet: null },
      { thread_id: "thread-keep", snippet: "Existing snippet" },
      { thread_id: "thread-multi", snippet: "Newest message snippet" },
      { thread_id: "thread-single", snippet: "Snippet thread-single" },
    ];
    for (let reopenCount = 0; reopenCount < 2; reopenCount += 1) {
      const reopened = new SqliteMailMessageCache({
        cacheRoot: fixture.cacheRoot,
        accountId: ACCOUNT_ID,
      });
      await reopened.initialize();
      reopened.close();
      expect(readSnippets()).toEqual(expected);
    }
  });

  it("adds the category column to a pre-category cache and defaults it", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-category", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    const databasePath = cacheDatabasePath(fixture.cacheRoot);
    withDatabase(databasePath, (database) => {
      const column = database
        .prepare("PRAGMA table_info(threads)")
        .all()
        .find((entry) => entry.name === "category");
      expect(column).toMatchObject({
        type: "TEXT",
        notnull: 1,
        dflt_value: "'people'",
      });
      database.exec("ALTER TABLE threads DROP COLUMN category");
    });

    const upgraded = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await upgraded.initialize();
    // Pre-upgrade rows read the safe default until a provider rewrite.
    expect(upgraded.listThreads({ limit: 10 }).items[0]?.category).toBe(
      "people",
    );
    upgraded.close();
    withDatabase(databasePath, (database) => {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    });
  });

  it("keeps rows a rollback runtime INSERTed without category readable", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-a", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      // The exact column list a pre-category runtime INSERTs.
      database
        .prepare(
          `INSERT INTO threads(
             account_id, generation, thread_id, subject, participants_json,
             snippet, last_message_at, message_count, unread, starred,
             has_attachments, in_inbox, list_message, size_bytes, sort_sender
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ACCOUNT_ID,
          generation,
          "thread-old-runtime",
          "Old runtime",
          JSON.stringify([{ name: "Sender", address: "sender@example.test" }]),
          null,
          3_000,
          1,
          1,
          0,
          0,
          1,
          0,
          0,
          "sender",
        );
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(reopened.getThread("thread-old-runtime")?.thread.category).toBe(
      "people",
    );
    reopened.close();
  });

  it("round-trips the category through upsert and rejects corrupt values", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [
        viewThreadFixture("thread-newsletter", {
          sentAt: 1_000,
          unread: true,
          hasAttachments: false,
          listMessage: true,
          sizeEstimate: null,
          senderName: "News",
          category: "newsletter",
        }),
      ],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    expect(
      fixture.cache.listThreads({ limit: 10 }).items[0],
    ).toMatchObject({ category: "newsletter", listMessage: true });
    expect(
      fixture.cache.getThread("thread-newsletter")?.thread.category,
    ).toBe("newsletter");

    fixture.cache.replaceActiveThread(
      viewThreadFixture("thread-newsletter", {
        sentAt: 1_500,
        unread: true,
        hasAttachments: false,
        listMessage: true,
        sizeEstimate: null,
        senderName: "News",
        category: "notification",
      }),
    );
    expect(fixture.cache.listThreads({ limit: 10 }).items[0]?.category).toBe(
      "notification",
    );
    fixture.cache.close();

    // A corrupt value written past the CHECK constraint must be rejected on
    // read instead of decoded into a broken item.
    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database.exec("ALTER TABLE threads DROP COLUMN category");
      database.exec(
        "ALTER TABLE threads ADD COLUMN category TEXT NOT NULL DEFAULT 'people'",
      );
      database.exec("UPDATE threads SET category = 'bogus'");
    });
    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    expect(() => reopened.listThreads({ limit: 10 })).toThrow(
      "mail_cache_invalid",
    );
    reopened.close();
  });

  it("pre-seeds notification for automated first participants on open", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [
        // Simulates pre-upgrade rows: automated senders, category default.
        viewThreadFixture("thread-support", {
          sentAt: 6_000,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: "Support",
          senderAddress: "support@example.test",
          category: "people",
        }),
        viewThreadFixture("thread-subdomain", {
          sentAt: 5_000,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: "Developer Relations",
          senderAddress: "developer@email.example.test",
          category: "people",
        }),
        viewThreadFixture("thread-noreply", {
          sentAt: 4_000,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: "Robot",
          senderAddress: "no_reply-billing@service.example.test",
          category: "people",
        }),
        viewThreadFixture("thread-postmaster", {
          sentAt: 3_000,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: null,
          senderAddress: "Postmaster@example.test",
          category: "people",
        }),
        threadFixture("thread-human", 2_000),
        // Excluded local part on a two-label domain: stays people.
        viewThreadFixture("thread-hi", {
          sentAt: 1_500,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: "Studio",
          senderAddress: "hi@studio.example",
          category: "people",
        }),
        viewThreadFixture("thread-hello", {
          sentAt: 1_200,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: "Front Desk",
          senderAddress: "hello@example.test",
          category: "people",
        }),
        viewThreadFixture("thread-digest", {
          sentAt: 1_100,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: "Weekly Digest",
          senderAddress: "person@digest.example.test",
          category: "people",
        }),
        viewThreadFixture("thread-empty", {
          sentAt: 1_000,
          unread: true,
          hasAttachments: false,
          listMessage: false,
          sizeEstimate: null,
          senderName: null,
          noParticipants: true,
          category: "people",
        }),
      ],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    const readAll = () => {
      let rows: unknown;
      withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
        rows = database
          .prepare(
            `SELECT thread_id, category, list_message FROM threads
              WHERE account_id = ? ORDER BY thread_id ASC`,
          )
          .all(ACCOUNT_ID);
      });
      return rows;
    };
    const expected = [
      // list_message follows the repaired category. Never 'newsletter':
      // list headers have no local source.
      { thread_id: "thread-digest", category: "notification", list_message: 1 },
      { thread_id: "thread-empty", category: "people", list_message: 0 },
      { thread_id: "thread-hello", category: "notification", list_message: 1 },
      { thread_id: "thread-hi", category: "people", list_message: 0 },
      { thread_id: "thread-human", category: "people", list_message: 0 },
      { thread_id: "thread-noreply", category: "notification", list_message: 1 },
      {
        thread_id: "thread-postmaster",
        category: "notification",
        list_message: 1,
      },
      {
        thread_id: "thread-subdomain",
        category: "notification",
        list_message: 1,
      },
      { thread_id: "thread-support", category: "notification", list_message: 1 },
    ];

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    reopened.close();
    expect(readAll()).toEqual(expected);

    // Idempotent: a second open changes nothing.
    const again = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await again.initialize();
    expect(again.listThreads({ limit: 10 }).items.map((item) => item.category))
      .toEqual([
        "notification",
        "notification",
        "notification",
        "notification",
        "people",
        "people",
        "notification",
        "notification",
        "people",
      ]);
    again.close();
    expect(readAll()).toEqual(expected);
  });

  it("keeps the default view and sort on the exact v1 and v2 cursor bytes", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [
        threadFixture("thread-a", 3_000),
        threadFixture("thread-b", 2_000),
        threadFixture("thread-c", 1_000),
      ],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);

    const implicit = fixture.cache.listThreads({ limit: 2 });
    const explicit = fixture.cache.listThreads({
      limit: 2,
      view: null,
      sort: "date",
    });
    expect(explicit.nextCursor).toBe(implicit.nextCursor);
    expect(implicit.nextCursor).toBe(
      Buffer.from(
        JSON.stringify({ v: 1, g: generation, t: 2_000, i: "thread-b" }),
        "utf8",
      ).toString("base64url"),
    );
    expect(
      fixture.cache
        .listThreads({
          cursor: implicit.nextCursor!,
          limit: 2,
          view: null,
          sort: "date",
        })
        .items.map((item) => item.threadId),
    ).toEqual(["thread-c"]);

    const implicitMailbox = fixture.cache.listMailboxThreads({
      mailboxId: "inbox",
      limit: 2,
    });
    const explicitMailbox = fixture.cache.listMailboxThreads({
      mailboxId: "inbox",
      limit: 2,
      view: null,
      sort: "date",
    });
    expect(explicitMailbox.nextCursor).toBe(implicitMailbox.nextCursor);
    expect(
      JSON.parse(
        Buffer.from(implicitMailbox.nextCursor!, "base64url").toString("utf8"),
      ),
    ).toMatchObject({ v: 2, m: "inbox", t: 2_000, i: "thread-b" });

    // A default-path cursor never opens a non-default page and vice versa.
    expect(() =>
      fixture.cache.listThreads({
        cursor: implicit.nextCursor!,
        limit: 2,
        sort: "size",
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_request_invalid" }));
    expect(() =>
      fixture.cache.listMailboxThreads({
        mailboxId: "inbox",
        cursor: implicitMailbox.nextCursor!,
        limit: 2,
        view: "lists",
      }),
    ).toThrowError(expect.objectContaining({ code: "mail_request_invalid" }));
    const nonDefault = fixture.cache.listThreads({ limit: 2, sort: "size" });
    expect(() =>
      fixture.cache.listThreads({ cursor: nonDefault.nextCursor!, limit: 2 }),
    ).toThrowError(expect.objectContaining({ code: "mail_cache_invalid" }));
    fixture.cache.close();
  });

  it("orders and paginates every view and sort identically on both paths", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, matrixThreadFixtures(), null, null);
    fixture.cache.completeInitial(generation, 2_000);

    const views = [null, "unread", "attachments", "lists", "people"] as const;
    const sorts = ["date", "unread", "sender", "size"] as const;
    for (const view of views) {
      for (const sort of sorts) {
        const inboxFull = fixture.cache
          .listThreads({ limit: 100, view, sort })
          .items.map((item) => item.threadId);
        const mailboxFull = fixture.cache
          .listMailboxThreads({ mailboxId: "inbox", limit: 100, view, sort })
          .items.map((item) => item.threadId);
        expect(mailboxFull).toEqual(inboxFull);

        const inboxWalk: string[] = [];
        let cursor: string | undefined;
        do {
          const page = fixture.cache.listThreads({
            limit: 2,
            view,
            sort,
            ...(cursor === undefined ? {} : { cursor }),
          });
          inboxWalk.push(...page.items.map((item) => item.threadId));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        expect(inboxWalk).toEqual(inboxFull);

        const mailboxWalk: string[] = [];
        cursor = undefined;
        do {
          const page = fixture.cache.listMailboxThreads({
            mailboxId: "inbox",
            limit: 2,
            view,
            sort,
            ...(cursor === undefined ? {} : { cursor }),
          });
          mailboxWalk.push(...page.items.map((item) => item.threadId));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        expect(mailboxWalk).toEqual(mailboxFull);
      }
    }

    const ids = (view: (typeof views)[number], sort: (typeof sorts)[number]) =>
      fixture.cache
        .listThreads({ limit: 100, view, sort })
        .items.map((item) => item.threadId);
    // Ties on last_message_at break by thread_id DESC; a NULL date sorts last.
    expect(ids(null, "date")).toEqual(["vf", "vb", "va", "vc", "ve", "vd"]);
    // unread DESC first, then the date order inside each group.
    expect(ids(null, "unread")).toEqual(["va", "vc", "ve", "vf", "vb", "vd"]);
    // '' sorts first in ASC; equal senders fall back to the date order.
    expect(ids(null, "sender")).toEqual(["ve", "vf", "vb", "va", "vc", "vd"]);
    // size DESC, ties by date order; missing sizes count as zero.
    expect(ids(null, "size")).toEqual(["va", "vc", "vf", "vb", "ve", "vd"]);
    // Views filter on the rolled-up columns.
    expect(new Set(ids("lists", "date"))).toEqual(new Set(["va", "vd", "vf"]));
    expect(new Set(ids("people", "date"))).toEqual(new Set(["vb", "vc", "ve"]));
    expect(new Set(ids("unread", "date"))).toEqual(new Set(["va", "vc", "ve"]));
    expect(new Set(ids("attachments", "date"))).toEqual(
      new Set(["vb", "vc", "vf"]),
    );
    fixture.cache.close();
  });

  it("rejects a v3 cursor replayed across a view, sort, snapshot, or path switch", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(generation, matrixThreadFixtures(), null, null);
    fixture.cache.completeInitial(generation, 2_000);
    publishMailbox(
      fixture.cache,
      "sent",
      generation,
      "100",
      [threadFixture("sent-a", 1_000, ["sent"])],
      3_000,
    );

    const stale = expect.objectContaining({ code: "mail_sync_stale" });
    const invalid = expect.objectContaining({ code: "mail_request_invalid" });
    const unreadCursor = fixture.cache.listThreads({
      limit: 2,
      sort: "unread",
    }).nextCursor!;
    const senderCursor = fixture.cache.listThreads({
      limit: 2,
      sort: "sender",
    }).nextCursor!;
    const mailboxCursor = fixture.cache.listMailboxThreads({
      mailboxId: "inbox",
      limit: 2,
      sort: "size",
    }).nextCursor!;

    // View switch: the key shape still matches, the fingerprint does not.
    expect(() =>
      fixture.cache.listThreads({
        cursor: unreadCursor,
        limit: 2,
        view: "attachments",
        sort: "unread",
      }),
    ).toThrowError(stale);
    // Sort switch with a compatible key shape (0|1 is a valid size key).
    expect(() =>
      fixture.cache.listThreads({
        cursor: unreadCursor,
        limit: 2,
        sort: "size",
      }),
    ).toThrowError(stale);
    // Sort switch with an incompatible key type fails at decode.
    expect(() =>
      fixture.cache.listThreads({
        cursor: senderCursor,
        limit: 2,
        sort: "size",
      }),
    ).toThrowError(invalid);
    expect(() =>
      fixture.cache.listThreads({
        cursor: mailboxCursor,
        limit: 2,
        sort: "unread",
      }),
    ).toThrowError(invalid);
    // Cross-path replay fails the decoder's mailbox binding shape.
    expect(() =>
      fixture.cache.listMailboxThreads({
        mailboxId: "inbox",
        cursor: unreadCursor,
        limit: 2,
        sort: "unread",
      }),
    ).toThrowError(invalid);
    expect(() =>
      fixture.cache.listThreads({
        cursor: mailboxCursor,
        limit: 2,
        sort: "size",
      }),
    ).toThrowError(invalid);
    // Cross-mailbox replay is stale, matching the v2 precedent.
    expect(() =>
      fixture.cache.listMailboxThreads({
        mailboxId: "sent",
        cursor: mailboxCursor,
        limit: 2,
        sort: "size",
      }),
    ).toThrowError(stale);
    // A tampered position no longer matches the fingerprint.
    const payload = JSON.parse(
      Buffer.from(unreadCursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(() =>
      fixture.cache.listThreads({
        cursor: Buffer.from(
          JSON.stringify({ ...payload, t: 1 }),
          "utf8",
        ).toString("base64url"),
        limit: 2,
        sort: "unread",
      }),
    ).toThrowError(stale);
    // Non-canonical base64 and non-v3 envelopes fail closed at decode.
    expect(() =>
      fixture.cache.listThreads({ cursor: "e3", limit: 2, sort: "unread" }),
    ).toThrowError(invalid);
    expect(() =>
      fixture.cache.listThreads({ cursor: "e30", limit: 2, sort: "unread" }),
    ).toThrowError(invalid);

    // Mailbox History movement invalidates the mailbox-path cursor.
    fixture.cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "150",
      now: 4_000,
    });
    expect(() =>
      fixture.cache.listMailboxThreads({
        mailboxId: "inbox",
        cursor: mailboxCursor,
        limit: 2,
        sort: "size",
      }),
    ).toThrowError(stale);

    // A generation bump invalidates the inbox-path cursor.
    const rebuild = fixture.cache.beginInitial("200");
    fixture.cache.putInitialPage(rebuild, matrixThreadFixtures(), null, null);
    fixture.cache.completeInitial(rebuild, 5_000);
    expect(() =>
      fixture.cache.listThreads({
        cursor: unreadCursor,
        limit: 2,
        sort: "unread",
      }),
    ).toThrowError(stale);
    fixture.cache.close();
  });

  it("answers filtered and sorted pages from 50k threads within budget", async () => {
    const fixture = await createCache();
    const generation = fixture.cache.beginInitial("100");
    fixture.cache.putInitialPage(
      generation,
      [threadFixture("thread-seed", 1_000)],
      null,
      null,
    );
    fixture.cache.completeInitial(generation, 2_000);
    fixture.cache.close();

    withDatabase(cacheDatabasePath(fixture.cacheRoot), (database) => {
      database.exec("BEGIN IMMEDIATE");
      const insertThread = database.prepare(
        `INSERT INTO threads(
           account_id, generation, thread_id, subject, participants_json,
           snippet, last_message_at, message_count, unread, starred,
           has_attachments, in_inbox, list_message, size_bytes, sort_sender
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, 1, ?, ?, ?)`,
      );
      const insertMembership = database.prepare(
        `INSERT INTO thread_mailboxes(account_id, mailbox_id, generation, thread_id)
         VALUES (?, 'inbox', ?, ?)`,
      );
      for (let index = 0; index < 50_000; index += 1) {
        const threadId = `perf-${String(index).padStart(6, "0")}`;
        insertThread.run(
          ACCOUNT_ID,
          generation,
          threadId,
          `Subject ${index}`,
          JSON.stringify([
            { name: null, address: `sender${index % 997}@example.test` },
          ]),
          null,
          1_000_000 + (index % 10_000),
          index % 3 === 0 ? 1 : 0,
          index % 5 === 0 ? 1 : 0,
          index % 2,
          (index * 37) % 100_000,
          `sender${index % 997}@example.test`,
        );
        insertMembership.run(ACCOUNT_ID, generation, threadId);
      }
      database.exec("COMMIT");
    });

    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    await reopened.initialize();
    // Warm the page cache once before timing.
    reopened.listThreads({ limit: 50, sort: "size" });
    for (const request of [
      { limit: 50, view: "unread", sort: "sender" },
      { limit: 50, view: "lists", sort: "size" },
      { limit: 50, view: "people", sort: "unread" },
    ] as const) {
      const startedAt = performance.now();
      const page = reopened.listThreads(request);
      const mailboxPage = reopened.listMailboxThreads({
        mailboxId: "inbox",
        ...request,
      });
      const elapsedMs = performance.now() - startedAt;
      expect(page.items).toHaveLength(50);
      expect(mailboxPage.items).toHaveLength(50);
      expect(elapsedMs).toBeLessThan(750);
    }
    reopened.close();
  });
});

/**
 * Six threads spanning every view and sort dimension: date ties, an absent
 * date, unread and attachment mixes, list and people classification, size
 * ties, an absent size, equal senders, and an empty participant list.
 */
function matrixThreadFixtures(): readonly CachedProviderThread[] {
  return Object.freeze([
    viewThreadFixture("va", {
      sentAt: 5_000,
      unread: true,
      hasAttachments: false,
      listMessage: true,
      sizeEstimate: 300,
      senderName: "Bob",
    }),
    viewThreadFixture("vb", {
      sentAt: 5_000,
      unread: false,
      hasAttachments: true,
      listMessage: false,
      sizeEstimate: 100,
      senderName: "Alice",
    }),
    viewThreadFixture("vc", {
      sentAt: 4_000,
      unread: true,
      hasAttachments: true,
      listMessage: false,
      sizeEstimate: 300,
      senderName: "Bob",
    }),
    viewThreadFixture("vd", {
      sentAt: null,
      unread: false,
      hasAttachments: false,
      listMessage: true,
      sizeEstimate: null,
      senderName: null,
      senderAddress: "zed@example.test",
    }),
    viewThreadFixture("ve", {
      sentAt: 3_000,
      unread: true,
      hasAttachments: false,
      listMessage: false,
      sizeEstimate: 0,
      senderName: null,
      noParticipants: true,
    }),
    viewThreadFixture("vf", {
      sentAt: 6_000,
      unread: false,
      hasAttachments: true,
      listMessage: true,
      sizeEstimate: 100,
      senderName: "Alice",
    }),
  ]);
}

function viewThreadFixture(
  threadId: string,
  options: {
    readonly sentAt: number | null;
    readonly unread: boolean;
    readonly hasAttachments: boolean;
    readonly listMessage: boolean;
    readonly sizeEstimate: number | null;
    readonly senderName: string | null;
    readonly senderAddress?: string;
    readonly noParticipants?: boolean;
    readonly category?: MailThreadCategory;
  },
): CachedProviderThread {
  const base = threadFixture(threadId, options.sentAt ?? 0);
  const category =
    options.category ?? (options.listMessage ? "notification" : "people");
  const from = options.noParticipants
    ? null
    : Object.freeze({
        name: options.senderName,
        address: options.senderAddress ?? "sender@example.test",
      });
  const message: CachedProviderMessage = Object.freeze({
    ...base.messages[0]!,
    from,
    sentAt: options.sentAt,
    unread: options.unread,
    hasAttachments: options.hasAttachments,
    listMessage: options.listMessage,
    category,
    sizeEstimate: options.sizeEstimate,
  });
  const thread: MailThreadListItem = Object.freeze({
    ...base.thread,
    participants: Object.freeze(from === null ? [] : [from]),
    lastMessageAt: options.sentAt,
    unread: options.unread,
    hasAttachments: options.hasAttachments,
    listMessage: options.listMessage,
    sizeBytes: options.sizeEstimate ?? 0,
    category,
  });
  return Object.freeze({
    ...base,
    thread,
    messages: Object.freeze([message]),
  });
}

async function createCache(): Promise<{
  readonly cache: SqliteMailMessageCache;
  readonly cacheRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-cache-"));
  roots.push(root);
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { mode: 0o700 });
  const cache = new SqliteMailMessageCache({ cacheRoot, accountId: ACCOUNT_ID });
  await cache.initialize();
  return { cache, cacheRoot };
}

function publishMailbox(
  cache: SqliteMailMessageCache,
  mailboxId: MailCacheHydratableMailbox,
  generation: number,
  historyId: string,
  threads: readonly CachedProviderThread[],
  now: number,
): void {
  cache.beginOrResumeMailboxHydration(mailboxId);
  cache.putMailboxHydrationPage({
    mailboxId,
    generation,
    expectedPageToken: null,
    threads,
    listedCount: threads.length,
    nextPageToken: null,
  });
  expect(cache.markPostCrawlHistoryObserved(mailboxId)).toBe(true);
  cache.completeMailboxHydration({
    mailboxId,
    generation,
    expectedHistoryId: historyId,
    now,
  });
}

function threadFixture(
  threadId: string,
  sentAt: number,
  mailboxes: readonly MailCacheMailbox[] = Object.freeze(["all", "inbox"]),
): CachedProviderThread {
  const inInbox = mailboxes.includes("inbox");
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
    unread: true,
    inInbox,
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
    unread: true,
    starred: mailboxes.includes("starred"),
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
  });
  return Object.freeze({
    thread,
    messages: Object.freeze([message]),
    inInbox,
    mailboxes: Object.freeze([...mailboxes]),
  });
}

function threadWithBody(
  threadId: string,
  sentAt: number,
  bodyBytes: number,
): CachedProviderThread {
  const base = threadFixture(threadId, sentAt);
  const message = Object.freeze({
    ...base.messages[0],
    textBody: "x".repeat(bodyBytes),
  });
  return Object.freeze({ ...base, messages: Object.freeze([message]) });
}

/** Six threads of one megabyte each, enough to dominate the file size. */
function bulkThreadFixtures(): readonly CachedProviderThread[] {
  return Object.freeze(
    Array.from({ length: 6 }, (_, index) =>
      threadWithBody(`thread-bulk-${index}`, 1_000 + index, 1024 * 1024 - 16),
    ),
  );
}

function searchThreadFixture(
  threadId: string,
  sentAt: number,
  options: {
    readonly subject?: string;
    readonly snippet?: string;
    readonly participants?: readonly { readonly name: string | null; readonly address: string }[];
    readonly mailboxes?: readonly MailCacheMailbox[];
  } = {},
): CachedProviderThread {
  const base = threadFixture(
    threadId,
    sentAt,
    options.mailboxes ?? Object.freeze(["all", "inbox"]),
  );
  const subject = options.subject ?? base.thread.subject;
  const snippet = options.snippet ?? base.thread.snippet;
  const participants = Object.freeze(
    options.participants ? [...options.participants] : [...base.thread.participants],
  );
  const message = Object.freeze({
    ...base.messages[0],
    subject,
    snippet,
    from: participants[0] ?? base.messages[0].from,
  });
  return Object.freeze({
    ...base,
    thread: Object.freeze({
      ...base.thread,
      subject,
      snippet,
      participants,
    }),
    messages: Object.freeze([message]),
  });
}

function cacheDatabasePath(cacheRoot: string): string {
  return path.join(cacheRoot, ACCOUNT_ID, "messages.sqlite3");
}

function mailboxesFor(
  database: DatabaseSync,
  generation: number,
  threadId: string,
): unknown[] {
  return database
    .prepare(
      `SELECT mailbox_id
         FROM thread_mailboxes
        WHERE account_id = ? AND generation = ? AND thread_id = ?
        ORDER BY mailbox_id ASC`,
    )
    .all(ACCOUNT_ID, generation, threadId)
    .map((row) => row.mailbox_id);
}

function mailboxState(
  database: DatabaseSync,
  mailbox: MailCacheMailbox,
): Record<string, unknown> | undefined {
  return database
    .prepare(
      `SELECT active_thread_generation, staged_thread_generation,
              observed_history_id, initial_anchor_history_id, page_token,
              status, last_successful_at, last_error_code
         FROM mailbox_sync_state
        WHERE account_id = ? AND mailbox_id = ?`,
    )
    .get(ACCOUNT_ID, mailbox);
}

function historyCycle(database: DatabaseSync): Record<string, unknown> | undefined {
  return database
    .prepare(
      `SELECT start_history_id, next_page_token
         FROM mailbox_history_cycle
        WHERE account_id = ?`,
    )
    .get(ACCOUNT_ID);
}

function withDatabase(
  databasePath: string,
  operation: (database: DatabaseSync) => void,
): void {
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    operation(database);
  } finally {
    database.close();
  }
}
