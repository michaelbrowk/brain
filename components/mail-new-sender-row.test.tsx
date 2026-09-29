// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionRender } from "@/test/framer-motion-mock";
import { NewSenderRow } from "./mail-new-sender-row";
import type { MailThreadListItem } from "@/lib/mail/message-types";

/** What the swipe body hands framer, so the gesture's rules can be driven
 *  without a pointer: jsdom plays no drag, but the handler it would call is
 *  the code under test. */
const harness = vi.hoisted(() => ({
  reduce: false,
  dragBodies: [] as Array<Record<string, unknown>>,
  animate: [] as unknown[][],
}));

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  const mock = createFramerMotionMock({
    reducedMotion: () => harness.reduce,
    onRender: ({ motion, props }: MotionRender) => {
      if (props.className === "brain-mail-swipe-body") harness.dragBodies.push(motion);
    },
  });
  return {
    ...mock,
    animate: (...args: unknown[]) => {
      harness.animate.push(args);
      return { stop: () => {} };
    },
  };
});

const lena = { name: "Lena Okafor", address: "lena@okafor.example" };

const thread: MailThreadListItem = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  threadId: "thread-lena",
  subject: "Flat in Lisbon",
  participants: [{ name: "Priya Raman", address: "priya@example.test" }],
  snippet: "Keys are at the café downstairs.",
  lastMessageAt: 1_700_000_000_000,
  messageCount: 1,
  unread: true,
  starred: false,
  hasAttachments: false,
  listMessage: false,
  sizeBytes: 0,
  category: "people",
  newSender: true,
  newSenderFrom: lena,
};

describe("NewSenderRow", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("PointerEvent", MouseEvent);
    harness.reduce = false;
    harness.dragBodies.length = 0;
    harness.animate.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(domainScope = true) {
    const onDecide = vi.fn();
    await act(async () =>
      root.render(
        <div role="list">
          <NewSenderRow
            thread={thread}
            from={lena}
            active={false}
            index={0}
            entrance={false}
            reduce={harness.reduce}
            domainScope={domainScope}
            waitingHere={2}
            onSelect={() => {}}
            onDecide={onDecide}
          />
        </div>,
      ),
    );
    return onDecide;
  }

  async function openMenu() {
    const trigger = host.querySelector(".brain-mail-swipe") as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 2 }),
      );
      trigger.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      );
    });
    return [...document.body.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
  }

  it("offers this sender and everyone at the domain in the row menu", async () => {
    const onDecide = await render();
    const items = await openMenu();
    expect(items.map((item) => item.textContent)).toEqual([
      "Accept Lena Okafor",
      "Accept everyone at okafor.example2",
      "Block Lena Okafor",
      "Block everyone at okafor.example",
    ]);
    await act(async () => items[1]!.click());
    expect(onDecide).toHaveBeenCalledWith(thread, "accept", "domain");
  });

  it("leaves the domain out where the service would refuse it", async () => {
    const onDecide = await render(false);
    const items = await openMenu();
    expect(items.map((item) => item.textContent)).toEqual([
      "Accept Lena Okafor",
      "Block Lena Okafor",
    ]);
    await act(async () => items[1]!.click());
    expect(onDecide).toHaveBeenCalledWith(thread, "block", "address");
  });

  it("decides on a swipe past the threshold or a flick, and goes home otherwise", async () => {
    const onDecide = await render();
    const body = harness.dragBodies.at(-1)!;
    expect(body.drag).toBe("x");
    const end = body.onDragEnd as (
      event: unknown,
      info: { offset: { x: number }; velocity: { x: number } },
    ) => void;
    // jsdom lays nothing out, so the row has no width and only a flick can
    // cross; a real row decides at 35% of its width as well.
    end(null, { offset: { x: 30 }, velocity: { x: 900 } });
    expect(onDecide).not.toHaveBeenCalled();
    expect(harness.animate).toHaveLength(1);

    end(null, { offset: { x: 60 }, velocity: { x: 900 } });
    expect(onDecide).toHaveBeenLastCalledWith(thread, "accept", "address", { dragged: 0 });
    end(null, { offset: { x: -60 }, velocity: { x: -900 } });
    expect(onDecide).toHaveBeenLastCalledWith(thread, "block", "address", { dragged: 0 });
    // A slow drag back the way it came is a change of mind, not a flick.
    end(null, { offset: { x: 60 }, velocity: { x: -900 } });
    expect(onDecide).toHaveBeenCalledTimes(2);
  });

  it("takes no swipe under reduced motion, and keeps both buttons", async () => {
    harness.reduce = true;
    await render();
    expect(harness.dragBodies.at(-1)!.drag).toBe(false);
    const words = [...host.querySelectorAll(".brain-mail-gate button")].map(
      (button) => button.textContent,
    );
    expect(words).toEqual(["Block", "Accept"]);
  });
});
