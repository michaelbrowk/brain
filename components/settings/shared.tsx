"use client";

// Shared chrome of the settings surface (DESIGN.md v2 → Components; the
// visual spec is "Settings — V1" in the glass plan): inset groups on paper —
// r16 ring, 44px rows with a hairline between them, group header H3 15/600,
// descriptions in Caption. Controls: the v2 segmented control (thumb on
// SPRING_SELECT) and the copy row. Everything here lives on paper — no
// materials, no shadows (ban #4).

import { useId, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { SPRING_SELECT } from "@/lib/motion";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/button";

/** A settings group: H3 title + Caption description over an inset r16 ring;
 *  `action` is a small control at the header's right (Refresh). */
export function SettingsGroup({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="brain-settings-group-block">
      {(title || description || action) && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h3 className="text-h3 text-ink">{title}</h3>}
            {description && (
              <p className="mt-0.5 text-caption text-ink-3">{description}</p>
            )}
          </div>
          {action}
        </div>
      )}
      <div className={`brain-settings-group ${title || description || action ? "mt-2.5" : ""}`}>
        {children}
      </div>
    </section>
  );
}

/** One 44px row of a group: label + optional Caption hint on the left, the
 *  control on the right — the surface's default, forms included. `stack`
 *  puts the control under the label, and is only for a control that needs
 *  the row's full width (a long copyable value, an import summary). */
export function SettingsRow({
  label,
  hint,
  stack = false,
  children,
}: {
  label?: string;
  hint?: string;
  stack?: boolean;
  children?: React.ReactNode;
}) {
  if (stack) {
    return (
      <div className="brain-settings-row" data-stack="">
        {(label || hint) && (
          <div className="min-w-0">
            {label && <p className="text-table font-medium text-ink">{label}</p>}
            {hint && <p className="mt-0.5 text-caption text-ink-3">{hint}</p>}
          </div>
        )}
        {children}
      </div>
    );
  }
  return (
    <div className="brain-settings-row">
      <div className="min-w-0 flex-1">
        {label && <p className="text-table font-medium text-ink">{label}</p>}
        {hint && <p className="mt-0.5 text-caption text-ink-3">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** The v2 segmented control: a recessed track (r10) with the selected
 *  segment as a raised paper thumb flowing on SPRING_SELECT. */
export function Segmented({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // Several controls share one pane, so the sliding thumb needs its own id.
  const thumbId = useId();
  const reduce = useReducedMotion();
  const activate = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    refs.current[index]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`brain-settings-segmented ${disabled ? "pointer-events-none opacity-40" : ""}`}
    >
      {options.map((o, index) => (
        <button
          ref={(element) => {
            refs.current[index] = element;
          }}
          key={o.value}
          type="button"
          role="radio"
          disabled={disabled}
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(event) => {
            const activeIndex = options.findIndex((option) => option.value === value);
            let next: number | undefined;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              next = (activeIndex + 1) % options.length;
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              next = (activeIndex - 1 + options.length) % options.length;
            } else if (event.key === "Home") {
              next = 0;
            } else if (event.key === "End") {
              next = options.length - 1;
            }
            if (next === undefined) return;
            event.preventDefault();
            activate(next);
          }}
          className="brain-settings-segment focus-inset"
        >
          {value === o.value && (
            <motion.span
              aria-hidden="true"
              layoutId={reduce ? undefined : thumbId}
              transition={SPRING_SELECT}
              className="brain-settings-segment-thumb"
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function CopyRow({
  label,
  value,
  onCopy,
  disabled = false,
  mono = true,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  disabled?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="brain-settings-copyrow">
      <span
        className={`min-w-0 flex-1 truncate text-caption text-ink-2 ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
      <IconButton size={28} onClick={onCopy} aria-label={label} disabled={disabled}>
        <Icon name="copy-linear" size={16} />
      </IconButton>
    </div>
  );
}

export function formatPortableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
