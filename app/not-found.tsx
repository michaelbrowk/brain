import Link from "next/link";
import { Icon } from "@/components/ui/icon";

/** On-brand not-found — a page id that no longer resolves lands here instead of
 *  the raw Next.js default. Quiet register, matches the login surface. */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-6">
      <div className="flex flex-col items-center text-center">
        <Icon name="ghost-linear" size={30} className="text-ink-3" />
        <h1 className="mt-5 text-[22px] font-semibold tracking-tight text-ink">
          Nothing here
        </h1>
        <p className="mt-1.5 text-[14px] text-ink-3">
          This page moved, or never existed
        </p>
        <Link
          href="/"
          className="mt-6 flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
        >
          <Icon name="arrow-left-linear" size={15} className="text-ink-3" />
          Back to Brain
        </Link>
      </div>
    </main>
  );
}
