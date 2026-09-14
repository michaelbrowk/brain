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

/** THE ONE CURE FOR A ROTATED KEY IS THIS BUTTON, so it has to work.
 *
 *  RFC 8292 bakes the server's public key into every PushSubscription. A
 *  `vapid.json` that was lost or could not be read is replaced by a fresh
 *  pair, and every subscription a browser still holds is then addressed to a
 *  key this server no longer has. Reusing `getSubscription()` as it stands
 *  registered that dead subscription again: Settings reported success, every
 *  send failed with a 403, and 403 is not a status `subscriptionIsGone`
 *  removes a row for, so nothing was cleaned up either.
 */
describe("a subscription the browser already holds", () => {
  const KEY = Buffer.from(
    Uint8Array.from([4, ...Array.from({ length: 64 }, (_, index) => index)]),
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function browser(heldKey: Uint8Array | null) {
    const unsubscribed: true[] = [];
    const subscribed: { applicationServerKey: Uint8Array }[] = [];
    const posted: Record<string, unknown>[] = [];
    const held =
      heldKey === null
        ? null
        : {
            options: { applicationServerKey: heldKey.buffer as ArrayBuffer },
            unsubscribe: async () => {
              unsubscribed.push(true);
              return true;
            },
            toJSON: () => ({ endpoint: "https://push.example/held" }),
          };
    const pushManager = {
      getSubscription: async () => held,
      subscribe: async (options: { applicationServerKey: Uint8Array }) => {
        subscribed.push(options);
        return { toJSON: () => ({ endpoint: "https://push.example/fresh" }) };
      },
    };
    vi.stubGlobal("Notification", { requestPermission: async () => "granted" });
    vi.stubGlobal("navigator", {
      userAgent: MAC,
      maxTouchPoints: MAC_TOUCH_POINTS,
      serviceWorker: {
        register: async () => ({ pushManager }),
        ready: Promise.resolve({ pushManager }),
      },
    });
    vi.stubGlobal("window", { PushManager: class {}, Notification: class {} });
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url) === "/api/push/key") {
        return { ok: true, json: async () => ({ publicKey: KEY }) };
      }
      if (String(url) === "/api/push/subscriptions" && init?.body) {
        posted.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return { ok: true, json: async () => ({ device: { id: "0123456789abcdef" } }) };
    });
    return { unsubscribed, subscribed, posted };
  }

  it("keeps one made against the key this server still serves", async () => {
    const { unsubscribed, subscribed } = browser(urlBase64ToUint8Array(KEY));
    expect((await enablePushOnThisDevice()).ok).toBe(true);
    expect(unsubscribed).toHaveLength(0);
    expect(subscribed).toHaveLength(0);
  });

  it("drops one made against a key that has since rotated, and subscribes again", async () => {
    const stale = urlBase64ToUint8Array(KEY);
    stale[1] = stale[1] ^ 0xff;
    const { unsubscribed, subscribed } = browser(stale);
    expect((await enablePushOnThisDevice()).ok).toBe(true);
    expect(unsubscribed).toHaveLength(1);
    expect(subscribed).toHaveLength(1);
    expect(Array.from(subscribed[0].applicationServerKey)).toEqual(
      Array.from(urlBase64ToUint8Array(KEY)),
    );
  });

  // A ROTATED KEY MUST REPLACE THE ROW, NOT DOUBLE IT. The subscribe above
  // drops the stale subscription and makes a fresh one, at a new endpoint. If
  // that fresh registration goes up as an ordinary one, the server keeps the
  // old row beside the new one and Settings shows the same phone twice until
  // the retired endpoint next answers 410, which for a device with nothing due
  // that week is not soon. `pushsubscriptionchange` (public/sw.js) already
  // sends the endpoint it is retiring for the same reason; the button has to
  // send its own.
  it("sends the retired endpoint as previousEndpoint, so the row is replaced and not doubled", async () => {
    const stale = urlBase64ToUint8Array(KEY);
    stale[1] = stale[1] ^ 0xff;
    const { posted } = browser(stale);
    expect((await enablePushOnThisDevice()).ok).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.previousEndpoint).toBe("https://push.example/held");
  });

  it("sends no previousEndpoint when there was nothing held to replace", async () => {
    const { posted } = browser(null);
    expect((await enablePushOnThisDevice()).ok).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.previousEndpoint ?? null).toBeNull();
  });

  it("subscribes where the browser holds none", async () => {
    const { unsubscribed, subscribed } = browser(null);
    expect((await enablePushOnThisDevice()).ok).toBe(true);
    expect(unsubscribed).toHaveLength(0);
    expect(subscribed).toHaveLength(1);
  });
});
