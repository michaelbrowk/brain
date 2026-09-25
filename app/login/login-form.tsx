"use client";

import { useRouter } from "next/navigation";
import { Wordmark } from "@/components/shell/wordmark";
import {
  gateErrorForStatus,
  PasswordGate,
  type GateAttempt,
} from "@/components/password-gate";
import { safeOAuthReturnTo } from "@/lib/oauth/return-to";

/** Paper grain: one static feTurbulence overlay, no repaints. It is the one
 *  texture on this screen, and it belongs to the owner's side only — the
 *  shared page behind the visitor's gate is flat paper, and a grain on the
 *  gate would be something that goes away when the door opens. */
const GRAIN =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`,
  );

/** The first screen a new installation shows, and the screen a returning owner
 *  meets on a device that has never signed in. It is the lockup in the display
 *  register, the sentence README.md opens with, the field, the ink pill, and the
 *  running version at the foot: four things and a number, on paper.
 *
 *  The sentence is the product's own rather than one written for this screen.
 *  Somebody who has just run `install.sh` is looking at the first page their
 *  own server has ever served them, and what they need to read is what the
 *  thing is, not how it feels about itself.
 *
 *  `version` comes from the server component beside this one. It cannot be read
 *  here: `lib/release-info` reaches `node:fs`, and a value-import of it from a
 *  `"use client"` file is a client-bundle violation `pnpm check` cannot see. */
export function LoginForm({ version }: { version: string | null }) {
  const router = useRouter();

  const attempt = async (password: string): Promise<GateAttempt> => {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (response.ok) return { ok: true };
    return { ok: false, error: gateErrorForStatus(response.status) };
  };

  const open = () => {
    const candidate = new URLSearchParams(window.location.search).get(
      "returnTo",
    );
    router.replace(safeOAuthReturnTo(candidate));
    router.refresh();
  };

  return (
    <PasswordGate
      ground={
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.035] dark:opacity-[0.05]"
          style={{ backgroundImage: `url("${GRAIN}")` }}
        />
      }
      head={
        <>
          <h1 className="flex items-center gap-3 text-ink">
            <Wordmark size="lg" />
          </h1>
          {/* Balanced: at 320 the line broke with "server." alone under it,
              and an orphan under a lockup reads as a mistake in the copy. */}
          <p className="mt-3 text-balance text-body text-ink-2">
            A notes app you keep on your own server.
          </p>
        </>
      }
      foot={
        version && (
          <p className="text-caption text-ink-3">{`Brain ${version}`}</p>
        )
      }
      inputLabel="Password"
      errorId="login-error"
      submitLabel="Sign in"
      pendingLabel="Signing in…"
      onAttempt={attempt}
      onOpen={open}
    />
  );
}
