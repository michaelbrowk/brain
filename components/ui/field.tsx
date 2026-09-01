"use client";

import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./icon";
import { Kbd } from "./primitives";

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "size"> & {
  /** "paper" (default): hairline ring. "glass": an ink fill — inside a
   *  material a field is a fill, never a second material. */
  on?: "paper" | "glass";
  /** Solar icon at the left (16). */
  icon?: string;
  /** Anything at the right: a Kbd, a clear button, a count. */
  trailing?: ReactNode;
  className?: string;
  /** Static states for the stand and screenshots. `focus` is the field's
   *  own blue ring (`:focus-within`, every modality) — a text-field
   *  convention, not the keyboard focus ring; a press on a field keeps the
   *  hover ring and nothing else. */
  hover?: boolean;
  focus?: boolean;
};

/** Text field (32): on paper a hairline ring, stronger on hover, blue ring
 *  on focus; on glass an ink fill. `aria-invalid="true"` on the input turns
 *  the whole ladder red — the atom's sixth state, so a field a form has
 *  rejected carries the signal itself and not only in the message beside
 *  it. Styled by `.field` / `.field-glass` in globals.css. Forwarded ref is
 *  the input. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { on = "paper", icon, trailing, className = "", hover, focus, disabled, ...input },
  ref,
) {
  return (
    <label
      className={`field ${on === "glass" ? "field-glass" : ""} ${className}`}
      data-hover={hover ? "" : undefined}
      data-focus={focus ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
    >
      {icon && <Icon name={icon} size={16} />}
      <input ref={ref} disabled={disabled} {...input} />
      {trailing}
    </label>
  );
});

/** Search capsule inside a glass panel (32, r16): an ink fill, never a
 *  second material; the shortcut as a kbd chip at the right. */
export const SearchCapsule = forwardRef<
  HTMLInputElement,
  Omit<FieldProps, "icon" | "trailing" | "on"> & { shortcut?: string }
>(function SearchCapsule({ shortcut = "⌘K", className = "", ...rest }, ref) {
  return (
    <Field
      ref={ref}
      on="glass"
      type="search"
      icon="magnifer"
      trailing={shortcut ? <Kbd>{shortcut}</Kbd> : undefined}
      className={`search-capsule ${className}`}
      {...rest}
    />
  );
});
