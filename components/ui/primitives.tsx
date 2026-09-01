"use client";

import { AnimatePresence, motion } from "framer-motion";
import { slideUp } from "@/lib/motion";
import { Icon } from "./icon";
import { Button } from "./button";

/** Keyboard shortcut chip (Kbd 11/500). Takes its fill from the surface it
 *  sits on: white .70 + rim inside a material, ink .05 on paper (`--kbd-fill`
 *  set by `mat-*`, `.brain-menu`, `.brain-dialog`, `.brain-palette`). */
export function Kbd({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <kbd className={`kbd ${className}`}>{children}</kbd>;
}

/** Loading skeleton line: ink .05 on paper, white .40 on glass
 *  (`--skeleton-fill`); the pulse stops under reduced motion. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton animate-pulse motion-reduce:animate-none ${className}`} />;
}

/**
 * Everything a caller can ask of the shell's one general-purpose toast beyond
 * its title. It exists because a snackbar that only ever says a sentence
 * cannot carry an undo, and a bulk action that cannot be undone should not
 * ship. `durationMs` buys the reader time to reach the action — the default
 * dismissal is tuned for a sentence nobody has to act on.
 */
export type ToastOptions = {
  readonly icon?: string;
  readonly subtitle?: string;
  readonly actionLabel?: string;
  /**
   * Returning `false` REFUSES the press: the toast keeps standing and keeps
   * its window, so an action the caller cannot run right now costs the reader
   * nothing. Anything else (including `undefined`) spends the toast.
   *
   * Returning a promise spends it LATER: the pill stands, its button out of
   * reach and wearing `pendingLabel`, until the promise settles. That is the
   * shape of an undo pressed while the work it reverses is still going out —
   * the reversal cannot begin before the loop drops its lock, and a pill taken
   * down at the press looked spent over a run that had not been stopped.
   */
  readonly onAction?: () => boolean | void | Promise<unknown>;
  /** What the button says while a promise from `onAction` is still open. */
  readonly pendingLabel?: string;
  /**
   * How long the pill stands, in milliseconds. `null` is a pill with NO
   * window: it stands until a message wearing its `id` replaces it, or until
   * its action is spent.
   *
   * `null` is not "a very long time". A caller whose work has no known end —
   * a loop of sequential requests, say — cannot name a duration without
   * guessing, and a guessed one is worse than none: too short takes the way
   * back away while the thing it reverses is still happening, too long draws
   * the ring below over a deadline that is not real. So the caller says it
   * has no deadline yet, and says the sentence again with a real window when
   * the work lands.
   */
  readonly durationMs?: number | null;
  /**
   * Two toasts sharing an id are one message. A later one REPLACES the
   * standing one instead of queueing behind its undo, which is how an action
   * that reported at the gesture corrects itself when the work lands — a
   * report and its correction are the same sentence said twice, not two
   * sentences owed to the reader.
   */
  readonly id?: string;
  /**
   * A REFUSAL, not a report. It answers a gesture the reader just made, so it
   * speaks at once or not at all: it takes its own pill above whatever is
   * standing, never the pill itself, and never queues — a sentence that
   * surfaced ten seconds later would be detached from the gesture and by then
   * untrue. Nothing else on the options travels with it: a refusal is one
   * sentence and there is nothing to undo.
   */
  readonly urgent?: boolean;
};

/**
 * The column every pill stands in. One fixed box at the foot of the shell,
 * bottom-anchored, so pills that are up at the same beat — a refusal over a
 * live undo — stack instead of landing on each other's coordinates. Each pill
 * keeps its own permanently mounted live region as a row of this column, and
 * a closed one is a zero-height row that costs nothing.
 *
 * It also owns the ONE offset. Each pill used to place itself, which made the
 * clearance of the mobile tab bar nobody's job: the bar occupies safe+8 to
 * safe+62 and the pills sat at safe+24, so ten seconds of undo left Search,
 * New and Pages unpressable. Below md the column stands on the same reserve
 * the mail scroller already keeps for that strip (`.brain-mail-scrollfoot`).
 */
export function SnackbarStack({ children }: { children: React.ReactNode }) {
  return <div className="brain-toast-stack">{children}</div>;
}

/** Bottom-center pill snackbar with optional action (the undo pattern).
 *  durationSec shows a draining progress track; hover pauses via callbacks.
 *  Stands as a row of `SnackbarStack`, which owns the position.
 *
 *  `durationSec` is the ring, and the ring is a DEADLINE — the one thing it
 *  can say is "this much of your window is left". A pill with no deadline
 *  passes nothing and wears no ring: its icon sits alone in the slot and the
 *  pill stands until something takes it. See §13 — the icon slot is the
 *  ring's host, and a pill with nothing to count wears no ring. */
export function Snackbar({
  open,
  icon,
  title,
  subtitle,
  actionLabel,
  onAction,
  actionDisabled,
  durationSec,
  onHoverStart,
  onHoverEnd,
  assertive = false,
}: {
  open: boolean;
  icon?: string;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  durationSec?: number;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  /** An answer to a gesture interrupts, a report waits — so the live region
   *  is assertive. The role stays `status`: `alert` is this codebase's mark
   *  for the inline error text inside a form or a dialog, and a permanent
   *  empty one at the shell's root would answer for all of them. */
  assertive?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      className="brain-toast-slot"
    >
      <AnimatePresence>
        {open && (
          <motion.div
            {...slideUp}
            /* When a pill below this one closes, its slot collapses to zero in
               a single frame and everything above teleports down by its height
               plus the gap. `position` — never bare `layout`, which corrects a
               height change with a scale and would stretch the text. */
            layout="position"
            onHoverStart={onHoverStart}
            onHoverEnd={onHoverEnd}
            className={`brain-toast group pointer-events-auto relative flex items-center gap-3 overflow-hidden py-2.5 ${
              actionLabel ? "pr-2.5" : "pr-5"
            } ${durationSec != null && durationSec > 0 ? "pl-3.5" : "pl-5"}`}
          >
            {icon && (
              <span className="relative grid size-8 shrink-0 place-items-center">
                {durationSec != null && durationSec > 0 && (
                  /* countdown ring — pauses with the timer on hover. The
                     attribute names it: whether the ring is drawn at all is a
                     rule (a pill with no deadline wears none), so it has to be
                     assertable without reaching for a viewBox. */
                  <svg
                    data-toast-ring
                    viewBox="0 0 32 32"
                    aria-hidden
                    className="absolute inset-0 -rotate-90 motion-reduce:hidden"
                  >
                    <circle
                      cx="16" cy="16" r="14" fill="none" strokeWidth="2"
                      stroke="color-mix(in oklch, var(--paper) 22%, transparent)"
                    />
                    <circle
                      cx="16" cy="16" r="14" fill="none" strokeWidth="2"
                      strokeLinecap="round" stroke="var(--paper)"
                      strokeDasharray="87.96"
                      style={{ animation: `ring-drain ${durationSec}s linear forwards` }}
                      className="group-hover:[animation-play-state:paused]"
                    />
                  </svg>
                )}
                <Icon name={icon} size={16} className="text-paper" />
              </span>
            )}
            <div className="min-w-0">
              <div className="text-control truncate font-semibold text-paper">{title}</div>
              {subtitle && <div className="text-caption mt-0.5 text-paper/60">{subtitle}</div>}
            </div>
            {actionLabel && (
              <Button
                variant="pill"
                className="ml-1 shrink-0"
                onClick={onAction}
                disabled={actionDisabled}
              >
                {actionLabel}
              </Button>
            )}

          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
