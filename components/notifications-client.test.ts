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
  markMailCentreRead,
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

const MAIL_ID = "mail-new:2026-09-14T12:00:00.000Z";

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

  it("says nothing to the server when the centre holds no mail row", async () => {
    const { root } = mount();
    await settle();
    calls.length = 0;
    markMailCentreRead();
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual([]);
    await act(async () => root.unmount());
  });

  it("marks the mail row read when Mail opens", async () => {
    rows = [{ ...row("a"), id: MAIL_ID, kind: "mail-new", title: "3 new messages", href: "/mail" }];
    const { root } = mount();
    await settle();
    expect(hasUnreadRow(MAIL_ID)).toBe(true);
    calls.length = 0;
    await act(async () => {
      markMailCentreRead();
      await Promise.resolve();
    });
    expect(calls).toEqual([{ url: "/api/notifications/read", body: { ids: [MAIL_ID] } }]);
    await act(async () => root.unmount());
  });

  it("marks no reminder, whatever else the centre is holding", async () => {
    rows = [row("a"), { ...row("m"), id: MAIL_ID, kind: "mail-new", href: "/mail" }];
    const { root } = mount();
    await settle();
    calls.length = 0;
    await act(async () => {
      markMailCentreRead();
      await Promise.resolve();
    });
    expect(calls).toEqual([{ url: "/api/notifications/read", body: { ids: [MAIL_ID] } }]);
    await act(async () => root.unmount());
  });

  it("waits for the centre's first answer when Mail mounted before it", async () => {
    // Mail and the bell mount together, and Mail is usually the faster of the
    // two: there is no row to name yet, so the wish is kept and taken on the
    // commit the bell's own fetch causes.
    rows = [{ ...row("a"), id: MAIL_ID, kind: "mail-new", title: "3 new messages", href: "/mail" }];
    markMailCentreRead();
    expect(calls).toEqual([]);
    const { root } = mount();
    await settle();
    await settle();
    expect(calls.map((c) => c.url)).toEqual([
      "/api/notifications",
      "/api/notifications/read",
    ]);
    await act(async () => root.unmount());
  });

  it("opens the mail row with one read POST and no mail request at all", async () => {
    // The row is the count of what is waiting, not a letter, so a press marks
    // it read and opens Mail. `./mail-surface-client` is not doubled here, so
    // a PATCH would be a real one.
    const mailRow = {
      id: MAIL_ID,
      kind: "mail-new" as const,
      at: "2026-09-14T12:00:00.000Z",
      title: "3 new messages",
      href: "/mail",
    };
    rows = [mailRow];
    const wire: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        wire.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/notifications") {
          return response({ notifications: rows, unread: 1 });
        }
        return response({ read: 1 });
      }),
    );
    const { root } = mount();
    await settle();
    const { openNotificationRow } = await import("./notifications-bell");
    wire.length = 0;
    await act(async () => {
      openNotificationRow(mailRow, () => undefined);
      await Promise.resolve();
    });
    expect(wire).toEqual(["POST /api/notifications/read"]);
    await act(async () => root.unmount());
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
