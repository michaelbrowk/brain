"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { TEMPLATES, requestTemplateCaret, type Template } from "@/lib/templates";
import { Icon } from "./ui/icon";

/** New-page menu: a blank page or a template. `onPick` may resolve to the
 *  created page id; a template page then opens with the caret in its first
 *  empty section (a blank page focuses the title instead). */
export function TemplateMenu({
  children,
  onPick,
}: {
  children: React.ReactNode;
  onPick: (t: Template) => void | Promise<string | null>;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        {/* regular material r14, materialized by a keyframe on data-state */}
        <Dropdown.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="brain-menu z-[var(--z-modal)] w-[210px]"
        >
          <p className="brain-menu-label">New page</p>
          {TEMPLATES.map((t) => (
            <Dropdown.Item
              key={t.id}
              onSelect={() => {
                const created = onPick(t);
                if (t.id === "blank" || !created) return;
                void created.then((id) => {
                  if (id) requestTemplateCaret(id);
                });
              }}
              className="brain-menu-item"
            >
              <span className="grid size-4 place-items-center text-[14px] leading-none">
                {t.emoji || <Icon name="add-linear" size={16} className="brain-menu-icon" />}
              </span>
              {t.name}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
