"use client";

import { useEffect, useState } from "react";

/** THE PHONE-SHAPED QUESTION, ASKED ONCE.
 *
 *  Below md a panel keeps the sheet form: it slides in from the bottom edge
 *  and a grip drags it away. Two surfaces ask this now (the mail composer and
 *  the When picker), and a second copy of the query string is how one of them
 *  ends up on a different breakpoint from the rest of the app. */
const SHEET_QUERY = "(max-width: 767px)";

/** Read synchronously on the first client render, so the entrance actually
 *  plays. Guards the matchMedia surface for environments (jsdom) that stub it
 *  partially. */
export function matchesSheet(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(SHEET_QUERY).matches === true;
}

export function useSheetGesture(): boolean {
  const [sheet, setSheet] = useState(matchesSheet);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(SHEET_QUERY);
    const update = () => setSheet(query.matches === true);
    update();
    if (typeof query.addEventListener !== "function") return;
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return sheet;
}
