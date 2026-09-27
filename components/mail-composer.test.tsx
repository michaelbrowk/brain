// @vitest-environment jsdom

// THE COMPOSE SHEET, ON ITS OWN. `mail-surface.test.tsx` drives the composer
// through DraftSync and the send flow; what is pinned here is the sheet as a
// surface: where it renders, what it is called, where the caret lands, that
// nothing on it wears a ring, and that the two things a writer is told while
// writing (a failed save, a refused send) arrive in the slot on the actions
// row rather than somewhere else on the window.

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionProps } from "@/test/framer-motion-mock";

const harness: {
  reduce: boolean;
  renders: Array<{ tag: string; className: string; motion: MotionProps }>;
  /** The `onExitComplete` of a presence whose children just left, held
   *  until the test lets the exit finish. */
  pendingExit: (() => void) | null;
} = { reduce: false, renders: [], pendingExit: null };

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  const React = await import("react");
  /** The passthrough presence, plus the one thing the slot relies on: the
   *  exit callback, fired by the test rather than by a clock, so the moment
   *  between a sentence leaving and its box collapsing can be looked at. */
  function StubPresence({
    children,
    onExitComplete,
  }: {
    children?: React.ReactNode;
    onExitComplete?: () => void;
  }) {
    const count = React.Children.toArray(children).length;
    const had = React.useRef(count > 0);
    React.useEffect(() => {
      if (had.current && count === 0 && onExitComplete) harness.pendingExit = onExitComplete;
      had.current = count > 0;
    }, [count, onExitComplete]);
    return React.createElement(React.Fragment, null, children);
  }
  return createFramerMotionMock({
    reducedMotion: () => harness.reduce,
    onRender: ({ tag, motion, props }) => {
      harness.renders.push({ tag, className: String(props.className ?? ""), motion });
    },
    AnimatePresence: StubPresence,
  });
});

import { MailComposer, type MailComposerDraft } from "./mail-composer";
import type { PublicMailAccount } from "./mail-surface-client";
import { DUR, EASE_OUT, SHEET_ENTER_Y, SPIN, SPRING_SELECT, SPRING_SHEET } from "@/lib/motion";

const css = readFileSync(path.join(path.resolve(__dirname, ".."), "app/globals.css"), "utf8");

/** Everything `globals.css` declares in flat top-level rules ending on this
 *  selector (`selector { ... }`), joined: the sheet's class also stands last
 *  in the shared list that flips the v2 ink names on portaled surfaces. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...css.matchAll(new RegExp(`^${escaped} \\{([^}]*)\\}`, "gm"))].map(
    (match) => match[1],
  );
  if (blocks.length === 0) throw new Error(`no ${selector} rule in app/globals.css`);
  return blocks.join("\n");
}

/** The compose block's own `@media (min-width: 768px)` step, whole. */
function composeMd(): string {
  const start = css.indexOf(".brain-compose-form {");
  const media = css.indexOf("@media (min-width: 768px) {", start);
  if (start === -1 || media === -1) throw new Error("no compose md block in app/globals.css");
  let depth = 0;
  let end = media;
  for (let i = media; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return css.slice(media, end);
}

/** One rule inside the compose block's md step. */
function mdRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = composeMd().match(new RegExp(`${escaped} \\{([^}]*)\\}`));
  if (!match) throw new Error(`no ${selector} rule in the compose md step`);
  return match[1];
}

const account: PublicMailAccount = {
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

function draft(overrides: Partial<MailComposerDraft> = {}): MailComposerDraft {
  return {
    idempotencyKey: "idem-1",
    mode: "compose",
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    text: "",
    replyToMessageId: null,
    notice: null,
    ...overrides,
  };
}

type Props = Parameters<typeof MailComposer>[0];

function props(overrides: Partial<Props> = {}): Props {
  return {
    account,
    initialDraft: draft(),
    sending: false,
    sendError: null,
    sendBlocked: false,
    onCancel: vi.fn(),
    onDiscard: vi.fn(),
    onDraftChange: vi.fn(),
    onRetrySave: vi.fn(),
    onSend: vi.fn(),
    ...overrides,
  };
}

function stubViewport(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone ? query === "(max-width: 767px)" : query === "(min-width: 768px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const byLabel = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
const byText = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  );
/** Send: its text holds a hidden "Sending" beside the live word, so it is
 *  found by what it is, the form's one submit. */
const sendButton = () => document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!;

describe("the compose sheet", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    harness.reduce = false;
    harness.renders = [];
    stubViewport(false);
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  /** A fresh mount every time: the sheet places its caret and takes its
   *  shape on mount, the way it does in the app, where each composer is a
   *  new element keyed by its draft. */
  async function render(overrides: Partial<Props> = {}) {
    await act(async () => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const p = props(overrides);
    await act(async () => root.render(<MailComposer {...p} />));
    await settle();
    return p;
  }

  it("renders as a modal dialog in a portal at the body, named by its mode", async () => {
    for (const [mode, name] of [
      ["compose", "New message"],
      ["reply", "Reply"],
      ["replyAll", "Reply all"],
      ["forward", "Forward"],
    ] as const) {
      await render({ initialDraft: draft({ mode }) });
      const sheet = dialog();
      expect(sheet, mode).not.toBeNull();
      expect(sheet?.getAttribute("aria-label")).toBe(name);
      expect(sheet?.getAttribute("aria-modal")).toBe("true");
      // A portal: the sheet stands at the body, not inside the pane that
      // rendered it, so the shell's `inert` never reaches it.
      expect(host.contains(sheet)).toBe(false);
      expect(sheet?.parentElement).toBe(document.body);
      // The mode is the dialog's name and nothing else: no title row. The
      // one heading is Radix's own, for screen readers, off the page.
      expect(
        [...(sheet?.querySelectorAll("h1, h2") ?? [])].every((heading) =>
          heading.classList.contains("sr-only"),
        ),
      ).toBe(true);
    }
  });

  it("puts the caret in To for a new message and in the body for a reply", async () => {
    await render();
    const to = document.body.querySelector('input[autocomplete="email"]');
    expect(document.activeElement).toBe(to);

    await render({
      initialDraft: draft({ mode: "reply", to: "ben@example.test", subject: "Re: Lunch" }),
    });
    expect(document.activeElement).toBe(document.body.querySelector("textarea"));
  });

  it("writes on paper without rings: no field atom, no box-shadow on a row or the body", async () => {
    await render();
    const sheet = dialog()!;
    expect(sheet.querySelector(".field, .field-glass")).toBeNull();
    expect(sheet.querySelectorAll(".brain-compose-row").length).toBeGreaterThanOrEqual(3);
    expect(sheet.querySelector(".brain-compose-body")).not.toBeNull();
    expect(sheet.querySelectorAll(".brain-compose-fold")).toHaveLength(1);
    for (const selector of [".brain-compose-paper", ".brain-compose-row", ".brain-compose-body"]) {
      const block = rule(selector);
      expect(block, selector).not.toContain("box-shadow");
      expect(block, selector).not.toContain("backdrop-filter");
    }
    expect(rule(".brain-compose-paper")).toContain("background: var(--paper)");
    // The document is one column of 700, the editor's width.
    expect(rule(".brain-compose-column")).toContain("max-width: 700px");
    // Send is the surface's one ink fill.
    expect(sheet.querySelectorAll(".btn-ink")).toHaveLength(1);
  });

  it("stays silent while it saves and speaks only when a save fails", async () => {
    for (const status of ["idle", "saving", "saved"] as const) {
      await render({ saveStatus: status });
      expect(document.body.textContent).not.toContain("Saving");
      expect(document.body.textContent).not.toContain("Saved");
      expect(dialog()?.querySelector(".brain-compose-slot")?.textContent?.trim()).toBe("");
    }
    const p = await render({ saveStatus: "error" });
    const slot = dialog()!.querySelector(".brain-compose-slot")!;
    expect(slot.textContent).toContain("Not saved");
    expect(slot.querySelector('[role="alert"]')).toBeNull();
    const retry = byText("Retry");
    expect(slot.contains(retry ?? null)).toBe(true);
    await act(async () => retry?.click());
    expect(p.onRetrySave).toHaveBeenCalledTimes(1);
  });

  it("puts a refused send in the slot, as an alert, and never in a toast", async () => {
    const p = await render({
      sendError: "This account needs to be reconnected in Settings.",
      sendErrorSettings: true,
      onOpenSettings: vi.fn(),
    });
    const slot = dialog()!.querySelector(".brain-compose-slot")!;
    const alert = slot.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("This account needs to be reconnected in Settings.");
    const settings = byText("Mail settings");
    expect(slot.contains(settings ?? null)).toBe(true);
    await act(async () => settings?.click());
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".brain-toast")).toBeNull();
  });

  it("colours the To label through aria-invalid when the recipients are refused", async () => {
    const p = await render({ initialDraft: draft({ to: "not an address" }) });
    await act(async () => sendButton().click());
    await settle();
    const to = document.body.querySelector('input[autocomplete="email"]');
    expect(to?.getAttribute("aria-invalid")).toBe("true");
    const alert = dialog()!.querySelector('.brain-compose-slot [role="alert"]');
    expect(alert?.textContent).toContain("is not an email address");
    expect(p.onSend).not.toHaveBeenCalled();
    expect(document.body.querySelector(".brain-toast")).toBeNull();
    // The label reads its colour off the input's state, in the stylesheet.
    expect(css).toMatch(/\.brain-compose-row:has\(> \[aria-invalid="true"\]\) > \.brain-compose-label \{[^}]*color: var\(--red\)/);
  });

  it("keeps its shape while sending: aria-busy, the same text nodes, read-only fields, Esc inert", async () => {
    const p = await render({ initialDraft: draft({ to: "ben@example.test", text: "Hi" }) });
    const send = sendButton();
    const textNodes = (node: Element) =>
      [...node.querySelectorAll("*")].flatMap((el) =>
        [...el.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE),
      ).length;
    const before = textNodes(send);
    expect(send.getAttribute("aria-busy")).toBeNull();

    await render({
      initialDraft: draft({ to: "ben@example.test", text: "Hi" }),
      sending: true,
      onCancel: p.onCancel,
    });
    const busy = sendButton();
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.textContent).toContain("Sending");
    expect(textNodes(busy)).toBe(before);
    for (const field of dialog()!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    )) {
      expect(field.readOnly).toBe(true);
    }
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(p.onCancel).not.toHaveBeenCalled();
    await act(async () => byLabel("Close draft")?.click());
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  it("closes on Escape and on the cross when it is not sending", async () => {
    const p = await render();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    await act(async () => byLabel("Close draft")?.click());
    expect(p.onCancel).toHaveBeenCalledTimes(2);
  });

  it("takes the sheet down from the trash without a question, and not while sending", async () => {
    // Discard used to ask through a ConfirmDialog. The way back is the
    // surface's undo pill now, so the press is answered at once and the sheet
    // owns no second dialog.
    const p = await render({ initialDraft: draft({ subject: "Half a thought", text: "Hi" }) });
    await act(async () => byLabel("Discard draft")?.click());
    await settle();
    expect(p.onDiscard).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Discard this draft?");

    const busy = await render({ initialDraft: draft({ text: "Hi" }), sending: true });
    await act(async () => byLabel("Discard draft")?.click());
    expect(busy.onDiscard).not.toHaveBeenCalled();
  });

  // THE FROM SWITCH. With two accounts that can send, the From value is a
  // quiet menu button; with one, or on a reply or forward, it is text.
  describe("the From switch", () => {
    const second: PublicMailAccount = {
      ...account,
      accountId: `account-a${"b".repeat(32)}`,
      emailAddress: "second@example.test",
      displayName: null,
    };
    /** Every From button on the sheet: the envelope row's and the phone's
     *  copy in the actions row, one of which CSS hides at any width. */
    const fromButtons = () =>
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
        button.getAttribute("aria-label")?.startsWith("From:"),
      );
    const openFrom = async () => {
      const trigger = document.body.querySelector<HTMLButtonElement>(
        '.brain-compose-from button[aria-label^="From:"]',
      );
      if (!trigger) throw new Error("no From button in the envelope row");
      await act(async () => {
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      await settle();
    };

    it("is a quiet menu button only in compose mode with two sendable accounts", async () => {
      await render({ accounts: [account, second], onSwitchAccount: vi.fn() });
      const buttons = fromButtons();
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.getAttribute("aria-haspopup")).toBe("menu");
        expect(button.getAttribute("aria-label")).toBe("From: Personal");
        expect(button.textContent).toContain("Personal");
        // The chevron, and no glass: the value reads as text with a mark.
        expect(button.querySelector("svg")).not.toBeNull();
        expect(button.className).not.toContain("btn-glass");
      }
      expect(dialog()!.querySelector(".brain-compose-from .brain-compose-value")).not.toBeNull();

      // One account: text.
      await render({ accounts: [account], onSwitchAccount: vi.fn() });
      expect(fromButtons()).toHaveLength(0);
      expect(dialog()!.querySelector(".brain-compose-from .brain-compose-value")?.textContent).toBe(
        "Personal",
      );

      // A reply: text, whatever the accounts.
      await render({
        accounts: [account, second],
        onSwitchAccount: vi.fn(),
        initialDraft: draft({ mode: "reply", to: "ben@example.test" }),
      });
      expect(fromButtons()).toHaveLength(0);

      // No one to hand the switch to: text.
      await render({ accounts: [account, second] });
      expect(fromButtons()).toHaveLength(0);
    });

    it("lists each account with its address, marks the current one, and hands the fields over on a switch", async () => {
      const onSwitchAccount = vi.fn();
      await render({
        accounts: [account, second],
        onSwitchAccount,
        initialDraft: draft({ to: "ben@example.test", subject: "Thursday", text: "Hi" }),
      });
      await openFrom();
      const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      expect(items.map((item) => item.textContent)).toEqual([
        "Personalperson@example.test",
        "second@example.test",
      ]);
      expect(items[0]?.getAttribute("data-state")).toBe("checked");
      expect(items[0]?.querySelector("svg")).not.toBeNull();
      expect(items[1]?.getAttribute("data-state")).toBe("unchecked");
      expect(items[1]?.querySelector("svg")).toBeNull();

      await act(async () => items[1]?.click());
      await settle();
      expect(onSwitchAccount).toHaveBeenCalledTimes(1);
      expect(onSwitchAccount).toHaveBeenCalledWith(second.accountId, {
        to: "ben@example.test",
        cc: "",
        bcc: "",
        subject: "Thursday",
        text: "Hi",
      });
    });

    it("choosing the account already in From changes nothing", async () => {
      const onSwitchAccount = vi.fn();
      await render({ accounts: [account, second], onSwitchAccount });
      await openFrom();
      const current = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')][0];
      await act(async () => current?.click());
      await settle();
      expect(onSwitchAccount).not.toHaveBeenCalled();
    });
  });

  it("reveals Cc and Bcc from the quiet text at To's end and puts the caret in Cc", async () => {
    await render();
    const sheet = dialog()!;
    expect(sheet.querySelector('input[aria-label="Cc"], #cc')).toBeNull();
    const reveal = byText("Cc Bcc");
    expect(reveal?.className).toContain("brain-compose-copies");
    await act(async () => reveal?.click());
    await settle();
    const cc = [...sheet.querySelectorAll("label")].find((l) => l.textContent === "Cc");
    expect(cc).toBeDefined();
    const ccInput = sheet.querySelector<HTMLInputElement>(`#${cc!.htmlFor}`);
    expect(ccInput).not.toBeNull();
    expect(document.activeElement).toBe(ccInput);
    expect(byText("Cc Bcc")).toBeUndefined();

    // A resumed draft that already carries a copy shows the rows, no button.
    await render({ initialDraft: draft({ cc: "casey@example.test" }) });
    expect(byText("Cc Bcc")).toBeUndefined();
    expect(
      [...dialog()!.querySelectorAll("label")].some((l) => l.textContent === "Bcc"),
    ).toBe(true);
  });

  it("starts the subject, the body and the notice at the document's left edge, under the labels", () => {
    // A selector with no flat rule of its own declares nothing, which is the
    // point: nothing indents these off the column's edge.
    const declared = (selector: string) => {
      try {
        return rule(selector);
      } catch {
        return "";
      }
    };
    for (const selector of [".brain-compose-subject", ".brain-compose-body", ".brain-compose-notice"]) {
      expect(declared(selector), selector).not.toContain("padding-left");
      expect(declared(selector), selector).not.toMatch(/padding: [^;]*calc\(var\(--compose-gutter\)/);
    }
  });

  it("keeps the window's inset above the actions row, like every strip of chrome", () => {
    expect(rule(".brain-compose-actions")).toContain("margin-top: var(--inset)");
  });

  it("draws Send as a 28 capsule on the desktop, with the glyph only while sending", async () => {
    expect(mdRule(".brain-compose-send")).toContain("height: 28px");
    expect(rule(".brain-compose-send-label")).toContain("justify-items: center");

    await render({ initialDraft: draft({ to: "ben@example.test" }) });
    const rest = sendButton();
    expect(rest.querySelector(".brain-compose-send-glyph")).toBeNull();
    expect(rest.querySelector(".brain-compose-send-word")?.textContent).toBe("Send");
    // The hidden cell holds the widest state, glyph and word, so the capsule
    // is the same size before and after the press.
    const ghost = rest.querySelector(".brain-compose-send-ghost");
    expect(ghost?.querySelector("svg")).not.toBeNull();
    expect(ghost?.textContent).toBe("Sending");

    await render({ initialDraft: draft({ to: "ben@example.test" }), sending: true });
    const busy = sendButton();
    expect(busy.querySelector(".brain-compose-send-word .brain-compose-send-glyph svg")).not.toBeNull();
    expect(busy.querySelector(".brain-compose-send-word")?.textContent).toBe("Sending");
  });

  it("reads the cross, the trash and Cc Bcc as inert while a send is out", async () => {
    await render({ initialDraft: draft({ to: "ben@example.test" }), sending: true });
    const actions = dialog()!.querySelector(".brain-compose-actions")!;
    expect(actions.hasAttribute("data-sending")).toBe(true);
    expect(byLabel("Close draft")?.getAttribute("aria-disabled")).toBe("true");
    expect(byLabel("Discard draft")?.getAttribute("aria-disabled")).toBe("true");
    expect(byText("Cc Bcc")?.disabled).toBe(true);

    await render({ initialDraft: draft({ to: "ben@example.test" }) });
    expect(dialog()!.querySelector(".brain-compose-actions")!.hasAttribute("data-sending")).toBe(false);
    expect(byLabel("Close draft")?.getAttribute("aria-disabled")).toBeNull();
    expect(byLabel("Discard draft")?.getAttribute("aria-disabled")).toBeNull();
    expect(byText("Cc Bcc")?.disabled).toBe(false);
  });

  it("refuses a dropped file in the slot, as a status, and clears it when the writer types on", async () => {
    await render();
    const form = dialog()!.querySelector("form")!;
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"] } });
    await act(async () => {
      form.dispatchEvent(drop);
    });
    await settle();
    expect(drop.defaultPrevented).toBe(true);
    const slot = dialog()!.querySelector(".brain-compose-slot")!;
    expect(slot.querySelector('[role="status"]')?.textContent).toBe(
      "Attachments aren’t available yet.",
    );
    expect(slot.querySelector('[role="alert"]')).toBeNull();
    // No toast: the sheet is the whole window and the sentence belongs on it.
    expect(document.body.querySelector(".brain-toast")).toBeNull();

    const subject = dialog()!.querySelector<HTMLInputElement>('input[placeholder="Subject"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(subject, "Thursday, then");
      subject.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(dialog()!.querySelector('.brain-compose-slot [role="status"]')).toBeNull();
  });

  it("keeps 16px inputs on a touch screen at any width: the 14 at md is gated on a fine pointer", () => {
    expect(rule(".brain-compose-input")).toContain("font-size: 16px");
    // The plain md step no longer sizes the input: an iPad at 1024 is past md
    // and would zoom on a 14.
    expect(composeMd()).not.toMatch(/\.brain-compose-input \{[^}]*font-size: 14px/);
    expect(css).toMatch(
      /@media \(min-width: 768px\) and \(pointer: fine\) \{\s*\.brain-compose-input \{[^}]*font-size: 14px/,
    );
  });

  it("keeps the phone's bottom safe area under the letter", () => {
    expect(rule(".brain-compose-column")).toContain(
      "calc(24px + env(safe-area-inset-bottom, 0px))",
    );
    expect(mdRule(".brain-compose-column")).toContain(
      "calc(40px + env(safe-area-inset-bottom, 0px))",
    );
  });

  it("keeps the slot's box until a leaving sentence has finished leaving", async () => {
    harness.pendingExit = null;
    const p = await render({ sendError: "Message wasn’t sent. Try again." });
    const actions = () => dialog()!.querySelector(".brain-compose-actions")!;
    expect(actions().hasAttribute("data-message")).toBe(true);

    // The sentence is taken back; the box stays for the exit to play in.
    await act(async () => root.render(<MailComposer {...p} sendError={null} />));
    await settle();
    expect(dialog()!.querySelector(".brain-compose-slot-line")).toBeNull();
    expect(actions().hasAttribute("data-message")).toBe(true);
    expect(harness.pendingExit).not.toBeNull();

    // The exit completes; now the box goes.
    await act(async () => harness.pendingExit?.());
    await settle();
    expect(actions().hasAttribute("data-message")).toBe(false);
  });

  it("gives focus back to what opened it when it goes, or to the shell's fallback if that is inert", async () => {
    // Radix returns focus from a timeout after the unmount.
    const afterUnmount = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

    const opener = document.createElement("button");
    opener.textContent = "New message";
    document.body.appendChild(opener);
    opener.focus();
    await render();
    expect(document.activeElement).not.toBe(opener);
    await act(async () => root.unmount());
    await afterUnmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();

    // The opener is under an inert ancestor (a route change left the shell
    // inert): focus lands on the shell's own fallback instead.
    const fallback = document.createElement("main");
    fallback.tabIndex = -1;
    fallback.setAttribute("data-dialog-focus-fallback", "");
    document.body.appendChild(fallback);
    const inertShell = document.createElement("div");
    inertShell.setAttribute("inert", "");
    const inertOpener = document.createElement("button");
    inertShell.appendChild(inertOpener);
    document.body.appendChild(inertShell);
    inertOpener.focus();
    // `render` unmounts the previous root first; there is none standing.
    root = createRoot(host);
    await act(async () => root.render(<MailComposer {...props()} />));
    await settle();
    await act(async () => root.unmount());
    await afterUnmount();
    expect(document.activeElement).toBe(fallback);
    fallback.remove();
    inertShell.remove();
    root = createRoot(host);
  });

  it("says From once on the phone: the envelope's From row is hidden below 768 and stands from it", () => {
    expect(rule(".brain-compose-from")).toContain("display: none");
    expect(mdRule(".brain-compose-from")).toContain("display: flex");
  });

  it("on the phone puts From in the actions row as quiet text and gives the slot its place under an error", async () => {
    stubViewport(true);
    await render();
    const actions = dialog()!.querySelector(".brain-compose-actions")!;
    const from = actions.querySelector(".brain-compose-actions-from");
    expect(from?.textContent).toBe("Personal");
    expect(actions.hasAttribute("data-message")).toBe(false);
    expect(dialog()!.querySelectorAll(".btn-ink")).toHaveLength(1);

    await render({ sendError: "Message wasn’t sent. Try again." });
    const busy = dialog()!.querySelector(".brain-compose-actions")!;
    expect(busy.hasAttribute("data-message")).toBe(true);
  });

  // THE CHOREOGRAPHY, as the props the sheet hands framer. Every number is
  // `lib/motion.ts`'s; the distances (12, 8, 4) are the spec's and stand in
  // the component beside the reason for each.
  describe("its choreography", () => {
    /** The last render of a motion element wearing this class. */
    const motionOf = (className: string) =>
      [...harness.renders].reverse().find((render) =>
        render.className.split(" ").includes(className),
      )?.motion;

    it("enters on the desktop as a fade with a 12px rise over DUR.page and leaves by the way it was dismissed", async () => {
      await render();
      const paper = motionOf("brain-compose-paper");
      expect(paper?.initial).toEqual({ opacity: 0, y: 12 });
      expect(paper?.animate).toEqual({ opacity: 1, y: 0 });
      expect(paper?.transition).toEqual({ duration: DUR.page, ease: EASE_OUT });
      // Dismissed: down and out, fast, ease-in.
      expect(paper?.exit).toEqual({
        opacity: 0,
        y: 8,
        transition: { duration: DUR.fast, ease: "easeIn" },
      });

      // Committed (the sheet leaves because the send landed): it lets go
      // outward, on the page duration, the way a dialog commits.
      await render({ initialDraft: draft({ to: "ben@example.test" }), sending: true });
      expect(motionOf("brain-compose-paper")?.exit).toEqual({
        opacity: 0,
        scale: 1.02,
        transition: { duration: DUR.page, ease: EASE_OUT },
      });
    });

    it("enters on the phone from 48px below on the sheet spring, and leaves the same way", async () => {
      stubViewport(true);
      await render();
      const paper = motionOf("brain-compose-paper");
      expect(paper?.initial).toEqual({ opacity: 0, y: SHEET_ENTER_Y });
      expect(paper?.animate).toEqual({ opacity: 1, y: 0 });
      expect(paper?.transition).toEqual(SPRING_SHEET);
      expect(paper?.exit).toEqual({
        opacity: 0,
        y: SHEET_ENTER_Y,
        transition: { duration: DUR.fast, ease: "easeIn" },
      });
    });

    it("staggers From, To, Subject, then the fold and the body together, landing at 300ms", async () => {
      await render();
      const rows = harness.renders.filter((render) =>
        render.className.split(" ").includes("brain-compose-row"),
      );
      const delays = rows.map(
        (render) => (render.motion.transition as { delay: number }).delay,
      );
      expect(delays).toEqual([0.05, 0.08, 0.11]);
      for (const row of rows) {
        expect(row.motion.initial).toEqual({ opacity: 0, y: 4 });
        expect(row.motion.animate).toEqual({ opacity: 1, y: 0 });
        expect(row.motion.transition).toMatchObject({ duration: DUR.base, ease: EASE_OUT });
      }
      for (const className of ["brain-compose-fold", "brain-compose-body"]) {
        const part = motionOf(className);
        expect(part?.initial, className).toEqual({ opacity: 0, y: 4 });
        expect(part?.transition, className).toEqual({
          duration: DUR.base,
          ease: EASE_OUT,
          delay: 0.14,
        });
      }
    });

    it("grows Cc and Bcc on the select spring from a press, and not for a draft that already carries a copy", async () => {
      await render();
      await act(async () => byText("Cc Bcc")?.click());
      await settle();
      const rows = motionOf("brain-compose-copies-rows");
      expect(rows?.initial).toEqual({ height: 0, opacity: 0 });
      expect(rows?.animate).toEqual({ height: "auto", opacity: 1 });
      expect(rows?.transition).toEqual(SPRING_SELECT);

      // A resumed copy does not grow: it stands, and arrives with the rest.
      await render({ initialDraft: draft({ cc: "casey@example.test" }) });
      expect(motionOf("brain-compose-copies-rows")?.initial).toEqual({ opacity: 0, y: 4 });
    });

    it("lets a resumed Cc/Bcc and the notice join the stagger at 95ms, between To and Subject", async () => {
      await render({
        initialDraft: draft({
          mode: "forward",
          cc: "casey@example.test",
          notice: "Attachments from the original message are not included.",
        }),
      });
      for (const className of ["brain-compose-copies-rows", "brain-compose-notice"]) {
        const part = motionOf(className);
        expect(part?.initial, className).toEqual({ opacity: 0, y: 4 });
        expect(part?.animate, className).toEqual({ opacity: 1, y: 0 });
        expect(part?.transition, className).toEqual({
          duration: DUR.base,
          ease: EASE_OUT,
          delay: 0.095,
        });
      }
      // The rows around them keep their steps.
      const rows = harness.renders.filter((render) =>
        render.className.split(" ").includes("brain-compose-row"),
      );
      expect(rows.map((render) => (render.motion.transition as { delay: number }).delay)).toEqual([
        0.05, 0.08, 0.11,
      ]);
      expect((motionOf("brain-compose-body")?.transition as { delay: number }).delay).toBe(0.14);

      harness.reduce = true;
      await render({ initialDraft: draft({ cc: "casey@example.test", notice: "Kept." }) });
      expect(motionOf("brain-compose-copies-rows")?.initial).toBe(false);
      expect(motionOf("brain-compose-notice")?.initial).toBe(false);
    });

    it("swaps Send for Sending through a 2px blur and turns the glyph on SPIN, in place", async () => {
      await render({ initialDraft: draft({ to: "ben@example.test" }) });
      // The label does not blur in with the sheet: only the swap does.
      expect(motionOf("brain-compose-send-word")?.initial).toBe(false);
      expect(motionOf("brain-compose-send-glyph")?.animate).toBeUndefined();

      await render({ initialDraft: draft({ to: "ben@example.test" }), sending: true });
      const glyph = motionOf("brain-compose-send-glyph");
      expect(glyph?.animate).toEqual({ rotate: 360 });
      expect(glyph?.transition).toEqual(SPIN);
      const word = motionOf("brain-compose-send-word");
      expect(word?.animate).toEqual({ opacity: 1, filter: "blur(0px)" });
      expect(word?.transition).toEqual({ duration: DUR.base, ease: EASE_OUT });
    });

    it("brings a sentence into the slot from 4px above over DUR.base", async () => {
      await render({ sendError: "Message wasn’t sent. Try again." });
      const line = motionOf("brain-compose-slot-line");
      expect(line?.initial).toEqual({ opacity: 0, y: -4 });
      expect(line?.animate).toEqual({ opacity: 1, y: 0 });
      expect(line?.transition).toEqual({ duration: DUR.base, ease: EASE_OUT });
    });

    it("under reduced motion crossfades over DUR.fast and moves, staggers and blurs nothing", async () => {
      harness.reduce = true;
      stubViewport(true);
      await render({ sendError: "Message wasn’t sent. Try again.", sending: true });
      const paper = motionOf("brain-compose-paper");
      expect(paper?.initial).toEqual({ opacity: 0 });
      expect(paper?.animate).toEqual({ opacity: 1 });
      expect(paper?.transition).toEqual({ duration: DUR.fast });
      expect(paper?.exit).toEqual({ opacity: 0, transition: { duration: DUR.fast } });
      for (const className of ["brain-compose-row", "brain-compose-fold", "brain-compose-body"]) {
        expect(motionOf(className)?.initial, className).toBe(false);
      }
      expect(motionOf("brain-compose-slot-line")?.initial).toEqual({ opacity: 0 });
      // The spinner stands still; the word "Sending" is what says the work
      // is happening.
      expect(motionOf("brain-compose-send-glyph")?.animate).toBeUndefined();
      expect(motionOf("brain-compose-send-word")?.initial).toBe(false);
      expect(sendButton().textContent).toContain("Sending");
    });
  });
});
