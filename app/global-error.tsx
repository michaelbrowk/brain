"use client";

import "./globals.css";

/** Root-layout error boundary. Replaces the layout entirely, so it must render
 *  its own <html>/<body> and import the stylesheet itself. Kept dependency-free
 *  beyond that — this screen must not be able to crash. */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="grid min-h-dvh place-items-center bg-paper px-6 antialiased">
        <div className="flex flex-col items-center text-center">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">
            Something broke
          </h1>
          <p className="mt-1.5 text-[14px] text-ink-3">
            Your notes are safe on disk. Reloading usually fixes this
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-6 flex h-9 items-center rounded-md border border-line px-3 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
