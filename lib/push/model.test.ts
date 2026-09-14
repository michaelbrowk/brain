import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUSH_KINDS,
  MAX_PUSH_SUBSCRIPTIONS,
  PUSH_KINDS,
  PUSH_TTL_SECONDS,
  deviceView,
  parsePushSubscription,
  pushSubscriptionId,
  subscriptionIsGone,
} from "./model";

const ENDPOINT = "https://web.push.apple.com/brain-smoke-endpoint-not-for-production";

describe("the push model", () => {
  it("pushes exactly two kinds, both on by default", () => {
    expect([...PUSH_KINDS]).toEqual(["task-reminder", "mail-new"]);
    expect(DEFAULT_PUSH_KINDS).toEqual({ "task-reminder": true, "mail-new": true });
  });

  it("never pushes a missed reminder, because task-missed is not a push kind", () => {
    expect((PUSH_KINDS as readonly string[]).includes("task-missed")).toBe(false);
  });

  it("holds a push for an hour and no longer", () => {
    expect(PUSH_TTL_SECONDS).toBe(3600);
  });

  it("treats 404 and 410 as gone and everything else as not", () => {
    expect(subscriptionIsGone(404)).toBe(true);
    expect(subscriptionIsGone(410)).toBe(true);
    for (const status of [201, 400, 401, 413, 429, 500]) {
      expect(subscriptionIsGone(status)).toBe(false);
    }
  });

  it("derives a stable short id from the endpoint", () => {
    const id = pushSubscriptionId(ENDPOINT);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(pushSubscriptionId(ENDPOINT)).toBe(id);
    expect(pushSubscriptionId(`${ENDPOINT}-other`)).not.toBe(id);
  });

  it("keeps the endpoint out of a device view", () => {
    const view = deviceView({
      id: "0123456789abcdef",
      endpoint: ENDPOINT,
      keys: { p256dh: "p", auth: "a" },
      deviceLabel: "iPhone",
      createdAt: "2026-09-14T12:00:00.000Z",
      lastSeenAt: "2026-09-14T12:00:00.000Z",
    });
    expect(view).toEqual({
      id: "0123456789abcdef",
      deviceLabel: "iPhone",
      createdAt: "2026-09-14T12:00:00.000Z",
      lastSeenAt: "2026-09-14T12:00:00.000Z",
    });
    expect(JSON.stringify(view)).not.toContain("web.push.apple.com");
  });

  it("parses a browser PushSubscription into a record", () => {
    const record = parsePushSubscription({
      subscription: { endpoint: ENDPOINT, keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } },
      deviceLabel: "iPhone",
      at: "2026-09-14T12:00:00.000Z",
    });
    expect(record?.endpoint).toBe(ENDPOINT);
    expect(record?.id).toBe(pushSubscriptionId(ENDPOINT));
    expect(record?.deviceLabel).toBe("iPhone");
  });

  it("refuses an endpoint that is not https", () => {
    expect(
      parsePushSubscription({
        subscription: { endpoint: "http://example.com/x", keys: { p256dh: "p", auth: "a" } },
        deviceLabel: "iPhone",
        at: "2026-09-14T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("refuses a subscription with no keys, and a label that is not a string", () => {
    expect(
      parsePushSubscription({
        subscription: { endpoint: ENDPOINT },
        deviceLabel: "iPhone",
        at: "2026-09-14T12:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      parsePushSubscription({
        subscription: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } },
        deviceLabel: 7,
        at: "2026-09-14T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("caps the devices a single owner can register", () => {
    expect(MAX_PUSH_SUBSCRIPTIONS).toBe(20);
  });
});
