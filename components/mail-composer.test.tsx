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
} = { reduce: false, renders: [] };

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => harness.reduce,
    onRender: ({ tag, motion, props }) => {
      harness.renders.push({ tag, className: String(props.className ?? ""), motion });
    },
  });
});

import { MailComposer, type MailComposerDraft } from "./mail-composer";
import type { PublicMailAccount } from "./mail-surface-client";

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
    onToast: vi.fn(),
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
    expect(p.onToast).not.toHaveBeenCalled();
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
    expect(p.onToast).not.toHaveBeenCalled();
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
});
