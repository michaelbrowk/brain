import { describe, expect, it } from "vitest";
import { mailPushTag } from "./ids";
import { mailRowId } from "./mail-rows";
import {
  NOTIFICATION_CAP,
  decodeTaskNotificationId,
  notificationSchema,
  taskMissedNotificationId,
  taskReminderNotificationId,
} from "./model";

const base = {
  id: "task-reminder:task-alpha:2026-09-14T13:00",
  kind: "task-reminder" as const,
  at: "2026-09-14T12:00:00.000Z",
  title: "Water the plants",
  href: "/tasks",
};

describe("the notification model", () => {
  it("accepts a reminder with no body and no readAt", () => {
    expect(notificationSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a mail row with a body and a readAt", () => {
    const value = {
      ...base,
      kind: "mail-new",
      body: "Lunch on Friday",
      readAt: "2026-09-14T12:05:00.000Z",
    };
    expect(notificationSchema.safeParse(value).success).toBe(true);
  });

  it("accepts an agent row, which is what an agent did through MCP", () => {
    const value = {
      ...base,
      id: "agent:2026-09-14T12:00:00.000Z:create_task:9f2c1b4a5e6d7c80",
      kind: "agent-action",
      title: "Claude created a task",
      body: "Water the plants",
      href: "/tasks?task=task-alpha",
    };
    expect(notificationSchema.safeParse(value).success).toBe(true);
  });

  it("refuses a kind nothing produces", () => {
    expect(notificationSchema.safeParse({ ...base, kind: "agent-said" }).success).toBe(false);
  });

  it("refuses an absolute href, so the worker cannot be sent off-origin", () => {
    expect(notificationSchema.safeParse({ ...base, href: "https://evil.example/x" }).success).toBe(
      false,
    );
    expect(notificationSchema.safeParse({ ...base, href: "//evil.example/x" }).success).toBe(false);
    expect(notificationSchema.safeParse({ ...base, href: "tasks" }).success).toBe(false);
  });

  it("refuses an unknown key rather than passing it through", () => {
    expect(notificationSchema.safeParse({ ...base, taskId: "task-alpha" }).success).toBe(false);
  });

  it("caps the centre at five hundred", () => {
    expect(NOTIFICATION_CAP).toBe(500);
  });

  it("derives a reminder id from the task, the day and the clock", () => {
    expect(taskReminderNotificationId("task-alpha", "2026-09-14", "13:00")).toBe(
      "task-reminder:task-alpha:2026-09-14T13:00",
    );
    expect(taskMissedNotificationId("task-alpha", "2026-09-14", "13:00")).toBe(
      "task-missed:task-alpha:2026-09-14T13:00",
    );
  });

  it("accepts the mail row's own id, which is the instant it opened", () => {
    const id = mailRowId("2026-09-14T12:00:00.000Z");
    expect(notificationSchema.safeParse({ ...base, kind: "mail-new", id }).success).toBe(true);
  });

  it("reads a task's own id back out of both task ids", () => {
    // The row in the centre says "/tasks"; the task it came from is in the id
    // it was minted with, and that is what takes a press to the right row.
    expect(decodeTaskNotificationId(taskReminderNotificationId("task-alpha", "2026-09-14", "13:00"))).toBe(
      "task-alpha",
    );
    expect(decodeTaskNotificationId(taskMissedNotificationId("task-alpha", "2026-09-14", "13:00"))).toBe(
      "task-alpha",
    );
  });

  it("returns null for an id that names no task", () => {
    expect(decodeTaskNotificationId(mailRowId("2026-09-14T12:00:00.000Z"))).toBeNull();
    expect(decodeTaskNotificationId("task-reminder:")).toBeNull();
    // A task id is `[A-Za-z0-9_-]`, so a segment holding anything else is not
    // one and the row opens the surface without naming a row.
    expect(decodeTaskNotificationId("task-reminder:task alpha:2026-09-14T13:00")).toBeNull();
  });
});

/** One table per field, because the schema is the only thing between a
 *  producer and a row that gets written, announced and then dropped at the
 *  next read. Each case is the value with everything else held valid. */
describe("what the schema accepts, field by field", () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["a title at the cap", { title: "t".repeat(200) }, true],
    ["a title past the cap", { title: "t".repeat(201) }, false],
    ["an empty title", { title: "" }, false],
    ["a body at the cap", { body: "b".repeat(400) }, true],
    ["a body past the cap", { body: "b".repeat(401) }, false],
    ["an empty body", { body: "" }, false],

    ["an instant to the millisecond", { at: "2026-09-14T12:00:00.000Z" }, true],
    ["an instant at second precision", { at: "2026-09-14T12:00:00Z" }, false],
    ["an instant in a local offset", { at: "2026-09-14T12:00:00.000+00:00" }, false],
    ["a bare day", { at: "2026-09-14" }, false],
    ["a day the calendar does not have", { at: "2026-02-30T12:00:00.000Z" }, false],
    ["a leap day the calendar does have", { at: "2024-02-29T12:00:00.000Z" }, true],
    ["a clock no day has", { at: "2026-09-14T99:99:99.999Z" }, false],
    ["a readAt on the same rules", { readAt: "2026-13-45T99:99:99.999Z" }, false],
    ["a readAt to the millisecond", { readAt: "2026-09-14T12:05:00.000Z" }, true],

    ["the site root as an href", { href: "/" }, true],
    ["a path with a query", { href: "/mail?account=a&thread=b" }, true],
    ["a backslash a browser reads as //", { href: "/\\evil.example/x" }, false],
    ["an href carrying a newline", { href: "/tasks\n" }, false],
    ["an href carrying a fragment", { href: "/tasks#top" }, false],
    ["an href past the cap", { href: `/${"x".repeat(300)}` }, false],

    ["an id at the cap", { id: "a".repeat(400) }, true],
    ["an id past the cap", { id: "a".repeat(401) }, false],
    ["an empty id", { id: "" }, false],
    ["an id carrying a space", { id: "task-reminder:task alpha:2026-09-14T13:00" }, false],
    ["an id carrying a slash", { id: "task-reminder:task/alpha:2026-09-14T13:00" }, false],

    ["a kind outside the four", { kind: "agent-said" }, false],
    ["a key nothing declares", { taskId: "task-alpha" }, false],
  ];

  it.each(cases)("%s", (_name, patch, accepted) => {
    expect(notificationSchema.safeParse({ ...base, ...patch }).success).toBe(accepted);
  });
});

/** The tag on one letter's push, which is all that is left of the per-thread
 *  mail id. It never reaches the centre now, so what it has to stay inside is
 *  `MAX_PUSH_TAG` and not the row's charset. */
describe("the mail push tag", () => {
  // The shape every mail module already gates on, SAFE_ACCOUNT_ID.
  const accountId = `account-a${"deadbeef".repeat(4)}`;

  it("is one tag per pair, whatever the provider's thread id holds", () => {
    const tag = mailPushTag(accountId, "th:read/one+two=three 🔔");
    expect(tag).toBe(`mail-new:${accountId}:74683a726561642f6f6e652b74776f3d746872656520f09f9494`);
    expect(tag!.length).toBeLessThanOrEqual(400);
    expect(mailPushTag(accountId, "thread-one")).not.toBe(tag);
  });

  it("answers null rather than a tag it cannot make, and the letter still goes", () => {
    expect(mailPushTag("account.one", "a")).toBeNull();
    expect(mailPushTag("account:one", "a")).toBeNull();
    expect(mailPushTag(accountId, "t".repeat(200))).toBeNull();
  });
});
