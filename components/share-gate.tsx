"use client";

import { Wordmark } from "./shell/wordmark";
import {
  gateErrorForStatus,
  PasswordGate,
  type GateAttempt,
} from "./password-gate";
import { Icon } from "./ui/icon";

/** Password prompt on a protected shared page. On success the server sets a
 *  page-scoped cookie and a reload renders the content.
 *
 *  It stands the same objects in the same places as the sign-in screen: a 36px
 *  mark, a line in the Title register, a sentence in Body, the field, the ink
 *  pill, and one quiet fact at the foot of the screen. On sign-in the mark is
 *  the lockup and the fact is the running version; here the mark is the lock
 *  and the fact is whose software this is, since a visitor has arrived from a
 *  link and may never have seen Brain before.
 *
 *  What it does not say is anything about the page behind it. That is not
 *  restraint, it is the decision `generateMetadata` in `app/share/[id]/page.tsx`
 *  already makes: a share that is not granted answers with the title "Brain", so
 *  a locked link pasted into a chat does not unfurl the name of the page. A
 *  title or an emoji printed over this field would hand back exactly what that
 *  withholds, to anyone holding the address and to every crawler that follows
 *  it. */
export function ShareGate({ id }: { id: string }) {
  const attempt = async (password: string): Promise<GateAttempt> => {
    const response = await fetch("/api/share-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, password }),
    });
    if (response.ok) return { ok: true };
    return { ok: false, error: gateErrorForStatus(response.status) };
  };

  return (
    <PasswordGate
      head={
        <>
          <span className="flex size-9 items-center justify-center rounded-block bg-(--fill-tint) text-ink-2">
            <Icon name="lock-keyhole-minimalistic-linear" size={20} />
          </span>
          <h1 className="mt-4 text-title text-ink">Shared page</h1>
          <p className="mt-3 text-body text-ink-2">
            This page is shared with a password.
          </p>
        </>
      }
      foot={
        <span className="inline-flex items-center gap-2 text-ink-3">
          <Wordmark />
        </span>
      }
      inputLabel="Page password"
      errorId={`share-error-${id}`}
      submitLabel="Open"
      pendingLabel="Opening…"
      onAttempt={attempt}
      onOpen={() => location.reload()}
    />
  );
}
