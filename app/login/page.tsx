"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { DUR, EASE_OUT } from "@/lib/motion";
import { safeOAuthReturnTo } from "@/lib/oauth/return-to";

// paper grain: static feTurbulence overlay, no repaints
const GRAIN =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`,
  );

type Phase = "idle" | "busy" | "unlocked";

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
        // the door opens: keyhole unlocks, the form dissolves, then navigate
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

  // staggered entrance (decorative — typing works from frame one)
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
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-paper px-6 pb-[12dvh]">
      {/* atmosphere: ink vignette (self-inverting via --ink) + paper grain */}
      <motion.div
        initial={{ opacity: reduced ? 1 : 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 640px 480px at 50% 38%, color-mix(in oklch, var(--ink) 4%, transparent), transparent 70%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035] dark:opacity-[0.05]"
        style={{ backgroundImage: `url("${GRAIN}")` }}
      />

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
        className="relative z-10 w-full max-w-[320px] text-center"
      >
        {/* identity: the keyhole — it unlocks on success */}
        <motion.div {...enter(0.05)} className="grid place-items-center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={phase === "unlocked" ? "open" : "closed"}
              initial={{ opacity: 0, filter: "blur(2px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(2px)" }}
              transition={{ duration: DUR.base }}
              className="text-ink-2"
            >
              <Icon
                name={
                  phase === "unlocked"
                    ? "lock-keyhole-minimalistic-unlocked-linear"
                    : "lock-keyhole-minimalistic-linear"
                }
                size={22}
              />
            </motion.span>
          </AnimatePresence>
        </motion.div>

        <motion.h1
          {...enter(0.1)}
          className="mt-5 text-[28px] font-semibold tracking-[-0.02em] text-ink"
        >
          Brain
        </motion.h1>
        <motion.p {...enter(0.16)} className="mt-2 text-[13px] text-ink-2">
          A quiet place to think
        </motion.p>

        <motion.div {...enter(0.24)}>
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
            className={`mt-10 h-12 w-full rounded-lg border bg-transparent px-4 text-center text-[15px] tracking-[0.08em] text-ink outline-none transition-[border-color,background-color] duration-200 placeholder:tracking-normal placeholder:text-ink-3 focus:border-ink-3 focus:bg-surface ${
              error ? "border-ink-2" : "border-line"
            }`}
          />
        </motion.div>

        <motion.div {...enter(0.3)}>
          <Button
            type="submit"
            disabled={phase !== "idle" || !password}
            className="mt-3 h-12 w-full rounded-lg text-[14px]"
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
              {phase === "busy" ? "Signing in…" : phase === "unlocked" ? "Welcome" : "Sign in"}
            </motion.span>
          </Button>
        </motion.div>

        <motion.p
          id="login-error"
          role="alert"
          aria-live="assertive"
          initial={false}
          animate={{ opacity: error ? 1 : 0, y: error ? 0 : -4 }}
          className="mt-4 min-h-5 text-[13px] text-ink-2"
        >
          {error}
        </motion.p>
      </motion.form>
    </div>
  );
}
