import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUSH_KINDS,
  MAX_PUSH_BODY,
  MAX_PUSH_SUBSCRIPTIONS,
  MAX_PUSH_TITLE,
  PUSH_KINDS,
  PUSH_TTL_SECONDS,
  deviceView,
  parsePushSubscription,
  pushSubscriptionId,
  subscriptionIsGone,
} from "./model";

const ENDPOINT = "https://web.push.apple.com/brain-smoke-endpoint-not-for-production";
/** An uncompressed P-256 point of the shape a browser produces, filled with
 *  one repeated byte so it is obviously not a key anyone holds: 65 bytes,
 *  first byte 0x04, written base64url. */
const P256DH = `BH${"p".repeat(85)}`;
const AUTH = "a".repeat(22);

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
      subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } },
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
        subscription: { endpoint: "http://example.com/x", keys: { p256dh: P256DH, auth: AUTH } },
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
        subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } },
        deviceLabel: 7,
        at: "2026-09-14T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  // A key web-push cannot encrypt to throws a plain Error with no statusCode,
  // so the row is never removed and every send from then on warns about it
  // forever. The door is the only place this can be caught.
  it("refuses a p256dh that is not an uncompressed P-256 point", () => {
    for (const p256dh of [
      "p".repeat(87), // 65 bytes, but the first is not 0x04
      `BH${"p".repeat(40)}`, // too short
      `BH${"p".repeat(200)}`, // too long
      `BH${"p".repeat(84)}$`, // not base64url
      "",
    ]) {
      expect(
        parsePushSubscription({
          subscription: { endpoint: ENDPOINT, keys: { p256dh, auth: AUTH } },
          deviceLabel: "iPhone",
          at: "2026-09-14T12:00:00.000Z",
        }),
      ).toBeNull();
    }
  });

  it("refuses an auth secret that is not sixteen bytes", () => {
    for (const auth of ["a".repeat(10), "a".repeat(43), "a a a a", ""]) {
      expect(
        parsePushSubscription({
          subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth } },
          deviceLabel: "iPhone",
          at: "2026-09-14T12:00:00.000Z",
        }),
      ).toBeNull();
    }
  });

  it("caps the devices a single owner can register", () => {
    expect(MAX_PUSH_SUBSCRIPTIONS).toBe(20);
  });

  // The service worker shows at most this much of either field
  // (lib/push/worker-handlers.ts), and a payload over roughly 3 KB of
  // plaintext is refused by the push service with a 413.
  it("caps a title and a body at what the worker will show", () => {
    expect(MAX_PUSH_TITLE).toBe(200);
    expect(MAX_PUSH_BODY).toBe(400);
  });
});
