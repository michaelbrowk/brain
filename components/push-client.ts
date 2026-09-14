"use client";

import type { PushDeviceView } from "@/lib/push/model";

/** THE ONE GESTURE THAT TURNS PUSH ON, AND WHAT IT NEEDS TO KNOW.
 *
 *  iOS grants web push only to a Home-Screen app, and only from a direct user
 *  gesture inside it. Both facts are in the call below rather than in a
 *  comment in Settings: the refusal a person meets has to name the cure.
 */

/** The VAPID key the server serves, as the bytes `pushManager.subscribe`
 *  wants. The ArrayBuffer parameter is not decoration: `applicationServerKey`
 *  takes a BufferSource, and a bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`
 *  since TypeScript 5.7, which a SharedArrayBuffer could satisfy and a
 *  BufferSource could not. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const raw = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** WHETHER A SUBSCRIPTION THE BROWSER STILL HOLDS WAS MADE AGAINST THIS KEY.
 *
 *  RFC 8292 bakes the server's public key into every PushSubscription, so a
 *  VAPID pair that was lost or could not be read leaves the browser holding a
 *  subscription this server can never deliver to. The enable button below is
 *  the only way the product offers to make a new one, and it used to hand the
 *  dead subscription straight back: Settings reported success, every send
 *  failed with a 403, and 403 is not a status the send path removes a row for,
 *  so the row stayed too. Comparing the bytes is the whole fix. */
export function sameApplicationServerKey(
  held: ArrayBuffer | null | undefined,
  wanted: Uint8Array,
): boolean {
  if (!held) return false;
  const bytes = new Uint8Array(held);
  if (bytes.length !== wanted.length) return false;
  return bytes.every((byte, index) => byte === wanted[index]);
}

/** How many touch points the live device reports, for the callers that do not
 *  pass their own. Since iPadOS 13, Safari on an iPad sends the Mac user agent
 *  character for character, and this is the one field that still separates
 *  them: a Mac reports 0, an iPad reports 5. Reading it here rather than
 *  demanding it at every call site means a caller who forgets still gets an
 *  iPad right; a test passes the number and never touches a global. */
function livingTouchPoints(): number {
  return typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints;
}

function isIOS(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/** A name the owner will recognise in a list of devices. It is a label and
 *  not an identity: the id is a hash of the endpoint (lib/push/model.ts). */
export function deviceLabel(
  userAgent: string,
  maxTouchPoints: number = livingTouchPoints(),
): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh/.test(userAgent)) {
    return maxTouchPoints > 1 ? "iPad" : "Mac";
  }
  if (/Windows/.test(userAgent)) return "Windows";
  return "This device";
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** True on an iOS browser that is not running from the Home Screen. Safari on
 *  iOS refuses `pushManager.subscribe` there, whatever the permission says,
 *  so Settings has to ask for the install before it asks for permission.
 *
 *  An iPad counts, and an iPad hides: desktop-class browsing sends the Mac
 *  user agent, so a rule reading only the string never showed an iPad the
 *  install instruction and labelled it a Mac. `standalone` is `undefined` on
 *  macOS and `false` in an iOS or iPadOS browser, and is checked for `true`
 *  rather than for `false` so a future platform that drops it is told to
 *  install rather than quietly told nothing. */
export function homeScreenRequired(
  userAgent: string,
  standalone: unknown,
  maxTouchPoints: number = livingTouchPoints(),
): boolean {
  return isIOS(userAgent, maxTouchPoints) && standalone !== true;
}

export async function enablePushOnThisDevice(): Promise<
  | { ok: true; device: PushDeviceView }
  | { ok: false; reason: "unsupported" | "denied" | "home-screen" | "failed" }
> {
  if (typeof navigator === "undefined") return { ok: false, reason: "unsupported" };
  // THE HOME SCREEN IS ASKED ABOUT FIRST, and the order is the whole point.
  // `window.Notification` does not exist in an iOS Safari tab: it appears only
  // inside a Home-Screen app. Checking support first answered "unsupported" on
  // the one device this feature was built for, when the true answer is that
  // the app has to be installed. The refusal a person meets has to name the
  // cure.
  if (
    homeScreenRequired(
      navigator.userAgent,
      (navigator as Navigator & { standalone?: boolean }).standalone,
      navigator.maxTouchPoints,
    )
  ) {
    return { ok: false, reason: "home-screen" };
  }
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  try {
    // The permission call has to be reached from the press itself. Everything
    // before it is synchronous checks for exactly that reason.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "denied" };

    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    const keyResponse = await fetch("/api/push/key");
    if (!keyResponse.ok) return { ok: false, reason: "failed" };
    const { publicKey } = (await keyResponse.json()) as { publicKey: string };

    const wanted = urlBase64ToUint8Array(publicKey);
    const held = await registration.pushManager.getSubscription();
    // A subscription addressed to a key this server has rotated away from can
    // never be delivered to, so it goes rather than being handed back. Its
    // endpoint is read before it goes: the row it named must be replaced, not
    // duplicated (lib/push/store.ts's `previousId`), the same problem and the
    // same cure `pushsubscriptionchange` already has in public/sw.js. Without
    // it Settings grew a second row for one phone, the retired endpoint's
    // silent forever, until it next answered 410, which for a device with
    // nothing due that week is not soon.
    let subscription = held;
    let previousEndpoint: string | null = null;
    if (held && !sameApplicationServerKey(held.options.applicationServerKey, wanted)) {
      previousEndpoint = held.toJSON().endpoint ?? null;
      await held.unsubscribe();
      subscription = null;
    }
    // userVisibleOnly is not optional anywhere: a silent push costs the
    // permission on iOS and a warning everywhere else.
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: wanted,
    });

    const saved = await fetch("/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        deviceLabel: deviceLabel(navigator.userAgent, navigator.maxTouchPoints),
        previousEndpoint,
      }),
    });
    if (!saved.ok) return { ok: false, reason: "failed" };
    const { device } = (await saved.json()) as { device: PushDeviceView };
    return { ok: true, device };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
