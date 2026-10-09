// @vitest-environment jsdom
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredSerializer, deferredSerialize } from "./deferred-serialize";

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
    const slow = vi.fn(() => {
      vi.advanceTimersByTime(120);
    });
    serializer.schedule(slow);
    vi.advanceTimersByTime(200);
    browser.idle(50);
    expect(slow).toHaveBeenCalledOnce();

    // The 120 ms run earned 360 ms of quiet.
    serializer.schedule(slow);
    vi.advanceTimersByTime(360);
    browser.idle(10);
    expect(slow).toHaveBeenCalledOnce();
    expect(browser.pending()).toBe(1);
    browser.idle(45);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("runs within a second of the last change even when no idle moment is long enough", () => {
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const slow = vi.fn(() => {
      vi.advanceTimersByTime(120);
    });
    serializer.schedule(slow);
    vi.advanceTimersByTime(200);
    browser.idle(50);
    serializer.schedule(slow);
    const lastChange = performance.now();
    vi.advanceTimersByTime(360);
    // Frames that leave 5 ms each, every 16 ms, up to the cap: none is taken.
    while (performance.now() - lastChange + 16 < 1000) {
      vi.advanceTimersByTime(16);
      browser.idle(5);
    }
    expect(slow).toHaveBeenCalledOnce();
    // The first frame past the cap is.
    vi.advanceTimersByTime(16);
    browser.idle(5);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("a costly page in a busy tab: quiet 500 ms, then the idle wait ends at one second", () => {
    // The reviewer's S5a shape: a 400 ms serialize used to earn a second of
    // quiet and then a second of idle wait, so the draft sat 2 s behind.
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const slow = vi.fn(() => {
      vi.advanceTimersByTime(400);
    });
    serializer.schedule(slow);
    vi.advanceTimersByTime(200);
    browser.idle(50);
    serializer.schedule(slow);
    const lastChange = performance.now();
    vi.advanceTimersByTime(499);
    expect(browser.pending()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(browser.pending()).toBe(1);
    let started = 0;
    slow.mockImplementation(() => {
      started = performance.now();
      vi.advanceTimersByTime(400);
    });
    while (slow.mock.calls.length < 2) {
      vi.advanceTimersByTime(16);
      browser.idle(5);
    }
    // The fake browser offers a frame every 16 ms; a real one fires the
    // request's own timeout at the cap.
    expect(started - lastChange).toBeLessThanOrEqual(1000 + 16);
  });

  it("a small page in a busy tab: the idle wait ends at one second, where it used to run on", () => {
    // The reviewer's S5b shape: frames that leave 1 ms idle each.
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const quick = vi.fn(() => {
      vi.advanceTimersByTime(2);
    });
    serializer.schedule(quick);
    vi.advanceTimersByTime(200);
    browser.idle(50);
    serializer.schedule(quick);
    const lastChange = performance.now();
    vi.advanceTimersByTime(200);
    let started = 0;
    quick.mockImplementation(() => {
      started = performance.now();
      vi.advanceTimersByTime(2);
    });
    while (quick.mock.calls.length < 2) {
      vi.advanceTimersByTime(16);
      browser.idle(1);
    }
    expect(started - lastChange).toBeLessThanOrEqual(1000 + 16);
    expect(started - lastChange).toBeGreaterThan(200);
  });

  it("waits longer after a costly run, so a long page is not serialized between every two words", () => {
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const slow = vi.fn(() => {
      vi.advanceTimersByTime(120);
    });
    serializer.schedule(slow);
    vi.advanceTimersByTime(200);
    browser.idle(50);
    expect(slow).toHaveBeenCalledOnce();

    // A word gap of 260 ms: the 120 ms run earned 360 ms of quiet.
    serializer.schedule(slow);
    vi.advanceTimersByTime(260);
    expect(browser.pending()).toBe(0);
    serializer.schedule(slow);
    vi.advanceTimersByTime(359);
    expect(browser.pending()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(browser.pending()).toBe(1);
  });

  it("caps the earned quiet at half a second", () => {
    const browser = fakeIdle();
    const serializer = createDeferredSerializer();
    const slow = vi.fn(() => {
      vi.advanceTimersByTime(900);
    });
    serializer.schedule(slow);
    vi.advanceTimersByTime(200);
    browser.idle(50);
    serializer.schedule(slow);
    vi.advanceTimersByTime(499);
    expect(browser.pending()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(browser.pending()).toBe(1);
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

describe("deferredSerialize in an editor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  async function mount(serialize: () => void) {
    const root = document.body.appendChild(document.createElement("div"));
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, "hello");
      })
      .use(commonmark)
      .use(deferredSerialize(createDeferredSerializer(), serialize))
      .create();
    return { editor, view: editor.ctx.get(editorViewCtx) };
  }

  it("serializes once after a change, and not after a caret move", async () => {
    const serialize = vi.fn();
    const { view } = await mount(serialize);
    view.dispatch(view.state.tr.insertText("x", 1));
    vi.advanceTimersByTime(200);
    expect(serialize).toHaveBeenCalledOnce();
    view.dispatch(view.state.tr.setSelection(view.state.selection));
    vi.advanceTimersByTime(500);
    expect(serialize).toHaveBeenCalledOnce();
  });

  it("is not put off by the view being updated with the state it already has", async () => {
    // ProseMirror hands plugin views the same state again on `setProps`;
    // the chrome around the editor does that often, and each one used to
    // restart the quiet period, so the serialize never came.
    const serialize = vi.fn();
    const { view } = await mount(serialize);
    view.dispatch(view.state.tr.insertText("x", 1));
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(100);
      view.setProps({});
    }
    vi.advanceTimersByTime(100);
    expect(serialize).toHaveBeenCalledOnce();
  });

  it("serializes at once on blur, with the text typed a moment before", async () => {
    const serialize = vi.fn();
    const { view } = await mount(serialize);
    view.dispatch(view.state.tr.insertText("q", 1));
    vi.advanceTimersByTime(50);
    view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(serialize).toHaveBeenCalledOnce();
  });

  it("leaves a transaction outside the history for the next flush", async () => {
    const serialize = vi.fn();
    const { view } = await mount(serialize);
    view.dispatch(view.state.tr.insertText("x", 1).setMeta("addToHistory", false));
    vi.advanceTimersByTime(1500);
    expect(serialize).not.toHaveBeenCalled();
  });
});
