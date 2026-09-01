// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import {
  BRAIN_PAGE_REF_DRAG_MIME,
  encodePageRefDragPayload,
  type ReparentPageRef,
} from "../editor/page-ref-nesting";
import { SortableTree, type TreeHandlers } from "./sortable-tree";

const activeDrag = vi.hoisted(() => ({
  source: null as { id: string; occurrence: number } | null,
}));

vi.mock("../editor/page-ref-nesting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../editor/page-ref-nesting")>();
  return {
    ...actual,
    getActivePageRefDragSource: () => activeDrag.source,
  };
});

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  DragOverlay: ({ children }: { children: ReactNode }) => children,
  MouseSensor: class {},
  TouchSensor: class {},
  closestCenter: vi.fn(() => []),
  pointerWithin: vi.fn(() => []),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Translate: { toString: () => undefined } },
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

vi.mock("./row-menu", () => ({
  PageContextMenu: ({ children }: { children: ReactNode }) => children,
  RowMenu: ({ children }: { children: ReactNode }) => children,
}));

function node(
  id: string,
  parentId: string | null,
  children: TreeNode[] = [],
): TreeNode {
  return {
    id,
    parentId,
    title: id,
    order: id,
    created: "2026-08-03T00:00:00.000Z",
    updated: "2026-08-03T00:00:00.000Z",
    hasChildren: children.length > 0,
    children,
  };
}

function nativeDragEvent(type: "dragover" | "drop", payload: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = {
    types: [BRAIN_PAGE_REF_DRAG_MIME],
    getData: vi.fn(() => payload),
    dropEffect: "none",
  };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return { event, dataTransfer };
}

describe("sidebar native page-ref drop preflight", () => {
  let host: HTMLDivElement;
  let root: Root;
  let handlers: TreeHandlers;
  let onReparentPageRef: ReparentPageRef;
  const source = node("source", "parent");
  const target = node("target", "parent");
  const tree = [node("parent", null, [source, target])];

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    activeDrag.source = { id: "source", occurrence: 0 };
    onReparentPageRef = vi.fn<ReparentPageRef>(() => ({
      operationId: "move-1",
      result: Promise.resolve(true),
    }));
    handlers = {
      selectedId: "parent",
      expanded: new Set(["parent"]),
      pageRefSourcePageId: "parent",
      onSelect: vi.fn(),
      onToggle: vi.fn(),
      onAddChild: vi.fn(),
      onDelete: vi.fn(),
      onRename: vi.fn(),
      onCopyLink: vi.fn(),
      onDuplicate: vi.fn(),
      onDialogIntent: vi.fn(),
      onMoveRequest: vi.fn(),
      onTogglePin: vi.fn(),
      onMove: vi.fn(),
      onReparentPageRef,
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<SortableTree tree={tree} {...handlers} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    activeDrag.source = null;
  });

  it("uses the local drag source while protected dragover data is empty", async () => {
    const row = host.querySelector('[data-tree-page-id="target"]') as HTMLElement;
    const over = nativeDragEvent("dragover", "");
    await act(async () => row.dispatchEvent(over.event));

    expect(over.dataTransfer.getData).not.toHaveBeenCalled();
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("move");
    // the valid target rings in yellow (TreeRow `dropInto`)
    expect(row.hasAttribute("data-drop-into")).toBe(true);

    const drop = nativeDragEvent(
      "drop",
      encodePageRefDragPayload({ id: "source", occurrence: 0 }),
    );
    await act(async () => row.dispatchEvent(drop.event));
    expect(onReparentPageRef).toHaveBeenCalledWith(
      { id: "source", occurrence: 0 },
      "target",
      "tree",
    );
  });

  it("keeps a mismatched active source invalid and never mutates", async () => {
    activeDrag.source = { id: "target", occurrence: 0 };
    const row = host.querySelector('[data-tree-page-id="target"]') as HTMLElement;
    const over = nativeDragEvent("dragover", "");
    await act(async () => row.dispatchEvent(over.event));
    expect(over.event.defaultPrevented).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe("none");
    expect(row.hasAttribute("data-drop-into")).toBe(false);

    const drop = nativeDragEvent(
      "drop",
      encodePageRefDragPayload({ id: "target", occurrence: 0 }),
    );
    await act(async () => row.dispatchEvent(drop.event));
    expect(onReparentPageRef).not.toHaveBeenCalled();
  });
});
