// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailSenderSettings } from "./mail-sender-settings";
import { MailApiError } from "./mail-surface-client";

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({ reducedMotion: false });
});

const DECISION_ID = `decision-a${"0".repeat(30)}ab`;
const OTHER_ID = `decision-a${"0".repeat(30)}cd`;

const on = {
  apiVersion: 1,
  enabled: true,
  enabledAt: 1_700_000_000_000,
  backfillComplete: true,
  domainScopeRefused: [],
} as const;
const off = { ...on, enabled: false, enabledAt: null, backfillComplete: false } as const;

const blocked = {
  apiVersion: 1,
  blocked: [
    {
      decisionId: DECISION_ID,
      key: "growthly.example",
      scope: "domain",
      decidedAt: Date.UTC(2026, 8, 29, 12),
      archivedCount: 3,
    },
    {
      decisionId: OTHER_ID,
      key: "spam@elsewhere.example",
      scope: "address",
      decidedAt: Date.UTC(2026, 8, 28, 12),
      archivedCount: 0,
    },
  ],
} as const;

describe("MailSenderSettings", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  function client(overrides: Record<string, unknown> = {}) {
    return {
      getSenderScreenState: vi.fn().mockResolvedValue(on),
      setSenderScreenEnabled: vi.fn().mockResolvedValue(off),
      listBlockedSenders: vi.fn().mockResolvedValue(blocked),
      undoSenderDecision: vi
        .fn()
        .mockResolvedValue({ apiVersion: 1, restored: [], pending: false }),
      ...overrides,
    };
  }

  async function render(fake: ReturnType<typeof client>) {
    const onToast = vi.fn();
    await act(async () =>
      root.render(<MailSenderSettings client={fake} onToast={onToast} />),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return onToast;
  }

  function button(name: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.trim() === name ||
        candidate.getAttribute("aria-label") === name,
    );
    if (!(found instanceof HTMLButtonElement)) throw new Error(`No button ${name}`);
    return found;
  }

  it("switches the screen and names the rule it now keeps", async () => {
    const fake = client();
    const onToast = await render(fake);
    expect(host.textContent).toContain("Screen new senders");
    const radios = [...host.querySelectorAll('[role="radio"]')];
    expect(radios.map((radio) => [radio.textContent, radio.getAttribute("aria-checked")])).toEqual([
      ["Off", "false"],
      ["On", "true"],
    ]);

    await act(async () => (radios[0] as HTMLElement).click());
    await act(async () => Promise.resolve());
    expect(fake.setSenderScreenEnabled).toHaveBeenCalledWith(false);
    expect(onToast).toHaveBeenCalledWith("New senders come straight in");
    expect(
      [...host.querySelectorAll('[role="radio"]')].map((radio) => radio.getAttribute("aria-checked")),
    ).toEqual(["true", "false"]);
  });

  it("lists who is blocked and unblocks without moving old mail", async () => {
    const fake = client();
    const onToast = await render(fake);
    expect(host.textContent).toContain("Blocked senders");
    expect(host.textContent).toContain("Old mail stays where it is");
    expect(host.textContent).toContain("growthly.example");
    expect(host.textContent).toContain("Everyone at this domain");
    expect(host.textContent).toContain("3 letters archived");
    expect(host.textContent).toContain("spam@elsewhere.example");

    await act(async () => button("Unblock growthly.example").click());
    await act(async () => Promise.resolve());
    expect(fake.undoSenderDecision).toHaveBeenCalledWith({
      decisionId: DECISION_ID,
      restore: false,
    });
    expect(host.textContent).not.toContain("growthly.example");
    expect(onToast).toHaveBeenCalledWith("Unblocked growthly.example");
  });

  it("drops a row the service no longer has, and says a failed unblock", async () => {
    const fake = client({
      undoSenderDecision: vi
        .fn()
        .mockRejectedValueOnce(new MailApiError(404, "mail_sender_decision_not_found"))
        .mockRejectedValueOnce(new MailApiError(502, null)),
    });
    const onToast = await render(fake);
    await act(async () => button("Unblock growthly.example").click());
    await act(async () => Promise.resolve());
    expect(host.textContent).not.toContain("growthly.example");

    await act(async () => button("Unblock spam@elsewhere.example").click());
    await act(async () => Promise.resolve());
    expect(host.textContent).toContain("spam@elsewhere.example");
    expect(onToast).toHaveBeenLastCalledWith("Couldn’t unblock spam@elsewhere.example. Try again.");
  });

  it("says nobody is blocked when nobody is", async () => {
    await render(client({ listBlockedSenders: vi.fn().mockResolvedValue({ apiVersion: 1, blocked: [] }) }));
    expect(host.textContent).toContain("Nobody is blocked");
  });

  it("draws nothing at all when the screen cannot be reached", async () => {
    await render(
      client({
        getSenderScreenState: vi
          .fn()
          .mockRejectedValue(new MailApiError(503, "mail_senders_unavailable")),
      }),
    );
    expect(host.textContent).toBe("");
  });
});
