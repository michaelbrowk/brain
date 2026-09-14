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

/** A name the owner will recognise in a list of devices. It is a label and
 *  not an identity: the id is a hash of the endpoint (lib/push/model.ts). */
export function deviceLabel(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh/.test(userAgent)) return "Mac";
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
 *  so Settings has to ask for the install before it asks for permission. */
export function homeScreenRequired(userAgent: string, standalone: unknown): boolean {
  const ios = /iPhone|iPad|iPod/.test(userAgent);
  return ios && standalone !== true;
}

export async function enablePushOnThisDevice(): Promise<
  | { ok: true; device: PushDeviceView }
  | { ok: false; reason: "unsupported" | "denied" | "home-screen" | "failed" }
> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (
    homeScreenRequired(
      navigator.userAgent,
      (navigator as Navigator & { standalone?: boolean }).standalone,
    )
  ) {
    return { ok: false, reason: "home-screen" };
  }
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

    const existing = await registration.pushManager.getSubscription();
    // userVisibleOnly is not optional anywhere: a silent push costs the
    // permission on iOS and a warning everywhere else.
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));

    const saved = await fetch("/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        deviceLabel: deviceLabel(navigator.userAgent),
      }),
    });
    if (!saved.ok) return { ok: false, reason: "failed" };
    const { device } = (await saved.json()) as { device: PushDeviceView };
    return { ok: true, device };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
