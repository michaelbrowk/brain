// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorPage from "./error";

function chunkError() {
  const error = new Error("Failed to load chunk static/chunks/x.js from module y");
  error.name = "ChunkLoadError";
  return error;
}

describe("ErrorPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const render = async (error: Error, reset = vi.fn()) => {
    await act(async () => {
      root.render(<ErrorPage error={error} reset={reset} />);
    });
    return reset;
  };

  it("paints the screen when the marker reads but refuses the write", async () => {
    // Safari private mode, a full quota, an extension: reads work, writes
    // throw. No reload can be guarded, so the screen must still appear
    // rather than the blank the reload would have replaced.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await render(chunkError());
    expect(container.textContent).toContain("Something broke");
    expect(container.textContent).toContain("Reloading usually fixes this");
    expect(container.textContent).not.toContain("already reloaded");
    expect(container.querySelector("button")?.textContent).toBe("Reload");
  });

  it("names the offline case instead of reloading into a network error", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await render(chunkError());
    expect(container.textContent).toContain("offline");
    expect(container.querySelector("button")?.textContent).toBe("Reload");
    expect(sessionStorage.length).toBe(0);
  });

  it("says the reload was already spent in this build", async () => {
    sessionStorage.setItem(`brain:chunk-reload:${location.pathname}${location.search}`, "development");
    await render(chunkError());
    expect(container.textContent).toContain("already reloaded once");
    expect(container.querySelector("button")?.textContent).toBe("Reload");
  });

  it("keeps Try again and reset() for an ordinary error", async () => {
    const reset = await render(new TypeError("x is not a function"));
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Try again");
    await act(async () => button?.click());
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
