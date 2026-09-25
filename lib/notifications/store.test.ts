import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainEvents, type SequencedStoreEvent } from "@/lib/store/events";
import { mailRow } from "./mail-rows";
import {
  NOTIFICATION_CAP,
  NOTIFICATION_KIND_CAP,
  type BrainNotification,
} from "./model";
import {
  NOTIFICATIONS_FILE,
  appendNotification,
  appendOrFoldNotification,
  clearNotifications,
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

/** One counted mail row, of the shape a scan writes: the instant it opened is
 *  its id, so a read row is never counted into again and the next scan opens
 *  another beside it. */
function mail(at: string): BrainNotification {
  return mailRow(at, 1, at);
}

/** A kind's whole share, written straight to the file. Two hundred real
 *  appends are two hundred fsyncs for a boundary that is one comparison, and
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
  return Array.from({ length: NOTIFICATION_KIND_CAP }, (_, index) =>
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

  it("drops a kind's oldest past its share and keeps exactly two hundred", async () => {
    await seed(dir, fullCentre());
    for (let index = 0; index < 5; index += 1) {
      const at = new Date(Date.UTC(2026, 8, 14, 2, 0, index)).toISOString();
      expect(await appendNotification(row(`fresh-${index}`, at), dir)).toBe(true);
    }
    const rows = await listNotifications(dir);
    expect(rows).toHaveLength(NOTIFICATION_KIND_CAP);
    expect(rows[0].id).toBe("fresh-4");
    expect(rows.at(-1)!.id).toBe("row-5");
  });

  // A KIND CANNOT PUSH ANOTHER KIND OUT.
  //
  // Mail opens a new row whenever the last one was read, so a few busy days of
  // letters are a few hundred rows of one kind, all newer than the reminders
  // under them. Against one shared bound those reminders go: the thing that
  // wanted the reader at 13:00 is evicted by the mail they had already dealt
  // with. Each kind holds its own share instead, and the total is still bounded
  // because every kind's share is.
  it("keeps the reminders when a burst of mail fills the centre", async () => {
    const reminders = [
      row("reminder-1", "2026-09-14T09:00:00.000Z"),
      row("reminder-2", "2026-09-14T09:05:00.000Z"),
      row("reminder-3", "2026-09-14T09:10:00.000Z"),
    ];
    // Every letter newer than every reminder, which is the shape that hurts.
    const burst = Array.from({ length: NOTIFICATION_CAP }, (_, index) =>
      mail(new Date(Date.UTC(2026, 8, 14, 10, 0, index)).toISOString()),
    );
    await seed(dir, [...reminders, ...burst]);

    // One more letter, and with it the write that applies the bound.
    expect(
      await appendNotification(mail("2026-09-14T23:00:00.000Z"), dir),
    ).toBe(true);

    const rows = await listNotifications(dir);
    expect(rows.filter((held) => held.kind === "task-reminder").map((held) => held.id)).toEqual([
      "reminder-3",
      "reminder-2",
      "reminder-1",
    ]);
    expect(rows.filter((held) => held.kind === "mail-new")).toHaveLength(
      NOTIFICATION_KIND_CAP,
    );
    // The newest letter is the one that stayed, and the oldest went.
    expect(rows[0].id).toBe("mail-new:2026-09-14T23:00:00.000Z");
  });

  it("refuses a row older than everything its kind's share holds, and stores nothing", async () => {
    await seed(dir, fullCentre());
    // The shape Task 2 produces: a reminder missed while the server was down,
    // written with the instant it was due rather than the instant it was found.
    expect(await appendNotification(row("missed-yesterday", "2026-09-13T08:00:00.000Z"), dir)).toBe(
      false,
    );
    const rows = await listNotifications(dir);
    expect(rows).toHaveLength(NOTIFICATION_KIND_CAP);
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

  it("clears every row and says how many it removed", async () => {
    await seed(dir, [
      row("a", "2026-09-14T09:00:00.000Z"),
      row("b", "2026-09-14T10:00:00.000Z"),
    ]);
    expect(await clearNotifications(dir)).toBe(2);
    expect(await listNotifications(dir)).toEqual([]);
    expect(await unreadNotificationCount(dir)).toBe(0);
  });

  it("clears a centre that has no file yet without creating one", async () => {
    expect(await clearNotifications(dir)).toBe(0);
    await expect(stat(path.join(dir, NOTIFICATIONS_FILE))).rejects.toThrow();
  });

  // THE CLEAR GOES THROUGH `writeAll` LIKE EVERY OTHER WRITE HERE, AND THE
  // INODE IS HOW THAT IS VISIBLE.
  //
  // A bare `fs.writeFile([])` would pass every assertion above: the rows are
  // gone either way. What it would lose is the temp-then-rename that keeps a
  // reader from ever seeing a half-written file, and the 0600 the systemd unit's
  // umask supplies in production and a developer's 0022 does not. `atomicWrite`
  // renames a new file over the old one, so the number changes; an in-place
  // write keeps it. No leftover `.tmp-` either, which is the other half of the
  // rename having happened.
  it("clears through an atomic write: a new file, 0600, no temp left", async () => {
    await seed(dir, [row("a", "2026-09-14T09:00:00.000Z")]);
    const file = path.join(dir, NOTIFICATIONS_FILE);
    await chmod(file, 0o644);
    const before = await stat(file);
    expect(await clearNotifications(dir)).toBe(1);
    const after = await stat(file);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).sort()).toEqual([NOTIFICATIONS_FILE]);
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

/** THE FOLD, FROM THE FILE'S SIDE.
 *
 *  The producer decides what a burst reads as; this decides whether there is
 *  still a row to fold into. Both answers are needed in one turn under the same
 *  lock, which is why the store takes the pair rather than a caller doing
 *  read-then-write around it.
 */
describe("appending, or folding into what is already there", () => {
  const agent = (id: string, at: string, title: string): BrainNotification => ({
    id,
    kind: "agent-action",
    at,
    title,
    href: "/mail",
  });

  it("replaces the held row rather than adding one", async () => {
    await appendNotification(agent("agent-1", "2026-09-14T12:00:00.000Z", "Claude archived a thread"), dir);
    const outcome = await appendOrFoldNotification(
      agent("agent-2", "2026-09-14T12:01:00.000Z", "Claude archived a thread"),
      agent("agent-1", "2026-09-14T12:01:00.000Z", "Claude archived 2 threads"),
      dir,
    );
    expect(outcome).toBe("folded");
    const rows = await listNotifications(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "agent-1",
      at: "2026-09-14T12:01:00.000Z",
      title: "Claude archived 2 threads",
    });
    expect(await unreadNotificationCount(dir)).toBe(1);
  });

  it("appends when the row it would fold into is gone", async () => {
    // The cap dropped it, or the file was cleared. The memo proposes and the
    // file decides.
    const outcome = await appendOrFoldNotification(
      agent("agent-2", "2026-09-14T12:01:00.000Z", "Claude archived a thread"),
      agent("agent-1", "2026-09-14T12:01:00.000Z", "Claude archived 2 threads"),
      dir,
    );
    expect(outcome).toBe("appended");
    expect(await listNotifications(dir)).toMatchObject([{ id: "agent-2" }]);
  });

  /** A ROW THE READER HAS SEEN IS NOT REWRITTEN UNDER THEM. Folding into it
   *  would either hide the new action behind a read row, or drag a row they
   *  have dealt with back to unread. A new row says the true thing. */
  it("appends rather than folding into a row already read", async () => {
    await appendNotification(agent("agent-1", "2026-09-14T12:00:00.000Z", "Claude archived a thread"), dir);
    await markAllNotificationsRead("2026-09-14T12:00:30.000Z", dir);

    const outcome = await appendOrFoldNotification(
      agent("agent-2", "2026-09-14T12:01:00.000Z", "Claude archived a thread"),
      agent("agent-1", "2026-09-14T12:01:00.000Z", "Claude archived 2 threads"),
      dir,
    );
    expect(outcome).toBe("appended");
    const rows = await listNotifications(dir);
    expect(rows.map((held) => held.id)).toEqual(["agent-2", "agent-1"]);
    expect(await unreadNotificationCount(dir)).toBe(1);
  });

  it("appends plainly when there is nothing to fold into at all", async () => {
    const outcome = await appendOrFoldNotification(
      agent("agent-1", "2026-09-14T12:00:00.000Z", "Claude archived a thread"),
      null,
      dir,
    );
    expect(outcome).toBe("appended");
    expect(await listNotifications(dir)).toHaveLength(1);
  });

  it("refuses the row it already holds, folded or not", async () => {
    await appendNotification(agent("agent-1", "2026-09-14T12:00:00.000Z", "Claude archived a thread"), dir);
    expect(
      await appendOrFoldNotification(
        agent("agent-1", "2026-09-14T12:00:00.000Z", "Claude archived a thread"),
        null,
        dir,
      ),
    ).toBe("refused");
    expect(await listNotifications(dir)).toHaveLength(1);
  });

  it("trims to the kind's share on the fold branch as well as on the append", async () => {
    // A fold is count-preserving, so it cannot push a kind past its share on
    // its own. A file that already holds more than the share can: from an older
    // writer, or a hand edit. Both branches trim, so which one ran is not a
    // thing a reader has to know. The reminders beside it are untouched either
    // way, which is what a share per kind is for.
    const target = agent("agent-1", "2026-09-14T12:00:00.000Z", "Claude archived a thread");
    const overFull = Array.from({ length: NOTIFICATION_KIND_CAP }, (_, index) =>
      agent(
        `agent-old-${index}`,
        new Date(Date.UTC(2026, 8, 14, 11, 0, index)).toISOString(),
        "Claude archived a thread",
      ),
    );
    await seed(dir, [...fullCentre(), ...overFull, target]);

    const outcome = await appendOrFoldNotification(
      agent("agent-2", "2026-09-14T12:01:00.000Z", "Claude archived a thread"),
      agent("agent-1", "2026-09-14T12:01:00.000Z", "Claude archived 2 threads"),
      dir,
    );

    expect(outcome).toBe("folded");
    const rows = await listNotifications(dir);
    expect(rows.filter((held) => held.kind === "agent-action")).toHaveLength(
      NOTIFICATION_KIND_CAP,
    );
    expect(rows.filter((held) => held.kind === "task-reminder")).toHaveLength(
      NOTIFICATION_KIND_CAP,
    );
    expect(rows[0]).toMatchObject({ id: "agent-1", title: "Claude archived 2 threads" });
  });

  it("announces a fold, so an open bell counts it", async () => {
    await appendNotification(agent("agent-1", "2026-09-14T12:00:00.000Z", "Claude archived a thread"), dir);
    const seen: SequencedStoreEvent[] = [];
    const listener = (event: SequencedStoreEvent) => seen.push(event);
    brainEvents.on("change", listener);
    try {
      await appendOrFoldNotification(
        agent("agent-2", "2026-09-14T12:01:00.000Z", "Claude archived a thread"),
        agent("agent-1", "2026-09-14T12:01:00.000Z", "Claude archived 2 threads"),
        dir,
      );
    } finally {
      brainEvents.off("change", listener);
    }
    expect(seen).toMatchObject([{ type: "notification", id: "agent-1" }]);
  });
});

/** THE ROWS AN OLDER BUILD WROTE, on the first read after the upgrade.
 *
 *  One row per thread is what the centre held until 0.12.2. They are folded on
 *  the way out of the file rather than by a migration pass, so a file that has
 *  none costs one filter and no version bump. `mail-rows.test.ts` owns the
 *  arithmetic; this is the seam. */
describe("a centre written by an older build", () => {
  function old(id: string, at: string, readAt?: string): BrainNotification {
    return {
      id: `mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:${id}`,
      kind: "mail-new",
      at,
      title: "Ana Silva",
      body: "Lunch on Friday",
      href: "/mail",
      ...(readAt !== undefined ? { readAt } : {}),
    };
  }

  it("answers one counted row where it held one per thread", async () => {
    await seed(dir, [
      old("6f6e65", "2026-09-14T11:00:00.000Z"),
      old("74776f", "2026-09-14T12:00:00.000Z"),
      row("task-1", "2026-09-14T10:00:00.000Z"),
    ]);
    expect(await listNotifications(dir)).toEqual([
      {
        id: "mail-new:2026-09-14T12:00:00.000Z",
        kind: "mail-new",
        at: "2026-09-14T12:00:00.000Z",
        title: "2 new messages",
        href: "/mail",
      },
      row("task-1", "2026-09-14T10:00:00.000Z"),
    ]);
    expect(await unreadNotificationCount(dir)).toBe(2);
  });

  it("drops rows that were all read, and counts the fold as one unread row", async () => {
    await seed(dir, [
      old("6f6e65", "2026-09-14T11:00:00.000Z", "2026-09-14T11:30:00.000Z"),
      old("74776f", "2026-09-14T12:00:00.000Z", "2026-09-14T12:30:00.000Z"),
    ]);
    expect(await listNotifications(dir)).toEqual([]);
    expect(await unreadNotificationCount(dir)).toBe(0);
  });

  it("persists the fold on the next write of the file", async () => {
    await seed(dir, [old("6f6e65", "2026-09-14T11:00:00.000Z")]);
    await markAllNotificationsRead("2026-09-14T13:00:00.000Z", dir);
    const raw = JSON.parse(await readFile(path.join(dir, NOTIFICATIONS_FILE), "utf8")) as {
      items: BrainNotification[];
    };
    expect(raw.items).toEqual([
      {
        id: "mail-new:2026-09-14T11:00:00.000Z",
        kind: "mail-new",
        at: "2026-09-14T11:00:00.000Z",
        title: "1 new message",
        href: "/mail",
        readAt: "2026-09-14T13:00:00.000Z",
      },
    ]);
  });
});
