"use client";

import { AnimatePresence, motion } from "framer-motion";
import { DUR } from "@/lib/motion";
import { LOCAL_RECOVERY_UNAVAILABLE, type SaveState } from "./helpers";

export function SaveIndicator({
  state,
  recoveryUnavailable,
}: {
  state: SaveState;
  recoveryUnavailable: boolean;
}) {
  const label =
    state === "saving"
      ? "Saving…"
      : state === "saved"
        ? "Saved"
        : state === "conflict"
          ? "Conflict"
          : state === "error"
            ? "Not saved"
            : "";
  return (
    <AnimatePresence mode="wait">
      {state !== "idle" && (
        <motion.span
          key={state}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: DUR.base }}
          title={
            state === "saving"
              ? "Saving…"
              : state === "conflict"
                ? "Page changed elsewhere. Save a copy to keep both versions."
                : state === "error"
                ? recoveryUnavailable
                  ? `Couldn’t save. ${LOCAL_RECOVERY_UNAVAILABLE}`
                  : "Couldn’t save. Your local draft is safe."
                : "Saved"
          }
          role={state === "conflict" ? "alert" : "status"}
          aria-live={state === "conflict" ? "assertive" : "polite"}
          className="flex min-w-0 shrink-0 items-center gap-1 text-[11px] font-medium text-ink-3"
        >
          <span
            className={`size-1.5 rounded-full ${
              state === "error" || state === "conflict" ? "bg-ink" : "bg-ink-3"
            } ${state === "saving" ? "animate-pulse" : ""}`}
          />
          <span className={state === "error" || state === "conflict" ? "text-ink" : ""}>
            {label}
          </span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
