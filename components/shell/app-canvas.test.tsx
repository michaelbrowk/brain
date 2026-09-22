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

function render() {
  host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host as HTMLDivElement).render(
      <AppCanvas node={node as never} liveTree={() => []} onOpenPage={() => {}} onToast={() => {}} />,
    );
  });
  return host;
}

/** Mounts and drains the preflight, so a case reads the canvas in the state
 *  it settles into rather than the one frame before it. */
async function renderReady() {
  const mounted = render();
  await settle();
  return mounted;
}

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

  it("keeps the phone's tab bar reserve under the frame", async () => {
    const shell = (await renderReady()).querySelector("[data-app-canvas]") as HTMLElement;
    expect(shell.className).toContain("brain-app-canvas");
  });

  it("carries no em-dash in anything a reader sees", async () => {
    expect((await renderReady()).textContent ?? "").not.toContain("—");
  });
});
