// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_FRAME_SANDBOX } from "@/lib/apps/csp";
import { apiFetch } from "@/lib/client";
import { AppCanvas } from "./app-canvas";
import { createAppWrites } from "./app-writes";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

// The factory is hoisted above every const in this file, so the double is
// made inside it and read back through `vi.mocked`, as the shell's own DOM
// contract does.
vi.mock("@/lib/client", () => ({ apiFetch: vi.fn(), CLIENT_ID: "test-client" }));
const fetchMock = vi.mocked(apiFetch);

/** The real write side, watched. Nothing here changes what it does: the case
 *  at the foot of the file only asks which app id the canvas handed it. */
vi.mock("./app-writes", async () => {
  const actual = await vi.importActual<typeof import("./app-writes")>("./app-writes");
  return { ...actual, createAppWrites: vi.fn(actual.createAppWrites) };
});
const writesMock = vi.mocked(createAppWrites);

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(minted());
  writesMock.mockClear();
});

/** What `POST /api/app/<id>/frame` answers: a signed address to mount and the
 *  second it stops working. The token is opaque to the canvas, which is the
 *  point of the shape; the expiry is not, because the canvas is what has to
 *  ask again before it arrives. */
const FRAME_SRC = "/api/app/app1/t/head.body.signature/index.html";
const TWELVE_HOURS = 12 * 60 * 60;
const minted = (src: string | null = FRAME_SRC, inSeconds = TWELVE_HOURS) =>
  ({
    ok: true,
    status: 200,
    json: async () =>
      src === null ? {} : { src, exp: Math.floor(Date.now() / 1000) + inSeconds },
  }) as Response;

const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

const node = {
  id: "app1",
  title: "Trainer",
  icon: "🃏",
  kind: "app" as const,
  app: {
    entry: "app/index.html",
    version: 1,
    builtBy: "Claude",
    builtAt: "2026-09-22T10:00:00.000Z",
    owns: [],
    state: false,
    reason: "build me a trainer for my Spanish words",
  },
};

/** The date the head draws, resolved through the reader's own locale exactly
 *  as the component resolves it. A fixed string here would assert the machine
 *  running the suite rather than the component. */
const BUILT_ON = new Date(node.app.builtAt).toLocaleDateString(undefined, {
  month: "short",
  day: "numeric",
});

/** One page, so a read driven through the bridge has something to answer
 *  with. The other cases never ask, and the shape is the shell's own. */
const LIVE_TREE = [
  { id: "p1", parentId: null, title: "Words", hasChildren: false, children: [] },
];

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** The root is unmounted, not just detached. The canvas listens on `document`
 *  for `visibilitychange`, so a root left mounted goes on answering events a
 *  later case dispatches, with the expiry the earlier case gave it. */
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(onToast: (text: string) => void = () => {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <AppCanvas
        node={node as never}
        liveTree={() => LIVE_TREE as never}
        onOpenPage={() => {}}
        onToast={onToast}
      />,
    );
  });
  return host;
}

/** Mounts and drains the preflight, so a case reads the canvas in the state
 *  it settles into rather than the one frame before it. */
async function renderReady(onToast?: (text: string) => void) {
  const mounted = render(onToast);
  await settle();
  return mounted;
}

const rebuildButton = (mounted: HTMLElement) =>
  mounted.querySelector("[data-app-rebuild]") as HTMLButtonElement;

describe("the app canvas", () => {
  it("asks for an address before it mounts a frame", async () => {
    // The frame's authority is in its path, so the canvas does not know where
    // to mount it until the server says. One POST, and the answer is both the
    // address and whether there is anything to show.
    render();
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/app/app1/frame", { method: "POST" });
  });

  it("says so, and offers Rebuild, when there is no address to mount", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
    const host = render();
    await settle();
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("App files are missing. Ask your agent to rebuild the page.");
    expect(host.querySelector("[data-app-rebuild]")).not.toBeNull();
  });

  it("says the same when the answer carries no address at all", async () => {
    fetchMock.mockResolvedValue(minted(null));
    const host = render();
    await settle();
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("App files are missing. Ask your agent to rebuild the page.");
  });

  it("mounts the frame at the address it was given, sandboxed", async () => {
    const frame = (await renderReady()).querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(FRAME_SRC);
    // The token is a path segment, which is what lets a relative
    // `assets/x.png` inside the frame carry it without the document knowing.
    expect(frame.getAttribute("src")).toContain("/t/");
    expect(frame.getAttribute("sandbox")).toBe(APP_FRAME_SANDBOX);
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("title")).toBe("Trainer");
  });

  it("says who built it and when, and why", async () => {
    const text = (await renderReady()).textContent ?? "";
    expect(text).toContain("Built by Claude");
    expect(text).toContain(BUILT_ON);
    expect(text).toContain("build me a trainer for my Spanish words");
  });

  it("offers Rebuild as a prompt to copy, with the page's id in it", async () => {
    const write = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText: write } });
    const button = (await renderReady()).querySelector("[data-app-rebuild]") as HTMLButtonElement;
    expect(button.textContent).toBe("Rebuild");
    await act(async () => {
      button.click();
    });
    // Deviation 2 in the plan head: no "Ask your agent:" prefix. What lands
    // on the clipboard is what the owner pastes into their agent, and the
    // prefix is addressed to the person, not to the agent.
    expect(write).toHaveBeenCalledWith("rebuild the page Trainer (id app1)");
  });

  it("says what to do with what it copied, beside the button", async () => {
    expect((await renderReady()).textContent).toContain("Copy a prompt for your agent");
  });

  it("stops saying Copied after a couple of seconds", async () => {
    vi.useFakeTimers();
    try {
      Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
      const mounted = await renderReady();
      await act(async () => {
        rebuildButton(mounted).click();
      });
      expect(mounted.textContent).toContain("Copied. Paste it to your agent.");
      await act(async () => {
        vi.advanceTimersByTime(2_500);
      });
      expect(mounted.textContent).not.toContain("Copied.");
      expect(mounted.textContent).toContain("Copy a prompt for your agent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so when the clipboard refuses, and puts the prompt where it can be read", async () => {
    // A denied permission or a page that is not a secure context rejects the
    // write. Unhandled, the owner clicks Rebuild and nothing at all happens.
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    const toasts: string[] = [];
    const mounted = await renderReady((text) => toasts.push(text));
    await act(async () => {
      rebuildButton(mounted).click();
    });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("Could not copy");
    expect(mounted.textContent).not.toContain("Copied.");
    expect(
      (mounted.querySelector("[data-app-prompt]") as HTMLElement | null)?.textContent,
    ).toBe("rebuild the page Trainer (id app1)");
  });

  it("keeps the phone's tab bar reserve under the frame", async () => {
    const shell = (await renderReady()).querySelector("[data-app-canvas]") as HTMLElement;
    expect(shell.className).toContain("brain-app-canvas");
  });

  /** WHAT STANDS WHERE THE APP WILL BE WHILE IT IS STILL ARRIVING.
   *
   *  A frame mounts with an empty document, and on a cold load the seconds
   *  before the app paints were bare paper under the head: a page that had
   *  finished loading with nothing on it, which is a different sentence from
   *  a page that is still loading. Until `load` the canvas carries the fill
   *  this app puts wherever work is in progress. The fill is static, so
   *  reduced motion is shown the same thing and there is nothing to flatten.
   */
  it("holds the frame's place until its document has painted", async () => {
    const mounted = await renderReady();
    const canvas = mounted.querySelector("[data-app-canvas]") as HTMLElement;
    expect(canvas.className).toContain("brain-app-canvas_loading");

    const frame = mounted.querySelector("iframe") as HTMLIFrameElement;
    await act(async () => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(canvas.className).not.toContain("brain-app-canvas_loading");
  });

  it("waits again when a remint hands the frame a new address", async () => {
    // A new address is a new token, so the frame reloads and the wait for the
    // second document is the same wait as the first.
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(minted(FRAME_SRC, 600));
      const mounted = render();
      await settle();
      const canvas = mounted.querySelector("[data-app-canvas]") as HTMLElement;
      await act(async () => {
        (mounted.querySelector("iframe") as HTMLIFrameElement).dispatchEvent(
          new Event("load"),
        );
      });
      expect(canvas.className).not.toContain("brain-app-canvas_loading");

      fetchMock.mockResolvedValue(minted("/api/app/app1/t/second.token/index.html", 600));
      await act(async () => {
        await vi.advanceTimersByTimeAsync((600 - 300) * 1000);
      });
      expect(canvas.className).toContain("brain-app-canvas_loading");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds nothing when there is no frame to wait for", async () => {
    // The missing-files state draws a sentence, not a frame. Nothing is on
    // its way, so nothing says it is.
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
    const canvas = (await renderReady()).querySelector(
      "[data-app-canvas]",
    ) as HTMLElement;
    expect(canvas.className).not.toContain("brain-app-canvas_loading");
  });

  it("answers a read the frame asks for", async () => {
    const frame = (await renderReady()).querySelector("iframe") as HTMLIFrameElement;
    const posted: unknown[] = [];
    // The bridge reads `contentWindow` when it posts, so a double installed
    // after mount is the one it answers into, and the one a message has to
    // name as its source to be heard at all.
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: { postMessage: (message: unknown) => posted.push(message) },
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { v: 1, rid: "r1", type: "read.tree" },
          source: frame.contentWindow as Window,
        }),
      );
      await Promise.resolve();
    });

    expect(posted).toEqual([
      {
        v: 1,
        rid: "r1",
        ok: true,
        data: { tree: [{ id: "p1", parentId: null, title: "Words" }] },
      },
    ]);
  });

  it("draws a page whose app map the tree withheld, without inventing one", async () => {
    // `getTree` hands out `app` only when it validates, so a page carrying
    // `kind: app` and a map this release cannot read arrives here as a node
    // with no `app` at all. The route refuses it for the same reason, so the
    // two ends agree: the head says the little it knows and the canvas draws
    // the missing-files state rather than a frame onto a 404.
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const withheld = { id: "app1", title: "Trainer", icon: "🃏", kind: "app" as const };
    act(() => {
      root!.render(
        <AppCanvas
          node={withheld as never}
          liveTree={() => []}
          onOpenPage={() => {}}
          onToast={() => {}}
        />,
      );
    });
    await settle();
    expect(host.textContent).toContain("Built by an agent");
    // No timestamp, so no separator left standing on its own beside it.
    expect(host.querySelector("[data-app-built]")).toBeNull();
    expect(host.textContent).toContain(
      "App files are missing. Ask your agent to rebuild the page.",
    );
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("[data-app-rebuild]")).not.toBeNull();
  });

  it("asks for a new address before the one it holds expires", async () => {
    // The token behind the address lasts twelve hours. An app left open
    // longer than that would go on running and then silently fail the first
    // subresource it had not already fetched: inside an opaque-origin frame
    // that reports nothing anywhere, which is the failure mode this whole
    // shape exists to remove.
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(minted(FRAME_SRC, 600));
      const mounted = render();
      await settle();
      expect(mounted.querySelector("iframe")?.getAttribute("src")).toBe(FRAME_SRC);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const next = "/api/app/app1/t/second.token.here/index.html";
      fetchMock.mockResolvedValue(minted(next, 600));
      // Five minutes before it dies, not after.
      await act(async () => {
        await vi.advanceTimersByTimeAsync((600 - 300) * 1000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenLastCalledWith("/api/app/app1/frame", {
        method: "POST",
      });
      expect(mounted.querySelector("iframe")?.getAttribute("src")).toBe(next);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again when the canvas comes back with little time left", async () => {
    // A backgrounded tab's timers are throttled and can be an hour late, so
    // returning to the page is its own moment to check.
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(minted(FRAME_SRC, 120));
      render();
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the address alone while there is plenty of time on it", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(minted(FRAME_SRC, TWELVE_HOURS));
      render();
      await settle();
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries no em-dash in anything a reader sees", async () => {
    expect((await renderReady()).textContent ?? "").not.toContain("—");
  });

  /** WHICH APP THE WRITES BELONG TO IS THIS ONE LINE.
   *
   *  `AppRequest` carries no app id, so the only thing pinning a frame's
   *  writes to the app on screen is the id the canvas hands `createAppWrites`.
   *  Every route under `/api/app-bridge/<appId>/` is built from it, and a
   *  different id here would put one app's pages in another's `owns`. The
   *  relay's own suite proves it builds the path from its argument; nothing
   *  proved which argument arrives. */
  it("builds the write side with the app on screen, not another one", async () => {
    await renderReady();
    expect(writesMock).toHaveBeenCalledWith(node.id, expect.any(Function));
    expect(writesMock.mock.calls.every(([appId]) => appId === node.id)).toBe(true);
  });
});
