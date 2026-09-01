"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { DialogBody, DialogHeader } from "./ui/dialog-header";
import { Kbd } from "./ui/primitives";

type Shortcut = {
  action: string;
  keys: string[];
};

const GENERAL_SHORTCUTS: Shortcut[] = [
  { action: "Search and commands", keys: ["⌘K"] },
  { action: "New page", keys: ["⌘⌥N"] },
  { action: "Focus mode", keys: ["⌘\\"] },
  { action: "Shortcuts", keys: ["⌘/"] },
];

const MAIL_SHORTCUTS: Shortcut[] = [
  { action: "Next / previous conversation", keys: ["J", "K", "↑", "↓"] },
  { action: "Open reader", keys: ["Enter"] },
  { action: "Archive (or the folder’s action)", keys: ["E"] },
  { action: "Read / unread", keys: ["U"] },
  { action: "Star", keys: ["S"] },
  { action: "Compose", keys: ["C"] },
  { action: "Search", keys: ["/"] },
  { action: "Close / back", keys: ["Esc"] },
];

const EDITOR_SHORTCUTS: Shortcut[] = [
  { action: "Bold", keys: ["⌘B"] },
  { action: "Italic", keys: ["⌘I"] },
  { action: "Strikethrough", keys: ["⌘⌥X"] },
  { action: "Inline code", keys: ["⌘E"] },
  { action: "Heading 1-3", keys: ["⌘⌥1", "⌘⌥2", "⌘⌥3"] },
  { action: "Quote", keys: ["⌘⇧B"] },
  { action: "Code block", keys: ["⌘⌥C"] },
  { action: "Bulleted list", keys: ["⌘⌥8"] },
  { action: "Numbered list", keys: ["⌘⌥7"] },
  { action: "Slash menu", keys: ["/"] },
  { action: "Page link", keys: ["[["] },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="brain-dialog brain-sheet fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[80dvh] w-[min(calc(100vw-2rem),480px)] flex-col overflow-hidden outline-none"
        >
          <DialogHeader
            title="Keyboard Shortcuts"
            closeLabel="Close shortcuts"
          />

          <DialogBody className="px-5 py-4">
            <ShortcutSection title="General" shortcuts={GENERAL_SHORTCUTS} />
            <ShortcutSection title="Mail" shortcuts={MAIL_SHORTCUTS} className="mt-5" />
            <ShortcutSection title="Editor" shortcuts={EDITOR_SHORTCUTS} className="mt-5" />
          </DialogBody>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ShortcutSection({
  title,
  shortcuts,
  className = "",
}: {
  title: string;
  shortcuts: Shortcut[];
  className?: string;
}) {
  return (
    <section className={className}>
      <h2 className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">
        {title}
      </h2>
      <div className="divide-y divide-line rounded-md border border-line">
        {shortcuts.map((shortcut) => (
          <div
            key={shortcut.action}
            className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-2"
          >
            <span className="min-w-0 text-[13px] text-ink-2">{shortcut.action}</span>
            <span className="flex max-w-[220px] flex-wrap justify-end gap-1">
              {shortcut.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
