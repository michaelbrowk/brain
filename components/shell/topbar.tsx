"use client";

// The floating toolbar over the canvas (DESIGN.md v2 → Toolbar): the
// breadcrumb pill on the left, the [Share] capsule and the [pin │ …] pill on
// the right. Two variants share one prop surface, and both are an absolute
// layer at the inset, a sibling of the scroller in a layer nothing animates
// (B3: glass never sits inside the canvas presence wrapper), so the cover
// and the document pass under the self-blurring pills — `desktop` past the
// sidebar with [Share] and [pin │ …] as two pills, `mobile` at the window's
// edge with one pill and touch-sized hits. Mobile used to be a row in flow
// at the top of the canvas: nothing passed under it, and the scroller's clip
// drew a hard line beneath the row. The save indicator and the "Edited …"
// stamp live on paper in the title block, not here. Presentational — every
// piece of state and every handler comes from <Shell> as a prop.

import type { ComponentProps } from "react";
import type { TreeNode } from "@/lib/store/types";
import { Icon } from "../ui/icon";
import { Button, IconButton } from "../ui/button";
import { BreadcrumbPill, type Crumb } from "../ui/breadcrumb-pill";
import type { ShellSurface } from "./helpers";
import {
  settingsSectionLabel,
  type SettingsSection,
} from "../settings/sections";
import { ToolbarDivider, ToolbarPill } from "../ui/toolbar-pill";
import { SharePopover } from "../share-popover";
import { PageActionsMenu, type PageFont } from "../page-actions-menu";

type SharePopoverProps = ComponentProps<typeof SharePopover>;

export interface ShellTopbarProps {
  variant: "mobile" | "desktop";
  /** The open page, or null on the hub / in mail / in settings. */
  currentNode: TreeNode | null;
  path: TreeNode[];
  /** Mail: neither variant draws anything — mail brings its own header row.
   *  Settings: desktop renders the "Settings › Section" breadcrumb pill,
   *  mobile nothing (the surface's own header is in flow). */
  surface: ShellSurface;
  settingsSection: SettingsSection | null;
  onSelectSettingsSection: (section: SettingsSection) => void;
  isBoard: boolean;
  isCollection: boolean;
  /** The node whose grant the share popover edits: the page itself when it
   *  is public, else the inherited (active or expired) root, else the page. */
  activeShareRoot: TreeNode | null;
  inheritedShareRoot: TreeNode | null;
  expiredInheritedShareRoot: TreeNode | null;
  /** The ancestor whose sharing settings apply: "Open settings" in the popover
   *  navigates there instead of opening the settings dialog. */
  inheritedSettingsRoot: TreeNode | null;
  hasActiveShare: boolean;
  hasConfiguredShare: boolean;
  shareScopeRevision: string;
  onSelect: (id: string) => void;
  onPrepareShare: SharePopoverProps["onPrepareShare"];
  onEnableShare: SharePopoverProps["onEnableShare"];
  onDisableShare: SharePopoverProps["onDisableShare"];
  onCopyShareLink: SharePopoverProps["onCopyLink"];
  onSetShareProtection: SharePopoverProps["onSetProtection"];
  onOpenSharingSettings: (invoker?: HTMLElement) => void;
  onSetPageAppearance: (
    patch: Partial<Pick<TreeNode, "font" | "smallText" | "fullWidth">>,
  ) => Promise<void>;
  onTogglePin: (id: string, pinned: boolean) => Promise<void>;
  onCopyPageLink: (id: string) => Promise<void>;
  onDuplicate: (id: string) => Promise<void>;
  onDialogIntent: () => void;
  onOpenMoveDialog: (
    id: string,
    title: string,
    invoker: HTMLElement | null,
  ) => void;
  onExportPdf: () => void;
  onExportMarkdown: () => Promise<void>;
  onOpenHistory: (invoker: HTMLElement | null) => Promise<void>;
  onRequestDelete: (id: string, title: string) => Promise<void>;
}

export function ShellTopbar({
  variant,
  currentNode,
  path,
  surface,
  settingsSection,
  onSelectSettingsSection,
  isBoard,
  isCollection,
  activeShareRoot,
  inheritedShareRoot,
  expiredInheritedShareRoot,
  inheritedSettingsRoot,
  hasActiveShare,
  hasConfiguredShare,
  shareScopeRevision,
  onSelect,
  onPrepareShare,
  onEnableShare,
  onDisableShare,
  onCopyShareLink,
  onSetShareProtection,
  onOpenSharingSettings,
  onSetPageAppearance,
  onTogglePin,
  onCopyPageLink,
  onDuplicate,
  onDialogIntent,
  onOpenMoveDialog,
  onExportPdf,
  onExportMarkdown,
  onOpenHistory,
  onRequestDelete,
}: ShellTopbarProps) {
  const mailOpen = surface === "mail";
  if (surface === "settings") {
    // Mobile settings renders its own in-flow header; desktop shows the
    // breadcrumb pill — "Settings" jumps to the first section.
    if (variant === "mobile" || settingsSection === null) return null;
    return (
      <div className="brain-topbar brain-topbar-desktop">
        <BreadcrumbPill
          className="brain-crumb"
          items={[
            {
              label: "Settings",
              onClick: () => onSelectSettingsSection("appearance"),
            },
            { label: settingsSectionLabel(settingsSection) },
          ]}
        />
      </div>
    );
  }
  const share = currentNode && (
    <SharePopover
      key={currentNode.id}
      isPublic={!!currentNode.public}
      pageId={currentNode.id}
      hasPassword={!!activeShareRoot?.shareLocked}
      expiresAt={activeShareRoot?.shareExpiresAt}
      inheritedFrom={
        inheritedShareRoot
          ? {
              id: inheritedShareRoot.id,
              title: inheritedShareRoot.title,
            }
          : undefined
      }
      expiredInheritedFrom={
        expiredInheritedShareRoot
          ? {
              id: expiredInheritedShareRoot.id,
              title: expiredInheritedShareRoot.title,
              expiresAt: expiredInheritedShareRoot.shareExpiresAt,
            }
          : undefined
      }
      scopeRevision={shareScopeRevision}
      onPrepareShare={onPrepareShare}
      onEnableShare={onEnableShare}
      onDisableShare={onDisableShare}
      onCopyLink={onCopyShareLink}
      onOpenShareSettings={
        inheritedSettingsRoot
          ? () => onSelect(inheritedSettingsRoot.id)
          : onOpenSharingSettings
      }
      onSetProtection={onSetShareProtection}
    >
      <Button
        variant="quiet"
        aria-label="Share"
        aria-pressed={hasConfiguredShare || undefined}
        className={variant === "mobile" ? "brain-touch-hit" : ""}
      >
        <Icon
          name={hasConfiguredShare ? "earth-linear" : "share-linear"}
          size={16}
        />
        {hasActiveShare
          ? "Shared"
          : hasConfiguredShare
            ? "Expired"
            : variant === "mobile"
              ? ""
              : "Share"}
      </Button>
    </SharePopover>
  );

  const actions = currentNode && (
    <PageActionsMenu
      font={(currentNode.font ?? "sans") as PageFont}
      smallText={!!currentNode.smallText}
      fullWidth={isBoard || isCollection || !!currentNode.fullWidth}
      fullWidthDisabled={isBoard || isCollection}
      includePin={variant === "mobile"}
      pinned={!!currentNode.pinned}
      onFont={(font) => void onSetPageAppearance({ font })}
      onSmallText={(smallText) => void onSetPageAppearance({ smallText })}
      onFullWidth={(fullWidth) => void onSetPageAppearance({ fullWidth })}
      onPin={() => void onTogglePin(currentNode.id, !currentNode.pinned)}
      onCopyLink={() => void onCopyPageLink(currentNode.id)}
      onDuplicate={() => void onDuplicate(currentNode.id)}
      onDialogIntent={onDialogIntent}
      onMove={(invoker) =>
        onOpenMoveDialog(
          currentNode.id,
          currentNode.title,
          invoker,
        )
      }
      onExportPdf={onExportPdf}
      onExportMarkdown={() => void onExportMarkdown()}
      onHistory={onOpenHistory}
      onTrash={() => onRequestDelete(currentNode.id, currentNode.title)}
    >
      <IconButton
        size={36}
        aria-label="Page actions"
        className={variant === "mobile" ? "brain-touch-hit" : ""}
      >
        <Icon name="menu-dots-bold" size={18} />
      </IconButton>
    </PageActionsMenu>
  );

  if (variant === "mobile") {
    // THIS SLOT SAYS WHERE YOU ARE. On a page that is the breadcrumb, which
    // names an ancestor the title below does not. Mail put the word "Mail"
    // in it, which is the one fact the screen already carries twice — the
    // tab bar's Mail slot is lit, and the surface underneath is a mailbox. It
    // was a <span>, so it was not the way back from the reader either; that
    // is the reader's own arrow. The row went with it: mail brings its own
    // header in flow (the list's account and folder selects, the reader's
    // subject strip), the way mobile settings already does, and 52px of
    // empty band above them was what made the canvas's top tint read as a
    // scroll edge over the strip below it.
    if (mailOpen) return null;
    // The hub has no crumb and no page pill — nothing to float, the way the
    // desktop layer already returns nothing there.
    if (!path.length && !currentNode) return null;
    // The crumb is a direct child of the layer, as on desktop: the layer lets
    // pointer events through to the canvas and only its children take them,
    // so a flex-1 box around the crumb would swallow taps on the paper
    // between the two pills.
    return (
      <div className="brain-topbar brain-topbar-mobile">
        <Breadcrumb path={path} onSelect={onSelect} />
        {currentNode && (
          <ToolbarPill aria-label="Page">
            {share}
            <ToolbarDivider />
            {actions}
          </ToolbarPill>
        )}
      </div>
    );
  }

  if (mailOpen) return null;
  if (!path.length && !currentNode) return null;
  return (
    <div className="brain-topbar brain-topbar-desktop">
      <Breadcrumb path={path} onSelect={onSelect} />
      {currentNode && (
        <div className="brain-topbar-actions">
          <ToolbarPill>{share}</ToolbarPill>
          <ToolbarPill aria-label="Page">
            <IconButton
              size={36}
              aria-label={currentNode.pinned ? "Unpin page" : "Pin page"}
              aria-pressed={!!currentNode.pinned}
              onClick={() => void onTogglePin(currentNode.id, !currentNode.pinned)}
              className={currentNode.pinned ? "text-ink" : ""}
            >
              <Icon
                name="pin"
                size={18}
                variant={currentNode.pinned ? "bold" : "linear"}
              />
            </IconButton>
            <ToolbarDivider />
            {actions}
          </ToolbarPill>
        </div>
      )}
    </div>
  );
}

/** The breadcrumb pill: the immediate parent + the current page (−1 depth);
 *  deeper nesting folds into a leading "…" that jumps to the grandparent.
 *  Parents are ink 500 with a chevron, the current page 600 — no blue on
 *  glass. */
function Breadcrumb({
  path,
  onSelect,
}: {
  path: TreeNode[];
  onSelect: (id: string) => void;
}) {
  if (!path.length) return null;
  const trimmed = path.slice(-2);
  const hidden = path.length > 2 ? path[path.length - 3] : null;
  const items: Crumb[] = [
    ...(hidden
      ? [{ label: "…", title: hidden.title, onClick: () => onSelect(hidden.id) }]
      : []),
    ...trimmed.map((n) => ({
      label: n.title,
      emoji: n.icon || undefined,
      onClick: () => onSelect(n.id),
    })),
  ];
  // A root page's crumb has one segment, and that segment is the page's own
  // title again — the pill repeats what the icon and the title say just
  // below it. So it hides while the title is on screen and materialises once
  // the title has scrolled away (`.brain-crumb-lone` in globals.css, driven
  // by `useTitleReveal` in shell/page-head.tsx). A crumb that carries
  // ancestors never duplicates the title and stays visible throughout.
  return (
    <BreadcrumbPill
      items={items}
      className={`brain-crumb${items.length === 1 ? " brain-crumb-lone" : ""}`}
    />
  );
}
