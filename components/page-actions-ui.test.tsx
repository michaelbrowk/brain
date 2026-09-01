// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionDefinition, CollectionRow } from "@/lib/collections/model";
import type { TreeNode } from "@/lib/store/types";
import { PageActionsMenu } from "./page-actions-menu";
import { PageMoveDialog, getMoveTargets } from "./page-move-dialog";
import { PageRenameDialog } from "./page-rename-dialog";
import { pageMenuActions, type PageMenuHandlers } from "./tree/row-menu";
import {
  claimDialogFocus,
  restoreDialogFocus,
  type DialogFocusLeaseRef,
} from "./ui/dialog-focus-return";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

function node(
  id: string,
  title: string,
  children: TreeNode[] = [],
  extra: Partial<TreeNode> = {},
): TreeNode {
  return {
    id,
    parentId: null,
    title,
    order: id,
    created: "2026-07-13T00:00:00.000Z",
    updated: "2026-07-13T00:00:00.000Z",
    hasChildren: children.length > 0,
    children,
    ...extra,
  };
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function buttonByText(text: string) {
  return [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

function dialogFocusProps(owner = 1) {
  const returnFocusRef: DialogFocusLeaseRef = { current: null };
  return {
    returnFocusRef,
    focusOwner: owner,
    onFocusReturned: () => {},
  };
}

describe("page action UI", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: () => undefined,
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: () => undefined,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((element) => element.remove());
    vi.unstubAllGlobals();
  });

  it("keeps dots and right-click actions on one exact registry", () => {
    const handlers: PageMenuHandlers = {
      pinned: false,
      onAddChild: vi.fn(),
      onTogglePin: vi.fn(),
      onRename: vi.fn(),
      onCopyLink: vi.fn(),
      onDuplicate: vi.fn(),
      onDialogIntent: vi.fn(),
      onMoveRequest: vi.fn(),
      onDelete: vi.fn(),
    };

    const actions = pageMenuActions(handlers);
    expect(actions.map((action) => action.label)).toEqual([
      "New page inside",
      "Pin",
      "Rename",
      "Copy link",
      "Duplicate",
      "Move to…",
      "Move to trash",
    ]);
    expect(actions.at(-1)).toMatchObject({ divider: true, strong: true });
    expect(pageMenuActions({ ...handlers, pinned: true }).map((action) => action.label)).toContain(
      "Unpin",
    );
    expect(
      pageMenuActions({ ...handlers, canAddChild: false }).map((action) => action.label),
    ).not.toContain("New page inside");
    expect(
      pageMenuActions({
        ...handlers,
        deleteLabel: "Remove reference",
        deleteReturnsFocus: true,
      }).at(-1),
    ).toMatchObject({
      label: "Remove reference",
      returnsFocus: true,
    });
  });

  it("keeps a newer dialog type focused when an older dialog finishes closing", () => {
    const returnFocusRef: DialogFocusLeaseRef = { current: null };
    const renameInvoker = document.createElement("button");
    const moveInput = document.createElement("input");
    document.body.append(renameInvoker, moveInput);
    claimDialogFocus(returnFocusRef, 1, renameInvoker, () => null);
    claimDialogFocus(returnFocusRef, 2, moveInput, () => null);
    moveInput.focus();

    const staleEvent = new Event("close", { cancelable: true });
    expect(restoreDialogFocus(staleEvent, returnFocusRef, 1)).toBe(false);
    expect(staleEvent.defaultPrevented).toBe(true);
    expect(returnFocusRef.current?.owner).toBe(2);
    expect(document.activeElement).toBe(moveInput);

    const currentEvent = new Event("close", { cancelable: true });
    expect(restoreDialogFocus(currentEvent, returnFocusRef, 2)).toBe(true);
    expect(document.activeElement).toBe(moveInput);
    expect(returnFocusRef.current).toBeNull();
    renameInvoker.remove();
    moveInput.remove();
  });

  it("uses the safe fallback when the original invoker disconnected", () => {
    const returnFocusRef: DialogFocusLeaseRef = { current: null };
    const disconnected = document.createElement("button");
    const fallback = document.createElement("button");
    document.body.append(fallback);
    claimDialogFocus(returnFocusRef, 1, disconnected, () => fallback);

    expect(
      restoreDialogFocus(
        new Event("close", { cancelable: true }),
        returnFocusRef,
        1,
      ),
    ).toBe(true);
    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });

  it("excludes unsafe move destinations", () => {
    const rowMeta: CollectionRow = {
      version: 1,
      source: "notion",
      databaseId: "1".repeat(32),
      values: { title: { type: "title", value: "Database row" } },
    };
    const definition: CollectionDefinition = {
      version: 1,
      source: "notion",
      databaseId: "1".repeat(32),
      dataSourceId: "2".repeat(32),
      titlePropertyId: "title",
      properties: [{ id: "title", name: "Name", type: "title", position: 0 }],
      views: [{ id: "all", name: "All", type: "table", rowNotionIds: [] }],
      initialViewId: "all",
    };
    const descendant = node("descendant", "Descendant");
    const target = node("target", "Target", [descendant]);
    const collectionRow = node("row", "Database row", [], {
      collectionRow: rowMeta,
    });
    const collectionChild = node("collection-child", "Collection child");
    const collection = node("collection", "Database", [collectionRow, collectionChild], {
      collection: definition,
    });
    const allowed = node("allowed", "Allowed");

    expect(getMoveTargets([target, collection, allowed], "target").map((item) => item.id)).toEqual([
      null,
      "collection-child",
      "allowed",
    ]);
    expect(
      getMoveTargets([target, collection, allowed], "target").find(
        (item) => item.id === "collection-child",
      )?.path,
    ).toBe("Database / Collection child");
  });

  it("keeps the move dialog open and reports an async failure", async () => {
    const onMove = vi.fn().mockRejectedValue(new Error("offline"));
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <PageMoveDialog
          open
          onOpenChange={onOpenChange}
          tree={[node("target", "Target"), node("other", "Other")]}
          pageId="target"
          pageTitle="Target"
          onMove={onMove}
          {...dialogFocusProps()}
        />,
      );
    });

    await click(
      [...document.body.querySelectorAll('[role="treeitem"]')].find(
        (item) => item.textContent?.includes("Other"),
      ) as HTMLElement,
    );
    await click(buttonByText("Move") as HTMLButtonElement);

    expect(onMove).toHaveBeenCalledWith("target", "other", null);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't move this page",
    );
  });

  it("speaks one language now that filing is not a second mode", async () => {
    // The dialog used to swap its title, subtitle, close label and confirm
    // verb when the Inbox opened it with intent="file". That was the only
    // caller, so the branch went with it — one dialog, one wording.
    const onMove = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        <PageMoveDialog
          open
          onOpenChange={() => {}}
          tree={[node("note", "A note"), node("home", "Home")]}
          pageId="note"
          pageTitle="A note"
          onMove={onMove}
          {...dialogFocusProps()}
        />,
      );
    });

    expect(document.body.textContent).toContain("Move page");
    expect(document.body.textContent).toContain("Choose a new parent for A note");
    expect(document.body.textContent).not.toContain("File note");
    expect(buttonByText("File")).toBeUndefined();
    await click(
      [...document.body.querySelectorAll('[role="treeitem"]')].find(
        (item) => item.textContent?.includes("Home"),
      ) as HTMLElement,
    );
    await click(buttonByText("Move") as HTMLButtonElement);

    expect(onMove).toHaveBeenCalledWith("note", "home", null);
  });

  it("collapses branches, clears hidden selection, and keeps busy rows inert", async () => {
    let resolveMove!: () => void;
    const onMove = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveMove = resolve;
      }),
    );
    const leaf = node("leaf", "Leaf", [], { parentId: "branch" });
    const branch = node("branch", "Branch", [leaf]);
    await act(async () => {
      root.render(
        <PageMoveDialog
          open
          onOpenChange={() => {}}
          tree={[node("moving", "Moving"), branch, node("other", "Other")]}
          pageId="moving"
          pageTitle="Moving"
          onMove={onMove}
          {...dialogFocusProps()}
        />,
      );
    });

    await click(document.body.querySelector('[aria-label="Expand Branch"]')!);
    const leafRow = [...document.body.querySelectorAll('[role="treeitem"]')].find(
      (item) => item.textContent?.includes("Leaf"),
    )!;
    await click(leafRow);
    expect(leafRow.getAttribute("aria-selected")).toBe("true");
    await click(document.body.querySelector('[aria-label="Collapse Branch"]')!);
    expect(document.body.querySelector('[aria-label="Collapse Branch"]')).toBeNull();
    expect(buttonByText("Move")?.disabled).toBe(true);

    const branchRow = [...document.body.querySelectorAll('[role="treeitem"]')].find(
      (item) => item.textContent?.includes("Branch"),
    )!;
    await click(branchRow);
    await click(buttonByText("Move")!);
    const otherRow = [...document.body.querySelectorAll('[role="treeitem"]')].find(
      (item) => item.textContent?.includes("Other"),
    )!;
    await click(otherRow);
    expect(branchRow.getAttribute("aria-selected")).toBe("true");
    expect(otherRow.getAttribute("aria-selected")).toBe("false");

    await act(async () => {
      resolveMove();
      await Promise.resolve();
    });
  });

  it("reveals a nested search selection when search is cleared", async () => {
    const leaf = node("leaf", "Deep destination", [], { parentId: "branch" });
    const branch = node("branch", "Collapsed branch", [leaf]);
    await act(async () => {
      root.render(
        <PageMoveDialog
          open
          onOpenChange={() => {}}
          tree={[node("moving", "Moving"), branch, node("other", "Other")]}
          pageId="moving"
          pageTitle="Moving"
          onMove={vi.fn().mockResolvedValue(undefined)}
          {...dialogFocusProps()}
        />,
      );
    });

    const search = document.body.querySelector(
      '[aria-label="Search destinations"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(search, "Deep destination"));
    const leafResult = [...document.body.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent?.includes("Deep destination"),
    )!;
    await click(leafResult);

    await act(async () => inputValue(search, "Other"));
    expect(buttonByText("Move")?.disabled).toBe(true);

    await act(async () => inputValue(search, ""));
    expect(document.body.querySelector('[aria-label="Collapse Collapsed branch"]')).not.toBeNull();
    expect(
      [...document.body.querySelectorAll('[role="treeitem"]')].find(
        (item) => item.textContent?.includes("Deep destination"),
      )?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(buttonByText("Move")?.disabled).toBe(false);
  });

  it("trims and saves a controlled rename draft", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <PageRenameDialog
          open
          onOpenChange={onOpenChange}
          pageId="page-a"
          title="Old title"
          onRename={onRename}
          {...dialogFocusProps()}
        />,
      );
    });
    const input = document.body.querySelector("#page-rename-title") as HTMLInputElement;
    await act(async () => inputValue(input, "  New title  "));
    await click(buttonByText("Save") as HTMLButtonElement);

    expect(onRename).toHaveBeenCalledWith("page-a", "New title");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("exposes appearance and file actions from the page menu", async () => {
    const onSmallText = vi.fn();
    const onCopyLink = vi.fn();
    const onHistory = vi.fn();
    await act(async () => {
      root.render(
        <PageActionsMenu
          font="sans"
          smallText={false}
          fullWidth={false}
          fullWidthDisabled
          onFont={() => {}}
          onSmallText={onSmallText}
          onFullWidth={() => {}}
          onPin={() => {}}
          onCopyLink={onCopyLink}
          onDuplicate={() => {}}
          onDialogIntent={() => {}}
          onMove={() => {}}
          onExportPdf={() => {}}
          onExportMarkdown={() => {}}
          onHistory={onHistory}
          onTrash={() => {}}
        >
          <button>Page actions</button>
        </PageActionsMenu>,
      );
    });

    const trigger = buttonByText("Page actions") as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await settle();

    const labels = [...document.body.querySelectorAll('[role^="menuitem"]')].map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toEqual([
      "Heading font",
      "Small text",
      "Full width",
      "Copy link",
      "Duplicate",
      "Move to…",
      "Export PDF",
      "Export Markdown",
      "Version history",
      "Move to trash",
    ]);
    expect(
      [...document.body.querySelectorAll('[role="menuitemcheckbox"]')].find(
        (item) => item.textContent?.trim() === "Full width",
      )?.getAttribute("aria-disabled"),
    ).toBe("true");

    const smallTextItem = [...document.body.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (item) => item.textContent?.trim() === "Small text",
    ) as HTMLElement;
    await click(smallTextItem);
    expect(onSmallText).toHaveBeenCalledWith(true);

    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await settle();
    const historyItem = [...document.body.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Version history",
    ) as HTMLElement;
    await click(historyItem);
    await vi.waitFor(() => expect(onHistory).toHaveBeenCalledWith(trigger));
  });

  it("invalidates History before the deferred Move callback", async () => {
    const onDialogIntent = vi.fn();
    const onMove = vi.fn();
    await act(async () => {
      root.render(
        <PageActionsMenu
          font="sans"
          smallText={false}
          fullWidth={false}
          onFont={() => {}}
          onSmallText={() => {}}
          onFullWidth={() => {}}
          onPin={() => {}}
          onCopyLink={() => {}}
          onDuplicate={() => {}}
          onDialogIntent={onDialogIntent}
          onMove={onMove}
          onExportPdf={() => {}}
          onExportMarkdown={() => {}}
          onHistory={() => {}}
          onTrash={() => {}}
        >
          <button>Page actions</button>
        </PageActionsMenu>,
      );
    });

    const trigger = buttonByText("Page actions") as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await settle();
    const moveItem = [...document.body.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Move to…",
    ) as HTMLElement;
    await act(async () => {
      moveItem.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      expect(onDialogIntent).toHaveBeenCalledTimes(1);
      expect(onMove).not.toHaveBeenCalled();
    });
    await vi.waitFor(() => expect(onMove).toHaveBeenCalledWith(trigger));
  });
});
