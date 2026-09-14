// @vitest-environment jsdom

// The preflight card is the one screen between a reader and an import. It
// reports what the archive holds, and an archive now holds task records as
// well as pages and attachments. A count the card leaves out is a thing the
// reader is about to import without being told.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSection } from "./data-section";

vi.mock("../backup-status", () => ({
  BackupStatusPanel: () => null,
}));
vi.mock("./notes-status", () => ({
  NotesStatusPanel: () => null,
}));

const SUMMARY = {
  title: "Brain archive",
  pages: 12,
  rootPages: 3,
  attachments: 4,
  attachmentBytes: 2048,
  collections: 1,
  tasks: 7,
};

describe("DataSection preflight card", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
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

  async function dryRun(summary: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ summary }),
      })),
    );
    await act(async () => root.render(<DataSection onToast={() => {}} />));
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("the archive picker is not rendered");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["x"], "brain.tgz")],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("counts the tasks the archive carries beside its pages and attachments", async () => {
    await dryRun(SUMMARY);

    const card = host.querySelector<HTMLElement>(".brain-settings-row[data-stack]");
    expect(card).not.toBeNull();
    const counts = card!.querySelector<HTMLElement>(".text-caption");
    expect(counts?.textContent).toBe("12 pages · 7 tasks · 4 attachments · 2 KB");
  });

  it("says zero rather than nothing for an archive written before tasks existed", async () => {
    // A version 1 archive carries no `tasks` key at all, and the route
    // answers 0 for it. A row that vanished would read as "unknown".
    await dryRun({ ...SUMMARY, tasks: 0 });

    const card = host.querySelector<HTMLElement>(".brain-settings-row[data-stack]");
    expect(card!.querySelector(".text-caption")?.textContent).toContain("0 tasks");
  });
});
