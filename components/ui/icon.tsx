import { SOLAR } from "./solar-icons.generated";

export type SolarIconName = keyof typeof SOLAR & string;

/** Linear at rest, bold in the selected state — the SF Symbols regular/fill
 *  pair. Only names listed in `PAIRS` (scripts/gen-icons.mjs) have a bold. */
export type IconVariant = "linear" | "bold";

/** The three sizes of the v2 system: 16 in rows and pills, 18 in toolbar
 *  buttons, 20 in settings navigation and empty states. Legacy call sites
 *  still pass other numbers; the union keeps the enum in autocomplete. */
export type IconSize = 16 | 18 | 20;

/** Solar icon (Iconify data, bundled locally). 24×24 viewBox, currentColor.
 *  `name` may be a base name ("home") resolved with `variant`, or a full
 *  generated name ("home-linear") which is used as-is. */
export function Icon({
  name,
  size = 16,
  variant = "linear",
  className,
}: {
  name: string;
  size?: IconSize | (number & {});
  variant?: IconVariant;
  className?: string;
}) {
  // a bold exists only for PAIRS; any other name falls back to its linear
  const body = SOLAR[resolveIconName(name, variant)] ?? SOLAR[resolveIconName(name, "linear")];
  if (!body) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

export function resolveIconName(name: string, variant: IconVariant = "linear") {
  if (name.endsWith("-linear") || name.endsWith("-bold")) return name;
  return `${name}-${variant}`;
}
