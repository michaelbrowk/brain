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

  /** The two microtask hops a flip takes: the fetch, then its body. */
  const settled = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

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
    // Optimistic, and neither row is pressable again until the answer lands:
    // `flip` refuses a second call while one is in flight, so a switch that
    // still looked live would do nothing and say nothing.
    expect(radio("Mail", "Off").getAttribute("aria-checked")).toBe("true");
    expect(radio("Mail", "Off").disabled).toBe(true);
    expect(radio("Tasks", "On").disabled).toBe(true);

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

  // THE OVERRIDE IS A STOPGAP, NOT A SECOND SOURCE OF TRUTH.
  //
  // The rows show the answer's own body until the `modules` prop catches up
  // over SSE, and then they have to let go of it. Nothing dropped it, so after
  // any successful flip this screen showed its own last answer for good: tab A
  // turns Tasks off, tab B turns it back on, and tab A's sidebar redraws the
  // Tasks row from the event while this row still reads Off. The screen
  // contradicting the shell around it is the one state it must not reach.
  it("lets go of its own answer once the prop agrees with it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ mail: true, tasks: false }),
      })) as unknown as typeof fetch,
    );
    await render();
    await act(async () => radio("Tasks", "Off").click());
    await settled();
    expect(radio("Tasks", "Off").getAttribute("aria-checked")).toBe("true");

    // The event this tab's own PUT produced, arriving over SSE.
    await render({ mail: true, tasks: false });
    expect(radio("Tasks", "Off").getAttribute("aria-checked")).toBe("true");

    // Another tab turns it back on. The prop moves and the row has to follow.
    await render({ mail: true, tasks: true });
    expect(radio("Tasks", "On").getAttribute("aria-checked")).toBe("true");
  });

  // A control that can only do nothing is worse than no control: the other
  // row's switch stands down until the one in flight has an answer.
  it("stands the idle row down while the other is in flight", async () => {
    let settle: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve;
          }),
      ),
    );
    await render();

    await act(async () => radio("Mail", "Off").click());
    expect(radio("Mail", "Off").disabled).toBe(true);
    expect(radio("Tasks", "On").disabled).toBe(true);

    await act(async () => {
      settle({ ok: true, json: async () => ({ mail: false, tasks: true }) } as Response);
      await Promise.resolve();
    });
    expect(radio("Mail", "Off").disabled).toBe(false);
    expect(radio("Tasks", "On").disabled).toBe(false);
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

  it("says the mail service was not told, without undoing the switch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ mail: false, tasks: true, mailService: "unreachable" }),
      })) as unknown as typeof fetch,
    );
    await render();
    await act(async () => {
      radio("Mail", "Off").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The switch landed. The other process did not hear it yet, which the
    // startup call repairs, so this is a sentence and not a revert.
    expect(radio("Mail", "Off").getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "The mail service did not answer; it will be told again on the next start",
    );
    expect(host.textContent).not.toContain("—");
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
