import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDeviceCookie,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  deviceBucketKey,
} from "./device-cookie";

const SECRET = "device-cookie-secret-with-enough-entropy";

describe("the device cookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a name, a year and nothing about who holds it", () => {
    expect(DEVICE_COOKIE).toBe("brain_device");
    expect(DEVICE_COOKIE_MAX_AGE_SECONDS).toBe(365 * 24 * 60 * 60);
  });

  it("gives a browser that carries one a bucket key of its own", () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    const mine = createDeviceCookie();
    const yours = createDeviceCookie();

    expect(mine).not.toBe(yours);
    const key = deviceBucketKey(mine);
    expect(key).toMatch(/^device:[\w-]+$/);
    // Stable across requests, so the same browser keeps the same bucket, and
    // distinct per device, so one device's wrong password spends only its own.
    expect(deviceBucketKey(mine)).toBe(key);
    expect(deviceBucketKey(yours)).not.toBe(key);
    // The key is derived, not the cookie: the limiter's map never holds the
    // value the browser sends.
    expect(key).not.toContain(mine.split(".")[0]);
  });

  it("refuses a cookie this installation did not sign, so the flood key is used instead", () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    const mine = createDeviceCookie();
    const [id, mac] = mine.split(".");

    for (const forged of [
      undefined,
      "",
      id,
      `${id}.`,
      `.${mac}`,
      `${id}.${mac.slice(0, -2)}`,
      `${id}x.${mac}`,
      `${id}.${Buffer.alloc(32).toString("base64url")}`,
      "not-a-cookie-at-all",
    ]) {
      expect(deviceBucketKey(forged), String(forged)).toBeNull();
    }

    // A cookie from an installation whose secret has been rotated is somebody
    // else's cookie now.
    vi.stubEnv("AUTH_SECRET", `${SECRET}-rotated`);
    expect(deviceBucketKey(mine)).toBeNull();
  });
});
