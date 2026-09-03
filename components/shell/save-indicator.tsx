"use client";

import { AnimatePresence, motion } from "framer-motion";
import { DUR } from "@/lib/motion";
import { LOCAL_RECOVERY_UNAVAILABLE, type SaveState } from "./helpers";

/** The page head's word on saving — and it has one only when a save has
 *  failed. A notes app keeps what is typed, so "Saving…" and "Saved" told the
 *  reader nothing and flickered under every keystroke (shell.tsx flips the
 *  state saving → saved on each debounced change; that machine is untouched,
 *  other code reads it). `error` and `conflict` show at once and stay until
 *  the state moves on. */
export function SaveIndicator({
  state,
  recoveryUnavailable,
}: {
  state: SaveState;
  recoveryUnavailable: boolean;
}) {
  const shown = state === "error" || state === "conflict";
  return (
    <AnimatePresence mode="wait">
      {shown && (
        <motion.span
          key={state}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: DUR.base }}
          title={
            state === "conflict"
              ? "Page changed elsewhere. Save a copy to keep both versions."
              : recoveryUnavailable
                ? `Couldn’t save. ${LOCAL_RECOVERY_UNAVAILABLE}`
                : "Couldn’t save. Your local draft is safe."
          }
          role={state === "conflict" ? "alert" : "status"}
          aria-live={state === "conflict" ? "assertive" : "polite"}
          className="flex min-w-0 shrink-0 items-center gap-1 text-[11px] font-medium text-ink-3"
        >
          <span className="size-1.5 rounded-full bg-ink" />
          <span className="text-ink">
            {state === "conflict" ? "Conflict" : "Not saved"}
          </span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
