// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onMailCommand, type MailCommand } from "./mail-commands";
import { CommandPalette } from "./command-palette";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const MAIL_LABELS = [
  "Compose message",
  "Go to Inbox",
  "Go to Starred",
  "Go to Unread",
  "Go to Lists",
  "Go to People",
  "Go to Attachments",
  "Go to Drafts",
];

function mailGroup(): HTMLElement | null {
  return (
    [...document.body.querySelectorAll("[cmdk-group]")].find(
      (group) =>
        group.querySelector("[cmdk-group-heading]")?.textContent === "Mail",
    ) ?? null
  ) as HTMLElement | null;
}

describe("CommandPalette mail commands", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    onOpenChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ hits: [] }),
      } as Response),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
  });

  async function renderPalette() {
    await act(async () =>
      root.render(
        <CommandPalette
          open
          onOpenChange={onOpenChange}
          tree={[]}
          onSelect={vi.fn()}
          hasCurrent={false}
          onOpenMail={vi.fn()}
        />,
      ),
    );
  }

  it("shows the Mail group only while Mail is the open route", async () => {
    window.history.replaceState({}, "", "/mail");
    await renderPalette();

    const group = mailGroup();
    expect(group).not.toBeNull();
    for (const label of MAIL_LABELS) {
      expect(group!.textContent).toContain(label);
    }
  });

  it("hides the Mail group on any other route", async () => {
    window.history.replaceState({}, "", "/");
    await renderPalette();

    expect(mailGroup()).toBeNull();
    // The generic Open Mail action still exists outside the group.
    expect(document.body.textContent).toContain("Open Mail");
  });

  it("emits the command on the bus and closes the palette", async () => {
    window.history.replaceState({}, "", "/mail");
    const received: MailCommand[] = [];
    const unsubscribe = onMailCommand((command) => received.push(command));
    await renderPalette();

    const item = [...mailGroup()!.querySelectorAll("[cmdk-item]")].find(
      (candidate) => candidate.textContent?.includes("Go to Lists"),
    ) as HTMLElement;
    await act(async () => item.click());

    expect(received).toEqual(["goto-lists"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    unsubscribe();
  });
});
