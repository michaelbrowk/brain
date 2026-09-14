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
