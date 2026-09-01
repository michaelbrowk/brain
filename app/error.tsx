"use client";

import { Icon } from "@/components/ui/icon";

/** Route-level error boundary. Before it existed, any render throw outside
 *  the Milkdown subtree unmounted the whole app to Next's default screen. */
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-6">
      <div className="flex flex-col items-center text-center">
        <Icon name="danger-triangle-linear" size={30} className="text-ink-3" />
        <h1 className="mt-5 text-[22px] font-semibold tracking-tight text-ink">
          Something broke
        </h1>
        <p className="mt-1.5 text-[14px] text-ink-3">
          Your notes are safe on disk. Reloading usually fixes this
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
