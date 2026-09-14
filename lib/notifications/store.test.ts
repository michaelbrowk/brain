import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainEvents, type SequencedStoreEvent } from "@/lib/store/events";
import { NOTIFICATION_CAP, type BrainNotification } from "./model";
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

// The house pattern of lib/owner-settings.test.ts and lib/update-check.test.ts:
// a temp directory per test, removed after it. Left behind, a full centre is
// 60K and a suite run leaves dozens.
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function row(id: string, at: string): BrainNotification {
  return { id, kind: "task-reminder", at, title: "Water the plants", href: "/tasks" };
}

/** A centre at the cap, written straight to the file. Five hundred real
 *  appends are five hundred fsyncs for a boundary that is one comparison, and
 *  seeding is also the only way to reach it with rows NEWER than the one under
 *  test, which is the case that matters. */
async function seed(target: string, items: BrainNotification[]): Promise<void> {
  await writeFile(
    path.join(target, NOTIFICATIONS_FILE),
    JSON.stringify({ version: 1, items }) + "\n",
    "utf8",
  );
}

function fullCentre(): BrainNotification[] {
  return Array.from({ length: NOTIFICATION_CAP }, (_, index) =>
    row(`row-${index}`, new Date(Date.UTC(2026, 8, 14, 1, 0, index)).toISOString()),
  );
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

  it("drops the oldest past the cap and keeps exactly five hundred", async () => {
    await seed(dir, fullCentre());
    for (let index = 0; index < 5; index += 1) {
      const at = new Date(Date.UTC(2026, 8, 14, 2, 0, index)).toISOString();
      expect(await appendNotification(row(`fresh-${index}`, at), dir)).toBe(true);
    }
    const rows = await listNotifications(dir);
    expect(rows).toHaveLength(NOTIFICATION_CAP);
    expect(rows[0].id).toBe("fresh-4");
    expect(rows.at(-1)!.id).toBe("row-5");
  });

  it("refuses a row older than everything a full centre holds, and stores nothing", async () => {
    await seed(dir, fullCentre());
    // The shape Task 2 produces: a reminder missed while the server was down,
    // written with the instant it was due rather than the instant it was found.
    expect(await appendNotification(row("missed-yesterday", "2026-09-13T08:00:00.000Z"), dir)).toBe(
      false,
    );
    const rows = await listNotifications(dir);
    expect(rows).toHaveLength(NOTIFICATION_CAP);
    expect(rows.some((n) => n.id === "missed-yesterday")).toBe(false);
  });

  it("refuses a row the schema refuses, and writes nothing at all", async () => {
    const bad = { ...row("a", "2026-09-14T09:00:00.000Z"), at: "yesterday" } as BrainNotification;
    expect(await appendNotification(bad, dir)).toBe(false);
    expect(await listNotifications(dir)).toEqual([]);
    await expect(stat(path.join(dir, NOTIFICATIONS_FILE))).rejects.toThrow();
  });

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

  // A readAt the schema refuses would be written onto real rows and drop every
  // one of them at the next read, so a read would delete notifications.
  it("refuses an instant the schema refuses and touches no row", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    for (const bad of ["2026-09-14T12:00:00Z", "2026-09-14", "2026-13-45T99:99:99.999Z"]) {
      expect(await markNotificationsRead(["a"], bad, dir)).toBe(0);
      expect(await markAllNotificationsRead(bad, dir)).toBe(0);
    }
    expect((await listNotifications(dir))[0].readAt).toBeUndefined();
    expect(await unreadNotificationCount(dir)).toBe(1);
  });

  it("writes the directory 0700 and the file 0600", async () => {
    // A directory the store creates itself, not the one mkdtemp made: mkdtemp
    // is 0700 whatever the store asks for, so the nested name is what puts
    // writeAll's own mkdir mode under test.
    const nested = path.join(dir, "nested");
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), nested);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(nested, NOTIFICATIONS_FILE))).mode & 0o777).toBe(0o600);
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
    await seed(dir, [
      row("a", "2026-09-14T09:00:00.000Z"),
      { id: "b", kind: "nope" } as unknown as BrainNotification,
    ]);
    expect((await listNotifications(dir)).map((n) => n.id)).toEqual(["a"]);
  });

  it("leaves nothing in the notes folder", async () => {
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
  const announced = () => seen.filter((event) => event.type === "notification");

  beforeEach(() => {
    seen.length = 0;
    brainEvents.on("change", listen);
  });

  afterEach(() => {
    brainEvents.off("change", listen);
  });

  it("announces a row the centre took, so an open tab lights the bell", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    expect(announced()).toHaveLength(1);
    expect(announced()[0].id).toBe("a");
  });

  it("stays quiet on an id the centre already holds", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    expect(announced()).toHaveLength(1);
  });

  it("stays quiet on a row the schema refuses", async () => {
    const bad = { ...row("a", "2026-09-14T09:00:00.000Z"), title: "" } as BrainNotification;
    expect(await appendNotification(bad, dir)).toBe(false);
    expect(announced()).toHaveLength(0);
  });

  it("stays quiet on a row the cap dropped", async () => {
    await seed(dir, fullCentre());
    expect(await appendNotification(row("too-old", "2026-09-13T08:00:00.000Z"), dir)).toBe(false);
    expect(announced()).toHaveLength(0);
  });

  it("says nothing about a read, which the reader already knows", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dir);
    seen.length = 0;
    await markNotificationsRead(["a"], "2026-09-14T12:00:00.000Z", dir);
    await markAllNotificationsRead("2026-09-14T12:00:00.000Z", dir);
    expect(seen).toHaveLength(0);
  });
});
