// Brain's service worker. It exists for push and for nothing else: no caching,
// no offline, no fetch handler. Brain is a server-rendered app behind a
// session, and a worker that served a stale shell would be a second source of
// truth for pages that live in a folder of Markdown files. It receives a push,
// shows a notification, opens the app where the notification points, and
// re-registers a subscription the browser replaced.
//
// The push handler ALWAYS shows something. iOS revokes an origin's push
// permission when a push arrives and no notification appears, so there is no
// branch here that ends without showNotification.
//
// planNotification and resolveClickTarget are the same two functions as
// lib/push/worker-handlers.ts. A classic worker cannot import an app module,
// and a module worker would rule out iOS 16.4 to 18.3, so the copy is
// deliberate and lib/push/worker-handlers.test.ts runs one table against both.

var PUSH_FALLBACK_TITLE = "Brain";
var PUSH_FALLBACK_BODY = "Open Brain to see what changed.";
var MAX_TITLE = 200;
var MAX_BODY = 400;

function planNotification(raw) {
  var title = PUSH_FALLBACK_TITLE;
  var body = PUSH_FALLBACK_BODY;
  var href = "/";
  try {
    var parsed = raw === null || raw === "" ? null : JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      if (typeof parsed.title === "string" && parsed.title.length > 0) {
        title = parsed.title.slice(0, MAX_TITLE);
        body = typeof parsed.body === "string" ? parsed.body.slice(0, MAX_BODY) : "";
        href =
          typeof parsed.href === "string" && parsed.href.charAt(0) === "/" ? parsed.href : "/";
      }
    }
  } catch {
    // The fallback above already stands.
  }
  return {
    title: title,
    options: {
      body: body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "brain:" + href,
      data: { href: href },
    },
  };
}

function resolveClickTarget(href, origin) {
  var home = origin + "/";
  if (typeof href !== "string" || href.charAt(0) !== "/" || href.slice(0, 2) === "//") return home;
  try {
    var url = new URL(href, origin);
    return url.origin === origin ? url.toString() : home;
  } catch {
    return home;
  }
}

// The unit test reaches the two functions through this. It is also the one
// place that says, inside the shipped file, that they are tested elsewhere.
self.__brainPushHandlers = {
  planNotification: planNotification,
  resolveClickTarget: resolveClickTarget,
};

self.addEventListener("push", function (event) {
  var raw = null;
  try {
    raw = event.data ? event.data.text() : null;
  } catch {
    raw = null;
  }
  var plan = planNotification(raw);
  event.waitUntil(self.registration.showNotification(plan.title, plan.options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var target = resolveClickTarget(data.href, self.location.origin);
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (windows) {
        for (var index = 0; index < windows.length; index += 1) {
          var open = windows[index];
          if (open.url.indexOf(self.location.origin) === 0 && "focus" in open) {
            return open.navigate
              ? open.navigate(target).then(function (moved) {
                  return (moved || open).focus();
                })
              : open.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});

// A push service may replace a subscription without asking. Without this the
// device goes quiet and nothing on either side says why.
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    fetch("/api/push/key")
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (payload) {
        if (!payload || typeof payload.publicKey !== "string") return null;
        var raw = payload.publicKey.replace(/-/g, "+").replace(/_/g, "/");
        var padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
        var binary = atob(padded);
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        });
      })
      .then(function (subscription) {
        if (!subscription) return null;
        return fetch("/api/push/subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subscription: subscription.toJSON(),
            deviceLabel: "This device",
          }),
        });
      })
      .catch(function () {
        // Offline, or the session expired. The next enable in Settings fixes it.
        return null;
      }),
  );
});
