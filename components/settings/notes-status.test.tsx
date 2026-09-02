// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotesStatusPanel } from "./notes-status";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ready = {
  apiVersion: 1,
  root: "/opt/brain/notes",
  repository: true,
  head: {
    hash: "a".repeat(40),
    at: new Date(Date.now() - 3 * 60_000).toISOString(),
  },
  commitDelaySeconds: 4,
};

describe("NotesStatusPanel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows the folder and the last commit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(ready), { status: 200 })),
    );

    await act(async () => root.render(<NotesStatusPanel />));
    await settle();

    expect(host.textContent).toContain("/opt/brain/notes");
    expect(host.textContent).toContain("Git repository");
    expect(host.textContent).toContain("3m ago");
    expect(host.textContent).toContain("four seconds");
  });

  it("explains a folder that is not a repository yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...ready, repository: false, head: null }),
            { status: 200 },
          ),
      ),
    );

    await act(async () => root.render(<NotesStatusPanel />));
    await settle();

    expect(host.textContent).toContain("first save");
  });

  it("shows an error state with a retry when the route fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );

    await act(async () => root.render(<NotesStatusPanel />));
    await settle();

    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain("Try again");
  });
});
