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
  MAIL_BODY_OPEN_PIN_MS,
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

describe("background body cohort and byte budget", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const HOUR = 60 * 60 * 1_000;
  const NOW = 100 * DAY;

  it("selects the newest 200 Inbox messages of the last 30 days", async () => {
    const fixture = await createFixture({ active: true });
    const recent = Array.from({ length: 205 }, (_, index) => ({
      threadId: `recent-${index}`,
      sentAt: NOW - (index + 1) * 60_000,
    }));
    activateThreads(
      fixture,
      [
        ...recent,
        { threadId: "stale", sentAt: NOW - 31 * DAY },
        { threadId: "archived", sentAt: NOW - 1_000, inInbox: false },
      ],
      "200",
    );

    await expect(
      fixture.content.refreshBackgroundPrivacyCohort(NOW),
    ).resolves.toEqual({ selectedMessages: 200, purgedContent: false });
    expect(readCohort(fixture.databasePath).map((row) => row.messageId)).toEqual(
      recent.slice(0, 200).map((entry) => `message-${entry.threadId}`),
    );
  });

  it("orders body prefetch newest first, the order the budget keeps", async () => {
    const fixture = await createFixture({ active: true });
    const recent = Array.from({ length: 25 }, (_, index) => ({
      threadId: `recent-${index}`,
      sentAt: NOW - (index + 1) * 60_000,
    }));
    activateThreads(fixture, recent, "200");
    await fixture.content.refreshBackgroundPrivacyCohort(NOW);

    const order: string[] = [];
    for (let step = 0; step < recent.length + 1; step += 1) {
      const messageId = (await fixture.content.findBackgroundContentCandidate(NOW))
        ?.messageId;
      if (messageId === undefined) break;
      order.push(messageId);
      await fixture.content.markBackgroundContentPrefetchStarted(messageId, NOW);
      await claimLease(fixture.content, messageId, NOW);
    }
    expect(order).toEqual(recent.map((entry) => `message-${entry.threadId}`));
  });

  it("claims no letter older than one the budget let go, or than the one it would let go next", async () => {
    const fixture = await createFixture({ active: true });
    const ids = ["a", "b", "c", "d", "e"];
    activateThreads(
      fixture,
      ids.map((id, index) => ({ threadId: id, sentAt: NOW - (index + 1) * HOUR })),
      "200",
    );
    await fixture.content.refreshBackgroundPrivacyCohort(NOW);
    await publishBody(fixture, "message-c", NOW, { raw: Buffer.alloc(100, "c") });
    await fixture.content.evictBodiesOverBudget({
      maxBytes: 0,
      now: NOW,
      pinnedMessageIds: [],
    });

    // c went for space, so d and e, older still, would go the same way.
    const candidates = async (newerThan: number | null, roomBytes = 0) => {
      const order: string[] = [];
      for (let step = 0; step < ids.length; step += 1) {
        const messageId = (
          await fixture.content.findBackgroundContentCandidate(
            NOW,
            newerThan,
            roomBytes,
          )
        )?.messageId;
        if (messageId === undefined) break;
        order.push(messageId);
        await claimLease(fixture.content, messageId, NOW);
      }
      return order;
    };
    // A budget that is full takes only what is newer than its next victim.
    await expect(candidates(NOW - 1 * HOUR - 1)).resolves.toEqual(["message-a"]);
    await expect(candidates(null)).resolves.toEqual(["message-b"]);
    // Room lifts both for what fits in it: the evicted body by what it held,
    // an older letter by its thread's size (2,048 bytes here).
    await expect(candidates(null, 2_047)).resolves.toEqual(["message-c"]);
    await expect(candidates(null, 2_048)).resolves.toEqual(["message-d", "message-e"]);
  });

  it("clears an eviction mark when a new generation arrives", async () => {
    const fixture = await createFixture({ active: true });
    await fixture.content.refreshBackgroundPrivacyCohort(1_000);
    const raw = Buffer.from("raw MIME evicted once");
    await publishBody(fixture, "message-thread-a", 1_001, { raw });
    await fixture.content.evictBodiesOverBudget({
      maxBytes: 0,
      now: 1_002,
      pinnedMessageIds: [],
    });
    await expect(
      fixture.content.findBackgroundContentCandidate(1_003),
    ).resolves.toBeNull();
    expect(readCohort(fixture.databasePath)).toEqual([
      {
        messageId: "message-thread-a",
        remoteImagePrefetch: 1,
        evictedAt: 1_002,
        evictedBytes: raw.byteLength,
      },
    ]);

    // A full resync is a new generation: what the budget let go before is a
    // candidate again, and the old eviction no longer holds anything back.
    // A hidden mailbox still on the old generation keeps its rows, so the
    // cohort row the refresh meets is the old one, mark and all.
    const writer = new DatabaseSync(fixture.databasePath);
    try {
      writer
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  status = 'idle', observed_history_id = '100',
                  last_successful_at = 1
            WHERE account_id = ? AND mailbox_id = 'all'`,
        )
        .run(fixture.generation, ACCOUNT_ID);
    } finally {
      writer.close();
    }
    activateOnlyThread(fixture, "thread-a", 1_000, "300");
    await fixture.content.refreshBackgroundPrivacyCohort(1_004);
    await expect(readCohort(fixture.databasePath)).toEqual([
      {
        messageId: "message-thread-a",
        remoteImagePrefetch: 1,
        evictedAt: null,
        evictedBytes: null,
      },
    ]);
    await expect(
      fixture.content.findBackgroundContentCandidate(1_004),
    ).resolves.toMatchObject({ messageId: "message-thread-a" });
  });

  it("writes nothing when a refresh finds the cohort unchanged", async () => {
    const fixture = await createFixture({ active: true });
    activateThreads(
      fixture,
      Array.from({ length: 50 }, (_, index) => ({
        threadId: `steady-${index}`,
        sentAt: NOW - (index + 1) * 60_000,
      })),
      "200",
    );
    await fixture.content.refreshBackgroundPrivacyCohort(NOW);
    const observer = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const version = () => observer.prepare("PRAGMA data_version").get();
      const before = version();
      await fixture.content.refreshBackgroundPrivacyCohort(NOW + 60_000);
      expect(version()).toEqual(before);
    } finally {
      observer.close();
    }
  });

  it("leaves a message whose thread is past the prefetch size, or unsized, for its open", async () => {
    const fixture = await createFixture({ active: true });
    const ceiling = MAIL_RESOURCE_LIMITS.privacyPrefetchMaxThreadBytes;
    activateThreads(
      fixture,
      [
        { threadId: "heavy", sentAt: NOW - 1 * HOUR, sizeEstimate: ceiling + 1 },
        { threadId: "at-limit", sentAt: NOW - 2 * HOUR, sizeEstimate: ceiling },
        { threadId: "unsized", sentAt: NOW - 150 * 60_000, sizeEstimate: null },
        { threadId: "light", sentAt: NOW - 3 * HOUR, sizeEstimate: 60 * 1024 },
      ],
      "200",
    );
    await expect(
      fixture.content.refreshBackgroundPrivacyCohort(NOW),
    ).resolves.toEqual({ selectedMessages: 4, purgedContent: false });

    const order: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      const messageId = (await fixture.content.findBackgroundContentCandidate(NOW))
        ?.messageId;
      if (messageId === undefined) break;
      order.push(messageId);
      await claimLease(fixture.content, messageId, NOW);
    }
    expect(order).toEqual(["message-at-limit", "message-light"]);
    // The owner's open of the heavy one fetches it as before.
    await expect(
      fixture.content.claim("message-heavy", NOW),
    ).resolves.toMatchObject({ kind: "claimed" });
  });

  it("fetches images unasked only for the three newest messages of the last seven days", async () => {
    const fixture = await createFixture({ active: true });
    const entries = [
      { threadId: "one", sentAt: NOW - 1 * HOUR },
      { threadId: "two", sentAt: NOW - 2 * HOUR },
      { threadId: "three", sentAt: NOW - 8 * DAY },
      { threadId: "four", sentAt: NOW - 9 * DAY },
    ];
    activateThreads(fixture, entries, "200");
    const imageIds = new Map<string, string>();
    for (const [index, entry] of entries.entries()) {
      const messageId = `message-${entry.threadId}`;
      const remoteImageId = `remote-image-a${String(index + 1).repeat(32)}`;
      imageIds.set(messageId, remoteImageId);
      await publishBody(fixture, messageId, NOW, {
        raw: Buffer.from(`raw ${messageId}`),
        html: Buffer.from(`<img data-brain-remote-image="${remoteImageId}">`),
        remoteImages: [
          {
            remoteImageId,
            sourceUrl: `https://images.example.com/${entry.threadId}.png`,
          },
        ],
      });
    }
    await expect(
      fixture.content.refreshBackgroundPrivacyCohort(NOW),
    ).resolves.toEqual({ selectedMessages: 4, purgedContent: false });
    for (const messageId of imageIds.keys()) {
      await fixture.content.markBackgroundContentPrefetchStarted(messageId, NOW);
    }

    // Every body is in the cohort, but the images a sync may fetch without
    // an open are still those of the newest three inside seven days.
    const pending = async (messageId: string) =>
      fixture.content.listPendingRemoteImages(messageId, NOW);
    await expect(pending("message-one")).resolves.toEqual([
      imageIds.get("message-one"),
    ]);
    await expect(pending("message-two")).resolves.toEqual([
      imageIds.get("message-two"),
    ]);
    await expect(pending("message-three")).resolves.toEqual([]);
    await expect(pending("message-four")).resolves.toEqual([]);

    // Opening a message outside that prefix is what approves its images.
    await fixture.content.recordUserContentDemand("message-four", NOW);
    await expect(pending("message-four")).resolves.toEqual([
      imageIds.get("message-four"),
    ]);
  });

  it("counts every blob a ready body holds toward the budget", async () => {
    const fixture = await createFixture({ active: true });
    await expect(fixture.content.readBodyCacheBytes()).resolves.toBe(0);
    const raw = Buffer.from("raw MIME for the budget");
    const text = Buffer.from("plain text part");
    const html = Buffer.from("<p>html part</p>");
    const attachment = Buffer.from("attachment bytes that count too");
    const remoteImageId = `remote-image-a${"c".repeat(32)}`;
    await publishBody(fixture, "message-thread-a", 100, {
      raw,
      text,
      html,
      attachment,
      remoteImages: [
        { remoteImageId, sourceUrl: "https://images.example.com/counted.png" },
      ],
    });
    const parts =
      raw.byteLength + text.byteLength + html.byteLength + attachment.byteLength;
    await expect(fixture.content.readBodyCacheBytes()).resolves.toBe(parts);

    // A fetched image is on disk because of the body, so it counts as well.
    const pending = await fixture.content.inspectRemoteImage(remoteImageId, 101);
    if (pending?.state !== "pending") throw new Error("expected a pending image");
    const image = testPng(3, 2);
    await fixture.content.storeRemoteImage({
      snapshot: pending,
      mimeType: "image/png",
      data: image,
      raster: { width: 3, height: 2, frames: 1 },
      now: 102,
    });
    await expect(fixture.content.readBodyCacheBytes()).resolves.toBe(
      parts + image.byteLength,
    );
  });

  it("evicts the body least recently sent or opened first, never a pinned one", async () => {
    const fixture = await createFixture({ active: true });
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6"];
    activateThreads(
      fixture,
      ids.map((id, index) => ({ threadId: id, sentAt: NOW - (index + 1) * HOUR })),
      "200",
    );
    for (const id of ids) {
      await publishBody(fixture, `message-${id}`, NOW - 3 * HOUR, {
        raw: Buffer.alloc(100, id),
      });
    }
    // m4 was read long ago; m5 is open in a reader right now.
    await fixture.content.recordUserContentDemand(
      "message-m4",
      NOW - MAIL_BODY_OPEN_PIN_MS - HOUR,
    );
    await fixture.content.recordUserContentDemand("message-m5", NOW - 60_000);
    await expect(fixture.content.readBodyCacheBytes()).resolves.toBe(600);

    // One key: when the body was sent or last opened, whichever is later. m2
    // is the source of a draft. Eviction stops the moment the account is at
    // the budget, not one body past it.
    await expect(
      fixture.content.evictBodiesOverBudget({
        maxBytes: 400,
        now: NOW,
        pinnedMessageIds: ["message-m2"],
      }),
    ).resolves.toEqual({
      evictedMessages: 2,
      remainingBytes: 400,
      oldestKeptKey: NOW - 2 * HOUR,
    });
    const state = async (id: string) =>
      (await fixture.content.inspect(`message-${id}`)).kind;
    expect(
      await Promise.all(ids.map(async (id) => [id, await state(id)])),
    ).toEqual([
      ["m1", "ready"],
      ["m2", "ready"],
      ["m3", "not_requested"],
      ["m4", "ready"],
      ["m5", "ready"],
      ["m6", "not_requested"],
    ]);

    // An opened body is not kept for good: m4, opened two hours ago, goes
    // before m1, sent an hour ago. What is pinned stays even when the budget
    // cannot be met without it, and then nothing is left to give up.
    await expect(
      fixture.content.evictBodiesOverBudget({
        maxBytes: 0,
        now: NOW,
        pinnedMessageIds: ["message-m2"],
      }),
    ).resolves.toEqual({
      evictedMessages: 2,
      remainingBytes: 200,
      oldestKeptKey: null,
    });
    await expect(state("m4")).resolves.toBe("not_requested");
    await expect(state("m1")).resolves.toBe("not_requested");
    await expect(state("m2")).resolves.toBe("ready");
    await expect(state("m5")).resolves.toBe("ready");
    await expect(fixture.content.collectGarbage()).resolves.toHaveLength(4);
  });

  it("gives up a body only an open fetches before any other, but not a prefetched one", async () => {
    const fixture = await createFixture({ active: true });
    const large = MAIL_RESOURCE_LIMITS.privacyPrefetchMaxThreadBytes;
    const ids = ["new", "big", "heavy", "old", "older"];
    activateThreads(
      fixture,
      ids.map((id, index) => ({ threadId: id, sentAt: NOW - (index + 1) * HOUR })),
      "200",
    );
    // big's raw message is past the prefetch's size, so only an open fetched
    // it; heavy's is not, though what it holds on disk is, with its file.
    for (const [index, id] of ids.entries()) {
      await publishWhole(
        fixture,
        `message-${id}`,
        NOW - 5 * HOUR,
        Buffer.alloc(id === "big" ? large + 1 : 100, index + 1),
        id === "heavy" ? Buffer.alloc(large, 9) : null,
      );
    }
    const total = 2 * large + 401;
    await expect(fixture.content.readBodyCacheBytes()).resolves.toBe(total);
    const evict = (maxBytes: number) =>
      fixture.content.evictBodiesOverBudget({ maxBytes, now: NOW, pinnedMessageIds: [] });

    // At the budget big is the next to go, so a letter of any age the
    // prefetch adds would push out that one and not itself.
    await expect(evict(total)).resolves.toEqual({
      evictedMessages: 0,
      remainingBytes: total,
      oldestKeptKey: 0,
    });
    // Over by one small body, big goes rather than the oldest.
    await expect(evict(total - 100)).resolves.toEqual({
      evictedMessages: 1,
      remainingBytes: large + 400,
      oldestKeptKey: NOW - 5 * HOUR,
    });
    // From there it is least recently used again: heavy is not first.
    await expect(evict(large + 300)).resolves.toEqual({
      evictedMessages: 1,
      remainingBytes: large + 300,
      oldestKeptKey: NOW - 4 * HOUR,
    });
    const state = async (id: string) =>
      (await fixture.content.inspect(`message-${id}`)).kind;
    expect(await Promise.all(ids.map(state))).toEqual([
      "ready",
      "not_requested",
      "ready",
      "ready",
      "not_requested",
    ]);
  });

  it("prefetches a body the budget evicted again only once there is room for it", async () => {
    const fixture = await createFixture({ active: true });
    await fixture.content.refreshBackgroundPrivacyCohort(1_000);
    await expect(
      fixture.content.findBackgroundContentCandidate(1_000),
    ).resolves.toEqual({ messageId: "message-thread-a", estimatedBytes: 2_048 });
    await fixture.content.markBackgroundContentPrefetchStarted(
      "message-thread-a",
      1_000,
    );
    const raw = Buffer.from("raw MIME the budget will not keep");
    await publishBody(fixture, "message-thread-a", 1_001, { raw });
    await expect(
      fixture.content.evictBodiesOverBudget({
        maxBytes: 0,
        now: 1_002,
        pinnedMessageIds: [],
      }),
    ).resolves.toEqual({ evictedMessages: 1, remainingBytes: 0, oldestKeptKey: null });

    await fixture.content.refreshBackgroundPrivacyCohort(1_003);
    await expect(
      fixture.content.findBackgroundContentCandidate(1_003),
    ).resolves.toBeNull();
    await expect(
      fixture.content.findBackgroundContentCandidate(1_003, null, raw.byteLength - 1),
    ).resolves.toBeNull();
    // Room for what it held, which the eviction recorded, brings it back.
    await expect(
      fixture.content.findBackgroundContentCandidate(1_003, null, raw.byteLength),
    ).resolves.toEqual({
      messageId: "message-thread-a",
      estimatedBytes: raw.byteLength,
    });
    // An owner's open still fetches it again.
    await expect(
      fixture.content.claim("message-thread-a", 1_004),
    ).resolves.toMatchObject({ kind: "claimed" });
  });

  it("checks a fetch's lease before its provider streams a byte", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 1_000);
    await fixture.content.voidInterruptedLeases();
    fixture.clock.now = 1_001;
    let pulled = false;
    await expect(
      fixture.content.incomingBlobStore(lease).putIncoming(
        (async function* () {
          pulled = true;
          yield Buffer.from("raw MIME");
        })(),
        1024,
      ),
    ).rejects.toMatchObject({ code: "mail_content_lease_stale" });
    expect(pulled).toBe(false);
  });

  it("removes a received body the cache has no room to publish", async () => {
    const fixture = await createFixture({ active: true, maxCacheBytes: 16 });
    const lease = await claimLease(fixture.content, "message-thread-a", 1_000);
    fixture.clock.now = 1_001;
    await expect(
      fixture.content
        .incomingBlobStore(lease)
        .putIncoming(chunks(Buffer.alloc(64, 1), 8), 1024),
    ).rejects.toThrow();
    await expect(
      readdir(path.join(fixture.cacheRoot, ACCOUNT_ID, "content-incoming")),
    ).resolves.toEqual([]);
  });

  it("voids the leases a process that stopped mid-fetch left behind", async () => {
    const fixture = await createFixture({ active: true });
    const lease = await claimLease(fixture.content, "message-thread-a", 1_000);
    // Still live by the clock: without the void an open would wait it out.
    await expect(
      fixture.content.claim("message-thread-a", 2_000),
    ).resolves.toMatchObject({ kind: "busy" });

    await expect(fixture.content.voidInterruptedLeases()).resolves.toBe(1);
    await expect(
      fixture.content.claim("message-thread-a", 2_001),
    ).resolves.toMatchObject({ kind: "claimed" });
    // The old worker can no longer commit.
    await expect(
      fixture.content.markFailure({
        lease,
        kind: "transient",
        errorCode: "late_worker",
        now: 2_002,
      }),
    ).rejects.toMatchObject({ code: "mail_content_lease_stale" });
  });

  it("adds the image and eviction columns to a cohort table written before them", async () => {
    const fixture = await createFixture({ active: true });
    await fixture.content.refreshBackgroundPrivacyCohort(1_000);
    await fixture.content.close();
    const legacy = new DatabaseSync(fixture.databasePath);
    try {
      legacy.exec(
        `ALTER TABLE message_content_privacy_cohort DROP COLUMN remote_image_prefetch;
         ALTER TABLE message_content_privacy_cohort DROP COLUMN content_evicted_at;
         ALTER TABLE message_content_privacy_cohort DROP COLUMN content_evicted_bytes;`,
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
    await expect(
      reopened.refreshBackgroundPrivacyCohort(1_001),
    ).resolves.toEqual({ selectedMessages: 1, purgedContent: false });
    expect(readCohort(fixture.databasePath)).toEqual([
      {
        messageId: "message-thread-a",
        remoteImagePrefetch: 1,
        evictedAt: null,
        evictedBytes: null,
      },
    ]);
  });
});

function readCohort(databasePath: string): {
  readonly messageId: string;
  readonly remoteImagePrefetch: number;
  readonly evictedAt: number | null;
  readonly evictedBytes: number | null;
}[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT cohort.provider_message_id, cohort.remote_image_prefetch,
                cohort.content_evicted_at, cohort.content_evicted_bytes
           FROM message_content_privacy_cohort AS cohort
           JOIN messages AS message
             ON message.account_id = cohort.account_id
            AND message.generation = cohort.source_generation
            AND message.message_id = cohort.provider_message_id
          ORDER BY message.sent_at DESC, message.message_id DESC`,
      )
      .all()
      .map((row) => ({
        messageId: row.provider_message_id as string,
        remoteImagePrefetch: row.remote_image_prefetch as number,
        evictedAt: row.content_evicted_at as number | null,
        evictedBytes: row.content_evicted_bytes as number | null,
      }));
  } finally {
    database.close();
  }
}

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
  inInbox = true,
  sizeEstimate: number | null = 2_048,
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
    inInbox,
    snippet: `Snippet ${threadId}`,
    textBody: `Body ${threadId}`,
    htmlBody: null,
    hasAttachments: false,
    rfcMessageId: `<${threadId}@example.test>`,
    references: Object.freeze([]),
    listMessage: false,
    category: "people",
    sizeEstimate,
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
    sizeBytes: sizeEstimate ?? 0,
    category: "people",
    newSender: false,
  });
  return Object.freeze({
    thread,
    messages: Object.freeze([message]),
    inInbox,
    mailboxes: inInbox
      ? Object.freeze(["all", "inbox"] as const)
      : Object.freeze(["all"] as const),
  });
}

/** Replaces the active generation with exactly these threads. */
function activateThreads(
  fixture: { readonly messages: SqliteMailMessageCache },
  threads: readonly {
    readonly threadId: string;
    readonly sentAt: number;
    readonly inInbox?: boolean;
    /** Null is a size the provider did not give. */
    readonly sizeEstimate?: number | null;
  }[],
  historyId: string,
): void {
  const generation = fixture.messages.beginInitial(historyId);
  fixture.messages.putInitialPage(
    generation,
    threads.map((entry) =>
      threadFixture(
        entry.threadId,
        entry.sentAt,
        ACCOUNT_ID,
        entry.inInbox ?? true,
        entry.sizeEstimate,
      ),
    ),
    null,
    null,
  );
  fixture.messages.completeInitial(generation, 1);
}

/** Commits a ready body staged in one chunk each, for bodies of megabytes. */
async function publishWhole(
  fixture: { readonly content: SqliteMailContentCache },
  messageId: string,
  now: number,
  raw: Buffer,
  attachment: Buffer | null,
) {
  const lease = await claimLease(fixture.content, messageId, now);
  for (const value of attachment === null ? [raw] : [raw, attachment]) {
    await fixture.content.stageBlob(
      lease,
      descriptorFor(value),
      chunks(value, value.byteLength),
      now,
    );
  }
  return fixture.content.commitReady({
    lease,
    rawMime: descriptorFor(raw),
    text: null,
    sanitizedHtml: null,
    attachments:
      attachment === null
        ? []
        : [
            {
              filename: "large.bin",
              mimeType: "application/octet-stream",
              disposition: "attachment" as const,
              contentId: null,
              blob: descriptorFor(attachment),
            },
          ],
    remoteImages: [],
    now,
  });
}

/** Commits a ready body for one message: raw MIME plus any extra parts. */
async function publishBody(
  fixture: { readonly content: SqliteMailContentCache },
  messageId: string,
  now: number,
  parts: {
    readonly raw: Buffer;
    readonly text?: Buffer;
    readonly html?: Buffer;
    readonly attachment?: Buffer;
    readonly remoteImages?: readonly {
      readonly remoteImageId: string;
      readonly sourceUrl: string;
    }[];
  },
) {
  const lease = await claimLease(fixture.content, messageId, now);
  for (const value of [parts.raw, parts.text, parts.html, parts.attachment]) {
    if (value !== undefined) await stage(fixture, lease, value, now);
  }
  return fixture.content.commitReady({
    lease,
    rawMime: descriptorFor(parts.raw),
    text: parts.text === undefined ? null : descriptorFor(parts.text),
    sanitizedHtml: parts.html === undefined ? null : descriptorFor(parts.html),
    attachments:
      parts.attachment === undefined
        ? []
        : [
            {
              filename: "file.bin",
              mimeType: "application/octet-stream",
              disposition: "attachment" as const,
              contentId: null,
              blob: descriptorFor(parts.attachment),
            },
          ],
    remoteImages: parts.remoteImages ?? [],
    now,
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
