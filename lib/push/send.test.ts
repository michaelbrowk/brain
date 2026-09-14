import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushSubscriptionId, type PushSubscriptionRecord } from "./model";
import { PUSH_REQUEST_TIMEOUT_MS, PUSH_SEND_CONCURRENCY, sendPush } from "./send";
import { listPushSubscriptions, savePushSubscription, writePushKinds } from "./store";

/** The library is stubbed for one test, the one that proves what the real
 *  delivery path hands it. Nothing here reaches a push service, and the pair
 *  it answers with is a run of one character rather than a key. */
const webPush = vi.hoisted(() => ({
  sendNotification:
    vi.fn<
      (
        subscription: unknown,
        payload: string,
        options: Record<string, unknown>,
      ) => Promise<void>
    >(),
  generateVAPIDKeys: vi.fn(() => ({
    publicKey: `B${"k".repeat(86)}`,
    privateKey: "x".repeat(43),
  })),
}));
vi.mock("web-push", () => ({ default: webPush }));

const ENDPOINT_A = "https://web.push.apple.com/brain-send-a-not-for-production";
const ENDPOINT_B = "https://fcm.googleapis.com/brain-send-b-not-for-production";
/** 65 bytes, first byte 0x04: the shape a browser produces, filled with one
 *  repeated byte so it is obviously not a key anyone holds. */
const P256DH = `BH${"p".repeat(85)}`;
const AUTH = "a".repeat(22);
let dir: string;

const device = (endpoint: string, deviceLabel: string): PushSubscriptionRecord => ({
  id: pushSubscriptionId(endpoint),
  endpoint,
  keys: { p256dh: P256DH, auth: AUTH },
  deviceLabel,
  createdAt: "2026-09-14T12:00:00.000Z",
  lastSeenAt: "2026-09-14T12:00:00.000Z",
});

/** A watcher list the injected `deliver` announces on, so the test waits for
 *  the delivery it needs rather than for a timer. A `setTimeout(0)` here
 *  raced the store's own file reads and failed about half the time. */
const watchers = new Set<() => void>();
const announce = () => {
  for (const watcher of [...watchers]) watcher();
};
const waitFor = (ready: () => boolean) =>
  new Promise<void>((resolve) => {
    const watcher = () => {
      if (!ready()) return;
      watchers.delete(watcher);
      resolve();
    };
    watchers.add(watcher);
    watcher();
  });

beforeEach(async () => {
  webPush.sendNotification.mockReset();
  webPush.sendNotification.mockResolvedValue(undefined);
  dir = await mkdtemp(path.join(os.tmpdir(), "brain-push-send-"));
  for (const [endpoint, label] of [
    [ENDPOINT_A, "iPhone"],
    [ENDPOINT_B, "Laptop"],
  ] as const) {
    await savePushSubscription(device(endpoint, label), dir);
  }
});

// The house pattern of lib/notifications/store.test.ts: the temp directory a
// test made is the test's to remove.
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sendPush", () => {
  it("sends one message per device with the title, the body and the href and nothing else", async () => {
    const seen: { endpoint: string; payload: unknown; ttl: number }[] = [];
    const result = await sendPush(
      "task-reminder",
      { title: "Water the plants", body: "13:00", href: "/tasks" },
      {
        dir,
        deliver: async (record, payload, options) => {
          seen.push({ endpoint: record.endpoint, payload: JSON.parse(payload), ttl: options.TTL });
        },
      },
    );
    expect(result).toEqual({ sent: 2, removed: 0, skipped: null });
    expect(seen.map((s) => s.endpoint).sort()).toEqual([ENDPOINT_B, ENDPOINT_A].sort());
    expect(seen[0].payload).toEqual({ title: "Water the plants", body: "13:00", href: "/tasks" });
    expect(seen[0].ttl).toBe(3600);
  });

  it("carries the tag the producer set, so two reminders in one scan both stand", async () => {
    // The worker tags a notification `brain:<tag>` and falls back to the href
    // only when there is none. Dropping the tag here would put every reminder
    // back on `brain:/tasks`, where the second replaces the first.
    const seen: unknown[] = [];
    await sendPush(
      "task-reminder",
      {
        title: "Water the plants",
        body: "13:00",
        href: "/tasks",
        tag: "task-reminder:task-alpha:2026-09-14T13:00",
      },
      {
        dir,
        deliver: async (_record, payload) => {
          seen.push(JSON.parse(payload));
        },
      },
    );
    expect(seen[0]).toEqual({
      title: "Water the plants",
      body: "13:00",
      href: "/tasks",
      tag: "task-reminder:task-alpha:2026-09-14T13:00",
    });
  });

  it("sends nothing when the kind is switched off", async () => {
    await writePushKinds({ "task-reminder": false }, dir);
    let called = 0;
    expect(
      await sendPush(
        "task-reminder",
        { title: "Water the plants", href: "/tasks" },
        {
          dir,
          deliver: async () => {
            called += 1;
          },
        },
      ),
    ).toEqual({ sent: 0, removed: 0, skipped: "kind-off" });
    expect(called).toBe(0);
  });

  it("still sends the other kind when one is switched off", async () => {
    await writePushKinds({ "task-reminder": false }, dir);
    const result = await sendPush(
      "mail-new",
      { title: "Ana Silva", body: "Lunch on Friday", href: "/mail" },
      { dir, deliver: async () => undefined },
    );
    expect(result.sent).toBe(2);
  });

  it("removes a subscription the push service answers 410 for", async () => {
    const result = await sendPush(
      "task-reminder",
      { title: "Water the plants", href: "/tasks" },
      {
        dir,
        deliver: async (record) => {
          if (record.endpoint !== ENDPOINT_A) return;
          const error = new Error("gone") as Error & { statusCode: number };
          error.statusCode = 410;
          throw error;
        },
      },
    );
    expect(result).toEqual({ sent: 1, removed: 1, skipped: null });
    expect((await listPushSubscriptions(dir)).map((r) => r.deviceLabel)).toEqual(["Laptop"]);
  });

  it("removes a subscription answered 404 as well", async () => {
    const result = await sendPush(
      "task-reminder",
      { title: "Water the plants", href: "/tasks" },
      {
        dir,
        deliver: async () => {
          const error = new Error("no such endpoint") as Error & { statusCode: number };
          error.statusCode = 404;
          throw error;
        },
      },
    );
    expect(result).toEqual({ sent: 0, removed: 2, skipped: null });
  });

  // WebPushError's message is the same constant for every status, so a line
  // without the code cannot tell a rate limit from an outage.
  it("names the status code in a failure, and no argument carries the endpoint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await sendPush(
      "task-reminder",
      { title: "Water the plants", href: "/tasks" },
      {
        dir,
        deliver: async () => {
          const error = new Error("Received unexpected response code") as Error & {
            statusCode: number;
          };
          error.statusCode = 429;
          throw error;
        },
      },
    );
    expect(warn).toHaveBeenCalledTimes(2);
    const logged = warn.mock.calls
      .map((call) => call.map((one) => (typeof one === "string" ? one : JSON.stringify(one))).join(" "))
      .join("\n");
    expect(logged).toContain("429");
    expect(logged).not.toContain("web.push.apple.com");
    expect(logged).not.toContain("fcm.googleapis.com");
    warn.mockRestore();
  });

  it("keeps a subscription the service rate-limited or refused", async () => {
    for (const statusCode of [400, 413, 429, 500]) {
      const result = await sendPush(
        "task-reminder",
        { title: "Water the plants", href: "/tasks" },
        {
          dir,
          deliver: async () => {
            const error = new Error("no") as Error & { statusCode: number };
            error.statusCode = statusCode;
            throw error;
          },
        },
      );
      expect(result.removed).toBe(0);
      expect(await listPushSubscriptions(dir)).toHaveLength(2);
    }
  });

  it("skips with no devices registered", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "brain-push-empty-"));
    expect(
      await sendPush(
        "task-reminder",
        { title: "x", href: "/tasks" },
        { dir: empty, deliver: async () => undefined },
      ),
    ).toEqual({ sent: 0, removed: 0, skipped: "no-devices" });
    await rm(empty, { recursive: true, force: true });
  });

  it("never logs an endpoint", async () => {
    const source = await readFile(path.join(process.cwd(), "lib/push/send.ts"), "utf8");
    // The whole call, not the run up to the first closing paren: an object
    // argument leaks the endpoint too, because Node serializes what it is
    // handed.
    const calls = source.match(/console\.\w+\([\s\S]*?\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toContain("endpoint");
      expect(call).not.toMatch(/[(,]\s*record\s*[,)]/);
    }
  });

  it("cuts a title and a body to what the worker will show", async () => {
    const seen: string[] = [];
    await sendPush(
      "task-reminder",
      { title: "T".repeat(300), body: "B".repeat(900), href: "/tasks" },
      {
        dir,
        deliver: async (record, payload) => {
          expect(record.deviceLabel).toMatch(/iPhone|Laptop/);
          seen.push(payload);
        },
      },
    );
    const parsed = JSON.parse(seen[0]);
    expect(parsed.title).toHaveLength(200);
    expect(parsed.body).toHaveLength(400);
    expect(parsed.href).toBe("/tasks");
  });

  it("delivers four at a time, so one hung endpoint does not stall the other seven", async () => {
    const many = await mkdtemp(path.join(os.tmpdir(), "brain-push-many-"));
    for (let index = 0; index < 8; index += 1) {
      await savePushSubscription(device(`${ENDPOINT_A}-${index}`, `device-${index}`), many);
    }
    const started: string[] = [];
    const finished: string[] = [];
    const gates: Array<() => void> = [];
    const run = sendPush(
      "task-reminder",
      { title: "Water the plants", href: "/tasks" },
      {
        dir: many,
        // One gate per call, opened by the test. Nothing here resolves on its
        // own, so every step below is a state the test put the send into.
        deliver: async (record) => {
          started.push(record.deviceLabel);
          announce();
          await new Promise<void>((resolve) => gates.push(resolve));
          finished.push(record.deviceLabel);
          announce();
        },
      },
    );

    await waitFor(() => started.length === 4);
    expect(started).toEqual(["device-0", "device-1", "device-2", "device-3"]);
    expect(finished).toEqual([]);
    expect(PUSH_SEND_CONCURRENCY).toBe(4);

    // A fifth can only start when a lane is freed. device-0's gate stays shut
    // throughout: it is the hung endpoint.
    gates[1]();
    await waitFor(() => started.length === 5);
    expect(started[4]).toBe("device-4");

    let released = 2;
    while (released < 8) {
      gates[released]();
      released += 1;
      if (started.length < 8) await waitFor(() => started.length === released + 3);
    }
    await waitFor(() => finished.length === 7);
    expect(started).toHaveLength(8);
    expect(finished).not.toContain("device-0");

    gates[0]();
    expect(await run).toEqual({ sent: 8, removed: 0, skipped: null });
    await rm(many, { recursive: true, force: true });
  });

  // The one test that runs the real delivery path, with the library stubbed.
  // web-push sets a socket timeout only when it is given one, so without this
  // an unresponsive push service holds the request open with no ceiling.
  it("hands web-push the subscription, the payload, the TTL and a request timeout", async () => {
    const result = await sendPush(
      "task-reminder",
      { title: "Water the plants", body: "13:00", href: "/tasks" },
      { dir },
    );
    expect(result).toEqual({ sent: 2, removed: 0, skipped: null });
    expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
    const [subscription, payload, options] = webPush.sendNotification.mock.calls[0];
    expect(subscription).toEqual({ endpoint: ENDPOINT_A, keys: { p256dh: P256DH, auth: AUTH } });
    expect(JSON.parse(payload)).toEqual({
      title: "Water the plants",
      body: "13:00",
      href: "/tasks",
    });
    expect(options.TTL).toBe(3600);
    expect(options.timeout).toBe(PUSH_REQUEST_TIMEOUT_MS);
    expect(PUSH_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(options.vapidDetails).toMatchObject({ publicKey: `B${"k".repeat(86)}` });
  });

  // The pair is read once per send rather than once per device. Once per
  // process would be wrong: a pair replaced on disk has to reach the next
  // send, or every device stays quiet until a restart.
  it("reads the pair again on the next send, so a replaced one is picked up", async () => {
    await sendPush("task-reminder", { title: "Water the plants", href: "/tasks" }, { dir });
    const rotated = `B${"z".repeat(86)}`;
    await writeFile(
      path.join(dir, "vapid.json"),
      JSON.stringify({ publicKey: rotated, privateKey: "y".repeat(43) }),
      "utf8",
    );
    await sendPush("task-reminder", { title: "Water the plants", href: "/tasks" }, { dir });
    const details = webPush.sendNotification.mock.calls.at(-1)?.[2].vapidDetails as {
      publicKey: string;
    };
    expect(details.publicKey).toBe(rotated);
  });
});
