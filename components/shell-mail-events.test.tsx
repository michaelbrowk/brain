// @vitest-environment jsdom

// The shell's half of the change feed: an SSE `mail` event becomes a window
// event the Mail surface and the reader listen for, and a stream that reopens
// becomes a reset, because mail events are not replayed across a reconnect.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { MAIL_CHANGED_EVENT } from "@/lib/mail/mail-events";
import { resetTasksStore } from "./tasks-client";
import { resetMailComposeAvailable } from "./mail-compose-available";
import { Shell } from "./shell";

vi.mock("@/lib/client", () => ({ apiFetch: vi.fn(), CLIENT_ID: "test-client" }));
vi.mock("next/dynamic", () => ({
  default: () =>
    function Stub() {
      return null;
    },
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));
vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const STAMP = "2026-08-01T08:00:00.000Z";
const TREE: TreeNode[] = [
  {
    id: "work",
    parentId: null,
    title: "Work",
    order: "work",
    created: STAMP,
    updated: STAMP,
    hasChildren: false,
    children: [],
  },
];
const ACCOUNT = `account-a${"1".repeat(32)}`;

/** Keeps the named listeners the shell installs, so a `mail` event can be
 *  delivered the way the server delivers it. */
class FakeEventSource {
  static CLOSED = 2 as const;
  static last: FakeEventSource | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, (event: MessageEvent) => void>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(name, listener);
  }
  removeEventListener() {}
  close() {}
  deliver(name: string, data: unknown) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe("the shell's mail events", () => {
  let host: HTMLDivElement;
  let root: Root;
  const received: unknown[] = [];
  const onMail = (event: Event) => received.push((event as CustomEvent).detail);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    resetTasksStore();
    resetMailComposeAvailable();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input);
      const ok = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as Response;
      if (url === "/api/tree") return ok({ tree: TREE });
      if (url === "/api/notifications") return ok({ notifications: [], unread: 0 });
      if (url.startsWith("/api/tasks")) return ok({ tasks: [] });
      return ok({});
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ apiVersion: 2, accounts: [] }),
          }) as Response,
      ),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
    received.length = 0;
    window.addEventListener(MAIL_CHANGED_EVENT, onMail);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.removeEventListener(MAIL_CHANGED_EVENT, onMail);
    window.history.replaceState(null, "", "/");
    resetTasksStore();
    resetMailComposeAvailable();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () =>
      root.render(
        <Shell tree={TREE} initialSelectedId={null} modules={{ mail: true, tasks: true }} />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("hands each SSE mail event to the window and drops one it cannot read", async () => {
    await render();
    const event = {
      kind: "mail",
      changeKind: "content_ready",
      accountId: ACCOUNT,
      mailboxIds: [],
      messageIds: ["message-1"],
    };

    await act(async () => {
      FakeEventSource.last?.deliver("mail", event);
      FakeEventSource.last?.deliver("mail", { kind: "mail", changeKind: "moved" });
    });

    expect(received).toEqual([event]);
  });

  it("says reset when the stream reopens, and nothing on its first open", async () => {
    await render();
    const source = FakeEventSource.last!;

    await act(async () => source.onopen?.());
    expect(received).toEqual([]);
    await act(async () => source.onopen?.());
    expect(received).toEqual([{ kind: "mail", changeKind: "reset" }]);
  });
});
