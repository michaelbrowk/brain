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
import { SMART_UNDO_MS } from "./shell/helpers";

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

/** What a section's Done says at the press: the column's fact, its Undo, the
 *  window every other Undo in Brain has, and the one id every Done wears. */
function doneReport(
  onAction: () => boolean | void | Promise<unknown>,
  onExpire?: () => void,
): ToastOptions {
  return {
    icon: "check-linear",
    subtitle: "8 threads out of your inbox",
    actionLabel: "Undo",
    onAction,
    onExpire,
    durationMs: SMART_UNDO_MS,
    id: "mail-section-done",
  };
}

/** What a Block says once the service has taken it: an Undo whose own request
 *  takes a moment, so its button wears a pending label while it is out. */
function blockReport(onAction: () => Promise<unknown>): ToastOptions {
  return {
    icon: "user-block-rounded-linear",
    subtitle: "Next letters go to Blocked too.",
    actionLabel: "Undo",
    pendingLabel: "Undoing…",
    onAction,
    durationMs: SMART_UNDO_MS,
    id: "mail-sender:1",
  };
}

/** A refusal mail really makes while an Undo may be standing. */
const REFUSAL = "Couldn’t accept Lena Okafor. Try again.";

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

  it("Done's pill wears its ring from the press, and says so when its window closes", async () => {
    // The press owes the provider nothing yet, so there is a real deadline
    // to draw from the first frame: the nine seconds the archives wait.
    const expired = vi.fn();
    await say("Seen cleared", doneReport(() => {}, expired));
    expect(document.body.querySelector(".brain-toast [data-toast-ring]")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(SMART_UNDO_MS - 1);
    });
    expect(pills().join(" | ")).toContain("Seen cleared");
    expect(pills().join(" | ")).toContain("Undo");
    expect(expired).not.toHaveBeenCalled();

    // The window closes: the pill goes, and the surface is told, which is
    // the moment its archives start going out.
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(pills().join(" | ")).not.toContain("Seen cleared");
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("a second Done takes the pill from the first under their one id, and the first is told", async () => {
    const firstExpired = vi.fn();
    const firstUndo = vi.fn();
    await say("Newsletters cleared", doneReport(firstUndo, firstExpired));
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await say("People cleared", {
      ...doneReport(() => {}),
      subtitle: "2 threads out of your inbox",
    });

    // Not queued behind the first Undo: the same id is the same pill, said
    // again. The first lost its way back unspent, so it hears `onExpire`,
    // and the second counts a whole window of its own from here.
    expect(pills().join(" | ")).toContain("People cleared");
    expect(pills().join(" | ")).not.toContain("Newsletters cleared");
    expect(firstExpired).toHaveBeenCalledTimes(1);
    expect(firstUndo).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(SMART_UNDO_MS - 1);
    });
    expect(pills().join(" | ")).toContain("People cleared");
  });

  // TWO UNDOS AT ONCE. A Done pressed while a Block's Undo stood used to wait
  // in the queue: its section left the column at the press and no pill said
  // so for up to nine seconds. Now it stands at once, on top of the other.
  describe("a second undo over a standing one", () => {
    const pillOf = (title: string) =>
      [...document.body.querySelectorAll<HTMLElement>(".brain-toast")].find((pill) =>
        pill.textContent?.includes(title),
      ) ?? null;
    const undoOf = (title: string) =>
      pillOf(title)?.querySelector<HTMLButtonElement>("button") ?? null;

    it("a second Done stands on top of a Block pressed between them, and ⌘Z reaches it", async () => {
      const firstExpired = vi.fn();
      const secondUndo = vi.fn();
      const blockUndo = vi.fn(() => true as const);
      await say("Newsletters cleared", doneReport(() => {}, firstExpired));
      await say("Blocked Lena Okafor", {
        ...blockReport(() => Promise.resolve()),
        onAction: blockUndo,
      });
      // What mail says on a second Done: the first's sentence again under the
      // one id, without its Undo, then the second Done with one.
      await say("Newsletters archived", { id: "mail-section-done", icon: "check-linear" });
      await say("People cleared", doneReport(secondUndo));

      expect(pills()).toHaveLength(2);
      expect(pills()[0]).toContain("People cleared");
      expect(pills()[1]).toContain("Blocked Lena Okafor");
      expect(firstExpired).toHaveBeenCalledTimes(1);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }));
      });
      expect(secondUndo).toHaveBeenCalledTimes(1);
      expect(blockUndo).not.toHaveBeenCalled();
    });

    it("a second Done draws a ring of its own from its press", async () => {
      await say("Newsletters cleared", doneReport(() => {}));
      const firstRing = pillOf("Newsletters cleared")?.querySelector("[data-toast-ring]");
      expect(firstRing).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(4_000);
      });
      await say("People cleared", doneReport(() => {}));
      const secondRing = pillOf("People cleared")?.querySelector("[data-toast-ring]");
      expect(secondRing).not.toBeNull();
      // A new element: its drain animation starts at the press instead of
      // carrying on from where the first Done's had got to.
      expect(secondRing).not.toBe(firstRing);
    });

    it("shows Done at once, on top of the Block, each with its own ring", async () => {
      await say("Blocked Lena Okafor", blockReport(() => Promise.resolve()));
      const blockRing = pillOf("Blocked Lena Okafor")?.querySelector("[data-toast-ring]");
      expect(blockRing).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      await say("Newsletters cleared", doneReport(() => {}));

      // Both up, the newest at the head of the column.
      expect(pills()).toHaveLength(2);
      expect(pills()[0]).toContain("Newsletters cleared");
      expect(pills()[1]).toContain("Blocked Lena Okafor");
      // Done's ring is its own, drawn from the press. The Block's is the same
      // element it was, still counting from its own press.
      expect(pillOf("Newsletters cleared")?.querySelector("[data-toast-ring]")).not.toBeNull();
      expect(pillOf("Blocked Lena Okafor")?.querySelector("[data-toast-ring]")).toBe(blockRing);
    });

    it("lets each Undo undo only its own action", async () => {
      const blockUndo = vi.fn(() => Promise.resolve());
      const doneUndo = vi.fn();
      await say("Blocked Lena Okafor", blockReport(blockUndo));
      await say("Newsletters cleared", doneReport(doneUndo));

      await act(async () => {
        undoOf("Newsletters cleared")!.click();
      });
      expect(doneUndo).toHaveBeenCalledTimes(1);
      expect(blockUndo).not.toHaveBeenCalled();
      expect(pillOf("Newsletters cleared")).toBeNull();
      expect(pillOf("Blocked Lena Okafor")).not.toBeNull();
      expect(undoOf("Blocked Lena Okafor")?.textContent).toBe("Undo");
      expect(undoOf("Blocked Lena Okafor")?.disabled).toBe(false);
    });

    it("keeps one pill's open action off the other", async () => {
      let settle: () => void = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const doneUndo = vi.fn();
      await say("Blocked Lena Okafor", blockReport(() => settled));
      await say("Newsletters cleared", doneReport(doneUndo));
      await act(async () => {
        undoOf("Blocked Lena Okafor")!.click();
      });
      expect(undoOf("Blocked Lena Okafor")?.textContent).toBe("Undoing…");
      // The Done beside it is still reachable while the Block's request is out.
      expect(undoOf("Newsletters cleared")?.disabled).toBe(false);
      await act(async () => {
        undoOf("Newsletters cleared")!.click();
      });
      expect(doneUndo).toHaveBeenCalledTimes(1);
      await act(async () => {
        settle();
        await settled;
      });
      expect(pills()).toEqual([]);
    });

    it("⌘Z undoes the newest one, then the one under it", async () => {
      const blockUndo = vi.fn(() => true as const);
      const doneUndo = vi.fn(() => true as const);
      await say("Blocked Lena Okafor", {
        ...blockReport(() => Promise.resolve()),
        onAction: blockUndo,
      });
      await say("Newsletters cleared", doneReport(doneUndo));

      const commandZ = () =>
        act(async () => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }));
        });
      await commandZ();
      expect(doneUndo).toHaveBeenCalledTimes(1);
      expect(blockUndo).not.toHaveBeenCalled();
      expect(pillOf("Blocked Lena Okafor")).not.toBeNull();
      await commandZ();
      expect(blockUndo).toHaveBeenCalledTimes(1);
      expect(pills()).toEqual([]);
    });

    it("commits Done at the end of ITS window, not the Block's", async () => {
      const blockExpired = vi.fn();
      const doneExpired = vi.fn();
      await say("Blocked Lena Okafor", {
        ...blockReport(() => Promise.resolve()),
        onExpire: blockExpired,
      });
      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      await say("Newsletters cleared", doneReport(() => {}, doneExpired));

      // The Block's window closes first, and only the Block's.
      await act(async () => {
        vi.advanceTimersByTime(SMART_UNDO_MS - 3_000);
      });
      expect(blockExpired).toHaveBeenCalledTimes(1);
      expect(doneExpired).not.toHaveBeenCalled();
      expect(pills()).toHaveLength(1);
      expect(pills()[0]).toContain("Newsletters cleared");

      // Done's own nine seconds, counted from its press.
      await act(async () => {
        vi.advanceTimersByTime(2_999);
      });
      expect(doneExpired).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(2);
      });
      expect(doneExpired).toHaveBeenCalledTimes(1);
      expect(pills()).toEqual([]);
    });

    it("commits the oldest when a fourth undo arrives", async () => {
      const expired = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
      for (const [index, onExpire] of expired.entries()) {
        await say(`Undo ${index + 1}`, {
          icon: "check-linear",
          actionLabel: "Undo",
          onAction: () => {},
          onExpire,
          durationMs: SMART_UNDO_MS,
          id: `undo-${index + 1}`,
        });
      }
      expect(pills()).toHaveLength(3);
      expect(pillOf("Undo 1")).toBeNull();
      expect(expired[0]).toHaveBeenCalledTimes(1);
      expect(expired.slice(1).every((each) => each.mock.calls.length === 0)).toBe(true);
      expect(pills()[0]).toContain("Undo 4");
    });

    it("a report still waits until the last undo has gone", async () => {
      await say("Blocked Lena Okafor", blockReport(() => Promise.resolve()));
      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      await say("Newsletters cleared", doneReport(() => {}));
      await say("People partly cleared", { durationMs: 5_000 });
      expect(pillOf("People partly cleared")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(SMART_UNDO_MS - 3_000);
      });
      // One undo is still up: the report keeps waiting.
      expect(pillOf("People partly cleared")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      expect(pills()).toHaveLength(1);
      expect(pills()[0]).toContain("People partly cleared");
    });
  });

  it("a pill with no window stands, and takes a ring only when it is said again with one", async () => {
    // A sentence said at the gesture, before the server has answered, the
    // way a task's completion is: there is no deadline to name yet, so it
    // names none, and the icon slot stays a plain glyph. The ring draws
    // deadlines and there is nothing here for it to draw.
    await say("Completed", {
      id: "task-complete-1",
      icon: "check-linear",
      durationMs: null,
    });
    expect(document.body.querySelector(".brain-toast [data-toast-ring]")).toBeNull();

    // Long past any window a guess would have armed. Still standing.
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(pills().join(" | ")).toContain("Completed");

    // The answer lands and the same sentence is said again under the same
    // id, with its Undo. NOW there is a deadline: the ring appears, and the
    // pill goes when it is spent.
    await say("Completed", {
      id: "task-complete-1",
      icon: "check-linear",
      actionLabel: "Undo",
      onAction: () => {},
      durationMs: SMART_UNDO_MS,
    });
    expect(document.body.querySelector(".brain-toast [data-toast-ring]")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(SMART_UNDO_MS + 1);
    });
    expect(pills().join(" | ")).not.toContain("Completed");
  });

  it("speaks a refusal WHILE an undo is standing, without taking its pill", async () => {
    await say(
      "Newsletters cleared",
      doneReport(() => {}),
    );
    await say(REFUSAL, { urgent: true });

    // Both, at once: the undo keeps the pill it was given and the refusal
    // gets one of its own. Queued, this sentence would have surfaced nine
    // seconds later, detached from the press and by then untrue.
    const spoken = pills().join(" | ");
    expect(spoken).toContain("Newsletters cleared");
    expect(spoken).toContain("Undo");
    expect(alertPill()).toContain(REFUSAL);
  });

  it("the REPORT of an earlier Done waits behind a standing Undo, and then stands its five seconds", async () => {
    // Newsletters is inside its window when People's run, already sending,
    // lands short. The report wears no id, so it cannot take the pill and
    // the way back with it: it waits its turn.
    await say(
      "Newsletters cleared",
      doneReport(() => {}),
    );
    await say("People partly cleared", {
      icon: "check-linear",
      subtitle: "2 archived, 1 stayed put",
      durationMs: 5_000,
    });
    expect(pills().join(" | ")).not.toContain("People partly cleared");
    expect(pills().join(" | ")).toContain("Newsletters cleared");

    await act(async () => {
      vi.advanceTimersByTime(SMART_UNDO_MS);
    });
    expect(pills().join(" | ")).toContain("People partly cleared");
    expect(pills().join(" | ")).toContain("2 archived, 1 stayed put");
    expect(document.body.querySelector(".brain-toast button")).toBeNull();
    // Nothing to reach for, so no ring: the five seconds are for reading.
    expect(document.body.querySelector(".brain-toast [data-toast-ring]")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(4_999);
    });
    expect(pills().join(" | ")).toContain("People partly cleared");
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(pills().join(" | ")).not.toContain("People partly cleared");
  });

  it("takes the refusal down on its own, leaving the undo standing", async () => {
    await say(
      "Newsletters cleared",
      doneReport(() => {}),
    );
    await say(REFUSAL, { urgent: true });
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
    // and put eight cleared threads back in the column with it.
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
    // Undo of a Block: the rows come back at the press and the request that
    // takes the decision off the service follows. The surface answers with
    // that request's promise, and the pill has to stand until it settles —
    // taken down at once, a second press or ⌘Z could start the same reversal
    // twice while the first was still out. (A section's Done answers at
    // once: its Undo has no request to wait for.)
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const undo = vi.fn(() => settled);
    await say("Blocked Lena Okafor", blockReport(undo));
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
    expect(pills().join(" | ")).toContain("Blocked Lena Okafor");
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
    expect(pills().join(" | ")).not.toContain("Blocked Lena Okafor");
  });

  it("a same-id message arriving under an open action takes the pill, and outlives the action", async () => {
    // A caller may say its sentence again under the same id while its own
    // action is still open: a pill that says the reversal is under way, with
    // no window and no way back of its own. It replaces the pill whose
    // action is open, and when that action's promise settles the shell must
    // not take it down — it is not the pill the press spent, and its own
    // report will replace it. No mail sentence does this today (Done's Undo
    // did, while it had requests of its own to wait for); the shell keeps
    // the promise for whoever does next.
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    await say(
      "Blocked Lena Okafor",
      blockReport(() => settled),
    );
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(".brain-toast button")!.click();
    });
    expect(pills().join(" | ")).toContain("Undoing…");

    await say("Taking the block off…", {
      icon: "inbox-linear",
      subtitle: "2 letters on the way back",
      durationMs: null,
      id: "mail-sender:1",
    });
    expect(pills().join(" | ")).toContain("Taking the block off…");
    expect(pills().join(" | ")).not.toContain("Blocked Lena Okafor");
    expect(document.body.querySelector(".brain-toast button")).toBeNull();
    expect(document.body.querySelector(".brain-toast [data-toast-ring]")).toBeNull();

    await act(async () => {
      settle();
      await settled;
    });
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(pills().join(" | ")).toContain("Taking the block off…");

    await say("Back in your inbox", {
      icon: "inbox-linear",
      subtitle: "2 letters restored",
      id: "mail-sender:1",
    });
    expect(pills().join(" | ")).toContain("Back in your inbox");
    expect(pills().join(" | ")).not.toContain("Taking the block off…");
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

  // THE PILL LEAVING UNSPENT IS AN EVENT THE CALLER CAN WAIT ON. Discard on
  // the compose sheet parks the provider delete behind its Undo; the delete
  // has to go out when the way back is gone, and only then. The shell owns
  // the window (hover holds it), so the shell says when it closed.
  describe("onExpire", () => {
    const discardReport = (
      onExpire: () => void,
      onAction: () => boolean | void | Promise<unknown> = () => {},
    ): ToastOptions => ({
      icon: "trash-bin-trash-linear",
      actionLabel: "Undo",
      onAction,
      onExpire,
      durationMs: 9_000,
      id: "mail-draft-discard",
    });

    it("fires once when the window runs out", async () => {
      const onExpire = vi.fn();
      await say("Draft discarded", discardReport(onExpire));
      await act(async () => {
        vi.advanceTimersByTime(8_999);
      });
      expect(onExpire).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(2);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(pills().join(" | ")).not.toContain("Draft discarded");
    });

    it("never fires when the action spent the pill", async () => {
      const onExpire = vi.fn();
      const undo = vi.fn();
      await say("Draft discarded", discardReport(onExpire, undo));
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>(".brain-toast button")!.click();
      });
      expect(undo).toHaveBeenCalledTimes(1);
      expect(pills().join(" | ")).not.toContain("Draft discarded");
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      expect(onExpire).not.toHaveBeenCalled();
    });

    it("fires when a message wearing the same id takes the pill", async () => {
      const onExpire = vi.fn();
      await say("Draft discarded", discardReport(onExpire));
      await say("Draft discarded", { id: "mail-draft-discard" });
      expect(onExpire).toHaveBeenCalledTimes(1);
      // The replacement has no window of its own to hand on: nothing fires
      // twice when it leaves.
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
    });

    it("never fires for a pill its own action replaces from inside the press", async () => {
      // The discard's Undo, pressed after the account left: the action runs
      // the flush itself and says the pill again under the same id, without
      // an Undo, before it returns. That replacement is the press spending
      // the pill, not the window closing on it: `onExpire` would flush a
      // second time over the flush the action just ran.
      const onExpire = vi.fn();
      const respeak = () => {
        if (!mailToast) throw new Error("the mail surface never got onToast");
        mailToast("Draft discarded", { id: "mail-draft-discard" });
        return false;
      };
      await say("Draft discarded", discardReport(onExpire, respeak));
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>(".brain-toast button")!.click();
      });
      expect(onExpire).not.toHaveBeenCalled();
      expect(pills().join(" | ")).toContain("Draft discarded");
      expect(document.body.querySelector(".brain-toast button")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      expect(onExpire).not.toHaveBeenCalled();
    });

    it("still fires when the window runs out after a refused press", async () => {
      // The press spends the pill before the action runs. A refusal (the
      // mail lock is held elsewhere) hands that back, so the pill goes on
      // standing with its window and still owes `onExpire` when the window
      // closes. Kept spent, the parked delete would never go out.
      const onExpire = vi.fn();
      const refuse = vi.fn(() => false as const);
      await say("Draft discarded", discardReport(onExpire, refuse));
      await act(async () => {
        vi.advanceTimersByTime(4_000);
      });
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>(".brain-toast button")!.click();
      });
      expect(refuse).toHaveBeenCalledTimes(1);
      expect(pills().join(" | ")).toContain("Undo");
      expect(onExpire).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(5_001);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(pills().join(" | ")).not.toContain("Draft discarded");
    });

    it("still fires when the window runs out while the action is pending", async () => {
      // A pending action hands the spend back until it settles. The window
      // that runs out meanwhile takes the pill unspent and says so, and the
      // late settle takes nothing down and owes nothing a second time.
      const onExpire = vi.fn();
      let settle: () => void = () => {};
      const undo = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      );
      await say("Draft discarded", discardReport(onExpire, undo));
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>(".brain-toast button")!.click();
      });
      expect(undo).toHaveBeenCalledTimes(1);
      expect(pills().join(" | ")).toContain("Draft discarded");
      expect(onExpire).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(9_001);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(pills().join(" | ")).not.toContain("Draft discarded");
      await act(async () => {
        settle();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
    });
  });
});
