import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PUSH_FALLBACK_BODY,
  PUSH_FALLBACK_TITLE,
  planNotification,
  resolveClickTarget,
  type NotificationPlan,
} from "./worker-handlers";

/** THE SHIPPED WORKER, RUN AS A FUNCTION.
 *
 *  public/sw.js is a classic service worker: it cannot import an app module,
 *  and a module worker would rule out iOS 16.4 to 18.3, which is the install
 *  base this feature exists for. So it carries the same two functions inline
 *  and hangs them off `self`. Evaluating the file against a fake scope is what
 *  keeps the two copies from drifting: a change to one and not the other is a
 *  failing test rather than a bug report from a phone.
 */
function shippedHandlers(): {
  planNotification: (raw: string | null) => NotificationPlan;
  resolveClickTarget: (href: unknown, origin: string) => string;
} {
  const source = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");
  const listeners: string[] = [];
  const scope = {
    addEventListener: (type: string) => listeners.push(type),
    registration: {},
    clients: {},
    __brainPushHandlers: undefined as unknown,
  };
  new Function("self", source)(scope);
  expect(listeners.sort()).toEqual(["notificationclick", "push", "pushsubscriptionchange"]);
  return scope.__brainPushHandlers as ReturnType<typeof shippedHandlers>;
}

const runners: [string, ReturnType<typeof shippedHandlers>][] = [
  ["the typed handlers", { planNotification, resolveClickTarget }],
  ["the shipped worker", shippedHandlers()],
];

describe.each(runners)("%s", (_name, handlers) => {
  it("plans a notification from a full payload", () => {
    const plan = handlers.planNotification(
      JSON.stringify({ title: "Water the plants", body: "13:00", href: "/tasks" }),
    );
    expect(plan.title).toBe("Water the plants");
    expect(plan.options.body).toBe("13:00");
    expect(plan.options.data.href).toBe("/tasks");
    expect(plan.options.icon).toBe("/icon-192.png");
    expect(plan.options.badge).toBe("/icon-192.png");
  });

  it("ALWAYS plans something, because a push that shows nothing costs the permission", () => {
    // iOS revokes web push for an origin that receives a push and shows no
    // notification (WebKit, "Meet Web Push"). Every one of these has to end in
    // a visible notification rather than a thrown handler.
    for (const raw of [null, "", "not json", "[]", "7", JSON.stringify({}), JSON.stringify({ title: "" })]) {
      const plan = handlers.planNotification(raw);
      expect(plan.title).toBe(PUSH_FALLBACK_TITLE);
      expect(plan.options.body).toBe(PUSH_FALLBACK_BODY);
      expect(plan.options.data.href).toBe("/");
    }
  });

  it("plans a title with no body when the payload carries none", () => {
    const plan = handlers.planNotification(JSON.stringify({ title: "Ana Silva", href: "/mail" }));
    expect(plan.title).toBe("Ana Silva");
    expect(plan.options.body).toBe("");
  });

  it("tags by href, so two reminders stack and a repeat replaces itself", () => {
    expect(handlers.planNotification(JSON.stringify({ title: "a", href: "/tasks" })).options.tag).toBe(
      "brain:/tasks",
    );
  });

  it("truncates a title and a body a push service would refuse", () => {
    const plan = handlers.planNotification(
      JSON.stringify({ title: "t".repeat(500), body: "b".repeat(1000), href: "/tasks" }),
    );
    expect(plan.title).toHaveLength(200);
    expect(plan.options.body).toHaveLength(400);
  });

  it("opens a same-origin path", () => {
    expect(handlers.resolveClickTarget("/tasks", "https://brain.example")).toBe(
      "https://brain.example/tasks",
    );
    expect(handlers.resolveClickTarget("/mail", "https://brain.example")).toBe(
      "https://brain.example/mail",
    );
  });

  it("refuses to open anywhere but this origin", () => {
    for (const href of [
      "https://evil.example/x",
      "//evil.example/x",
      "javascript:alert(1)",
      "tasks",
      "",
      null,
      7,
      { href: "/tasks" },
    ]) {
      expect(handlers.resolveClickTarget(href, "https://brain.example")).toBe(
        "https://brain.example/",
      );
    }
  });

  it("refuses a path that tries to climb out of the origin", () => {
    expect(handlers.resolveClickTarget("/../../etc/passwd", "https://brain.example")).toBe(
      "https://brain.example/etc/passwd",
    );
  });
});

describe("the shipped worker's own text", () => {
  const source = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");

  it("says at the top that it is push only", () => {
    expect(source.slice(0, 400)).toContain("push");
    expect(source.slice(0, 400)).toContain("no caching");
  });

  it("caches nothing and intercepts no navigation", () => {
    expect(source).not.toContain("caches");
    expect(source).not.toContain('addEventListener("fetch"');
  });

  it("always calls showNotification inside the push handler", () => {
    expect(source).toContain("showNotification");
  });

  it("carries no em-dash", () => {
    expect(source).not.toContain("—");
  });
});
