// @vitest-environment jsdom

// The one screen that can take Mail or Tasks away, so every branch here is a
// sentence the owner can act on: the flip, the wait, and the refusal.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModulesSection } from "./modules-section";
import {
  SETTINGS_SECTION_META,
  SETTINGS_SECTION_ORDER,
  visibleSettingsSections,
} from "./sections";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const BOTH_ON = { mail: true, tasks: true } as const;

describe("the Modules section", () => {
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
    vi.unstubAllGlobals();
  });

  async function render(modules: { mail: boolean; tasks: boolean } = BOTH_ON) {
    await act(async () =>
      root.render(<ModulesSection modules={modules} onToast={() => {}} />),
    );
  }

  function radio(label: string, option: "On" | "Off"): HTMLButtonElement {
    const group = host.querySelector<HTMLElement>(
      `[role="radiogroup"][aria-label="${label}"]`,
    );
    if (!group) throw new Error(`no switch for ${label}`);
    const button = [...group.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === option,
    );
    if (!button) throw new Error(`no ${option} in ${label}`);
    return button as HTMLButtonElement;
  }

  it("draws a row per module, on, with the sentence each one promises", async () => {
    await render();
    expect(radio("Mail", "On").getAttribute("aria-checked")).toBe("true");
    expect(radio("Tasks", "On").getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Accounts stay connected; syncing stops.");
    expect(host.textContent).toContain(
      "Checkboxes in notes keep working; tasks and reminders sleep.",
    );
    // The house rule for reader-visible strings.
    expect(host.textContent).not.toContain("—");
  });

  it("puts the switch at once and shows the row waiting for the answer", async () => {
    let settle: (value: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await render();

    await act(async () => radio("Mail", "Off").click());
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/modules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mail: false }),
    });
    // Optimistic, and the row is not pressable again until the answer lands.
    expect(radio("Mail", "Off").getAttribute("aria-checked")).toBe("true");
    expect(radio("Mail", "Off").disabled).toBe(true);
    expect(radio("Tasks", "On").disabled).toBe(false);

    await act(async () => {
      settle({ ok: true, json: async () => ({ mail: false, tasks: true }) } as Response);
      await Promise.resolve();
    });
    expect(radio("Mail", "Off").disabled).toBe(false);
  });

  // THE ANSWER IS THE SERVER'S, NOT THE GUESS. The PUT carries one key and
  // answers the whole pair, so a flip made in another tab while this one was
  // in flight lands here rather than being overwritten by the optimism.
  it("takes the pair that stands from the answer's own body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ mail: false, tasks: false }),
      })) as unknown as typeof fetch,
    );
    await render();
    await act(async () => {
      radio("Mail", "Off").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(radio("Mail", "Off").getAttribute("aria-checked")).toBe("true");
    expect(radio("Tasks", "Off").getAttribute("aria-checked")).toBe("true");
  });

  it("reverts the switch and shows the sentence the server sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "bad_modules", reason: "that is not a switch" }),
      })) as unknown as typeof fetch,
    );
    await render();
    await act(async () => {
      radio("Tasks", "Off").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(radio("Tasks", "On").getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "that is not a switch",
    );
  });

  it("says something act-on-able when the request never lands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    );
    await render();
    await act(async () => {
      radio("Mail", "Off").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(radio("Mail", "On").getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't save that. Try again.",
    );
  });
});

describe("the settings registry", () => {
  it("puts Modules right after Appearance", () => {
    expect(SETTINGS_SECTION_ORDER).toEqual([
      "appearance",
      "modules",
      "mail",
      "connections",
      "notifications",
      "sharing",
      "data",
      "account",
      "donate",
    ]);
    expect(SETTINGS_SECTION_META.modules).toEqual({
      label: "Modules",
      icon: "widget-2",
    });
  });

  it("drops the Mail section from the list when Mail is off", () => {
    expect(visibleSettingsSections({ mail: false, tasks: true })).not.toContain("mail");
    expect(visibleSettingsSections({ mail: false, tasks: true })).toContain("modules");
    // Tasks has no section of its own, so its switch changes nothing here.
    expect(visibleSettingsSections({ mail: true, tasks: false })).toEqual(
      SETTINGS_SECTION_ORDER,
    );
  });
});
