import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CAP,
  decodeMailNotificationId,
  mailNotificationId,
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

  it("round-trips a mail id through an id the schema accepts", () => {
    const accountId = "account-adeadbeefdeadbeefdeadbeefdeadbeef";
    const threadId = "thread/one+two=three";
    const id = mailNotificationId(accountId, threadId);
    expect(notificationSchema.safeParse({ ...base, kind: "mail-new", id }).success).toBe(true);
    expect(decodeMailNotificationId(id)).toEqual({ accountId, threadId });
  });

  it("returns null for an id that is not a mail id", () => {
    expect(decodeMailNotificationId("task-reminder:task-alpha:2026-09-14T13:00")).toBeNull();
    expect(decodeMailNotificationId("mail-new:account-a:zz")).toBeNull();
  });

  it("refuses a thread id too long to fit the bounded id", () => {
    const accountId = "account-adeadbeefdeadbeefdeadbeefdeadbeef";
    expect(() => mailNotificationId(accountId, "t".repeat(200))).toThrow(/too long/);
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

    ["a kind outside the three", { kind: "agent-said" }, false],
    ["a key nothing declares", { taskId: "task-alpha" }, false],
  ];

  it.each(cases)("%s", (_name, patch, accepted) => {
    expect(notificationSchema.safeParse({ ...base, ...patch }).success).toBe(accepted);
  });
});

describe("the mail id's two ends agree", () => {
  // The shape every mail module already gates on, SAFE_ACCOUNT_ID.
  const accountId = `account-a${"deadbeef".repeat(4)}`;

  it("round-trips the account id shape the mail store mints", () => {
    const threadId = "th:read/one+two=three 🔔";
    const id = mailNotificationId(accountId, threadId);
    expect(notificationSchema.safeParse({ ...base, kind: "mail-new", id }).success).toBe(true);
    expect(decodeMailNotificationId(id)).toEqual({ accountId, threadId });
  });

  it("refuses to encode an account id the decoder could not read back", () => {
    expect(() => mailNotificationId("account.one", "a")).toThrow(/account id/);
    expect(() => mailNotificationId("account:one", "a")).toThrow(/account id/);
  });
});
