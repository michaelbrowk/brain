// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogFocusLease } from "./ui/dialog-focus-return";
import { PageRefRemoveDialog } from "./page-ref-remove-dialog";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string) {
  return [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  ) as HTMLButtonElement;
}

describe("PageRefRemoveDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let returnTarget: HTMLButtonElement;
  let returnFocusRef: { current: DialogFocusLease | null };

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    returnTarget = document.createElement("button");
    document.body.appendChild(returnTarget);
    returnFocusRef = {
      current: {
        owner: 1,
        target: returnTarget,
        fallback: () => null,
      },
    };
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    returnTarget.remove();
  });

  async function render(
    onRemove: () => Promise<void>,
    targetMissing = false,
  ) {
    await act(async () => {
      root.render(
        <PageRefRemoveDialog
          open
          onOpenChange={() => {}}
          targetTitle="Target"
          sourceTitle="Source"
          targetMissing={targetMissing}
          onRemove={onRemove}
          returnFocusRef={returnFocusRef}
          focusOwner={1}
          onFocusReturned={() => {}}
        />,
      );
    });
  }

  it("states that only the selected reference is removed", async () => {
    await render(async () => {});

    expect(document.body.textContent).toContain(
      "Remove reference to “Target”?",
    );
    expect(document.body.textContent).toContain(
      "This removes only this reference from “Source”. The page itself will stay where it is.",
    );
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it("deduplicates Removing and exposes an honest retry after failure", async () => {
    let reject!: (reason?: unknown) => void;
    const pending = new Promise<void>((_, nextReject) => {
      reject = nextReject;
    });
    const onRemove = vi.fn(() => pending);
    await render(onRemove);

    await act(async () => button("Remove reference").click());
    expect(button("Removing…").disabled).toBe(true);
    await act(async () => button("Removing…").click());
    expect(onRemove).toHaveBeenCalledTimes(1);

    await act(async () => reject(new Error("Page changed. Review it and retry.")));
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Page changed. Review it and retry.",
    );
    expect(button("Retry").disabled).toBe(false);
  });

  it("explains that a broken reference removes only the link", async () => {
    await render(async () => {}, true);

    expect(document.body.textContent).toContain(
      "This removes only this link from “Source”. The referenced page may no longer exist; no page will be changed.",
    );
  });
});
