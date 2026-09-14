import { describe, expect, it } from "vitest";
import { deviceLabel, homeScreenRequired, urlBase64ToUint8Array } from "./push-client";

const IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

describe("urlBase64ToUint8Array", () => {
  it("decodes a VAPID public key to sixty-five bytes starting with 0x04", () => {
    // An uncompressed P-256 point: one 0x04 tag and two 32-byte coordinates.
    const key = "BP".padEnd(87, "A") + "=";
    const bytes = urlBase64ToUint8Array(
      Buffer.from(Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => i)]))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    );
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
    expect(key.length).toBe(88);
  });

  it("restores the padding the url-safe form drops", () => {
    expect(urlBase64ToUint8Array("YQ")).toEqual(new Uint8Array([97]));
    expect(urlBase64ToUint8Array("YWI")).toEqual(new Uint8Array([97, 98]));
    expect(urlBase64ToUint8Array("YWJj")).toEqual(new Uint8Array([97, 98, 99]));
  });
});

describe("homeScreenRequired", () => {
  it("is true on an iPhone in Safari, where push needs a Home-Screen install", () => {
    expect(homeScreenRequired(IOS, false)).toBe(true);
    expect(homeScreenRequired(IOS, undefined)).toBe(true);
  });

  it("is false on an iPhone already installed to the Home Screen", () => {
    expect(homeScreenRequired(IOS, true)).toBe(false);
  });

  it("is false on a Mac and on Android, where a tab may subscribe", () => {
    expect(homeScreenRequired(MAC, false)).toBe(false);
    expect(homeScreenRequired(ANDROID, false)).toBe(false);
  });
});

describe("deviceLabel", () => {
  it("names the device a person would recognise", () => {
    expect(deviceLabel(IOS)).toBe("iPhone");
    expect(deviceLabel(MAC)).toBe("Mac");
    expect(deviceLabel(ANDROID)).toBe("Android");
    expect(deviceLabel("something else entirely")).toBe("This device");
  });
});
