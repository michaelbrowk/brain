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
import { AtomicMailSystemAdmission } from "./admission";
import { MailBackgroundSyncScheduler } from "./background-sync";
import { AtomicMailBlobStore } from "./content-blob-store";
import { SqliteMailContentCache } from "./content-cache";
import {
  ExponentialMailContentRetryPolicy,
  InMemoryMailContentWorkQueue,
  MailContentCoordinator,
  type MailContentCoordinatorEvent,
  type MailContentQueueTask,
  MailContentServiceError,
  MailContentWorkError,
  type MailContentWorkInput,
  type MailContentWorkQueuePort,
  type MailContentWorkRunnerPort,
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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

  it("starts an owner's request ahead of prefetch work, which never takes the last slot", async () => {
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const work = queueHarness(queue);
    work.enqueue("first", true);
    work.enqueue("second", true);
    work.enqueue("third", true);
    expect(queue.backgroundCount(ACCOUNT_ID)).toBe(3);
    expect(queue.backgroundCount(SECOND_ACCOUNT_ID)).toBe(0);

    // One prefetch at a time: the second worker slot waits for an owner.
    await vi.waitFor(() => expect(work.started).toEqual(["first:prefetch"]));
    await nextTurn();
    expect(work.started).toEqual(["first:prefetch"]);
    work.enqueue("owner", false);
    await vi.waitFor(() =>
      expect(work.started).toEqual(["first:prefetch", "owner:owner"]),
    );

    // An owner asking for queued prefetch work moves it into the owner's lane.
    // With both slots taken, the running prefetch is aborted, and keeps its
    // slot until its run has let go: the parser counts it until then.
    work.holdWindDown("first");
    queue.promote(ACCOUNT_ID, "message-queue-third");
    await vi.waitFor(() => expect(work.signals.get("first")?.aborted).toBe(true));
    await nextTurn();
    expect(work.started).toEqual(["first:prefetch", "owner:owner"]);
    expect(queue.backgroundCount(ACCOUNT_ID)).toBe(2);
    work.letGo("first");
    await vi.waitFor(() =>
      expect(work.started).toEqual([
        "first:prefetch",
        "owner:owner",
        "third:owner",
      ]),
    );
    // The displaced prefetch went back to the head of its line, so it runs
    // again, with a fresh signal, before the second once a slot frees.
    work.release("owner");
    await vi.waitFor(() =>
      expect(work.started).toEqual([
        "first:prefetch",
        "owner:owner",
        "third:owner",
        "first:prefetch",
      ]),
    );
    expect(work.signals.get("first")?.aborted).toBe(false);
    await nextTurn();
    expect(work.started).toHaveLength(4);
    work.release("first");
    await vi.waitFor(() =>
      expect(work.started).toEqual([
        "first:prefetch",
        "owner:owner",
        "third:owner",
        "first:prefetch",
        "second:prefetch",
      ]),
    );
    work.release("third");
    work.release("second");
    await vi.waitFor(() =>
      expect(work.settled.toSorted()).toEqual(["first", "owner", "second", "third"]),
    );
    expect(queue.backgroundCount(ACCOUNT_ID)).toBe(0);
  });

  it("never gives up the owner's own letter, taken over mid-run, for the owner's next one", async () => {
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const work = queueHarness(queue);
    work.enqueue("taken", true);
    work.enqueue("waiting", true);
    await vi.waitFor(() => expect(work.started).toEqual(["taken:prefetch"]));

    // The owner opens the letter the prefetch is fetching. It is the owner's
    // now, to the run already under way too, and the prefetch slot is free.
    queue.promote(ACCOUNT_ID, "message-queue-taken");
    expect(work.lanes.get("taken")?.background).toBe(false);
    expect(queue.backgroundCount(ACCOUNT_ID)).toBe(1);
    await vi.waitFor(() =>
      expect(work.started).toEqual(["taken:prefetch", "waiting:prefetch"]),
    );

    // The owner's next letter displaces the prefetch, not the owner's own.
    work.enqueue("next", false);
    await vi.waitFor(() =>
      expect(work.started).toEqual([
        "taken:prefetch",
        "waiting:prefetch",
        "next:owner",
      ]),
    );
    expect(work.signals.get("waiting")?.aborted).toBe(true);
    expect(work.signals.get("taken")?.aborted).toBe(false);
    for (const name of ["taken", "next", "waiting"]) work.release(name);
    await vi.waitFor(() =>
      expect(work.settled.toSorted()).toEqual(["next", "taken", "waiting"]),
    );
  });

  it("runs as the owner's an open of prefetch work the pause is dropping", async () => {
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const work = queueHarness(queue);
    work.enqueue("opened", true);
    await vi.waitFor(() => expect(work.started).toEqual(["opened:prefetch"]));
    work.holdWindDown("opened");
    let paused = false;
    const pause = queue.abortAndDrainBackground().then(() => {
      paused = true;
    });
    await vi.waitFor(() => expect(work.signals.get("opened")?.aborted).toBe(true));
    expect(paused).toBe(false);

    // The owner opens it while its fetch winds down: the pause stops waiting
    // for what is now the owner's, and the letter is fetched again as that.
    queue.promote(ACCOUNT_ID, "message-queue-opened");
    await vi.waitFor(() => expect(paused).toBe(true));
    await pause;
    expect(work.started).toEqual(["opened:prefetch"]);
    work.letGo("opened");
    await vi.waitFor(() =>
      expect(work.started).toEqual(["opened:prefetch", "opened:owner"]),
    );
    work.release("opened");
    await vi.waitFor(() => expect(work.settled).toEqual(["opened"]));
  });

  it("leaves dropped the work of an account being drained, whoever asks for it", async () => {
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const work = queueHarness(queue);
    work.enqueue("removed", true);
    await vi.waitFor(() => expect(work.started).toEqual(["removed:prefetch"]));
    work.holdWindDown("removed");
    const drained = queue.abortAndDrainAccount(ACCOUNT_ID);
    await vi.waitFor(() => expect(work.signals.get("removed")?.aborted).toBe(true));
    queue.promote(ACCOUNT_ID, "message-queue-removed");
    work.letGo("removed");
    await drained;
    await nextTurn();
    expect(work.started).toEqual(["removed:prefetch"]);
    expect(work.settled).toEqual(["removed"]);
  });

  it("drops for good a displaced prefetch the pause stops while it winds down", async () => {
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const work = queueHarness(queue);
    work.enqueue("prefetch", true);
    await vi.waitFor(() => expect(work.started).toEqual(["prefetch:prefetch"]));
    work.enqueue("one", false);
    work.holdWindDown("prefetch");
    work.enqueue("two", false);
    await vi.waitFor(() =>
      expect(work.signals.get("prefetch")?.aborted).toBe(true),
    );
    const pause = queue.abortAndDrainBackground();
    work.letGo("prefetch");
    await pause;
    await vi.waitFor(() =>
      expect(work.started).toEqual(["prefetch:prefetch", "one:owner", "two:owner"]),
    );
    // A freed slot finds nothing: the pause ended the prefetch for good.
    work.release("one");
    await nextTurn();
    await nextTurn();
    expect(work.started).toEqual(["prefetch:prefetch", "one:owner", "two:owner"]);
    expect(queue.has(ACCOUNT_ID, "message-queue-prefetch")).toBe(false);
    work.release("two");
  });

  it("gives an owner who took over a prefetch mid-run no part of the prefetch's wait", async () => {
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const deciding = deferred<void>();
    const decided = deferred<void>();
    const lanes: string[] = [];
    queue.enqueue({
      accountId: ACCOUNT_ID,
      providerMessageId: "message-queue-paced",
      background: true,
      async run(_signal, lane) {
        lanes.push(lane.background ? "prefetch" : "owner");
        if (!lane.background) return { kind: "complete" };
        deciding.resolve();
        await decided.promise;
        // The prefetch decides to wait a minute for its turn.
        return { kind: "deferred", notBefore: Date.now() + 60_000 };
      },
    });
    await deciding.promise;
    queue.promote(ACCOUNT_ID, "message-queue-paced");
    decided.resolve();
    await vi.waitFor(() => expect(lanes).toEqual(["prefetch", "owner"]));
  });

  it("hands a freed slot to a waiting owner before waiting prefetch work", async () => {
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const started: string[] = [];
    const releases = new Map<string, ReturnType<typeof deferred<void>>>();
    const enqueue = (name: string, background: boolean) => {
      releases.set(name, deferred<void>());
      queue.enqueue({
        accountId: ACCOUNT_ID,
        providerMessageId: `message-queue-${name}`,
        background,
        async run() {
          started.push(name);
          await releases.get(name)!.promise;
          return { kind: "complete" };
        },
      });
    };
    enqueue("one", false);
    enqueue("two", false);
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
    enqueue("prefetch", true);
    enqueue("three", false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual(["one", "two"]);
    releases.get("one")!.resolve();
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
    releases.get("two")!.resolve();
    await vi.waitFor(() =>
      expect(started).toEqual(["one", "two", "three", "prefetch"]),
    );
    releases.get("three")!.resolve();
    releases.get("prefetch")!.resolve();
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
    const fetch = vi.fn<RemoteImageFetcherPort["fetch"]>(async () => ({
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
        remoteImageCount: 2,
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
        remoteImageAttemptCount: 2,
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
        remoteImageCount: 2,
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
      },
      {
        event: "mail_remote_image_drain_finished",
        accountId: ACCOUNT_ID,
        remoteImageAttemptCount: 2,
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
    ).rejects.toMatchObject({ code: "mail_content_remote_image_refused" });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        event: "mail_remote_image_drain_finished",
      }),
    );
    expect(events).toEqual([
      {
        event: "mail_remote_image_drain_started",
        accountId: ACCOUNT_ID,
        remoteImageCount: 1,
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
        remoteImageAttemptCount: 1,
      },
    ]);
  });

  it("runs at most two drains at once across a thread's worth of demands", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const cache = fixture.caches[0]!;
    const others = ["b", "c", "d", "e"].map((letter, index) => ({
      threadId: `thread-${letter}`,
      messageId: `message-thread-${letter}`,
      sentAt: 200 + index * 100,
    }));
    cache.applyIncrementalPage({
      expectedHistoryId: "100",
      expectedPageToken: null,
      changes: others.map((candidate) => ({
        kind: "upsert" as const,
        value: threadFixture(ACCOUNT_ID, candidate),
      })),
      nextPageToken: null,
      resultingHistoryId: "101",
      now: 500,
    });
    const messageIds = [MESSAGE_ID, ...others.map((candidate) => candidate.messageId)];
    const imageIds = messageIds.map(
      (_messageId, index) =>
        `remote-image-a${String(index + 1).padStart(32, "0")}`,
    );
    const parked: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const image = testPng(10, 10);
    const fetch = vi.fn<RemoteImageFetcherPort["fetch"]>(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => parked.push(resolve));
      inFlight -= 1;
      return {
        mimeType: "image/png",
        data: Buffer.from(image),
        raster: { width: 10, height: 10, frames: 1 },
      };
    });
    const step = (input: MailContentWorkInput) => {
      const index = messageIds.indexOf(input.providerMessageId);
      return publish(input, {
        html: Buffer.from(`<img data-brain-remote-image="${imageIds[index]}">`),
        remoteImages: [
          {
            remoteImageId: imageIds[index]!,
            sourceUrl: `https://images.example.com/thread/${index}.png`,
          },
        ],
      });
    };
    const runner = new FakeMailContentWorkRunner(messageIds.map(() => step));
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
    );

    for (const messageId of messageIds) {
      await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId });
    }
    // Two origins are dialed; the other three drains wait for a slot.
    await vi.waitFor(() => expect(parked).toHaveLength(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(fetch).toHaveBeenCalledTimes(2);
    for (let released = 1; released <= messageIds.length; released += 1) {
      await vi.waitFor(() => expect(parked.length).toBeGreaterThan(0));
      parked.shift()!();
      await vi.waitFor(() =>
        expect(fetch).toHaveBeenCalledTimes(
          Math.min(messageIds.length, released + 2),
        ),
      );
    }
    for (const remoteImageId of imageIds) {
      const cached = await vi.waitFor(() =>
        coordinator.downloadRemoteImage({ accountId: ACCOUNT_ID, remoteImageId }),
      );
      await cached.dispose();
    }
    expect(peak).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(messageIds.length);
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

  it("prefetches every cohort body but fetches images unasked only for the newest three", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const recent = seedInbox(fixture.caches[0]!, ["b", "c", "d", "e"]);
    const all = [
      { threadId: "thread-a", messageId: MESSAGE_ID, sentAt: 100 },
      ...recent,
    ];
    const imageFor = (messageId: string) => {
      const letter = messageId.slice(-1);
      return {
        remoteImageId: `remote-image-a${letter.repeat(32)}`,
        sourceUrl: `https://images.example.com/${letter}.png`,
      };
    };
    const runner = new FakeMailContentWorkRunner(
      all.map(() => (input: MailContentWorkInput) => {
        const remoteImage = imageFor(input.providerMessageId);
        return publish(input, {
          html: Buffer.from(
            `<img data-brain-remote-image="${remoteImage.remoteImageId}">`,
          ),
          remoteImages: [remoteImage],
        });
      }),
    );
    const image = testPng(10, 10);
    const fetch = vi.fn<RemoteImageFetcherPort["fetch"]>(async () => ({
      mimeType: "image/png",
      data: Buffer.from(image),
      raster: { width: 10, height: 10, frames: 1 },
    }));
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      { fetch } satisfies RemoteImageFetcherPort,
    );

    await vi.waitFor(async () => {
      await coordinator.runBackgroundPrefetchStep(
        ACCOUNT_ID,
        new AbortController().signal,
      );
      for (const entry of all) {
        await expect(
          coordinator.getContent({ accountId: ACCOUNT_ID, messageId: entry.messageId }),
        ).resolves.toMatchObject({ state: "ready" });
      }
    });
    expect(runner.calls).toHaveLength(all.length);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(
      ["c", "d", "e"].map((letter) => `https://images.example.com/${letter}.png`),
    );

    // The fourth newest body sits on disk; its images wait for the open.
    await coordinator.requestContent({
      accountId: ACCOUNT_ID,
      messageId: "message-thread-b",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(fetch.mock.calls[3]?.[0]).toBe("https://images.example.com/b.png");
    expect(runner.calls).toHaveLength(all.length);
  });

  it("keeps two prefetches in flight per account and starts the next as each lands", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const seeded = seedInbox(fixture.caches[0]!, ["m1", "m2", "m3", "m4", "m5"]);
    const ids = [
      ...seeded.map((entry) => entry.messageId).toReversed(),
      MESSAGE_ID,
    ];
    const gated = gatedRunner(ids.length);
    const wakeScheduler = vi.fn();
    const coordinator = fixture.coordinator(
      gated.runner,
      undefined,
      undefined,
      undefined,
      wakeScheduler,
    );
    const step = () =>
      coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    const fetching = () => statesOf(coordinator, ids, "fetching");

    await expect(step()).resolves.toEqual({ hasMore: true });
    await vi.waitFor(() => expect(gated.started()).toEqual([ids[0]]));
    await expect(fetching()).resolves.toEqual([ids[0], ids[1]]);
    // Two in flight is the account's share, so a second step adds nothing.
    await expect(step()).resolves.toEqual({ hasMore: false });
    await expect(fetching()).resolves.toEqual([ids[0], ids[1]]);

    // Each landing claims the next one without waiting for a scheduler step.
    for (const [index, messageId] of ids.entries()) {
      gated.release(messageId);
      await vi.waitFor(async () => {
        await expect(fetching()).resolves.toEqual(ids.slice(index + 1, index + 3));
      });
    }
    await expect(statesOf(coordinator, ids, "ready")).resolves.toEqual(ids);
    expect(gated.started()).toEqual(ids);
    await expect(step()).resolves.toEqual({ hasMore: false });
    // The whole cohort landed without waking the scheduler, the one part of
    // the service that syncs with the provider.
    expect(wakeScheduler).not.toHaveBeenCalled();
  });

  it("runs an owner's open of a queued prefetch ahead of the prefetch still running", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["m1", "m2"]);
    const gated = gatedRunner(3);
    const coordinator = fixture.coordinator(gated.runner);
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    // The prefetch takes one worker at a time, so m1 waits behind m2.
    await vi.waitFor(() => expect(gated.started()).toEqual(["message-thread-m2"]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gated.started()).toEqual(["message-thread-m2"]);

    // Opening m1 moves it to the owner's lane: it starts in the free slot at
    // once, while the prefetch it was queued behind is still running.
    await expect(
      coordinator.requestContent({
        accountId: ACCOUNT_ID,
        messageId: "message-thread-m1",
      }),
    ).resolves.toMatchObject({ state: "fetching" });
    await vi.waitFor(() =>
      expect(gated.started()).toEqual(["message-thread-m2", "message-thread-m1"]),
    );
    gated.release("message-thread-m1");
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({
          accountId: ACCOUNT_ID,
          messageId: "message-thread-m1",
        }),
      ).resolves.toMatchObject({ state: "ready" });
    });
    gated.release("message-thread-m2");
    gated.release(MESSAGE_ID);
    await vi.waitFor(async () => {
      await expect(
        statesOf(coordinator, ["message-thread-m2", MESSAGE_ID], "ready"),
      ).resolves.toHaveLength(2);
    });
  });

  it("leaves both of the reader's fetch streams to the reader while a prefetch runs", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const gated = gatedRunner(1);
    const coordinator = fixture.coordinator(gated.runner);
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(gated.started()).toEqual([MESSAGE_ID]));
    // The ledger the download routes admit against, with their exact delta:
    // the prefetch is bounded by its one worker, not by this.
    const ledger = new AtomicMailSystemAdmission();
    const download = {
      concurrentFetchStreams: 1,
      temporaryBytes: MAIL_RESOURCE_LIMITS.rawMessageBytes,
      openFileDescriptors: 2,
    };
    const first = await ledger.reserve("attachment-download:one", download);
    const second = await ledger.reserve("attachment-download:two", download);
    await ledger.release(first.reservationId);
    await ledger.release(second.reservationId);
    gated.release(MESSAGE_ID);
  });

  it("runs an owner's second open once the prefetch it displaces lets go, and puts that back", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["p1", "p2", "p3", "p4", "p5"]);
    const gated = gatedRunner(10);
    const coordinator = fixture.coordinator(gated.runner);
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(gated.started()).toEqual(["message-thread-p5"]));
    // The owner opens a two-letter thread: one takes the free slot, the other
    // would wait behind the prefetch, so the prefetch gives way. Its fetch
    // and parse keep the slot until they hang up, or the owner's second
    // letter would be a third connection the parser socket drops.
    gated.holdWindDown("message-thread-p5");
    for (const messageId of ["message-thread-p1", "message-thread-p2"]) {
      await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId });
    }
    await vi.waitFor(() =>
      expect(gated.signals.get("message-thread-p5")?.aborted).toBe(true),
    );
    await nextTurn();
    expect(gated.started()).toEqual(["message-thread-p5", "message-thread-p1"]);
    gated.letGo("message-thread-p5");
    await vi.waitFor(() =>
      expect(gated.started()).toEqual([
        "message-thread-p5",
        "message-thread-p1",
        "message-thread-p2",
      ]),
    );
    // Once the owner's letters land, the displaced prefetch runs again and
    // lands too.
    for (const messageId of [
      "message-thread-p1",
      "message-thread-p2",
      "message-thread-p5",
    ]) {
      gated.release(messageId);
    }
    await vi.waitFor(async () => {
      await expect(
        statesOf(
          coordinator,
          ["message-thread-p1", "message-thread-p2", "message-thread-p5"],
          "ready",
        ),
      ).resolves.toHaveLength(3);
    });
    for (const messageId of ["message-thread-p4", "message-thread-p3", MESSAGE_ID]) {
      gated.release(messageId);
    }
  });

  it("fetches at once on an open of a body a stopped process left fetching", async () => {
    let now = 1_000;
    const fixture = await createFixture([ACCOUNT_ID]);
    // The previous process claimed the body for the prefetch and stopped.
    const blobStore = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    const previous = new SqliteMailContentCache({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
      blobStore,
      clock: () => 1_000,
    });
    await previous.initialize();
    await previous.refreshBackgroundPrivacyCohort(1_000);
    await previous.markBackgroundContentPrefetchStarted(MESSAGE_ID, 1_000);
    expect((await previous.claim(MESSAGE_ID, 1_000)).kind).toBe("claimed");
    await previous.close();
    await blobStore.close();

    const runner = openRunner();
    const coordinator = fixture.coordinator(runner, undefined, undefined, () => now);
    now = 11_000; // ten seconds later the owner opens it
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(() =>
      expect(runner.calls.map((call) => call.providerMessageId)).toEqual([MESSAGE_ID]),
    );
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });
  });

  it("stops the prefetch with the pause and takes it up again on resume", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["s1", "s2", "s3", "s4", "s5"]);
    const gated = gatedRunner(10);
    const coordinator = fixture.coordinator(gated.runner);
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [ACCOUNT_ID],
        runBackgroundSyncStep: async () =>
          Object.freeze({
            result: Object.freeze({
              apiVersion: 1 as const,
              status: "idle" as const,
              changedCount: 0,
              hasMore: false,
            }),
            hasMore: false,
          }),
      },
      {
        privacyCache: coordinator,
        initialDelayMs: 1,
        intervalMs: 60_000,
        continuationDelayMs: 1,
      },
    );
    scheduler.start();
    await vi.waitFor(() => expect(gated.started()).toEqual(["message-thread-s5"]));

    // The owner switches Mail off: the pause stops both, and waits for the
    // fetch in flight, which the abort ends.
    await scheduler.stop();
    const stopped = coordinator.stopBackgroundPrefetch();
    await vi.waitFor(() =>
      expect(gated.signals.get("message-thread-s5")?.aborted).toBe(true),
    );
    for (const name of ["s5", "s4", "s3", "s2", "s1"]) {
      gated.release(`message-thread-${name}`);
    }
    gated.release(MESSAGE_ID);
    await stopped;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(gated.started()).toEqual(["message-thread-s5"]);
    await expect(
      coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal),
    ).resolves.toEqual({ hasMore: false });
    expect(gated.started()).toEqual(["message-thread-s5"]);

    // On resume the step claims again, the stopped fetch included.
    coordinator.startBackgroundPrefetch();
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(async () => {
      await expect(
        statesOf(
          coordinator,
          ["s5", "s4", "s3", "s2", "s1"].map((name) => `message-thread-${name}`),
          "ready",
        ),
      ).resolves.toHaveLength(5);
    });
  });

  it("fetches an owner's open of a letter whose prefetch the pause is stopping", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["s1"]);
    const gated = gatedRunner(5);
    const coordinator = fixture.coordinator(gated.runner);
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await vi.waitFor(() => expect(gated.started()).toEqual(["message-thread-s1"]));
    gated.holdWindDown("message-thread-s1");
    let paused = false;
    const stopped = coordinator.stopBackgroundPrefetch().then(() => {
      paused = true;
    });
    await vi.waitFor(() =>
      expect(gated.signals.get("message-thread-s1")?.aborted).toBe(true),
    );

    // Within the fetch's wind down, the owner opens that letter. The pause
    // stops waiting for what is the owner's now, and the letter is fetched.
    await expect(
      coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: "message-thread-s1" }),
    ).resolves.toMatchObject({ state: "fetching" });
    await vi.waitFor(() => expect(paused).toBe(true));
    await stopped;
    gated.letGo("message-thread-s1");
    await vi.waitFor(() =>
      expect(gated.started()).toEqual(["message-thread-s1", "message-thread-s1"]),
    );
    gated.release("message-thread-s1");
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: "message-thread-s1" }),
      ).resolves.toMatchObject({ state: "ready" });
    });
  });

  it("finishes the pause only once the claims of prefetches it dropped unstarted are free", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["q1"]);
    const gated = gatedRunner(5);
    const coordinator = fixture.coordinator(gated.runner);
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    // q1 runs in the prefetch slot; the fixture's own letter waits behind it.
    await vi.waitFor(() => expect(gated.started()).toEqual(["message-thread-q1"]));
    await expect(
      coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "fetching" });

    // Giving the waiting letter's claim back goes through the account store,
    // held here: the pause is not over until it is back.
    const store = deferred<void>();
    fixture.accounts.hold = store.promise;
    let paused = false;
    const stopped = coordinator.stopBackgroundPrefetch().then(() => {
      paused = true;
    });
    await sleep(50);
    expect(paused).toBe(false);
    fixture.accounts.hold = null;
    store.resolve();
    await stopped;
    // Free at once: an open fetches it without waiting out the claim.
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(() =>
      expect(gated.started()).toEqual(["message-thread-q1", MESSAGE_ID]),
    );
    gated.release(MESSAGE_ID);
  });

  it("gives back a claim the pause lands on while it is being made", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const gated = gatedRunner(5);
    const coordinator = fixture.coordinator(gated.runner);
    const claim = SqliteMailContentCache.prototype.claim;
    const claimed = deferred<void>();
    const pause = deferred<void>();
    const spy = vi
      .spyOn(SqliteMailContentCache.prototype, "claim")
      .mockImplementationOnce(async function (
        this: SqliteMailContentCache,
        ...args: Parameters<SqliteMailContentCache["claim"]>
      ) {
        const result = await claim.apply(this, args);
        claimed.resolve();
        await pause.promise;
        return result;
      });
    try {
      const step = coordinator.runBackgroundPrefetchStep(
        ACCOUNT_ID,
        new AbortController().signal,
      );
      await claimed.promise;
      const stopped = coordinator.stopBackgroundPrefetch();
      pause.resolve();
      await step;
      await stopped;
    } finally {
      spy.mockRestore();
    }
    expect(gated.started()).toEqual([]);
    // Given back rather than failed, so the resume fetches it at once.
    await expect(
      coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "fetching" });
    coordinator.startBackgroundPrefetch();
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await vi.waitFor(() => expect(gated.started()).toEqual([MESSAGE_ID]));
    gated.release(MESSAGE_ID);
  });

  it("claims nothing more once the pause lands between two claims", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["n1"]);
    const gated = gatedRunner(5);
    let coordinator: MailContentCoordinator | null = null;
    let stopped: Promise<void> | null = null;
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    coordinator = fixture.coordinator(
      gated.runner,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        // Mail goes off the moment the first claim is queued.
        queue: hookedQueue(queue, () => {
          stopped ??= coordinator!.stopBackgroundPrefetch();
        }),
      },
    );
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await stopped;
    await expect(
      statesOf(coordinator, [MESSAGE_ID], "not_requested"),
    ).resolves.toEqual([MESSAGE_ID]);
    expect(gated.started()).toEqual([]);
  });

  it("fetches no image in a scheduler step that comes after the pause", async () => {
    let now = 1_000;
    const fixture = await createFixture([ACCOUNT_ID]);
    const image = {
      remoteImageId: `remote-image-a${"7".repeat(32)}`,
      sourceUrl: "https://images.example.com/7.png",
    };
    const runner = new FakeMailContentWorkRunner([
      (input: MailContentWorkInput) =>
        publish(input, {
          html: Buffer.from(`<img data-brain-remote-image="${image.remoteImageId}">`),
          remoteImages: [image],
        }),
    ]);
    const png = testPng(10, 10);
    const fetch = vi
      .fn<RemoteImageFetcherPort["fetch"]>()
      .mockRejectedValueOnce(
        new RemoteImageFetchError("transient", "remote_image_fetch_failed"),
      )
      .mockResolvedValue({
        mimeType: "image/png",
        data: Buffer.from(png),
        raster: { width: 10, height: 10, frames: 1 },
      });
    const coordinator = fixture.coordinator(runner, undefined, { fetch }, () => now);
    const step = () =>
      coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await step();
    // The drain the commit started met a failing origin; the retry is due.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      await expect(
        coordinator.downloadRemoteImage({
          accountId: ACCOUNT_ID,
          remoteImageId: image.remoteImageId,
        }),
      ).rejects.toMatchObject({ code: "mail_content_unavailable" });
    });
    now += MAIL_RESOURCE_LIMITS.remoteImageTransientRetryMs + 1;

    await coordinator.stopBackgroundPrefetch();
    await expect(step()).resolves.toEqual({ hasMore: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    coordinator.startBackgroundPrefetch();
    await step();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives back the claim of a prefetch the pause stopped before its fetch began", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const gated = gatedRunner(5);
    const queue = new InMemoryMailContentWorkQueue({ maxPending: 10 });
    workQueues.push(queue);
    const store = deferred<void>();
    const coordinator = fixture.coordinator(
      gated.runner,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        // The run's first stop is the account store: hold it there.
        queue: hookedQueue(queue, () => {
          fixture.accounts.hold = store.promise;
        }),
      },
    );
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    const stopped = coordinator.stopBackgroundPrefetch();
    fixture.accounts.hold = null;
    store.resolve();
    await stopped;
    expect(gated.started()).toEqual([]);
    // The claim is free, so an open fetches at once.
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(() => expect(gated.started()).toEqual([MESSAGE_ID]));
    gated.release(MESSAGE_ID);
  });

  it("stops the image drain a prefetch commit started when Mail goes off", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const images = imageSet(["1", "2", "3"]);
    const runner = new FakeMailContentWorkRunner([
      (input: MailContentWorkInput) => publish(input, withImages(images)),
    ]);
    const origin = slowOrigin();
    const coordinator = fixture.coordinator(runner, undefined, { fetch: origin.fetch });
    // No owner asked for anything: this is the prefetch alone.
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await vi.waitFor(() => expect(origin.urls).toHaveLength(1));

    await coordinator.stopBackgroundPrefetch();
    expect(origin.signals[0]?.aborted).toBe(true);
    origin.answer();
    await sleep(50);
    expect(origin.urls).toHaveLength(1);

    // An open afterwards is the owner's approval: the images drain again.
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(() => expect(origin.urls).toHaveLength(4));
    expect(origin.urls.slice(1)).toEqual(images.map((image) => image.sourceUrl));
  });

  it("waits for a stopped image drain to let go, and drains again for an open meanwhile", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const images = imageSet(["1", "2", "3"]);
    const runner = new FakeMailContentWorkRunner([
      (input: MailContentWorkInput) => publish(input, withImages(images)),
    ]);
    const origin = slowOrigin();
    const coordinator = fixture.coordinator(runner, undefined, { fetch: origin.fetch });
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await vi.waitFor(() => expect(origin.urls).toHaveLength(1));

    // The origin takes its time to hang up: the pause waits for it.
    origin.holdAbort();
    let paused = false;
    const stopped = coordinator.stopBackgroundPrefetch().then(() => {
      paused = true;
    });
    await sleep(50);
    expect(paused).toBe(false);
    // The owner opens the letter while the stopped drain winds down.
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    origin.letGo();
    await stopped;
    origin.answer();
    await vi.waitFor(() => expect(origin.urls).toHaveLength(4));
    expect(origin.urls.slice(1)).toEqual(images.map((image) => image.sourceUrl));
  });

  it("starts no image drain for a prefetch that lands as the pause begins", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const images = imageSet(["1"]);
    const landing = deferred<void>();
    const started = deferred<void>();
    const runner = new FakeMailContentWorkRunner([
      // A fetch that has its body in hand and finishes whatever the signal says.
      async (input: MailContentWorkInput) => {
        started.resolve();
        await landing.promise;
        await publish(input, withImages(images));
      },
    ]);
    const origin = slowOrigin();
    const coordinator = fixture.coordinator(runner, undefined, { fetch: origin.fetch });
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await started.promise;
    const stopped = coordinator.stopBackgroundPrefetch();
    landing.resolve();
    await stopped;
    await expect(
      coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ state: "ready" });
    await sleep(50);
    expect(origin.urls).toEqual([]);
  });

  it("lets a stopped image drain waiting for a slot leave the line", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    // Both older than the fixture's own letter, which the prefetch takes first.
    seedInbox(fixture.caches[0]!, ["b1"], { baseSentAt: 10 });
    seedInbox(fixture.caches[0]!, ["b2"], {
      baseSentAt: 20,
      fromHistory: "101",
      toHistory: "102",
    });
    const imagesFor = (messageId: string) => imageSet([messageId.slice(-1)]);
    const prefetched = deferred<void>();
    const runner = new FakeMailContentWorkRunner(
      Array.from({ length: 5 }, () => async (input: MailContentWorkInput) => {
        if (input.providerMessageId === MESSAGE_ID) await prefetched.promise;
        await publish(input, withImages(imagesFor(input.providerMessageId)));
      }),
    );
    const origin = slowOrigin({ hangAll: true });
    const coordinator = fixture.coordinator(runner, undefined, { fetch: origin.fetch });
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await vi.waitFor(() =>
      expect(runner.calls.map((call) => call.providerMessageId)).toEqual([MESSAGE_ID]),
    );
    // The owner's two open letters hold both drain slots on slow origins.
    for (const messageId of ["message-thread-b2", "message-thread-b1"]) {
      await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId });
    }
    await vi.waitFor(() => expect(origin.urls).toHaveLength(2));
    // The prefetch lands its letter; that drain waits for a slot.
    prefetched.resolve();
    await vi.waitFor(async () => {
      await expect(
        coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }),
      ).resolves.toMatchObject({ state: "ready" });
    });
    await sleep(20);
    let paused = false;
    const stopped = coordinator.stopBackgroundPrefetch().then(() => {
      paused = true;
    });
    await vi.waitFor(() => expect(paused).toBe(true));
    await stopped;
    origin.answer();
    await sleep(50);
    expect(origin.urls).toHaveLength(2);
  });

  it("leaves to the owner a prefetch's image drain for a letter the owner opened", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const images = imageSet(["1", "2", "3"]);
    const runner = new FakeMailContentWorkRunner([
      (input: MailContentWorkInput) => publish(input, withImages(images)),
    ]);
    const origin = slowOrigin();
    const coordinator = fixture.coordinator(runner, undefined, { fetch: origin.fetch });
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await vi.waitFor(() => expect(origin.urls).toHaveLength(1));

    // The owner opens the letter while its images drain, then Mail goes off.
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await coordinator.stopBackgroundPrefetch();
    expect(origin.signals[0]?.aborted).toBe(false);
    origin.answer();
    await vi.waitFor(() => expect(origin.urls).toHaveLength(3));
    await sleep(50);
    expect(origin.urls).toEqual(images.map((image) => image.sourceUrl));
  });

  it("drains as the owner's the images of a letter the owner opened mid-fetch", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const images = imageSet(["1", "2", "3"]);
    const fetched = deferred<void>();
    const runner = new FakeMailContentWorkRunner([
      async (input: MailContentWorkInput) => {
        await fetched.promise;
        await publish(input, withImages(images));
      },
    ]);
    const origin = slowOrigin();
    const coordinator = fixture.coordinator(runner, undefined, { fetch: origin.fetch });
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    // Opened while the prefetch fetches it: the commit is the owner's.
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    fetched.resolve();
    await vi.waitFor(() => expect(origin.urls).toHaveLength(1));
    await coordinator.stopBackgroundPrefetch();
    expect(origin.signals[0]?.aborted).toBe(false);
    origin.answer();
    await vi.waitFor(() => expect(origin.urls).toHaveLength(3));
  });

  it("never aborts the owner's letter the prefetch was fetching for the owner's next one", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["p1", "p2", "p3", "p4", "p5"]);
    const gated = gatedRunner(10);
    const coordinator = fixture.coordinator(gated.runner);
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await vi.waitFor(() => expect(gated.started()).toEqual(["message-thread-p5"]));
    // The owner opens a thread of three whose newest letter the prefetch is
    // fetching: that one is the owner's now, and the third waits for a slot.
    for (const messageId of [
      "message-thread-p5",
      "message-thread-p1",
      "message-thread-p2",
    ]) {
      await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId });
    }
    await vi.waitFor(() => expect(gated.started()).toContain("message-thread-p1"));
    await nextTurn();
    expect(gated.started()).not.toContain("message-thread-p2");
    expect(gated.signals.get("message-thread-p5")?.aborted).toBe(false);
    for (const messageId of ["message-thread-p5", "message-thread-p1", "message-thread-p2"]) {
      gated.release(messageId);
    }
    await vi.waitFor(async () => {
      await expect(
        statesOf(
          coordinator,
          ["message-thread-p5", "message-thread-p1", "message-thread-p2"],
          "ready",
        ),
      ).resolves.toHaveLength(3);
    });
    expect(gated.started().filter((id) => id === "message-thread-p5")).toHaveLength(1);
    for (const messageId of ["message-thread-p4", "message-thread-p3", MESSAGE_ID]) {
      gated.release(messageId);
    }
  });

  it("brings the cohort back once the large open that pushed it out has gone", async () => {
    const setup = await cohortPushedOutByLargeOpen({ "message-thread-n1": 100 });
    const now = setup.advance(2 * HOUR);
    seedInbox(setup.caches[0]!, ["n1"], {
      baseSentAt: now - 60_000,
      fromHistory: "101",
      toHistory: "102",
    });
    // One step claims the new letter. Its landing gives up the large one and
    // claims back the one evicted body that fits the 116 bytes it leaves: a
    // second would be fetched only to be evicted again.
    await setup.step();
    await vi.waitFor(() => expect(setup.fetchesOf("message-thread-c5")).toBe(2));
    // While c5 is on its way its bytes are not counted yet, so no other step
    // counts that room again.
    await setup.step();
    await setup.step();
    expect(setup.fetchesOf("message-thread-c4")).toBe(1);
    setup.returning.resolve();
    await vi.waitFor(async () => {
      await expect(
        statesOf(setup.coordinator, ["message-thread-c5"], "ready"),
      ).resolves.toHaveLength(1);
    });
    await setup.step();
    await sleep(20);
    await expect(
      statesOf(
        setup.coordinator,
        [MESSAGE_ID, "message-thread-c4", "message-thread-c3"],
        "not_requested",
      ),
    ).resolves.toEqual([MESSAGE_ID, "message-thread-c4", "message-thread-c3"]);
    expect(setup.fetchesOf("message-thread-c4")).toBe(1);
  });

  it("brings an evicted body back once its room shows, when the eviction came mid-fill", async () => {
    const setup = await cohortPushedOutByLargeOpen({
      "message-thread-n1": 50,
      "message-thread-n2": 50,
    });
    const now = setup.advance(2 * HOUR);
    seedInbox(setup.caches[0]!, ["n1", "n2"], {
      baseSentAt: now - 60_000,
      fromHistory: "101",
      toHistory: "102",
    });
    // The step claims both new letters. The first to land gives up the large
    // one while the second is on its way, so that room waits for it; the
    // second's landing finds 116 bytes free and claims c5 back.
    await setup.step();
    await vi.waitFor(() => expect(setup.fetchesOf("message-thread-c5")).toBe(2));
    expect(setup.fetchesOf("message-thread-c4")).toBe(1);
    setup.returning.resolve();
    await vi.waitFor(async () => {
      await expect(
        statesOf(setup.coordinator, ["message-thread-c5"], "ready"),
      ).resolves.toHaveLength(1);
    });
  });

  it("claims nothing at the budget while every body it holds is pinned", async () => {
    const now = 40 * DAY;
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["r1", "r2"], { baseSentAt: now - 2 * DAY });
    const runner = openRunner();
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      undefined,
      () => now,
      undefined,
      undefined,
      { bodyCacheMaxBytes: 72 },
    );
    // The owner's open of r1 fills the budget and holds it for the hour. r2
    // would be fetched only to be the one body the budget could give up.
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: "message-thread-r1" });
    await vi.waitFor(async () => {
      await expect(
        statesOf(coordinator, ["message-thread-r1"], "ready"),
      ).resolves.toHaveLength(1);
    });
    await coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
    await sleep(20);
    expect(runner.calls.map((call) => call.providerMessageId)).toEqual([
      "message-thread-r1",
    ]);
  });

  it("clears a body a stopped process was receiving at the first open, however recent", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const cacheRoot = path.join(fixture.root, "cache");
    // The last process was streaming a body when it stopped, a moment ago.
    const before = new AtomicMailBlobStore({ cacheRoot, accountId: ACCOUNT_ID });
    await before.initialize();
    const hang = deferred<void>();
    const received = before
      .receiveIncoming(
        (async function* () {
          yield Buffer.alloc(4096, 1);
          await hang.promise;
        })(),
        1024 * 1024,
      )
      .catch(() => undefined);
    const incoming = path.join(cacheRoot, ACCOUNT_ID, "content-incoming");
    await vi.waitFor(async () => expect(await readdir(incoming)).toHaveLength(1));

    const coordinator = fixture.coordinator(openRunner());
    await coordinator.getContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    expect(await readdir(incoming)).toEqual([]);
    hang.resolve();
    await received;
    await before.close();
  });

  it("keeps a new letter over bodies opened hours ago once the budget is full", async () => {
    let now = 40 * DAY;
    const fixture = await createFixture([ACCOUNT_ID]);
    // Three letters from three weeks ago that the owner opened this morning.
    seedInbox(fixture.caches[0]!, ["o1", "o2", "o3"], {
      baseSentAt: now - 21 * DAY,
    });
    const runner = openRunner();
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      undefined,
      () => now,
      undefined,
      undefined,
      // Room for three bodies of 72 bytes.
      { bodyCacheMaxBytes: 3 * 72 },
    );
    const opened = ["message-thread-o1", "message-thread-o2", "message-thread-o3"];
    for (const messageId of opened) {
      await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId });
    }
    await vi.waitFor(async () => {
      await expect(statesOf(coordinator, opened, "ready")).resolves.toEqual(opened);
    });

    // Two hours later a letter arrives. It is newer than any of the three by
    // the one key the budget keeps, so it is fetched and kept, and the
    // least recent of the opened ones makes room.
    now += 2 * HOUR;
    seedInbox(fixture.caches[0]!, ["new"], {
      baseSentAt: now - 60_000,
      fromHistory: "101",
      toHistory: "102",
    });
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(async () => {
      await expect(
        statesOf(coordinator, [...opened, "message-thread-new"], "ready"),
      ).resolves.toEqual(["message-thread-o2", "message-thread-o3", "message-thread-new"]);
    });
    expect(
      runner.calls.filter((call) => call.providerMessageId === "message-thread-new"),
    ).toHaveLength(1);
  });

  it("fetches newest first, stops once the budget is full, and removes what it evicts from disk", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["m1", "m2", "m3", "m4", "m5"]);
    const runner = openRunner();
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { bodyCacheMaxBytes: 2 * 72 },
    );
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    const all = [
      "message-thread-m5",
      "message-thread-m4",
      "message-thread-m3",
      "message-thread-m2",
      "message-thread-m1",
      MESSAGE_ID,
    ];
    await vi.waitFor(async () => {
      await expect(statesOf(coordinator, all, "ready")).resolves.toEqual([
        "message-thread-m5",
        "message-thread-m4",
      ]);
      await expect(statesOf(coordinator, all, "fetching")).resolves.toEqual([]);
    });
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // m3 was already on its way when the budget filled; nothing older is
    // fetched after it, since the budget would only take it back.
    expect(runner.calls.map((call) => call.providerMessageId)).toEqual([
      "message-thread-m5",
      "message-thread-m4",
      "message-thread-m3",
    ]);
    // The evicted body's own blob left the disk with it.
    const blobs = path.join(fixture.root, "cache", ACCOUNT_ID, "content-blobs");
    const onDisk = new Set(await readdir(blobs));
    expect(onDisk.has(descriptor(bodyText("message-thread-m3")).sha256)).toBe(false);
    expect(onDisk.has(descriptor(bodyText("message-thread-m4")).sha256)).toBe(true);
  });

  it("spares a body a draft answers when the budget has to give one up", async () => {
    let now = 1_000;
    const fixture = await createFixture([ACCOUNT_ID]);
    const runner = openRunner();
    const listDraftSourceMessageIds = vi.fn(async () => [MESSAGE_ID]);
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      undefined,
      () => now,
      undefined,
      undefined,
      {
        bodyCacheMaxBytes: 2 * 72,
        draftSources: { listDraftSourceMessageIds },
      },
    );
    // The owner opened the fixture's letter and began a reply to it.
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(async () => {
      await expect(
        statesOf(coordinator, [MESSAGE_ID], "ready"),
      ).resolves.toHaveLength(1);
    });
    now += 2 * HOUR;
    seedInbox(fixture.caches[0]!, ["m1", "m2", "m3"], { baseSentAt: now - 1_000 });
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    // The letter the draft answers is the least recent, and it stays.
    await vi.waitFor(async () => {
      await expect(
        statesOf(
          coordinator,
          [MESSAGE_ID, "message-thread-m3", "message-thread-m2"],
          "ready",
        ),
      ).resolves.toEqual([MESSAGE_ID, "message-thread-m3"]);
      await expect(
        statesOf(coordinator, ["message-thread-m2"], "not_requested"),
      ).resolves.toHaveLength(1);
    });
    expect(listDraftSourceMessageIds).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("claims nothing past the budget while the drafts cannot say what they need", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["d1", "d2", "d3", "d4", "d5", "d6"]);
    const runner = openRunner();
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        bodyCacheMaxBytes: 72,
        draftSources: {
          listDraftSourceMessageIds: async () => {
            throw new Error("outbox locked");
          },
        },
      },
    );
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    const two = ["message-thread-d6", "message-thread-d5"];
    await vi.waitFor(async () => {
      await expect(statesOf(coordinator, two, "ready")).resolves.toEqual(two);
    });
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // The two claimed before the budget filled landed; nothing was evicted
    // without knowing what a draft needs, and nothing more was claimed.
    await expect(statesOf(coordinator, two, "ready")).resolves.toEqual(two);
    expect(runner.calls).toHaveLength(2);
  });

  it("never makes an owner wait out the prefetch's pacing", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    fixture.accounts.providerKind = "imap";
    seedInbox(fixture.caches[0]!, ["m1", "m2"]);
    const runner = openRunner();
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { imapPrefetchSpacingMs: 60_000 },
    );
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(async () => {
      await expect(
        statesOf(coordinator, ["message-thread-m2"], "ready"),
      ).resolves.toHaveLength(1);
    });
    // m1 is claimed and waits a minute for its turn on the IMAP account.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(runner.calls).toHaveLength(1);
    await coordinator.requestContent({
      accountId: ACCOUNT_ID,
      messageId: "message-thread-m1",
    });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    expect(runner.calls[1]?.providerMessageId).toBe("message-thread-m1");
  });

  it("runs at once an owner's open of a prefetch waiting to retry a failure", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    let failures = 0;
    const runner = new FakeMailContentWorkRunner([
      () => {
        failures += 1;
        throw new MailContentWorkError("transient", "provider_hiccup");
      },
      (input) => publish(input, { text: bodyText(input.providerMessageId) }),
    ]);
    // A minute before the prefetch would try again.
    const coordinator = fixture.coordinator(runner, { nextDelayMs: () => 60_000 });
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(failures).toBe(1));
    await vi.waitFor(async () => {
      await expect(
        statesOf(coordinator, [MESSAGE_ID], "transient"),
      ).resolves.toHaveLength(1);
    });
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    await vi.waitFor(async () => {
      await expect(
        statesOf(coordinator, [MESSAGE_ID], "ready"),
      ).resolves.toHaveLength(1);
    });
  });

  it("paces the prefetch on an IMAP account, where every fetch is a login", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    fixture.accounts.providerKind = "imap";
    seedInbox(fixture.caches[0]!, ["m1", "m2", "m3"], {
      baseSentAt: Date.now() - 60_000,
    });
    const startedAt: number[] = [];
    const runner = new FakeMailContentWorkRunner(
      Array.from({ length: 5 }, () => (input: MailContentWorkInput) => {
        startedAt.push(Date.now());
        return publish(input, { text: bodyText(input.providerMessageId) });
      }),
    );
    const coordinator = fixture.coordinator(
      runner,
      undefined,
      undefined,
      () => Date.now(),
      undefined,
      undefined,
      { imapPrefetchSpacingMs: 300 },
    );
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(startedAt).toHaveLength(3), { timeout: 3_000 });
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(280);
    expect(startedAt[2]! - startedAt[1]!).toBeGreaterThanOrEqual(280);
  });

  it("serves the reader's attachment while a prefetch is still streaming a body", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["slow"], { baseSentAt: 50 });
    const download = deferred<void>();
    const runner = new FakeMailContentWorkRunner([
      // The owner's earlier open of the fixture letter, with an attachment.
      (input) =>
        publish(input, {
          text: Buffer.from("body"),
          attachment: Buffer.from("attachment bytes"),
          filename: "a.pdf",
        }),
      // The prefetch of an older letter, from a provider that stalls.
      async (input) => {
        async function* slowProvider(): AsyncIterable<Uint8Array> {
          yield Buffer.from("From: a\r\n");
          await download.promise;
          yield Buffer.from("\r\nbody");
        }
        await input.cache.incomingBlobStore(input.lease).putIncoming(slowProvider(), 1024);
        await publish(input, { text: Buffer.from("prefetched") });
      },
    ]);
    const coordinator = fixture.coordinator(runner);
    await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
    let attachmentId = "";
    await vi.waitFor(async () => {
      const content = await coordinator.getContent({
        accountId: ACCOUNT_ID,
        messageId: MESSAGE_ID,
      });
      if (content.state !== "ready") throw new Error("not ready yet");
      attachmentId = content.attachments[0]!.attachmentId;
    });
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const read = coordinator
      .downloadAttachment({ accountId: ACCOUNT_ID, attachmentId })
      .then(async (value) => {
        const bytes = await collectBytes(value.body);
        await value.dispose();
        return bytes;
      });
    const outcome = await Promise.race([
      read,
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]);
    expect(outcome).toEqual(Buffer.from("attachment bytes"));
    download.resolve();
    await vi.waitFor(async () => {
      await expect(
        statesOf(coordinator, ["message-thread-slow"], "ready"),
      ).resolves.toHaveLength(1);
    });
  });

  it("claims afresh a prefetch whose lease ran out while it waited its turn", async () => {
    let now = 1_000;
    const fixture = await createFixture([ACCOUNT_ID]);
    seedInbox(fixture.caches[0]!, ["m1", "m2"]);
    const gated = gatedRunner(5);
    const coordinator = fixture.coordinator(gated.runner, undefined, undefined, () => now);
    await coordinator.runBackgroundPrefetchStep(
      ACCOUNT_ID,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(gated.started()).toEqual(["message-thread-m2"]));
    // m1 was claimed with m2 and waits behind it past its lease.
    now += MAIL_RESOURCE_LIMITS.workerLeaseMs + 1;
    gated.release("message-thread-m2");
    gated.release("message-thread-m1");
    gated.release(MESSAGE_ID);
    await vi.waitFor(async () => {
      await expect(
        statesOf(coordinator, ["message-thread-m1"], "ready"),
      ).resolves.toHaveLength(1);
    });
    // Its first fetch already ran on a fresh claim: none was spent on a lease
    // the cache would have refused at the commit.
    expect(
      gated.started().filter((messageId) => messageId === "message-thread-m1"),
    ).toHaveLength(1);
  });

  it("takes a deployed three-message cohort to the new size without a refetch storm", async () => {
    const fixture = await createFixture([ACCOUNT_ID]);
    const seeded = seedInbox(fixture.caches[0]!, [
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);
    // What the three-message cohort left on disk: the newest three bodies.
    const deployed = seeded.slice(-3).map((entry) => entry.messageId);
    const blobStore = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    const contentCache = new SqliteMailContentCache({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
      blobStore,
      clock: () => 1_000,
    });
    await contentCache.initialize();
    await contentCache.refreshBackgroundPrivacyCohort(1_000);
    for (const messageId of deployed) {
      await contentCache.markBackgroundContentPrefetchStarted(messageId, 1_000);
      const claim = await contentCache.claim(messageId, 1_000);
      if (claim.kind !== "claimed") throw new Error("expected a claim");
      await publish(
        {
          accountId: ACCOUNT_ID,
          providerMessageId: messageId,
          lease: claim.lease,
          cache: contentCache,
          blobStore,
          deadlineAt: claim.lease.expiresAt,
        },
        { text: Buffer.from(messageId) },
      );
    }
    await contentCache.close();
    await blobStore.close();

    const missing = [
      ...seeded.slice(0, 3).map((entry) => entry.messageId).toReversed(),
      MESSAGE_ID,
    ];
    const gated = gatedRunner(missing.length);
    const coordinator = fixture.coordinator(gated.runner);
    await expect(
      coordinator.runBackgroundPrefetchStep(
        ACCOUNT_ID,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ hasMore: true });
    // One step claims the account's two and nothing that is already on disk.
    await expect(
      statesOf(coordinator, [...deployed, ...missing], "fetching"),
    ).resolves.toEqual(missing.slice(0, 2));
    await expect(statesOf(coordinator, deployed, "ready")).resolves.toEqual(
      deployed,
    );
    for (const messageId of missing) gated.release(messageId);
    await vi.waitFor(async () => {
      await expect(statesOf(coordinator, missing, "ready")).resolves.toEqual(
        missing,
      );
    });
    expect(gated.started()).toEqual(missing);
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
      ).rejects.toMatchObject({ code: "mail_content_remote_image_refused" });
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
  /** What the fake account store answers: the provider, and a hold on reads. */
  readonly accounts: { providerKind: "gmail" | "imap" | null; hold: Promise<void> | null };
  coordinator(
    runner: MailContentWorkRunnerPort,
    retryPolicy?: { nextDelayMs(): number | null },
    remoteImageFetcher?: RemoteImageFetcherPort,
    clock?: () => number,
    onBackgroundWorkAvailable?: () => void,
    onEvent?: (event: MailContentCoordinatorEvent) => void,
    extra?: {
      readonly bodyCacheMaxBytes?: number;
      readonly imapPrefetchSpacingMs?: number;
      readonly draftSources?: {
        listDraftSourceMessageIds(accountId: string): Promise<readonly string[]>;
      };
      readonly queue?: MailContentWorkQueuePort;
    },
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
  const known = new Set(accountIds);
  const accounts: {
    providerKind: "gmail" | "imap" | null;
    hold: Promise<void> | null;
  } = { providerKind: null, hold: null };
  const store = {
    readAccount: async (accountId: string) => {
      if (accounts.hold !== null) await accounts.hold;
      if (!known.has(accountId)) return null;
      return (
        accounts.providerKind === null
          ? { account: { accountId } }
          : { account: { accountId }, providerKind: accounts.providerKind }
      ) as never;
    },
  } as unknown as MultiMailAccountStore;
  return {
    root,
    caches,
    accounts,
    coordinator(
      runner,
      retryPolicy,
      remoteImageFetcher,
      clock,
      onBackgroundWorkAvailable,
      onEvent,
      extra,
    ) {
      const coordinator = new MailContentCoordinator({
        stateDirectory: root,
        store,
        runner,
        ...extra,
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
    sizeEstimate: 2_048,
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
    sizeBytes: 2_048,
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

/**
 * A runner whose every fetch waits for its message to be released, so a test
 * can hold work in flight and watch what starts behind it. An abort ends a
 * fetch the way it ends a real one, unless the test holds the fetch's wind
 * down (`holdWindDown`) to watch what waits for it.
 */
function gatedRunner(count: number): {
  readonly runner: FakeMailContentWorkRunner;
  /** The signal each message's latest fetch was handed. */
  readonly signals: Map<string, AbortSignal>;
  started(): readonly string[];
  release(messageId: string): void;
  /** Keeps this message's next aborted fetch running until `letGo`. */
  holdWindDown(messageId: string): void;
  letGo(messageId: string): void;
} {
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const windDowns = new Map<string, ReturnType<typeof deferred<void>>>();
  const signals = new Map<string, AbortSignal>();
  const gate = (messageId: string) => {
    let value = gates.get(messageId);
    if (value === undefined) {
      value = deferred<void>();
      gates.set(messageId, value);
    }
    return value;
  };
  const runner = new FakeMailContentWorkRunner(
    Array.from(
      { length: count },
      () => async (input: MailContentWorkInput, signal: AbortSignal) => {
        const messageId = input.providerMessageId;
        signals.set(messageId, signal);
        const aborted = await new Promise<boolean>((resolve) => {
          void gate(messageId).promise.then(() => resolve(false));
          if (signal.aborted) resolve(true);
          signal.addEventListener("abort", () => resolve(true), { once: true });
        });
        if (aborted) {
          await windDowns.get(messageId)?.promise;
          throw new MailContentWorkError("transient", "mail_mime_aborted");
        }
        await publish(input, { text: Buffer.from(messageId) });
      },
    ),
  );
  return {
    runner,
    signals,
    started: () => runner.calls.map((call) => call.providerMessageId),
    release: (messageId) => gate(messageId).resolve(),
    holdWindDown: (messageId) => windDowns.set(messageId, deferred<void>()),
    letGo: (messageId) => {
      windDowns.get(messageId)?.resolve();
      windDowns.delete(messageId);
    },
  };
}

/**
 * Queue work that runs until the test releases it or, once aborted, until its
 * wind down ends, which is at once unless the test holds it. Each run records
 * its name and lane.
 */
function queueHarness(queue: InMemoryMailContentWorkQueue) {
  const started: string[] = [];
  const settled: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const lanes = new Map<string, { readonly background: boolean }>();
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const windDowns = new Map<string, ReturnType<typeof deferred<void>>>();
  const gate = (name: string) => {
    let value = gates.get(name);
    if (value === undefined) {
      value = deferred<void>();
      gates.set(name, value);
    }
    return value;
  };
  return {
    started,
    settled,
    signals,
    lanes,
    enqueue(name: string, background: boolean): void {
      queue.enqueue({
        accountId: ACCOUNT_ID,
        providerMessageId: `message-queue-${name}`,
        background,
        onSettled: () => settled.push(name),
        async run(signal, lane) {
          signals.set(name, signal);
          lanes.set(name, lane);
          started.push(`${name}:${lane.background ? "prefetch" : "owner"}`);
          const aborted = new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          }).then(() => windDowns.get(name)?.promise);
          await Promise.race([gate(name).promise, aborted]);
          return { kind: "complete" };
        },
      });
    },
    release: (name: string) => gate(name).resolve(),
    holdWindDown: (name: string) => windDowns.set(name, deferred<void>()),
    letGo: (name: string) => {
      windDowns.get(name)?.resolve();
      windDowns.delete(name);
    },
  };
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * The start of the tests of what brings evicted bodies back. Three 72-byte
 * cohort bodies fill a 216-byte budget, and the owner's open of the
 * fixture's own letter, sixty days old and holding 208 bytes, pushes them
 * out while it stays pinned. A new letter's body holds what `sizes` says,
 * and a body fetched a second time waits for `returning`.
 */
async function cohortPushedOutByLargeOpen(sizes: Readonly<Record<string, number>>) {
  let now = 60 * DAY;
  const fixture = await createFixture([ACCOUNT_ID]);
  seedInbox(fixture.caches[0]!, ["c1", "c2", "c3", "c4", "c5"], {
    baseSentAt: now - 5 * DAY,
  });
  const returning = deferred<void>();
  const text = (messageId: string) => {
    if (messageId === MESSAGE_ID) return Buffer.alloc(200, 0x61);
    const size = sizes[messageId];
    return size === undefined ? bodyText(messageId) : Buffer.alloc(size - 8, 0x62);
  };
  const runner = new FakeMailContentWorkRunner(
    Array.from({ length: 30 }, () => async (input: MailContentWorkInput) => {
      if (fetchesOf(input.providerMessageId) > 1) await returning.promise;
      await publish(input, { text: text(input.providerMessageId) });
    }),
  );
  const fetchesOf = (messageId: string) =>
    runner.calls.filter((call) => call.providerMessageId === messageId).length;
  const coordinator = fixture.coordinator(
    runner,
    undefined,
    undefined,
    () => now,
    undefined,
    undefined,
    { bodyCacheMaxBytes: 3 * 72 },
  );
  const step = () =>
    coordinator.runBackgroundPrefetchStep(ACCOUNT_ID, new AbortController().signal);
  const cohort = ["c5", "c4", "c3"].map((name) => `message-thread-${name}`);
  await vi.waitFor(async () => {
    await step();
    await expect(statesOf(coordinator, cohort, "ready")).resolves.toEqual(cohort);
  });
  await coordinator.requestContent({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID });
  await vi.waitFor(async () => {
    await expect(statesOf(coordinator, [MESSAGE_ID], "ready")).resolves.toEqual([
      MESSAGE_ID,
    ]);
  });
  await step();
  await expect(statesOf(coordinator, cohort, "not_requested")).resolves.toEqual(cohort);
  return {
    caches: fixture.caches,
    coordinator,
    step,
    fetchesOf,
    returning,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

/** The queue, with a hook that runs right after each enqueue. */
function hookedQueue(
  queue: InMemoryMailContentWorkQueue,
  afterEnqueue: (task: MailContentQueueTask) => void,
): MailContentWorkQueuePort {
  return {
    has: (accountId, messageId) => queue.has(accountId, messageId),
    enqueue: (task) => {
      const result = queue.enqueue(task);
      afterEnqueue(task);
      return result;
    },
    promote: (accountId, messageId) => queue.promote(accountId, messageId),
    backgroundCount: (accountId) => queue.backgroundCount(accountId),
    abortAndDrainBackground: () => queue.abortAndDrainBackground(),
    resumeBackground: () => queue.resumeBackground(),
    abortAndDrainAccount: (accountId) => queue.abortAndDrainAccount(accountId),
    restoreAccount: (accountId) => queue.restoreAccount(accountId),
    close: () => queue.close(),
  };
}

function imageSet(names: readonly string[]): readonly {
  readonly remoteImageId: string;
  readonly sourceUrl: string;
}[] {
  return names.map((name) => ({
    remoteImageId: `remote-image-a${name.repeat(32)}`,
    sourceUrl: `https://images.example.com/${name}.png`,
  }));
}

function withImages(
  images: readonly { readonly remoteImageId: string; readonly sourceUrl: string }[],
): { readonly html: Buffer; readonly remoteImages: typeof images } {
  return {
    html: Buffer.from(
      images
        .map((image) => `<img data-brain-remote-image="${image.remoteImageId}">`)
        .join(""),
    ),
    remoteImages: images,
  };
}

/**
 * An image origin whose first answer, or every answer with `hangAll`, waits
 * for the test (`answer`) unless the fetch is aborted first, as a real one
 * is. Once answered, it answers at once. `holdAbort` keeps an aborted fetch
 * hanging on until `letGo`, to watch what waits for it.
 */
function slowOrigin(options: { readonly hangAll?: boolean } = {}): {
  readonly urls: string[];
  readonly signals: (AbortSignal | undefined)[];
  readonly fetch: RemoteImageFetcherPort["fetch"];
  answer(): void;
  holdAbort(): void;
  letGo(): void;
} {
  const urls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const answered = deferred<void>();
  let hold: ReturnType<typeof deferred<void>> | null = null;
  const png = testPng(10, 10);
  return {
    urls,
    signals,
    answer: () => answered.resolve(),
    holdAbort: () => {
      hold = deferred<void>();
    },
    letGo: () => hold?.resolve(),
    fetch: async (url, _budget, signal) => {
      urls.push(url);
      signals.push(signal);
      if (options.hangAll === true || urls.length === 1) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            void (hold?.promise ?? Promise.resolve()).then(() =>
              reject(
                new RemoteImageFetchError("transient", "remote_image_fetch_aborted"),
              ),
            );
          };
          void answered.promise.then(resolve);
          if (signal?.aborted) abort();
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return {
        mimeType: "image/png",
        data: Buffer.from(png),
        raster: { width: 10, height: 10, frames: 1 },
      };
    },
  };
}

/** The messages, in the order given, whose content is in `state`. */
async function statesOf(
  coordinator: MailContentCoordinator,
  messageIds: readonly string[],
  state: string,
): Promise<readonly string[]> {
  const states = await Promise.all(
    messageIds.map(async (messageId) => ({
      messageId,
      state: (await coordinator.getContent({ accountId: ACCOUNT_ID, messageId }))
        .state,
    })),
  );
  return states
    .filter((entry) => entry.state === state)
    .map((entry) => entry.messageId);
}

/**
 * Adds one Inbox thread per name beside the fixture's own, each a hundred
 * milliseconds newer than the one before it. A second batch names the history
 * it follows on from.
 */
function seedInbox(
  cache: SqliteMailMessageCache,
  names: readonly string[],
  options: {
    readonly baseSentAt?: number;
    readonly fromHistory?: string;
    readonly toHistory?: string;
  } = {},
): readonly { threadId: string; messageId: string; sentAt: number }[] {
  const entries = names.map((name, index) => ({
    threadId: `thread-${name}`,
    messageId: `message-thread-${name}`,
    sentAt: (options.baseSentAt ?? 200) + index * 100,
  }));
  cache.applyIncrementalPage({
    expectedHistoryId: options.fromHistory ?? "100",
    expectedPageToken: null,
    changes: entries.map((entry) => ({
      kind: "upsert" as const,
      value: threadFixture(ACCOUNT_ID, entry),
    })),
    nextPageToken: null,
    resultingHistoryId: options.toHistory ?? "101",
    now: 500,
  });
  return entries;
}

/** Publishes every body it is asked for: 8 bytes of shared raw MIME and 64 of text. */
function openRunner(): FakeMailContentWorkRunner {
  return new FakeMailContentWorkRunner(
    Array.from({ length: 30 }, () => (input: MailContentWorkInput) =>
      publish(input, { text: bodyText(input.providerMessageId) }),
    ),
  );
}

function bodyText(messageId: string): Buffer {
  return Buffer.from(messageId.padEnd(64, "."));
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
