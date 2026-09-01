import * as Dialog from "@radix-ui/react-dialog";
import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "./icon";
import { ScrollEdge } from "./scroll-edge";

export function DialogCloseButton({
  label,
  disabled = false,
  className = "",
}: {
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Dialog.Close
      type="button"
      aria-label={label}
      disabled={disabled}
      className={`brain-touch-hit icon-btn focus-inset ${className}`}
      data-size="28"
    >
      {/* One plain X across History, Move, Rename, Shortcuts, Trash and
          Settings. It used to be `close-circle` with the ring hidden in CSS
          and the glyph scaled back up — the ring is not information, and this
          button already is the circle. */}
      <Icon name="close-linear" size={18} />
    </Dialog.Close>
  );
}

export function DialogHeader({
  title,
  subtitle,
  action,
  closeLabel,
  closeDisabled = false,
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  closeLabel?: string;
  closeDisabled?: boolean;
  className?: string;
}) {
  return (
    /* No hairline under the header (DESIGN.md v2 → No hard edge): a body
       that scrolls takes <ScrollEdge variant="fade"> instead. */
    <div className={`flex items-center gap-2 px-5 pb-3 pt-4 ${className}`}>
      <div className="min-w-0 flex-1">
        <Dialog.Title className="text-subheading truncate text-ink">{title}</Dialog.Title>
        {subtitle && (
          <Dialog.Description className="text-caption mt-0.5 truncate font-medium text-ink-2">
            {subtitle}
          </Dialog.Description>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {closeLabel && (
        <DialogCloseButton label={closeLabel} disabled={closeDisabled} />
      )}
    </div>
  );
}

/** The scrolling body under a `DialogHeader`: the header has no hairline, so
 *  the body is a fade scroller (DESIGN.md v2 → Scroll-edge) — 12px at the
 *  top once scrolled, 20px at the bottom while content continues, nothing at
 *  rest. Pass the padding and any scroller attributes as usual. */
export function DialogBody({
  className = "",
  children,
  ...scroller
}: Omit<HTMLAttributes<HTMLDivElement>, "className"> & {
  className?: string;
  children: ReactNode;
}) {
  return (
    <ScrollEdge variant="fade" className={`min-h-0 flex-1 ${className}`} scrollerProps={scroller}>
      {children}
    </ScrollEdge>
  );
}
