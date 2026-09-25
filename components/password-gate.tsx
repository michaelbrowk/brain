"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, IconButton } from "./ui/button";
import { Field } from "./ui/field";
import { Icon } from "./ui/icon";
import { DUR, EASE_OUT, SPIN } from "@/lib/motion";

/** One password screen, two doors. The owner's sign-in after `install.sh` and
 *  a visitor's locked share are the same refusal seen from two sides, so they
 *  are one drawing: the same field, the same eye, the same ink pill, the same
 *  four sentences, the same arrival. What each caller supplies is the head
 *  above the field, the two words on the button, and what to do once the door
 *  is open.
 *
 *  It is paper, not glass. DESIGN.md §10 ban 10 keeps the public page and
 *  print on paper only, and the sign-in screen has no scroller for glass to
 *  float over in the first place: the field's own hairline ring is what says
 *  "type here" (§2, the one hairline held to 3:1). */

/** The four sentences these screens say, in the words a person reads rather
 *  than the status code that caused them. Exported because both callers name
 *  them and both test files read them. */
export const GATE_WRONG_PASSWORD = "That password did not match.";
export const GATE_RATE_LIMITED = "Too many tries. Wait a minute.";
export const GATE_SERVER_SILENT = "The server did not answer. Try again.";
export const GATE_NO_CONNECTION = "No connection to the server. Try again.";

/** 401 and 429 are the two answers `/api/auth` and `/api/share-auth` are
 *  written to give, and a minute is the window both rate limiters hold.
 *  Anything else is the server failing to answer the question it was asked:
 *  an instance with no `AUTH_PASSWORD_HASH` returns 500, a proxy in front of
 *  a stopped container returns 502, and a reader can do the same thing about
 *  either one. */
export function gateErrorForStatus(status: number): string {
  if (status === 401) return GATE_WRONG_PASSWORD;
  if (status === 429) return GATE_RATE_LIMITED;
  return GATE_SERVER_SILENT;
}

/** What an attempt answers. A rejection is a sentence, never a status. */
export type GateAttempt = { ok: true } | { ok: false; error: string };

/** The dissolve's delay, in seconds. The door opens by the form going rather
 *  than by a spinner: what was in front of the reader leaves, and the wait the
 *  caller's navigation owes it is derived from this and `DUR.page` below, so
 *  the two cannot drift and a redirect cannot cut the dissolve in half. */
const UNLOCK_DELAY = 0.12;

function unlockMs(reduce: boolean): number {
  return Math.round((reduce ? DUR.fast : UNLOCK_DELAY + DUR.page) * 1000);
}

export function PasswordGate({
  head,
  foot,
  ground,
  inputLabel,
  errorId,
  submitLabel,
  pendingLabel,
  onAttempt,
  onOpen,
}: {
  /** What stands above the field: the lockup on sign-in, the lock on a share. */
  head: ReactNode;
  /** The quiet line at the bottom of the screen, if the screen has one. */
  foot?: ReactNode;
  /** What the paper of this screen is made of, drawn under everything. */
  ground?: ReactNode;
  inputLabel: string;
  /** The id the field points `aria-describedby` at while it is refused. */
  errorId: string;
  submitLabel: string;
  pendingLabel: string;
  /** Asks the server. It may throw: a request that never left is one of the
   *  four sentences, so the caller writes the fetch and nothing else. */
  onAttempt: (password: string) => Promise<GateAttempt>;
  /** Called once the form has dissolved, to go through the open door. */
  onOpen: () => void;
}) {
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "busy" | "open">("idle");
  const busy = phase !== "idle";

  const send = async (event: FormEvent) => {
    event.preventDefault();
    // The empty field is guarded here rather than by disabling the button: a
    // .4 plate is the loudest thing on an otherwise quiet screen, and it is
    // loudest at the moment the reader has not done anything wrong yet.
    if (!password || phase !== "idle") return;
    setPhase("busy");
    setError(null);
    let attempt: GateAttempt;
    try {
      attempt = await onAttempt(password);
    } catch {
      attempt = { ok: false, error: GATE_NO_CONNECTION };
    }
    if (attempt.ok) {
      setPhase("open");
      setTimeout(onOpen, unlockMs(!!reduce));
      return;
    }
    setPhase("idle");
    setError(attempt.error);
    // The value stays and the caret comes back over it. A refused password is
    // usually a typo in one the reader has, so the next try starts by typing
    // over what is there rather than by finding the field again — and after a
    // press the caret is on the button, so this is a focus and not a select.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const arrive = reduce
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        transition: { duration: DUR.fast },
      }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: DUR.page, ease: EASE_OUT },
      };

  const dissolve = reduce
    ? { opacity: 0, transition: { duration: DUR.fast } }
    : {
        opacity: 0,
        scale: 0.98,
        filter: "blur(4px)",
        transition: { duration: DUR.page, ease: EASE_OUT, delay: UNLOCK_DELAY },
      };

  return (
    <div className="relative grid min-h-dvh place-items-center bg-paper px-6 py-16">
      {ground}
      <motion.div
        initial={arrive.initial}
        animate={phase === "open" ? dissolve : arrive.animate}
        transition={arrive.transition}
        className="relative z-10 w-full max-w-[360px]"
      >
        {head}
        <form onSubmit={send} className="mt-8">
          <Field
            ref={inputRef}
            type={visible ? "text" : "password"}
            aria-label={inputLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            autoFocus
            autoComplete="current-password"
            className="h-11! text-body!"
            trailing={
              <IconButton
                type="button"
                size={28}
                aria-label={visible ? "Hide password" : "Show password"}
                aria-pressed={visible}
                onClick={() => setVisible((shown) => !shown)}
                className="brain-touch-hit"
              >
                <Icon
                  name={visible ? "eye-closed-linear" : "eye-linear"}
                  size={16}
                />
              </IconButton>
            }
          />

          {/* The refusal belongs under the field it is about, rather than
              crossing the screen as a toast: what is wrong is the value in
              that box, and the box is where the reader is looking.

              THE ROOM IS KEPT WHETHER OR NOT THERE IS ANYTHING IN IT. An
              opening slot used to push the card apart and, because the card
              is centred on its own height, it moved the lockup, the sentence
              and the field up while it pushed the button down — every object
              on the screen travelling at the one instant the reader is told
              they were wrong, and the button travelling under the hand that
              had just pressed it. So the slot is always this tall, the line
              arrives inside it, and the only thing that moves is the sentence.
              `min-h` rather than a fixed height: a refusal that wraps on a
              narrow phone grows rather than being clipped. */}
          <div data-gate-slot className="min-h-9 pt-2">
            <AnimatePresence initial={false}>
              {error && (
                <motion.p
                  key="refusal"
                  id={errorId}
                  // `role="alert"` and nothing beside it: the role already
                  // implies an assertive live region, and a second
                  // declaration is a second thing to keep in step.
                  role="alert"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: DUR.fast } }}
                  transition={{ duration: DUR.base, ease: EASE_OUT }}
                  className="text-table text-red"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {/* The one ink-filled control on this surface (§2 → Primary). It
              keeps the field's height, width and radius, so the two read as a
              pair, and the label swaps inside a box that never changes size:
              the width is the field's, not the word's. The blur belongs to the
              swap and not to the wait — two words changing in one place read
              as two words unless something bridges them, while a word held
              out of focus for the length of a request reads as a fault. So
              the key remounts the span and the blur resolves in 160ms.

              The wait is a turning glyph, and the label stays at full ink. A
              label dimmed for the 300–800ms a bcrypt compare takes is what a
              control taken away looks like, and this control has not been
              taken away: the press is refused by the submit handler rather
              than by `disabled`, so the button still reads as the way in. */}
          <Button
            type="submit"
            variant="ink"
            aria-busy={busy || undefined}
            className="h-11! w-full text-body!"
          >
            {busy && (
              <motion.span
                data-gate-working
                animate={reduce ? {} : { rotate: 360 }}
                transition={reduce ? undefined : SPIN}
                className="inline-flex"
              >
                <Icon name="restart-linear" size={16} />
              </motion.span>
            )}
            <motion.span
              key={busy ? "working" : "waiting"}
              data-gate-label
              initial={reduce ? false : { opacity: 0.5, filter: "blur(2px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              transition={{ duration: DUR.base, ease: EASE_OUT }}
              className="inline-block"
            >
              {busy ? pendingLabel : submitLabel}
            </motion.span>
          </Button>
        </form>
        {/* The one quiet fact this screen carries, under the card rather than
            pinned to the window: at the foot of the viewport it was an orphan
            280px below everything it belongs to on a desktop, and on a
            landscape phone it landed on the button. */}
        {foot && <div className="mt-6">{foot}</div>}
      </motion.div>
    </div>
  );
}
