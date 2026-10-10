"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { slideUp } from "@/lib/motion";
import { pcShortcut } from "@/lib/shortcut-keys";
import { Icon } from "./icon";
import { Button } from "./button";

/** Keyboard shortcut chip (Kbd 11/500). Takes its fill from the surface it
 *  sits on: white .70 + rim inside a material, ink .05 on paper (`--kbd-fill`
 *  set by `mat-*`, `.brain-menu`, `.brain-dialog`, `.brain-palette`).
 *
 *  A string label is written in Mac glyphs and carries its Ctrl spelling with
 *  it: both are in the HTML and CSS shows the one `data-platform` asks for, so
 *  the right one is there at first paint and the hydrated tree matches what the
 *  server sent. The stamp is set before paint in `app/layout.tsx`. */
export function Kbd({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <kbd className={`kbd ${className}`}>{bothSpellings(children)}</kbd>;
}

function bothSpellings(children: React.ReactNode): React.ReactNode {
  if (typeof children !== "string") return children;
  const pc = pcShortcut(children);
  if (pc === children) return children;
  return (
    <>
      <span className="kbd-mac">{children}</span>
      <span className="kbd-pc">{pc}</span>
    </>
  );
}

/** The platform the reader is on, once the page has hydrated, and `null`
 *  before that: it is stamped on `<html>` by a script in the browser, which
 *  the server rendering the HTML cannot run. Painted labels never wait for
 *  this — they swap in CSS. It is for the strings CSS cannot reach, a `title`
 *  above all, which no one can read before a pointer rests on the control. */
export function usePlatform(): "mac" | "pc" | null {
  return useSyncExternalStore(subscribeToPlatform, readPlatform, () => null);
}

function readPlatform(): "mac" | "pc" | null {
  const stamped = document.documentElement.dataset.platform;
  return stamped === "mac" || stamped === "pc" ? stamped : null;
}

/** The stamp is written once, before the first paint, and never changes. */
function subscribeToPlatform(): () => void {
  return () => {};
}

/** `Send (⌘↵)` on a Mac, `Send (Ctrl+Enter)` elsewhere, and `Send` until the
 *  platform is known, because a tooltip that names the wrong key is the bug
 *  this whole file is about. */
export function useShortcutTitle(label: string, shortcut: string): string {
  const platform = usePlatform();
  if (platform === null) return label;
  return `${label} (${platform === "mac" ? shortcut : pcShortcut(shortcut)})`;
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
   * shape of an undo that has a request of its own to make — a Block taken
   * back, a letter archived again — where a pill taken down at the press
   * would let a second press, or ⌘Z, start the same reversal twice.
   */
  readonly onAction?: () => boolean | void | Promise<unknown>;
  /**
   * The pill left WITHOUT its action being spent: its window ran out, a
   * message wearing its `id` took its place, or a fourth undo committed it.
   * An action that has begun and not settled counts as spent, so a pill
   * whose Undo is still going out never hears this. A caller that parked real work
   * behind the way back (the compose sheet's Discard holds the provider
   * delete behind its Undo, a section's Done holds its archives) does that
   * work here, and only here — the shell
   * owns the window, hover included, so the shell is the one that knows when
   * the way back is gone. Never called after `onAction` spent the pill.
   */
  readonly onExpire?: () => void;
  /** What the button says while a promise from `onAction` is still open. */
  readonly pendingLabel?: string;
  /**
   * How long the pill stands, in milliseconds. `null` is a pill with NO
   * window: it stands until a message wearing its `id` replaces it, or until
   * its action is spent.
   *
   * `null` is not "a very long time". A caller whose work has no known end —
   * a request not yet answered, say — cannot name a duration without
   * guessing, and a guessed one is worse than none: too short takes the pill
   * away while the thing it speaks of is still happening, too long draws the
   * ring below over a deadline that is not real. So the caller says it has no
   * deadline yet, and says the sentence again with a real window when the
   * work lands. (A section's Done was the first to stand this way and no
   * longer does: its requests wait behind the window, so the window is real
   * from the press.)
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
   * surfaced nine seconds later would be detached from the gesture and by
   * then untrue. Nothing else on the options travels with it: a refusal is one
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
 *
 * It stands at the BODY, in a portal, not inside the shell root. A transient
 * must read over anything (§1), and the compose sheet is a portal at the body
 * on `--z-modal` with the whole shell root `inert` and receding under it: a
 * column left inside that root drew every pill fired while a letter was being
 * written under the sheet, unpressable and out of the accessibility tree. At
 * the body `--z-toast` stands over `--z-modal`, the pill is pressable, and
 * Radix's `hideOthers` leaves live regions alone. The canvas offset it centres
 * on is read from `:root` (globals.css), which is why the offset lives there
 * and not on the shell. The portal mounts after hydration; a pill is never
 * part of the server's markup anyway.
 */
export function SnackbarStack({ children }: { children: React.ReactNode }) {
  // Hydrated or not, the way `usePlatform` asks it: the server has no body
  // to portal into and renders nothing, the client renders the column.
  const hydrated = useSyncExternalStore(
    subscribeToPlatform,
    () => true,
    () => false,
  );
  if (!hydrated) return null;
  return createPortal(<div className="brain-toast-stack">{children}</div>, document.body);
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
  assertive = false,
  ...pill
}: SnackbarPillProps & {
  open: boolean;
  /** An answer to a gesture interrupts, a report waits — so the live region
   *  is assertive. The role stays `status`: `alert` is this codebase's mark
   *  for the inline error text inside a form or a dialog, and a permanent
   *  empty one at the shell's root would answer for all of them. */
  assertive?: boolean;
}) {
  return (
    <SnackbarSlot assertive={assertive}>
      {open && <SnackbarPill {...pill} />}
    </SnackbarSlot>
  );
}

/**
 * One row of `SnackbarStack`: a permanently mounted live region and the pills
 * that come and go inside it. A `Snackbar` is a slot holding at most one pill.
 * The shell's general channel is a slot holding a short column of them, the
 * newest first, so two undos up at the same beat each keep a pill of their own
 * without a live region being mounted at the moment it should speak (a region
 * that arrives already holding its sentence is not announced).
 *
 * `popLayout` takes a leaving pill out of the flow as its exit starts, so the
 * pills that stay, in this slot and in the rows above it, settle into its
 * place on the toast spring in the same beat instead of waiting for the exit
 * to finish and then jumping. It pins the leaving pill by its BOTTOM
 * (`anchorY`): the column is fixed to the foot of the window and grows upward,
 * so a pill pinned by its top would drift down the screen as the pills under
 * it close up, while one pinned by its bottom fades where it stood.
 *
 * A slot of several is not `aria-atomic`: a pill joining the column is read on
 * its own, not the whole column again with it.
 */
export function SnackbarSlot({
  assertive = false,
  atomic = true,
  children,
}: {
  assertive?: boolean;
  atomic?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic={atomic}
      className="brain-toast-slot"
    >
      <AnimatePresence mode="popLayout" anchorY="bottom">
        {children}
      </AnimatePresence>
    </div>
  );
}

/** One of several answers a pill offers at once: a page in conflict asks
 *  which version stays, and the answers are equals, so none of them is the
 *  pill's single action. */
export type SnackbarChoice = {
  label: string;
  onAction: () => void;
  disabled?: boolean;
};

export type SnackbarPillProps = {
  icon?: string;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  /** Several answers instead of one action. The pill keeps its capsule while
   *  they fit beside the words; on a narrow screen they wrap under them and
   *  the pill rounds to the panel radius, since a capsule two rows tall
   *  would cut into the words at its corners. */
  choices?: readonly SnackbarChoice[];
  durationSec?: number;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
};

/** The pill itself, as a direct child of a `SnackbarSlot`. The ref reaches
 *  the moving element because `popLayout` measures the leaving pill there. */
export function SnackbarPill({
  icon,
  title,
  subtitle,
  actionLabel,
  onAction,
  actionDisabled,
  choices,
  durationSec,
  onHoverStart,
  onHoverEnd,
  ref,
}: SnackbarPillProps & { ref?: React.Ref<HTMLDivElement> }) {
  if (choices?.length) {
    return (
      <motion.div
        ref={ref}
        {...slideUp}
        layout="position"
        onHoverStart={onHoverStart}
        onHoverEnd={onHoverEnd}
        className="brain-toast brain-toast-choices pointer-events-auto relative flex flex-wrap items-center justify-start gap-x-3 gap-y-2 overflow-hidden py-2.5 pr-2.5 pl-5"
      >
        <div className="min-w-0 flex-[1_1_12rem]">
          <div className="text-control truncate font-semibold text-paper">{title}</div>
          {subtitle && <div className="text-caption mt-0.5 text-paper/60">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* By place, not by label: a label that turns into "Saving…" is
              the same button, and keeps the focus it has. */}
          {choices.map((choice, index) => (
            <Button
              key={index}
              variant="pill"
              className="shrink-0"
              onClick={choice.onAction}
              disabled={choice.disabled}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      </motion.div>
    );
  }
  return (
    <motion.div
      ref={ref}
      {...slideUp}
      /* When a pill below this one leaves, its place closes in a single
         frame and everything above would teleport down by its height plus
         the gap. `position` — never bare `layout`, which corrects a height
         change with a scale and would stretch the text. */
      layout="position"
      onHoverStart={onHoverStart}
      onHoverEnd={onHoverEnd}
      /* The tight left padding belongs to the RING, and the ring is
         drawn inside the icon's slot: a pill with a deadline and no icon
         has no ring to make room for, and used to sit 6px tight with
         nothing in the gap. So the padding reads the same condition the
         ring does. */
      className={`brain-toast group pointer-events-auto relative flex items-center gap-3 overflow-hidden py-2.5 ${
        actionLabel ? "pr-2.5" : "pr-5"
      } ${icon && durationSec != null && durationSec > 0 ? "pl-3.5" : "pl-5"}`}
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
  );
}
