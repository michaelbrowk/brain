"use client";

import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { Field } from "./ui/field";
import { ScrollEdge } from "./ui/scroll-edge";

/** Category chip + picker: free text with suggestions from existing categories. */
export function CategoryPicker({
  value,
  suggestions,
  onSet,
  revealClass = "",
}: {
  value?: string;
  suggestions: string[];
  onSet: (category: string) => void;
  /** hides the empty "+ Category" affordance until the header is hovered; a set
   *  category pill stays visible */
  revealClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = (v: string) => {
    onSet(v.trim());
    setOpen(false);
    setDraft("");
  };

  const filtered = suggestions.filter(
    (s) =>
      s.toLowerCase().includes(draft.trim().toLowerCase()) && s !== value,
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {value ? (
          <button className="brain-touch-min -ml-2.5 rounded-full border border-line px-2.5 py-0.5 text-[12px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink">
            {value}
          </button>
        ) : (
          <button
            className={`brain-touch-min -ml-2 rounded-full px-2 py-0.5 text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2 ${revealClass}`}
          >
            + Category
          </button>
        )}
      </Popover.Trigger>
      {/* regular material r14 (.brain-menu); materializes on Radix's
          data-state and retraces on close — Radix keeps the panel mounted for
          the exit keyframe (the picker canon shared with emoji and the menus) */}
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="brain-menu brain-keyboard-popover z-[var(--z-modal)] w-[220px]"
        >
          <div className="brain-keyboard-popover-panel">
            <Field
              on="glass"
              autoFocus
              aria-label="Category name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) commit(draft);
                if (e.key === "Escape") setOpen(false);
              }}
              placeholder="Category name"
              className="max-md:text-[16px]"
            />
            <ScrollEdge variant="fade" className="mt-1.5 max-h-44">
              {filtered.map((s) => (
                <button key={s} type="button" onClick={() => commit(s)} className="brain-menu-item w-full">
                  {s}
                </button>
              ))}
              {draft.trim() && !suggestions.includes(draft.trim()) && (
                <button type="button" onClick={() => commit(draft)} className="brain-menu-item w-full">
                  Create “{draft.trim()}”
                </button>
              )}
              {value && (
                <button type="button" onClick={() => commit("")} className="brain-menu-item w-full text-ink-2">
                  Remove category
                </button>
              )}
            </ScrollEdge>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
