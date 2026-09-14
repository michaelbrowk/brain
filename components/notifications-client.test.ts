// @vitest-environment jsdom

// The centre's client store. Written as `.ts` and not `.tsx` on purpose: the
// module it tests carries no JSX and neither does this, so the two probes are
// built with `createElement` rather than dragging a JSX pragma into a file
// whose subject is a fetch.

import { Fragment, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainNotification } from "@/lib/notifications/model";
import {
  hasUnreadRow,
  markAllRead,
  markMailNotificationRead,
  markRead,
  resetNotificationsStore,
  useNotifications,
  type NotificationRow,
} from "./notifications-client";

/** THE ROW IS WRITTEN OUT TWICE AND HELD TO ITSELF HERE.
 *
 *  `components/notifications-client.ts` declares its own `NotificationRow`
 *  rather than importing `BrainNotification`, because the mail read seam
 *  re-exports through it and `lib/notifications/model.ts` builds a zod schema
 *  at module scope, and `components/notifications-read.test.ts` fails the day
 *  that schema can be reached from the seam. A test file is not in the
 *  bundler's graph, so the two shapes meet here instead, and a field added to
 *  the schema and not to the row stops compiling. */
const _rowIsASchemaRow: BrainNotification = {} as NotificationRow;
const _schemaRowIsARow: NotificationRow = {} as BrainNotification;
void _rowIsASchemaRow;
void _schemaRowIsARow;

vi.mock("@/lib/client", () => ({
  apiFetch: (...args: unknown[]) => (globalThis.fetch as typeof fetch)(...(args as [RequestInfo])),
  CLIENT_ID: "test-client",
}));

let calls: { url: string; body: unknown }[];
let rows: unknown[];

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const row = (id: string, readAt?: string) => ({
  id,
  kind: "task-reminder",
  at: "2026-09-14T12:00:00.000Z",
  title: "Water the plants",
  href: "/tasks",
  ...(readAt ? { readAt } : {}),
});

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetNotificationsStore();
  calls = [];
  rows = [row("a"), row("b", "2026-09-14T12:05:00.000Z")];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/notifications") {
        return response({
          notifications: rows,
          unread: rows.filter((r) => (r as { readAt?: string }).readAt === undefined).length,
        });
      }
      return response({ read: 1 });
    }),
  );
});
afterEach(() => {
  resetNotificationsStore();
  vi.unstubAllGlobals();
});

function mount(): { host: HTMLDivElement; root: Root; seen: unknown[] } {
  const seen: unknown[] = [];
  function Probe() {
    seen.push(useNotifications(0));
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(createElement(Fragment, null, createElement(Probe), createElement(Probe))),
  );
  return { host, root, seen };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the notifications client", () => {
  it("asks once however many subscribers there are", async () => {
    const { root } = mount();
    await settle();
    expect(calls.filter((c) => c.url === "/api/notifications")).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it("reports the unread count the route sent", async () => {
    const { root, seen } = mount();
    await settle();
    expect((seen.at(-1) as { unread: number }).unread).toBe(1);
    await act(async () => root.unmount());
  });

  it("marks read optimistically and posts the ids", async () => {
    const { root, seen } = mount();
    await settle();
    await act(async () => {
      await markRead(["a"]);
    });
    expect((seen.at(-1) as { unread: number }).unread).toBe(0);
    expect(calls.find((c) => c.url === "/api/notifications/read")?.body).toEqual({ ids: ["a"] });
    await act(async () => root.unmount());
  });

  it("does not post for an id already read", async () => {
    const { root } = mount();
    await settle();
    await act(async () => {
      await markRead(["b"]);
    });
    expect(calls.some((c) => c.url === "/api/notifications/read")).toBe(false);
    await act(async () => root.unmount());
  });

  it("clears everything through read-all", async () => {
    const { root, seen } = mount();
    await settle();
    await act(async () => {
      await markAllRead();
    });
    expect((seen.at(-1) as { unread: number }).unread).toBe(0);
    expect(calls.some((c) => c.url === "/api/notifications/read-all")).toBe(true);
    await act(async () => root.unmount());
  });

  it("says nothing to the server for a thread with no unread row in the centre", async () => {
    const { root } = mount();
    await settle();
    calls.length = 0;
    markMailNotificationRead("account-adeadbeefdeadbeefdeadbeefdeadbeef", "thread-one");
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual([]);
    await act(async () => root.unmount());
  });

  it("still says nothing once the seam's own window has closed", async () => {
    // The test above passes on the batching window alone, which would hold
    // even if the skip were not there. This one waits the window out, which
    // is where a read with no row would actually go to the server.
    vi.useFakeTimers();
    try {
      const { root } = mount();
      await settle();
      calls.length = 0;
      markMailNotificationRead("account-adeadbeefdeadbeefdeadbeefdeadbeef", "thread-one");
      await vi.advanceTimersByTimeAsync(400);
      expect(calls).toEqual([]);
      await act(async () => root.unmount());
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts a thread read that the centre does hold, so the skip is not a blanket", async () => {
    const mailId = "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d6f6e65";
    rows = [{ ...row("a"), id: mailId, kind: "mail-new", href: "/mail" }];
    vi.useFakeTimers();
    try {
      const { root } = mount();
      await settle();
      expect(hasUnreadRow(mailId)).toBe(true);
      calls.length = 0;
      markMailNotificationRead("account-adeadbeefdeadbeefdeadbeefdeadbeef", "thread-one");
      await vi.advanceTimersByTimeAsync(400);
      expect(calls).toEqual([{ url: "/api/notifications/read", body: { ids: [mailId] } }]);
      await act(async () => root.unmount());
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads rather than guessing when the read the server was told about fails", async () => {
    const { root } = mount();
    await settle();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url === "/api/notifications") {
          return response({ notifications: rows, unread: 1 });
        }
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
      }),
    );
    calls.length = 0;
    await act(async () => {
      await markRead(["a"]);
    });
    await settle();
    expect(calls.map((c) => c.url)).toEqual([
      "/api/notifications/read",
      "/api/notifications",
    ]);
    await act(async () => root.unmount());
  });
});
