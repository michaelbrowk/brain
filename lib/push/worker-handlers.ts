/** THE WORKER'S LOGIC, AS TYPED FUNCTIONS.
 *
 *  public/sw.js carries the same two functions inline, because a classic
 *  service worker cannot import an app module and a module worker would rule
 *  out iOS 16.4 to 18.3. One test table runs against both copies
 *  (lib/push/worker-handlers.test.ts), so a change to one and not the other is
 *  a failing test.
 *
 *  Nothing here touches the network, the DOM or `self`.
 */

export const PUSH_FALLBACK_TITLE = "Brain";
export const PUSH_FALLBACK_BODY = "Open Brain to see what changed.";

const MAX_TITLE = 200;
const MAX_BODY = 400;

export interface NotificationPlan {
  title: string;
  options: {
    body: string;
    icon: string;
    badge: string;
    tag: string;
    data: { href: string };
  };
}

/**
 * A payload always becomes a notification, whatever it is.
 *
 * iOS revokes an origin's push permission when a push arrives and nothing is
 * shown, so a handler that throws on a malformed payload does not fail one
 * notification, it loses the feature. Every unreadable input falls back to
 * the product's own name and a sentence that is true of all of them.
 */
export function planNotification(raw: string | null): NotificationPlan {
  let title = PUSH_FALLBACK_TITLE;
  let body = PUSH_FALLBACK_BODY;
  let href = "/";
  try {
    const parsed: unknown = raw === null || raw === "" ? null : JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      if (typeof value.title === "string" && value.title.length > 0) {
        title = value.title.slice(0, MAX_TITLE);
        body = typeof value.body === "string" ? value.body.slice(0, MAX_BODY) : "";
        href = typeof value.href === "string" && value.href.startsWith("/") ? value.href : "/";
      }
    }
  } catch {
    // The fallback above already stands.
  }
  return {
    title,
    options: {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Tagged by destination: two reminders are two notifications, and the
      // same destination arriving twice replaces itself rather than stacking.
      tag: `brain:${href}`,
      data: { href },
    },
  };
}

/**
 * Where a click goes.
 *
 * The payload is encrypted in transit and this still checks it: a worker that
 * opened whatever a payload named would be an open redirect with a
 * notification in front of it. Only a path on this origin is honoured, and
 * anything else lands on the root.
 */
export function resolveClickTarget(href: unknown, origin: string): string {
  const home = `${origin}/`;
  if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")) return home;
  try {
    const url = new URL(href, origin);
    return url.origin === origin ? url.toString() : home;
  } catch {
    return home;
  }
}
