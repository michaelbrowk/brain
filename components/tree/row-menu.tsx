"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Context from "@radix-ui/react-context-menu";
import { useRef } from "react";
import { Icon } from "../ui/icon";
import { useDeferredMenuAction } from "../ui/deferred-menu-action";

export interface PageMenuHandlers {
  pinned?: boolean;
  canAddChild?: boolean;
  onAddChild: () => void;
  onRename: (invoker: HTMLElement | null) => void;
  onCopyLink: () => void;
  onDuplicate: () => void;
  onDialogIntent: () => void;
  onMoveRequest: (invoker: HTMLElement | null) => void;
  onTogglePin: () => void;
  deleteLabel?: string;
  deleteReturnsFocus?: boolean;
  onDelete: (invoker: HTMLElement | null) => void;
}

export interface PageMenuAction {
  key: string;
  icon: string;
  label: string;
  onSelect: (invoker: HTMLElement | null) => void;
  returnsFocus?: boolean;
  strong?: boolean;
  divider?: boolean;
}

/** Shared registry so the dots menu and right-click menu cannot drift. */
export function pageMenuActions(h: PageMenuHandlers): PageMenuAction[] {
  return [
    ...(h.canAddChild === false
      ? []
      : [
          {
            key: "add-child",
            icon: "add-linear",
            label: "New page inside",
            onSelect: h.onAddChild,
          },
        ]),
    {
      key: "pin",
      icon: h.pinned ? "pin-bold" : "pin-linear",
      label: h.pinned ? "Unpin" : "Pin",
      onSelect: h.onTogglePin,
    },
    {
      key: "rename",
      icon: "text-field-linear",
      label: "Rename",
      onSelect: h.onRename,
      returnsFocus: true,
    },
    {
      key: "copy-link",
      icon: "link-linear",
      label: "Copy link",
      onSelect: h.onCopyLink,
    },
    {
      key: "duplicate",
      icon: "copy-linear",
      label: "Duplicate",
      onSelect: h.onDuplicate,
    },
    {
      key: "move",
      icon: "list-arrow-down-linear",
      label: "Move to…",
      onSelect: h.onMoveRequest,
      returnsFocus: true,
    },
    {
      key: "trash",
      icon: "trash-bin-trash-linear",
      label: h.deleteLabel ?? "Move to trash",
      onSelect: h.onDelete,
      returnsFocus: h.deleteReturnsFocus,
      strong: true,
      divider: true,
    },
  ];
}

/* Regular material r14 (`.brain-menu` in globals.css); the entrance is a
   keyframe on Radix's data-state — materialize from the trigger's corner. */
const PANEL = "brain-menu z-[var(--z-modal)] w-[184px]";
const ITEM = "brain-menu-item";

/** The "…" click-menu on a tree row. */
export function RowMenu({
  children,
  ...h
}: PageMenuHandlers & { children: React.ReactNode }) {
  const dialogAction = useDeferredMenuAction();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Dropdown.Root>
      <Dropdown.Trigger ref={triggerRef} asChild>
        {children}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          onCloseAutoFocus={dialogAction.runAfterClose}
          side="bottom"
          align="start"
          sideOffset={4}
          className={PANEL}
        >
          {pageMenuActions(h).map((a) => (
            <div key={a.key}>
              {a.divider && <div className="brain-menu-sep" />}
              <Dropdown.Item
                onSelect={
                  a.returnsFocus
                    ? () => {
                        const invoker = triggerRef.current;
                        h.onDialogIntent();
                        dialogAction.defer(() => a.onSelect(invoker));
                      }
                    : () => a.onSelect(null)
                }
                className={ITEM}
              >
                <Icon name={a.icon} size={16} className="brain-menu-icon" />
                {a.label}
              </Dropdown.Item>
            </div>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Right-click context menu with the same actions. */
export function PageContextMenu({
  children,
  returnFocusToActiveElement = false,
  ...h
}: PageMenuHandlers & {
  children: React.ReactNode;
  returnFocusToActiveElement?: boolean;
}) {
  const dialogAction = useDeferredMenuAction();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);
  const rememberInvoker = (trigger: HTMLElement | null) => {
    const active = document.activeElement;
    invokerRef.current =
      returnFocusToActiveElement &&
      active instanceof HTMLElement &&
      active !== document.body
        ? active
        : trigger;
  };
  return (
    <Context.Root>
      <Context.Trigger
        ref={triggerRef}
        asChild
        onPointerDownCapture={(event) => {
          if (event.button === 2) rememberInvoker(event.currentTarget);
        }}
        onKeyDownCapture={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          )
            rememberInvoker(event.currentTarget);
        }}
        onContextMenuCapture={(event) => {
          if (!invokerRef.current) rememberInvoker(event.currentTarget);
        }}
      >
        {children}
      </Context.Trigger>
      <Context.Portal>
        {/* Same panel and entrance as the dots menu — the two must not feel
            like different components. */}
        <Context.Content onCloseAutoFocus={dialogAction.runAfterClose} className={PANEL}>
          {pageMenuActions(h).map((a) => (
            <div key={a.key}>
              {a.divider && <div className="brain-menu-sep" />}
              <Context.Item
                onSelect={
                  a.returnsFocus
                    ? () => {
                        const invoker =
                          invokerRef.current ?? triggerRef.current;
                        h.onDialogIntent();
                        dialogAction.defer(() => a.onSelect(invoker));
                      }
                    : () => a.onSelect(null)
                }
                className={ITEM}
              >
                <Icon name={a.icon} size={16} className="brain-menu-icon" />
                {a.label}
              </Context.Item>
            </div>
          ))}
        </Context.Content>
      </Context.Portal>
    </Context.Root>
  );
}
