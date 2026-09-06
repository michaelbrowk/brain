// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import { ShareBusyRetry, SHARE_BUSY_SECONDS } from "./share-busy-retry";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(onRetry: (href: string) => void) {
  await act(async () => {
    root.render(<ShareBusyRetry href="/share/root" onRetry={onRetry} />);
  });
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const line = () => host.querySelector("[data-share-busy-countdown]");

describe("the busy page's retry", () => {
  it("counts down where it can be read, then goes back for the page", async () => {
    const onRetry = vi.fn();
    await mount(onRetry);

    expect(line()?.textContent).toContain(`Trying again in ${SHARE_BUSY_SECONDS}s.`);
    await elapse(1000);
    expect(line()?.textContent).toContain(`Trying again in ${SHARE_BUSY_SECONDS - 1}s.`);
    expect(onRetry).not.toHaveBeenCalled();

    for (let second = 0; second < SHARE_BUSY_SECONDS; second += 1) {
      await elapse(1000);
    }
    expect(onRetry).toHaveBeenCalledWith("/share/root");
  });

  it("stops on the press and stays stopped", async () => {
    // The meta refresh this replaces reloaded every second for as long as the
    // store stayed busy, with no way to stop it.
    const onRetry = vi.fn();
    await mount(onRetry);

    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((candidate) => candidate.textContent === "Stop")!
        .click();
    });

    expect(line()).toBeNull();
    for (let second = 0; second < SHARE_BUSY_SECONDS * 2; second += 1) {
      await elapse(1000);
    }
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not announce each second", async () => {
    await mount(vi.fn());
    expect(line()?.getAttribute("aria-live")).toBeNull();
    expect(line()?.getAttribute("role")).toBeNull();
  });
});
