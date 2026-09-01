// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CollectionDefinition,
  CollectionRow,
} from "@/lib/collections/model";
import type { TreeNode } from "@/lib/store/types";
import {
  CollectionRowProperties,
  CollectionView,
  orderCollectionRows,
} from "./collection-view";

const DATABASE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DATA_SOURCE_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const definition: CollectionDefinition = {
  version: 1,
  source: "notion",
  databaseId: DATABASE_ID,
  dataSourceId: DATA_SOURCE_ID,
  titlePropertyId: "title",
  properties: [
    { id: "title", name: "Name", position: 0, type: "title" },
    { id: "date", name: "Date", position: 1, type: "date" },
    {
      id: "status",
      name: "Status",
      position: 2,
      type: "select",
      options: [
        { id: "good", name: "Good", color: "green" },
        { id: "bad", name: "Bad", color: "red" },
      ],
    },
    {
      id: "tags",
      name: "Tags",
      position: 3,
      type: "multi_select",
      options: [
        { id: "design", name: "Design", color: "blue" },
        { id: "writing", name: "Writing", color: "purple" },
      ],
    },
    { id: "owner", name: "Owner", position: 4, type: "people" },
    {
      id: "verification",
      name: "Verification",
      position: 5,
      type: "verification",
    },
    {
      id: "edited",
      name: "Last edited",
      position: 6,
      type: "last_edited_time",
      readOnly: true,
    },
  ],
  views: [
    {
      id: "table",
      name: "All pages",
      type: "table",
      rowNotionIds: [
        "22222222-2222-2222-2222-222222222222",
        "11111111111111111111111111111111",
      ],
    },
    {
      id: "board",
      name: "By status",
      type: "board",
      rowNotionIds: [
        "22222222222222222222222222222222",
        "11111111111111111111111111111111",
      ],
      groupBy: {
        propertyId: "status",
        manualOptionIds: ["bad", "good"],
        hideEmptyGroups: true,
      },
    },
  ],
  initialViewId: "table",
};

function rowValues({
  title,
  status,
}: {
  title: string;
  status: "good" | "bad" | null;
}): CollectionRow {
  return {
    version: 1,
    source: "notion",
    databaseId: DATABASE_ID,
    values: {
      title: { type: "title", value: title },
      date: {
        type: "date",
        value: {
          start: "2026-07-11",
          end: "2026-07-12",
          timeZone: "America/Los_Angeles",
        },
      },
      status: {
        type: "select",
        value: status
          ? {
              id: status,
              name: status === "good" ? "Good" : "Bad",
              color: status === "good" ? "green" : "red",
            }
          : null,
      },
      tags: {
        type: "multi_select",
        value: [
          { id: "design", name: "Design", color: "blue" },
          { id: "writing", name: "Writing", color: "purple" },
        ],
      },
      owner: {
        type: "people",
        value: [{ id: "person-1", name: "Dana Rowe" }],
      },
      verification: {
        type: "verification",
        value: {
          state: "verified",
          verifiedBy: { id: "person-1", name: "Dana Rowe" },
        },
      },
      edited: {
        type: "last_edited_time",
        value: "2026-07-12T02:49:00Z",
      },
    },
  };
}

function rowNode({
  id,
  notionId,
  title,
  sourceTitle,
  status,
}: {
  id: string;
  notionId: string;
  title: string;
  sourceTitle: string;
  status: "good" | "bad" | null;
}): TreeNode {
  return {
    id,
    parentId: "collection",
    title,
    notionId,
    collectionRow: rowValues({ title: sourceTitle, status }),
    order: id,
    created: "2026-07-11T00:00:00Z",
    updated: "2026-07-12T00:00:00Z",
    hasChildren: false,
    children: [],
  };
}

const first = rowNode({
  id: "first",
  notionId: "11111111111111111111111111111111",
  title: "Renamed in Brain",
  sourceTitle: "Original source title",
  status: "good",
});
const second = rowNode({
  id: "second",
  notionId: "22222222222222222222222222222222",
  title: "Untitled",
  sourceTitle: "",
  status: "bad",
});
const extra = rowNode({
  id: "extra",
  notionId: "33333333333333333333333333333333",
  title: "Safe extra",
  sourceTitle: "Safe extra",
  status: null,
});

const collectionNode: TreeNode = {
  id: "collection",
  parentId: null,
  title: "Collection",
  collection: definition,
  order: "a",
  created: "2026-07-11T00:00:00Z",
  updated: "2026-07-12T00:00:00Z",
  hasChildren: true,
  children: [first, second, extra],
};

describe("CollectionView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("uses source order, accepts dashed ids, and safely appends extra rows", () => {
    const ordered = orderCollectionRows(
      collectionNode,
      definition,
      definition.views[0],
    );
    expect(ordered.map((row) => row.id)).toEqual(["second", "first", "extra"]);
  });

  it("does not append rows that a filtered source view intentionally omits", () => {
    const filtered = {
      ...definition.views[0],
      rowNotionIds: [],
      filter: { kind: "today" as const, propertyId: "date" },
    };

    expect(
      orderCollectionRows(collectionNode, definition, filtered),
    ).toEqual([]);
  });

  it("renders a scrollable table with current Brain titles and all property types", async () => {
    const onSelect = vi.fn();
    await act(async () =>
      root.render(<CollectionView node={collectionNode} onSelect={onSelect} />),
    );

    const tableRegion = container.querySelector('[role="region"]');
    expect(tableRegion?.className).toContain("overflow-x-auto");
    const rowButtons = [...container.querySelectorAll("tbody button")];
    expect(rowButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open Untitled",
      "Open Renamed in Brain",
      "Open Safe extra",
    ]);
    expect(container.querySelector('[data-empty-title="true"]')?.textContent).toBe(
      "Untitled",
    );
    expect(container.textContent).toContain("Jul 11, 2026 to Jul 12, 2026");
    expect(container.textContent).toContain("Design");
    expect(container.textContent).toContain("Writing");
    expect(container.textContent).toContain("Dana Rowe");
    expect(container.textContent).toContain("Verified by Dana Rowe");
    expect(container.textContent).toContain("Jul 12, 2026, 2:49 AM UTC");
    expect(second.collectionRow?.values.title).toEqual({
      type: "title",
      value: "",
    });

    await act(async () => (rowButtons[1] as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith("first");
  });

  it("switches to a neutral board and preserves manual group order", async () => {
    const onSelect = vi.fn();
    await act(async () =>
      root.render(<CollectionView node={collectionNode} onSelect={onSelect} />),
    );

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "board";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const groups = [...container.querySelectorAll("[data-collection-group]")];
    expect(groups.map((group) => group.querySelector("h3")?.textContent)).toEqual([
      "Bad",
      "Good",
      "No Status",
    ]);
    expect(
      groups.map((group) => group.querySelector("button")?.getAttribute("aria-label")),
    ).toEqual(["Open Untitled", "Open Renamed in Brain", "Open Safe extra"]);

    await act(async () =>
      (groups[2].querySelector("button") as HTMLButtonElement).click(),
    );
    expect(onSelect).toHaveBeenCalledWith("extra");
  });

  it("shows source properties without repeating the editable title", async () => {
    await act(async () =>
      root.render(
        <CollectionRowProperties
          definition={definition}
          row={first.collectionRow as CollectionRow}
        />,
      ),
    );

    const propertyList = container.querySelector('[aria-label="Collection properties"]');
    expect(propertyList?.className).toContain("overflow-x-auto");
    expect(container.querySelector("dt")?.textContent).toBe("Date");
    expect(container.textContent).not.toContain("Original source title");
    expect(container.textContent).toContain("Good");
    expect(container.textContent).toContain("Verified by Dana Rowe");
  });
});
