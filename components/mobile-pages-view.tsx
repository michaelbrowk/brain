"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "framer-motion";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import type { TreeNode } from "@/lib/store/types";
import { SPRING_SHEET } from "@/lib/motion";
import { Icon } from "./ui/icon";
import { IconButton } from "./ui/button";
import { ScrollEdge } from "./ui/scroll-edge";
import { useUpdateStatus } from "./settings/use-update-status";

type SearchPage = {
  node: TreeNode;
  path: string;
};

function isVisibleFocusTarget(target: HTMLElement | null): target is HTMLElement {
  return !!(
    target?.isConnected &&
    target.getClientRects().length > 0 &&
    !target.closest('[aria-hidden="true"], [inert]')
  );
}

function searchablePages(tree: TreeNode[]): SearchPage[] {
  const pages: SearchPage[] = [];
  const visit = (nodes: TreeNode[], ancestors: string[]) => {
    for (const node of nodes) {
      if (node.collectionRow) continue;
      pages.push({ node, path: ancestors.join(" / ") });
      visit(node.children, [...ancestors, node.title]);
    }
  };
  visit(tree, []);
  return pages;
}

function ancestorIds(tree: TreeNode[], selectedId: string | null): string[] {
  if (!selectedId) return [];
  const visit = (nodes: TreeNode[], parents: string[]): string[] | null => {
    for (const node of nodes) {
      if (node.collectionRow) continue;
      if (node.id === selectedId) return parents;
      const found = visit(node.children, [...parents, node.id]);
      if (found) return found;
    }
    return null;
  };
  return visit(tree, []) ?? [];
}

export function MobilePagesView({
  open,
  tree,
  selectedId,
  footer,
  nestedOverlay,
  returnFocusRef,
  fallbackFocusRef,
  nestedModalOpen,
  onClose,
  onOpenSettings,
  onSelect,
}: {
  open: boolean;
  tree: TreeNode[];
  selectedId: string | null;
  footer: ReactNode;
  nestedOverlay?: ReactNode;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  nestedModalOpen: boolean;
  onClose: () => void;
  onOpenSettings: (invoker: HTMLElement) => void;
  onSelect: (id: string) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => {
      if (desktop.matches) onClose();
    };
    closeOnDesktop();
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [onClose, open]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !nestedModalOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          data-testid="mobile-pages-view"
          aria-modal="true"
          onPointerDownOutside={(event) => {
            if (nestedModalOpen) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (nestedModalOpen) event.preventDefault();
          }}
          className="brain-mobile-pages fixed inset-0 z-[calc(var(--z-drawer)-21)] outline-none md:hidden"
          onOpenAutoFocus={(event) => {
            // Opening the sheet must not raise the keyboard (hub.tsx
            // precedent: autofocus is a desktop convenience, and this
            // surface is touch-only). Focus the sheet itself — the search
            // field focuses only on an explicit tap.
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus({
              preventScroll: true,
            });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const closingSurface = event.currentTarget as HTMLElement;
            // A nested surface can outlive Pages when the viewport crosses to
            // desktop. Let that surface keep focus instead of stealing it back
            // to the now-hidden page or main content.
            if (nestedModalOpen) return;
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                // Browser Back can remount Pages while a nested Settings sheet
                // closes. Settings already restored focus to its gear in the
                // replacement surface; this stale close callback must not move
                // focus again to the bottom navigation tab.
                const replacementPagesSurface = Array.from(
                  document.querySelectorAll<HTMLElement>(
                    '[data-testid="mobile-pages-view"]',
                  ),
                ).find(
                  (surface) =>
                    surface !== closingSurface && isVisibleFocusTarget(surface),
                );
                if (replacementPagesSurface) return;
                const currentPagesTab = Array.from(
                  document.querySelectorAll<HTMLButtonElement>(
                    '[data-mobile-tab="pages"]',
                  ),
                ).find(isVisibleFocusTarget);
                const target = currentPagesTab ?? returnFocusRef.current;
                if (isVisibleFocusTarget(target)) {
                  target.focus({ preventScroll: true });
                  return;
                }
                const fallback = fallbackFocusRef.current;
                if (isVisibleFocusTarget(fallback)) {
                  fallback.focus({ preventScroll: true });
                }
              });
            });
          }}
        >
          <Dialog.Title className="sr-only">Pages</Dialog.Title>
          <Dialog.Description className="sr-only">
            Browse, search, and open your pages.
          </Dialog.Description>
          <PagesSheet>
            <MobilePagesSurface
              tree={tree}
              selectedId={selectedId}
              onClose={onClose}
              onOpenSettings={onOpenSettings}
              onSelect={onSelect}
            />
            {footer}
          </PagesSheet>
          {nestedOverlay}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The sheet itself: a thick material with the 8px inset over the safe
 *  area, rising on SPRING_SHEET from below (a fade under reduced motion).
 *  Entrance only — Radix unmounts on close, so the tab bar underneath can
 *  take focus the moment Pages is dismissed. */
function PagesSheet({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="brain-mobile-pages-sheet mat-thick"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 48 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.12 } : SPRING_SHEET}
    >
      {children}
    </motion.div>
  );
}

function MobilePagesSurface({
  tree,
  selectedId,
  onClose,
  onOpenSettings,
  onSelect,
}: {
  tree: TreeNode[];
  selectedId: string | null;
  onClose: () => void;
  onOpenSettings: (invoker: HTMLElement) => void;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const update = useUpdateStatus();
  const updateAvailable =
    update.state.kind === "ready" && update.state.status.updateAvailable;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(ancestorIds(tree, selectedId)),
  );
  const pages = useMemo(() => searchablePages(tree), [tree]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results = useMemo(
    () =>
      normalizedQuery
        ? pages.filter(({ node, path }) =>
            `${path} ${node.title}`.toLocaleLowerCase().includes(normalizedQuery),
          )
        : [],
    [normalizedQuery, pages],
  );

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section
      aria-label="Pages"
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="brain-mobile-pages-head">
        <button
          type="button"
          onClick={onClose}
          className="tree-row focus-inset brain-touch-hit w-auto justify-self-start"
        >
          <Icon name="alt-arrow-left" size={16} className="text-ink-2" />
          <span className="tree-row-title">Editor</span>
        </button>
        <h1 className="text-h3 text-ink">Pages</h1>
        <IconButton
          size={36}
          data-settings-trigger="mobile-pages"
          aria-label="Settings"
          onClick={(event) => onOpenSettings(event.currentTarget)}
          className="brain-touch-hit relative justify-self-end"
        >
          <Icon name="settings" size={18} />
          {/* The sidebar's Settings row wears this dot on the desktop. The
              phone never shows that row, so the gear carries the same dot at
              the glyph's corner — out of the grid, so the glyph stays put. */}
          {updateAvailable && (
            <span
              role="img"
              aria-label="Update available"
              className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-current"
            />
          )}
        </IconButton>
      </header>

      <label htmlFor={searchId} className="sr-only">
        Search pages
      </label>
      <div className="field field-glass search-capsule shrink-0">
        <Icon name="magnifer" size={16} />
        <input
          id={searchId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search pages"
          className="text-[16px]"
        />
        {query && (
          <IconButton
            size={28}
            aria-label="Clear page search"
            onClick={() => setQuery("")}
          >
            <Icon name="close" size={16} />
          </IconButton>
        )}
      </div>

      <ScrollEdge
        variant="fade"
        className="min-h-0 flex-1 overscroll-contain px-1 pb-2"
      >
        {normalizedQuery ? (
          <div role="list" aria-label="Page search results" className="py-1">
            {results.map(({ node, path }) => (
              <div key={node.id} role="listitem">
                <button
                  type="button"
                  aria-label={`Open ${node.title}`}
                  onClick={() => onSelect(node.id)}
                  className="tree-row focus-inset"
                >
                  <span className="tree-row-glyph" aria-hidden>
                    {node.icon ?? DEFAULT_PAGE_ICON}
                  </span>
                  <span className="tree-row-title">
                    {node.title}
                    {path && (
                      <span className="text-caption ml-2 text-ink-2">{path}</span>
                    )}
                  </span>
                </button>
              </div>
            ))}
            {results.length === 0 && (
              <p className="text-control px-3 py-10 text-center text-ink-2">
                No pages found
              </p>
            )}
          </div>
        ) : (
          <nav aria-label="Page tree" className="py-1">
            {tree
              .filter((node) => !node.collectionRow)
              .map((node) => (
                <MobilePageRow
                  key={node.id}
                  node={node}
                  depth={0}
                  selectedId={selectedId}
                  expanded={expanded}
                  onToggle={toggle}
                  onSelect={onSelect}
                />
              ))}
            {tree.every((node) => node.collectionRow) && (
              <p className="text-control px-3 py-10 text-center text-ink-2">
                No pages yet
              </p>
            )}
          </nav>
        )}
      </ScrollEdge>
    </section>
  );
}

function MobilePageRow({
  node,
  depth,
  selectedId,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const children = node.children.filter((child) => !child.collectionRow);
  const hasChildren = children.length > 0;
  const isOpen = expanded.has(node.id);

  return (
    <>
      <div
        className="tree-row"
        data-selected={node.id === selectedId ? "" : undefined}
        style={{ paddingLeft: 4 + Math.min(depth, 5) * 20 }}
      >
        {node.id === selectedId && (
          <span aria-hidden className="tree-row-capsule" />
        )}
        <button
          type="button"
          aria-label={isOpen ? `Collapse ${node.title}` : `Expand ${node.title}`}
          aria-expanded={hasChildren ? isOpen : undefined}
          disabled={!hasChildren}
          data-leaf={hasChildren ? undefined : ""}
          onClick={() => onToggle(node.id)}
          className="tree-row-toggle brain-touch-min focus-inset"
        >
          <Icon name="alt-arrow-right" size={14} />
        </button>
        <button
          type="button"
          aria-label={`Open ${node.title}`}
          aria-current={node.id === selectedId ? "page" : undefined}
          onClick={() => onSelect(node.id)}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-[7px] text-left focus-inset"
        >
          <span className="tree-row-glyph" aria-hidden>
            {node.icon ?? DEFAULT_PAGE_ICON}
          </span>
          <span className="tree-row-title">{node.title}</span>
        </button>
      </div>
      {hasChildren && isOpen &&
        children.map((child) => (
          <MobilePageRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}
