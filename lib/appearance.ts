/** Appearance settings that must apply before first paint.
 *
 *  The theme lives in next-themes (class on <html>). The two settings below
 *  are attributes on <html> written by the inline script in app/layout.tsx
 *  from localStorage, and kept in sync by these helpers so the page never
 *  flashes the wrong state on load. */

export const HEADINGS_STORAGE_KEY = "brain-headings";
export const BACKGROUND_STORAGE_KEY = "brain-bg";

export type BackgroundMode = "still" | "live";

/** The reading typeface: the system stack, or Literata for titles and
 *  headings. The stored "mono" option was retired with the settings surface —
 *  a stored value that is not "serif" reads as the system stack. */
export type HeadingFont = "sans" | "serif";

export function getHeadingFont(): HeadingFont {
  if (typeof document === "undefined") return "sans";
  return document.documentElement.dataset.headings === "serif" ? "serif" : "sans";
}

export function setHeadingFont(font: HeadingFont) {
  if (typeof document === "undefined") return;
  try {
    if (font === "sans") localStorage.removeItem(HEADINGS_STORAGE_KEY);
    else localStorage.setItem(HEADINGS_STORAGE_KEY, font);
  } catch {}
  if (font === "sans") delete document.documentElement.dataset.headings;
  else document.documentElement.dataset.headings = font;
}

export function getBackgroundMode(): BackgroundMode {
  if (typeof document === "undefined") return "still";
  return document.documentElement.dataset.bg === "live" ? "live" : "still";
}

/** Switch the background under glass. "still" is the default: layout.tsx
 *  server-renders `data-bg="still"` and the stored key is removed, mirroring
 *  how `brain-headings` treats "sans". */
export function setBackgroundMode(mode: BackgroundMode) {
  if (typeof document === "undefined") return;
  try {
    if (mode === "still") localStorage.removeItem(BACKGROUND_STORAGE_KEY);
    else localStorage.setItem(BACKGROUND_STORAGE_KEY, mode);
  } catch {}
  document.documentElement.dataset.bg = mode;
}
