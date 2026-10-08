// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredSerializer } from "./deferred-serialize";

/** A browser whose idle moments the test hands out. */
function fakeIdle() {
  const queue: { callback: IdleRequestCallback; id: number; timeout: number; at: number }[] = [];
  let nextId = 1;
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback, options?: IdleRequestOptions) => {
    const id = nextId++;
    queue.push({ callback, id, timeout: options?.timeout ?? Infinity, at: performance.now() });
    return id;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number) => {
    const index = queue.findIndex((entry) => entry.id === id);
    if (index >= 0) queue.splice(index, 1);
  });
  return {
    pending: () => queue.length,
    /** The browser is idle with `remaining` ms to spare. */
    idle: (remaining: number) => {
      const entry = queue.shift();
      if (!entry) throw new Error("nothing waits for an idle moment");
      entry.callback({ didTimeout: false, timeRemaining: () => remaining });
    },
    /** The request's own timeout ran out. */
    expire: () => {
      const entry = queue.shift();
      if (!entry) throw new Error("nothing waits for an idle moment");
      entry.callback({ didTimeout: true, timeRemaining: () => 0 });
    },
  };
}

describe("createDeferredSerializer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for the quiet period, then for an idle moment, and runs once", () => {
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const work = vi.fn();
    serializer.schedule(work);
    serializer.schedule(work);
    vi.advanceTimersByTime(199);
    expect(browser.pending()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(browser.pending()).toBe(1);
    expect(work).not.toHaveBeenCalled();
    browser.idle(50);
    expect(work).toHaveBeenCalledOnce();
  });

  it("restarts the quiet period on every change, as a debounce does", () => {
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const work = vi.fn();
    serializer.schedule(work);
    vi.advanceTimersByTime(150);
    serializer.schedule(work);
    vi.advanceTimersByTime(150);
    expect(browser.pending()).toBe(0);
    vi.advanceTimersByTime(50);
    expect(browser.pending()).toBe(1);
  });

  it("postpones while the idle moment is shorter than the last run needed", () => {
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const slow = vi.fn(() => vi.advanceTimersByTime(120));
    serializer.schedule(slow);
    vi.advanceTimersByTime(200);
    browser.idle(50);
    expect(slow).toHaveBeenCalledOnce();

    serializer.schedule(slow);
    vi.advanceTimersByTime(200);
    browser.idle(10);
    expect(slow).toHaveBeenCalledOnce();
    expect(browser.pending()).toBe(1);
    browser.idle(45);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("runs at the cap even when no idle moment is long enough", () => {
    const browser = fakeIdle();
    const serializer = createDeferredSerializer({ capMs: 1000 });
    const slow = vi.fn(() => vi.advanceTimersByTime(120));
    serializer.schedule(slow);
    vi.advanceTimersByTime(200);
    browser.idle(50);
    serializer.schedule(slow);
    vi.advanceTimersByTime(200);
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(150);
      browser.idle(5);
    }
    expect(slow).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(300);
    browser.idle(5);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("runs when the request itself times out", () => {
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const work = vi.fn();
    serializer.schedule(work);
    vi.advanceTimersByTime(200);
    browser.expire();
    expect(work).toHaveBeenCalledOnce();
  });

  it("drops scheduled work when the caller has serialized itself", () => {
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const work = vi.fn();
    serializer.schedule(work);
    vi.advanceTimersByTime(200);
    serializer.drop();
    expect(browser.pending()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(work).not.toHaveBeenCalled();
  });

  it("runs after the quiet period alone where the browser offers no idle callback", () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const serializer = createDeferredSerializer();
    const work = vi.fn();
    serializer.schedule(work);
    vi.advanceTimersByTime(200);
    expect(work).toHaveBeenCalledOnce();
  });
});
