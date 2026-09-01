"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { Button, IconButton } from "./ui/button";
import { Icon } from "./ui/icon";
import { ScrollEdge } from "./ui/scroll-edge";
import { ToolbarDivider, ToolbarPill } from "./ui/toolbar-pill";
import { MailRow, MailRowSkeleton } from "./mail-row";
import type {
  MailMailboxThreadPage,
  MailSearchThreadPage,
  MailSystemMailbox,
  MailThreadListItem,
  MailThreadPage,
  PublicMailAccount,
} from "./mail-surface-client";
import type { MailThreadSort, MailThreadView } from "@/lib/mail/message-types";

export type MailThreadListPage =
  | MailThreadPage
  | MailMailboxThreadPage
  | MailSearchThreadPage;

export type MailThreadListState =
  | { readonly kind: "loading" }
  | { readonly kind: "invalid-search" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly page: MailThreadListPage };

export function MailThreadList({
  accounts,
  nav,
  selectedAccountId,
  selectedMailboxId,
  selectedView,
  threadSort,
  selectedThreadId,
  searchQuery,
  state,
  syncing,
  onSelectSort,
  onSelectThread,
  onSearchQueryChange,
  onCompose,
  onOpenDrafts,
  failedDraftCount = 0,
  submittingDraftCount = 0,
  onSync,
  onRetry,
  onLoadMore,
  onOpenSettings,
}: {
  accounts: readonly PublicMailAccount[];
  /** The one control that owns account and folder navigation, built by the
   *  surface and the same object on every mail column (`MailNav`). */
  nav: React.ReactNode;
  selectedAccountId: string;
  selectedMailboxId: MailSystemMailbox;
  selectedView: MailThreadView | null;
  threadSort: MailThreadSort;
  selectedThreadId: string | null;
  searchQuery: string;
  state: MailThreadListState;
  syncing: boolean;
  onSelectSort: (sort: MailThreadSort) => void;
  onSelectThread: (thread: MailThreadListItem) => void;
  onSearchQueryChange: (query: string) => void;
  onCompose: () => void;
  onOpenDrafts?: () => void;
  failedDraftCount?: number;
  submittingDraftCount?: number;
  onSync: () => void;
  onRetry: () => void;
  onLoadMore: (cursor: string) => void;
  onOpenSettings: (invoker: HTMLElement, accountId?: string) => void;
}) {
  const reduce = useReducedMotion();
  const selectedAccount = accounts.find(
    (account) => account.accountId === selectedAccountId,
  );
  const mailboxLabel = formatMailboxLabel(selectedMailboxId);
  const unavailable =
    state.kind === "ready" && "availability" in state.page &&
    state.page.availability.status === "unavailable"
      ? state.page.availability
      : null;
  const draftsLabel = mailDraftsLabel(failedDraftCount, submittingDraftCount);
  /* THE DRAFTS ICON EXISTS ONLY WHILE ITS REASON DOES. Drafts is a
     destination and its door is the nav menu; a second door in the toolbar
     was the duplication §13 already cleaned off Compose. What the menu cannot
     do is shout — a send that failed is visible there only once the menu is
     open. So the icon comes back for exactly as long as there is a failed
     send to report and leaves with it, which is the same rule read forward:
     a control lives as long as its reason. An in-flight send is not a
     reason — it corrects itself. */
  const failedDrafts = onOpenDrafts !== undefined && failedDraftCount > 0;

  return (
    <section
      aria-label="Mailbox"
      className="brain-mail-list"
      data-chrome-rows="2"
    >
      <header className="brain-mail-head">
        <div className="brain-mail-navrow">
          {nav}
          <ToolbarPill className="ml-auto shrink-0">
            {failedDrafts && (
              <IconButton
                type="button"
                size={36}
                aria-label={draftsLabel}
                title={draftsLabel}
                className="brain-touch-hit relative"
                onClick={onOpenDrafts}
              >
                <Icon name="document-text-linear" size={18} />
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ink px-1 text-[11px] font-medium leading-none text-paper"
                >
                  {failedDraftCount > 9 ? "9+" : failedDraftCount}
                </span>
              </IconButton>
            )}
            {selectedAccount?.capabilities.compose && (
              <IconButton
                type="button"
                size={36}
                aria-label="New message"
                title="New message"
                className="brain-touch-hit"
                onClick={onCompose}
              >
                <Icon name="pen-new-square-linear" size={18} />
              </IconButton>
            )}
            {(failedDrafts || selectedAccount?.capabilities.compose) && (
              <ToolbarDivider />
            )}
            <MailSortMenu
              sort={threadSort}
              disabled={searchQuery.trim() !== ""}
              onSelectSort={onSelectSort}
            />
            <IconButton
              type="button"
              size={36}
              aria-label={syncing ? "Syncing mail" : "Sync mail"}
              title={syncing ? "Syncing" : "Sync mail"}
              disabled={syncing || selectedAccount?.status === "reauth_required"}
              className="brain-touch-hit"
              onClick={onSync}
            >
              <Icon name="history-2-linear" size={18} />
            </IconButton>
          </ToolbarPill>
        </div>

        <label className="brain-mail-search">
          <span className="sr-only">Search mail</span>
          <Icon name="magnifer-linear" size={16} className="shrink-0" />
          <input
            aria-label="Search mail"
            type="search"
            inputMode="search"
            autoComplete="off"
            enterKeyHint="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            placeholder={`Search ${mailboxLabel}`}
            className="md:text-control min-w-0 flex-1 bg-transparent text-[16px] font-medium text-ink outline-none md:leading-[1.25] placeholder:text-ink-2"
          />
        </label>
      </header>

      <div className="brain-mail-scroll">
        {/* the head floats over the rows in every mode now, so the edge is
            unconditional and its height follows --mail-chrome in CSS (§7) */}
        <ScrollEdge variant="blur" steps={1} />
        <div className="brain-mail-scrollfoot brain-mail-scrollpad">
        <p
          aria-live="polite"
          className="text-caption truncate px-6 pb-1 pt-2 tabular-nums text-ink-3"
        >
          {selectedAccount?.status === "reauth_required"
            ? "Reconnect needed"
            : formatSyncStatus(state.kind === "ready" ? state.page : null, syncing)}
        </p>
        {state.kind === "ready" && "scope" in state.page && (
          <p aria-live="polite" className="text-caption px-6 pb-1 text-ink-3">
            {state.page.indexStatus === "building"
              ? "Indexing cached mail — results are partial"
              : state.page.resultsTruncated
                ? "Showing recent matching mail"
                : "Searching cached headers and previews"}
          </p>
        )}
        {selectedAccount?.status === "reauth_required" ? (
          <ListMessage
            title="Reconnect this account"
            body="Open Mail settings to reconnect before syncing."
            action={
              <Button
                variant="glass"
                onClick={(event) =>
                  onOpenSettings(event.currentTarget, selectedAccountId)
                }
              >
                Open settings
              </Button>
            }
          />
        ) : state.kind === "loading" ? (
          <ThreadListSkeleton />
        ) : state.kind === "invalid-search" ? (
          <ListMessage
            title="Search needs different words"
            body="Use up to 12 shorter words containing letters or numbers."
          />
        ) : state.kind === "error" ? (
          <ListMessage
            title={`${mailboxLabel} couldn’t load`}
            body="Your mail is still on the server."
            action={<Button variant="glass" onClick={onRetry}>Try again</Button>}
          />
        ) : unavailable ? (
          <ListMessage
            title={mailboxUnavailableTitle(mailboxLabel, unavailable.reason)}
            body={mailboxUnavailableBody(unavailable.reason)}
            action={<Button variant="quiet" onClick={onRetry}>Check again</Button>}
          />
        ) : state.page.items.length === 0 ? (
          <ListMessage
            title={"scope" in state.page ? "No matching mail" : `${mailboxLabel} is empty`}
            body={
              "scope" in state.page
                ? "Search checks cached senders, subjects, and previews."
                : mailboxEmptyBody(selectedMailboxId)
            }
            action={
              "scope" in state.page ? undefined : (
                <Button
                  variant="quiet"
                  onClick={selectedMailboxId === "inbox" ? onSync : onRetry}
                  disabled={syncing}
                >
                  {syncing
                    ? "Syncing"
                    : selectedMailboxId === "inbox"
                      ? "Sync now"
                      : "Check again"}
                </Button>
              )
            }
          />
        ) : (
          <>
            <AnimatePresence mode="popLayout">
              <motion.div
                key={`${selectedMailboxId}|${selectedView ?? ""}`}
                role="list"
                aria-label={`${mailboxLabel} threads`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: DUR.fast, ease: EASE_OUT }}
              >
                {state.page.items.map((thread, index) => (
                  <motion.div
                    key={thread.threadId}
                    role="listitem"
                    className="brain-mail-row-item"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
                    animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
                    transition={{
                      duration: DUR.fast,
                      ease: EASE_OUT,
                      delay: reduce || index >= 8 ? 0 : index * 0.025,
                    }}
                  >
                    <ThreadRow
                      thread={thread}
                      active={thread.threadId === selectedThreadId}
                      sizeMode={threadSort === "size"}
                      onSelect={() => onSelectThread(thread)}
                    />
                  </motion.div>
                ))}
              </motion.div>
            </AnimatePresence>
            {state.page.nextCursor && (
              <div className="flex justify-center px-3 py-3">
                <Button
                  variant="quiet"
                  onClick={() => onLoadMore(state.page.nextCursor as string)}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
        </div>
        {/* Below md this column runs under the mobile tab bar exactly as the
            unified one does (§7), and two lists in one slot are one design. */}
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

/**
 * The single-account row is `MailRow` with two fields dropped: no avatar
 * (this list knows whose mailbox it is) and no account word (there is one
 * account). Everything else is the shared object — the unread rail, the count
 * chip, the subject-plus-snippet line, the attachment column.
 */
function ThreadRow({
  thread,
  active,
  sizeMode,
  onSelect,
}: {
  thread: MailThreadListItem;
  active: boolean;
  sizeMode: boolean;
  onSelect: () => void;
}) {
  return (
    <MailRow
      thread={thread}
      active={active}
      timeLabel={formatThreadTime(thread.lastMessageAt)}
      sizeLabel={sizeMode ? formatSizeBytes(thread.sizeBytes) : undefined}
      onSelect={onSelect}
    />
  );
}

const MAIL_THREAD_SORTS: readonly MailThreadSort[] = [
  "date",
  "unread",
  "sender",
  "size",
];

function sortLabel(sort: MailThreadSort): string {
  if (sort === "unread") return "Unread first";
  if (sort === "sender") return "Sender";
  if (sort === "size") return "Size";
  return "Date";
}

function MailSortMenu({
  sort,
  disabled,
  onSelectSort,
}: {
  sort: MailThreadSort;
  disabled: boolean;
  onSelectSort: (sort: MailThreadSort) => void;
}) {
  const label = sortLabel(sort);
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <IconButton
          type="button"
          size={36}
          aria-label={`Sort: ${label}`}
          title={`Sort: ${label}`}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          className="brain-touch-hit relative"
        >
          <Icon name="sort-vertical-linear" size={18} />
          {sort !== "date" && (
            <span
              aria-hidden
              className="absolute right-1.5 top-1.5 size-1 rounded-full bg-ink-2"
            />
          )}
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="brain-menu z-[var(--z-modal)] w-[176px]"
        >
          {MAIL_THREAD_SORTS.map((option) => (
            <Dropdown.Item
              key={option}
              className="brain-menu-item"
              onSelect={() => onSelectSort(option)}
            >
              <span className="min-w-0 flex-1 truncate">
                {sortLabel(option)}
              </span>
              {option === sort && (
                <Icon
                  name="check-linear"
                  size={14}
                  className="shrink-0 text-ink"
                />
              )}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function ListMessage({
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

function ThreadListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading mail folder">
      {[0, 1, 2, 3, 4].map((item) => (
        <MailRowSkeleton key={item} />
      ))}
    </div>
  );
}

export function formatThreadTime(value: number | null): string {
  if (value === null) return "";
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

function formatSyncStatus(
  page: MailThreadListPage | null,
  syncing: boolean,
): string {
  if (syncing) return "Syncing";
  if (page === null) return "";
  if ("scope" in page) {
    if (page.indexStatus === "building") return "Indexing";
    if (page.resultsTruncated) return "Recent matches";
  }
  if ("sync" in page) {
    if (page.sync.status === "syncing") return "Syncing";
    if (page.sync.status === "backoff") return "Retrying later";
    if (page.sync.status === "cache_full") return "Mail cache full";
    if (page.sync.status === "reauth_required") return "Reconnect needed";
    return formatUpdatedAt(page.sync.lastSuccessfulAt);
  }
  if (page.availability.status === "unavailable") {
    if (page.availability.reason === "mailbox_backoff") return "Retrying later";
    if (page.availability.reason === "mailbox_cache_capacity") {
      return "Mail cache full";
    }
    if (page.availability.reason === "mailbox_reauth_required") {
      return "Reconnect needed";
    }
    return "Preparing";
  }
  if (page.availability.windowTruncated) return "Recent mail";
  return formatUpdatedAt(page.availability.lastSuccessfulAt);
}

function formatUpdatedAt(value: number | null): string {
  if (value === null) return "";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - value) / 60_000),
  );
  if (minutes < 1) return "Updated now";
  if (minutes < 60) return `Updated ${minutes}m`;
  if (minutes < 24 * 60) return `Updated ${Math.floor(minutes / 60)}h`;
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value))}`;
}

export function formatMailboxLabel(mailboxId: MailSystemMailbox): string {
  if (mailboxId === "all") return "All Mail";
  return `${mailboxId.slice(0, 1).toUpperCase()}${mailboxId.slice(1)}`;
}

/** A failed send outranks an in-flight one — the writer must act on it. */
export function mailDraftsLabel(
  failedDraftCount: number,
  submittingDraftCount: number,
): string {
  if (failedDraftCount > 0) return `Drafts, ${failedDraftCount} didn’t send`;
  if (submittingDraftCount > 0) return "Drafts, sending";
  return "Drafts";
}

export type MailSmartViewItem = {
  readonly view: MailThreadView;
  readonly mailboxId: MailSystemMailbox;
  readonly label: string;
};

/**
 * The four smart destinations as (mailbox, view) pairs. Unread, Lists, and
 * People read the inbox; Attachments prefers All Mail when the account has it
 * so results are not limited to what is still in the inbox.
 */
export function mailSmartViewItems(
  mailboxes: readonly MailSystemMailbox[],
): readonly MailSmartViewItem[] {
  return [
    { view: "unread", mailboxId: "inbox", label: "Unread" },
    { view: "lists", mailboxId: "inbox", label: "Lists" },
    { view: "people", mailboxId: "inbox", label: "People" },
    {
      view: "attachments",
      mailboxId: mailboxes.includes("all") ? "all" : "inbox",
      label: "Attachments",
    },
  ];
}

/**
 * Thread size for the size-sorted list. Zero means the server has no size for
 * this thread, so show a placeholder instead of a lying "0 KB". Anything under
 * a kilobyte still counts as one.
 */
export function formatSizeBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function mailboxUnavailableTitle(
  mailboxLabel: string,
  reason: Extract<
    MailMailboxThreadPage["availability"],
    { readonly status: "unavailable" }
  >["reason"],
): string {
  if (reason === "mailbox_backoff") return `${mailboxLabel} will retry`;
  if (reason === "mailbox_cache_capacity") return "Local mail cache is full";
  if (reason === "mailbox_reauth_required") return "Reconnect this account";
  return `${mailboxLabel} is preparing`;
}

function mailboxUnavailableBody(
  reason: Extract<
    MailMailboxThreadPage["availability"],
    { readonly status: "unavailable" }
  >["reason"],
): string {
  if (reason === "mailbox_backoff") {
    return "Brain will try this folder again in the background.";
  }
  if (reason === "mailbox_cache_capacity") {
    return "Brain has no local space left for this account's mail, so syncing is paused.";
  }
  if (reason === "mailbox_reauth_required") {
    return "Reconnect before Brain can refresh this folder.";
  }
  return "Brain is fetching this folder in the background.";
}

function mailboxEmptyBody(mailboxId: MailSystemMailbox): string {
  if (mailboxId === "sent") return "Sent messages will appear here.";
  if (mailboxId === "starred") return "Star a conversation to keep it here.";
  if (mailboxId === "spam") return "Messages marked as spam will appear here.";
  if (mailboxId === "trash") return "Deleted conversations will appear here.";
  if (mailboxId === "all") return "Synced conversations will appear here.";
  return "New mail will appear here after the next sync.";
}
