// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_RECOVERY_UNAVAILABLE, type SaveState } from "./helpers";
import { SaveIndicator } from "./save-indicator";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

describe("SaveIndicator", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const render = (state: SaveState, recoveryUnavailable = false) =>
    act(async () =>
      root.render(
        <SaveIndicator
          state={state}
          recoveryUnavailable={recoveryUnavailable}
        />,
      ),
    );
  const live = () => container.querySelector("[role]");

  /** The head is silent about a save that works: nothing while saving,
   *  nothing once saved, however long either state holds. */
  it("renders nothing for idle, saving and saved, even after 2 s", async () => {
    await render("idle");
    expect(container.textContent).toBe("");

    await render("saving");
    expect(container.textContent).toBe("");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(container.textContent).toBe("");
    expect(live()).toBeNull();

    await render("saved");
    expect(container.textContent).toBe("");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(container.textContent).toBe("");
    expect(live()).toBeNull();
  });

  it("says Not saved the moment a save fails", async () => {
    await render("saving");
    await render("error");
    const status = live();
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("Not saved");
    expect(status?.getAttribute("title")).toBe(
      "Couldn’t save. Your local draft is safe.",
    );
  });

  it("announces a conflict assertively", async () => {
    await render("conflict");
    const alert = live();
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.getAttribute("aria-live")).toBe("assertive");
    expect(alert?.textContent).toBe("Conflict");
    expect(alert?.getAttribute("title")).toContain("Save a copy");
  });

  it("keeps the recovery-unavailable copy on a failed save", async () => {
    await render("error", true);
    expect(live()?.getAttribute("title")).toBe(
      `Couldn’t save. ${LOCAL_RECOVERY_UNAVAILABLE}`,
    );
  });
});
