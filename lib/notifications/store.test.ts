import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainEvents, type SequencedStoreEvent } from "@/lib/store/events";
import type { BrainNotification } from "./model";
import {
  NOTIFICATIONS_FILE,
  appendNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  notificationStateDirectory,
  unreadNotificationCount,
} from "./store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "brain-notifications-test-"));
});

function row(id: string, at: string): BrainNotification {
  return { id, kind: "task-reminder", at, title: "Water the plants", href: "/tasks" };
}

describe("the notification store's directory", () => {
  it("takes the env override first", () => {
    expect(notificationStateDirectory({ BRAIN_NOTIFICATIONS_STATE_DIR: "/tmp/elsewhere" })).toBe(
      "/tmp/elsewhere",
    );
  });

  it("is /var/lib/brain/notifications in production", () => {
    expect(notificationStateDirectory({ NODE_ENV: "production" })).toBe(
      "/var/lib/brain/notifications",
    );
  });

  it("is a per-user temp folder in development", () => {
    expect(notificationStateDirectory({ NODE_ENV: "development" })).toContain(os.tmpdir());
  });
});

describe("the notification store", () => {
  it("reads an empty list before anything has been written", async () => {
    expect(await listNotifications(dir)).toEqual([]);
    expect(await unreadNotificationCount(dir)).toBe(0);
  });

  it("keeps the newest first whatever order they arrive in", async () => {
    await appendNotification(row("b", "2026-09-14T09:00:00.000Z"), dir);
    await appendNotification(row("a", "2026-09-14T11:00:00.000Z"), dir);
    expect((await listNotifications(dir)).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("is idempotent on an id it already holds", async () => {
    expect(await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir)).toBe(true);
    expect(await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir)).toBe(false);
    expect(await listNotifications(dir)).toHaveLength(1);
  });

  // Five hundred and five real appends, each one a temp file, an fsync and a
  // rename, so this one test is seconds rather than milliseconds. Its own
  // directory is held in a local binding: the module-level `dir` is reassigned
  // before the next test, and a loop that outlived its test would otherwise
  // write these rows into whatever directory came next.
  it(
    "drops the oldest past the cap and keeps exactly five hundred",
    async () => {
      const target = dir;
      for (let index = 0; index < 505; index += 1) {
        const at = new Date(Date.UTC(2026, 8, 14, 0, 0, index)).toISOString();
        await appendNotification(row(`row-${index}`, at), target);
      }
      const rows = await listNotifications(target);
      expect(rows).toHaveLength(500);
      expect(rows[0].id).toBe("row-504");
      expect(rows.at(-1)!.id).toBe("row-5");
    },
    30_000,
  );

  it("marks named ids read and leaves the rest", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    await appendNotification(row("b", "2026-09-14T10:00:00.000Z"), dir);
    expect(await markNotificationsRead(["a", "missing"], "2026-09-14T12:00:00.000Z", dir)).toBe(1);
    const rows = await listNotifications(dir);
    expect(rows.find((n) => n.id === "a")!.readAt).toBe("2026-09-14T12:00:00.000Z");
    expect(rows.find((n) => n.id === "b")!.readAt).toBeUndefined();
    expect(await unreadNotificationCount(dir)).toBe(1);
  });

  it("does not move a readAt that is already there", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    await markNotificationsRead(["a"], "2026-09-14T12:00:00.000Z", dir);
    expect(await markNotificationsRead(["a"], "2026-09-14T13:00:00.000Z", dir)).toBe(0);
    expect((await listNotifications(dir))[0].readAt).toBe("2026-09-14T12:00:00.000Z");
  });

  it("marks everything read in one pass", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    await appendNotification(row("b", "2026-09-14T10:00:00.000Z"), dir);
    expect(await markAllNotificationsRead("2026-09-14T12:00:00.000Z", dir)).toBe(2);
    expect(await unreadNotificationCount(dir)).toBe(0);
  });

  it("writes the directory 0700 and the file 0600", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, NOTIFICATIONS_FILE))).mode & 0o777).toBe(0o600);
  });

  it("serialises concurrent appends rather than losing one", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendNotification(
          row(`row-${index}`, new Date(Date.UTC(2026, 8, 14, 0, 0, index)).toISOString()),
          dir,
        ),
      ),
    );
    expect(await listNotifications(dir)).toHaveLength(20);
  });

  it("reads an empty list from a file that is not JSON, and never throws", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    await writeFile(path.join(dir, NOTIFICATIONS_FILE), "{ not json", "utf8");
    expect(await listNotifications(dir)).toEqual([]);
  });

  it("drops a row the schema refuses and keeps the rest", async () => {
    await writeFile(
      path.join(dir, NOTIFICATIONS_FILE),
      JSON.stringify({
        version: 1,
        items: [row("a", "2026-09-14T09:00:00.000Z"), { id: "b", kind: "nope" }],
      }) + "\n",
      "utf8",
    );
    expect((await listNotifications(dir)).map((n) => n.id)).toEqual(["a"]);
  });

  it("leaves nothing in the notes folder", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    const source = await readFile(path.join(process.cwd(), "lib/notifications/store.ts"), "utf8");
    expect(source).not.toContain("NOTES_ROOT");
    expect(source).not.toContain("getStore");
  });
});

describe("the store's live announcement", () => {
  const seen: SequencedStoreEvent[] = [];
  const listen = (event: SequencedStoreEvent) => {
    seen.push(event);
  };

  beforeEach(() => {
    seen.length = 0;
    brainEvents.on("change", listen);
  });

  afterEach(() => {
    brainEvents.off("change", listen);
  });

  it("announces a row the centre took, so an open tab lights the bell", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    const announced = seen.filter((event) => event.type === "notification");
    expect(announced).toHaveLength(1);
    expect(announced[0].id).toBe("a");
  });

  it("stays quiet on an id the centre already holds", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    expect(seen.filter((event) => event.type === "notification")).toHaveLength(1);
  });

  it("says nothing about a read, which the reader already knows", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    seen.length = 0;
    await markNotificationsRead(["a"], "2026-09-14T12:00:00.000Z", dir);
    await markAllNotificationsRead("2026-09-14T12:00:00.000Z", dir);
    expect(seen).toHaveLength(0);
  });
});
