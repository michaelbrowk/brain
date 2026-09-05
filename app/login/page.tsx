"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";
import { DUR, EASE_OUT } from "@/lib/motion";
import { safeOAuthReturnTo } from "@/lib/oauth/return-to";

// paper grain: static feTurbulence overlay, no repaints
const GRAIN =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`,
  );

type Phase = "idle" | "busy" | "unlocked";

// The page is four things on flat paper — the lockup at the top, one line of
// title, one pill to type into, one ink pill to press — and nothing else. The
// keyhole that used to sit above the title went with the vignette: next to
// the wordmark it was a second mark, and the door opening is told by the form
// dissolving. The button is ink at all times: the submit handler is the guard
// against an empty field, and a .4 plate on paper read louder than the press.
export default function LoginPage() {
  const router = useRouter();
  const reduced = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [shake, setShake] = useState(0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || phase !== "idle") return;
    setPhase("busy");
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // the door opens: the form dissolves, then navigate
        setPhase("unlocked");
        setTimeout(
          () => {
            const candidate = new URLSearchParams(window.location.search).get(
              "returnTo",
            );
            const destination = safeOAuthReturnTo(candidate);
            router.replace(destination);
            router.refresh();
          },
          reduced ? 150 : 340,
        );
        return;
      }
      setError(
        res.status === 429
          ? "Too many attempts. Wait a bit."
          : res.status === 401
            ? "Wrong password"
            : "Couldn't sign in. Try again.",
      );
      if (!reduced) setShake((n) => n + 1);
      requestAnimationFrame(() => inputRef.current?.select());
    } catch {
      setError("Couldn't connect. Try again.");
      requestAnimationFrame(() => inputRef.current?.select());
    } finally {
      setPhase((current) => (current === "busy" ? "idle" : current));
    }
  };

  // staggered entrance (decorative — typing works from frame one): the title
  // first, then the field, then the button
  const enter = (delay: number) =>
    reduced
      ? {
          initial: { opacity: 0 },
          animate: { opacity: 1 },
          transition: { duration: 0.2 },
        }
      : {
          initial: { opacity: 0, y: 8, filter: "blur(4px)" },
          animate: { opacity: 1, y: 0, filter: "blur(0px)" },
          transition: { duration: DUR.page, ease: EASE_OUT, delay },
        };

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-paper px-6 pb-[6dvh]">
      {/* paper grain — the one texture; the paper is otherwise flat */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035] dark:opacity-[0.05]"
        style={{ backgroundImage: `url("${GRAIN}")` }}
      />

      {/* the sidebar's own lockup, standing at the top of the paper — it is
          the frame, not a step in the entrance, so it only fades */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reduced ? 0.2 : DUR.page + 0.1 }}
        className="absolute inset-x-0 top-[calc(env(safe-area-inset-top,0px)+32px)] flex justify-center"
      >
        <span className="inline-flex items-center gap-2 text-ink">
          <Wordmark />
        </span>
      </motion.div>

      <motion.form
        onSubmit={submit}
        animate={
          phase === "unlocked"
            ? reduced
              ? { opacity: 0, transition: { duration: 0.15 } }
              : {
                  opacity: 0,
                  scale: 0.98,
                  filter: "blur(4px)",
                  transition: { duration: 0.2, ease: EASE_OUT, delay: 0.12 },
                }
            : {}
        }
        className="relative z-10 w-full max-w-[360px] text-center"
      >
        {/* the title register in the system face — login is chrome, so it
            does not follow the reader's Literata setting the way a page
            title does; the wordmark beside it is SF too */}
        <motion.h1 {...enter(0)} className="text-title text-balance text-ink">
          A quiet place to think
        </motion.h1>

        {/* the field on paper (§12): the hairline ring at rest — the one
            hairline held to 3:1, what says "type here" once focus leaves —
            a step stronger on hover, the blue ring on focus, and the same
            ladder in red while the password is wrong; the glass fill sits
            under it so the capsule reads as a pill and not as an outline */}
        <motion.div {...enter(0.08)} className="mt-8">
          <motion.input
            key={shake}
            ref={inputRef}
            animate={shake ? { x: [0, -6, 6, -3, 3, 0] } : {}}
            transition={{ duration: 0.3 }}
            type="password"
            aria-label="Password"
            aria-invalid={!!error}
            aria-describedby={error ? "login-error" : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            autoComplete="current-password"
            className="h-11 w-full rounded-full bg-(--fill-field-glass) px-5 text-center text-body text-ink shadow-[0_0_0_1px_var(--hair-field)] outline-none transition-[background-color,box-shadow] duration-[160ms] ease-(--ease-out) placeholder:text-ink-2 hover:bg-(--fill-field-glass-hover) hover:shadow-[0_0_0_1px_var(--hair-field-strong)] hover:duration-[80ms] focus:bg-(--fill-field-glass) focus:shadow-[0_0_0_1.5px_var(--blue)] aria-[invalid=true]:shadow-[0_0_0_1px_var(--hair-field-invalid)] aria-[invalid=true]:hover:shadow-[0_0_0_1px_var(--red)] aria-[invalid=true]:focus:shadow-[0_0_0_1.5px_var(--red)]"
          />
        </motion.div>

        {/* the one ink-filled primary on this surface: the field's own height,
            capsule and Body register, so the two pills read as a pair (the
            .btn block is unlayered, hence the bangs) */}
        <motion.div {...enter(0.16)} className="mt-3">
          <Button
            type="submit"
            variant="ink"
            className="h-11! w-full rounded-full! text-body!"
          >
            <motion.span
              animate={
                phase === "busy" && !reduced
                  ? { filter: "blur(2px)", opacity: 0.7 }
                  : { filter: "blur(0px)", opacity: 1 }
              }
              transition={{ duration: DUR.base, ease: EASE_OUT }}
              className="inline-block"
            >
              {phase === "busy" ? "Signing in…" : "Sign in"}
            </motion.span>
          </Button>
        </motion.div>

        <motion.p
          id="login-error"
          role="alert"
          aria-live="assertive"
          initial={false}
          animate={{ opacity: error ? 1 : 0, y: error ? 0 : -4 }}
          className="mt-4 min-h-5 text-table text-ink-2"
        >
          {error}
        </motion.p>
      </motion.form>
    </div>
  );
}
