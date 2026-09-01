"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useRef, useState } from "react";
import type { TreeNode } from "@/lib/store/types";
import { Button } from "./ui/button";
import {
  restoreDialogFocus,
  type DialogFocusLeaseRef,
} from "./ui/dialog-focus-return";
import { Field } from "./ui/field";
import { Icon } from "./ui/icon";
import { DialogBody, DialogHeader } from "./ui/dialog-header";

export const MOVE_BLOCKED_MESSAGE = "Save a copy first.";

export interface MoveTarget {
  id: string | null;
  title: string;
  icon?: string;
  depth: number;
  path: string;
  parentId?: string | null;
  hasChildren?: boolean;
}

interface MoveTargetNode extends MoveTarget {
  id: string;
  parentId: string | null;
  hasChildren: boolean;
  children: MoveTargetNode[];
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children, id);
    if (child) return child;
  }
  return null;
}

function collectIds(node: TreeNode, ids: Set<string>) {
  ids.add(node.id);
  for (const child of node.children) collectIds(child, ids);
}

function findPath(nodes: TreeNode[], id: string): TreeNode[] {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const childPath = findPath(node.children, id);
    if (childPath.length) return [node, ...childPath];
  }
  return [];
}

function buildMoveTargetTree(
  tree: TreeNode[],
  targetId: string,
): MoveTargetNode[] {
  const blocked = new Set<string>([targetId]);
  const target = findNode(tree, targetId);
  if (target) collectIds(target, blocked);

  const walk = (
    nodes: TreeNode[],
    depth: number,
    parents: string[],
    parentId: string | null,
  ): MoveTargetNode[] =>
    nodes.flatMap((node) => {
      if (blocked.has(node.id)) {
        return [];
      }
      const path = [...parents, node.title];
      // Collections are structural containers, not valid manual-move targets.
      // Their normal page children must remain reachable, so flatten only the
      // container row while preserving its title in search breadcrumbs.
      if (node.collection || node.collectionRow) {
        return walk(node.children, depth, path, parentId);
      }
      const children = walk(node.children, depth + 1, path, node.id);
      return [{
        id: node.id,
        title: node.title,
        icon: node.icon,
        depth,
        path: path.join(" / "),
        parentId,
        hasChildren: children.length > 0,
        children,
      }];
    });

  return walk(tree, 0, [], null);
}

function flattenTargetTree(
  nodes: MoveTargetNode[],
  expanded?: Set<string>,
): MoveTargetNode[] {
  const output: MoveTargetNode[] = [];
  for (const node of nodes) {
    output.push(node);
    if (!expanded || expanded.has(node.id)) {
      output.push(...flattenTargetTree(node.children, expanded));
    }
  }
  return output;
}

function findMoveTargetPath(
  nodes: MoveTargetNode[],
  id: string,
): MoveTargetNode[] {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const childPath = findMoveTargetPath(node.children, id);
    if (childPath.length) return [node, ...childPath];
  }
  return [];
}

/** Pure target builder used by the dialog and its safety tests. */
export function getMoveTargets(tree: TreeNode[], targetId: string): MoveTarget[] {
  return [
    { id: null, title: "Top level", depth: 0, path: "Top level" },
    ...flattenTargetTree(buildMoveTargetTree(tree, targetId)),
  ];
}

export interface PageMoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tree: TreeNode[];
  pageId: string;
  pageTitle: string;
  onMove: (id: string, parentId: string | null, beforeId: null) => Promise<void>;
  returnFocusRef: DialogFocusLeaseRef;
  focusOwner: number;
  onFocusReturned: (owner: number) => void;
}

export function PageMoveDialog(props: PageMoveDialogProps) {
  return <OpenPageMoveDialog key={props.open ? "open" : "closed"} {...props} />;
}

function OpenPageMoveDialog({
  open,
  onOpenChange,
  tree,
  pageId,
  pageTitle,
  onMove,
  returnFocusRef,
  focusOwner,
  onFocusReturned,
}: PageMoveDialogProps) {
  const currentParentId = useMemo(
    () => findNode(tree, pageId)?.parentId ?? null,
    [tree, pageId],
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null | undefined>(
    currentParentId,
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const currentPath = currentParentId
      ? findPath(tree, currentParentId).map((node) => node.id)
      : [];
    return new Set(currentPath.slice(0, -1));
  });
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetTree = useMemo(
    () => buildMoveTargetTree(tree, pageId),
    [tree, pageId],
  );
  const allTargets = useMemo(
    () => flattenTargetTree(targetTree),
    [targetTree],
  );
  const visibleTargets = useMemo(
    () => flattenTargetTree(targetTree, expanded),
    [targetTree, expanded],
  );
  const shown = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return visibleTargets;
    return allTargets.filter((target) =>
      target.path.toLocaleLowerCase().includes(normalized),
    );
  }, [allTargets, query, visibleTargets]);
  const selectedVisible =
    selectedId === null ||
    (selectedId !== undefined && shown.some((target) => target.id === selectedId));

  const updateQuery = (nextQuery: string) => {
    if (
      query.trim() &&
      !nextQuery.trim() &&
      selectedId !== undefined &&
      selectedId !== null
    ) {
      const selectedPath = findMoveTargetPath(targetTree, selectedId);
      setExpanded((current) => {
        const next = new Set(current);
        for (const ancestor of selectedPath.slice(0, -1)) next.add(ancestor.id);
        return next;
      });
    }
    setQuery(nextQuery);
  };

  const focusRow = (id: string) => {
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  const toggleBranch = (target: MoveTargetNode) => {
    if (busy) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(target.id)) {
        next.delete(target.id);
        if (
          selectedId !== undefined &&
          selectedId !== null &&
          flattenTargetTree(target.children).some(
            (child) => child.id === selectedId,
          )
        ) {
          setSelectedId(undefined);
        }
      } else {
        next.add(target.id);
      }
      return next;
    });
  };

  const onTreeKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    target: MoveTargetNode,
  ) => {
    if (busy) return;
    const index = shown.findIndex((candidate) => candidate.id === target.id);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = shown[Math.max(0, Math.min(shown.length - 1, index + direction))];
      if (next) focusRow(next.id);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? shown[0] : shown.at(-1);
      if (next) focusRow(next.id);
      return;
    }
    if (!query && event.key === "ArrowRight" && target.hasChildren) {
      event.preventDefault();
      if (!expanded.has(target.id)) toggleBranch(target);
      else if (target.children[0]) focusRow(target.children[0].id);
      return;
    }
    if (!query && event.key === "ArrowLeft") {
      event.preventDefault();
      if (expanded.has(target.id)) toggleBranch(target);
      else if (target.parentId) focusRow(target.parentId);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedId(target.id);
    }
  };

  const commit = async () => {
    if (
      selectedId === undefined ||
      !selectedVisible ||
      selectedId === currentParentId ||
      busy
    ) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(pageId, selectedId, null);
      onOpenChange(false);
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message === MOVE_BLOCKED_MESSAGE
          ? MOVE_BLOCKED_MESSAGE
          : "Couldn't move this page. Try again.",
      );
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            restoreDialogFocus(event, returnFocusRef, focusOwner);
            onFocusReturned(focusOwner);
          }}
          className="brain-dialog brain-sheet fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[80dvh] w-[min(calc(100vw-2rem),480px)] flex-col overflow-hidden outline-none"
        >
          <DialogHeader
            title="Move page"
            subtitle={<>Choose a new parent for {pageTitle}</>}
            closeLabel="Close move dialog"
            closeDisabled={busy}
          />

          {/* the field atom on glass (an ink fill, never a second material)
              at the rows' own 10px inset, so its glyph stands on the
              header's rule; no hairline under it — the body is the fade
              scroller. Rows are `.brain-dialog-row` (globals.css): r10 at
              the sheet's padding 10, the tree row's glyph and title. */}
          <div className="shrink-0 px-2.5 pb-1">
            <Field
              on="glass"
              icon="magnifer"
              aria-label="Search destinations"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              placeholder="Search pages"
              disabled={busy}
            />
          </div>

          <DialogBody className="p-2.5">
            <button
              type="button"
              aria-pressed={selectedId === null}
              disabled={busy}
              onClick={() => setSelectedId(null)}
              className="brain-dialog-row focus-inset brain-touch-min mb-1 w-full pl-2.5 pr-2"
            >
              <span className="tree-row-glyph" aria-hidden>
                <Icon name="hashtag" size={16} />
              </span>
              <span className="tree-row-title">Top level</span>
              {selectedId === null && (
                <Icon name="check" size={16} className="shrink-0 text-ink-2" />
              )}
            </button>
            <div
              role={query ? "listbox" : "tree"}
              aria-label="Move destinations"
            >
            {shown.map((target, index) => {
              const selected = selectedId === target.id;
              const searching = query.trim().length > 0;
              return (
                <div
                  key={target.id}
                  ref={(element) => {
                    if (element) rowRefs.current.set(target.id, element);
                    else rowRefs.current.delete(target.id);
                  }}
                  role={searching ? "option" : "treeitem"}
                  aria-level={searching ? undefined : target.depth + 1}
                  aria-expanded={
                    searching || !target.hasChildren
                      ? undefined
                      : expanded.has(target.id)
                  }
                  aria-selected={selected}
                  aria-disabled={busy || undefined}
                  tabIndex={index === 0 ? 0 : -1}
                  onClick={() => {
                    if (!busy) setSelectedId(target.id);
                  }}
                  onKeyDown={(event) => onTreeKeyDown(event, target)}
                  className="brain-dialog-row focus-inset brain-touch-min w-full pr-2"
                  style={{ paddingLeft: searching ? 10 : 10 + target.depth * 20 }}
                >
                  {!searching && (
                    <button
                      type="button"
                      aria-label={
                        expanded.has(target.id)
                          ? `Collapse ${target.title}`
                          : `Expand ${target.title}`
                      }
                      aria-expanded={
                        target.hasChildren ? expanded.has(target.id) : undefined
                      }
                      data-leaf={target.hasChildren ? undefined : ""}
                      disabled={busy || !target.hasChildren}
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleBranch(target);
                      }}
                      className="tree-row-toggle focus-inset brain-touch-min"
                    >
                      <Icon name="alt-arrow-right" size={13} />
                    </button>
                  )}
                  <span className="tree-row-glyph" aria-hidden>
                    {target.icon ?? <Icon name="hashtag" size={16} />}
                  </span>
                  <span className="tree-row-title">
                    <span className="block truncate">{target.title}</span>
                    {searching && target.path !== target.title && (
                      <span className="text-caption block truncate font-normal text-ink-2">
                        {target.path}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <Icon name="check" size={16} className="shrink-0 text-ink-2" />
                  )}
                </div>
              );
            })}
            {shown.length === 0 && (
              <p className="text-control px-3 py-8 text-center text-ink-2">
                No pages found
              </p>
            )}
            </div>
          </DialogBody>

          <div className="px-5 pb-4 pt-3">
            {error && (
              <p role="alert" className="mb-2 text-[12px] text-ink-2">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="quiet"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="ink"
                disabled={
                  selectedId === undefined ||
                  !selectedVisible ||
                  selectedId === currentParentId ||
                  busy
                }
                onClick={commit}
              >
                {busy ? "Moving…" : "Move"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
