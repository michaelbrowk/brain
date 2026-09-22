// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_VERSION } from "@/lib/apps/bridge";
import { createAppBridge } from "./app-bridge";

let frame: HTMLIFrameElement;
let posted: unknown[];
let bridge: ReturnType<typeof createAppBridge>;
const onOpenPage = vi.fn();
const onToast = vi.fn();
const handle = vi.fn(async () => ({ tree: [] }));

function speak(message: unknown, source: unknown = frame.contentWindow) {
  window.dispatchEvent(
    new MessageEvent("message", { data: message, source: source as Window }),
  );
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  posted = [];
  frame = document.createElement("iframe");
  document.body.append(frame);
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: { postMessage: (message: unknown) => posted.push(message) },
  });
  bridge = createAppBridge({
    frame,
    page: { id: "app1", title: "Trainer" },
    theme: () => "light",
    tokens: () => ({ "--paper": "oklch(0.988 0.004 91)" }),
    handle,
    onOpenPage,
    onToast,
  });
});

afterEach(() => {
  bridge.dispose();
  frame.remove();
  vi.clearAllMocks();
});

describe("the host side of the bridge", () => {
  it("answers hello with the theme, the page and the tokens", async () => {
    speak({ v: 1, rid: "r1", type: "hello" });
    await settle();
    expect(posted).toEqual([
      {
        v: BRIDGE_VERSION,
        rid: "r1",
        ok: true,
        data: {
          v: BRIDGE_VERSION,
          theme: "light",
          page: { id: "app1", title: "Trainer" },
          kit: { tokens: { "--paper": "oklch(0.988 0.004 91)" } },
        },
      },
    ]);
  });

  it("ignores a message from any window but the frame it made", async () => {
    speak({ v: 1, rid: "r1", type: "hello" }, window);
    await settle();
    expect(posted).toHaveLength(0);
  });

  it("refuses a message it cannot parse, and says nothing more about it", async () => {
    speak({ v: 1, rid: "r1", type: "delete.page", id: "p" });
    await settle();
    expect(posted).toEqual([
      {
        v: BRIDGE_VERSION,
        rid: "r1",
        ok: false,
        error: "Brain did not understand that request",
        reason: "bad_request",
      },
    ]);
  });

  it("drops a message with no usable request id rather than answering nowhere", async () => {
    speak({ v: 1, type: "hello" });
    speak("not even an object");
    await settle();
    expect(posted).toHaveLength(0);
  });

  it("stops at 30 requests a second and says too_many", async () => {
    for (let i = 0; i < 31; i += 1) speak({ v: 1, rid: `r${i}`, type: "read.tree" });
    await settle();
    // The refusal is posted synchronously, inside the loop, and the thirty
    // answers resolve on microtasks after it, so the refusal is not the last
    // message posted. It is the only one.
    const refusals = posted.filter(
      (message) => (message as { ok?: boolean }).ok === false,
    ) as { ok: boolean; reason?: string }[];
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reason).toBe("too_many");
    expect(handle).toHaveBeenCalledTimes(30);
  });

  it("sends a theme event without being asked, with the tokens the theme changed", () => {
    bridge.sendTheme("dark");
    expect(posted).toEqual([
      {
        v: BRIDGE_VERSION,
        event: "theme",
        theme: "dark",
        tokens: { "--paper": "oklch(0.988 0.004 91)" },
      },
    ]);
  });

  it("reads the tokens at the moment it sends them, not once at hello", () => {
    // The values are resolved off the live document, which is what has just
    // changed. Reading them once when the bridge was made would send the
    // light palette under the word dark.
    const values = [{ "--paper": "light-paper" }, { "--paper": "dark-paper" }];
    let reads = 0;
    const live = createAppBridge({
      frame,
      page: { id: "app1", title: "Trainer" },
      theme: () => "dark",
      tokens: () => values[Math.min(reads++, values.length - 1)]!,
      handle,
      onOpenPage,
      onToast,
    });
    live.sendTheme("light");
    live.sendTheme("dark");
    live.dispose();
    expect(posted.map((message) => (message as { tokens: unknown }).tokens)).toEqual([
      { "--paper": "light-paper" },
      { "--paper": "dark-paper" },
    ]);
  });

  it("sends a visibility event when the canvas leaves and returns", () => {
    bridge.sendVisibility(false);
    bridge.sendVisibility(true);
    expect(posted).toEqual([
      { v: BRIDGE_VERSION, event: "visibility", visible: false },
      { v: BRIDGE_VERSION, event: "visibility", visible: true },
    ]);
  });

  it("navigates and toasts in the shell rather than through handle", async () => {
    speak({ v: 1, rid: "r1", type: "open", id: "page9" });
    speak({ v: 1, rid: "r2", type: "toast", text: "Saved" });
    await settle();
    expect(onOpenPage).toHaveBeenCalledWith("page9");
    expect(onToast).toHaveBeenCalledWith("Saved");
    expect(handle).not.toHaveBeenCalled();
  });

  it("hears nothing once disposed", async () => {
    bridge.dispose();
    speak({ v: 1, rid: "r1", type: "hello" });
    await settle();
    expect(posted).toHaveLength(0);
  });
});
