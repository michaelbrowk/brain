// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_FRAME_SANDBOX } from "@/lib/apps/csp";
import { apiFetch } from "@/lib/client";
import { AppCanvas } from "./app-canvas";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

// The factory is hoisted above every const in this file, so the double is
// made inside it and read back through `vi.mocked`, as the shell's own DOM
// contract does.
vi.mock("@/lib/client", () => ({ apiFetch: vi.fn(), CLIENT_ID: "test-client" }));
const fetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
});

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

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function render(onToast: (text: string) => void = () => {}) {
  host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host as HTMLDivElement).render(
      <AppCanvas
        node={node as never}
        liveTree={() => []}
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
  it("asks whether the files are there before it mounts a frame", async () => {
    render();
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/app/app1/index.html", { method: "HEAD" });
  });

  it("says so, and offers Rebuild, when the entry is missing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
    const host = render();
    await settle();
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("App files are missing. Ask your agent to rebuild the page.");
    expect(host.querySelector("[data-app-rebuild]")).not.toBeNull();
  });

  it("mounts the frame at the app's own address, sandboxed", async () => {
    const frame = (await renderReady()).querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/api/app/app1/index.html");
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

  it("draws a page whose app map the tree withheld, without inventing one", async () => {
    // `getTree` hands out `app` only when it validates, so a page carrying
    // `kind: app` and a map this release cannot read arrives here as a node
    // with no `app` at all. The route refuses it for the same reason, so the
    // two ends agree: the head says the little it knows and the canvas draws
    // the missing-files state rather than a frame onto a 404.
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
    host = document.createElement("div");
    document.body.append(host);
    const withheld = { id: "app1", title: "Trainer", icon: "🃏", kind: "app" as const };
    act(() => {
      createRoot(host as HTMLDivElement).render(
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

  it("carries no em-dash in anything a reader sees", async () => {
    expect((await renderReady()).textContent ?? "").not.toContain("—");
  });
});
