"use client";

import {
  gateErrorForStatus,
  PasswordGate,
  type GateAttempt,
} from "./password-gate";
import { Wordmark } from "./shell/wordmark";
import { Icon } from "./ui/icon";

/** Password prompt on a protected shared page. On success the server sets a
 *  page-scoped cookie and a reload renders the content.
 *
 *  It stands the same objects in the same places as the sign-in screen: a 36px
 *  mark, a name, a sentence in Body, the field, the ink pill, and one quiet
 *  fact under the card. On sign-in the mark is the lockup and the fact is the
 *  running version; here the mark is the lock and the fact is whose software
 *  this is, since a visitor arrived from a link and may never have seen Brain
 *  before.
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
          {/* Body, not Title. In the display register "Shared page" was the
              loudest thing on the screen and said the least, standing over
              the field it exists to introduce. It names what the reader has
              arrived at and then gets out of the way, and ink against the
              sentence's ink-2 is what separates the two lines — §3's own
              distinction between a subject and a sentence. */}
          <h1 className="mt-4 text-body text-ink">Shared page</h1>
          <p className="mt-1 text-balance text-body text-ink-2">
            This page is shared with a password.
          </p>
        </>
      }
      /* A stranger who followed a link may never have seen Brain, and on a
         launch week a locked share is the first thing some of them meet. The
         lockup says whose software this is where a 12px caption whispered it. */
      foot={
        <span className="inline-flex items-center gap-2 text-ink-2">
          <span className="text-caption">Shared from</span>
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
