"use client";

import { useEffect, useState } from "react";
import { chunkRecoveryState, recoverFromStaleChunk } from "@/lib/stale-chunk";
import "./globals.css";

/** Root-layout error boundary. Replaces the layout entirely, so it must render
 *  its own <html>/<body> and import the stylesheet itself. Kept dependency-free
 *  beyond that and the pure chunk-recovery helpers — this screen must not be
 *  able to crash. A failed chunk reloads the document once (lib/stale-chunk)
 *  rather than `reset()`, which cannot bring a missing script back. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [recovery, setRecovery] = useState(() => chunkRecoveryState(error));

  useEffect(() => {
    if (recovery !== "reload") return;
    const outcome = recoverFromStaleChunk(error);
    if (outcome === "reload") return;
    // one terminal transition when the reload was refused after render, so
    // the empty body does not stay empty (see app/error.tsx)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecovery(outcome === "offline" ? "offline" : "unavailable");
  }, [error, recovery]);

  const stale = recovery !== "none";
  const hint =
    recovery === "reloaded"
      ? "Your notes are safe on disk. This tab already reloaded once and part of the app still would not load. Wait a moment, then reload again"
      : recovery === "offline"
        ? "Your notes are safe on disk. You're offline — reload once you're back"
        : "Your notes are safe on disk. Reloading usually fixes this";
  return (
    <html lang="en">
      <body className="grid min-h-dvh place-items-center bg-paper px-6 antialiased">
        {recovery !== "reload" && (
          <div className="flex flex-col items-center text-center">
            <h1 className="text-[22px] font-semibold tracking-tight text-ink">
              Something broke
            </h1>
            <p className="mt-1.5 max-w-[320px] text-[14px] text-ink-3">{hint}</p>
            <button
              type="button"
              onClick={stale ? () => window.location.reload() : reset}
              className="mt-6 flex h-9 items-center rounded-md border border-line px-3 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
            >
              {stale ? "Reload" : "Try again"}
            </button>
          </div>
        )}
      </body>
    </html>
  );
}
