import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushSubscriptionId } from "./model";
import { sendPush } from "./send";
import { listPushSubscriptions, savePushSubscription, writePushKinds } from "./store";

const ENDPOINT_A = "https://web.push.apple.com/brain-send-a-not-for-production";
const ENDPOINT_B = "https://fcm.googleapis.com/brain-send-b-not-for-production";
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "brain-push-send-"));
  for (const [endpoint, label] of [
    [ENDPOINT_A, "iPhone"],
    [ENDPOINT_B, "Laptop"],
  ] as const) {
    await savePushSubscription(
      {
        id: pushSubscriptionId(endpoint),
        endpoint,
        keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
        deviceLabel: label,
        createdAt: "2026-09-14T12:00:00.000Z",
        lastSeenAt: "2026-09-14T12:00:00.000Z",
      },
      dir,
    );
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
    expect(source).not.toMatch(/console\.\w+\([^)]*endpoint/);
  });
});
