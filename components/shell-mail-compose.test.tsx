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
import { DUR, EASE_OUT } from "@/lib/motion";
import type { MotionProps } from "@/test/framer-motion-mock";
import { resetMailComposeAvailable } from "./mail-compose-available";
import { Shell } from "./shell";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

/** The motion props the shell root hands framer, per render, so the recede
 *  under the compose sheet can be read off the last one. */
const shellMotion: { reduce: boolean; renders: MotionProps[] } = { reduce: false, renders: [] };

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => shellMotion.reduce,
    onRender: ({ motion, props }) => {
      if (String(props.className ?? "").split(" ").includes("brain-shell")) {
        shellMotion.renders.push(motion);
      }
    },
  });
});

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

/** A second account that can send, so the sheet's From is a switch. */
const secondAccount = {
  ...sendableAccount,
  accountId: `account-a${"b".repeat(32)}`,
  emailAddress: "second@example.test",
  displayName: null,
};

type Recorded = { readonly url: string; readonly method: string; readonly body: unknown };

/**
 * The Mail routes as a small server behind `fetch`: drafts are created,
 * patched and deleted the way the service answers them, and a send is
 * queued. Everything the sheet asked for is recorded in order, so a test
 * reads the wire rather than a mock of the surface's own client.
 */
function installMailServer(
  accounts: readonly unknown[],
  sendAnswer: { readonly status: number; readonly body: unknown } = {
    status: 200,
    body: { apiVersion: 1, operationId: "send-files-1", created: true, status: "queued" },
  },
) {
  const requests: Recorded[] = [];
  const revisions = new Map<string, number>();
  const json = (body: unknown, status = 200) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ url, method, body });
      const path = url.split("?")[0]!;
      if (path === "/api/mail/accounts/capabilities") {
        return json({ apiVersion: 3, accounts });
      }
      if (path.startsWith("/api/mail/threads")) {
        return json({
          apiVersion: 1,
          items: [],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
        });
      }
      if (path === "/api/mail/drafts" && method === "GET") {
        return json({ apiVersion: 1, drafts: [] });
      }
      if (path === "/api/mail/drafts" && method === "POST") {
        revisions.set(body.draftId, 0);
        return json({
          apiVersion: 1,
          created: true,
          draft: {
            apiVersion: 1,
            draftId: body.draftId,
            accountId: body.accountId,
            revision: 0,
            state: "editing",
            intent: body.intent,
            to: body.to,
            cc: body.cc,
            bcc: body.bcc,
            subject: body.subject,
            text: body.text,
            attachments: [],
            sendOperationId: null,
            sendErrorCode: null,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            sentAt: null,
          },
        });
      }
      if (path.startsWith("/api/mail/drafts/") && method === "PATCH") {
        const draftId = decodeURIComponent(path.split("/")[4]!);
        const appliedRevision = (revisions.get(draftId) ?? 0) + 1;
        revisions.set(draftId, appliedRevision);
        return json({ apiVersion: 1, replayed: false, appliedRevision, operationId: null });
      }
      if (path.startsWith("/api/mail/drafts/") && method === "DELETE") {
        return json({ apiVersion: 1, deleted: true, replayed: false });
      }
      if (path === "/api/mail/send" && method === "POST") {
        return json(sendAnswer.body, sendAnswer.status);
      }
      return json({ error: "not found" }, 404);
    }),
  );
  return {
    requests,
    creates: () => requests.filter((r) => r.url === "/api/mail/drafts" && r.method === "POST"),
    deletes: () =>
      requests.filter((r) => r.url.startsWith("/api/mail/drafts/") && r.method === "DELETE"),
    sends: () => requests.filter((r) => r.url === "/api/mail/send" && r.method === "POST"),
  };
}

/** A value typed into a field the way React hears it. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** Files handed to the sheet the way its file chooser hands them back. */
async function chooseFiles(files: readonly File[]) {
  const input = document.body.querySelector<HTMLInputElement>(
    '[role="dialog"] input[type="file"]',
  );
  if (!input) throw new Error("no file input on the sheet");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function until(check: () => boolean, what: string) {
  await findLazy(() => (check() ? document.body : null), what);
}

const desktop = (query: string) => ({
  matches: query === "(min-width: 768px)",
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
});

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
    expect(
      document.body.querySelector('[role="dialog"][aria-label="New message"]'),
    ).toBeNull();

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
      () => document.body.querySelector('[role="dialog"][aria-label="New message"]'),
      "the composer opened by the standing ask",
    );
    expect(composer).not.toBeNull();
  });

  // THE SHEET TAKES THE SHELL OVER, ON EVERY WIDTH. What Pages and the phone's
  // search already did below md, the composer does everywhere: the shell goes
  // inert and out of the accessibility tree, the tab bar leaves, and the two
  // chords that live on the shell (⌘K, ⌘\) fall silent, because a palette or
  // a folding sidebar under an opaque sheet is a thing that happens to a
  // window nobody can see. The proof is the same chord working again the
  // moment the sheet is gone: the guard is the composer, not the harness.
  it("makes the shell inert and silences its chords while the composer is up", async () => {
    // A desktop, so ⌘\ has a sidebar to fold and the control case is real.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 768px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    window.history.replaceState({}, "", "/mail");
    await act(async () =>
      root.render(<Shell tree={[]} initialSelectedId={null} initialSurface="mail" />),
    );
    await settle();
    const compose = await findLazy(
      () =>
        [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.getAttribute("aria-label") === "New message",
        ),
      "the column's New message",
    );
    const main = document.body.querySelector("main");
    const shell = document.body.querySelector(".brain-shell");
    expect(main?.hasAttribute("inert")).toBe(false);
    expect(document.body.querySelector('nav[aria-label="Primary"]')).not.toBeNull();

    await act(async () => compose.click());
    await settle();
    await findLazy(
      () => document.body.querySelector('textarea[placeholder="Write a message…"]'),
      "the open composer",
    );

    expect(main?.hasAttribute("inert")).toBe(true);
    expect(main?.getAttribute("aria-hidden")).toBe("true");
    expect(shell?.hasAttribute("inert")).toBe(true);
    expect(shell?.getAttribute("aria-hidden")).toBe("true");
    // The tab bar stays mounted and leaves on its own 200ms (`data-hidden`),
    // instead of unmounting in a frame while the shell recedes around it.
    const tabbar = document.body.querySelector('nav[aria-label="Primary"]');
    expect(tabbar).not.toBeNull();
    expect(tabbar?.hasAttribute("data-hidden")).toBe(true);
    expect(tabbar?.getAttribute("aria-hidden")).toBe("true");
    // The toast column stands at the body, outside the shell root, so a pill
    // that fires while the sheet is up is over it, pressable and in the
    // accessibility tree: not inside the inert shell, and not aria-hidden by
    // the dialog (Radix's hideOthers leaves live regions alone).
    const stack = document.body.querySelector(".brain-toast-stack");
    expect(stack).not.toBeNull();
    expect(stack?.closest(".brain-shell")).toBeNull();
    expect(stack?.closest("[inert]")).toBeNull();
    expect(
      stack?.querySelector('[aria-live]')?.closest('[aria-hidden="true"]') ?? null,
    ).toBeNull();
    // The shell recedes under the sheet: scale .98 at half opacity over the
    // page duration, and comes back the same way.
    expect(shellMotion.renders.at(-1)?.animate).toEqual({ scale: 0.98, opacity: 0.5 });
    expect(shellMotion.renders.at(-1)?.transition).toEqual({
      duration: DUR.page,
      ease: EASE_OUT,
    });

    const chord = async (key: string, code: string) => {
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, code, metaKey: true, bubbles: true }),
        );
      });
      await settle();
    };
    const focusChip = () =>
      [...document.body.querySelectorAll("button")].some((button) =>
        button.getAttribute("title")?.startsWith("Exit focus mode"),
      );
    await chord("k", "KeyK");
    expect(document.body.querySelector("[cmdk-input]")).toBeNull();
    await chord("\\", "Backslash");
    expect(focusChip()).toBe(false);

    const close = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "Close draft",
    );
    expect(close).toBeDefined();
    await act(async () => close?.click());
    await settle();
    expect(main?.hasAttribute("inert")).toBe(false);
    expect(shell?.hasAttribute("inert")).toBe(false);
    expect(
      document.body.querySelector('nav[aria-label="Primary"]')?.hasAttribute("data-hidden"),
    ).toBe(false);
    expect(shellMotion.renders.at(-1)?.animate).toEqual({ scale: 1, opacity: 1 });

    await chord("\\", "Backslash");
    expect(focusChip()).toBe(true);
  });

  it("does not recede under reduced motion: the shell keeps its scale and its opacity", async () => {
    shellMotion.reduce = true;
    window.history.replaceState({}, "", "/mail");
    await act(async () =>
      root.render(<Shell tree={[]} initialSelectedId={null} initialSurface="mail" />),
    );
    await settle();
    const compose = await findLazy(
      () =>
        [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.getAttribute("aria-label") === "New message",
        ),
      "the column's New message",
    );
    await act(async () => compose.click());
    await settle();
    await findLazy(
      () => document.body.querySelector('textarea[placeholder="Write a message…"]'),
      "the open composer",
    );
    expect(document.body.querySelector(".brain-shell")?.hasAttribute("inert")).toBe(true);
    expect(shellMotion.renders.at(-1)?.animate).toEqual({ scale: 1, opacity: 1 });
  });

  // THE FILES AND THE FROM SWITCH, AT THE SEAM THEY CROSS. The sheet holds
  // its files in memory; the surface moves the draft underneath a From
  // switch, sends the files through the send door, and says what a closing
  // sheet leaves behind.
  describe("the sheet's files and its From switch", () => {
    const openSheet = async (
      accounts: readonly unknown[],
      sendAnswer?: Parameters<typeof installMailServer>[1],
    ) => {
      vi.stubGlobal("matchMedia", desktop);
      const server = installMailServer(accounts, sendAnswer);
      window.history.replaceState({}, "", "/mail");
      await act(async () =>
        root.render(<Shell tree={[]} initialSelectedId={null} initialSurface="mail" />),
      );
      await settle();
      const compose = await findLazy(
        () =>
          [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.getAttribute("aria-label") === "New message",
          ),
        "the column's New message",
      );
      await act(async () => compose.click());
      await settle();
      const sheet = await findLazy(
        () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="New message"]'),
        "the open sheet",
      );
      return { server, sheet };
    };
    const to = () =>
      document.body.querySelector<HTMLInputElement>('[role="dialog"] input[autocomplete="email"]')!;
    const body = () => document.body.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
    const chipNames = () =>
      [...document.body.querySelectorAll(".brain-compose-shelf .brain-compose-attachment-name")].map(
        (node) => node.textContent,
      );
    const button = (label: string) =>
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.getAttribute("aria-label") === label,
      );

    it("switches From in place: the same sheet, the focus kept, the files kept, the draft moved underneath", async () => {
      const { server, sheet } = await openSheet([sendableAccount, secondAccount]);
      await type(to(), "ben@example.test");
      await type(body(), "Moving house");
      await until(() => server.creates().length === 1, "the first draft's create");
      expect((server.creates()[0]?.body as { accountId: string }).accountId).toBe(
        sendableAccount.accountId,
      );
      await chooseFiles([new File(["quote"], "Quote.pdf", { type: "application/pdf" })]);
      const toField = to();

      const trigger = document.body.querySelector<HTMLButtonElement>(
        '.brain-compose-from button[aria-label^="From:"]',
      )!;
      trigger.focus();
      await act(async () => {
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      await settle();
      const row = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (item) => item.textContent?.includes(secondAccount.emailAddress),
      )!;
      await act(async () => row.click());
      await settle();

      // No exit and no enter: the same sheet and the same fields stand, and
      // there was never a second one.
      expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(document.body.querySelector('[role="dialog"]')).toBe(sheet);
      expect(to()).toBe(toField);
      expect(chipNames()).toEqual(["Quote.pdf"]);
      // The caret goes back to the From it was on, not to To.
      await until(() => document.activeElement === trigger, "the focus back on From");
      expect(trigger.getAttribute("aria-label")).toBe("From: second@example.test");

      // Underneath: the next create carries the second account and what was
      // typed, and the first account's draft is deleted.
      await until(() => server.creates().length === 2, "the second account's create");
      expect(server.creates()[1]?.body).toMatchObject({
        accountId: secondAccount.accountId,
        to: "ben@example.test",
        text: "Moving house",
      });
      await until(() => server.deletes().length === 1, "the first draft's delete");
      expect(server.deletes()[0]?.body).toMatchObject({ accountId: sendableAccount.accountId });
    });

    it("sends the files through the send door with the letter, from the account in From", async () => {
      const { server } = await openSheet([sendableAccount]);
      await type(to(), "ben@example.test");
      await type(body(), "The quote, attached.");
      await chooseFiles([new File(["hello"], "hello.txt", { type: "text/plain" })]);
      const send = document.body.querySelector<HTMLButtonElement>(
        '[role="dialog"] button[type="submit"]',
      )!;
      await act(async () => send.click());
      await until(() => server.sends().length === 1, "the send");

      expect(server.sends()[0]?.body).toMatchObject({
        accountId: sendableAccount.accountId,
        to: ["ben@example.test"],
        text: "The quote, attached.",
        attachments: [{ filename: "hello.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" }],
      });
      await until(
        () => document.body.querySelector('[role="dialog"]') === null,
        "the sheet gone once the letter is queued",
      );
      await until(
        () => document.body.textContent?.includes("Message queued") ?? false,
        "the queued toast",
      );
      // The draft that held the words stays until the letter is known sent:
      // a letter that fails later is still in Drafts.
      expect(server.deletes()).toHaveLength(0);
    });

    it.each([
      [
        413,
        "mail_send_attachments_too_large",
        "These files are too large to send. A message can carry 10 MB of files.",
      ],
      [
        413,
        "mail_send_request_invalid",
        "These files are too large to send. A message can carry 10 MB of files.",
      ],
      [400, "mail_send_attachments_invalid", "One of these files can’t be sent. Remove it and try again."],
    ])("words a %i %s from the send door in the slot, and keeps Send live", async (status, code, sentence) => {
      const { server } = await openSheet([sendableAccount], {
        status,
        body: { apiVersion: 1, error: { code } },
      });
      await type(to(), "ben@example.test");
      await chooseFiles([new File(["hello"], "hello.txt", { type: "text/plain" })]);
      const send = document.body.querySelector<HTMLButtonElement>(
        '[role="dialog"] button[type="submit"]',
      )!;
      await act(async () => send.click());
      await until(() => server.sends().length === 1, "the send");
      await until(
        () =>
          document.body.querySelector('[role="dialog"] .brain-compose-slot [role="alert"]')
            ?.textContent === sentence,
        "the refusal in the slot",
      );
      expect(send.disabled).toBe(false);
      expect(chipNames()).toEqual(["hello.txt"]);
    });

    it("says at once that the draft it keeps has no files, when the sheet closes with files on it", async () => {
      await openSheet([sendableAccount]);
      await type(to(), "ben@example.test");
      await chooseFiles([new File(["quote"], "Quote.pdf", { type: "application/pdf" })]);
      await act(async () => button("Close draft")?.click());
      await settle();

      await until(
        () => document.body.textContent?.includes("Draft kept without its files.") ?? false,
        "the files toast",
      );
    });

    it("says it when an Undo brings back a discarded sheet that had files", async () => {
      await openSheet([sendableAccount]);
      await type(to(), "ben@example.test");
      await chooseFiles([new File(["quote"], "Quote.pdf", { type: "application/pdf" })]);
      await act(async () => button("Discard draft")?.click());
      await settle();
      await until(
        () => document.body.textContent?.includes("Draft discarded") ?? false,
        "the discard pill",
      );
      // The files went with the discard; Undo brings back the words only.
      expect(document.body.textContent).not.toContain("Draft kept without its files.");
      const undo = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Undo",
      );
      await act(async () => undo?.click());
      await settle();
      await until(
        () => document.body.querySelector('[role="dialog"]') !== null,
        "the sheet back",
      );
      await until(
        () => document.body.textContent?.includes("Draft kept without its files.") ?? false,
        "the files toast",
      );
      expect(chipNames()).toEqual([]);
    });
  });
});
