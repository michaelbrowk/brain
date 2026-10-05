// @vitest-environment jsdom

// How a snackbar slot hands its pills to framer's presence. Playback is not
// under test here (jsdom lays nothing out); the settings that decide where a
// leaving pill is pinned are.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnimatePresenceProps } from "@/test/framer-motion-mock";

const presence = vi.hoisted(() => ({ seen: [] as Record<string, unknown>[] }));

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    AnimatePresence: ({ children, ...rest }: AnimatePresenceProps) => {
      presence.seen.push(rest as Record<string, unknown>);
      return <>{children}</>;
    },
  });
});

const { Snackbar } = await import("./primitives");

describe("SnackbarSlot", () => {
  afterEach(() => {
    presence.seen.length = 0;
  });

  it("pins a leaving pill from the foot of the column, where the column is anchored", async () => {
    // The stack is fixed to the bottom of the window and grows upward. A
    // leaving pill pinned by its TOP drifts as the column under the pins
    // shrinks; pinned by its BOTTOM it stays where the reader last saw it.
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Snackbar open title="Saved" />));
    expect(presence.seen.at(-1)).toMatchObject({ mode: "popLayout", anchorY: "bottom" });
    await act(async () => root.unmount());
    host.remove();
  });
});
