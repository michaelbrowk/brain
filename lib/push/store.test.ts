import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushSubscriptionId, type PushSubscriptionRecord } from "./model";
import {
  listPushSubscriptions,
  pushStateDirectory,
  readPushKinds,
  readVapidKeys,
  removePushSubscription,
  savePushSubscription,
  touchPushSubscription,
  writePushKinds,
} from "./store";

const ENDPOINT = "https://web.push.apple.com/brain-store-endpoint-not-for-production";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "brain-push-test-"));
});

// The house pattern of lib/notifications/store.test.ts: the temp directory a
// test made is the test's to remove.
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = (endpoint = ENDPOINT, label = "iPhone"): PushSubscriptionRecord => ({
  id: pushSubscriptionId(endpoint),
  endpoint,
  keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
  deviceLabel: label,
  createdAt: "2026-09-14T12:00:00.000Z",
  lastSeenAt: "2026-09-14T12:00:00.000Z",
});

describe("the push state directory", () => {
  it("takes the env override, then production, then a temp folder", () => {
    expect(pushStateDirectory({ BRAIN_PUSH_STATE_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    expect(pushStateDirectory({ NODE_ENV: "production" })).toBe("/var/lib/brain/push");
    expect(pushStateDirectory({ NODE_ENV: "development" })).toContain(os.tmpdir());
  });
});

describe("the VAPID key pair", () => {
  it("generates a pair on first read and keeps it", async () => {
    const first = await readVapidKeys(dir);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(await readVapidKeys(dir)).toEqual(first);
  });

  it("writes the private half 0600 inside a 0700 directory", async () => {
    await readVapidKeys(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, "vapid.json"))).mode & 0o777).toBe(0o600);
  });

  it("regenerates when the file on disk is not a pair, rather than throwing", async () => {
    await writeFile(path.join(dir, "vapid.json"), "{ not json", "utf8");
    expect((await readVapidKeys(dir)).publicKey.length).toBeGreaterThan(80);
  });

  it("keeps the private half out of every other file in the directory", async () => {
    const keys = await readVapidKeys(dir);
    await savePushSubscription(record(), dir);
    await writePushKinds({ "mail-new": false }, dir);
    for (const name of ["subscriptions.json", "preferences.json"]) {
      expect(await readFile(path.join(dir, name), "utf8")).not.toContain(keys.privateKey);
    }
  });
});

describe("the subscription store", () => {
  it("saves, lists and removes by id", async () => {
    const saved = await savePushSubscription(record(), dir);
    expect((await listPushSubscriptions(dir)).map((r) => r.id)).toEqual([saved.id]);
    expect(await removePushSubscription(saved.id, dir)).toBe(true);
    expect(await listPushSubscriptions(dir)).toEqual([]);
  });

  it("answers false when removing an id it does not hold", async () => {
    expect(await removePushSubscription("0123456789abcdef", dir)).toBe(false);
  });

  it("replaces a device that re-subscribes on the same endpoint, keeping createdAt", async () => {
    await savePushSubscription(record(), dir);
    const again = await savePushSubscription(
      { ...record(ENDPOINT, "iPhone 17"), createdAt: "2026-09-20T12:00:00.000Z" },
      dir,
    );
    const rows = await listPushSubscriptions(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].deviceLabel).toBe("iPhone 17");
    expect(rows[0].createdAt).toBe("2026-09-14T12:00:00.000Z");
    expect(again.id).toBe(rows[0].id);
  });

  it("drops the oldest past the cap", async () => {
    for (let index = 0; index < 21; index += 1) {
      await savePushSubscription(record(`${ENDPOINT}-${index}`, `device-${index}`), dir);
    }
    const rows = await listPushSubscriptions(dir);
    expect(rows).toHaveLength(20);
    expect(rows.some((r) => r.deviceLabel === "device-0")).toBe(false);
  });

  it("moves lastSeenAt without moving createdAt", async () => {
    const saved = await savePushSubscription(record(), dir);
    await touchPushSubscription(saved.id, "2026-09-20T12:00:00.000Z", dir);
    const row = (await listPushSubscriptions(dir))[0];
    expect(row.lastSeenAt).toBe("2026-09-20T12:00:00.000Z");
    expect(row.createdAt).toBe("2026-09-14T12:00:00.000Z");
  });
});

describe("the per-kind toggles", () => {
  it("are both on before anything is written", async () => {
    expect(await readPushKinds(dir)).toEqual({ "task-reminder": true, "mail-new": true });
  });

  it("take a partial patch and leave the other alone", async () => {
    expect(await writePushKinds({ "mail-new": false }, dir)).toEqual({
      "task-reminder": true,
      "mail-new": false,
    });
    expect(await readPushKinds(dir)).toEqual({ "task-reminder": true, "mail-new": false });
  });

  it("read as both on when the file is not a pair of booleans", async () => {
    await writeFile(path.join(dir, "preferences.json"), JSON.stringify({ "mail-new": "no" }), "utf8");
    expect(await readPushKinds(dir)).toEqual({ "task-reminder": true, "mail-new": true });
  });
});
