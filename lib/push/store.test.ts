import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushSubscriptionId, type PushSubscriptionRecord } from "./model";
import {
  listPushSubscriptions,
  pushStateDirectory,
  readPushKinds,
  readVapidKeys,
  removePushSubscription,
  savePushSubscription,
  writePushKinds,
} from "./store";

const ENDPOINT = "https://web.push.apple.com/brain-store-endpoint-not-for-production";
/** 65 bytes, first byte 0x04, one repeated byte after it: the shape a browser
 *  produces and obviously not a key anyone holds. */
const P256DH = `BH${"p".repeat(85)}`;
const AUTH = "a".repeat(22);
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
  keys: { p256dh: P256DH, auth: AUTH },
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

  // The directory under test is one the store creates itself, not the one
  // mkdtemp made: mkdtemp already gives 0700, so asserting on it measured
  // Node's mode and not the store's.
  it("writes the private half 0600 inside a directory it creates 0700", async () => {
    const made = path.join(dir, "made-by-the-store");
    await readVapidKeys(made);
    expect((await stat(made)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(made, "vapid.json"))).mode & 0o777).toBe(0o600);
  });

  // fs.mkdir(recursive) leaves an existing directory's mode alone, so a push
  // directory laid down by hand at 0755 would stay 0755 and the key inside it
  // would be world-readable to anyone with a shell on the box.
  it("narrows a directory that already existed too wide", async () => {
    await chmod(dir, 0o755);
    await readVapidKeys(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("regenerates when the file on disk is not a pair, rather than throwing", async () => {
    await writeFile(path.join(dir, "vapid.json"), "{ not json", "utf8");
    expect((await readVapidKeys(dir)).publicKey.length).toBeGreaterThan(80);
  });

  // Losing the pair is the loudest failure this subsystem has: every device
  // stops receiving anything, because a browser baked the old public key into
  // the subscription it created. It must not happen in silence.
  it("says out loud that a pair it could not read was replaced", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(path.join(dir, "vapid.json"), "{ not json", "utf8");
    await readVapidKeys(dir);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/register again/);
    warn.mockRestore();
  });

  it("says nothing when there was no pair to lose", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await readVapidKeys(dir);
    await readVapidKeys(dir);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

  // lastSeenAt moves through a re-registration, which is the only event that
  // proves a device is still there. There is no separate toucher.
  it("moves lastSeenAt without moving createdAt when a device registers again", async () => {
    await savePushSubscription(record(), dir);
    await savePushSubscription({ ...record(), lastSeenAt: "2026-09-20T12:00:00.000Z" }, dir);
    const row = (await listPushSubscriptions(dir))[0];
    expect(row.lastSeenAt).toBe("2026-09-20T12:00:00.000Z");
    expect(row.createdAt).toBe("2026-09-14T12:00:00.000Z");
  });

  // A push service may replace an endpoint without asking, and the worker that
  // hears it has no user agent to name the device with, so it posts "This
  // device". Without the endpoint it replaced, the owner's Settings grew a
  // second row for one phone: "iPhone", last seen weeks ago and never ringing
  // again, beside "This device".
  it("moves a replaced endpoint's name and its first day onto the new row", async () => {
    await savePushSubscription(record(ENDPOINT, "iPhone"), dir);
    const moved = await savePushSubscription(
      {
        ...record(`${ENDPOINT}-replaced`, "This device"),
        createdAt: "2026-09-20T12:00:00.000Z",
        lastSeenAt: "2026-09-20T12:00:00.000Z",
      },
      dir,
      pushSubscriptionId(ENDPOINT),
    );
    const rows = await listPushSubscriptions(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(moved.id);
    expect(rows[0].deviceLabel).toBe("iPhone");
    expect(rows[0].createdAt).toBe("2026-09-14T12:00:00.000Z");
    expect(rows[0].lastSeenAt).toBe("2026-09-20T12:00:00.000Z");
  });

  // The Settings button that cures a rotated VAPID key also replaces the
  // retired row, and it sends its own real label (components/push-client.ts),
  // not the worker's placeholder. That real label must win: carrying the old
  // row's name over it would rename a Mac "iPhone" forever, the same bug in a
  // new shape one commit after the worker path fixed it.
  it("keeps the real label a rotated key's own re-subscribe sends, rather than the row it replaces", async () => {
    await savePushSubscription(record(ENDPOINT, "iPhone"), dir);
    const moved = await savePushSubscription(
      { ...record(`${ENDPOINT}-rotated`, "Mac"), createdAt: "2026-09-20T12:00:00.000Z" },
      dir,
      pushSubscriptionId(ENDPOINT),
    );
    const rows = await listPushSubscriptions(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(moved.id);
    expect(rows[0].deviceLabel).toBe("Mac");
    expect(rows[0].createdAt).toBe("2026-09-14T12:00:00.000Z");
  });

  it("takes a previous endpoint it holds no row for as an ordinary registration", async () => {
    const saved = await savePushSubscription(
      record(ENDPOINT, "This device"),
      dir,
      "0123456789abcdef",
    );
    expect(await listPushSubscriptions(dir)).toEqual([saved]);
    expect(saved.deviceLabel).toBe("This device");
  });

  // The relabel path is the one Settings uses, and it must keep winning: a
  // device re-registering on its own endpoint is naming itself, not being
  // replaced.
  it("still takes the new name when the endpoint did not change", async () => {
    await savePushSubscription(record(ENDPOINT, "iPhone"), dir);
    await savePushSubscription(
      record(ENDPOINT, "iPhone 17"),
      dir,
      pushSubscriptionId(ENDPOINT),
    );
    const rows = await listPushSubscriptions(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].deviceLabel).toBe("iPhone 17");
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
