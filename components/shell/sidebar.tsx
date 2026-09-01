"use client";

// The floating sidebar of the app shell (DESIGN.md v2 → Floating sidebar): a
// thick glass panel 280 wide with the 12px inset — head (wordmark + the one
// ink-filled primary, New page, on every surface that has a create), the
// search capsule, the primary rows, the
// pinned chips, the page tree under an edge-fade, and the foot (Settings /
// Trash / theme). Presentational — every piece of state and every handler
// comes from <Shell> as a prop. Focus mode moves the panel off-canvas on
// SPRING_PANEL (transform only) and reports when the spring settles so the
// shell reflows the canvas offset once (B5).

import { forwardRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { TreeNode } from "@/lib/store/types";
import type { Template } from "@/lib/templates";
import { SPRING_PANEL, SPRING_SELECT } from "@/lib/motion";
import { SIDEBAR_SELECT_LAYOUT_ID } from "./sidebar-select";
import type { ShellSurface } from "./helpers";
import {
  SETTINGS_SECTION_META,
  SETTINGS_SECTION_ORDER,
  type SettingsSection,
} from "../settings/sections";
import { Icon } from "../ui/icon";
import { Kbd } from "../ui/primitives";
import { Button, IconButton } from "../ui/button";
import { Chip } from "../ui/chip";
import { useScrollEdge } from "../ui/scroll-edge";
import { ThemeToggle } from "../theme-toggle";
import { SortableTree, type TreeHandlers } from "../tree/sortable-tree";
import { TemplateMenu } from "../template-menu";
import {
  acceptExternalPageRefNesting,
  BRAIN_PAGE_REF_DRAG_MIME,
  decodePageRefDragPayload,
  getActivePageRefDragSource,
  pageRefDragSourcesMatch,
  type ReparentPageRef,
  validatePageRefNestingTarget,
} from "../editor/page-ref-nesting";

export interface ShellSidebarProps {
  tree: TreeNode[];
  /** The open page: page-ref drag source and the parent for New page. */
  selectedId: string | null;
  /** The row to highlight — the collection root while one of its rows is open. */
  sidebarSelectedId: string | null;
  expanded: Set<string>;
  focusMode: boolean;
  /** Translated off-screen (mobile viewport, focus mode, a mobile surface
   *  open): also out of the tab order and the accessibility tree. */
  offCanvas: boolean;
  /** The slot is contextual: "settings" lists the sections, everything else
   *  is the page tree. Mail used to take it over too, hosting the rail; its
   *  navigation lives in its own column now, so mail is an ordinary
   *  destination here and the tree stays where it was. */
  surface: ShellSurface;
  /** The active settings section (null = the mobile root list). */
  settingsSection: SettingsSection | null;
  onSelectSettingsSection: (section: SettingsSection) => void;
  pinnedPages: Pick<TreeNode, "id" | "title" | "icon">[];
  onGoHome: () => void;
  /** The settings slot's back row: the surface's close semantics —
   *  history.back when entered in-app, else go home. It is the only one left
   *  — mail navigates itself from the head of its own column. */
  onCloseSettings: () => void;
  onOpenPalette: (invoker: HTMLElement) => void;
  onCreatePage: (
    parentId: string | null,
    template?: Template,
  ) => Promise<string | null>;
  onOpenDailyPage: () => void;
  onOpenMail: () => void;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onDelete: TreeHandlers["onDelete"];
  onRename: TreeHandlers["onRename"];
  onCopyLink: TreeHandlers["onCopyLink"];
  onDuplicate: TreeHandlers["onDuplicate"];
  onDialogIntent: TreeHandlers["onDialogIntent"];
  onMoveRequest: TreeHandlers["onMoveRequest"];
  onTogglePin: TreeHandlers["onTogglePin"];
  onMove: TreeHandlers["onMove"];
  onReparentPageRef: ReparentPageRef;
  onPrefetch: (id: string) => void;
  onOpenSettings: () => void;
  onOpenTrash: () => void;
  /** The focus-mode collapse spring settled with the panel off-canvas: the
   *  shell reflows the canvas offset now, once. */
  onCollapsed: () => void;
}

export function ShellSidebar({
  tree,
  selectedId,
  sidebarSelectedId,
  expanded,
  focusMode,
  offCanvas,
  surface,
  settingsSection,
  onSelectSettingsSection,
  pinnedPages,
  onGoHome,
  onCloseSettings,
  onOpenPalette,
  onCreatePage,
  onOpenDailyPage,
  onOpenMail,
  onSelect,
  onToggleExpand,
  onDelete,
  onRename,
  onCopyLink,
  onDuplicate,
  onDialogIntent,
  onMoveRequest,
  onTogglePin,
  onMove,
  onReparentPageRef,
  onPrefetch,
  onOpenSettings,
  onOpenTrash,
  onCollapsed,
}: ShellSidebarProps) {
  const reduce = useReducedMotion();
  const mailOpen = surface === "mail";
  const settingsOpen = surface === "settings";
  return (
    <motion.aside
      aria-hidden={offCanvas || undefined}
      inert={offCanvas || undefined}
      className="brain-sidebar mat-thick"
      initial={false}
      // off-canvas past its own width, inset and shadow; the canvas offset
      // follows once the spring settles (onAnimationComplete → onCollapsed)
      animate={{ x: focusMode ? "-112%" : "0%" }}
      transition={reduce ? { duration: 0 } : SPRING_PANEL}
      onAnimationComplete={() => {
        if (focusMode) onCollapsed();
      }}
    >
      <div className="brain-sidebar-head">
        <button
          type="button"
          onClick={onGoHome}
          className="brain-wordmark brain-touch-min focus-inset"
          aria-label="Home"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-small.png"
            alt=""
            className="size-[18px] rounded-[4px] object-cover"
          />
          <span className="text-h3">Brain</span>
        </button>
        {/* THE ACCENT CIRCLE MEANS ONE THING. It used to host mail's Compose
            while mail was open — same circle, same fill, same 34 slot, same
            corner, a different action — so the button changed what it did
            under a reader who had not moved it, and in mail it did the job
            the column's own Compose pill was already doing two hundred pixels
            away. ⌘⌥N never played along either: it makes a page whatever
            surface is open, so the shortcut and the button disagreed exactly
            while mail was up. New page everywhere now, and Compose stays in
            the mail column where it belongs. Settings still draws no primary:
            nothing there is a create.

            THE GLYPH FOLLOWS. It wore the composing pen, which is the glyph
            mail's own Compose pill wears — same drawing, one screen, 370px
            apart at lg and both wordless. That was harmless while both meant
            compose; once this one makes a PAGE, the only thing separating a
            note from a message was the fill, and a fill in this system
            encodes accent, not meaning. A miss makes an empty page in the
            tree and says nothing.

            It takes the plus, which is what this system draws for making a
            page everywhere else: the template menu this button opens wears it
            on the blank entry, and the tree row menu wears it on "New page
            inside". A page glyph would have named the noun — and
            `document-text`, the noun, is the very next slot in the mobile tab
            bar, under the word "Pages". The mark for the ACT was already here.

            The plus is drawn bare (DESIGN.md §10 ban 13). It was `add-square`,
            so this one button carried three shapes for one action — a rounded
            square inside a round ink button — and at 17px the box took the
            weight the plus needed to read. */}
        {settingsOpen ? null : (
          <TemplateMenu onPick={(t) => onCreatePage(selectedId, t)}>
            <Button
              variant="accent"
              aria-label="New page"
              title="New page (⌘⌥N)"
            >
              <Icon name="add-linear" size={17} />
            </Button>
          </TemplateMenu>
        )}
      </div>

      {settingsOpen ? (
        <>
          <SlotBackRow onBack={onCloseSettings} />
          <nav aria-label="Settings sections" className="brain-sidebar-settings">
            <p className="brain-sidebar-label text-label">Settings</p>
            {SETTINGS_SECTION_ORDER.map((section) => (
              <NavRow
                key={section}
                icon={SETTINGS_SECTION_META[section].icon}
                label={SETTINGS_SECTION_META[section].label}
                selected={section === settingsSection}
                reduce={reduce}
                onClick={() => onSelectSettingsSection(section)}
              />
            ))}
          </nav>
        </>
      ) : (
        <>
          <button
            type="button"
            data-search-trigger="desktop"
            className="field field-glass search-capsule brain-sidebar-search focus-inset"
            onClick={(event) => onOpenPalette(event.currentTarget)}
          >
            <Icon name="magnifer" size={16} />
            <span>Search</span>
            <Kbd>⌘K</Kbd>
          </button>

          <NavRow
            icon="sun"
            label="Today thoughts"
            onClick={() => onOpenDailyPage()}
          />
          <NavRow
            icon="letter"
            label="Mail"
            selected={mailOpen}
            reduce={reduce}
            onClick={onOpenMail}
          />

          <SidebarTreeNav>
            {pinnedPages.length > 0 && (
              <div>
                <p className="brain-sidebar-label text-label">Pinned</p>
                <div className="brain-sidebar-pinned">
                  {pinnedPages.map((p) => (
                    <PinnedChip
                      key={p.id}
                      page={p}
                      tree={tree}
                      pageRefSourcePageId={selectedId}
                      selected={p.id === sidebarSelectedId}
                      onSelect={onSelect}
                      onReparentPageRef={onReparentPageRef}
                    />
                  ))}
                </div>
              </div>
            )}
            <p className="brain-sidebar-label text-label">Pages</p>
            <SortableTree
              tree={tree}
              pageRefSourcePageId={selectedId}
              selectedId={sidebarSelectedId}
              expanded={expanded}
              onSelect={onSelect}
              onToggle={onToggleExpand}
              onAddChild={onCreatePage}
              onDelete={onDelete}
              onRename={onRename}
              onCopyLink={onCopyLink}
              onDuplicate={onDuplicate}
              onDialogIntent={onDialogIntent}
              onMoveRequest={onMoveRequest}
              onTogglePin={onTogglePin}
              onMove={onMove}
              onReparentPageRef={onReparentPageRef}
              onPrefetch={onPrefetch}
            />
            {tree.length === 0 && (
              <button
                type="button"
                onClick={() => onCreatePage(null)}
                className="brain-sidebar-empty text-control focus-inset"
              >
                No pages yet — create one
              </button>
            )}
          </SidebarTreeNav>
        </>
      )}

      <div className="brain-sidebar-foot">
        <NavRow
          icon="settings"
          label="Settings"
          selected={settingsOpen}
          capsule={false}
          data-settings-trigger="desktop"
          onClick={() => onOpenSettings()}
        />
        <IconButton size={28} onClick={() => onOpenTrash()} aria-label="Trash">
          <Icon name="trash-bin-trash" size={16} />
        </IconButton>
        <ThemeToggle />
      </div>
    </motion.aside>
  );
}

/** The way back from a slot surface (the settings section list): a quiet row
 *  above the slot content — chevron + "Back", through the surface's close
 *  semantics. The wordmark stays a secondary path to the same place. Mail had
 *  one of these too while the panel hosted its rail; the rail is gone and mail
 *  is an ordinary row in the tree panel again.
 *
 *  It read "Brain" until the owner pointed at it: the word stood twice in
 *  four lines, once as the wordmark and once as the row under it, and it
 *  named the product he was already inside rather than anywhere he could go.
 *  Naming the place instead is not available — the row follows history, so
 *  from Settings opened out of Mail it lands in Mail, and "Pages" or "Notes"
 *  would be a lie exactly there. "Back" names no place and so cannot be
 *  wrong, and it is the word the mobile settings header already uses. */
function SlotBackRow({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back"
      className="tree-row focus-inset brain-touch-hit brain-sidebar-back"
    >
      <span className="tree-row-glyph" aria-hidden>
        <Icon name="alt-arrow-left" size={16} />
      </span>
      <span className="tree-row-title">Back</span>
    </button>
  );
}

/** The page tree's scroller: an edge-fade gated by data-scrolled /
 *  data-scroll-more. Its own component so the observers re-attach when the
 *  pages slot returns after mail hosted the panel. */
function SidebarTreeNav({ children }: { children: ReactNode }) {
  const { ref, sentinelRef, endRef } = useScrollEdge<HTMLElement>();
  return (
    <nav ref={ref} className="brain-sidebar-tree edge-fade overflow-y-auto">
      <div ref={sentinelRef} aria-hidden className="-mb-px h-px w-full shrink-0" />
      {children}
      <div ref={endRef} aria-hidden className="-mt-px h-px w-full shrink-0" />
    </nav>
  );
}

/** A primary row of the panel (Today thoughts, Mail, Settings): the tree-row
 *  capsule as a button. `selected` renders the shared selection capsule so
 *  it flows here from the tree (Mail). */
const NavRow = forwardRef<
  HTMLButtonElement,
  {
    icon: string;
    label: string;
    selected?: boolean;
    /** false: the selected state keeps the bold glyph and 600 weight but
     *  does not render the flowing capsule (the settings foot row, whose
     *  capsule lives on the active section above it). */
    capsule?: boolean;
    reduce?: boolean | null;
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">
>(function NavRow(
  { icon, label, selected, capsule = true, reduce, ...button },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className="tree-row focus-inset"
      data-selected={selected ? "" : undefined}
      aria-current={selected ? "page" : undefined}
      {...button}
    >
      {selected && capsule && (
        <motion.span
          aria-hidden
          className="tree-row-capsule"
          layoutId={reduce ? undefined : SIDEBAR_SELECT_LAYOUT_ID}
          transition={SPRING_SELECT}
        />
      )}
      <span className="tree-row-glyph" aria-hidden>
        <Icon name={icon} size={16} variant={selected ? "bold" : "linear"} />
      </span>
      <span className="tree-row-title">{label}</span>
    </button>
  );
});

/** A pinned page as a chip (2×2 grid). Keeps the page-ref drop target the
 *  pinned row had: a page reference dragged from the editor onto it nests
 *  under that page. */
function PinnedChip({
  page,
  tree,
  pageRefSourcePageId,
  selected,
  onSelect,
  onReparentPageRef,
}: {
  page: Pick<TreeNode, "id" | "title" | "icon">;
  tree: TreeNode[];
  pageRefSourcePageId: string | null;
  selected: boolean;
  onSelect: (id: string) => void;
  onReparentPageRef: ReparentPageRef;
}) {
  const [pageRefOver, setPageRefOver] = useState(false);
  const accepts = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes(BRAIN_PAGE_REF_DRAG_MIME);
  const validActiveSource = (event: React.DragEvent) => {
    if (!accepts(event)) return null;
    const source = getActivePageRefDragSource();
    if (
      !source ||
      !validatePageRefNestingTarget({
        tree,
        pageId: pageRefSourcePageId,
        source,
        targetId: page.id,
        scope: "tree",
      }).valid
    ) {
      return null;
    }
    return source;
  };
  const validDroppedSource = (event: React.DragEvent) => {
    const activeSource = validActiveSource(event);
    const droppedSource = decodePageRefDragPayload(
      event.dataTransfer.getData(BRAIN_PAGE_REF_DRAG_MIME),
    );
    return pageRefDragSourcesMatch(activeSource, droppedSource)
      ? droppedSource
      : null;
  };

  return (
    <Chip
      emoji={page.icon || undefined}
      icon={page.icon ? undefined : "hashtag"}
      active={selected}
      aria-current={selected ? "page" : undefined}
      data-page-ref-over={pageRefOver ? "" : undefined}
      onClick={() => onSelect(page.id)}
      onDragEnter={(event) => {
        if (!accepts(event)) return;
        if (!validActiveSource(event)) {
          event.dataTransfer.dropEffect = "none";
          setPageRefOver(false);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setPageRefOver(true);
      }}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        if (!validActiveSource(event)) {
          event.dataTransfer.dropEffect = "none";
          setPageRefOver(false);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (!pageRefOver) setPageRefOver(true);
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setPageRefOver(false);
      }}
      onDrop={(event) => {
        if (!accepts(event)) return;
        const source = validDroppedSource(event);
        if (!source) {
          event.dataTransfer.dropEffect = "none";
          setPageRefOver(false);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setPageRefOver(false);
        const request = onReparentPageRef(source, page.id, "tree");
        if (request) acceptExternalPageRefNesting(request);
      }}
    >
      {page.title}
    </Chip>
  );
}
