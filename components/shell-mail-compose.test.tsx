// @vitest-environment jsdom

// THE COMPOSE ASK, PROVEN AT THE SEAM IT CROSSES.
//
// `mail-commands.test.ts` pins the latch as a module, in isolation.
// `mail-surface.test.tsx` drives MailSurface's own handlers with a stub
// client already mounted. Neither renders the assembled <Shell>, so neither
// proves the thing Message is FOR: an ask made from a page, before Mail has
// mounted, still opens a composer once Mail is up. This is the mirror of
// shell-tasks-navigation.test.tsx's "opens Tasks with the caret in the
// capture row from the head's plus", where Task has that shell-level case
// and Message did not.

import { act, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";
import { resetMailComposeAvailable } from "./mail-compose-available";
import { Shell } from "./shell";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

// The real `./mail-surface` module, not a fake: the latch's own `take()`
// effect is the seam under test, so it has to run. `next/dynamic` is stubbed
// to resolve the loader for real, the way jsdom needs since it does no
// code-splitting.
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    let Resolved: React.ComponentType<Record<string, unknown>> | null = null;
    return function DynamicStub(props: Record<string, unknown>) {
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        if (Resolved) return;
        void Promise.resolve(loader()).then((mod) => {
          Resolved =
            (mod as { default?: React.ComponentType<Record<string, unknown>> })
              ?.default ?? (mod as React.ComponentType<Record<string, unknown>>);
          force();
        });
      }, []);
      return Resolved ? <Resolved {...props} /> : null;
    };
  },
}));

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function findLazy<T extends Element>(
  select: () => T | null | undefined,
  what: string,
): Promise<T> {
  for (let round = 0; round < 200; round += 1) {
    const found = select();
    if (found) return found;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await settle();
  }
  throw new Error(`not found: ${what}`);
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
  constructor() {
    FakeEventSource.instances.push(this);
  }
}

/** One connected account that can send, so `firstComposeAccount` has
 *  somewhere to open the blank composer against. */
const sendableAccount = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  emailAddress: "person@example.test",
  displayName: "Personal",
  status: "connected",
  connectedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerKind: "gmail",
  capabilities: {
    mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: true,
    send: true,
    reply: true,
  },
};

describe("the compose ask, through the assembled shell", () => {
  let host: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    resetMailComposeAvailable();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/tree") return response({ tree: [] });
      if (url.startsWith("/api/tasks?")) return response({ tasks: [] });
      if (url === "/api/notifications")
        return response({ notifications: [], unread: 0 });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/mail/accounts/capabilities")) {
          return Promise.resolve(
            response({ apiVersion: 3, accounts: [sendableAccount] }),
          );
        }
        if (url.startsWith("/api/mail/threads")) {
          return Promise.resolve(
            response({
              apiVersion: 1,
              items: [],
              nextCursor: null,
              sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
            }),
          );
        }
        return Promise.resolve(response({ error: "not found" }, 404));
      }),
    );
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("PointerEvent", MouseEvent);
    for (const name of [
      "hasPointerCapture",
      "setPointerCapture",
      "releasePointerCapture",
    ]) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        value: () => (name === "hasPointerCapture" ? false : undefined),
      });
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((element) => element.remove());
    window.history.replaceState(null, "", "/");
    resetMailComposeAvailable();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the composer once Mail mounts, for an ask made from a page", async () => {
    window.history.replaceState({}, "", "/");

    await act(async () => root.render(<Shell tree={[]} initialSelectedId={null} />));
    await settle();
    expect(document.body.querySelector('form[aria-label="New message"]')).toBeNull();

    // The palette's "New message" row: unconditional on `onNewMessage`, so
    // the ask does not have to wait on the compose-availability fetch first.
    // It runs the same row the New menu's Message press ultimately runs.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    await settle();

    const newMessage = await findLazy(
      () =>
        [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
          (item) => item.textContent?.trim() === "New message",
        ),
      "the palette's New message row",
    );
    await act(async () => newMessage.click());

    expect(window.location.pathname).toBe("/mail");

    // Mail was not mounted when the ask was made, and the latch is what
    // carries it across. `take()`'s initial call, not only the subscription,
    // is what this proves: dropping it (review mutation M4) leaves the ask
    // standing and this composer never opens.
    const composer = await findLazy(
      () => document.body.querySelector('form[aria-label="New message"]'),
      "the composer opened by the standing ask",
    );
    expect(composer).not.toBeNull();
  });
});
