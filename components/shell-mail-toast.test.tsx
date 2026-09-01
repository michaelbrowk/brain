// @vitest-environment jsdom

// The shell's toast channels, driven the way mail drives them.
//
// `mail-surface.test.tsx` proves what MailSurface hands `onToast`; it cannot
// prove the sentence is ever spoken, because there the callback is a stub.
// This file renders the assembled <Shell>, takes the `onToast` it hands the
// mail surface, and asserts what reaches the DOM — which is where the gap was:
// a refusal raised while an undo was standing fired the callback and then sat
// in the queue for ten seconds, saying nothing.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import type { ToastOptions } from "./ui/primitives";
import { Shell } from "./shell";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

type ToastFn = (title: string, options?: ToastOptions) => void;
let mailToast: ToastFn | null = null;

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    if (String(loader).includes("mail-surface")) {
      return function FakeMailSurface(props: { onToast?: ToastFn }) {
        mailToast = props.onToast ?? null;
        return <div data-testid="fake-mail-surface" />;
      };
    }
    return function FakeEditor() {
      return <div data-testid="fake-editor" />;
    };
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const STAMP = "2026-08-01T08:00:00.000Z";

function fixtureTree(): TreeNode[] {
  return [
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
}

class FakeEventSource {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

/** What Done says at the press: a report with a way back and a long window. */
function doneReport(
  onAction: () => boolean | void | Promise<unknown>,
): ToastOptions {
  return {
    icon: "check-linear",
    subtitle: "8 threads out of your inbox",
    actionLabel: "Undo",
    onAction,
    durationMs: 10_000,
    id: "mail-section-done:1",
  };
}

describe("shell toast channels, as mail uses them", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ now: new Date("2026-08-20T10:00:00.000Z") });
    localStorage.clear();
    mailToast = null;
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ tree: fixtureTree() }),
        }) as Response,
    );
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("PointerEvent", MouseEvent);
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

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    window.history.replaceState({}, "", "/mail");
    await act(async () =>
      root.render(
        <Shell
          tree={fixtureTree()}
          initialSelectedId={null}
          initialSurface="mail"
        />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function say(title: string, options?: ToastOptions) {
    if (!mailToast) throw new Error("the mail surface never got onToast");
    const speak = mailToast;
    return act(async () => speak(title, options));
  }

  const pills = () =>
    [...document.body.querySelectorAll(".brain-toast")].map(
      (pill) => pill.textContent ?? "",
    );
  const alertPill = () =>
    document.body.querySelector('[aria-live="assertive"] .brain-toast')
      ?.textContent ?? null;

  it("says a report, with its way back", async () => {
    await say(
      "Newsletters cleared",
      doneReport(() => {}),
    );
    expect(pills().join(" ")).toContain("Newsletters cleared");
    expect(pills().join(" ")).toContain("8 threads out of your inbox");
    expect(pills().join(" ")).toContain("Undo");
  });

  it("a report with no window stands, and takes a ring only when there is one to count", async () => {
    // What Done says at the press of a big section. It has no deadline to
    // name — the run is eighty sequential requests — so it names none, and
    // the icon slot stays a plain glyph: the ring draws deadlines and there
    // is nothing here for it to draw.
    await say("Seen cleared", { ...doneReport(() => {}), durationMs: null });
    expect(document.body.querySelector(".brain-toast [data-toast-ring]")).toBeNull();

    // Past the point where the old arithmetic would have taken the pill down
    // — ten seconds plus six a thread, over forty threads. The way back is
    // still on screen, because the work it reverses is still going out.
    await act(async () => {
      vi.advanceTimersByTime(10_000 + 40 * 6_000 + 1_000);
    });
    expect(pills().join(" | ")).toContain("Seen cleared");
    expect(pills().join(" | ")).toContain("Undo");

    // The loop lands and says the same sentence again under the same id. NOW
    // there is a deadline: the ring appears and drains the plain ten seconds
    // from here, and the pill goes when they are spent.
    await say("Seen cleared", doneReport(() => {}));
    expect(document.body.querySelector(".brain-toast [data-toast-ring]")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });
    expect(pills().join(" | ")).not.toContain("Seen cleared");
  });

  it("speaks a refusal WHILE an undo is standing, without taking its pill", async () => {
    await say(
      "Newsletters cleared",
      doneReport(() => {}),
    );
    await say("Finish the current mail action first", { urgent: true });

    // Both, at once: the undo keeps the pill it was given and the refusal
    // gets one of its own. Queued, this sentence would have surfaced ten
    // seconds later, detached from the press and by then untrue.
    const spoken = pills().join(" | ");
    expect(spoken).toContain("Newsletters cleared");
    expect(spoken).toContain("Undo");
    expect(alertPill()).toContain("Finish the current mail action first");
  });

  it("a REPORT arriving in the same beat still waits its turn", async () => {
    await say(
      "Newsletters cleared",
      doneReport(() => {}),
    );
    await say("People cleared", { id: "mail-section-done:2" });
    expect(pills().join(" | ")).not.toContain("People cleared");
    expect(pills().join(" | ")).toContain("Newsletters cleared");
  });

  it("takes the refusal down on its own, leaving the undo standing", async () => {
    await say(
      "Newsletters cleared",
      doneReport(() => {}),
    );
    await say("Finish the current mail action first", { urgent: true });
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(alertPill()).toBeNull();
    expect(pills().join(" | ")).toContain("Newsletters cleared");
  });

  it("⌘Z reaches the standing toast's action", async () => {
    const undo = vi.fn(() => true as const);
    await say("Newsletters cleared", doneReport(undo));

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true }),
      );
    });
    expect(undo).toHaveBeenCalledTimes(1);
    // Spent: the pill goes with the press, so the undo cannot run twice.
    expect(pills().join(" | ")).not.toContain("Newsletters cleared");
  });

  it("⌘Z on a refused action leaves the message and its window alone", async () => {
    const undo = vi.fn(() => false as const);
    await say("Newsletters cleared", doneReport(undo));

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true }),
      );
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(pills().join(" | ")).toContain("Newsletters cleared");
  });

  it("⌘Z inside a typing surface is the field's, and the way back survives it", async () => {
    const undo = vi.fn(() => true as const);
    await say("Newsletters cleared", doneReport(undo));

    // The composer, or any field: the window listener runs AFTER ProseMirror
    // has taken the typo back, so without the guard one ⌘Z would fix a letter
    // and roll eleven archived threads back with it.
    for (const field of [
      Object.assign(document.createElement("input"), { type: "text" }),
      (() => {
        const host = document.createElement("div");
        host.setAttribute("contenteditable", "true");
        // the key lands on the deepest node, not on the editable host
        host.appendChild(document.createElement("span"));
        return host;
      })(),
    ]) {
      document.body.appendChild(field);
      const target = field.lastElementChild ?? field;
      const event = new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        target.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      field.remove();
    }

    expect(undo).not.toHaveBeenCalled();
    // Untouched: the pill, its action and the rest of its window.
    expect(pills().join(" | ")).toContain("Newsletters cleared");
    expect(pills().join(" | ")).toContain("Undo");
  });

  it("an action that answers with a promise holds the pill until it settles", async () => {
    // Undo pressed while Done's loop is still sending: the surface answers
    // with the run's own settling promise. The pill has to stand until then
    // — taken down at once, the way back looked spent while nothing had been
    // reversed, and there was nowhere left to press when the run finally
    // dropped the lock.
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const undo = vi.fn(() => settled);
    await say("Seen cleared", {
      ...doneReport(undo),
      durationMs: null,
      pendingLabel: "Undoing…",
    });
    const button = () =>
      [...document.body.querySelectorAll<HTMLButtonElement>(".brain-toast button")].at(0) ??
      null;
    expect(button()?.textContent).toBe("Undo");

    await act(async () => {
      button()!.click();
    });
    expect(undo).toHaveBeenCalledTimes(1);
    // Still standing, and saying what it is doing; the button is out of
    // reach so the reversal cannot be started twice.
    expect(pills().join(" | ")).toContain("Seen cleared");
    expect(button()?.textContent).toBe("Undoing…");
    expect(button()?.disabled).toBe(true);

    // Neither the pointer nor ⌘Z gets a second run out of it.
    await act(async () => {
      button()!.click();
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true }),
      );
    });
    expect(undo).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
      await settled;
    });
    expect(pills().join(" | ")).not.toContain("Seen cleared");
  });

  it("a same-id message arriving under an open action takes the pill, and outlives the action", async () => {
    // Undo's own "working" pill: posted under Done's id while the way back
    // goes out. It replaces the pill whose action is open, and when that
    // action's promise settles the shell must not take it down — it is not
    // the pill the press spent, and its own report will replace it.
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    await say("Seen cleared", {
      ...doneReport(() => settled),
      durationMs: null,
      pendingLabel: "Undoing…",
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(".brain-toast button")!.click();
    });
    expect(pills().join(" | ")).toContain("Undoing…");

    await say("Putting back…", {
      icon: "inbox-linear",
      subtitle: "8 threads on the way back",
      durationMs: null,
      id: "mail-section-done:1",
    });
    expect(pills().join(" | ")).toContain("Putting back…");
    expect(pills().join(" | ")).not.toContain("Seen cleared");
    expect(document.body.querySelector(".brain-toast button")).toBeNull();
    expect(document.body.querySelector(".brain-toast [data-toast-ring]")).toBeNull();

    await act(async () => {
      settle();
      await settled;
    });
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(pills().join(" | ")).toContain("Putting back…");

    await say("Back in your inbox", {
      icon: "inbox-linear",
      subtitle: "8 threads restored",
      id: "mail-section-done:1",
    });
    expect(pills().join(" | ")).toContain("Back in your inbox");
    expect(pills().join(" | ")).not.toContain("Putting back…");
    await act(async () => {
      vi.advanceTimersByTime(2_201);
    });
    expect(pills().join(" | ")).not.toContain("Back in your inbox");
  });

  it("⌘Z is not swallowed when the pill has no action", async () => {
    await say("Saved");
    const event = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});
