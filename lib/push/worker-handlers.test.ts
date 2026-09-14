import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PUSH_FALLBACK_BODY,
  PUSH_FALLBACK_TITLE,
  planNotification,
  resolveClickTarget,
  type NotificationPlan,
} from "./worker-handlers";

/** THE SHIPPED WORKER, RUN AS A FUNCTION.
 *
 *  public/sw.js is a classic service worker: it cannot import an app module,
 *  and a module worker would rule out iOS 16.4 to 18.3, which is the install
 *  base this feature exists for. So it carries the same two functions inline
 *  and hangs them off `self`. Evaluating the file against a fake scope is what
 *  keeps the two copies from drifting: a change to one and not the other is a
 *  failing test rather than a bug report from a phone.
 *
 *  The scope also collects the three listener callbacks, so the tests below
 *  can run the bodies rather than grep the file for them. A substring search
 *  for "showNotification" stays green if somebody wraps the call in an `if`,
 *  and that `if` is what costs the permission on iOS.
 */

interface ShippedHandlers {
  planNotification: (raw: string | null) => NotificationPlan;
  resolveClickTarget: (href: unknown, origin: string) => string;
}

interface FakeEvent {
  data?: { text: () => string } | null;
  notification?: { data?: unknown; close: () => void };
  /** `pushsubscriptionchange` carries the endpoint the browser is retiring. */
  oldSubscription?: { endpoint: string } | null;
  waitUntil: (value: unknown) => void;
}

type ShippedListener = (event: FakeEvent) => void;

interface WorkerScope {
  addEventListener: (type: string, listener: ShippedListener) => void;
  registration: Record<string, unknown>;
  clients: Record<string, unknown>;
  location: { origin: string };
  __brainPushHandlers?: unknown;
}

const ORIGIN = "https://brain.example";

function loadShippedWorker(overrides: Partial<WorkerScope> = {}): {
  listeners: Record<string, ShippedListener>;
  handlers: ShippedHandlers;
} {
  const source = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");
  const listeners: Record<string, ShippedListener> = {};
  const scope: WorkerScope = {
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    registration: {},
    clients: {},
    location: { origin: ORIGIN },
    __brainPushHandlers: undefined,
    ...overrides,
  };
  new Function("self", source)(scope);
  return { listeners, handlers: scope.__brainPushHandlers as ShippedHandlers };
}

function shippedHandlers(): ShippedHandlers {
  const { listeners, handlers } = loadShippedWorker();
  expect(Object.keys(listeners).sort()).toEqual([
    "notificationclick",
    "push",
    "pushsubscriptionchange",
  ]);
  return handlers;
}

const runners: [string, ShippedHandlers][] = [
  ["the typed handlers", { planNotification, resolveClickTarget }],
  ["the shipped worker", shippedHandlers()],
];

describe.each(runners)("%s", (_name, handlers) => {
  it("plans a notification from a full payload", () => {
    const plan = handlers.planNotification(
      JSON.stringify({ title: "Water the plants", body: "13:00", href: "/tasks" }),
    );
    expect(plan.title).toBe("Water the plants");
    expect(plan.options.body).toBe("13:00");
    expect(plan.options.data.href).toBe("/tasks");
    expect(plan.options.icon).toBe("/icon-192.png");
    expect(plan.options.badge).toBe("/icon-192.png");
  });

  it("ALWAYS plans something, because a push that shows nothing costs the permission", () => {
    // iOS revokes web push for an origin that receives a push and shows no
    // notification (WebKit, "Meet Web Push"). Every one of these has to end in
    // a visible notification rather than a thrown handler.
    for (const raw of [null, "", "not json", "[]", "7", JSON.stringify({}), JSON.stringify({ title: "" })]) {
      const plan = handlers.planNotification(raw);
      expect(plan.title).toBe(PUSH_FALLBACK_TITLE);
      expect(plan.options.body).toBe(PUSH_FALLBACK_BODY);
      expect(plan.options.data.href).toBe("/");
      expect(plan.options.tag).toBe("brain:/");
    }
  });

  it("plans a title with no body when the payload carries none", () => {
    const plan = handlers.planNotification(JSON.stringify({ title: "Ana Silva", href: "/mail" }));
    expect(plan.title).toBe("Ana Silva");
    expect(plan.options.body).toBe("");
  });

  it("tags by the payload's tag, so two reminders due in one scan both stand", () => {
    // THE TAG IS THE NOTIFICATION'S OWN ID, NOT ITS DESTINATION. Every task
    // reminder carries href "/tasks" and every new-mail row "/mail", so a tag
    // derived from the href made the second reminder of a scan replace the
    // first, silently and without a sound.
    const first = handlers.planNotification(
      JSON.stringify({ title: "Water the plants", href: "/tasks", tag: "task-reminder:a:2026-09-14T13:00" }),
    );
    const second = handlers.planNotification(
      JSON.stringify({ title: "Call the bank", href: "/tasks", tag: "task-reminder:b:2026-09-14T13:00" }),
    );
    expect(first.options.tag).toBe("brain:task-reminder:a:2026-09-14T13:00");
    expect(second.options.tag).toBe("brain:task-reminder:b:2026-09-14T13:00");
    expect(first.options.tag).not.toBe(second.options.tag);
  });

  it("repeats itself on one tag, so the same notification twice replaces itself", () => {
    const tag = "mail-new:account-a:6162";
    expect(
      handlers.planNotification(JSON.stringify({ title: "Ana Silva", href: "/mail", tag })).options
        .tag,
    ).toBe(
      handlers.planNotification(JSON.stringify({ title: "Ana Silva", href: "/mail", tag })).options
        .tag,
    );
  });

  it("falls back to the destination when a payload carries no tag", () => {
    for (const payload of [
      { title: "a", href: "/tasks" },
      { title: "a", href: "/tasks", tag: "" },
      { title: "a", href: "/tasks", tag: 7 },
    ]) {
      expect(handlers.planNotification(JSON.stringify(payload)).options.tag).toBe("brain:/tasks");
    }
  });

  it("truncates a title and a body a push service would refuse", () => {
    const plan = handlers.planNotification(
      JSON.stringify({ title: "t".repeat(500), body: "b".repeat(1000), href: "/tasks" }),
    );
    expect(plan.title).toHaveLength(200);
    expect(plan.options.body).toHaveLength(400);
  });

  it("opens a same-origin path", () => {
    expect(handlers.resolveClickTarget("/tasks", ORIGIN)).toBe("https://brain.example/tasks");
    expect(handlers.resolveClickTarget("/mail", ORIGIN)).toBe("https://brain.example/mail");
  });

  it("refuses to open anywhere but this origin", () => {
    for (const href of [
      "https://evil.example/x",
      "//evil.example/x",
      "javascript:alert(1)",
      "tasks",
      "",
      null,
      7,
      { href: "/tasks" },
    ]) {
      expect(handlers.resolveClickTarget(href, ORIGIN)).toBe("https://brain.example/");
    }
  });

  it("refuses a path that tries to climb out of the origin", () => {
    expect(handlers.resolveClickTarget("/../../etc/passwd", ORIGIN)).toBe(
      "https://brain.example/etc/passwd",
    );
  });
});

describe("the shipped worker's push listener", () => {
  function showsFor(data: FakeEvent["data"]): { title: string; tag: string }[] {
    const shown: { title: string; tag: string }[] = [];
    const waited: unknown[] = [];
    const { listeners } = loadShippedWorker({
      registration: {
        showNotification: (title: string, options: { tag: string }) => {
          shown.push({ title, tag: options.tag });
          return Promise.resolve();
        },
      },
    });
    listeners.push?.({ data, waitUntil: (value) => waited.push(value) });
    expect(waited).toHaveLength(1);
    return shown;
  }

  it("shows exactly one notification for every payload, including one that throws on read", () => {
    // The invariant that costs the permission when it breaks, asserted by
    // running the handler rather than by grepping the file for the call.
    const payloads: FakeEvent["data"][] = [
      null,
      {
        text: () => {
          throw new Error("this data cannot be read");
        },
      },
      { text: () => "not json" },
      { text: () => "" },
      { text: () => JSON.stringify({ title: "Water the plants", href: "/tasks", tag: "t" }) },
    ];
    for (const data of payloads) {
      const shown = showsFor(data);
      expect(shown).toHaveLength(1);
      expect(shown[0]!.title.length).toBeGreaterThan(0);
    }
  });

  it("carries the payload's tag onto the notification it shows", () => {
    const shown = showsFor({
      text: () => JSON.stringify({ title: "Call the bank", href: "/tasks", tag: "task-reminder:b" }),
    });
    expect(shown[0]!.tag).toBe("brain:task-reminder:b");
  });
});

describe("the shipped worker's notificationclick listener", () => {
  interface FakeWindow {
    url: string;
    focus: () => unknown;
    navigate?: (url: string) => Promise<unknown>;
  }

  async function click(
    windows: FakeWindow[],
    openWindow: (url: string) => Promise<unknown>,
  ): Promise<boolean> {
    const waited: unknown[] = [];
    const { listeners } = loadShippedWorker({
      clients: {
        matchAll: () => Promise.resolve(windows),
        openWindow,
      },
    });
    let closed = false;
    listeners.notificationclick?.({
      notification: {
        data: { href: "/tasks" },
        close: () => {
          closed = true;
        },
      },
      waitUntil: (value) => waited.push(value),
    });
    await Promise.all(waited);
    return closed;
  }

  it("opens a window when there is none to reuse", async () => {
    const opened: string[] = [];
    const closed = await click([], async (url) => {
      opened.push(url);
    });
    expect(opened).toEqual(["https://brain.example/tasks"]);
    expect(closed).toBe(true);
  });

  it("navigates an open window to the notification's destination", async () => {
    const navigated: string[] = [];
    let focused = 0;
    const opened: string[] = [];
    await click(
      [
        {
          url: "https://brain.example/mail",
          focus: () => {
            focused += 1;
          },
          navigate: async (url) => {
            navigated.push(url);
            return null;
          },
        },
      ],
      async (url) => {
        opened.push(url);
      },
    );
    expect(navigated).toEqual(["https://brain.example/tasks"]);
    expect(focused).toBe(1);
    expect(opened).toEqual([]);
  });

  it("opens the destination when navigate rejects on an uncontrolled client", async () => {
    // WindowClient.navigate() rejects with a TypeError on a client this worker
    // does not control, which is every page that was already open when the
    // worker activated: there is no clients.claim() here. Without the catch
    // the tap resolved a rejected waitUntil and did nothing at all.
    //
    // It opens rather than focuses, because somebody who taps a reminder wants
    // the task and not whatever page the app was last showing. On an installed
    // iOS app openWindow with a path inside the scope opens the app there.
    let focused = 0;
    const opened: string[] = [];
    await click(
      [
        {
          url: "https://brain.example/mail",
          focus: () => {
            focused += 1;
          },
          navigate: () => Promise.reject(new TypeError("client is not controlled")),
        },
      ],
      async (url) => {
        opened.push(url);
      },
    );
    expect(opened).toEqual(["https://brain.example/tasks"]);
    expect(focused).toBe(0);
  });

  it("opens the root rather than a destination a payload invented", async () => {
    const opened: string[] = [];
    const waited: unknown[] = [];
    const { listeners } = loadShippedWorker({
      clients: {
        matchAll: () => Promise.resolve([]),
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
    });
    listeners.notificationclick?.({
      notification: { data: { href: "https://evil.example/x" }, close: () => {} },
      waitUntil: (value) => waited.push(value),
    });
    await Promise.all(waited);
    expect(opened).toEqual(["https://brain.example/"]);
  });
});

describe("the shipped worker's re-subscribe", () => {
  const OLD = "https://web.push.apple.com/brain-worker-old-endpoint";
  const NEW = "https://web.push.apple.com/brain-worker-new-endpoint";
  /** 65 bytes base64url, the shape `/api/push/key` answers with. */
  const PUBLIC_KEY = `BQ${"p".repeat(85)}`;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function resubscribe(oldSubscription: { endpoint: string } | null) {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (url === "/api/push/key") {
        return { ok: true, json: async () => ({ publicKey: PUBLIC_KEY }) };
      }
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return { ok: true };
    });
    vi.stubGlobal("atob", (value: string) =>
      Buffer.from(value, "base64").toString("binary"),
    );
    const waited: unknown[] = [];
    const { listeners } = loadShippedWorker({
      registration: {
        pushManager: {
          subscribe: async () => ({
            toJSON: () => ({ endpoint: NEW, keys: { p256dh: "p", auth: "a" } }),
          }),
        },
      },
    });
    listeners.pushsubscriptionchange?.({
      oldSubscription,
      waitUntil: (value) => waited.push(value),
    });
    await Promise.all(waited);
    return posts;
  }

  // Without the endpoint it replaces, the server has no way to know the new
  // row is the same phone: Settings grows a second row for one device, the
  // first of them silent forever and named after a device the owner still has.
  it("names the endpoint the browser retired, so the old row goes", async () => {
    const posts = await resubscribe({ endpoint: OLD });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/push/subscriptions");
    expect(posts[0].body).toMatchObject({
      subscription: { endpoint: NEW },
      previousEndpoint: OLD,
    });
  });

  it("posts the new subscription anyway when the event carries no old one", async () => {
    const posts = await resubscribe(null);
    expect(posts).toHaveLength(1);
    expect((posts[0].body as { previousEndpoint?: unknown }).previousEndpoint).toBeNull();
  });
});

describe("the shipped worker's own text", () => {
  const source = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");

  it("says at the top that it is push only", () => {
    expect(source.slice(0, 400)).toContain("push");
    expect(source.slice(0, 400)).toContain("no caching");
  });

  it("caches nothing and intercepts no navigation", () => {
    expect(source).not.toContain("caches");
    expect(source).not.toContain('addEventListener("fetch"');
  });

  it("always calls showNotification inside the push handler", () => {
    expect(source).toContain("showNotification");
  });

  it("carries no em-dash", () => {
    expect(source).not.toContain("—");
  });
});
