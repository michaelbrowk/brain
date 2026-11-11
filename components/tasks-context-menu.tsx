"use client";

import * as Context from "@radix-ui/react-context-menu";
import { Fragment, useRef, type ReactNode } from "react";
import { Icon } from "./ui/icon";
import { useDeferredMenuAction } from "./ui/deferred-menu-action";

export interface TasksContextAction {
  key: string;
  icon: string;
  label: string;
  disabled?: boolean;
  divider?: boolean;
  onSelect: (invoker: HTMLElement | null) => void;
}

/** Tasks uses the page menu's material and deferred handoff to dialogs.
 * The wrapper stays in place: right-clicking it never activates the row. */
export function TasksContextMenu({ actions, category = false, children, onOpenChange }: {
  actions: readonly TasksContextAction[];
  category?: boolean;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const deferred = useDeferredMenuAction();
  const invoker = useRef<HTMLElement | null>(null);
  const keyboardInvoker = useRef<HTMLElement | null>(null);
  if (actions.length === 0) return children;
  return <Context.Root onOpenChange={onOpenChange}>
    <Context.Trigger asChild
      onPointerDownCapture={(event) => { invoker.current = event.currentTarget; }}
      onContextMenuCapture={(event) => { invoker.current = keyboardInvoker.current || event.currentTarget; }}
      onKeyDownCapture={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        event.stopPropagation();
        const target = event.target instanceof HTMLElement ? event.target : event.currentTarget;
        keyboardInvoker.current = target;
        const bounds = target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: bounds.left, clientY: bounds.bottom }));
        keyboardInvoker.current = null;
      }}>
      {children}
    </Context.Trigger>
    <Context.Portal>
      <Context.Content collisionPadding={8} className={`brain-menu z-[var(--z-modal)] ${category ? "w-[220px]" : "w-[184px]"}`}
        onKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (invoker.current?.isConnected) {
            event.preventDefault();
            invoker.current.focus({ preventScroll: true });
          }
          deferred.runAfterClose();
        }}>
        {actions.map((action) => <Fragment key={action.key}>
          {action.divider && <Context.Separator className="brain-menu-sep" />}
          <Context.Item disabled={action.disabled} className="brain-menu-item" onSelect={() => {
            const target = invoker.current;
            deferred.defer(() => action.onSelect(target));
          }}><Icon name={action.icon} size={16} className="brain-menu-icon" /><span className="min-w-0 flex-1 truncate">{action.label}</span></Context.Item>
        </Fragment>)}
      </Context.Content>
    </Context.Portal>
  </Context.Root>;
}
