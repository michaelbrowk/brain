"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { useRef, type ReactNode } from "react";
import { Icon } from "./ui/icon";
import { useDeferredMenuAction } from "./ui/deferred-menu-action";

export type PageFont = "sans" | "serif" | "mono";

export interface PageActionsMenuProps {
  children: ReactNode;
  font: PageFont;
  smallText: boolean;
  fullWidth: boolean;
  fullWidthDisabled?: boolean;
  includePin?: boolean;
  pinned?: boolean;
  onFont: (font: PageFont) => void;
  onSmallText: (enabled: boolean) => void;
  onFullWidth: (enabled: boolean) => void;
  onPin: () => void;
  onCopyLink: () => void;
  onDuplicate: () => void;
  onDialogIntent: () => void;
  onMove: (invoker: HTMLElement | null) => void;
  onExportPdf: () => void;
  onExportMarkdown: () => void;
  onHistory: (invoker: HTMLElement | null) => void;
  onTrash: () => void;
}

/* Regular material r14 (`.brain-menu` in globals.css), materialized by a
   keyframe on Radix's data-state from the trigger's corner. */
const PANEL = "brain-menu z-[var(--z-modal)] w-[220px]";
const ITEM = "brain-menu-item";

function Indicator() {
  return (
    <Dropdown.ItemIndicator className="ml-auto grid size-4 place-items-center text-ink">
      <Icon name="check-linear" size={14} />
    </Dropdown.ItemIndicator>
  );
}

function MenuIcon({ name }: { name: string }) {
  return <Icon name={name} size={16} className="brain-menu-icon" />;
}

/** Page-level appearance and file actions used by the top-right trigger. */
export function PageActionsMenu({
  children,
  font,
  smallText,
  fullWidth,
  fullWidthDisabled = false,
  includePin = false,
  pinned = false,
  onFont,
  onSmallText,
  onFullWidth,
  onPin,
  onCopyLink,
  onDuplicate,
  onDialogIntent,
  onMove,
  onExportPdf,
  onExportMarkdown,
  onHistory,
  onTrash,
}: PageActionsMenuProps) {
  const dialogAction = useDeferredMenuAction();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const deferDialog = (action: (invoker: HTMLElement | null) => void) => {
    const invoker = triggerRef.current;
    dialogAction.defer(() => action(invoker));
  };

  return (
    <Dropdown.Root>
      <Dropdown.Trigger ref={triggerRef} asChild>
        {children}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          onCloseAutoFocus={dialogAction.runAfterClose}
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className={PANEL}
        >
            <Dropdown.Sub>
              <Dropdown.SubTrigger className={ITEM}>
                <MenuIcon name="text-linear" />
                Heading font
                <Icon name="alt-arrow-right-linear" size={13} className="ml-auto text-ink-2" />
              </Dropdown.SubTrigger>
              <Dropdown.Portal>
                <Dropdown.SubContent sideOffset={5} collisionPadding={8} className={PANEL}>
                  <Dropdown.RadioGroup
                    value={font}
                    onValueChange={(value) => onFont(value as PageFont)}
                  >
                    <Dropdown.RadioItem value="sans" className={ITEM}>
                      <span className="w-4 text-center font-sans text-[14px]">A</span>
                      Sans
                      <Indicator />
                    </Dropdown.RadioItem>
                    <Dropdown.RadioItem value="serif" className={ITEM}>
                      <span className="w-4 text-center font-serif text-[14px]">A</span>
                      Serif
                      <Indicator />
                    </Dropdown.RadioItem>
                    <Dropdown.RadioItem value="mono" className={ITEM}>
                      <span className="w-4 text-center font-mono text-[13px]">A</span>
                      Mono
                      <Indicator />
                    </Dropdown.RadioItem>
                  </Dropdown.RadioGroup>
                </Dropdown.SubContent>
              </Dropdown.Portal>
            </Dropdown.Sub>

            <Dropdown.CheckboxItem
              checked={smallText}
              onCheckedChange={(checked) => onSmallText(checked === true)}
              className={ITEM}
            >
              <MenuIcon name="text-field-linear" />
              Small text
              <Indicator />
            </Dropdown.CheckboxItem>
            <Dropdown.CheckboxItem
              checked={fullWidth}
              disabled={fullWidthDisabled}
              onCheckedChange={(checked) => onFullWidth(checked === true)}
              className={ITEM}
            >
              <MenuIcon name="widget-4-linear" />
              Full width
              <Indicator />
            </Dropdown.CheckboxItem>

            <Dropdown.Separator className="brain-menu-sep" />
            <Dropdown.Item onSelect={onCopyLink} className={ITEM}>
              <MenuIcon name="link-linear" />
              Copy link
            </Dropdown.Item>
            <Dropdown.Item onSelect={onDuplicate} className={ITEM}>
              <MenuIcon name="copy-linear" />
              Duplicate
            </Dropdown.Item>
            <Dropdown.Item
              onSelect={() => {
                onDialogIntent();
                deferDialog(onMove);
              }}
              className={ITEM}
            >
              <MenuIcon name="list-arrow-down-linear" />
              Move to…
            </Dropdown.Item>
            <Dropdown.Item onSelect={onExportPdf} className={ITEM}>
              <MenuIcon name="document-text-linear" />
              Export PDF
            </Dropdown.Item>
            <Dropdown.Item onSelect={onExportMarkdown} className={ITEM}>
              <MenuIcon name="document-text-linear" />
              Export Markdown
            </Dropdown.Item>
            <Dropdown.Item
              onSelect={() => {
                onDialogIntent();
                deferDialog(onHistory);
              }}
              className={ITEM}
            >
              <MenuIcon name="history-2-linear" />
              Version history
            </Dropdown.Item>

            <Dropdown.Separator className="brain-menu-sep" />
            {includePin && (
              <Dropdown.Item onSelect={onPin} className={ITEM}>
                <MenuIcon name={pinned ? "pin-bold" : "pin-linear"} />
                {pinned ? "Unpin" : "Pin"}
              </Dropdown.Item>
            )}
            <Dropdown.Item onSelect={onTrash} className={ITEM}>
              <MenuIcon name="trash-bin-trash-linear" />
              Move to trash
            </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
