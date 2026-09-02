// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hub } from "./hub";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Hub empty state", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query === "(hover: hover)" })),
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("explains the two sidebar items a new notebook shows", async () => {
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={async () => null} />,
      ),
    );
    await settle();

    expect(host.textContent).toContain("Your notebook is empty");
    expect(host.textContent).toContain("Today thoughts opens a page for today");
    expect(host.textContent).toContain("Mail is for a Gmail or IMAP account");
  });
});
