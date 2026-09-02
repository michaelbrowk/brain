"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { chunkRecoveryState, recoverFromStaleChunk } from "@/lib/stale-chunk";

/** Route-level error boundary. Before it existed, any render throw outside
 *  the Milkdown subtree unmounted the whole app to Next's default screen.
 *
 *  A chunk that failed to load is the one error `reset()` cannot recover:
 *  after a deploy the URL is gone from the server, and React.lazy keeps the
 *  rejection. That case reloads the document once instead (lib/stale-chunk);
 *  if the reload already happened, the screen says so and offers another. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // read once per boundary mount: the effect below spends the reload, and
  // the copy must not change under a re-render in the moment before it lands
  const [recovery] = useState(() => chunkRecoveryState(error));

  useEffect(() => {
    if (recovery === "reload") recoverFromStaleChunk(error);
  }, [error, recovery]);

  // the reload is on its way; painting the screen first would only flash it
  if (recovery === "reload") return null;

  const stale = recovery !== "none";
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-6">
      <div className="flex flex-col items-center text-center">
        <Icon name="danger-triangle-linear" size={30} className="text-ink-3" />
        <h1 className="mt-5 text-[22px] font-semibold tracking-tight text-ink">
          Something broke
        </h1>
        <p className="mt-1.5 max-w-[320px] text-[14px] text-ink-3">
          {recovery === "reloaded"
            ? "Your notes are safe on disk. This tab already reloaded once and part of the app still would not load. Wait a moment, then reload again"
            : "Your notes are safe on disk. Reloading usually fixes this"}
        </p>
        <button
          type="button"
          onClick={stale ? () => window.location.reload() : reset}
          className="mt-6 flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
        >
          {stale ? "Reload" : "Try again"}
        </button>
      </div>
    </main>
  );
}
