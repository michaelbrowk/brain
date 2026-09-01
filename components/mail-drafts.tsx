"use client";

import { Button, IconButton } from "./ui/button";
import { Icon } from "./ui/icon";
import { Skeleton } from "./ui/primitives";
import { ScrollEdge } from "./ui/scroll-edge";
import {
  isDeletableDraft,
  isResumableDraft,
  type MailDraftSummary,
} from "./mail-surface-client";

export type MailDraftsState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly drafts: readonly MailDraftSummary[] };

export function MailDraftsList({
  state,
  nav,
  onRetry,
  onResume,
  onDelete,
}: {
  state: MailDraftsState;
  /** The same control every other mail column wears. Drafts is a
   *  DESTINATION — it holds the column the way a folder does — so it is
   *  reached and left through the one menu that names every destination,
   *  and the head that used to carry a Back button and the word "Drafts" now
   *  carries the pill that says the same word and can be pressed. Two ways
   *  out of one place is the duplication §13 spent Compose cleaning up. */
  nav: React.ReactNode;
  onRetry: () => void;
  onResume: (draft: MailDraftSummary) => void;
  /** The invoker travels with the draft: deleting a saved draft asks first,
   *  and the confirmation has to hand focus back to the row it came from. */
  onDelete: (draft: MailDraftSummary, invoker: HTMLElement) => void;
}) {
  return (
    <section
      aria-label="Drafts"
      className="brain-mail-list"
      data-chrome-rows="1"
    >
      <header className="brain-mail-head">
        <div className="brain-mail-navrow">{nav}</div>
      </header>

      <div className="brain-mail-scroll">
        <ScrollEdge variant="blur" steps={1} />
        <div className="brain-mail-scrollfoot brain-mail-scrollpad">
        {state.kind === "loading" ? (
          <DraftsSkeleton />
        ) : state.kind === "error" ? (
          <DraftsMessage
            title="Drafts couldn’t load"
            body="Your saved drafts are still on the server."
            action={<Button variant="glass" onClick={onRetry}>Try again</Button>}
          />
        ) : state.drafts.length === 0 ? (
          <DraftsMessage
            title="No saved drafts"
            body="Unsent messages you start will wait here."
          />
        ) : (
          <div role="list" aria-label="Saved drafts">
            {state.drafts.map((draft) => {
              const title = draft.subject.trim() || "(no subject)";
              const resumable = isResumableDraft(draft);
              const deletable = isDeletableDraft(draft);
              const status = draftStatusLabel(draft);
              /* Both lines on ONE wrapper, and the wrapper takes the row's
                 width. `.brain-mail-row` aligns its items to flex-start, so
                 a line left to size itself had no width to truncate
                 against: a long subject grew past the capsule and took its
                 own date with it, 300px off the row at 1440. `self-stretch`
                 gives the lines the row's content box. The reserve for the
                 delete button is here too, once for both lines — 36, the
                 28 capsule plus the row's 8 text rule — because the row's
                 own padding is written in globals.css and a utility on the
                 row loses to it: the `pr-10` that used to sit there did
                 nothing, which is how the date came to sit under the trash. */
              const body = (
                <span
                  className={`flex min-w-0 flex-col self-stretch ${deletable ? "pr-9" : ""}`}
                >
                  {/* the time stands BESIDE the subject (§13), so the subject
                      takes its own width and gives way only when the line
                      runs out — not `flex-1`, which would push the time to
                      the row's edge on every row */}
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                      {title}
                    </span>
                    <time
                      dateTime={new Date(draft.updatedAt).toISOString()}
                      className="text-caption shrink-0 tabular-nums text-ink-3"
                    >
                      {formatDraftTime(draft.updatedAt)}
                    </time>
                  </span>
                  <span className="text-control mt-0.5 flex min-w-0 gap-1.5 text-ink-2">
                    <span className="truncate">{draftIntentLabel(draft)}</span>
                    {status && (
                      <span className="shrink-0 font-medium text-ink">· {status}</span>
                    )}
                  </span>
                </span>
              );
              return (
                <div key={draft.draftId} role="listitem" className="relative">
                  {/*
                    A draft mid-send or left ambiguous is listed so the writer
                    can see it, but the service refuses to reopen it — so it
                    renders as plain text rather than a control that does
                    nothing.
                  */}
                  {resumable ? (
                    <button
                      type="button"
                      onClick={() => onResume(draft)}
                      /* The two lines stack. `.brain-mail-row` is a flex ROW
                         for the mailbox's rail-avatar-text geometry, and a
                         draft has none of that — it is a title over a status,
                         which side by side reads as one clipped sentence.
                         The row's padding is the class's own (12 8 12 4). */
                      className="brain-mail-row group flex-col justify-center"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="brain-mail-row-static mx-inset py-3 pl-1 pr-2 text-left">
                      {body}
                    </div>
                  )}
                  {deletable && (
                    <IconButton
                      type="button"
                      size={28}
                      aria-label={`Delete draft ${title}`}
                      title="Delete draft"
                      onClick={(event) =>
                        onDelete(draft, event.currentTarget)
                      }
                      /* On the row's own text rule — 8 inside the capsule at
                         either inset, where the mailbox row keeps its time
                         and its paperclip. Anchored on the window's inset it
                         stood 4px past the capsule on the desktop and flush
                         with it on a phone, two positions for one control. */
                      className="brain-touch-hit absolute top-1/2 right-[calc(var(--inset)+8px)] -translate-y-1/2"
                    >
                      <Icon name="trash-bin-trash-linear" size={16} />
                    </IconButton>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </div>
        {/* below md this column runs under the mobile tab bar, exactly as the
            two thread columns do (§7) */}
        <ScrollEdge
          variant="blur"
          position="bottom"
          steps={1}
          size={90}
          className="md:hidden"
        />
      </div>
    </section>
  );
}

function DraftsMessage({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-table font-medium text-ink">{title}</p>
      <p className="text-caption mx-auto mt-1 max-w-[30ch] leading-relaxed text-ink-3">
        {body}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function DraftsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading drafts">
      {[0, 1, 2].map((item) => (
        <div key={item} className="px-3 py-3">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="mt-2 h-2.5 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * What Brain actually knows about this draft. `sent` never reaches the list, so
 * an idle draft needs no status line at all.
 */
function draftStatusLabel(draft: MailDraftSummary): string | null {
  if (draft.state === "submitting") return "Sending";
  if (draft.state === "failed") return "Didn’t send";
  if (draft.state === "delivery_unknown") return "Delivery unknown";
  return null;
}

function draftIntentLabel(draft: MailDraftSummary): string {
  if (draft.intent.kind === "reply") return "Reply";
  if (draft.intent.kind === "reply_all") return "Reply all";
  if (draft.intent.kind === "forward") return "Forward";
  return "New message";
}

function formatDraftTime(value: number): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}
