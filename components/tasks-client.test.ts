// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTimeZone } from "@/lib/owner-settings";
import {
  deviceZone,
  mutateTasks,
  onDayChange,
  resetTasksStore,
  useTasks,
  type TasksState,
} from "./tasks-client";

describe("deviceZone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers a zone the server will accept", () => {
    // The one reading of the browser's own zone. The server validates the name
    // it is handed, so a name this platform reports has to pass that gate.
    expect(isTimeZone(deviceZone())).toBe(true);
  });

  it("answers the empty string when the platform cannot say", () => {
    vi.stubGlobal("Intl", {
      DateTimeFormat: () => {
        throw new Error("no calendar here");
      },
    });
    expect(deviceZone()).toBe("");
  });
});

describe("the list request", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetTasksStore();
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ tasks: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetTasksStore();
    vi.unstubAllGlobals();
  });

  it("offers the device's zone, so the server can capture it once", async () => {
    // Nothing else on the client asks for the zone: a reminder fires from a
    // server timer, and this is the request every client already makes.
    const stop = onDayChange(() => {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    stop();

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain(`zone=${encodeURIComponent(deviceZone())}`);
    expect(url).toContain("today=");
    expect(url).toContain("offset=");
  });
});

// RULING M8, THE HALF A BEHAVIOUR TEST CANNOT SEE.
//
// With Tasks off the hook must still call every hook in the same order on
// every render, and must ask for nothing, subscribe to nothing and hold no
// reference on the midnight clock. Two of those three are invisible from the
// shell: reverting `enabled ? subscribe : NO_SUBSCRIBE` and the two snapshot
// readers to their unconditional form left every suite green, because
// `load()` returns early while `state.day` is null and `watchDay` is what
// sets it. These read the hook directly.
describe("useTasks with the module off", () => {
  let host: HTMLDivElement;
  let root: Root;
  let seen: TasksState[];

  function Probe({ enabled }: { enabled: boolean }) {
    seen.push(useTasks(0, enabled));
    return null;
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    resetTasksStore();
    seen = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ tasks: [] }), { status: 200 })),
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetTasksStore();
    vi.unstubAllGlobals();
  });

  // `createElement` and not JSX: this file is a `.ts`, and the hook is the
  // only thing under test, so it does not earn a rename to `.tsx`.
  const render = async (enabled: boolean) => {
    await act(async () => root.render(createElement(Probe, { enabled })));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  // `useSyncExternalStore` compares snapshots by reference, so a fresh object
  // per read re-renders for ever. One frozen value for the life of the module
  // is what makes the disabled path safe to mount at all.
  it("answers one and the same snapshot across renders", async () => {
    await render(false);
    await render(false);

    expect(seen.length).toBeGreaterThan(1);
    for (const snapshot of seen) expect(snapshot).toBe(seen[0]);
    expect(seen[0]).toEqual({ day: null, tasks: [], loading: false, error: null });
  });

  it("asks for nothing", async () => {
    await render(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  // The store publishing to its subscribers must not reach a hook that is
  // off: `NO_SUBSCRIBE` registers no listener, so this re-renders nothing and
  // the snapshot stays the frozen empty one.
  it("hears nothing when the store moves under it", async () => {
    await render(false);
    const before = seen.length;

    await act(async () => {
      mutateTasks(() => [{ id: "task-1" } as never]);
    });

    expect(seen.length).toBe(before);
    expect(seen.at(-1)).toBe(seen[0]);
  });

  // And with the module on it is the ordinary hook again, subscriber and all.
  it("subscribes and asks again once the module is on", async () => {
    await render(false);
    expect(fetch).not.toHaveBeenCalled();

    await render(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(seen.at(-1)).not.toBe(seen[0]);
  });
});
