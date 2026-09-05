import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailThreadListItem } from "../message-types";
import type { MailBlobDescriptor } from "../ports";
import { MAIL_RESOURCE_LIMITS } from "../security";
import { FakeMailContentWorkRunner } from "../testing/content-fakes";
import type { MultiMailAccountStore } from "./account-store";
import { AtomicMailBlobStore } from "./content-blob-store";
import { SqliteMailContentCache } from "./content-cache";
import {
  ExponentialMailContentRetryPolicy,
  InMemoryMailContentWorkQueue,
  MailContentCoordinator,
  type MailContentCoordinatorEvent,
  MailContentServiceError,
  MailContentWorkError,
  type MailContentWorkInput,
} from "./content-coordinator";
import {
  type CachedProviderMessage,
  type CachedProviderThread,
  SqliteMailMessageCache,
} from "./message-cache";
import {
  RemoteImageFetchError,
  type RemoteImageFetcherPort,
} from "./remote-image-fetcher";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const SECOND_ACCOUNT_ID = "account-a22222222222222222222222222222222";
const MESSAGE_ID = "message-thread-a";
const roots: string[] = [];
const messageCaches: SqliteMailMessageCache[] = [];
const coordinators: MailContentCoordinator[] = [];
const workQueues: InMemoryMailContentWorkQueue[] = [];

afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((value) => value.close()));
  await Promise.all(workQueues.splice(0).map((value) => value.close()));
  for (const cache of messageCaches.splice(0)) cache.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("MailContentCoordinator", () => {
  it("returns immediately, coalesces duplicate POST work, and publishes ready content", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const started = deferred<void>();
    const release = deferred<void>();
    const runner = new FakeMailContentWorkRunner([
      async (input) => {
        started.resolve();
        await release.promise;
        await publish(input, {
          text: Buffer.from("plain body"),
          html: Buffer.from("<p>safe body</p>"),
          attachment: Buffer.from("attachment bytes"),
          filename: "report.pdf",
        });
      },
    ]);
    const coordinator = fixture.coordinator(runner);

    await expect(
      coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toEqual({
      apiVersion: 1,
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
      state: "not_requested",
    });
    await expect(
      coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "fetching" });
    await started.promise;
    await expect(
      coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "fetching" });
    expect(runner.calls).toHaveLength(1);

    release.resolve();
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({
        state: "ready",
        textBody: "plain body",
        htmlBody: "<p>safe body</p>",
        attachments: [
          {
            filename: "report.pdf",
            mimeType: "application/octet-stream",
            bytes: 16,
          },
        ],
      });
    });
  });

  it("uses content-only retry policy and keeps permanent failures terminal", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const retryRunner = new FakeMailContentWorkRunner([
      () => {
        throw new MailContentWorkError("transient", "source_transient");
      },
      (input) => publish(input, { text: Buffer.from("after retry") }),
    ]);
    const retryCoordinator = fixture.coordinator(retryRunner, {
      nextDelayMs: () => 0,
    });
    await retryCoordinator.requestContent({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
    });
    await vi.waitFor(async () => {
      await expect(
        retryCoordinator.getContent({
          accountId: ACCOUNT_ID,
          messageId: MESSAGE_ID,
        }),
      ).resolves.toMatchObject({ state: "ready", textBody: "after retry" });
    });
    expect(retryRunner.calls).toHaveLength(2);
    await retryCoordinator.close();

    const permanentFixture = await createFixture([ACCOUNT_ID]);
    const permanentRunner = new FakeMailContentWorkRunner([
      () => {
        throw new MailContentWorkError("permanent", "mime_rejected");
      },
    ]);
    const permanent = permanentFixture.coordinator(permanentRunner);
    await permanent.requestContent({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
    });
    await vi.waitFor(async () => {
      await expect(
        permanent.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "permanent" });
    });
    expect(permanentRunner.calls).toHaveLength(1);
  });

  it("waits for manual OAuth reconnect before retrying reauthentication failures", async () => {
    const policy = new ExponentialMailContentRetryPolicy();
    expect(
      policy.nextDelayMs({
        accountId: ACCOUNT_ID,
        providerMessageId: MESSAGE_ID,
        attempt: 1,
        errorCode: "mail_content_source_reauth_required",
      }),
    ).toBeNull();

    const fixture = await createFixture([ACCOUNT_ID]);
    const runner = new FakeMailContentWorkRunner([
      () => {
        throw new MailContentWorkError(
          "transient",
          "mail_content_source_reauth_required",
        );
      },
      (input) => publish(input, { text: Buffer.from("after OAuth reconnect") }),
    ]);
    const coordinator = fixture.coordinator(runner);

    await coordinator.requestContent({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
    });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "transient" });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.calls).toHaveLength(1);

    await coordinator.requestContent({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
    });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({
        state: "ready",
        textBody: "after OAuth reconnect",
      });
    });
    expect(runner.calls).toHaveLength(2);
  });

  it("runs at most two fetch and parse workflows at a time", async () => {
    expect(MAIL_RESOURCE_LIMITS.concurrentMimeParsers).toBe(2);
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    for (const [index, messageId] of [
      "message-queue-a",
      "message-queue-b",
      "message-queue-c",
    ].entries()) {
      queue.enqueue({
        accountId: ACCOUNT_ID,
        providerMessageId: messageId,
        async run() {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          started.push(messageId);
          await releases[index]!.promise;
          active -= 1;
          return { kind: "complete" };
        },
      });
    }

    await vi.waitFor(() =>
      expect(started).toEqual(["message-queue-a", "message-queue-b"]),
    );
    releases[0]!.resolve();
    await vi.waitFor(() =>
      expect(started).toEqual([
        "message-queue-a",
        "message-queue-b",
        "message-queue-c",
      ]),
    );
    releases[1]!.resolve();
    releases[2]!.resolve();
    await vi.waitFor(() => expect(active).toBe(0));
    expect(maximumActive).toBe(MAIL_RESOURCE_LIMITS.concurrentMimeParsers);
  });

  it("coalesces duplicates before rejecting a full pending queue", async () => {
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 2 });
    workQueues.push(queue);
    const started = deferred<void>();
    const release = deferred<void>();
    queue.enqueue({
      accountId: ACCOUNT_ID,
      providerMessageId: "message-queue-running",
      async run() {
        started.resolve();
        await release.promise;
        return { kind: "complete" };
      },
    });
    await started.promise;
    const complete = async () => ({ kind: "complete" as const });
    expect(
      queue.enqueue({
        accountId: ACCOUNT_ID,
        providerMessageId: "message-queue-b",
        run: complete,
      }),
    ).toBe("queued");
    expect(
      queue.enqueue({
        accountId: ACCOUNT_ID,
        providerMessageId: "message-queue-b",
        run: complete,
      }),
    ).toBe("coalesced");
    expect(
      queue.enqueue({
        accountId: ACCOUNT_ID,
        providerMessageId: "message-queue-c",
        run: complete,
      }),
    ).toBe("queued");
    expect(() =>
      queue.enqueue({
        accountId: ACCOUNT_ID,
        providerMessageId: "message-queue-overflow",
        run: complete,
      }),
    ).toThrow(
      expect.objectContaining({
        kind: "transient",
        errorCode: "queue_full",
      }),
    );
    release.resolve();
  });

  it("aborts running work and drops pending work for only the drained account", async () => {
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const runningStarted = deferred<void>();
    const otherStarted = deferred<void>();
    let pendingAccountWork = 0;
    queue.enqueue({
      accountId: ACCOUNT_ID,
      providerMessageId: "message-queue-running",
      async run(signal) {
        runningStarted.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { kind: "complete" };
      },
    });
    await runningStarted.promise;
    queue.enqueue({
      accountId: ACCOUNT_ID,
      providerMessageId: "message-queue-pending",
      async run() {
        pendingAccountWork += 1;
        return { kind: "complete" };
      },
    });
    queue.enqueue({
      accountId: SECOND_ACCOUNT_ID,
      providerMessageId: "message-queue-other",
      async run() {
        otherStarted.resolve();
        return { kind: "complete" };
      },
    });

    await queue.abortAndDrainAccount(ACCOUNT_ID);
    await otherStarted.promise;
    expect(pendingAccountWork).toBe(0);
    expect(queue.has(ACCOUNT_ID, "message-queue-running")).toBe(false);
    expect(queue.has(ACCOUNT_ID, "message-queue-pending")).toBe(false);
  });

  it("invalidates the exact ready snapshot when a body blob read fails", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    let work: MailContentWorkInput | null = null;
    const text = Buffer.from("cached body");
    const runner = new FakeMailContentWorkRunner([
      async (input) => {
        work = input;
        await publish(input, { text });
      },
    ]);
    const coordinator = fixture.coordinator(runner);
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });
    const captured = work as MailContentWorkInput | null;
    if (captured === null) throw new Error("work did not start");
    await captured.blobStore.remove(descriptor(text));

    await expect(
      coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toEqual({
      apiVersion: 1,
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
      state: "transient",
    });
    await expect(captured.cache.inspect(MESSAGE_ID)).resolves.toMatchObject({
      kind: "transient_failure",
    });
  });

  it("binds attachment ids to the requested account", async () => {
    const fixture = await createFixture([ACCOUNT_ID, SECOND_ACCOUNT_ID]);
    const runner = new FakeMailContentWorkRunner([
      (input) =>
        publish(input, {
          attachment: Buffer.from("owned bytes"),
          filename: "owned.bin",
        }),
    ]);
    const coordinator = fixture.coordinator(runner);
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    let attachmentId = "";
    await vi.waitFor(async () => {
      const result = await coordinator.getContent({
        accountId: ACCOUNT_ID,
        messageId: MESSAGE_ID,
      });
      if (result.state !== "ready") throw new Error("content is not ready");
      attachmentId = result.attachments[0]!.attachmentId;
    });

    const owned = await coordinator.downloadAttachment({
      accountId: ACCOUNT_ID,
      attachmentId,
    });
    expect((await collectBytes(owned.body)).toString("utf8")).toBe("owned bytes");
    await owned.dispose();
    await expect(
      coordinator.downloadAttachment({
        accountId: SECOND_ACCOUNT_ID,
        attachmentId,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "mail_content_attachment_not_found",
      }),
    );
  });

  it("keeps reader downloads cache-only while the demand-started fetch is in flight", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const remoteImageId = `remote-image-a${"9".repeat(32)}`;
    const sourceUrl = "https://images.example.com/campaign.png?private=origin";
    const started = deferred<void>();
    const release = deferred<void>();
    const image = testPng(10, 10);
    const fetch = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return {
        mimeType: "image/png",
        data: Buffer.from(image),
        raster: { width: 10, height: 10, frames: 1 },
      };
    });
    const runner = new FakeMailContentWorkRunner([
      (input) =>
        publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${remoteImageId}" alt="Campaign">`,
          ),
          remoteImages: [{ remoteImageId, sourceUrl }],
        }),
    ]);
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
    );
    await coordinator.requestContent({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
    });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });

    // The ready commit dialed the origin on its own. The reader endpoint
    // still answers from the cache alone: it neither starts a fetch nor
    // waits for the one in flight.
    await started.promise;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      sourceUrl,
      {
        maxBytes: MAIL_RESOURCE_LIMITS.maxRemoteImageBytesPerMessage,
        maxPixels: MAIL_RESOURCE_LIMITS.maxInlineImagePixels,
        maxFrames: MAIL_RESOURCE_LIMITS.maxInlineImageFrames,
      },
      expect.any(AbortSignal),
    );
    await expect(
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId }),
    ).rejects.toMatchObject({ code: "mail_content_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);

    release.resolve();
    const cached = await vi.waitFor(() =>
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId }),
    );
    await expect(collectBytes(cached.body)).resolves.toEqual(image);
    await cached.dispose();

    // Scheduler passes afterwards add no second dial.
    for (let pass = 0; pass < 2; pass += 1) {
      await coordinator.runBackgroundPrefetchStep(
        ACCOUNT_ID,
        new AbortController().signal,
      );
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches an opened message's images on demand without a scheduler pass", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const firstId = `remote-image-a${"d".repeat(32)}`;
    const secondId = `remote-image-a${"e".repeat(32)}`;
    const firstUrl = "https://images.example.com/first-on-demand.png";
    const secondUrl = "https://images.example.com/second-on-demand.png";
    const image = testPng(10, 10);
    const fetch = vi.fn(async (_requestedUrl: string) => ({
      mimeType: "image/png",
      data: Buffer.from(image),
      raster: { width: 10, height: 10, frames: 1 },
    }));
    const runner = new FakeMailContentWorkRunner([
      (input) =>
        publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${firstId}"><img data-brain-remote-image="${secondId}">`,
          ),
          remoteImages: [
            { remoteImageId: firstId, sourceUrl: firstUrl },
            { remoteImageId: secondId, sourceUrl: secondUrl },
          ],
        }),
    ]);
    const events: MailContentCoordinatorEvent[] = [];
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
      undefined,
      undefined,
      (event) => events.push(event),
    );

    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    // No scheduler pass ever runs: the owner's demand alone fills the cache.
    for (const remoteImageId of [firstId, secondId]) {
      const cached = await vi.waitFor(() =>
        coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId }),
      );
      await expect(collectBytes(cached.body)).resolves.toEqual(image);
      await cached.dispose();
    }
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([firstUrl, secondUrl]);
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        event: "mail_remote_image_drain_finished",
      }),
    );
    expect(events).toEqual([
      {
        event: "mail_remote_image_drain_started",
        accountId: ACCOUNT_ID,
        attachmentCount: 2,
      },
      {
        event: "mail_remote_image_settled",
        accountId: ACCOUNT_ID,
        phase: "fetched",
        cacheBytes: image.byteLength,
      },
      {
        event: "mail_remote_image_settled",
        accountId: ACCOUNT_ID,
        phase: "fetched",
        cacheBytes: image.byteLength,
      },
      {
        event: "mail_remote_image_drain_finished",
        accountId: ACCOUNT_ID,
        attachmentCount: 2,
      },
    ]);
  });

  it("retries an expired transient image when the message is opened again and logs each refusal", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const now = { value: 1_000 };
    const blockedId = `remote-image-a${"f".repeat(32)}`;
    const flakyId = `remote-image-a${"0".repeat(32)}`;
    const blockedUrl = "https://images.example.com/pixel.gif";
    const flakyUrl = "https://images.example.com/flaky.png";
    const image = testPng(10, 10);
    let flakyDials = 0;
    const fetch = vi.fn(async (requestedUrl: string) => {
      if (requestedUrl === blockedUrl) {
        throw new RemoteImageFetchError(
          "permanent",
          "remote_image_tracking_pixel_blocked",
        );
      }
      flakyDials += 1;
      if (flakyDials === 1) {
        throw new RemoteImageFetchError(
          "transient",
          "remote_image_origin_unavailable",
        );
      }
      return {
        mimeType: "image/png",
        data: Buffer.from(image),
        raster: { width: 10, height: 10, frames: 1 },
      };
    });
    const runner = new FakeMailContentWorkRunner([
      (input) =>
        publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${blockedId}"><img data-brain-remote-image="${flakyId}">`,
          ),
          remoteImages: [
            { remoteImageId: blockedId, sourceUrl: blockedUrl },
            { remoteImageId: flakyId, sourceUrl: flakyUrl },
          ],
        }),
    ]);
    const events: MailContentCoordinatorEvent[] = [];
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
      () => now.value,
      undefined,
      (event) => events.push(event),
    );

    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        event: "mail_remote_image_drain_finished",
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      {
        event: "mail_remote_image_drain_started",
        accountId: ACCOUNT_ID,
        attachmentCount: 2,
      },
      {
        event: "mail_remote_image_settled",
        accountId: ACCOUNT_ID,
        phase: "blocked",
        errorCode: "remote_image_tracking_pixel_blocked",
      },
      {
        event: "mail_remote_image_settled",
        accountId: ACCOUNT_ID,
        phase: "transient",
        errorCode: "remote_image_origin_unavailable",
        durationBucket: "under_10m",
      },
      {
        event: "mail_remote_image_drain_finished",
        accountId: ACCOUNT_ID,
        attachmentCount: 2,
      },
    ]);

    // Inside the retry window a re-open has nothing to take.
    events.length = 0;
    await expect(
      coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "ready" });
    await expect(
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId: flakyId }),
    ).rejects.toMatchObject({ code: "mail_content_unavailable" });

    // Once it has passed, opening the message again retries the flaky image
    // at once and leaves the blocked one alone.
    now.value += MAIL_RESOURCE_LIMITS.remoteImageTransientRetryMs;
    await expect(
      coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "ready" });
    const cached = await vi.waitFor(() =>
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId: flakyId }),
    );
    await expect(collectBytes(cached.body)).resolves.toEqual(image);
    await cached.dispose();
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId: blockedId }),
    ).rejects.toMatchObject({ code: "mail_content_remote_image_not_found" });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        event: "mail_remote_image_drain_finished",
      }),
    );
    expect(events).toEqual([
      {
        event: "mail_remote_image_drain_started",
        accountId: ACCOUNT_ID,
        attachmentCount: 1,
      },
      {
        event: "mail_remote_image_settled",
        accountId: ACCOUNT_ID,
        phase: "fetched",
        cacheBytes: image.byteLength,
      },
      {
        event: "mail_remote_image_drain_finished",
        accountId: ACCOUNT_ID,
        attachmentCount: 1,
      },
    ]);
  });

  it("lets a scheduler pass that joined a demand-started fetch abort without waiting on the origin", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const remoteImageId = `remote-image-a${"1".repeat(32)}`;
    const started = deferred<void>();
    const release = deferred<void>();
    const image = testPng(10, 10);
    const fetch = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return {
        mimeType: "image/png",
        data: Buffer.from(image),
        raster: { width: 10, height: 10, frames: 1 },
      };
    });
    const runner = new FakeMailContentWorkRunner([
      (input) =>
        publish(input, {
          html: Buffer.from(`<img data-brain-remote-image="${remoteImageId}">`),
          remoteImages: [
            {
              remoteImageId,
              sourceUrl: "https://images.example.com/joined.png",
            },
          ],
        }),
    ]);
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
    );
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await started.promise;

    const controller = new AbortController();
    const joined = coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(joined).rejects.toMatchObject({ code: "mail_content_unavailable" });

    // The demand-started fetch itself is untouched by the scheduler's abort.
    release.resolve();
    const cached = await vi.waitFor(() =>
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId }),
    );
    await expect(collectBytes(cached.body)).resolves.toEqual(image);
    await cached.dispose();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("prefetches an eligible recent Inbox message without a reader request", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const remoteImageId = `remote-image-a${"3".repeat(32)}`;
    const image = testPng(10, 10);
    const fetch = vi.fn(async () => ({
      mimeType: "image/png",
      data: Buffer.from(image),
      raster: { width: 10, height: 10, frames: 1 },
    }));
    const runner = new FakeMailContentWorkRunner([
      (input) =>
        publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${remoteImageId}" alt="Recent">`,
          ),
          remoteImages: [
            {
              remoteImageId,
              sourceUrl: "https://images.example.com/recent.png",
            },
          ],
        }),
    ]);
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
    );

    await expect(
      coordinator.runBackgroundPrefetchStep(
        ACCOUNT_ID,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ hasMore: true });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });

    // The ready commit drains the cohort message's images itself, so the
    // next scheduler pass finds nothing left for this account.
    const cached = await vi.waitFor(() =>
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId }),
    );
    await cached.dispose();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      coordinator.runBackgroundPrefetchStep(
        ACCOUNT_ID,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ hasMore: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("loads an old out-of-cohort message's remote images after the reader opens it", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const remoteImageId = `remote-image-a${"4".repeat(32)}`;
    const image = testPng(10, 10);
    const fetch = vi.fn(async () => ({
      mimeType: "image/png",
      data: Buffer.from(image),
      raster: { width: 10, height: 10, frames: 1 },
    }));
    const runner = new FakeMailContentWorkRunner([
      (input) =>
        publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${remoteImageId}" alt="Old">`,
          ),
          remoteImages: [
            {
              remoteImageId,
              sourceUrl: "https://images.example.com/old.png",
            },
          ],
        }),
    ]);
    const now = MAIL_RESOURCE_LIMITS.privacyPrefetchMaxAgeMs + 10_000;
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
      () => now,
    );
    // Too old for the background cohort: nothing is eligible before the open.
    await expect(
      coordinator.runBackgroundPrefetchStep(
        ACCOUNT_ID,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ hasMore: false });
    expect(fetch).not.toHaveBeenCalled();

    // Opening the message records an owner demand and fills its images at
    // once, even though the message never joins the cohort; the scheduler
    // pass afterwards has nothing left to take.
    await coordinator.requestContent({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
    });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });
    const cached = await vi.waitFor(() =>
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId }),
    );
    await expect(collectBytes(cached.body)).resolves.toEqual(image);
    await cached.dispose();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      coordinator.runBackgroundPrefetchStep(
        ACCOUNT_ID,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ hasMore: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lets a reader retry re-claim failed background content work immediately", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const now = { value: 1_000 };
    const remoteImageId = `remote-image-a${"6".repeat(32)}`;
    const image = testPng(10, 10);
    const fetch = vi.fn(async () => ({
      mimeType: "image/png",
      data: Buffer.from(image),
      raster: { width: 10, height: 10, frames: 1 },
    }));
    const runner = new FakeMailContentWorkRunner([
      () => {
        throw new MailContentWorkError("transient", "source_transient");
      },
      (input) =>
        publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${remoteImageId}" alt="Retry">`,
          ),
          remoteImages: [
            {
              remoteImageId,
              sourceUrl: "https://images.example.com/retry.png",
            },
          ],
        }),
    ]);
    const coordinator = fixture.coordinator(
      runner,
      { nextDelayMs: () => null },
      { fetch } satisfies RemoteImageFetcherPort,
      () => now.value,
    );

    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "transient" });
    });
    expect(runner.calls).toHaveLength(1);

    // The owner's explicit request does not wait out the background retry
    // window: it re-claims the lease at once and reports fetching.
    await expect(
      coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "fetching" });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });
    expect(runner.calls).toHaveLength(2);
    // The re-claimed commit drains its own images; a scheduler pass
    // afterwards adds no second dial.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("claims and enqueues on owner demand when a started background prefetch left no content", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    // A background pass marked the message started and then never landed
    // content (restart before the fetch, or a format bump invalidated the
    // row): the cohort remembers the start while content reads as pending.
    const blobStore = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    const contentCache = new SqliteMailContentCache({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
      blobStore,
    });
    await contentCache.initialize();
    await contentCache.refreshBackgroundPrivacyCohort(1_000);
    await contentCache.markBackgroundContentPrefetchStarted(MESSAGE_ID, 1_000);
    await expect(
      contentCache.isBackgroundContentPrefetchStarted(MESSAGE_ID),
    ).resolves.toBe(true);
    await expect(contentCache.inspect(MESSAGE_ID)).resolves.toEqual({
      kind: "not_requested",
    });
    await contentCache.close();
    await blobStore.close();

    const runner = new FakeMailContentWorkRunner([
      (input) => publish(input, { text: Buffer.from("demanded body") }),
    ]);
    const coordinator = fixture.coordinator(runner);
    await expect(
      coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "not_requested" });

    // The owner opening the message must claim the lease and queue work
    // instead of echoing the pending snapshot back forever.
    await expect(
      coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "fetching" });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready", textBody: "demanded body" });
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("signals background work on owner demand and on each ready commit", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const runner = new FakeMailContentWorkRunner([
      (input) => publish(input, { text: Buffer.from("kicked body") }),
    ]);
    const onBackgroundWorkAvailable = vi.fn();
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      undefined,
      undefined,
      onBackgroundWorkAvailable,
    );

    await coordinator.requestContent({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
    });
    expect(onBackgroundWorkAvailable).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });
    await vi.waitFor(() =>
      expect(onBackgroundWorkAvailable).toHaveBeenCalledTimes(2),
    );

    // A throwing observer never breaks the demand path.
    onBackgroundWorkAvailable.mockImplementation(() => {
      throw new Error("scheduler unavailable");
    });
    await expect(
      coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(onBackgroundWorkAvailable).toHaveBeenCalledTimes(3);
  });

  it("keeps an opened N+1 Inbox message outside the stable top-N cohort", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const cache = fixture.caches[0]!;
    const recent = [
      { threadId: "thread-b", messageId: "message-thread-b", sentAt: 200 },
      { threadId: "thread-c", messageId: "message-thread-c", sentAt: 300 },
      { threadId: "thread-d", messageId: "message-thread-d", sentAt: 400 },
    ];
    cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: recent.map((candidate) => ({
        kind: "upsert" as const,
        value: threadFixture(ACCOUNT_ID, candidate),
      })),
      nextPageToken: null,
      resultingHistoryId: "101",
      now: 500,
    });
    const oldRemoteImageId = `remote-image-a${"5".repeat(32)}`;
    const expectedBackgroundOrder = recent.toReversed();
    const runner = new FakeMailContentWorkRunner([
      (input) => {
        expect(input.providerMessageId).toBe(MESSAGE_ID);
        return publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${oldRemoteImageId}" alt="Old">`,
          ),
          remoteImages: [
            {
              remoteImageId: oldRemoteImageId,
              sourceUrl: "https://images.example.com/n-plus-one.png",
            },
          ],
        });
      },
      ...expectedBackgroundOrder.map((candidate) => (input: MailContentWorkInput) => {
        expect(input.providerMessageId).toBe(candidate.messageId);
        return publish(input, { text: Buffer.from(candidate.messageId) });
      }),
    ]);
    const image = testPng(10, 10);
    const fetch = vi.fn(async () => ({
      mimeType: "image/png",
      data: Buffer.from(image),
      raster: { width: 10, height: 10, frames: 1 },
    }));
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
    );

    await coordinator.requestContent({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
    });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });

    // The opened N+1 message's image loads at once through its demand row,
    // but the message itself never displaces the stable top-N content cohort.
    const opened = await vi.waitFor(() =>
      coordinator.downloadRemoteImage({
        accountId: ACCOUNT_ID,
        remoteImageId: oldRemoteImageId,
      }),
    );
    await opened.dispose();
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const candidate of expectedBackgroundOrder) {
      await expect(
        coordinator.runBackgroundPrefetchStep(
          ACCOUNT_ID,
          new AbortController().signal,
        ),
      ).resolves.toEqual({ hasMore: true });
      await vi.waitFor(async () => {
        await expect(
          coordinator.getContent({
            accountId: ACCOUNT_ID,
            messageId: candidate.messageId,
          }),
        ).resolves.toMatchObject({ state: "ready" });
      });
    }
    await expect(
      coordinator.runBackgroundPrefetchStep(
        ACCOUNT_ID,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ hasMore: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    const cached = await coordinator.downloadRemoteImage({
      accountId: ACCOUNT_ID,
      remoteImageId: oldRemoteImageId,
    });
    await cached.dispose();
  });

  it("permanently stops remote fetches after the message raster budget is spent", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const firstId = `remote-image-a${"a".repeat(32)}`;
    const secondId = `remote-image-a${"b".repeat(32)}`;
    const firstUrl = "https://images.example.com/first.png";
    const secondUrl = "https://images.example.com/second.png";
    const image = testPng(3_000, 4_000);
    const fetch = vi.fn(
      async (requestedUrl: string, budget: unknown, signal?: AbortSignal) => {
        expect(requestedUrl).toBe(firstUrl);
        expect(budget).toMatchObject({ maxPixels: 12_000_000 });
        expect(signal?.aborted).toBe(false);
        return {
          mimeType: "image/png",
          data: Buffer.from(image),
          raster: { width: 3_000, height: 4_000, frames: 1 },
        };
      },
    );
    const runner = new FakeMailContentWorkRunner([
      (input) =>
        publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${firstId}"><img data-brain-remote-image="${secondId}">`,
          ),
          remoteImages: [
            { remoteImageId: firstId, sourceUrl: firstUrl },
            { remoteImageId: secondId, sourceUrl: secondUrl },
          ],
        }),
    ]);
    const events: MailContentCoordinatorEvent[] = [];
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
      undefined,
      undefined,
      (event) => events.push(event),
    );
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });

    // The demand-started drain takes the first image and refuses the second
    // against the spent raster budget without dialing for it.
    const first = await vi.waitFor(() =>
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId: firstId }),
    );
    await first.dispose();
    await vi.waitFor(async () => {
      await expect(
        coordinator.downloadRemoteImage({
          accountId: ACCOUNT_ID,
          remoteImageId: secondId,
        }),
      ).rejects.toMatchObject({ code: "mail_content_remote_image_not_found" });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(firstUrl);
    expect(events).toContainEqual({
      event: "mail_remote_image_settled",
      accountId: ACCOUNT_ID,
      phase: "budget_exhausted",
      errorCode: "remote_image_budget_exceeded",
    });
  });

  it("aborts detached image work without caching it as an image failure", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const remoteImageId = `remote-image-a${"c".repeat(32)}`;
    const sourceUrl = "https://images.example.com/abort.png";
    const started = deferred<void>();
    let attempt = 0;
    const image = testPng(10, 10);
    const fetch = vi.fn(
      async (requestedUrl: string, budget: unknown, signal?: AbortSignal) => {
        expect(requestedUrl).toBe(sourceUrl);
        expect(budget).toMatchObject({ maxPixels: 12_000_000 });
        attempt += 1;
        if (attempt > 1) {
          return {
            mimeType: "image/png",
            data: Buffer.from(image),
            raster: { width: 10, height: 10, frames: 1 },
          };
        }
        started.resolve();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                new RemoteImageFetchError(
                  "transient",
                  "remote_image_fetch_aborted",
                ),
              ),
            { once: true },
          );
        });
      },
    );
    const runner = new FakeMailContentWorkRunner([
      (input) =>
        publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${remoteImageId}">`,
          ),
          remoteImages: [{ remoteImageId, sourceUrl }],
        }),
    ]);
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
    );
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });

    // The ready commit started the fetch; tearing the account down aborts
    // it, and the abort leaves the row pending rather than failed.
    await started.promise;
    await coordinator.invalidateAccount(ACCOUNT_ID);
    coordinator.restoreInvalidatedAccount(ACCOUNT_ID);

    await expect(
      coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "ready" });
    const retried = await vi.waitFor(() =>
      coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId }),
    );
    await expect(collectBytes(retried.body)).resolves.toEqual(image);
    await retried.dispose();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps valid cached content ready when an attachment setup is cancelled", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const runner = new FakeMailContentWorkRunner([
      (input) => publish(input, { attachment: Buffer.from("cached bytes") }),
    ]);
    const coordinator = fixture.coordinator(runner);
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    let attachmentId = "";
    await vi.waitFor(async () => {
      const content = await coordinator.getContent({
        accountId: ACCOUNT_ID,
        messageId: MESSAGE_ID,
      });
      if (content.state !== "ready") throw new Error("content is not ready");
      attachmentId = content.attachments[0]!.attachmentId;
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      coordinator.downloadAttachment({
        accountId: ACCOUNT_ID,
        attachmentId,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "mail_content_unavailable" });
    await expect(
      coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "ready" });
  });

  it("aborts and drains content work, then closes content and blob handles before deletion", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const started = deferred<void>();
    const runner = new FakeMailContentWorkRunner([
      async (_input, signal) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    ]);
    const coordinator = fixture.coordinator(runner);
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await started.promise;
    await coordinator.invalidateAccount(ACCOUNT_ID);
    await expect(
      coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "mail_content_account_not_found" }),
    );

    fixture.caches[0]!.close();
    const accountDirectory = path.join(fixture.root, "cache", ACCOUNT_ID);
    const tombstone = path.join(fixture.root, `${ACCOUNT_ID}.deleting`);
    await rename(accountDirectory, tombstone);
    expect(await readdir(tombstone)).toContain("content-blobs");
  });

  it("rejects unknown accounts and inactive provider message ids", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const coordinator = fixture.coordinator(new FakeMailContentWorkRunner([]));
    await expect(
      coordinator.getContent({ accountId: SECOND_ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).rejects.toBeInstanceOf(MailContentServiceError);
    await expect(
      coordinator.getContent({ accountId: ACCOUNT_ID, messageId: "missing_message" }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "mail_content_message_not_found" }),
    );
  });
});

async function createFixture(accountIds: readonly string[]): Promise<{
  readonly root: string;
  readonly caches: readonly SqliteMailMessageCache[];
  coordinator(
    runner: FakeMailContentWorkRunner,
    retryPolicy?: { nextDelayMs(): number | null },
    remoteImageFetcher?: RemoteImageFetcherPort,
    clock?: () => number,
    onBackgroundWorkAvailable?: () => void,
    onEvent?: (event: MailContentCoordinatorEvent) => void,
  ): MailContentCoordinator;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-content-coordinator-"));
  roots.push(root);
  await mkdir(path.join(root, "cache"), { mode: 0o700 });
  const caches: SqliteMailMessageCache[] = [];
  for (const accountId of accountIds) {
    const cache = new SqliteMailMessageCache({
      cacheRoot: path.join(root, "cache"),
      accountId,
    });
    messageCaches.push(cache);
    caches.push(cache);
    await cache.initialize();
    const generation = cache.beginInitial("100");
    cache.putInitialPage(generation, [threadFixture(accountId)], null, null);
    cache.completeInitial(generation, 200);
  }
  const accounts = new Set(accountIds);
  const store = {
    readAccount: async (accountId: string) =>
      accounts.has(accountId) ? ({ account: { accountId } } as never) : null,
  } as unknown as MultiMailAccountStore;
  return {
    root,
    caches,
    coordinator(
      runner,
      retryPolicy,
      remoteImageFetcher,
      clock,
      onBackgroundWorkAvailable,
      onEvent,
    ) {
      const coordinator = new MailContentCoordinator({
        stateDirectory: root,
        store,
        runner,
        ...(retryPolicy === undefined ? {} : { retryPolicy }),
        ...(remoteImageFetcher === undefined ? {} : { remoteImageFetcher }),
        ...(onBackgroundWorkAvailable === undefined
          ? {}
          : { onBackgroundWorkAvailable }),
        ...(onEvent === undefined ? {} : { onEvent }),
        clock: clock ?? (() => 1_000),
      });
      coordinators.push(coordinator);
      return coordinator;
    },
  };
}

async function publish(
  input: MailContentWorkInput,
  values: {
    readonly text?: Buffer;
    readonly html?: Buffer;
    readonly attachment?: Buffer;
    readonly filename?: string;
    readonly remoteImages?: readonly {
      readonly remoteImageId: string;
      readonly sourceUrl: string;
    }[];
  },
): Promise<void> {
  const raw = Buffer.from("raw MIME");
  const candidates = [raw, values.text, values.html, values.attachment].filter(
    (value): value is Buffer => value !== undefined,
  );
  for (const value of candidates) {
    await input.cache.stageBlob(
      input.lease,
      descriptor(value),
      chunks(value),
      1_001,
    );
  }
  await input.cache.commitReady({
    lease: input.lease,
    rawMime: descriptor(raw),
    text: values.text === undefined ? null : descriptor(values.text),
    sanitizedHtml: values.html === undefined ? null : descriptor(values.html),
    attachments:
      values.attachment === undefined
        ? []
        : [
            {
              filename: values.filename ?? null,
              mimeType: "application/octet-stream",
              disposition: "attachment",
              contentId: null,
              blob: descriptor(values.attachment),
            },
          ],
    remoteImages: values.remoteImages ?? [],
    now: 1_002,
  });
}

function threadFixture(
  accountId: string,
  values: {
    readonly threadId?: string;
    readonly messageId?: string;
    readonly sentAt?: number;
  } = {},
): CachedProviderThread {
  const threadId = values.threadId ?? "thread-a";
  const messageId = values.messageId ?? MESSAGE_ID;
  const sentAt = values.sentAt ?? 100;
  const message: CachedProviderMessage = Object.freeze({
    accountId,
    messageId,
    threadId,
    from: Object.freeze({ name: "Sender", address: "sender@example.test" }),
    replyTo: Object.freeze([]),
    to: Object.freeze([{ name: null, address: "reader@example.test" }]),
    cc: Object.freeze([]),
    subject: "Subject",
    sentAt,
    unread: true,
    inInbox: true,
    snippet: "Snippet",
    textBody: null,
    htmlBody: null,
    hasAttachments: true,
    rfcMessageId: "<message@example.test>",
    references: Object.freeze([]),
    listMessage: false,
    category: "people",
    sizeEstimate: null,
  });
  const thread: MailThreadListItem = Object.freeze({
    accountId,
    threadId,
    subject: "Subject",
    participants: Object.freeze([message.from!]),
    snippet: "Snippet",
    lastMessageAt: sentAt,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: true,
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

function descriptor(value: Buffer): MailBlobDescriptor {
  return Object.freeze({
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: value.byteLength,
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

async function* chunks(value: Buffer): AsyncIterable<Uint8Array> {
  yield value;
}

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
