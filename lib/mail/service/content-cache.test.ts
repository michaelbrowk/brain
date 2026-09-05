import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { MailThreadListItem } from "../message-types";
import type { MailBlobDescriptor } from "../ports";
import { MAIL_RESOURCE_LIMITS } from "../security";
import { AtomicMailBlobStore } from "./content-blob-store";
import {
  MAIL_CONTENT_FORMAT_VERSION,
  SqliteMailContentCache,
  type MailContentLease,
} from "./content-cache";
import {
  type CachedProviderMessage,
  type CachedProviderThread,
  SqliteMailMessageCache,
} from "./message-cache";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const SECOND_ACCOUNT_ID = "account-a22222222222222222222222222222222";
const roots: string[] = [];
const contentCaches: SqliteMailContentCache[] = [];
const blobStores: AtomicMailBlobStore[] = [];
const messageCaches: SqliteMailMessageCache[] = [];

afterEach(async () => {
  await Promise.all(contentCaches.splice(0).map((cache) => cache.close()));
  for (const cache of messageCaches.splice(0)) cache.close();
  await Promise.all(blobStores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("active-message content metadata cache", () => {
  it("keeps additive schema v1 readable after a legacy cache reopen", async () => {
    const fixture = await createFixture({ active: true });
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'message_content'`,
          )
          .get(),
      ).toEqual({ name: "message_content" });
    } finally {
      database.close();
    }

    await fixture.content.close();
    fixture.messages.close();
    const reopened = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
    });
    messageCaches.push(reopened);
    await reopened.initialize();
    expect(reopened.getThread("thread-a")?.messages[0].messageId).toBe(
      "message-thread-a",
    );
    expect(reopened.readSyncState().activeGeneration).toBe(1);
    reopened.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [],
      nextPageToken: null,
      resultingHistoryId: "101",
      now: 2_000,
    });
    expect(reopened.readSyncState().historyId).toBe("101");
  });

  it("adds the format-version column to an older additive content table", async () => {
    const fixture = await createFixture({ active: true });
    await fixture.content.close();
    const legacy = new DatabaseSync(fixture.databasePath);
    try {
      legacy.exec(
        "ALTER TABLE message_content DROP COLUMN content_format_version",
      );
    } finally {
      legacy.close();
    }

    const reopened = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobs,
    });
    contentCaches.push(reopened);
    await reopened.initialize();
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare("PRAGMA table_info(message_content)")
          .all()
          .some((row) => row.name === "content_format_version"),
      ).toBe(true);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
    } finally {
      database.close();
    }
  });

  it("rejects an unknown future schema without mutating it", async () => {
    const fixture = await createFixture({ active: true });
    await fixture.content.close();
    fixture.messages.close();
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database.exec("PRAGMA user_version = 2");
    } finally {
      database.close();
    }
    const future = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobs,
    });
    contentCaches.push(future);
    await expect(future.initialize()).rejects.toMatchObject({
      code: "mail_content_cache_unavailable",
    });
    const unchanged = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 2,
      });
    } finally {
      unchanged.close();
    }
  });

  it("rejects a fresh future schema before creating any blob state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-future-content-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    const accountDirectory = path.join(cacheRoot, ACCOUNT_ID);
    await mkdir(accountDirectory, { recursive: true, mode: 0o700 });
    const databasePath = path.join(accountDirectory, "messages.sqlite3");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA user_version = 2");
    } finally {
      database.close();
    }
    await chmod(databasePath, 0o600);
    const blobs = new AtomicMailBlobStore({ cacheRoot, accountId: ACCOUNT_ID });
    blobStores.push(blobs);
    const content = new SqliteMailContentCache({
      cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: blobs,
    });
    contentCaches.push(content);

    await expect(content.initialize()).rejects.toMatchObject({
      code: "mail_content_cache_unavailable",
    });
    expect((await readdir(accountDirectory)).sort()).toEqual(["messages.sqlite3"]);
  });

  it("keeps staged-generation content invisible, then atomically publishes it", async () => {
    const fixture = await createFixture({ active: false });
    await expect(fixture.content.claim("message-thread-a", 100)).resolves.toEqual({
      kind: "not_active",
    });
    fixture.messages.completeInitial(fixture.generation, 200);

    const lease = await claimLease(fixture.content, "message-thread-a", 300);
    const raw = Buffer.from("raw mime");
    const text = Buffer.from("visible text");
    const attachment = Buffer.from("attachment bytes");
    await stage(fixture, lease, raw, 301);
    await stage(fixture, lease, text, 302);
    await stage(fixture, lease, attachment, 303);
    expect(await fixture.content.read("message-thread-a")).toBeNull();

    const ready = await fixture.content.commitReady({
      lease,
      rawMime: descriptorFor(raw),
      text: descriptorFor(text),
      sanitizedHtml: null,
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          disposition: "attachment",
          contentId: null,
          blob: descriptorFor(attachment),
        },
      ],
      now: 304,
    });
    expect(ready.attachments[0]?.attachmentId).toMatch(
      /^attachment-a[0-9a-f]{32}$/,
    );
    expect(await fixture.content.read("message-thread-a")).toEqual(ready);
    expect(
      await fixture.content.readAttachment(ready.attachments[0]!.attachmentId),
    ).toEqual({
      accountId: ready.accountId,
      providerMessageId: ready.providerMessageId,
      sourceGeneration: ready.sourceGeneration,
      version: ready.version,
      contentFormatVersion: ready.contentFormatVersion,
      attachment: ready.attachments[0],
    });
    await expect(
      collect(fixture.blobs.read(ready.attachments[0]!.blob)),
    ).resolves.toEqual(attachment);
  });

  it("lists one message's pending remote images for a demand-started drain", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("raw MIME with several remote images");
    const ids = ["1", "2", "3", "4"].map(
      (digit) => `remote-image-a${digit.repeat(32)}`,
    );
    const html = Buffer.from(
      ids.map((id) => `<img data-brain-remote-image="${id}">`).join(""),
    );
    await stage(fixture, lease, raw, 101);
    await stage(fixture, lease, html, 102);
    await fixture.content.commitReady({
      lease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: descriptorFor(html),
      attachments: [],
      remoteImages: ids.map((remoteImageId, ordinal) => ({
        remoteImageId,
        sourceUrl: `https://cdn.example.net/${ordinal}.png`,
      })),
      now: 103,
    });

    // Neither a cohort start nor an owner demand: nothing is approved yet.
    await expect(
      fixture.content.listPendingRemoteImages("message-thread-a", 104),
    ).resolves.toEqual([]);
    await fixture.content.recordUserContentDemand("message-thread-a", 104);
    await expect(
      fixture.content.listPendingRemoteImages("message-thread-a", 104),
    ).resolves.toEqual(ids);
    await expect(
      fixture.content.listPendingRemoteImages("message-thread-b", 104),
    ).resolves.toEqual([]);

    const [first, second, third] = await Promise.all(
      ids.slice(0, 3).map((id) => fixture.content.inspectRemoteImage(id, 105)),
    );
    if (
      first?.state !== "pending" ||
      second?.state !== "pending" ||
      third?.state !== "pending"
    ) {
      throw new Error("expected pending remote images");
    }
    await fixture.content.storeRemoteImage({
      snapshot: first,
      mimeType: "image/png",
      data: testPng(3, 2),
      raster: { width: 3, height: 2, frames: 1 },
      now: 106,
    });
    await fixture.content.markRemoteImageFailure({
      snapshot: second,
      kind: "transient",
      retryAt: 500,
      now: 107,
    });
    await fixture.content.markRemoteImageFailure({
      snapshot: third,
      kind: "permanent",
      now: 108,
    });

    // Ready, unexpired transient and permanent rows drop out. An expired
    // transient row comes back in its ordinal place.
    await expect(
      fixture.content.listPendingRemoteImages("message-thread-a", 499),
    ).resolves.toEqual([ids[3]]);
    await expect(
      fixture.content.listPendingRemoteImages("message-thread-a", 500),
    ).resolves.toEqual([ids[1], ids[3]]);
  });

  it("keeps remote origins behind opaque IDs and caches verified image bytes", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("raw MIME with remote image");
    const remoteImageId = `remote-image-a${"7".repeat(32)}`;
    const secondRemoteImageId = `remote-image-a${"8".repeat(32)}`;
    const thirdRemoteImageId = `remote-image-a${"9".repeat(32)}`;
    const sourceUrl = "https://images.example.com/banner.png?campaign=one";
    const html = Buffer.from(
      `<img data-brain-remote-image="${remoteImageId}" alt="Banner">`,
    );
    await stage(fixture, lease, raw, 101);
    await stage(fixture, lease, html, 102);
    const ready = await fixture.content.commitReady({
      lease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: descriptorFor(html),
      attachments: [],
      remoteImages: [
        { remoteImageId, sourceUrl },
        {
          remoteImageId: secondRemoteImageId,
          sourceUrl: "https://cdn.example.net/secondary.png",
        },
        {
          remoteImageId: thirdRemoteImageId,
          sourceUrl: "https://cdn.example.net/third.png",
        },
      ],
      now: 103,
    });

    expect(JSON.stringify(ready)).not.toContain(sourceUrl);
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(104),
    ).resolves.toBeNull();
    await expect(
      fixture.content.refreshBackgroundPrivacyCohort(104),
    ).resolves.toEqual({ selectedMessages: 1, purgedContent: false });
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(104),
    ).resolves.toBeNull();
    await fixture.content.markBackgroundContentPrefetchStarted(
      "message-thread-a",
      104,
    );
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(104),
    ).resolves.toBe(remoteImageId);
    const pending = await fixture.content.inspectRemoteImage(remoteImageId, 104);
    expect(pending).toMatchObject({
      state: "pending",
      accountId: ACCOUNT_ID,
      providerMessageId: "message-thread-a",
      remoteImageId,
      sourceUrl,
    });
    if (pending === null || pending.state !== "pending") {
      throw new Error("expected pending remote image");
    }
    const image = testPng(3, 2);
    const cached = await fixture.content.storeRemoteImage({
      snapshot: pending,
      mimeType: "image/png",
      data: image,
      raster: { width: 3, height: 2, frames: 1 },
      now: 105,
    });
    expect(await fixture.content.inspectRemoteImage(remoteImageId, 106)).toEqual(
      cached,
    );
    await expect(collect(fixture.blobs.read(cached.blob))).resolves.toEqual(image);

    const second = await fixture.content.inspectRemoteImage(
      secondRemoteImageId,
      107,
    );
    if (second === null || second.state !== "pending") {
      throw new Error("expected second pending remote image");
    }
    await fixture.content.markRemoteImageFailure({
      snapshot: second,
      kind: "transient",
      retryAt: 500,
      now: 108,
    });
    const third = await fixture.content.inspectRemoteImage(
      thirdRemoteImageId,
      109,
    );
    if (third === null || third.state !== "pending") {
      throw new Error("expected third pending remote image");
    }
    await expect(
      fixture.content.inspectRemoteImage(secondRemoteImageId, 499),
    ).resolves.toMatchObject({ state: "transient_failure", retryAt: 500 });
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(499),
    ).resolves.toBe(thirdRemoteImageId);
    await expect(
      fixture.content.inspectRemoteImage(secondRemoteImageId, 500),
    ).resolves.toMatchObject({ state: "pending" });
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(500),
    ).resolves.toBe(thirdRemoteImageId);
    await fixture.content.markRemoteImageFailure({
      snapshot: third,
      kind: "permanent",
      now: 501,
    });
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(501),
    ).resolves.toBe(secondRemoteImageId);
  });

  it("makes a user-demanded message's remote images eligible outside the cohort", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("raw MIME with demanded remote image");
    const remoteImageId = `remote-image-a${"1".repeat(32)}`;
    const sourceUrl = "https://images.example.com/demanded.png";
    const html = Buffer.from(
      `<img data-brain-remote-image="${remoteImageId}" alt="Demanded">`,
    );
    await stage(fixture, lease, raw, 101);
    await stage(fixture, lease, html, 102);
    await fixture.content.commitReady({
      lease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: descriptorFor(html),
      attachments: [],
      remoteImages: [{ remoteImageId, sourceUrl }],
      now: 103,
    });

    // The message is far too old for the background cohort. Without an owner
    // demand its image is never a candidate; the demand row alone makes it
    // one, without any cohort membership or prefetch marker.
    const openedAt = 1_000 + MAIL_RESOURCE_LIMITS.privacyPrefetchMaxAgeMs + 60_000;
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(openedAt),
    ).resolves.toBeNull();
    await fixture.content.recordUserContentDemand("message-thread-a", openedAt);
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(openedAt),
    ).resolves.toBe(remoteImageId);

    // The cohort purge exempts demanded content, so its remote-image state
    // and blobs survive a refresh that selects no messages.
    await expect(
      fixture.content.refreshBackgroundPrivacyCohort(openedAt),
    ).resolves.toEqual({ selectedMessages: 0, purgedContent: false });
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(openedAt),
    ).resolves.toBe(remoteImageId);
    const pending = await fixture.content.inspectRemoteImage(
      remoteImageId,
      openedAt,
    );
    if (pending === null || pending.state !== "pending") {
      throw new Error("expected pending remote image");
    }
    const image = testPng(3, 2);
    const cached = await fixture.content.storeRemoteImage({
      snapshot: pending,
      mimeType: "image/png",
      data: image,
      raster: { width: 3, height: 2, frames: 1 },
      now: openedAt + 1,
    });
    await expect(
      fixture.content.refreshBackgroundPrivacyCohort(openedAt + 2),
    ).resolves.toEqual({ selectedMessages: 0, purgedContent: false });
    await expect(fixture.content.collectGarbage()).resolves.toEqual([]);
    await expect(
      fixture.content.inspectRemoteImage(remoteImageId, openedAt + 3),
    ).resolves.toMatchObject({ state: "ready", blob: cached.blob });
    await expect(collect(fixture.blobs.read(cached.blob))).resolves.toEqual(image);
  });

  it("enforces one transactional decoded-pixel budget across remote images", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("raw MIME with aggregate remote images");
    const ids = ["a", "b", "c"].map(
      (suffix) => `remote-image-a${suffix.repeat(32)}`,
    );
    const html = Buffer.from(
      ids.map((id) => `<img data-brain-remote-image="${id}">`).join(""),
    );
    await stage(fixture, lease, raw, 101);
    await stage(fixture, lease, html, 102);
    await fixture.content.commitReady({
      lease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: descriptorFor(html),
      attachments: [],
      remoteImages: ids.map((remoteImageId, index) => ({
        remoteImageId,
        sourceUrl: `https://images.example.com/${index}.png`,
      })),
      now: 103,
    });
    await fixture.content.refreshBackgroundPrivacyCohort(103);
    await fixture.content.markBackgroundContentPrefetchStarted(
      "message-thread-a",
      103,
    );

    for (const [index, remoteImageId] of ids.slice(0, 2).entries()) {
      const snapshot = await fixture.content.inspectRemoteImage(
        remoteImageId!,
        104 + index * 2,
      );
      if (snapshot === null || snapshot.state !== "pending") {
        throw new Error("expected pending remote image");
      }
      const budget = await fixture.content.readRemoteImageBudget(snapshot);
      expect(budget.maxPixels).toBe(12_000_000 - index * 6_000_000);
      const image = testPng(3_000, 2_000);
      await fixture.content.storeRemoteImage({
        snapshot,
        mimeType: "image/png",
        data: image,
        raster: { width: 3_000, height: 2_000, frames: 1 },
        now: 105 + index * 2,
      });
    }

    const third = await fixture.content.inspectRemoteImage(ids[2]!, 110);
    if (third === null || third.state !== "pending") {
      throw new Error("expected third pending remote image");
    }
    await expect(fixture.content.readRemoteImageBudget(third)).resolves.toMatchObject({
      maxPixels: 0,
    });
    await expect(
      fixture.content.storeRemoteImage({
        snapshot: third,
        mimeType: "image/png",
        data: testPng(3, 3),
        raster: { width: 3, height: 3, frames: 1 },
        now: 111,
      }),
    ).rejects.toMatchObject({
      code: "mail_content_remote_image_budget_exhausted",
    });
    await expect(
      fixture.content.inspectRemoteImage(ids[2]!, 112),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("evicts least-recently-used ready remote images into a refetchable state", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("raw MIME with LRU remote images");
    const firstId = `remote-image-a${"d".repeat(32)}`;
    const secondId = `remote-image-a${"e".repeat(32)}`;
    const thirdId = `remote-image-a${"f".repeat(32)}`;
    const html = Buffer.from(
      `<img data-brain-remote-image="${firstId}"><img data-brain-remote-image="${secondId}"><img data-brain-remote-image="${thirdId}">`,
    );
    await stage(fixture, lease, raw, 101);
    await stage(fixture, lease, html, 102);
    await fixture.content.commitReady({
      lease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: descriptorFor(html),
      attachments: [],
      remoteImages: [
        { remoteImageId: firstId, sourceUrl: "https://images.example.com/a.png" },
        { remoteImageId: secondId, sourceUrl: "https://images.example.com/b.png" },
        { remoteImageId: thirdId, sourceUrl: "https://images.example.com/c.png" },
      ],
      now: 103,
    });
    await fixture.content.refreshBackgroundPrivacyCohort(103);
    await fixture.content.markBackgroundContentPrefetchStarted(
      "message-thread-a",
      103,
    );
    const firstPending = await fixture.content.inspectRemoteImage(firstId, 104);
    const secondPending = await fixture.content.inspectRemoteImage(secondId, 105);
    if (firstPending?.state !== "pending" || secondPending?.state !== "pending") {
      throw new Error("expected pending remote images");
    }
    const firstImage = testPng(3, 3);
    const secondImage = testPng(4, 3);
    const firstReady = await fixture.content.storeRemoteImage({
      snapshot: firstPending,
      mimeType: "image/png",
      data: firstImage,
      raster: { width: 3, height: 3, frames: 1 },
      now: 106,
    });
    const secondReady = await fixture.content.storeRemoteImage({
      snapshot: secondPending,
      mimeType: "image/png",
      data: secondImage,
      raster: { width: 4, height: 3, frames: 1 },
      now: 107,
    });

    await fixture.content.inspectRemoteImage(firstId, 200);
    const evicted = await fixture.content.evictReadyRemoteImages({
      minimumBytes: secondReady.blob.bytes,
      now: 201,
    });
    expect(evicted).toEqual([secondReady.blob]);
    await expect(
      fixture.content.inspectRemoteImage(firstId, 202),
    ).resolves.toMatchObject({ state: "ready", blob: firstReady.blob });
    await expect(
      fixture.content.inspectRemoteImage(secondId, 202),
    ).resolves.toMatchObject({ state: "pending" });
    await expect(
      fixture.content.findBackgroundRemoteImageCandidate(202),
    ).resolves.toBe(thirdId);
    const thirdPending = await fixture.content.inspectRemoteImage(thirdId, 202);
    if (thirdPending?.state !== "pending") {
      throw new Error("expected third pending remote image");
    }
    await expect(
      fixture.content.readRemoteImageBudget(thirdPending),
    ).resolves.toMatchObject({
      maxBytes:
        MAIL_RESOURCE_LIMITS.maxRemoteImageBytesPerMessage -
        firstReady.blob.bytes -
        secondReady.blob.bytes,
      maxPixels: MAIL_RESOURCE_LIMITS.maxInlineImagePixels - 21,
      maxFrames: MAIL_RESOURCE_LIMITS.maxInlineImageFrames - 2,
    });
    await expect(fixture.content.collectGarbage()).resolves.toContainEqual(
      secondReady.blob,
    );
  });

  it("commits a real zero-byte attachment but rejects an empty raw MIME", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("non-empty raw MIME");
    const emptyAttachment = Buffer.alloc(0);
    await stage(fixture, lease, raw, 101);
    await stage(fixture, lease, emptyAttachment, 102);

    const ready = await fixture.content.commitReady({
      lease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: null,
      attachments: [
        {
          filename: "empty.txt",
          mimeType: "text/plain",
          disposition: "attachment",
          contentId: null,
          blob: descriptorFor(emptyAttachment),
        },
      ],
      now: 103,
    });
    expect(ready.attachments[0]?.blob.bytes).toBe(0);
    await expect(
      collect(fixture.blobs.read(ready.attachments[0]!.blob)),
    ).resolves.toEqual(emptyAttachment);
    await expect(fixture.content.collectGarbage()).resolves.toEqual([]);

    const second = await createFixture({ active: true });
    const emptyRawLease = await claimLease(
      second.content,
      "message-thread-a",
      200,
    );
    await expect(
      second.content.commitReady({
        lease: emptyRawLease,
        rawMime: descriptorFor(Buffer.alloc(0)),
        text: null,
        sanitizedHtml: null,
        attachments: [],
        now: 201,
      }),
    ).rejects.toMatchObject({ code: "mail_content_request_invalid" });
  });

  it("returns an attachment owner snapshot and self-heals a missing download", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("raw with one attachment");
    const attachment = Buffer.from("download payload");
    await stage(fixture, lease, raw, 101);
    await stage(fixture, lease, attachment, 102);
    const ready = await fixture.content.commitReady({
      lease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: null,
      attachments: [
        {
          filename: "download.bin",
          mimeType: "application/octet-stream",
          disposition: "attachment",
          contentId: null,
          blob: descriptorFor(attachment),
        },
      ],
      now: 103,
    });
    const attachmentId = ready.attachments[0]!.attachmentId;
    const snapshot = await fixture.content.readAttachment(attachmentId);
    expect(snapshot).not.toBeNull();
    const missingAttachmentId = `${attachmentId.slice(0, -1)}${
      attachmentId.endsWith("0") ? "1" : "0"
    }`;
    await expect(
      fixture.content.readAttachment(missingAttachmentId),
    ).resolves.toBeNull();
    await expect(
      fixture.content.invalidateReady({
        accountId: snapshot!.accountId,
        providerMessageId: snapshot!.providerMessageId,
        sourceGeneration: snapshot!.sourceGeneration,
        version: snapshot!.version,
        contentFormatVersion: snapshot!.contentFormatVersion,
        failedBlob: descriptorFor(Buffer.from("foreign missing attachment")),
        errorCode: "attachment_read_failed",
        now: 104,
      }),
    ).resolves.toBe(false);
    expect(await fixture.content.read("message-thread-a")).toEqual(ready);

    await fixture.blobs.remove(snapshot!.attachment.blob);
    await expect(
      collect(fixture.blobs.read(snapshot!.attachment.blob)),
    ).rejects.toMatchObject({ code: "mail_blob_not_found" });
    await expect(
      fixture.content.invalidateReady({
        accountId: snapshot!.accountId,
        providerMessageId: snapshot!.providerMessageId,
        sourceGeneration: snapshot!.sourceGeneration,
        version: snapshot!.version,
        contentFormatVersion: snapshot!.contentFormatVersion,
        failedBlob: snapshot!.attachment.blob,
        errorCode: "attachment_read_failed",
        now: 105,
      }),
    ).resolves.toBe(true);
    await expect(fixture.content.read("message-thread-a")).resolves.toBeNull();
    await expect(fixture.content.claim("message-thread-a", 106)).resolves.toMatchObject({
      kind: "claimed",
    });
  });

  it("enforces busy, expiry, and exact stale-lease transitions", async () => {
    const fixture = await createFixture({ active: true });
    const first = await claimLease(fixture.content, "message-thread-a", 1_000);
    await expect(fixture.content.claim("message-thread-a", 1_001)).resolves.toEqual({
      kind: "busy",
      expiresAt: first.expiresAt,
    });
    const raw = Buffer.from("late raw");
    await expect(
      stage(fixture, first, raw, first.expiresAt),
    ).rejects.toMatchObject({ code: "mail_content_lease_stale" });

    const second = await claimLease(
      fixture.content,
      "message-thread-a",
      first.expiresAt,
    );
    expect(second.version).toBe(first.version + 1);
    await expect(
      fixture.content.markFailure({
        lease: first,
        kind: "transient",
        errorCode: "old_worker",
        now: first.expiresAt + 1,
      }),
    ).rejects.toMatchObject({ code: "mail_content_lease_stale" });
    await expect(
      fixture.content.markFailure({
        lease: second,
        kind: "permanent",
        errorCode: "mime_rejected",
        now: first.expiresAt + 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      fixture.content.claim("message-thread-a", first.expiresAt + 2),
    ).resolves.toEqual({
      kind: "permanent_failure",
      errorCode: "mime_rejected",
    });
  });

  it("rechecks the clock after streaming and never stages across lease expiry", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("stream crosses the lease boundary");
    fixture.clock.now = 101;
    await expect(
      fixture.content.stageBlob(
        lease,
        descriptorFor(raw),
        (async function* () {
          yield raw.subarray(0, 5);
          fixture.clock.now = lease.expiresAt;
          yield raw.subarray(5);
        })(),
        101,
      ),
    ).rejects.toMatchObject({ code: "mail_content_lease_stale" });
    expect(await fixture.blobs.has(descriptorFor(raw))).toBe(true);
    await expect(fixture.content.collectGarbage()).resolves.toEqual([
      descriptorFor(raw),
    ]);
  });

  it("rechecks the clock after blob verification before the ready CAS", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("verified before expiry");
    await stage(fixture, lease, raw, 101);
    fixture.clock.now = lease.expiresAt;

    await expect(
      fixture.content.commitReady({
        lease,
        rawMime: descriptorFor(raw),
        text: null,
        sanitizedHtml: null,
        attachments: [],
        now: 102,
      }),
    ).rejects.toMatchObject({ code: "mail_content_lease_stale" });
    expect(await fixture.content.read("message-thread-a")).toBeNull();
  });

  it("rechecks the clock before a failure CAS and rejects an expired worker", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    fixture.clock.now = lease.expiresAt;

    await expect(
      fixture.content.markFailure({
        lease,
        kind: "permanent",
        errorCode: "mime_rejected",
        now: 101,
      }),
    ).rejects.toMatchObject({ code: "mail_content_lease_stale" });
    await expect(
      fixture.content.claim("message-thread-a", lease.expiresAt),
    ).resolves.toMatchObject({ kind: "claimed" });
  });

  it("binds every lease and store to exactly one account", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const forged = Object.freeze({ ...lease, accountId: SECOND_ACCOUNT_ID });
    const raw = Buffer.from("cross-account attempt");
    await expect(
      fixture.content.stageBlob(forged, descriptorFor(raw), chunks(raw, 3), 101),
    ).rejects.toMatchObject({ code: "mail_content_request_invalid" });
    expect(await fixture.blobs.has(descriptorFor(raw))).toBe(false);

    expect(
      () =>
        new SqliteMailContentCache({
          cacheRoot: fixture.cacheRoot,
          accountId: SECOND_ACCOUNT_ID,
          blobStore: fixture.blobs,
        }),
    ).toThrowError(
      expect.objectContaining({ code: "mail_content_request_invalid" }),
    );
  });

  it("closes every account handle before a disconnect tombstone rename", async () => {
    const fixture = await createFixture({ active: true });
    await publishRaw(fixture, Buffer.from("close barrier"), 100);
    await fixture.content.close();
    fixture.messages.close();
    await fixture.blobs.close();

    const accountDirectory = path.join(fixture.cacheRoot, ACCOUNT_ID);
    const tombstone = path.join(fixture.cacheRoot, `${ACCOUNT_ID}.disconnected`);
    await rename(accountDirectory, tombstone);
    expect((await readdir(fixture.cacheRoot)).sort()).toEqual([
      `${ACCOUNT_ID}.disconnected`,
    ]);
  });

  it("withholds ready content after its active message generation disappears", async () => {
    const fixture = await createFixture({ active: true });
    const ready = await publishRaw(fixture, Buffer.from("generation one"), 100);
    expect(await fixture.content.read("message-thread-a")).toEqual(ready);

    const nextGeneration = fixture.messages.beginInitial("200");
    fixture.messages.putInitialPage(
      nextGeneration,
      [threadFixture("thread-b", 2_000)],
      null,
      null,
    );
    expect(await fixture.content.read("message-thread-a")).toEqual(ready);
    fixture.messages.completeInitial(nextGeneration, 3_000);
    expect(await fixture.content.read("message-thread-a")).toBeNull();
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM message_content
              WHERE account_id = ? AND provider_message_id = ?`,
          )
          .get(ACCOUNT_ID, "message-thread-a"),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
    await expect(fixture.content.collectGarbage()).resolves.toEqual([
      ready.rawMime,
    ]);
  });

  it("preserves ready content across a same-generation message refresh", async () => {
    const fixture = await createFixture({ active: true });
    const ready = await publishRaw(fixture, Buffer.from("stable provider id"), 100);
    fixture.messages.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [{ kind: "upsert", value: threadFixture("thread-a", 2_000) }],
      nextPageToken: null,
      resultingHistoryId: "101",
      now: 2_500,
    });

    expect(await fixture.content.read("message-thread-a")).toEqual(ready);
    await expect(fixture.content.collectGarbage()).resolves.toEqual([]);
    expect(await fixture.blobs.has(ready.rawMime)).toBe(true);
  });

  it("reclaims ready content when the parser and sanitizer policy version changes", async () => {
    const fixture = await createFixture({ active: true });
    const ready = await publishRaw(fixture, Buffer.from("policy v1"), 100);
    expect(ready.contentFormatVersion).toBe(MAIL_CONTENT_FORMAT_VERSION);
    await fixture.content.close();

    const upgraded = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobs,
      contentFormatVersion: MAIL_CONTENT_FORMAT_VERSION + 1,
    });
    contentCaches.push(upgraded);
    await upgraded.initialize();

    await expect(upgraded.read("message-thread-a")).resolves.toBeNull();
    const next = await claimLease(upgraded, "message-thread-a", 200);
    expect(next.version).toBe(ready.version + 1);
    await expect(upgraded.collectGarbage()).resolves.toEqual([ready.rawMime]);
  });

  it("reuses verified remote images when the sanitizer policy version changes", async () => {
    const fixture = await createFixture({ active: true });
    const sourceUrl = "https://images.example.com/preserved.png";
    const oldRemoteImageId = `remote-image-a${"a".repeat(32)}`;
    const raw = Buffer.from("policy migration with remote image");
    const oldHtml = Buffer.from(
      `<img data-brain-remote-image="${oldRemoteImageId}">`,
    );
    const firstLease = await claimLease(
      fixture.content,
      "message-thread-a",
      100,
    );
    await stage(fixture, firstLease, raw, 101);
    await stage(fixture, firstLease, oldHtml, 102);
    await fixture.content.commitReady({
      lease: firstLease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: descriptorFor(oldHtml),
      attachments: [],
      remoteImages: [{ remoteImageId: oldRemoteImageId, sourceUrl }],
      now: 103,
    });
    const pending = await fixture.content.inspectRemoteImage(
      oldRemoteImageId,
      104,
    );
    if (pending === null || pending.state !== "pending") {
      throw new Error("expected pending remote image");
    }
    const image = testPng(4, 3);
    const verified = await fixture.content.storeRemoteImage({
      snapshot: pending,
      mimeType: "image/png",
      data: image,
      raster: { width: 4, height: 3, frames: 1 },
      now: 105,
    });
    await fixture.content.close();

    const upgraded = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobs,
      clock: () => fixture.clock.now,
      contentFormatVersion: MAIL_CONTENT_FORMAT_VERSION + 1,
    });
    contentCaches.push(upgraded);
    await upgraded.initialize();
    const secondLease = await claimLease(
      upgraded,
      "message-thread-a",
      200,
    );
    const newRemoteImageId = `remote-image-a${"b".repeat(32)}`;
    const newHtml = Buffer.from(
      `<img data-brain-remote-image="${newRemoteImageId}">`,
    );
    await upgraded.stageBlob(
      secondLease,
      descriptorFor(raw),
      chunks(raw, 3),
      201,
    );
    await upgraded.stageBlob(
      secondLease,
      descriptorFor(newHtml),
      chunks(newHtml, 3),
      202,
    );
    await upgraded.commitReady({
      lease: secondLease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: descriptorFor(newHtml),
      attachments: [],
      remoteImages: [{ remoteImageId: newRemoteImageId, sourceUrl }],
      now: 203,
    });

    await expect(
      upgraded.inspectRemoteImage(newRemoteImageId, 204),
    ).resolves.toMatchObject({
      state: "ready",
      sourceUrl,
      mimeType: "image/png",
      blob: verified.blob,
      raster: { width: 4, height: 3, frames: 1 },
    });
    await expect(
      upgraded.inspectRemoteImage(oldRemoteImageId, 204),
    ).resolves.toBeNull();
    await expect(collect(fixture.blobs.read(verified.blob))).resolves.toEqual(
      image,
    );
  });

  it("invalidates a sticky v1 parser failure when the v2 policy starts", async () => {
    const fixture = await createFixture({ active: true });
    await fixture.content.close();
    const legacy = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobs,
      clock: () => fixture.clock.now,
      contentFormatVersion: 1,
    });
    contentCaches.push(legacy);
    await legacy.initialize();
    const legacyLease = await claimLease(legacy, "message-thread-a", 100);
    await legacy.markFailure({
      lease: legacyLease,
      kind: "permanent",
      errorCode: "mail_mime_limit_exceeded",
      now: 101,
    });
    await expect(legacy.inspect("message-thread-a")).resolves.toMatchObject({
      kind: "permanent_failure",
      errorCode: "mail_mime_limit_exceeded",
    });
    await legacy.close();

    const current = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobs,
      clock: () => fixture.clock.now,
    });
    contentCaches.push(current);
    await current.initialize();

    await expect(current.inspect("message-thread-a")).resolves.toEqual({
      kind: "not_requested",
    });
    const currentLease = await claimLease(current, "message-thread-a", 102);
    expect(currentLease.version).toBe(legacyLease.version + 1);
  });

  it("reclaims stale generations before repeatedly admitting large content", async () => {
    const fixture = await createFixture({
      active: true,
      maxCacheBytes: 64 * 1024,
    });
    const first = Buffer.alloc(40 * 1024, 0x61);
    const second = Buffer.alloc(40 * 1024, 0x62);
    const third = Buffer.alloc(40 * 1024, 0x63);
    const firstReady = await publishRaw(fixture, first, 100, "message-thread-a");

    activateOnlyThread(fixture, "thread-b", 2_000, "200");
    const secondReady = await publishRaw(
      fixture,
      second,
      300,
      "message-thread-b",
    );
    expect(await fixture.blobs.has(firstReady.rawMime)).toBe(false);
    expect(await fixture.blobs.has(secondReady.rawMime)).toBe(true);

    activateOnlyThread(fixture, "thread-c", 4_000, "300");
    const thirdReady = await publishRaw(
      fixture,
      third,
      500,
      "message-thread-c",
    );
    expect(await fixture.blobs.has(secondReady.rawMime)).toBe(false);
    expect(await fixture.blobs.has(thirdReady.rawMime)).toBe(true);
    await expect(fixture.content.read("message-thread-a")).resolves.toBeNull();
    await expect(fixture.content.read("message-thread-b")).resolves.toBeNull();
    await expect(fixture.content.read("message-thread-c")).resolves.toEqual(
      thirdReady,
    );
  }, 15_000);

  it("applies the capacity reservation across account directories", async () => {
    const fixture = await createFixture({
      active: true,
      maxCacheBytes: 64 * 1024,
    });
    const first = Buffer.alloc(40 * 1024, 0x61);
    await publishRaw(fixture, first, 100);

    const messages = new SqliteMailMessageCache({
      cacheRoot: fixture.cacheRoot,
      accountId: SECOND_ACCOUNT_ID,
    });
    messageCaches.push(messages);
    await messages.initialize();
    const generation = messages.beginInitial("100");
    messages.putInitialPage(
      generation,
      [threadFixture("thread-b", 1_000, SECOND_ACCOUNT_ID)],
      null,
      null,
    );
    messages.completeInitial(generation, 1_500);
    const blobs = new AtomicMailBlobStore({
      cacheRoot: fixture.cacheRoot,
      accountId: SECOND_ACCOUNT_ID,
      maxCacheBytes: 64 * 1024,
    });
    blobStores.push(blobs);
    await blobs.initialize();
    const content = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: SECOND_ACCOUNT_ID,
      blobStore: blobs,
      clock: () => fixture.clock.now,
    });
    contentCaches.push(content);
    await content.initialize();
    const lease = await claimLease(content, "message-thread-b", 200);
    const second = Buffer.alloc(40 * 1024, 0x62);

    await expect(
      content.stageBlob(lease, descriptorFor(second), chunks(second, 1024), 201),
    ).rejects.toMatchObject({ code: "mail_content_cache_capacity_exhausted" });
    expect(await fixture.blobs.has(descriptorFor(first))).toBe(true);
    expect(await blobs.has(descriptorFor(second))).toBe(false);
  }, 15_000);

  it("serializes competing capacity reservations before either stream writes", async () => {
    const fixture = await createFixture({
      active: true,
      maxCacheBytes: 64 * 1024,
    });
    fixture.messages.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [{ kind: "upsert", value: threadFixture("thread-b", 2_000) }],
      nextPageToken: null,
      resultingHistoryId: "101",
      now: 2_500,
    });
    const secondBlobs = new AtomicMailBlobStore({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      maxCacheBytes: 64 * 1024,
    });
    blobStores.push(secondBlobs);
    await secondBlobs.initialize();
    const secondCache = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: secondBlobs,
      clock: () => fixture.clock.now,
    });
    contentCaches.push(secondCache);
    await secondCache.initialize();

    const firstLease = await claimLease(fixture.content, "message-thread-a", 100);
    const secondLease = await claimLease(secondCache, "message-thread-b", 100);
    const first = Buffer.alloc(40 * 1024, 0x61);
    const second = Buffer.alloc(40 * 1024, 0x62);
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const firstWrite = fixture.content.stageBlob(
      firstLease,
      descriptorFor(first),
      (async function* () {
        yield first.subarray(0, 1024);
        firstStarted.resolve(undefined);
        await releaseFirst.promise;
        yield first.subarray(1024);
      })(),
      101,
    );
    await firstStarted.promise;
    let secondConsumed = false;
    const secondWrite = secondCache.stageBlob(
      secondLease,
      descriptorFor(second),
      (async function* () {
        secondConsumed = true;
        yield second;
      })(),
      101,
    );
    await nextTurn();
    expect(secondConsumed).toBe(false);

    releaseFirst.resolve(undefined);
    await expect(firstWrite).resolves.toBeUndefined();
    await expect(secondWrite).rejects.toMatchObject({
      code: "mail_content_cache_capacity_exhausted",
    });
    expect(secondConsumed).toBe(false);
    expect(await fixture.blobs.has(descriptorFor(first))).toBe(true);
    expect(await fixture.blobs.has(descriptorFor(second))).toBe(false);
  });

  it("serializes competing claims from two cache instances", async () => {
    const fixture = await createFixture({ active: true });
    const second = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobs,
    });
    contentCaches.push(second);
    await second.initialize();

    const results = await Promise.all([
      fixture.content.claim("message-thread-a", 100),
      second.claim("message-thread-a", 100),
    ]);
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "busy")).toHaveLength(1);
  });

  it("protects staged references from GC, then reaps crash orphans", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const staged = Buffer.from("staged raw");
    const orphan = Buffer.from("unreferenced orphan");
    await stage(fixture, lease, staged, 101);
    await fixture.blobs.put(descriptorFor(orphan), chunks(orphan, 3));

    await expect(fixture.content.collectGarbage()).resolves.toEqual([
      descriptorFor(orphan),
    ]);
    expect(await fixture.blobs.has(descriptorFor(staged))).toBe(true);

    await fixture.content.close();
    const reopened = new SqliteMailContentCache({
      cacheRoot: fixture.cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobs,
    });
    contentCaches.push(reopened);
    await reopened.initialize();
    await expect(reopened.reapExpiredLeases(lease.expiresAt)).resolves.toBe(1);
    await expect(reopened.collectGarbage()).resolves.toEqual([
      descriptorFor(staged),
    ]);
    expect(await fixture.blobs.has(descriptorFor(staged))).toBe(false);
  });

  it("requires every committed descriptor to be staged and present", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("raw only");
    const text = Buffer.from("not staged");
    await stage(fixture, lease, raw, 101);
    await expect(
      fixture.content.commitReady({
        lease,
        rawMime: descriptorFor(raw),
        text: descriptorFor(text),
        sanitizedHtml: null,
        attachments: [],
        now: 102,
      }),
    ).rejects.toMatchObject({ code: "mail_content_integrity_failed" });
    expect(await fixture.content.read("message-thread-a")).toBeNull();
  });

  it("invalidates an exact ready snapshot after its blob disappears", async () => {
    const fixture = await createFixture({ active: true });
    const ready = await publishRaw(fixture, Buffer.from("recoverable raw"), 100);
    await fixture.blobs.remove(ready.rawMime);
    await expect(collect(fixture.blobs.read(ready.rawMime))).rejects.toMatchObject({
      code: "mail_blob_not_found",
    });

    await expect(
      fixture.content.invalidateReady({
        accountId: ready.accountId,
        providerMessageId: ready.providerMessageId,
        sourceGeneration: ready.sourceGeneration,
        version: ready.version,
        contentFormatVersion: ready.contentFormatVersion,
        failedBlob: ready.rawMime,
        errorCode: "blob_read_failed",
        now: 200,
      }),
    ).resolves.toBe(true);
    await expect(fixture.content.read("message-thread-a")).resolves.toBeNull();
    await expect(fixture.content.claim("message-thread-a", 201)).resolves.toMatchObject({
      kind: "claimed",
    });
  });

  it("invalidates only forged metadata and preserves a valid shared CAS blob", async () => {
    const fixture = await createFixture({ active: true });
    fixture.messages.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [{ kind: "upsert", value: threadFixture("thread-b", 2_000) }],
      nextPageToken: null,
      resultingHistoryId: "101",
      now: 2_500,
    });
    const shared = Buffer.from("one blob shared by two ready messages");
    await publishRaw(fixture, shared, 100, "message-thread-a");
    const secondReady = await publishRaw(
      fixture,
      shared,
      200,
      "message-thread-b",
    );
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database
        .prepare(
          `UPDATE message_content SET raw_bytes = raw_bytes - 1
            WHERE account_id = ? AND provider_message_id = ?`,
        )
        .run(ACCOUNT_ID, "message-thread-a");
    } finally {
      database.close();
    }

    const forged = await fixture.content.read("message-thread-a");
    expect(forged?.rawMime.bytes).toBe(shared.byteLength - 1);
    await expect(collect(fixture.blobs.read(forged!.rawMime))).rejects.toMatchObject({
      code: "mail_blob_integrity_failed",
    });
    await expect(
      fixture.content.invalidateReady({
        accountId: forged!.accountId,
        providerMessageId: forged!.providerMessageId,
        sourceGeneration: forged!.sourceGeneration,
        version: forged!.version,
        contentFormatVersion: forged!.contentFormatVersion,
        failedBlob: forged!.rawMime,
        errorCode: "blob_metadata_mismatch",
        now: 300,
      }),
    ).resolves.toBe(true);

    expect(await fixture.content.read("message-thread-b")).toEqual(secondReady);
    await expect(collect(fixture.blobs.read(secondReady.rawMime))).resolves.toEqual(
      shared,
    );
    await expect(fixture.content.claim("message-thread-a", 301)).resolves.toMatchObject({
      kind: "claimed",
    });
  });

  it("keeps a ready body and its owner demand when incremental sync rewrites the thread", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = Buffer.from("raw MIME that must survive a thread refresh");
    const html = Buffer.from("<p>Body thread-a</p>");
    await stage(fixture, lease, raw, 101);
    await stage(fixture, lease, html, 102);
    await fixture.content.commitReady({
      lease,
      rawMime: descriptorFor(raw),
      text: null,
      sanitizedHtml: descriptorFor(html),
      attachments: [],
      remoteImages: [],
      now: 103,
    });
    await fixture.content.recordUserContentDemand("message-thread-a", 104);

    // Reading the thread flips its unread flag, so the next incremental page
    // carries the same thread again. That refresh must not drop the body the
    // owner just opened or the demand row that protects it from the cohort purge.
    const refreshed = threadFixture("thread-a", 1_000);
    fixture.messages.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: [
        {
          kind: "upsert",
          value: {
            ...refreshed,
            thread: { ...refreshed.thread, unread: false },
            messages: refreshed.messages.map((message) => ({
              ...message,
              unread: false,
            })),
          },
        },
      ],
      nextPageToken: null,
      resultingHistoryId: "101",
      now: 105,
    });

    await expect(
      fixture.content.inspect("message-thread-a"),
    ).resolves.toMatchObject({ kind: "ready" });
    const demand = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        demand
          .prepare(
            "SELECT provider_message_id FROM message_content_user_demand",
          )
          .all(),
      ).toEqual([{ provider_message_id: "message-thread-a" }]);
    } finally {
      demand.close();
    }
    const later = 1_000 + MAIL_RESOURCE_LIMITS.privacyPrefetchMaxAgeMs + 60_000;
    await expect(
      fixture.content.refreshBackgroundPrivacyCohort(later),
    ).resolves.toEqual({ selectedMessages: 0, purgedContent: false });
    await expect(
      fixture.content.inspect("message-thread-a"),
    ).resolves.toMatchObject({ kind: "ready" });
  });

  it("rejects decoded content beyond the global MIME budget", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 100);
    const raw = descriptorFor(Buffer.from("raw"));
    const tooLarge: MailBlobDescriptor = Object.freeze({
      sha256: "a".repeat(64),
      bytes: MAIL_RESOURCE_LIMITS.rawMessageBytes,
    });
    await expect(
      fixture.content.commitReady({
        lease,
        rawMime: raw,
        text: tooLarge,
        sanitizedHtml: tooLarge,
        attachments: [{
          filename: null,
          mimeType: "application/octet-stream",
          disposition: "attachment",
          contentId: null,
          blob: tooLarge,
        }],
        now: 101,
      }),
    ).rejects.toMatchObject({ code: "mail_content_request_invalid" });
  });
});

async function createFixture(input: {
  readonly active: boolean;
  readonly maxCacheBytes?: number;
}): Promise<{
  readonly root: string;
  readonly cacheRoot: string;
  readonly databasePath: string;
  readonly generation: number;
  readonly clock: { now: number };
  readonly messages: SqliteMailMessageCache;
  readonly blobs: AtomicMailBlobStore;
  readonly content: SqliteMailContentCache;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-content-"));
  roots.push(root);
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { mode: 0o700 });
  const messages = new SqliteMailMessageCache({ cacheRoot, accountId: ACCOUNT_ID });
  messageCaches.push(messages);
  await messages.initialize();
  const generation = messages.beginInitial("100");
  messages.putInitialPage(
    generation,
    [threadFixture("thread-a", 1_000)],
    null,
    null,
  );
  if (input.active) messages.completeInitial(generation, 1_500);
  const blobs = new AtomicMailBlobStore({
    cacheRoot,
    accountId: ACCOUNT_ID,
    ...(input.maxCacheBytes === undefined
      ? {}
      : { maxCacheBytes: input.maxCacheBytes }),
  });
  blobStores.push(blobs);
  await blobs.initialize();
  const clock = { now: 0 };
  const content = new SqliteMailContentCache({
    cacheRoot,
    accountId: ACCOUNT_ID,
    blobStore: blobs,
    clock: () => clock.now,
  });
  contentCaches.push(content);
  await content.initialize();
  return {
    root,
    cacheRoot,
    databasePath: path.join(cacheRoot, ACCOUNT_ID, "messages.sqlite3"),
    generation,
    clock,
    messages,
    blobs,
    content,
  };
}

async function claimLease(
  content: SqliteMailContentCache,
  messageId: string,
  now: number,
): Promise<MailContentLease> {
  const result = await content.claim(messageId, now);
  if (result.kind !== "claimed") throw new Error(`expected claimed, got ${result.kind}`);
  return result.lease;
}

async function stage(
  fixture: { readonly content: SqliteMailContentCache },
  lease: MailContentLease,
  value: Buffer,
  now: number,
): Promise<void> {
  await fixture.content.stageBlob(lease, descriptorFor(value), chunks(value, 3), now);
}

async function publishRaw(
  fixture: {
    readonly content: SqliteMailContentCache;
  },
  value: Buffer,
  now: number,
  messageId = "message-thread-a",
) {
  const lease = await claimLease(fixture.content, messageId, now);
  await stage(fixture, lease, value, now + 1);
  return fixture.content.commitReady({
    lease,
    rawMime: descriptorFor(value),
    text: null,
    sanitizedHtml: null,
    attachments: [],
    now: now + 2,
  });
}

function testPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([1])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

function threadFixture(
  threadId: string,
  sentAt: number,
  accountId = ACCOUNT_ID,
): CachedProviderThread {
  const message: CachedProviderMessage = Object.freeze({
    accountId,
    messageId: `message-${threadId}`,
    threadId,
    from: Object.freeze({ name: "Sender", address: "sender@example.test" }),
    replyTo: Object.freeze([]),
    to: Object.freeze([{ name: null, address: "reader@example.test" }]),
    cc: Object.freeze([]),
    subject: `Subject ${threadId}`,
    sentAt,
    unread: true,
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
    accountId,
    threadId,
    subject: message.subject,
    participants: Object.freeze([message.from!]),
    snippet: message.snippet,
    lastMessageAt: sentAt,
    messageCount: 1,
    unread: true,
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

function activateOnlyThread(
  fixture: { readonly messages: SqliteMailMessageCache },
  threadId: string,
  sentAt: number,
  historyId: string,
): void {
  const generation = fixture.messages.beginInitial(historyId);
  fixture.messages.putInitialPage(
    generation,
    [threadFixture(threadId, sentAt)],
    null,
    null,
  );
  fixture.messages.completeInitial(generation, sentAt + 1);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function descriptorFor(value: Buffer): MailBlobDescriptor {
  return Object.freeze({
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: value.byteLength,
  });
}

async function* chunks(value: Buffer, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.byteLength; offset += size) {
    yield value.subarray(offset, Math.min(offset + size, value.byteLength));
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Buffer[] = [];
  for await (const value of source) values.push(Buffer.from(value));
  return Buffer.concat(values);
}
