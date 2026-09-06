// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { SharingSection } from "./sharing-section";

function shared(values: Partial<TreeNode> & { id: string; title: string }): TreeNode {
  return {
    parentId: null,
    order: values.id,
    created: "2026-09-01T00:00:00.000Z",
    updated: "2026-09-01T00:00:00.000Z",
    public: true,
    hasChildren: false,
    children: [],
    ...values,
  };
}

describe("SharingSection badges", () => {
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
  });

  async function render(tree: TreeNode[]) {
    await act(async () =>
      root.render(<SharingSection tree={tree} onUnshare={() => {}} />),
    );
  }

  function badges(title: string) {
    const row = [...host.querySelectorAll(".brain-settings-row")].find((candidate) =>
      candidate.textContent?.includes(title),
    );
    return [...(row?.querySelectorAll(".brain-settings-badge") ?? [])].map(
      (badge) => badge.textContent,
    );
  }

  it("marks a link that admits writes, and leaves a read-only one bare", async () => {
    await render([
      shared({ id: "a", title: "Editable page", shareEdit: true }),
      shared({ id: "b", title: "Read-only page" }),
    ]);

    expect(badges("Editable page")).toEqual(["Editable"]);
    expect(badges("Read-only page")).toEqual([]);
  });

  it("says both when an editable link has also expired", async () => {
    await render([
      shared({
        id: "a",
        title: "Editable page",
        shareEdit: true,
        shareExpiresAt: "2020-01-01T00:00:00.000Z",
      }),
    ]);

    expect(badges("Editable page")).toEqual(["Expired", "Editable"]);
  });
});
