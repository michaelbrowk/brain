// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTimeZone } from "@/lib/owner-settings";
import type { TaskView } from "@/lib/tasks/model";
import {
  deviceZone,
  liveTask,
  localDay,
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

// A WRITE THAT LANDS WHILE A LIST REQUEST IS OUT.
//
// `load()` replaces the records wholesale, so a fetch that left before the
// write answers for a set that predates it. The capture row on the hub inserts
// the created task and asks for nothing else, so the row appeared under Today
// and vanished a beat later when the mount's own fetch came back. The answer is
// only written if nothing moved under it.
describe("a load in flight against an optimistic insert", () => {
  let answer: (body: { tasks: TaskView[] }) => void;
  let fetchMock: ReturnType<typeof vi.fn>;

  function task(id: string, title: string): TaskView {
    return {
      id,
      title,
      when: localDay().today,
      created: "2026-09-20T08:00:00.000Z",
      updated: "2026-09-20T08:00:00.000Z",
      done: false,
    };
  }

  let host: HTMLDivElement;
  let root: Root;

  function Reader() {
    useTasks(0);
    return null;
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    resetTasksStore();
    fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = (body) => {
            resolve(new Response(JSON.stringify(body), { status: 200 }));
          };
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
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

  /** Past the response, its `json()` and the write that follows them, so the
   *  assertions read a load that has finished rather than one that has not
   *  started. A `waitFor` on an absence passes on its first look and proves
   *  nothing here. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps the record the writer landed, and drops the older answer", async () => {
    const stop = onDayChange(() => {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The POST answered while the list request was still out.
    mutateTasks((tasks) => [task("fresh", "Buy bread"), ...tasks]);
    expect(liveTask("fresh")?.title).toBe("Buy bread");

    // The server's snapshot, taken before that write landed.
    answer({ tasks: [task("older", "Water the plants")] });
    await settled();
    expect(liveTask("fresh")?.title).toBe("Buy bread");
    expect(liveTask("older")).toBeUndefined();
    stop();
  });

  it("takes an answer that nothing moved under", async () => {
    const stop = onDayChange(() => {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    answer({ tasks: [task("older", "Water the plants")] });
    await settled();
    expect(liveTask("older")?.title).toBe("Water the plants");
    stop();
  });

  // THE KEY GOES WITH THE ANSWER THAT WAS DROPPED.
  //
  // A load records the day, the offset and the token it asked under, and a
  // later load on the same three is skipped as a repeat of it — which is what
  // makes two subscribers one request. An answer that was dropped never
  // arrived, so the key it was asked under has to go with it, or the surface
  // remounting on the same token asks nothing and the reader is left with the
  // optimistic set for ever.
  it("is askable again on the same token after an answer it dropped", async () => {
    await act(async () => root.render(createElement(Reader)));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    mutateTasks((tasks) => [task("fresh", "Buy bread"), ...tasks]);
    answer({ tasks: [] });
    await settled();

    // The surface goes and comes back on the same refresh token and the same
    // day: the only reason to ask again is the answer that was not taken.
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Reader)));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    answer({ tasks: [task("fresh", "Buy bread"), task("older", "Water the plants")] });
    await settled();
    expect(liveTask("older")?.title).toBe("Water the plants");
    expect(liveTask("fresh")?.title).toBe("Buy bread");
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
