import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceLabel,
  enablePushOnThisDevice,
  homeScreenRequired,
  urlBase64ToUint8Array,
} from "./push-client";

const IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
// Since iPadOS 13 Safari defaults to desktop-class browsing and sends the Mac
// user agent, character for character. The touch points are the difference: a
// Mac reports 0, an iPad reports 5.
const IPAD_TOUCH_POINTS = 5;
const MAC_TOUCH_POINTS = 0;

describe("urlBase64ToUint8Array", () => {
  it("decodes a VAPID public key to sixty-five bytes starting with 0x04", () => {
    // An uncompressed P-256 point: one 0x04 tag and two 32-byte coordinates.
    const bytes = urlBase64ToUint8Array(
      Buffer.from(Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => i)]))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    );
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });

  it("restores the padding the url-safe form drops", () => {
    expect(urlBase64ToUint8Array("YQ")).toEqual(new Uint8Array([97]));
    expect(urlBase64ToUint8Array("YWI")).toEqual(new Uint8Array([97, 98]));
    expect(urlBase64ToUint8Array("YWJj")).toEqual(new Uint8Array([97, 98, 99]));
  });
});

describe("homeScreenRequired", () => {
  it("is true on an iPhone in Safari, where push needs a Home-Screen install", () => {
    expect(homeScreenRequired(IOS, false, 5)).toBe(true);
    expect(homeScreenRequired(IOS, undefined, 5)).toBe(true);
  });

  it("is false on an iPhone already installed to the Home Screen", () => {
    expect(homeScreenRequired(IOS, true, 5)).toBe(false);
  });

  it("is true on an iPad, which sends the Mac user agent and needs the install too", () => {
    expect(homeScreenRequired(MAC, false, IPAD_TOUCH_POINTS)).toBe(true);
    expect(homeScreenRequired(MAC, true, IPAD_TOUCH_POINTS)).toBe(false);
  });

  it("is false on a Mac and on Android, where a tab may subscribe", () => {
    // macOS Safari never sets `standalone` at all, so the real shape of a Mac
    // is `undefined` with no touch points. A pin that passed `false` here
    // described a device that does not exist.
    expect(homeScreenRequired(MAC, undefined, MAC_TOUCH_POINTS)).toBe(false);
    expect(homeScreenRequired(ANDROID, false, 5)).toBe(false);
  });
});

describe("deviceLabel", () => {
  it("names the device a person would recognise", () => {
    expect(deviceLabel(IOS, 5)).toBe("iPhone");
    expect(deviceLabel(MAC, MAC_TOUCH_POINTS)).toBe("Mac");
    expect(deviceLabel(ANDROID, 5)).toBe("Android");
    expect(deviceLabel("something else entirely", 0)).toBe("This device");
  });

  it("says iPad for an iPad, which calls itself a Macintosh", () => {
    expect(deviceLabel(MAC, IPAD_TOUCH_POINTS)).toBe("iPad");
  });
});

describe("enablePushOnThisDevice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tells an iPhone tab to install rather than calling the device unsupported", async () => {
    // `window.Notification` does not exist in an iOS Safari tab; it appears
    // only inside a Home-Screen app. Asking about support first told the one
    // device this whole feature exists for that Brain cannot do this at all,
    // and never named the cure.
    vi.stubGlobal("navigator", { userAgent: IOS, standalone: false, maxTouchPoints: 5 });
    vi.stubGlobal("window", {});
    expect(await enablePushOnThisDevice()).toEqual({ ok: false, reason: "home-screen" });
  });

  it("is unsupported where there is no navigator at all", async () => {
    vi.stubGlobal("navigator", undefined);
    expect(await enablePushOnThisDevice()).toEqual({ ok: false, reason: "unsupported" });
  });
});
