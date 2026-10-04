"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, useReducedMotion } from "framer-motion";
import { isEditableEventTarget } from "@/lib/editable-target";
import { PROJECT_URL } from "@/lib/project";
import {
  MailComposer,
  type MailComposerDraft,
  type MailComposerFields,
  type MailComposerLeaving,
  type MailComposerSaveStatus,
} from "./mail-composer";
import { ATTACHMENT_REFUSALS } from "./mail-composer-attachments";
import { parkDiscard, type DeferredDiscard } from "./mail-deferred-discard";
import { MailDraftsList, type MailDraftsState } from "./mail-drafts";
import {
  directActionForMailbox,
  letterInInbox,
  MailReader,
  waitForContentPoll,
  type MailReaderAction,
  type MailReaderState,
} from "./mail-reader";
import {
  clearComposeRequest,
  emitMailCommand,
  onMailCommand,
  pendingComposeRequest,
  subscribeComposeRequest,
} from "./mail-commands";
import {
  clearOpenThreadRequest,
  defaultMailSurfaceClient,
  isListedDraft,
  isMailMutationTimeout,
  MailApiError,
  pendingOpenThread,
  subscribeOpenThread,
  type MailOpenRequest,
  type MailAccountCapabilities,
  type MailDraft,
  type MailDraftCreateInput,
  type MailDraftIntent,
  type MailDraftMutationResult,
  type MailDraftPatchInput,
  type MailDraftSummary,
  type MailSendInput,
  type MailSystemMailbox,
  type MailSurfaceClient,
  type MailThreadDetail,
  type MailThreadListItem,
  type PublicMailAccount,
} from "./mail-surface-client";
import { MailNav } from "./mail-nav";
import { markMailCentreRead } from "./notifications-read";
import { SMART_UNDO_MS } from "./shell/helpers";
import {
  MailThreadList,
  mailSmartViewItems,
  type MailThreadListPage,
  type MailThreadListState,
} from "./mail-thread-list";
import {
  appendStreamPage,
  compareUnified,
  deriveUnifiedSections,
  mergedDisplayItems,
  reconcileStreamPageOne,
  removeStreamItems,
  restoreStreamItems,
  UNIFIED_ACCOUNT_ID,
  UNIFIED_EXPAND_COLLAPSED,
  UNIFIED_PAGE_SIZE,
  unifiedThreadKey,
  visibleUnifiedItems,
  waitsOn,
  type UnifiedExpandKey,
  type UnifiedExpandState,
  type UnifiedState,
  type UnifiedStickyOpen,
  type UnifiedStream,
} from "./mail-unified";
import { MailUnifiedList, NewSendersSection } from "./mail-unified-list";
import {
  applyShownDecisions,
  domainScopeAllowed,
  senderDomain,
  senderName,
  splitNewSenders,
  waitingAtDomain,
  type SenderScope,
  type SenderVerdict,
  type ShownSenderDecision,
} from "./mail-new-senders";
import {
  NO_DONE,
  doneQueue,
  hideDone,
  holdDone,
  landDone,
  releaseDone,
  settleDone,
  type DoneFailure,
  type DoneOutcome,
  type DoneOverlay,
} from "./mail-section-done";
import type { SenderDecide } from "./mail-new-sender-row";
import {
  flipElements,
  flipRowKey,
  ghostFlip,
  handFocusOn,
  playFlip,
  snapshotFlip,
} from "./mail-flip";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Skeleton, type ToastOptions } from "./ui/primitives";
import type {
  MailSenderScreenState,
  MailThreadMutationInput,
  MailThreadPage,
  MailThreadSort,
  MailThreadView,
} from "@/lib/mail/message-types";
import {
  MAIL_CHANGED_EVENT,
  MAIL_EVENT_DEBOUNCE_MS,
  parseBrainMailEvent,
  type BrainMailEvent,
} from "@/lib/mail/mail-events";
import { normalizeMailSearchQueryText } from "@/lib/mail/search-query";
import { readableMailBody } from "@/lib/mail/reader-content";
import {
  deriveReplyAllRecipients,
  deriveReplyRecipients,
  forwardedPlainText,
  forwardedSubject,
} from "@/lib/mail/reply-forward";

/**
 * How many per-account requests the unified inbox keeps in flight at once.
 *
 * The merge is generic in the number of streams, so the account cap can rise
 * without it noticing. The machine underneath cannot: the mail service holds
 * one shared vCPU beside the rest of Brain, and every page-1 request is a
 * cache read, a JSON encode and a parse on that core. Unbounded, opening All
 * inboxes on seven accounts would ask for all seven in the same instant, so
 * raising the account cap meant bounding this first.
 *
 * Three is the concurrency the surface already ran at the old three-account
 * cap, on the box that has been carrying it. Raising the number of accounts a
 * reader may connect is not a reason to raise the peak load their inbox makes,
 * so the peak stays where it has been measured and the seventh account waits
 * a turn instead.
 */
export const UNIFIED_FANOUT_LIMIT = 3;

/**
 * How long a unified stream a sync is holding waits before it is read again,
 * and how many times it is, before its row says it couldn't load.
 *
 * The service answers a list read with 409 `mail_sync_in_progress` while a
 * sync moves the account's cache under it: a page cursor taken before the
 * move names a snapshot that is gone. That is a wait, not an outage, and the
 * account answers again a moment later. Three reads a second and a half apart
 * cover a sync's commit without leaving a real failure unreported for long.
 */
const SYNC_HOLD_RETRY_MS = 1_500;
const SYNC_HOLD_RETRIES = 3;

/**
 * THE SAFETY NET UNDER THE CHANGE FEED. New mail reaches the column as `mail`
 * events (`lib/mail/mail-events.ts`), and the list reads itself on this timer
 * only in case the stream or the loop behind it lost one. The same read runs
 * on returning to the tab and once when the stream reconnects.
 */
export const MAIL_SAFETY_REFRESH_MS = 5 * 60_000;

// The debounce lives beside the event it times (`lib/mail/mail-events.ts`);
// it is still exported here, where this surface's tests read it.
export { MAIL_EVENT_DEBOUNCE_MS };

/**
 * Mail events gathered per account, each account handed on
 * `MAIL_EVENT_DEBOUNCE_MS` after its own last event, so a busy account never
 * holds a quiet one back. `null` is a reset and stands for every account.
 */
function debounceMailEvents(onDue: (accountIds: ReadonlySet<string> | null) => void): {
  push(accountId: string | null): void;
  dispose(): void;
} {
  const timers = new Map<string | null, ReturnType<typeof setTimeout>>();
  return {
    push(accountId) {
      const pending = timers.get(accountId);
      if (pending !== undefined) clearTimeout(pending);
      timers.set(
        accountId,
        setTimeout(() => {
          timers.delete(accountId);
          onDue(accountId === null ? null : new Set([accountId]));
        }, MAIL_EVENT_DEBOUNCE_MS),
      );
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** The event the shell re-dispatched, or `null` for anything else. */
function mailEventOf(event: Event): BrainMailEvent | null {
  return parseBrainMailEvent((event as CustomEvent<unknown>).detail);
}

/**
 * `Promise.allSettled(inputs.map(run))` with at most `limit` of them running
 * at a time. Results come back in input order, so every caller can keep
 * pairing result `i` with input `i`, and a rejection settles its own slot and
 * releases it: one account failing hands its turn to the next in the queue
 * rather than holding the queue behind it.
 */
export function settleWithLimit<T, R>(
  inputs: readonly T[],
  limit: number,
  run: (input: T) => Promise<R>,
): Promise<readonly PromiseSettledResult<R>[]> {
  const width = Math.max(limit, 1);
  if (inputs.length <= width) {
    // Nothing to queue, so hand back the same promise an unbounded fan-out
    // would have made. Not an optimization: an extra async frame here would
    // resolve a microtask later than before, and a surface under the limit
    // must settle exactly when it used to.
    return Promise.allSettled(
      inputs.map((input) => {
        try {
          return run(input);
        } catch (reason) {
          return Promise.reject<R>(reason);
        }
      }),
    );
  }
  return drainWithLimit(inputs, width, run);
}

async function drainWithLimit<T, R>(
  inputs: readonly T[],
  width: number,
  run: (input: T) => Promise<R>,
): Promise<readonly PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(inputs.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < inputs.length; index = next++) {
      try {
        results[index] = {
          status: "fulfilled",
          value: await run(inputs[index]!),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

type AccountsState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly accounts: readonly PublicMailAccount[] }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" };

type ComposerState = {
  readonly accountId: string;
  readonly draftId: string;
  readonly draft: MailComposerDraft;
  readonly sending: boolean;
  readonly error: string | null;
  readonly blocked: boolean;
  /** The error is a reauth failure: the footer offers Mail settings. */
  readonly errorSettings: boolean;
};

/**
 * Mirrors the durable draft the open composer autosaves into. `revision` stays
 * null until the first `createDraft` acknowledges, and advances with every
 * accepted patch or send. `pendingFields` is the newest unsaved edit; the sync
 * loop persists it and never overwrites it with slower server truth. `frozen`
 * pauses autosave while a send holds the draft in a `submitting`/frozen state.
 */
type DraftSync = {
  draftId: string;
  accountId: string;
  recoverySourceDraftId: string | null;
  idempotencyKey: string;
  createInput: MailDraftCreateInput;
  revision: number | null;
  savedFields: MailComposerFields;
  pendingFields: MailComposerFields | null;
  pendingMutationId: string | null;
  inFlightCreate: MailDraftCreateInput | null;
  inFlightPatch: {
    readonly fields: MailComposerFields;
    readonly mutationId: string;
    readonly expectedRevision: number;
  } | null;
  chain: Promise<void>;
  closed: boolean;
  frozen: boolean;
};

/**
 * What Discard parks behind its Undo: the draft's sync record, detached from
 * `draftSyncRef` so nothing mistakes it for an open draft, and the composer
 * state that brings the sheet back exactly as it was.
 */
type DiscardParcel = {
  readonly sync: DraftSync;
  readonly composer: ComposerState;
};

type DraftRecovery = {
  readonly version: 1;
  readonly draftId: string;
  readonly accountId: string;
  readonly intent: MailDraftIntent;
  readonly fields: MailComposerFields;
  readonly updatedAt: number;
};

/** Where three panes stop fitting. Read off the reader's own minimum — the
 *  action pill at its resting labels, the subject beside it, the message's
 *  measure — and settled by judgement inside the band those bounds leave.
 *  `--breakpoint-panes` in globals.css carries the arithmetic; this is the
 *  third of its three copies, and ops/design-guardrails.test.ts asserts they
 *  agree. Below it mail shows one pane at a time; the desktop shell, sidebar
 *  included, is unaffected. */
const MAIL_PANES_MIN_WIDTH = 1160;

const DRAFT_AUTOSAVE_DELAY_MS = 700;
/** The discard pill's id: the sentence said again under it, without an Undo,
 *  takes the standing pill rather than queueing behind its own way back. */
const DISCARD_TOAST_ID = "mail-draft-discard";
/** What a sheet that leaves with files leaves behind. The files lived only in
 *  the sheet's memory and the draft API stores none, so the draft that stays
 *  is the words: said urgently, at the gesture that lost them. */
const DRAFT_WITHOUT_FILES = "Draft kept without its files.";
/** The same gesture on a letter with no words: nothing is kept but the fact
 *  that the files went. */
const FILES_DISCARDED = "Files discarded.";
/** What a blocked sheet (a lost answer, an unknown delivery) leaves with: its
 *  letter may already be on its way, so the one thing worth saying is where
 *  to look before sending it again. */
const DRAFT_KEPT_CHECK_SENT = "Draft kept. Check Sent before sending it again.";
const DRAFT_RECOVERY_PREFIX = "brain:mail:draft-recovery:v1:";
const THREAD_SORT_PREFIX = "brain:mail:sort:v1:";
const SEND_POLL_BASE_DELAY_MS = 5_000;
const SEND_POLL_MAX_DELAY_MS = 180_000;

/**
 * What the Drafts control must disclose while the list is closed: how many
 * drafts ended in `failed`, and whether any is still `submitting`.
 */
type DraftBadgeCounts = {
  readonly failed: number;
  readonly submitting: number;
};

const EMPTY_DRAFT_BADGE: DraftBadgeCounts = { failed: 0, submitting: 0 };

/**
 * The Done pill's id. One Done waits behind its Undo at a time, so every
 * press wears the same id: a second Done takes the pill from the first rather
 * than queueing behind its way back, and the sentence said again without an
 * Undo (the page leaving, the surface unmounting) takes the standing one.
 */
const SECTION_DONE_TOAST_ID = "mail-section-done";

/**
 * One Done, from the press until its window closes: the section it named,
 * what the queue will send for it, and how many of its rows sit on an
 * account that cannot move them. It is parked behind the pill's Undo
 * (`mail-deferred-discard.ts`, the parcel a discarded draft waits in), so it
 * settles exactly once: Undo takes it back and nothing is ever sent, or the
 * window closes and it goes to the queue.
 */
type SectionDoneRun = {
  readonly label: string;
  readonly threads: readonly MailThreadListItem[];
  readonly blocked: number;
};

/** The title a Done says at the press, and again when its Undo is taken away:
 *  a press that leaves rows behind has not cleared the section. */
function sectionDoneTitle(run: SectionDoneRun): string {
  return run.blocked === 0 ? `${run.label} cleared` : `${run.label} partly cleared`;
}

/**
 * The line under it. The column's fact in the column's words: "archived" is
 * the provider's verb and this sentence is not a receipt from it. It says
 * LEAVE of the rows it could not take for the same reason, since one sentence
 * cannot hold both that and the provider's verb.
 */
function sectionDoneSubtitle(run: SectionDoneRun): string {
  return [
    `${threadWord(run.threads.length)} out of your inbox`,
    ...(run.blocked === 0 ? [] : [`${run.blocked} can’t leave`]),
  ].join(", ");
}

/**
 * One New senders decision the column is showing. It is laid over the lists
 * the moment it is made (`applyShownDecisions`), keeps the service's id once
 * the POST answers so the toast's Undo can name it, and holds the threads it
 * took so an Undo of a Block can put back rows a refresh has since dropped.
 * Taking it off the list is the whole of an Undo or a rollback on screen.
 *
 * A Block's `archived` set is the service's answer at one moment, and the
 * Inbox reads that follow are truer than it: the owner may move a letter back
 * by hand. So it is laid only over the Inbox and the merged list, and a
 * thread leaves the set once an Inbox read that began after the answer
 * (`answeredAt`, a count of reads begun) lands with that thread in it. A read
 * that does not list it says nothing: a page-one refresh or a Load more never
 * reaches the older rows a deep list still holds from before the answer.
 */
type SenderDecisionEntry = ShownSenderDecision & {
  readonly token: number;
  readonly decisionId: string | null;
  readonly taken: readonly MailThreadListItem[];
  readonly answeredAt: number | null;
};

/** "1 thread" / "9 threads" — the toast counts out loud, so it has to agree. */
function threadWord(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

export function MailSurface({
  onOpenSettings,
  onAccountStatusChange,
  onSheetOpenChange,
  onToast,
  refreshToken,
  client: givenClient = defaultMailSurfaceClient,
}: {
  /** Open Mail settings; `accountId` deep-links that account's details
   *  (/settings/mail?account=<id>) — the reauth affordances pass it. */
  onOpenSettings: (invoker: HTMLElement, accountId?: string) => void;
  onAccountStatusChange?: (configured: boolean) => void;
  /** Whether a sheet that takes the whole window is up: the composer or an
   *  attachment viewer. Both are portals at the body, so the shell learns it
   *  here and steps back (inert, tab bar gone, chords silent) rather than
   *  reading it off its own tree. Reported false on unmount. */
  onSheetOpenChange?: (open: boolean) => void;
  onToast?: (title: string, options?: ToastOptions) => void;
  refreshToken?: number;
  client?: MailSurfaceClient;
}) {
  /* EVERY INBOX READ IS COUNTED ON ITS WAY OUT AND REPORTED ON ITS WAY IN.
     A Block's archived answer holds a row out of the column only until a read
     that began after the answer lists that thread (see
     `SenderDecisionEntry`), and a read is begun from a dozen places, so the
     count lives on the one door they all pass through. */
  const inboxReadsRef = useRef(0);
  const inboxReadLandedRef = useRef<
    (startedAt: number, listed: readonly MailThreadListItem[]) => void
  >(() => {});
  /* The same door tells Done. A thread it archived is held out of the column
     until a read that began after the archive answered lands
     (`settleDone`). */
  const doneReadLandedRef = useRef<
    (startedAt: number, listed: readonly MailThreadListItem[]) => void
  >(() => {});
  /* THE SAME DOOR COUNTS LIST READS STILL OUT. A silent refresh that was
     skipped or dropped runs again once nothing else is reading the column
     (`singleRefreshPendingRef` below): running it beside a read still out would move
     the epoch under that read and drop it in turn. The last read to land
     says so, whether or not its answer was kept. */
  const listReadsOutRef = useRef(0);
  const listReadsSettledRef = useRef<() => void>(() => {});
  const client = useMemo<MailSurfaceClient>(
    () => ({
      ...givenClient,
      listThreads: async (...request) => {
        const startedAt = ++inboxReadsRef.current;
        listReadsOutRef.current += 1;
        let page: Awaited<ReturnType<MailSurfaceClient["listThreads"]>>;
        try {
          page = await givenClient.listThreads(...request);
        } finally {
          listReadsOutRef.current -= 1;
          if (listReadsOutRef.current === 0) listReadsSettledRef.current();
        }
        inboxReadLandedRef.current(startedAt, page.items);
        doneReadLandedRef.current(startedAt, page.items);
        return page;
      },
      listMailboxThreads: async (...request) => {
        listReadsOutRef.current += 1;
        try {
          return await givenClient.listMailboxThreads(...request);
        } finally {
          listReadsOutRef.current -= 1;
          if (listReadsOutRef.current === 0) listReadsSettledRef.current();
        }
      },
    }),
    [givenClient],
  );
  const [accountsState, setAccountsState] = useState<AccountsState>({ kind: "loading" });
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedMailboxId, setSelectedMailboxId] =
    useState<MailSystemMailbox>("inbox");
  const [selectedView, setSelectedView] = useState<MailThreadView | null>(null);
  const [threadSort, setThreadSort] = useState<MailThreadSort>("date");
  const [searchQuery, setSearchQuery] = useState("");
  const [threadState, setThreadState] = useState<MailThreadListState>({ kind: "loading" });
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [readerState, setReaderState] = useState<MailReaderState>({ kind: "idle" });
  const [composer, setComposer] = useState<ComposerState | null>(null);
  /** A letter's attachment viewer is up (the reader reports it). */
  const [attachmentViewerOpen, setAttachmentViewerOpen] = useState(false);
  /** The same flag for the window key listener, which runs off refs. It is
   *  written in the reader's own callback, so it is true before the first
   *  key can reach the viewer. */
  const attachmentViewerOpenRef = useRef(false);
  const onAttachmentViewerOpenChange = useCallback((open: boolean) => {
    attachmentViewerOpenRef.current = open;
    setAttachmentViewerOpen(open);
  }, []);
  const [saveStatus, setSaveStatus] = useState<MailComposerSaveStatus>("idle");
  const [draftsOpen, setDraftsOpen] = useState(false);
  /** The handler-side truth for the same flag — the navigation handlers below
   *  run off refs, and one of them has to ask whether the drafts list is the
   *  thing holding the column. Written only through `showDrafts`, so the two
   *  cannot drift. */
  const draftsOpenRef = useRef(false);
  const showDrafts = useCallback((open: boolean) => {
    draftsOpenRef.current = open;
    setDraftsOpen(open);
  }, []);
  const [draftsState, setDraftsState] = useState<MailDraftsState>({
    kind: "loading",
  });
  /**
   * The saved draft a delete is waiting on, and the row's own button so focus
   * lands back where the press came from. Deleting a stored draft is the one
   * mail action with no way back — the thread mutations all have inverses and
   * the section Done has an undo — so it is the one that asks first.
   */
  const [confirmDraftDelete, setConfirmDraftDelete] =
    useState<MailDraftSummary | null>(null);
  /** Held past the state clear: Radix asks where focus goes as it unmounts,
   *  which is after `onOpenChange(false)` has already emptied the state. */
  const draftDeleteInvokerRef = useRef<HTMLElement | null>(null);
  const [draftBadge, setDraftBadge] = useState<DraftBadgeCounts>(EMPTY_DRAFT_BADGE);
  const [syncing, setSyncing] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [unifiedState, setUnifiedState] = useState<UnifiedState>({ kind: "idle" });
  // Load mores the column asked for and never got: refused under a mail
  // action's lock, or answered after the column's epoch moved and dropped.
  // Nothing about the rows changed, so the list's scroll sentinel, which
  // re-arms on the rows, takes this count too and asks again. A refusal is
  // counted only once the lock lets go, or the sentinel would ask straight
  // back into it.
  const [unifiedUnserved, setUnifiedUnserved] = useState(0);
  const loadMoreRefusedRef = useRef(false);
  // Every Load more moves the column's epoch, so a second one started while
  // the first is out drops the first's answer. That drop is not unserved: the
  // newer request is on its way. Only the latest Load more's drop counts, or
  // each would re-arm the sentinel into the next and drop it in turn.
  const loadMoreGenerationRef = useRef(0);
  useEffect(() => {
    if (mutating || !loadMoreRefusedRef.current) return;
    loadMoreRefusedRef.current = false;
    queueMicrotask(() => setUnifiedUnserved((count) => count + 1));
  }, [mutating]);
  // Which sections are open is an external store, not component state: it
  // outlives every unified mount in this session (see the store below).
  const unifiedExpand = useSyncExternalStore(
    subscribeUnifiedExpand,
    unifiedExpandSnapshot,
    unifiedExpandServerSnapshot,
  );
  // Presentation capture of the open thread — see UnifiedStickyOpen. The ref
  // is the handler-side truth; the state mirror feeds unified derivation in
  // render. `singleHoldRef` is the single-account sibling: while true, the
  // open thread's auto-read skipped its page-1 refetch (unread view /
  // unread-first sort) and silent page commits keep that row in place.
  const [stickyOpen, setStickyOpen] = useState<UnifiedStickyOpen | null>(null);
  const selectedAccountIdRef = useRef<string | null>(null);
  const selectedMailboxIdRef = useRef<MailSystemMailbox>("inbox");
  const selectedViewRef = useRef<MailThreadView | null>(null);
  const threadSortRef = useRef<MailThreadSort>("date");
  const searchQueryRef = useRef("");
  const selectedThreadIdRef = useRef<string | null>(null);
  const accountsStateRef = useRef<AccountsState>({ kind: "loading" });
  const accountsRequestEpochRef = useRef(0);
  const composerRef = useRef<ComposerState | null>(null);
  const composerActionEpochRef = useRef(0);
  const recoveryAccountsRef = useRef(new Set<string>());
  const draftSyncRef = useRef<DraftSync | null>(null);
  /** The discard whose delete is waiting behind the pill's Undo. Apart from
   *  `draftSyncRef` on purpose: a parked draft is not an open one. */
  const deferredDiscardRef = useRef<DeferredDiscard<DiscardParcel> | null>(null);
  const draftDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listEpochRef = useRef(0);
  const threadStateRef = useRef<MailThreadListState>({ kind: "loading" });
  const readerStateRef = useRef<MailReaderState>({ kind: "idle" });
  const keyNavFrameRef = useRef(false);
  const mutationLockRef = useRef(false);
  const autoReadKeyRef = useRef<string | null>(null);
  const sendPollersRef = useRef(new Map<string, AbortController>());
  const draftBadgeRunningRef = useRef(false);
  const unifiedStateRef = useRef<UnifiedState>({ kind: "idle" });
  const lastSingleAccountIdRef = useRef<string | null>(null);
  const selectedThreadAccountIdRef = useRef<string | null>(null);
  const stickyOpenRef = useRef<UnifiedStickyOpen | null>(null);
  const singleHoldRef = useRef(false);
  /** New senders: the switch's state as the service last said it (null when
   *  it could not be read, which offers no domain decision anywhere), the
   *  decisions the column is showing, and the scope the reader's switch holds
   *  for the letter it has open. */
  const [senderScreen, setSenderScreen] = useState<MailSenderScreenState | null>(null);
  const senderScreenRef = useRef<MailSenderScreenState | null>(null);
  const [senderDecisions, setSenderDecisions] = useState<readonly SenderDecisionEntry[]>([]);
  const senderDecisionsRef = useRef<readonly SenderDecisionEntry[]>([]);
  const senderTokenRef = useRef(0);
  const [readerScope, setReaderScope] = useState<{
    readonly key: string;
    readonly scope: SenderScope;
  } | null>(null);
  const readerScopeRef = useRef<{ readonly key: string; readonly scope: SenderScope } | null>(
    null,
  );
  /** Section Done: the threads it is holding out of the Inbox lists
   *  (`mail-section-done.ts`), and the one Done still waiting behind its
   *  pill's Undo. */
  const [doneOverlay, setDoneOverlay] = useState<DoneOverlay>(NO_DONE);
  const doneOverlayRef = useRef<DoneOverlay>(NO_DONE);
  const sectionDoneParkedRef = useRef<DeferredDiscard<SectionDoneRun> | null>(null);
  /** The latest `flushSectionDone`, for the page and unmount handlers that
   *  are wired before it is made (see `flushDeferredDiscardRef`). */
  const flushSectionDoneRef = useRef<
    (options?: { readonly keepalive?: boolean }) => void
  >(() => {});
  const reduceMotion = useReducedMotion();
  const reduceMotionRef = useRef(reduceMotion);
  useEffect(() => {
    reduceMotionRef.current = reduceMotion;
  }, [reduceMotion]);
  /* An Inbox read that began after a block answered has landed: a thread it
     lists is in the Inbox after the archive (the owner moved it back), which
     says it better than the block's answer, so the answer stops holding that
     one out. */
  useEffect(() => {
    inboxReadLandedRef.current = (startedAt, listed) => {
      const present = new Set(listed.map(unifiedThreadKey));
      let changed = false;
      const next = senderDecisionsRef.current.map((entry) => {
        if (entry.answeredAt === null || startedAt <= entry.answeredAt) return entry;
        const kept = new Set([...entry.archived].filter((key) => !present.has(key)));
        if (kept.size === entry.archived.size) return entry;
        changed = true;
        return { ...entry, archived: kept };
      });
      if (!changed) return;
      senderDecisionsRef.current = next;
      setSenderDecisions(next);
    };
  }, []);

  const commitThreadState = useCallback((next: MailThreadListState) => {
    threadStateRef.current = next;
    setThreadState(next);
  }, []);

  const commitUnifiedState = useCallback((next: UnifiedState) => {
    unifiedStateRef.current = next;
    setUnifiedState(next);
  }, []);

  const commitDoneOverlay = useCallback((next: DoneOverlay) => {
    if (next === doneOverlayRef.current) return;
    doneOverlayRef.current = next;
    setDoneOverlay(next);
  }, []);

  /**
   * Take threads Done archived out of the lists that hold them, as their
   * hold ends: the merged streams, and an account's own Inbox if that is
   * where the column stands. The overlay hid them until this commit, so
   * nothing moves on screen. Without it a row would come back the moment the
   * overlay let go: a page-one read never reaches a row a deep list keeps
   * below it, and another account's read says nothing of this one's rows.
   * It moves no epoch, so a read on its way is not dropped for it.
   */
  const sweepDoneThreads = useCallback(
    (threads: readonly MailThreadListItem[]) => {
      if (threads.length === 0) return;
      const unified = unifiedStateRef.current;
      if (unified.kind === "ready") {
        const streams = removeStreamItems(unified.streams, threads);
        if (streams !== unified.streams) commitUnifiedState({ kind: "ready", streams });
      }
      const single = threadStateRef.current;
      if (
        single.kind !== "ready" ||
        selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID ||
        selectedMailboxIdRef.current !== "inbox"
      ) {
        return;
      }
      const swept = new Set(threads.map(unifiedThreadKey));
      const kept = single.page.items.filter(
        (item) => !swept.has(unifiedThreadKey(item)),
      );
      if (kept.length === single.page.items.length) return;
      commitThreadState({ kind: "ready", page: { ...single.page, items: kept } });
    },
    [commitThreadState, commitUnifiedState],
  );

  useEffect(() => {
    doneReadLandedRef.current = (startedAt, listed) => {
      const settled = settleDone(doneOverlayRef.current, startedAt, listed);
      commitDoneOverlay(settled.overlay);
      sweepDoneThreads(settled.gone);
    };
  }, [commitDoneOverlay, sweepDoneThreads]);

  /**
   * Leaving unified mode drops the merged streams but NOT which sections are
   * open: a reader who unbundled Newsletters, stepped into one account and
   * came back would otherwise find the pile bundled again by a rule they had
   * already answered.
   */
  const resetUnifiedUiState = useCallback(() => {
    const idle = { kind: "idle" } as const;
    unifiedStateRef.current = idle;
    setUnifiedState(idle);
  }, []);

  const toggleUnifiedExpand = useCallback((key: UnifiedExpandKey) => {
    const current = unifiedExpandSnapshot();
    writeUnifiedExpand({ ...current, [key]: !current[key] });
  }, []);

  /**
   * Releases the sticky presentation of the open thread: unified derivation
   * reverts to live state (the read letter settles into Seen) and the
   * single-account hold stops pinning the open row. Called wherever the
   * reader stops showing that thread — close, removal, navigation resets.
   */
  const clearStickyOpen = useCallback(() => {
    stickyOpenRef.current = null;
    setStickyOpen(null);
    singleHoldRef.current = false;
  }, []);

  // Data-only persistence. Guarded solely by `sync.closed`, so a detached draft
  // (after the composer closes while keeping it) still flushes its last edit.
  const persistDraftStep = useCallback(
    async (
      sync: DraftSync,
      options?: { readonly keepalive?: boolean },
    ) => {
      if (sync.closed) return;
      if (sync.revision === null) {
        let createInput = sync.inFlightCreate;
        if (!createInput) {
          const createFields =
            options?.keepalive && sync.pendingFields
              ? sync.pendingFields
              : sync.savedFields;
          createInput = {
            ...sync.createInput,
            to: createFields.to,
            cc: createFields.cc,
            bcc: createFields.bcc,
            subject: createFields.subject,
            text: createFields.text,
          };
          sync.inFlightCreate = createInput;
        }
        const created = options?.keepalive
          ? await client.createDraft(createInput, undefined, options)
          : await client.createDraft(createInput);
        const ownsCreate = sync.inFlightCreate === createInput;
        if (
          sync.revision !== null &&
          created.revision < sync.revision
        ) {
          return;
        }
        sync.revision = created.revision;
        sync.savedFields = fieldsFromCreateInput(createInput);
        if (!ownsCreate) return;
        sync.inFlightCreate = null;
        clearConfirmedDraftRecovery(sync, sync.savedFields);
        if (sync.closed) return;
      }
      while (
        sync.inFlightPatch ||
        (sync.pendingFields &&
          !draftFieldsEqual(sync.pendingFields, sync.savedFields))
      ) {
        let attempt = sync.inFlightPatch;
        if (!attempt) {
          const fields = sync.pendingFields;
          const expectedRevision: number | null = sync.revision;
          if (!fields || expectedRevision === null) return;
          const mutationId = sync.pendingMutationId ?? createMutationId();
          sync.pendingMutationId = mutationId;
          attempt = { fields, mutationId, expectedRevision };
          sync.inFlightPatch = attempt;
        }
        const patchInput: MailDraftPatchInput = {
          accountId: sync.accountId,
          draftId: sync.draftId,
          mutationId: attempt.mutationId,
          expectedRevision: attempt.expectedRevision,
          patch: {
            to: attempt.fields.to,
            cc: attempt.fields.cc,
            bcc: attempt.fields.bcc,
            subject: attempt.fields.subject,
            text: attempt.fields.text,
          },
        };
        const result: MailDraftMutationResult = options?.keepalive
          ? await client.patchDraft(patchInput, undefined, options)
          : await client.patchDraft(patchInput);
        const ownsAttempt = sync.inFlightPatch === attempt;
        if (
          sync.revision !== null &&
          result.appliedRevision < sync.revision
        ) {
          return;
        }
        sync.revision = result.appliedRevision;
        sync.savedFields = attempt.fields;
        if (!ownsAttempt) return;
        sync.inFlightPatch = null;
        clearConfirmedDraftRecovery(sync, attempt.fields);
        if (sync.pendingFields === attempt.fields) sync.pendingMutationId = null;
        if (sync.closed) return;
      }
    },
    [client],
  );

  const runDraftSyncStep = useCallback(
    async (sync: DraftSync) => {
      if (draftSyncRef.current !== sync || sync.closed) return;
      try {
        await persistDraftStep(sync);
        if (draftSyncRef.current === sync && !sync.closed && !sync.frozen) {
          setSaveStatus(
            sync.pendingFields &&
              !draftFieldsEqual(sync.pendingFields, sync.savedFields)
              ? "saving"
              : "saved",
          );
        }
      } catch {
        if (draftSyncRef.current === sync && !sync.closed) setSaveStatus("error");
      }
    },
    [persistDraftStep],
  );

  const enqueueDraftSync = useCallback(
    (sync: DraftSync) => {
      sync.chain = sync.chain
        .then(() => runDraftSyncStep(sync))
        .catch(() => undefined);
      return sync.chain;
    },
    [runDraftSyncStep],
  );

  const flushDraftSync = useCallback(
    async (sync: DraftSync) => {
      if (draftDebounceRef.current) {
        clearTimeout(draftDebounceRef.current);
        draftDebounceRef.current = null;
      }
      await enqueueDraftSync(sync);
    },
    [enqueueDraftSync],
  );

  const onComposerDraftChange = useCallback(
    (fields: MailComposerFields) => {
      const sync = draftSyncRef.current;
      if (!sync || sync.closed) return;
      sync.pendingFields = fields;
      sync.pendingMutationId = createMutationId();
      writeDraftRecovery(sync, fields);
      if (sync.frozen) return;
      setSaveStatus("saving");
      if (draftDebounceRef.current) clearTimeout(draftDebounceRef.current);
      draftDebounceRef.current = setTimeout(() => {
        draftDebounceRef.current = null;
        void enqueueDraftSync(sync);
      }, DRAFT_AUTOSAVE_DELAY_MS);
    },
    [enqueueDraftSync],
  );

  const retryDraftSave = useCallback(() => {
    const sync = draftSyncRef.current;
    if (!sync || sync.closed || sync.frozen) return;
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current);
      draftDebounceRef.current = null;
    }
    setSaveStatus("saving");
    void enqueueDraftSync(sync);
  }, [enqueueDraftSync]);

  /**
   * Deletes the draft behind `sync`, after whatever it still owes the server:
   * a create or a patch whose response was lost is replayed first, so the
   * delete has a revision to name and leaves no orphan in Drafts. A draft that
   * never reached the server has only its local recovery copy to clear. Run
   * by the close-with-delete path at once, and by a parked discard the moment
   * its way back is gone.
   */
  const deleteDraftSync = useCallback(
    (sync: DraftSync, options?: { readonly keepalive?: boolean }) => {
      sync.closed = true;
      sync.chain = sync.chain
        .then(async () => {
          const createAttempt = sync.inFlightCreate;
          if (createAttempt) {
            const created = await client.createDraft(createAttempt);
            sync.revision = created.revision;
            sync.savedFields = fieldsFromCreateInput(createAttempt);
            if (sync.inFlightCreate === createAttempt) {
              sync.inFlightCreate = null;
            }
          }
          const attempt = sync.inFlightPatch;
          if (attempt) {
            const result = await client.patchDraft({
              accountId: sync.accountId,
              draftId: sync.draftId,
              mutationId: attempt.mutationId,
              expectedRevision: attempt.expectedRevision,
              patch: {
                to: attempt.fields.to,
                cc: attempt.fields.cc,
                bcc: attempt.fields.bcc,
                subject: attempt.fields.subject,
                text: attempt.fields.text,
              },
            });
            sync.revision = result.appliedRevision;
            sync.savedFields = attempt.fields;
            if (sync.inFlightPatch === attempt) sync.inFlightPatch = null;
          }
          if (sync.revision === null) return true;
          const input = {
            accountId: sync.accountId,
            draftId: sync.draftId,
            mutationId: createMutationId(),
            expectedRevision: sync.revision,
          };
          if (options?.keepalive) {
            await client.deleteDraft(input, undefined, { keepalive: true });
          } else {
            await client.deleteDraft(input);
          }
          return true;
        })
        .then((discarded) => {
          if (!discarded) return;
          clearDraftRecovery(sync.draftId);
          if (sync.recoverySourceDraftId) {
            clearDraftRecovery(sync.recoverySourceDraftId);
            sync.recoverySourceDraftId = null;
          }
        })
        .catch(() => undefined);
    },
    [client],
  );

  const closeComposer = useCallback(
    (deleteDraft: boolean) => {
      if (draftDebounceRef.current) {
        clearTimeout(draftDebounceRef.current);
        draftDebounceRef.current = null;
      }
      const sync = draftSyncRef.current;
      draftSyncRef.current = null;
      composerRef.current = null;
      setComposer(null);
      setSaveStatus("idle");
      if (!sync) return;
      if (deleteDraft) {
        deleteDraftSync(sync);
      } else {
        // Keep the draft: flush the newest edit, then release it. A detached
        // draft still persists here, so navigating away never drops an edit.
        sync.chain = sync.chain
          .then(() => persistDraftStep(sync))
          .catch(() => undefined)
          .finally(() => {
            sync.closed = true;
          });
      }
    },
    [deleteDraftSync, persistDraftStep],
  );

  const detachRemovedAccountComposer = useCallback(() => {
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current);
      draftDebounceRef.current = null;
    }
    const sync = draftSyncRef.current;
    draftSyncRef.current = null;
    composerRef.current = null;
    setComposer(null);
    setSaveStatus("idle");
    if (!sync) return;
    sync.closed = true;
    sync.pendingFields = null;
    sync.pendingMutationId = null;
    clearDraftRecovery(sync.draftId);
    if (sync.recoverySourceDraftId) {
      clearDraftRecovery(sync.recoverySourceDraftId);
      sync.recoverySourceDraftId = null;
    }
  }, []);

  /**
   * The way back is gone: the parked delete goes out now. The pill is said
   * again under its id without an Undo, so it takes the standing one instead
   * of leaving an Undo on screen that could bring nothing back, and the
   * sentence is still true. Said at pagehide (`keepalive`) too: the page may
   * come back from the back-forward cache with this very DOM, and the pill
   * it shows must not offer an Undo whose delete already went out.
   */
  const flushDeferredDiscard = useCallback(
    (options?: { readonly keepalive?: boolean }) => {
      const parked = deferredDiscardRef.current;
      if (!parked) return;
      deferredDiscardRef.current = null;
      if (!parked.flush(options)) return;
      onToast?.("Draft discarded", {
        id: DISCARD_TOAST_ID,
        icon: "trash-bin-trash-linear",
      });
    },
    [onToast],
  );
  /** The latest `flushDeferredDiscard`, for the unmount cleanup below: a
   *  cleanup that closed over the callback would run when the callback's
   *  identity changed, and let a parked discard go while its pill stood. */
  const flushDeferredDiscardRef = useRef(flushDeferredDiscard);
  useEffect(() => {
    flushDeferredDiscardRef.current = flushDeferredDiscard;
  }, [flushDeferredDiscard]);

  /**
   * Undo. The sheet comes back as it was: the same draftId and revision, the
   * fields as last typed (the pending edit over the saved one), and the
   * autosave the press cut off is re-armed on its own pause rather than fired,
   * so a draft that had not reached the server yet still waits for the writer
   * the way it did before.
   */
  const restoreDiscardedComposer = useCallback(
    (parcel: DiscardParcel) => {
      const { sync, composer: parked } = parcel;
      const fields = sync.pendingFields ?? sync.savedFields;
      draftSyncRef.current = sync;
      const next: ComposerState = {
        ...parked,
        draft: { ...parked.draft, ...fields },
        sending: false,
        error: null,
      };
      composerRef.current = next;
      setComposer(next);
      setSaveStatus("idle");
      if (
        sync.pendingFields &&
        !draftFieldsEqual(sync.pendingFields, sync.savedFields)
      ) {
        if (draftDebounceRef.current) clearTimeout(draftDebounceRef.current);
        draftDebounceRef.current = setTimeout(() => {
          draftDebounceRef.current = null;
          void enqueueDraftSync(sync);
        }, DRAFT_AUTOSAVE_DELAY_MS);
      }
    },
    [enqueueDraftSync],
  );

  /**
   * DISCARD IS NOT CLOSE, and it no longer asks. Closing keeps the draft;
   * Discard removes it, and instead of a question in the way the protection
   * is the way back: the sheet goes at the press, a pill with Undo stands for
   * `SMART_UNDO_MS`, and the provider delete waits behind it
   * (`mail-deferred-discard.ts`). It goes out when the window closes (the
   * shell says so through `onExpire`), when the page unloads, or when the
   * writer opens another message. Undo brings the same draft back and no
   * delete ever goes out. An empty composer has nothing to bring back and
   * leaves without a pill; so does one with no toast channel to offer it in.
   * One discard is parked at a time: a second press lets the first go.
   */
  const discardComposer = useCallback((leaving?: MailComposerLeaving) => {
    const sync = draftSyncRef.current;
    const current = composerRef.current;
    if (!sync || !current || !onToast || isDraftSyncEmpty(sync)) {
      closeComposer(true);
      return;
    }
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current);
      draftDebounceRef.current = null;
    }
    flushDeferredDiscard();
    draftSyncRef.current = null;
    composerRef.current = null;
    setComposer(null);
    setSaveStatus("idle");
    const parked = parkDiscard<DiscardParcel>(
      { sync, composer: current },
      (parcel, { keepalive }) =>
        deleteDraftSync(parcel.sync, keepalive ? { keepalive: true } : undefined),
    );
    deferredDiscardRef.current = parked;
    onToast("Draft discarded", {
      id: DISCARD_TOAST_ID,
      icon: "trash-bin-trash-linear",
      actionLabel: "Undo",
      durationMs: SMART_UNDO_MS,
      onAction: () => {
        // Nothing left to bring back (the discard settled elsewhere): the
        // press is refused rather than spending a pill that was replaced.
        if (parked.state !== "parked") return false;
        if (deferredDiscardRef.current === parked) deferredDiscardRef.current = null;
        // The account left while the pill stood: a restored sheet would have
        // no account to draw for, so this press is the flush instead, said
        // again without an Undo.
        if (!selectedMailAccount(accountsStateRef.current, sync.accountId)) {
          parked.flush();
          onToast("Draft discarded", {
            id: DISCARD_TOAST_ID,
            icon: "trash-bin-trash-linear",
          });
          return false;
        }
        const parcel = parked.restore();
        if (!parcel) return false;
        restoreDiscardedComposer(parcel);
        // The files lived only on the sheet and went with the discard; the
        // letter that comes back is the words, and that is said at once.
        if (leaving?.withFiles) onToast(DRAFT_WITHOUT_FILES, { urgent: true });
      },
      onExpire: () => {
        if (deferredDiscardRef.current === parked) deferredDiscardRef.current = null;
        parked.flush();
      },
    });
  }, [
    closeComposer,
    deleteDraftSync,
    flushDeferredDiscard,
    onToast,
    restoreDiscardedComposer,
  ]);

  const openComposer = useCallback(
    (params: {
      readonly accountId: string;
      readonly mode: MailComposerDraft["mode"];
      readonly intent: MailDraftIntent;
      readonly to: string;
      readonly cc: string;
      readonly bcc: string;
      readonly subject: string;
      readonly text: string;
      readonly replyToMessageId: string | null;
      readonly notice: string | null;
      readonly recoverySourceDraftId?: string;
      /** The key of a sheet already standing, handed over by the From switch
       *  so the letter moves under the same sheet: the key is the sheet's
       *  identity at its mount, and a new one would replay the whole sheet. */
      readonly idempotencyKey?: string;
    }) => {
      const existing = draftSyncRef.current;
      if (existing) closeComposer(isDraftSyncEmpty(existing));
      // Another letter is being started: the way back to a discarded one
      // closes, and its delete goes out.
      flushDeferredDiscard();
      const draftId = createDraftId();
      const idempotencyKey = params.idempotencyKey ?? createIdempotencyKey();
      const createInput: MailDraftCreateInput = {
        draftId,
        accountId: params.accountId,
        intent: params.intent,
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject: params.subject,
        text: params.text,
      };
      const sync: DraftSync = {
        draftId,
        accountId: params.accountId,
        recoverySourceDraftId: params.recoverySourceDraftId ?? null,
        idempotencyKey,
        createInput,
        revision: null,
        savedFields: fieldsFromCreateInput(createInput),
        pendingFields: null,
        pendingMutationId: null,
        inFlightCreate: null,
        inFlightPatch: null,
        chain: Promise.resolve(),
        closed: false,
        frozen: false,
      };
      draftSyncRef.current = sync;
      const next: ComposerState = {
        accountId: params.accountId,
        draftId,
        draft: {
          idempotencyKey,
          mode: params.mode,
          to: params.to,
          cc: params.cc,
          bcc: params.bcc,
          subject: params.subject,
          text: params.text,
          replyToMessageId: params.replyToMessageId,
          notice: params.notice,
        },
        sending: false,
        error: null,
        blocked: false,
        errorSettings: false,
      };
      composerRef.current = next;
      setComposer(next);
      setSaveStatus("idle");
      // A seeded reply or forward is durable at once; a blank compose waits for
      // the first keystroke, so glancing at New message leaves no junk draft.
      if (!isDraftSyncEmpty(sync)) {
        writeDraftRecovery(sync, fieldsFromCreateInput(createInput));
        void enqueueDraftSync(sync);
      }
    },
    [closeComposer, enqueueDraftSync, flushDeferredDiscard],
  );

  const resumeComposer = useCallback(
    (draft: MailDraft) => {
      const existing = draftSyncRef.current;
      if (existing) closeComposer(isDraftSyncEmpty(existing));
      // The draft whose delete is parked is still listed in Drafts, since
      // nothing has left yet. Opening that row is its Undo, not a resume that
      // would let the delete go on the way in and then find nothing to open.
      const parked = deferredDiscardRef.current;
      if (parked && parked.parcel.sync.draftId === draft.draftId) {
        deferredDiscardRef.current = null;
        const parcel = parked.restore();
        if (parcel) {
          restoreDiscardedComposer(parcel);
          return;
        }
      }
      flushDeferredDiscard();
      const idempotencyKey = createIdempotencyKey();
      const replyToMessageId =
        draft.intent.kind === "reply" || draft.intent.kind === "reply_all"
          ? draft.intent.sourceMessageId
          : null;
      const createInput: MailDraftCreateInput = {
        draftId: draft.draftId,
        accountId: draft.accountId,
        intent: draft.intent,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        text: draft.text,
      };
      const sync: DraftSync = {
        draftId: draft.draftId,
        accountId: draft.accountId,
        recoverySourceDraftId: null,
        idempotencyKey,
        createInput,
        revision: draft.revision,
        savedFields: fieldsFromCreateInput(createInput),
        pendingFields: null,
        pendingMutationId: null,
        inFlightCreate: null,
        inFlightPatch: null,
        chain: Promise.resolve(),
        closed: false,
        frozen: false,
      };
      draftSyncRef.current = sync;
      const next: ComposerState = {
        accountId: draft.accountId,
        draftId: draft.draftId,
        draft: {
          idempotencyKey,
          mode: composerModeFromIntent(draft.intent),
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          text: draft.text,
          replyToMessageId,
          notice: null,
        },
        sending: false,
        error: null,
        blocked: false,
        errorSettings: false,
      };
      composerRef.current = next;
      setComposer(next);
      setSaveStatus("idle");
    },
    [closeComposer, flushDeferredDiscard, restoreDiscardedComposer],
  );

  const refreshDrafts = useCallback(
    async (signal?: AbortSignal) => {
      const accountId = selectedAccountIdRef.current;
      const account = accountId
        ? selectedMailAccount(accountsStateRef.current, accountId)
        : null;
      if (!accountId || !account?.capabilities.compose) return;
      try {
        const drafts = await client.listDrafts(accountId, signal);
        if (signal?.aborted || selectedAccountIdRef.current !== accountId) return;
        // Everything except a `sent` tombstone. A draft that is mid-send or
        // ended ambiguous used to be filtered out here, so the writer's message
        // disappeared and Drafts claimed there was nothing saved.
        setDraftBadge(draftBadgeCounts(drafts));
        setDraftsState({
          kind: "ready",
          drafts: drafts.filter(isListedDraft),
        });
      } catch {
        if (!signal?.aborted && selectedAccountIdRef.current === accountId) {
          setDraftsState({ kind: "error" });
        }
      }
    },
    [client],
  );

  // Badge-only read behind the closed Drafts list. Errors keep the last known
  // counts — the next timer tick reads them again — so a flaky request never
  // degrades the open Drafts panel or blanks a truthful badge. One read at a
  // time: a stalled request must not stack up under the timer.
  const refreshDraftBadge = useCallback(
    async (accountId: string) => {
      if (draftBadgeRunningRef.current) return;
      draftBadgeRunningRef.current = true;
      try {
        const drafts = await client.listDrafts(accountId);
        if (selectedAccountIdRef.current !== accountId) return;
        setDraftBadge(draftBadgeCounts(drafts));
      } catch {
        // Keep the last known counts.
      } finally {
        draftBadgeRunningRef.current = false;
      }
    },
    [client],
  );

  /**
   * Follow a queued send to its terminal status. The composer is already
   * closed and its recovery cleared, so this watcher is the only witness left:
   * without it a send that fails hours later looks sent forever. One watcher
   * per operation, exponential backoff capped at three minutes, paused while
   * the tab is hidden, aborted when the Mail surface unmounts.
   */
  const watchSendOperation = useCallback(
    /** `withFiles`: the letter went with the sheet's files, which lived only
     *  in the sheet. A failed send leaves its words in Drafts and not its
     *  files, and the sentence says so. */
    (operationId: string, withFiles = false) => {
      const pollers = sendPollersRef.current;
      if (pollers.has(operationId)) return;
      const controller = new AbortController();
      pollers.set(operationId, controller);
      const poll = async () => {
        let attempt = 0;
        while (!controller.signal.aborted) {
          const canPoll = await waitForContentPoll(
            controller.signal,
            sendPollDelayMs(attempt),
          );
          if (!canPoll) return;
          attempt += 1;
          let status;
          try {
            status = (await client.getSendOperation(operationId, controller.signal))
              .status;
          } catch (error) {
            if (controller.signal.aborted) return;
            // A refusal is permanent — the operation is not readable, and the
            // Drafts badge still carries the outcome. An outage retries.
            if (error instanceof MailApiError && error.status < 500) return;
            continue;
          }
          if (status === "queued" || status === "sending") continue;
          if (status === "failed") {
            onToast?.(
              withFiles
                ? "Message didn’t send. It’s in Drafts without its files."
                : "Message didn’t send. It’s in Drafts.",
            );
          } else if (status === "delivery_unknown") {
            onToast?.("Delivery unconfirmed. Check Drafts.");
          } else {
            onToast?.("Message sent");
          }
          const accountId = selectedAccountIdRef.current;
          if (accountId) void refreshDraftBadge(accountId);
          return;
        }
      };
      void poll().finally(() => {
        pollers.delete(operationId);
      });
    },
    [client, onToast, refreshDraftBadge],
  );

  useEffect(() => {
    const pollers = sendPollersRef.current;
    return () => {
      for (const controller of pollers.values()) controller.abort();
      pollers.clear();
    };
  }, []);

  const openDrafts = useCallback(() => {
    const existing = draftSyncRef.current;
    if (existing) closeComposer(isDraftSyncEmpty(existing));
    showDrafts(true);
    setDraftsState({ kind: "loading" });
    void refreshDrafts();
  }, [closeComposer, refreshDrafts, showDrafts]);

  const closeDrafts = useCallback(() => {
    composerActionEpochRef.current += 1;
    showDrafts(false);
  }, [showDrafts]);

  const resumeDraft = useCallback(
    async (summary: MailDraftSummary) => {
      const accountId = selectedAccountIdRef.current;
      if (!accountId || accountId !== summary.accountId) return;
      const actionEpoch = ++composerActionEpochRef.current;
      try {
        const draft = await client.getDraft({
          accountId,
          draftId: summary.draftId,
        });
        if (
          selectedAccountIdRef.current !== accountId ||
          composerActionEpochRef.current !== actionEpoch
        ) {
          return;
        }
        resumeComposer(draft);
        showDrafts(false);
      } catch {
        onToast?.("This draft couldn’t open. Try again.");
      }
    },
    [client, resumeComposer, onToast, showDrafts],
  );

  const deleteDraftFromList = useCallback(
    async (summary: MailDraftSummary) => {
      const accountId = selectedAccountIdRef.current;
      if (!accountId || accountId !== summary.accountId) return;
      try {
        await client.deleteDraft({
          accountId: summary.accountId,
          draftId: summary.draftId,
          mutationId: createMutationId(),
          expectedRevision: summary.revision,
        });
      } catch {
        // A stale revision or missing draft resolves on the refresh below.
      }
      void refreshDrafts();
    },
    [client, refreshDrafts],
  );

  useEffect(() => {
    selectedAccountIdRef.current = selectedAccountId;
  }, [selectedAccountId]);

  useEffect(() => {
    selectedMailboxIdRef.current = selectedMailboxId;
  }, [selectedMailboxId]);

  useEffect(() => {
    selectedViewRef.current = selectedView;
  }, [selectedView]);

  useEffect(() => {
    threadSortRef.current = threadSort;
  }, [threadSort]);

  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    accountsStateRef.current = accountsState;
  }, [accountsState]);

  useEffect(() => {
    composerRef.current = composer;
  }, [composer]);

  const sheetOpen = composer !== null || attachmentViewerOpen;
  useEffect(() => {
    onSheetOpenChange?.(sheetOpen);
    // Leaving Mail with a sheet up (a route change) must give the shell back.
    return () => onSheetOpenChange?.(false);
  }, [sheetOpen, onSheetOpenChange]);

  useEffect(() => {
    readerStateRef.current = readerState;
  }, [readerState]);

  // Leaving Mail with a discard parked: the surface that could bring the
  // sheet back is going, so the delete goes out and the pill loses its Undo.
  useEffect(() => () => flushDeferredDiscardRef.current(), []);

  // Leaving Mail with a Done still inside its window: the column that could
  // show the rows again is going, so its archives go out and the pill loses
  // its Undo.
  useEffect(() => () => flushSectionDoneRef.current(), []);

  useEffect(
    () => () => {
      if (draftDebounceRef.current) clearTimeout(draftDebounceRef.current);
      const sync = draftSyncRef.current;
      if (!sync || sync.closed) return;
      // Internal Mail navigation closes the composer explicitly, but leaving
      // the Mail surface unmounts it. Detach and persist the final keystroke so
      // a route change inside Brain cannot silently drop the debounce window.
      draftSyncRef.current = null;
      sync.chain = sync.chain
        .then(() => persistDraftStep(sync))
        .catch(() => undefined)
        .finally(() => {
          sync.closed = true;
        });
    },
    [persistDraftStep],
  );

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      const sync = draftSyncRef.current;
      if (!sync || sync.closed || sync.frozen) return;
      void flushDraftSync(sync);
    };
    const onPageHide = () => {
      if (draftDebounceRef.current) {
        clearTimeout(draftDebounceRef.current);
        draftDebounceRef.current = null;
      }
      // A delete parked behind an Undo leaves with the page, bounded and
      // allowed to outlive the tab like the last autosave below.
      flushDeferredDiscardRef.current({ keepalive: true });
      // So does what a section's Done has not sent yet, whether its window
      // is still open or its queue is part of the way through.
      flushSectionDoneRef.current({ keepalive: true });
      const sync = draftSyncRef.current;
      if (!sync || sync.closed || sync.frozen) return;
      // `keepalive` lets the browser finish this bounded request after the tab
      // starts unloading. Reuse the pending mutation id so a simultaneous
      // autosave and pagehide retry are idempotent rather than two writes.
      void persistDraftStep(sync, { keepalive: true }).catch(() => undefined);
    };
    // Back from the back-forward cache: the DOM returns as it was left, with
    // frozen timers, so a parcel still parked would become a dead Undo the
    // moment its window ran out. It goes now, and the pill says so without
    // an Undo. A plain load's pageshow has nothing parked and touches nothing.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      flushDeferredDiscardRef.current();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [flushDraftSync, persistDraftStep]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("gmail");
    if (outcome !== "connected" && outcome !== "cancelled" && outcome !== "error") {
      return;
    }
    onToast?.(
      outcome === "connected"
        ? "Google account connected"
        : outcome === "cancelled"
          ? "Google connection cancelled"
          : "Couldn’t connect Google. Try again.",
    );
    url.searchParams.delete("gmail");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [onToast]);

  const loadAccounts = useCallback(
    async (signal?: AbortSignal) => {
      const requestEpoch = ++accountsRequestEpochRef.current;
      if (accountsStateRef.current.kind !== "ready") {
        const loading = { kind: "loading" } as const;
        accountsStateRef.current = loading;
        setAccountsState(loading);
      }
      try {
        const accounts = await client.loadAccounts(signal);
        if (signal?.aborted || accountsRequestEpochRef.current !== requestEpoch) return;

        clearDraftRecoveriesForRemovedAccounts(
          new Set(accounts.map((account) => account.accountId)),
        );

        const activeComposer = composerRef.current;
        if (
          activeComposer &&
          !accounts.some(
            (account) => account.accountId === activeComposer.accountId,
          )
        ) {
          detachRemovedAccountComposer();
        }
        // A discard parked behind an Undo whose account has left: Undo would
        // restore a composer with no account to draw it for (the shell inert
        // under nothing), so the way back closes here and the pill is said
        // again without it.
        const parked = deferredDiscardRef.current;
        if (
          parked &&
          !accounts.some((account) => account.accountId === parked.parcel.sync.accountId)
        ) {
          flushDeferredDiscardRef.current();
        }

        // The merged mode needs something to merge. A lone account mounts
        // into its own Inbox: All inboxes over one inbox names a mode with
        // nothing in it, and the menu draws no Accounts block for one
        // address (§13), so the merge would be a place with no row to show
        // for it. With two or more, a fresh mount (or a selected account that
        // disappeared) lands on All inboxes, and a session already in unified
        // mode stays there across account refreshes. The list is re-read on
        // every refresh, so a second account connecting mid-session opens the
        // merge without a reload — and a second one leaving closes it.
        const currentAccountId = selectedAccountIdRef.current;
        const nextAccountId =
          accounts.length < 2
            ? (accounts[0]?.accountId ?? null)
            : currentAccountId === UNIFIED_ACCOUNT_ID
              ? UNIFIED_ACCOUNT_ID
              : currentAccountId &&
                  accounts.some((account) => account.accountId === currentAccountId)
                ? currentAccountId
                : UNIFIED_ACCOUNT_ID;
        const nextAccount = accounts.find(
          (account) => account.accountId === nextAccountId,
        );
        const currentMailboxId = selectedMailboxIdRef.current;
        const nextMailboxId =
          nextAccount?.capabilities.mailboxes.includes(currentMailboxId) === true
            ? currentMailboxId
            : "inbox";

        if (
          nextAccountId !== currentAccountId ||
          nextMailboxId !== currentMailboxId
        ) {
          const nextSort = nextAccountId
            ? readStoredThreadSort(nextAccountId, nextMailboxId)
            : "date";
          listEpochRef.current += 1;
          selectedAccountIdRef.current = nextAccountId;
          selectedMailboxIdRef.current = nextMailboxId;
          selectedViewRef.current = null;
          threadSortRef.current = nextSort;
          selectedThreadIdRef.current = null;
          selectedThreadAccountIdRef.current = null;
          searchQueryRef.current = "";
          setSelectedAccountId(nextAccountId);
          setSelectedMailboxId(nextMailboxId);
          setSelectedView(null);
          setThreadSort(nextSort);
          setSelectedThreadId(null);
          setSearchQuery("");
          setReaderState({ kind: "idle" });
          setDraftBadge(EMPTY_DRAFT_BADGE);
          clearStickyOpen();
        }

        onAccountStatusChange?.(accounts.length > 0);
        const ready = { kind: "ready", accounts } as const;
        accountsStateRef.current = ready;
        setAccountsState(ready);
      } catch (error) {
        if (signal?.aborted || accountsRequestEpochRef.current !== requestEpoch) return;
        if (accountsStateRef.current.kind !== "ready") {
          // The mail service is a second container. When it is absent every
          // mail route answers 503 with this code, and that is a missing
          // service to add, not a load that failed.
          const unavailable =
            error instanceof MailApiError && error.code === "mail_service_unavailable";
          const next = unavailable
            ? ({ kind: "unavailable" } as const)
            : ({ kind: "error" } as const);
          accountsStateRef.current = next;
          setAccountsState(next);
        }
      }
    },
    [client, clearStickyOpen, detachRemovedAccountComposer, onAccountStatusChange],
  );

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void loadAccounts(controller.signal);
    });
    return () => controller.abort();
  }, [loadAccounts, refreshToken]);

  useEffect(() => {
    if (!selectedAccountId || accountsState.kind !== "ready") return;
    if (recoveryAccountsRef.current.has(selectedAccountId)) return;
    recoveryAccountsRef.current.add(selectedAccountId);
    if (composerRef.current) return;
    // The unified default mount still honors the recovery promise: scan every
    // account for the newest unsaved draft instead of one account's store.
    const recovery =
      selectedAccountId === UNIFIED_ACCOUNT_ID
        ? latestDraftRecoveryAcrossAccounts(accountsState.accounts)
        : latestDraftRecovery(selectedAccountId);
    if (!recovery) return;
    recoveryAccountsRef.current.add(recovery.accountId);

    composerActionEpochRef.current += 1;
    openComposer({
      accountId: recovery.accountId,
      mode: composerModeFromIntent(recovery.intent),
      intent: recovery.intent,
      to: recovery.fields.to,
      cc: recovery.fields.cc,
      bcc: recovery.fields.bcc,
      subject: recovery.fields.subject,
      text: recovery.fields.text,
      replyToMessageId:
        recovery.intent.kind === "reply" ||
        recovery.intent.kind === "reply_all"
          ? recovery.intent.sourceMessageId
          : null,
      notice: "Recovered after Brain closed before the last save finished.",
      recoverySourceDraftId: recovery.draftId,
    });
    onToast?.("Recovered your unsaved draft");
  }, [accountsState, onToast, openComposer, selectedAccountId]);

  const loadThreads = useCallback(
    async (
      accountId: string,
      mailboxId: MailSystemMailbox,
      view: MailThreadView | null,
      sort: MailThreadSort,
      signal?: AbortSignal,
    ) => {
      if (
        signal?.aborted ||
        selectedAccountIdRef.current !== accountId ||
        selectedMailboxIdRef.current !== mailboxId ||
        selectedViewRef.current !== view ||
        threadSortRef.current !== sort
      ) {
        return;
      }
      const account = selectedMailAccount(accountsStateRef.current, accountId);
      if (!account?.capabilities.mailboxes.includes(mailboxId)) return;
      const listInput = {
        accountId,
        limit: 50,
        ...(view ? { view } : {}),
        ...(sort !== "date" ? { sort } : {}),
      };
      const listEpoch = ++listEpochRef.current;
      commitThreadState({ kind: "loading" });
      try {
        let page: MailThreadListPage =
          mailboxId === "inbox"
            ? await client.listThreads(listInput, signal)
            : await client.listMailboxThreads(
                { ...listInput, mailboxId },
                signal,
              );
        if (
          mailboxId === "inbox" &&
          "sync" in page &&
          page.sync.lastSuccessfulAt === null &&
          (page.sync.status === "idle" || page.sync.status === "syncing") &&
          !signal?.aborted &&
          listEpochRef.current === listEpoch &&
          selectedAccountIdRef.current === accountId &&
          selectedMailboxIdRef.current === mailboxId &&
          selectedViewRef.current === view &&
          threadSortRef.current === sort
        ) {
          try {
            await client.sync({ accountId }, signal);
            page = await client.listThreads(listInput, signal);
          } catch {
            // Keep the cached page usable. The background scheduler and the
            // explicit Sync action can continue or surface recovery later.
          }
        }
        if (
          signal?.aborted ||
          listEpochRef.current !== listEpoch ||
          selectedAccountIdRef.current !== accountId ||
          selectedMailboxIdRef.current !== mailboxId ||
          selectedViewRef.current !== view ||
          threadSortRef.current !== sort
        ) {
          return;
        }
        commitThreadState({ kind: "ready", page });
      } catch {
        if (
          !signal?.aborted &&
          listEpochRef.current === listEpoch &&
          selectedAccountIdRef.current === accountId &&
          selectedMailboxIdRef.current === mailboxId &&
          selectedViewRef.current === view &&
          threadSortRef.current === sort
        ) {
          commitThreadState({ kind: "error" });
        }
      }
    },
    [client, commitThreadState],
  );

  const loadSearch = useCallback(
    async (
      accountId: string,
      mailboxId: MailSystemMailbox,
      query: string,
      signal?: AbortSignal,
      /**
       * `visible` is the search the reader typed: its loading and its failure
       * are the list's. `background` re-reads the results on screen without a
       * skeleton, and a failure still says so. `silent` is a refresh nobody
       * asked to watch: only fresh results change the list, as a failed
       * silent list refresh leaves the list as it was.
       */
      presentation: "visible" | "background" | "silent" = "visible",
    ) => {
      if (
        signal?.aborted ||
        selectedAccountIdRef.current !== accountId ||
        selectedMailboxIdRef.current !== mailboxId ||
        searchQueryRef.current !== query
      ) {
        return;
      }
      // Search ignores view and sort on the wire, but a destination or sort
      // change mid-flight still invalidates this response like any other list
      // load.
      const view = selectedViewRef.current;
      const sort = threadSortRef.current;
      const listEpoch = ++listEpochRef.current;
      if (normalizeMailSearchQueryText(query) === null) {
        if (presentation !== "silent") {
          commitThreadState({ kind: "invalid-search" });
        }
        return;
      }
      if (presentation === "visible") commitThreadState({ kind: "loading" });
      try {
        const page = await client.searchThreads(
          { accountId, mailboxId, query, limit: 50 },
          signal,
        );
        if (
          signal?.aborted ||
          listEpochRef.current !== listEpoch ||
          selectedAccountIdRef.current !== accountId ||
          selectedMailboxIdRef.current !== mailboxId ||
          selectedViewRef.current !== view ||
          threadSortRef.current !== sort ||
          searchQueryRef.current !== query
        ) {
          return;
        }
        commitThreadState({ kind: "ready", page });
      } catch {
        if (
          !signal?.aborted &&
          listEpochRef.current === listEpoch &&
          selectedAccountIdRef.current === accountId &&
          selectedMailboxIdRef.current === mailboxId &&
          selectedViewRef.current === view &&
          threadSortRef.current === sort &&
          searchQueryRef.current === query
        ) {
          if (presentation !== "silent") {
            commitThreadState({ kind: "error" });
            return;
          }
          // The results stay, but not as the same object. Starting this read
          // dropped any background re-read of an index still building, and
          // that re-read re-arms only on a new list state: without one it
          // never runs again and the list says "Indexing" for good.
          const current = threadStateRef.current;
          if (current.kind === "ready") {
            commitThreadState({ kind: "ready", page: current.page });
          }
        }
      }
    },
    [client, commitThreadState],
  );

  /**
   * A SILENT REFRESH THAT COULD NOT RUN, OR WHOSE ANSWER WAS DROPPED, RUNS
   * AGAIN instead of waiting for the safety net. It steps aside for a mail
   * action's lock and for a list still loading, and its answer is dropped when
   * another read (a Load more, a row action, a Try again) moved the column's
   * epoch while it was out. Either way the change it was asked about is still
   * unread, so the column or the accounts are marked here and read again by
   * the effect below once the list is ready, the lock has let go and no other
   * list read is out. `undefined` for the merge is nothing waiting, `null`
   * every stream.
   */
  const singleRefreshPendingRef = useRef<{
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly released: string | null;
  } | null>(null);
  const unifiedRefreshPendingRef = useRef<ReadonlySet<string> | null | undefined>(undefined);
  const [refreshPendingTick, setRefreshPendingTick] = useState(0);
  const noteRefreshPending = useCallback(() => {
    setRefreshPendingTick((tick) => tick + 1);
  }, []);
  useEffect(() => {
    listReadsSettledRef.current = () => {
      if (
        singleRefreshPendingRef.current !== null ||
        unifiedRefreshPendingRef.current !== undefined
      ) {
        noteRefreshPending();
      }
    };
  }, [noteRefreshPending]);

  const refreshThreadsSilently = useCallback(
    async (
      accountId: string,
      mailboxId: MailSystemMailbox,
      signal: AbortSignal,
      /** The thread a hold kept on screen and that has just been let go:
       *  under the Unread view or unread-first sort it leaves the kept rows. */
      released: string | null = null,
    ) => {
      const markPending = () => {
        const owed = singleRefreshPendingRef.current;
        singleRefreshPendingRef.current = {
          accountId,
          mailboxId,
          released:
            released ??
            (owed?.accountId === accountId && owed.mailboxId === mailboxId
              ? owed.released
              : null),
        };
        noteRefreshPending();
      };
      if (
        signal.aborted ||
        searchQueryRef.current.trim() !== "" ||
        selectedAccountIdRef.current !== accountId ||
        selectedMailboxIdRef.current !== mailboxId
      ) {
        return;
      }
      // A list read already out (a Load more, its walk, another refresh) would
      // lose its answer to this read's epoch, so this one waits for it.
      if (
        mutationLockRef.current ||
        threadStateRef.current.kind !== "ready" ||
        listReadsOutRef.current > 0
      ) {
        markPending();
        return;
      }
      const account = selectedMailAccount(accountsStateRef.current, accountId);
      if (!account?.capabilities.mailboxes.includes(mailboxId)) return;
      const view = selectedViewRef.current;
      const sort = threadSortRef.current;
      const listInput = {
        accountId,
        limit: 50,
        ...(view ? { view } : {}),
        ...(sort !== "date" ? { sort } : {}),
      };
      const listEpoch = ++listEpochRef.current;
      try {
        const page: MailThreadListPage =
          mailboxId === "inbox"
            ? await client.listThreads(listInput, signal)
            : await client.listMailboxThreads(
                { ...listInput, mailboxId },
                signal,
              );
        if (
          signal.aborted ||
          selectedAccountIdRef.current !== accountId ||
          selectedMailboxIdRef.current !== mailboxId ||
          selectedViewRef.current !== view ||
          threadSortRef.current !== sort
        ) {
          return;
        }
        const current = threadStateRef.current;
        if (listEpochRef.current !== listEpoch || current.kind !== "ready") {
          markPending();
          return;
        }
        // Page one is read again and folded into what is loaded: rows the
        // owner brought in with Load more stay below it, as the merge keeps
        // its streams (`reconcileStreamPageOne`). While the open thread is
        // held (auto-read under the unread view or unread-first sort), the
        // fresh page wins everywhere except that row: it keeps its local item
        // and position until the hold releases on selection change or reader
        // close.
        // A released letter leaves the kept rows only under the Unread view,
        // and only when the list's own row says it is read: one marked
        // unread again belongs there. Under unread-first it moves rather
        // than leaves, so it stays where it was loaded.
        const folded = pageWithLoadedDepth(page, current.page, {
          keepCursor: mailboxId === "inbox",
          drop:
            released !== null &&
            view === "unread" &&
            current.page.items.some(
              (item) =>
                item.threadId === released && item.accountId === accountId && !item.unread,
            )
              ? unifiedThreadKey({ accountId, threadId: released })
              : null,
        });
        const next = pageWithHeldThread(folded, current.page, {
          accountId: selectedThreadAccountIdRef.current,
          threadId: singleHoldRef.current ? selectedThreadIdRef.current : null,
        });
        commitThreadState({ kind: "ready", page: next });
      } catch {
        // The visible list stays usable. Explicit Sync and Try again own errors.
      }
    },
    [client, commitThreadState, noteRefreshPending],
  );

  /**
   * An Inbox an Undo of Move to Inbox took a letter out of. The list loaded
   * before that request landed, so it can still show a row the server has
   * since archived — and the next silent refresh is up to a minute away, and
   * never comes for a search. Asked again as soon as it is ready, a search
   * searched again; a switch elsewhere drops the request.
   */
  const refreshAfterRunRef = useRef<{
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
  } | null>(null);
  const refreshAfterRun = useCallback(() => {
    const pending = refreshAfterRunRef.current;
    if (pending === null) return;
    if (
      selectedAccountIdRef.current !== pending.accountId ||
      selectedMailboxIdRef.current !== pending.mailboxId
    ) {
      refreshAfterRunRef.current = null;
      return;
    }
    // The switch's own load may still be in flight; the effect below calls
    // back here when it lands.
    if (threadStateRef.current.kind !== "ready") return;
    refreshAfterRunRef.current = null;
    const query = searchQueryRef.current;
    if (query.trim() !== "") {
      void loadSearch(
        pending.accountId,
        pending.mailboxId,
        query,
        new AbortController().signal,
        "silent",
      );
      return;
    }
    void refreshThreadsSilently(
      pending.accountId,
      pending.mailboxId,
      new AbortController().signal,
    );
  }, [loadSearch, refreshThreadsSilently]);
  useEffect(() => {
    refreshAfterRun();
  }, [refreshAfterRun, threadState]);

  /**
   * THE WAIT A SYNC ASKS FOR, taken by the surface rather than the reader.
   *
   * A stream whose read a sync held stands as `loading`: no row, no notice,
   * no horizon. Its first page is read again `SYNC_HOLD_RETRY_MS` later, up to
   * `SYNC_HOLD_RETRIES` times, and only a read that still fails, or fails
   * some other way, puts up the row that says it couldn't load. Page one and
   * not the page that was held, because a held cursor names a snapshot the
   * sync has since replaced; this is the read Try again makes, made for the
   * reader.
   *
   * One chain per account, cancelled by a newer one and by leaving All
   * inboxes, so a read that lands late never writes into a column it no
   * longer belongs to.
   */
  const syncHoldsRef = useRef(new Map<string, AbortController>());
  const stopSyncHolds = useCallback(() => {
    for (const controller of syncHoldsRef.current.values()) controller.abort();
    syncHoldsRef.current.clear();
  }, []);
  useEffect(() => {
    if (selectedAccountId !== UNIFIED_ACCOUNT_ID) return;
    return stopSyncHolds;
  }, [selectedAccountId, stopSyncHolds]);

  const holdUnifiedStream = useCallback(
    async (accountId: string) => {
      const holds = syncHoldsRef.current;
      holds.get(accountId)?.abort();
      const controller = new AbortController();
      holds.set(accountId, controller);
      const { signal } = controller;
      let page: MailThreadPage | null = null;
      for (
        let attempt = 0;
        attempt < SYNC_HOLD_RETRIES && page === null;
        attempt += 1
      ) {
        await pause(SYNC_HOLD_RETRY_MS, signal);
        if (signal.aborted) return;
        try {
          page = await client.listThreads(
            { accountId, limit: UNIFIED_PAGE_SIZE },
            signal,
          );
        } catch (error) {
          if (signal.aborted) return;
          if (!isSyncHold(error)) break;
        }
      }
      if (signal.aborted) return;
      holds.delete(accountId);
      if (selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
      const current = unifiedStateRef.current;
      if (current.kind !== "ready") return;
      commitUnifiedState({
        kind: "ready",
        streams: current.streams.map((stream) => {
          if (stream.accountId !== accountId || stream.status !== "loading") {
            return stream;
          }
          return page === null
            ? { ...stream, status: "error" as const }
            : reconcileStreamPageOne(stream, page);
        }),
      });
    },
    [client, commitUnifiedState],
  );

  /**
   * Page-1 loads for every eligible account, `UNIFIED_FANOUT_LIMIT` at a time.
   * One account failing degrades to a per-stream notice — the rest still
   * merge. The first-sync kick is deliberately skipped in unified mode:
   * background sync owns freshness for non-focused accounts.
   *
   * The merged state is still committed once, after the last stream settles.
   * The safe horizon in `mergedDisplayItems` is only sound over a settled set:
   * a stream that has not answered imposes no horizon, so committing the
   * queue's early answers would emit rows that a later account then inserts
   * above, moving the column under the reader and re-arming the load-more
   * sentinel. Until then every account reads as pending through the list's
   * own loading state, which is what a reader with seven of them should see.
   */
  const loadUnified = useCallback(
    async (signal?: AbortSignal) => {
      if (selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
      const eligible = unifiedStreamAccounts(accountsStateRef.current);
      const listEpoch = ++listEpochRef.current;
      commitUnifiedState({ kind: "loading" });
      const connected = eligible.filter(
        (account) => account.status === "connected",
      );
      const results = await settleWithLimit(
        connected,
        UNIFIED_FANOUT_LIMIT,
        (account) =>
          client.listThreads(
            { accountId: account.accountId, limit: UNIFIED_PAGE_SIZE },
            signal,
          ),
      );
      if (
        signal?.aborted ||
        listEpochRef.current !== listEpoch ||
        selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID
      ) {
        return;
      }
      const pages = new Map<string, PromiseSettledResult<MailThreadPage>>();
      connected.forEach((account, index) => {
        pages.set(account.accountId, results[index]!);
      });
      const held: string[] = [];
      const streams = eligible.map((account): UnifiedStream => {
        const base = {
          accountId: account.accountId,
          emailAddress: account.emailAddress,
          items: [] as const,
          nextCursor: null,
          sync: null,
        };
        if (account.status !== "connected") {
          return { ...base, status: "reauth" };
        }
        const result = pages.get(account.accountId)!;
        if (result.status === "rejected") {
          if (!isSyncHold(result.reason)) return { ...base, status: "error" };
          held.push(account.accountId);
          return { ...base, status: "loading" };
        }
        return {
          ...base,
          items: result.value.items,
          nextCursor: result.value.nextCursor,
          status: "ready",
          sync: result.value.sync,
        };
      });
      commitUnifiedState({ kind: "ready", streams });
      for (const accountId of held) void holdUnifiedStream(accountId);
    },
    [client, commitUnifiedState, holdUnifiedStream],
  );

  /** Fetch the next page of exactly the streams that starve the horizon,
   *  under the same fan-out bound the first load runs at. */
  const loadMoreUnified = useCallback(async () => {
    if (selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
    if (mutationLockRef.current) {
      loadMoreRefusedRef.current = true;
      return;
    }
    const state = unifiedStateRef.current;
    if (state.kind !== "ready") return;
    const { starvedAccountIds } = mergedDisplayItems(state.streams);
    const starved = state.streams.filter(
      (stream) =>
        starvedAccountIds.includes(stream.accountId) &&
        stream.nextCursor !== null,
    );
    if (starved.length === 0) return;
    const listEpoch = ++listEpochRef.current;
    const generation = ++loadMoreGenerationRef.current;
    const results = await settleWithLimit(
      starved,
      UNIFIED_FANOUT_LIMIT,
      async (stream) => {
        const read = (cursor: string) =>
          client.listThreads({
            accountId: stream.accountId,
            cursor,
            limit: UNIFIED_PAGE_SIZE,
          });
        let page = await read(stream.nextCursor as string);
        const last = stream.items.at(-1);
        if (!stream.repage || last === undefined) return page;
        // A re-paging stream's cursor starts inside rows it already holds.
        // Pages that end at or above its last row bring nothing but what
        // moved, and a press that added no row would not re-arm the scroll
        // sentinel, so one Load more walks on to the page that reaches past.
        // It walks no more pages than the stream is deep, plus one for the
        // rows that moved down, and none after the column moved on: that
        // answer is dropped below, and every page it still read was waste.
        // A cursor it has already read leads back over the same pages, so it
        // ends the stream's paging instead of being followed or kept.
        const cap = Math.ceil(stream.items.length / UNIFIED_PAGE_SIZE) + 1;
        const asked = new Set([stream.nextCursor as string]);
        const items = [...page.items];
        while (
          asked.size < cap &&
          page.nextCursor !== null &&
          page.items.length > 0 &&
          compareUnified(page.items.at(-1)!, last) <= 0 &&
          listEpochRef.current === listEpoch &&
          selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID
        ) {
          if (asked.has(page.nextCursor)) {
            page = { ...page, nextCursor: null };
            break;
          }
          asked.add(page.nextCursor);
          page = await read(page.nextCursor);
          items.push(...page.items);
        }
        return { ...page, items };
      },
    );
    if (selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
    if (listEpochRef.current !== listEpoch) {
      if (loadMoreGenerationRef.current === generation) {
        setUnifiedUnserved((count) => count + 1);
      }
      return;
    }
    const current = unifiedStateRef.current;
    if (current.kind !== "ready") return;
    const byAccount = new Map<string, PromiseSettledResult<MailThreadPage>>();
    starved.forEach((stream, index) => {
      byAccount.set(stream.accountId, results[index]!);
    });
    const held: string[] = [];
    commitUnifiedState({
      kind: "ready",
      streams: current.streams.map((stream) => {
        const result = byAccount.get(stream.accountId);
        if (!result) return stream;
        if (result.status === "rejected") {
          // A stale cursor or an outage degrades this stream to a notice with
          // retry; its loaded rows keep merging and no longer hold a horizon.
          // A cursor a sync outdated waits for its quiet re-read instead.
          if (isSyncHold(result.reason)) {
            held.push(stream.accountId);
            return { ...stream, nextCursor: null, status: "loading" as const };
          }
          return { ...stream, nextCursor: null, status: "error" as const };
        }
        return appendStreamPage(stream, result.value);
      }),
    });
    for (const accountId of held) void holdUnifiedStream(accountId);
  }, [client, commitUnifiedState, holdUnifiedStream]);

  /**
   * The silent refresh in unified mode reads page-1 windows per account and
   * reconciles, never rebuilding: a rebuild would discard loaded depth and
   * scroll position on every refresh for no correctness gain — new mail sorts
   * to the top, so page 1 captures arrivals. A mail event names the account
   * it is about and only that stream is read; the safety net and a reset read
   * them all. This is the fan-out that runs forever rather than once, so it
   * takes the same bound: at seven accounts a full read is three short waves,
   * not seven requests at once.
   */
  const refreshUnifiedSilently = useCallback(
    async (signal: AbortSignal, accountIds: ReadonlySet<string> | null = null) => {
      const markPending = () => {
        const pending = unifiedRefreshPendingRef.current;
        unifiedRefreshPendingRef.current =
          pending === undefined
            ? accountIds
            : pending === null || accountIds === null
              ? null
              : new Set([...pending, ...accountIds]);
        noteRefreshPending();
      };
      const state = unifiedStateRef.current;
      if (signal.aborted || selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
      if (mutationLockRef.current || state.kind !== "ready") {
        markPending();
        return;
      }
      const refreshable = state.streams.filter(
        (stream) =>
          (stream.status === "ready" || stream.status === "error") &&
          (accountIds === null || accountIds.has(stream.accountId)),
      );
      if (refreshable.length === 0) return;
      const listEpoch = ++listEpochRef.current;
      const results = await settleWithLimit(
        refreshable,
        UNIFIED_FANOUT_LIMIT,
        (stream) =>
          client.listThreads(
            { accountId: stream.accountId, limit: UNIFIED_PAGE_SIZE },
            signal,
          ),
      );
      if (signal.aborted || selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
      const current = unifiedStateRef.current;
      if (listEpochRef.current !== listEpoch || current.kind !== "ready") {
        markPending();
        return;
      }
      const byAccount = new Map<string, MailThreadPage>();
      refreshable.forEach((stream, index) => {
        const result = results[index]!;
        if (result.status === "fulfilled") {
          byAccount.set(stream.accountId, result.value);
        }
      });
      commitUnifiedState({
        kind: "ready",
        streams: current.streams.map((stream) => {
          const page = byAccount.get(stream.accountId);
          // A failed refresh keeps the stale items silently; a stream that was
          // down and succeeds heals to ready through the reconcile.
          return page ? reconcileStreamPageOne(stream, page) : stream;
        }),
      });
    },
    [client, commitUnifiedState, noteRefreshPending],
  );

  useEffect(() => {
    if (
      mutating ||
      mutationLockRef.current ||
      listReadsOutRef.current > 0 ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const selected = selectedAccountIdRef.current;
    const single = singleRefreshPendingRef.current;
    if (single !== null) {
      if (
        single.accountId !== selected ||
        single.mailboxId !== selectedMailboxIdRef.current
      ) {
        singleRefreshPendingRef.current = null;
      } else if (threadStateRef.current.kind === "ready") {
        singleRefreshPendingRef.current = null;
        void refreshThreadsSilently(
          single.accountId,
          single.mailboxId,
          new AbortController().signal,
          single.released,
        );
      }
    }
    const merged = unifiedRefreshPendingRef.current;
    if (merged !== undefined) {
      if (selected !== UNIFIED_ACCOUNT_ID) {
        unifiedRefreshPendingRef.current = undefined;
      } else if (unifiedStateRef.current.kind === "ready") {
        unifiedRefreshPendingRef.current = undefined;
        void refreshUnifiedSilently(new AbortController().signal, merged);
      }
    }
  }, [
    mutating,
    refreshPendingTick,
    refreshThreadsSilently,
    refreshUnifiedSilently,
    threadState,
    unifiedState,
  ]);

  /** Per-stream Try again: page 1 of that account only, others untouched. */
  const retryUnifiedStream = useCallback(
    async (accountId: string) => {
      if (selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
      const state = unifiedStateRef.current;
      if (state.kind !== "ready") return;
      if (!state.streams.some((stream) => stream.accountId === accountId)) {
        return;
      }
      const listEpoch = ++listEpochRef.current;
      let page: MailThreadPage;
      try {
        page = await client.listThreads({
          accountId,
          limit: UNIFIED_PAGE_SIZE,
        });
      } catch {
        // The notice stays; Try again remains available.
        return;
      }
      if (
        listEpochRef.current !== listEpoch ||
        selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID
      ) {
        return;
      }
      const current = unifiedStateRef.current;
      if (current.kind !== "ready") return;
      commitUnifiedState({
        kind: "ready",
        streams: current.streams.map((stream) =>
          stream.accountId === accountId
            ? reconcileStreamPageOne(stream, page)
            : stream,
        ),
      });
    },
    [client, commitUnifiedState],
  );

  useEffect(() => {
    if (accountsState.kind !== "ready" || selectedAccountId === null) return;
    const account = accountsState.accounts.find(
      (candidate) => candidate.accountId === selectedAccountId,
    );
    if (!account) return;
    if (account.status === "reauth_required") {
      const listEpoch = ++listEpochRef.current;
      queueMicrotask(() => {
        if (
          listEpochRef.current !== listEpoch ||
          selectedAccountIdRef.current !== selectedAccountId ||
          selectedMailboxIdRef.current !== selectedMailboxId
        ) {
          return;
        }
        commitThreadState({
          kind: "ready",
          page: {
            apiVersion: 1,
            items: [],
            nextCursor: null,
            sync: { status: "reauth_required", lastSuccessfulAt: null },
          },
        });
      });
      return;
    }
    const controller = new AbortController();
    const query = searchQuery;
    if (query.trim() !== "") {
      if (normalizeMailSearchQueryText(query) === null) {
        queueMicrotask(() => {
          if (!controller.signal.aborted) {
            commitThreadState({ kind: "invalid-search" });
          }
        });
        return () => controller.abort();
      }
      const timeout = setTimeout(() => {
        if (!controller.signal.aborted) {
          void loadSearch(
            selectedAccountId,
            selectedMailboxId,
            query,
            controller.signal,
          );
        }
      }, 180);
      return () => {
        clearTimeout(timeout);
        controller.abort();
      };
    }
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        void loadThreads(
          selectedAccountId,
          selectedMailboxId,
          selectedView,
          threadSort,
          controller.signal,
        );
      }
    });
    return () => controller.abort();
  }, [
    accountsState,
    commitThreadState,
    loadThreads,
    loadSearch,
    searchQuery,
    selectedAccountId,
    selectedMailboxId,
    selectedView,
    threadSort,
  ]);

  useEffect(() => {
    if (
      threadState.kind !== "ready" ||
      !("scope" in threadState.page) ||
      threadState.page.indexStatus !== "building" ||
      selectedAccountId === null ||
      searchQuery.trim() === ""
    ) {
      return;
    }
    const accountId = selectedAccountId;
    const mailboxId = selectedMailboxId;
    const query = searchQuery;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        void loadSearch(
          accountId,
          mailboxId,
          query,
          controller.signal,
          "background",
        );
      }
    }, 250);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [
    loadSearch,
    searchQuery,
    selectedAccountId,
    selectedMailboxId,
    threadState,
  ]);

  useEffect(() => {
    if (accountsState.kind !== "ready" || selectedAccountId === null) return;
    const account = accountsState.accounts.find(
      (candidate) => candidate.accountId === selectedAccountId,
    );
    if (!account || account.status !== "connected") return;

    let interval: ReturnType<typeof setInterval> | null = null;
    let requestController: AbortController | null = null;
    let requestRunning = false;
    let requestGeneration = 0;
    // Asked for while a read is out: the read in flight may have left before
    // the change it is being asked about, so it runs once more when it lands.
    let refreshAgain = false;

    const stopInterval = () => {
      if (interval !== null) clearInterval(interval);
      interval = null;
    };
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (requestRunning) {
        refreshAgain = true;
        return;
      }
      // The same read keeps the Drafts badge honest, so a send that failed in
      // the durable outbox surfaces with the next change or the safety net,
      // even after a reload.
      if (account.capabilities.compose) void refreshDraftBadge(selectedAccountId);
      const generation = ++requestGeneration;
      const controller = new AbortController();
      requestController = controller;
      requestRunning = true;
      void refreshThreadsSilently(
        selectedAccountId,
        selectedMailboxId,
        controller.signal,
      ).finally(() => {
        if (generation !== requestGeneration) return;
        requestRunning = false;
        requestController = null;
        if (refreshAgain) {
          refreshAgain = false;
          refresh();
        }
      });
    };
    const startInterval = () => {
      if (interval === null) interval = setInterval(refresh, MAIL_SAFETY_REFRESH_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
        startInterval();
        return;
      }
      stopInterval();
      requestController?.abort();
      requestGeneration += 1;
      requestController = null;
      requestRunning = false;
      refreshAgain = false;
    };
    // This column's own account and mailbox, or a reset. A hidden tab lets
    // them pass: coming back to it reads the column anyway. A read that steps
    // aside for a mail action, or whose answer is dropped, is marked pending
    // and read again once the column is free (`singleRefreshPendingRef`).
    const events = debounceMailEvents(() => refresh());
    const onMailChanged = (event: Event) => {
      const change = mailEventOf(event);
      if (change === null || document.visibilityState !== "visible") return;
      if (change.changeKind === "reset") {
        events.push(selectedAccountId);
        return;
      }
      if (
        change.changeKind === "content_ready" ||
        change.accountId !== selectedAccountId ||
        !change.mailboxIds.includes(selectedMailboxId)
      ) {
        return;
      }
      events.push(selectedAccountId);
    };

    if (document.visibilityState === "visible") startInterval();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener(MAIL_CHANGED_EVENT, onMailChanged);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(MAIL_CHANGED_EVENT, onMailChanged);
      events.dispose();
      stopInterval();
      requestController?.abort();
      requestGeneration += 1;
    };
  }, [
    accountsState,
    refreshDraftBadge,
    refreshThreadsSilently,
    selectedAccountId,
    selectedMailboxId,
  ]);

  useEffect(() => {
    if (accountsState.kind !== "ready" || selectedAccountId !== UNIFIED_ACCOUNT_ID) {
      return;
    }
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void loadUnified(controller.signal);
    });
    return () => controller.abort();
  }, [accountsState, loadUnified, selectedAccountId]);

  // The unified sibling of the single-account refresh: visibility-gated, one
  // request generation in flight, aborted the moment the tab hides. A mail
  // event reads the one stream it names; the safety net and a reset read all.
  useEffect(() => {
    if (accountsState.kind !== "ready" || selectedAccountId !== UNIFIED_ACCOUNT_ID) {
      return;
    }
    if (
      !accountsState.accounts.some((account) => account.status === "connected")
    ) {
      return;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let requestController: AbortController | null = null;
    let requestRunning = false;
    let requestGeneration = 0;
    // What was asked for while a read was out, run once when it lands:
    // `undefined` is nothing, `null` every stream.
    let pending: ReadonlySet<string> | null | undefined;

    const stopInterval = () => {
      if (interval !== null) clearInterval(interval);
      interval = null;
    };
    const refresh = (accountIds: ReadonlySet<string> | null = null) => {
      if (document.visibilityState !== "visible") return;
      if (requestRunning) {
        pending =
          pending === undefined
            ? accountIds
            : pending === null || accountIds === null
              ? null
              : new Set([...pending, ...accountIds]);
        return;
      }
      const generation = ++requestGeneration;
      const controller = new AbortController();
      requestController = controller;
      requestRunning = true;
      void refreshUnifiedSilently(controller.signal, accountIds).finally(() => {
        if (generation !== requestGeneration) return;
        requestRunning = false;
        requestController = null;
        const next = pending;
        pending = undefined;
        if (next !== undefined) refresh(next);
      });
    };
    const startInterval = () => {
      if (interval === null) {
        interval = setInterval(() => refresh(), MAIL_SAFETY_REFRESH_MS);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
        startInterval();
        return;
      }
      stopInterval();
      requestController?.abort();
      requestGeneration += 1;
      requestController = null;
      requestRunning = false;
      pending = undefined;
    };
    const events = debounceMailEvents((accountIds) => refresh(accountIds));
    const onMailChanged = (event: Event) => {
      const change = mailEventOf(event);
      if (change === null || document.visibilityState !== "visible") return;
      if (change.changeKind === "reset") {
        events.push(null);
        return;
      }
      if (change.changeKind === "content_ready" || !change.mailboxIds.includes("inbox")) {
        return;
      }
      events.push(change.accountId);
    };

    if (document.visibilityState === "visible") startInterval();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener(MAIL_CHANGED_EVENT, onMailChanged);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(MAIL_CHANGED_EVENT, onMailChanged);
      events.dispose();
      stopInterval();
      requestController?.abort();
      requestGeneration += 1;
    };
  }, [accountsState, refreshUnifiedSilently, selectedAccountId]);

  const selectUnifiedMode = useCallback(() => {
    if (selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID) return;
    // The invariant the mount rule states, held at the one other door: the
    // merge exists only where there is a second account to merge.
    const snapshot = accountsStateRef.current;
    if (snapshot.kind !== "ready" || snapshot.accounts.length < 2) return;
    const openSync = draftSyncRef.current;
    if (openSync) closeComposer(isDraftSyncEmpty(openSync));
    closeDrafts();
    listEpochRef.current += 1;
    if (selectedAccountIdRef.current) {
      lastSingleAccountIdRef.current = selectedAccountIdRef.current;
    }
    selectedAccountIdRef.current = UNIFIED_ACCOUNT_ID;
    selectedMailboxIdRef.current = "inbox";
    selectedViewRef.current = null;
    threadSortRef.current = "date";
    selectedThreadIdRef.current = null;
    selectedThreadAccountIdRef.current = null;
    searchQueryRef.current = "";
    setSelectedAccountId(UNIFIED_ACCOUNT_ID);
    setSelectedMailboxId("inbox");
    setSelectedView(null);
    setThreadSort("date");
    setSelectedThreadId(null);
    setSearchQuery("");
    setReaderState({ kind: "idle" });
    setDraftBadge(EMPTY_DRAFT_BADGE);
    clearStickyOpen();
    resetUnifiedUiState();
  }, [clearStickyOpen, closeComposer, closeDrafts, resetUnifiedUiState]);

  const selectAccount = useCallback(
    (accountId: string) => {
      if (accountId === UNIFIED_ACCOUNT_ID) {
        selectUnifiedMode();
        return;
      }
      // THIS RETURN COMES BEFORE `closeDrafts()` ON PURPOSE. Pressing the
      // address you are already at is therefore inert, and stays inert while
      // the drafts list holds the column — that is the behaviour, not an
      // oversight, and the two sibling handlers below deliberately do the
      // opposite.
      //
      // The menu is two radio groups, and while Drafts is open each holds a
      // check that is true: `Drafts` in the destinations, the address in the
      // accounts. The account row you would be pressing is the account you
      // are already on, and the drafts on screen are that account's. Nothing
      // here is a marked row that does nothing — it is a checked radio
      // behaving like a checked radio. The way out of Drafts is already in this menu one
      // block up, wearing its own check, so moving the column from an account
      // row would both duplicate it and make an address do a folder's work.
      //
      // A reader who cannot see the menu hears "Drafts, checked" and the
      // selected address, also checked, and both are the truth. If the second
      // one started moving the column it would be a button wearing a radio's
      // clothes, and there is no way to announce that difference — which is
      // the symmetry `Dropdown.RadioGroup` was chosen for in the first place.
      if (selectedAccountIdRef.current === accountId) return;
      const openSync = draftSyncRef.current;
      if (openSync) closeComposer(isDraftSyncEmpty(openSync));
      closeDrafts();
      listEpochRef.current += 1;
      const nextSort = readStoredThreadSort(accountId, "inbox");
      selectedAccountIdRef.current = accountId;
      lastSingleAccountIdRef.current = accountId;
      selectedMailboxIdRef.current = "inbox";
      selectedViewRef.current = null;
      threadSortRef.current = nextSort;
      selectedThreadIdRef.current = null;
      selectedThreadAccountIdRef.current = null;
      searchQueryRef.current = "";
      setSelectedAccountId(accountId);
      setSelectedMailboxId("inbox");
      setSelectedView(null);
      setThreadSort(nextSort);
      setSelectedThreadId(null);
      setSearchQuery("");
      setReaderState({ kind: "idle" });
      setDraftBadge(EMPTY_DRAFT_BADGE);
      clearStickyOpen();
      resetUnifiedUiState();
    },
    [
      clearStickyOpen,
      closeComposer,
      closeDrafts,
      resetUnifiedUiState,
      selectUnifiedMode,
    ],
  );

  const selectMailbox = useCallback(
    (mailboxId: MailSystemMailbox) => {
      const accountId = selectedAccountIdRef.current;
      const account = accountId
        ? selectedMailAccount(accountsStateRef.current, accountId)
        : null;
      if (!accountId || !account?.capabilities.mailboxes.includes(mailboxId)) {
        return;
      }
      const openSync = draftSyncRef.current;
      if (openSync) closeComposer(isDraftSyncEmpty(openSync));
      // PRESSING THE PLACE YOU CAME FROM IS THE WAY BACK. Drafts is a
      // destination, so leaving it is choosing another one — and when that
      // other one is where the column already stood, this is the Back button
      // the head no longer draws. Everything below rebuilds the column for a
      // NEW destination: it drops the query, the open thread and the sticky
      // hold, and re-reads the mailbox's stored sort. Doing that on a return
      // would charge the reader a search they never asked to lose. The old
      // Back set one flag; so does this.
      if (
        draftsOpenRef.current &&
        selectedMailboxIdRef.current === mailboxId &&
        selectedViewRef.current === null
      ) {
        closeDrafts();
        return;
      }
      closeDrafts();
      listEpochRef.current += 1;
      const nextSort = readStoredThreadSort(accountId, mailboxId);
      selectedMailboxIdRef.current = mailboxId;
      selectedViewRef.current = null;
      threadSortRef.current = nextSort;
      selectedThreadIdRef.current = null;
      searchQueryRef.current = "";
      setSelectedMailboxId(mailboxId);
      setSelectedView(null);
      setThreadSort(nextSort);
      setSelectedThreadId(null);
      setSearchQuery("");
      setReaderState({ kind: "idle" });
      clearStickyOpen();
    },
    [clearStickyOpen, closeComposer, closeDrafts],
  );

  const selectView = useCallback(
    (mailboxId: MailSystemMailbox, view: MailThreadView) => {
      const accountId = selectedAccountIdRef.current;
      const account = accountId
        ? selectedMailAccount(accountsStateRef.current, accountId)
        : null;
      if (!accountId || !account?.capabilities.mailboxes.includes(mailboxId)) {
        return;
      }
      const openSync = draftSyncRef.current;
      if (openSync) closeComposer(isDraftSyncEmpty(openSync));
      // the same return, for the smart view the column was standing in
      if (
        draftsOpenRef.current &&
        selectedMailboxIdRef.current === mailboxId &&
        selectedViewRef.current === view
      ) {
        closeDrafts();
        return;
      }
      closeDrafts();
      listEpochRef.current += 1;
      const nextSort = readStoredThreadSort(accountId, mailboxId);
      selectedMailboxIdRef.current = mailboxId;
      selectedViewRef.current = view;
      threadSortRef.current = nextSort;
      selectedThreadIdRef.current = null;
      searchQueryRef.current = "";
      setSelectedMailboxId(mailboxId);
      setSelectedView(view);
      setThreadSort(nextSort);
      setSelectedThreadId(null);
      setSearchQuery("");
      setReaderState({ kind: "idle" });
      clearStickyOpen();
    },
    [clearStickyOpen, closeComposer, closeDrafts],
  );

  const selectSort = useCallback(
    (sort: MailThreadSort) => {
      const accountId = selectedAccountIdRef.current;
      const account = accountId
        ? selectedMailAccount(accountsStateRef.current, accountId)
        : null;
      if (!accountId || !account?.capabilities.listThreads) return;
      // Sort never applies to search results — the control is disabled there.
      if (searchQueryRef.current.trim() !== "") return;
      if (threadSortRef.current === sort) return;
      const openSync = draftSyncRef.current;
      if (openSync) closeComposer(isDraftSyncEmpty(openSync));
      showDrafts(false);
      // Drop the cursor and any in-flight page proactively. The selected
      // thread and the reader stay — only the list reorders. The reload that
      // follows is user-driven, so any sticky hold releases with it.
      listEpochRef.current += 1;
      threadSortRef.current = sort;
      setThreadSort(sort);
      singleHoldRef.current = false;
      writeStoredThreadSort(accountId, selectedMailboxIdRef.current, sort);
    },
    [closeComposer, showDrafts],
  );

  const changeSearchQuery = useCallback((query: string) => {
    listEpochRef.current += 1;
    searchQueryRef.current = query;
    setSearchQuery(query);
  }, []);

  const selectThread = useCallback(
    async (thread: MailThreadListItem) => {
      const openSync = draftSyncRef.current;
      if (openSync) closeComposer(isDraftSyncEmpty(openSync));
      const accountId = thread.accountId;
      const mailboxId = selectedMailboxIdRef.current;
      const movingOn =
        selectedThreadIdRef.current !== thread.threadId ||
        selectedThreadAccountIdRef.current !== thread.accountId;
      if (movingOn && singleHoldRef.current) {
        // Release the previous hold: a silent page-1 refetch settles the list
        // to server truth (the read letter leaves the unread view, re-sorts
        // under unread-first). No skeleton; the reader is untouched.
        singleHoldRef.current = false;
        const listAccountId = selectedAccountIdRef.current;
        if (listAccountId && listAccountId !== UNIFIED_ACCOUNT_ID) {
          void refreshThreadsSilently(
            listAccountId,
            mailboxId,
            new AbortController().signal,
            selectedThreadIdRef.current,
          );
        }
      }
      if (movingOn || stickyOpenRef.current === null) {
        // Capture presentation state at selection, before auto-read fires, so
        // the letter keeps its section and position while it is read. A retry
        // of the same open keeps the original capture.
        const capture: UnifiedStickyOpen = {
          accountId: thread.accountId,
          threadId: thread.threadId,
          unread: thread.unread,
          category: thread.category,
        };
        stickyOpenRef.current = capture;
        setStickyOpen(capture);
      }
      selectedThreadIdRef.current = thread.threadId;
      selectedThreadAccountIdRef.current = thread.accountId;
      setSelectedThreadId(thread.threadId);
      setReaderState({ kind: "loading", thread });
      try {
        const detail =
          mailboxId === "inbox"
            ? await client.readThread({
                accountId: thread.accountId,
                threadId: thread.threadId,
              })
            : await client.readMailboxThread({
                accountId: thread.accountId,
                mailboxId,
                threadId: thread.threadId,
              });
        if (
          (selectedAccountIdRef.current !== accountId &&
            selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) ||
          selectedThreadIdRef.current !== thread.threadId ||
          selectedThreadAccountIdRef.current !== accountId ||
          selectedMailboxIdRef.current !== mailboxId
        ) {
          return;
        }
        setReaderState({ kind: "ready", detail });
      } catch {
        if (
          (selectedAccountIdRef.current === accountId ||
            selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID) &&
          selectedThreadIdRef.current === thread.threadId &&
          selectedThreadAccountIdRef.current === accountId &&
          selectedMailboxIdRef.current === mailboxId
        ) {
          setReaderState({ kind: "error", thread });
        }
      }
    },
    [client, closeComposer, refreshThreadsSilently],
  );

  const retryReader = useCallback(() => {
    if (readerState.kind !== "error") return;
    void selectThread(readerState.thread);
  }, [readerState, selectThread]);

  const closeReader = useCallback(() => {
    const releaseHold = singleHoldRef.current;
    const accountId = selectedAccountIdRef.current;
    const mailboxId = selectedMailboxIdRef.current;
    const released = selectedThreadIdRef.current;
    clearStickyOpen();
    selectedThreadIdRef.current = null;
    selectedThreadAccountIdRef.current = null;
    setSelectedThreadId(null);
    setReaderState({ kind: "idle" });
    if (releaseHold && accountId && accountId !== UNIFIED_ACCOUNT_ID) {
      // Settle the released hold: the read letter leaves the unread view or
      // re-sorts under unread-first through a silent page-1 refetch.
      void refreshThreadsSilently(
        accountId,
        mailboxId,
        new AbortController().signal,
        released,
      );
    }
  }, [clearStickyOpen, refreshThreadsSilently]);

  /**
   * THE OPEN LETTER, READ AGAIN WHEN ITS MAILBOX CHANGED: a reply that landed
   * in the thread, a flag set in another client. Silent, and only while the
   * same letter is still the one on screen. A read that fails leaves the
   * letter as it stands: a thread that left its mailbox is the list's news,
   * and the reader closes only when the owner acts.
   */
  const rereadOpenThread = useCallback(async () => {
    const reader = readerStateRef.current;
    if (reader.kind !== "ready" || mutationLockRef.current) return;
    const { accountId, threadId } = reader.detail.thread;
    const mailboxId = selectedMailboxIdRef.current;
    let detail: MailThreadDetail;
    try {
      detail =
        mailboxId === "inbox"
          ? await client.readThread({ accountId, threadId })
          : await client.readMailboxThread({ accountId, mailboxId, threadId });
    } catch {
      return;
    }
    const current = readerStateRef.current;
    if (
      current.kind !== "ready" ||
      current.detail.thread.accountId !== accountId ||
      current.detail.thread.threadId !== threadId ||
      selectedMailboxIdRef.current !== mailboxId ||
      mutationLockRef.current
    ) {
      return;
    }
    setReaderState({ kind: "ready", detail });
  }, [client]);

  useEffect(() => {
    const events = debounceMailEvents(() => {
      if (mutationLockRef.current) {
        events.push(null);
        return;
      }
      void rereadOpenThread();
    });
    const onMailChanged = (event: Event) => {
      const change = mailEventOf(event);
      const reader = readerStateRef.current;
      if (
        change === null ||
        document.visibilityState !== "visible" ||
        reader.kind !== "ready"
      ) {
        return;
      }
      if (change.changeKind === "reset") {
        events.push(null);
        return;
      }
      if (
        change.changeKind === "content_ready" ||
        change.accountId !== reader.detail.thread.accountId ||
        !change.mailboxIds.includes(selectedMailboxIdRef.current)
      ) {
        return;
      }
      events.push(null);
    };
    // The same net the list has: events a hidden tab let pass, or the stream
    // lost, reach the open letter when the tab comes back and on the
    // five-minute tick.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void rereadOpenThread();
    };
    const safetyNet = setInterval(() => {
      if (document.visibilityState === "visible") void rereadOpenThread();
    }, MAIL_SAFETY_REFRESH_MS);
    window.addEventListener(MAIL_CHANGED_EVENT, onMailChanged);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener(MAIL_CHANGED_EVENT, onMailChanged);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInterval(safetyNet);
      events.dispose();
    };
  }, [rereadOpenThread]);

  /** OPENING MAIL ANSWERS THE BELL'S MAIL ROW (spec §7, D6).
   *
   *  The centre holds one row for new mail and it says how many letters are
   *  waiting. Mail being open is the answer to that question, whichever way it
   *  was opened — the row itself, the sidebar, a link, the phone's tab bar —
   *  so the mark is here, on the mount, and not on the press.
   *
   *  REGISTERED FOR AS LONG AS MAIL STANDS, rather than called once: a scan
   *  that lands during an hour in Mail opens a row about letters already in
   *  the list on screen, and the seam reads it on the answer that carries it.
   *  The cleanup ends that, so nothing is marked once Mail is gone. */
  useEffect(() => markMailCentreRead(), []);

  /** THE NEW-SENDERS SWITCH, READ ONCE THERE IS MAIL. Only its refused
   *  domains matter here: the section itself comes from the lists, which say
   *  per thread whether it waits. A screen that cannot be read offers no
   *  domain decision anywhere and nothing else changes, like the palette's
   *  answer to the same 503. */
  const senderScreenWanted =
    accountsState.kind === "ready" && accountsState.accounts.length > 0;
  useEffect(() => {
    if (!senderScreenWanted) return;
    const controller = new AbortController();
    client.getSenderScreenState(controller.signal).then(
      (state) => {
        if (controller.signal.aborted) return;
        senderScreenRef.current = state;
        setSenderScreen(state);
      },
      () => {
        if (controller.signal.aborted) return;
        senderScreenRef.current = null;
        setSenderScreen(null);
      },
    );
    return () => controller.abort();
  }, [client, senderScreenWanted]);

  /** THE THREAD SOMETHING OUTSIDE MAIL ASKED FOR (spec §7, D6).
   *
   *  An `agent-action` row about a thread is pressed on whatever surface the
   *  reader is on, so it leaves an account and a thread in
   *  `mail-surface-client` and the shell opens Mail. This is the other end. The
   *  request is read on mount and again on every list commit, because the list
   *  it has to be found in usually arrives after it.
   *
   *  Three answers, in this order. The letter is in the list in hand, and
   *  that list is its Inbox or the mailbox the request names, and
   *  `selectThread` opens it exactly as a press on the row would. It is in
   *  another account or another mailbox, and the column moves there first,
   *  by way of the letter's own Inbox and at most once per kind of move, and
   *  the list that follows brings the letter with it. Or it is in neither,
   *  and one read of that mailbox fetches the row to open it with. A request
   *  that cannot be answered is dropped rather than retried: Mail is open at
   *  the list it was going to show anyway, which is not a failure to report
   *  to whoever pressed a notification.
   *
   *  The mailbox is the request's own: Inbox for the centre, and for the
   *  palette whichever mailbox its search read in that account, All Mail on
   *  Gmail. A letter the palette found there may have left Inbox long ago,
   *  and the Inbox read answers 404 for it, which opened nothing.
   */
  const pendingOpen = useSyncExternalStore(
    subscribeOpenThread,
    pendingOpenThread,
    pendingOpenThreadServerSnapshot,
  );
  /** What has already been tried for the request in hand. A switch and a fetch
   *  are each worth one attempt, and without this ledger the effect would
   *  switch accounts every time the list it asked for commits. `listAtMove`
   *  is the list that was on screen when the column was last moved, by a
   *  switch or a reset: the fetch waits for a commit that is not it, so the
   *  destination's own page gets its chance first. */
  const openRequestRef = useRef<{
    key: string;
    opened: boolean;
    switched: boolean;
    listAtMove: MailThreadListState | null;
    fetched: boolean;
    /** The column was moved back to Inbox with an empty query for this
     *  request; a second move would be a loop, so the request is dropped
     *  instead if the column is still elsewhere after the first. */
    reset: boolean;
    /** The column was moved on from the letter's own Inbox to the mailbox the
     *  request names. Once, for the same reason. */
    followed: boolean;
  } | null>(null);

  const fetchRequestedThread = useCallback(
    async (request: MailOpenRequest, mailboxId: MailSystemMailbox) => {
      let detail: MailThreadDetail;
      try {
        detail =
          mailboxId === "inbox"
            ? await client.readThread({
                accountId: request.accountId,
                threadId: request.threadId,
              })
            : await client.readMailboxThread({
                accountId: request.accountId,
                mailboxId,
                threadId: request.threadId,
              });
      } catch {
        // A later press replaces the slot before this one answers: only the
        // request still standing there is this fetch's to clear.
        if (!isPendingRequest(request)) return;
        clearOpenThreadRequest();
        // Only the palette names a mailbox other than Inbox, and its row was
        // on screen a moment ago: a pick that lands silently on "Choose a
        // message" reads as a press that did nothing. The centre's letters
        // are new mail, and one of those gone by now is no news.
        if (request.mailboxId !== "inbox") onToast?.("Couldn’t open that letter.");
        return;
      }
      // The slot may already hold a different request by the time this
      // fetch lands, a second press before the first is answered. Landing on
      // the letter this fetch was for would move the reader off the one they
      // asked for since, so an abandoned fetch is dropped instead of opened.
      if (!isPendingRequest(request)) return;
      clearOpenThreadRequest();
      void selectThread(detail.thread);
    },
    [client, onToast, selectThread],
  );

  useEffect(() => {
    if (pendingOpen === null) {
      openRequestRef.current = null;
      return;
    }
    // Nothing can be decided before the accounts are known: the request names
    // one, and the column may still be choosing which it stands in.
    if (accountsState.kind !== "ready") return;

    const key = `${unifiedThreadKey(pendingOpen)}\u0000${pendingOpen.mailboxId}`;
    let ledger = openRequestRef.current;
    if (ledger === null || ledger.key !== key) {
      ledger = {
        key,
        opened: false,
        switched: false,
        listAtMove: null,
        fetched: false,
        reset: false,
        followed: false,
      };
      openRequestRef.current = ledger;
    }

    // An account that is no longer connected has no letter to open.
    const requestedAccount = accountsState.accounts.find(
      (account) => account.accountId === pendingOpen.accountId,
    );
    if (!requestedAccount) {
      clearOpenThreadRequest();
      return;
    }
    // A mailbox the account does not offer cannot be moved to, so the request
    // is answered in Inbox, which every account has.
    const mailboxId = requestedAccount.capabilities.mailboxes.includes(
      pendingOpen.mailboxId,
    )
      ? pendingOpen.mailboxId
      : "inbox";

    // A letter a section's Done is holding out of the Inbox is gone as far as
    // the Inbox goes, from the press on: a request for it there is dropped
    // the way one for an archived letter is, rather than opening a row the
    // column does not draw or fetching a letter on its way out. A request
    // that names another mailbox is still followed there, where the letter
    // is listed either way.
    const heldByDone = doneOverlay.has(unifiedThreadKey(pendingOpen));
    if (heldByDone && mailboxId === "inbox") {
      clearOpenThreadRequest();
      return;
    }

    // The list on screen has not committed since the column last moved, so
    // "not in the list" is not yet an answer, and neither is "in it": the
    // rows still standing belong to the folder the column just left.
    const listPending =
      threadState.kind === "loading" || threadState === ledger.listAtMove;

    // The list in hand answers only where the request would have looked
    // anyway: the mailbox it names, or the Inbox every request tries first
    // (the merged column is Inbox too). All Mail holds most of the Inbox, and
    // a notification's letter found there opened in All Mail only because All
    // Mail was the folder on screen.
    const listAnswers =
      (selectedMailboxId === mailboxId || selectedMailboxId === "inbox") &&
      (selectedAccountId === UNIFIED_ACCOUNT_ID || !listPending);
    const hiddenByDone =
      heldByDone &&
      (selectedAccountId === UNIFIED_ACCOUNT_ID || selectedMailboxId === "inbox");
    const loaded =
      listAnswers && !hiddenByDone
        ? loadedThread(pendingOpen, selectedAccountId, threadState, unifiedState)
        : null;
    if (loaded) {
      // The ledger, not `pendingOpen === null`, is what stops a development
      // double invoke of this effect from opening the same letter twice: the
      // clear below has not committed yet the second time this runs against
      // the same render.
      if (ledger.opened) return;
      ledger.opened = true;
      clearOpenThreadRequest();
      void selectThread(loaded);
      return;
    }

    const sameAccount = selectedAccountId === pendingOpen.accountId;
    const plain = searchQuery.trim() === "";

    // At the letter's own mailbox with no query: its page was the last list
    // to look in, and the letter is fetched from that mailbox.
    if (sameAccount && selectedMailboxId === mailboxId && plain) {
      if (listPending || ledger.fetched) return;
      ledger.fetched = true;
      void fetchRequestedThread(pendingOpen, mailboxId);
      return;
    }

    // In the letter's own Inbox, for a letter found in another mailbox. Most
    // of what the palette finds in All Mail is in Inbox too, and there it
    // opens with its Archive, so the Inbox page is waited for; only a letter
    // it does not hold is followed to the mailbox the request names.
    if (sameAccount && selectedMailboxId === "inbox" && plain) {
      if (listPending) return;
      if (ledger.followed) {
        clearOpenThreadRequest();
        return;
      }
      ledger.followed = true;
      ledger.listAtMove = threadState;
      selectMailbox(mailboxId);
      return;
    }

    // Anywhere else the column goes back to Inbox first, whichever account
    // the request names. Checked before the switch below rather than after
    // it: switching resets to Inbox and clears the query on its way, so a
    // cross-account request would otherwise answer where a same-account one
    // did not, for the same reader standing on the same other folder. A
    // request that arrives on Sent, or over a search, moves the column to
    // Inbox with an empty query and stays standing: the press came from
    // outside Mail (the palette, the centre) and named a letter, and a folder
    // the reader was on a moment ago is not a reason to lose it. Once, per
    // request: the reset commits a new list, the effect runs again on it, and
    // a second reset would only spin.
    if (selectedMailboxId !== "inbox" || !plain) {
      if (ledger.reset) {
        clearOpenThreadRequest();
        return;
      }
      ledger.reset = true;
      ledger.listAtMove = threadState;
      // `selectMailbox` clears the query on its way to Inbox, but it stands
      // down where there is no single account to move (the merged stream
      // only ever searches), so the query is cleared on its own as well.
      selectMailbox("inbox");
      changeSearchQuery("");
      return;
    }

    // In another account's Inbox, or in All inboxes: the switch lands on the
    // letter's own Inbox, and the list that follows brings it or does not.
    if (ledger.switched) return;
    ledger.switched = true;
    ledger.listAtMove = threadState;
    selectAccount(pendingOpen.accountId);
  }, [
    accountsState,
    changeSearchQuery,
    doneOverlay,
    fetchRequestedThread,
    pendingOpen,
    searchQuery,
    selectAccount,
    selectMailbox,
    selectThread,
    selectedAccountId,
    selectedMailboxId,
    threadState,
    unifiedState,
  ]);

  // A request nothing can now answer must not outlive this instance: the
  // reader who leaves Mail before an account switch or a fetch resolves, or
  // whose accounts never finish loading, should not have the next Mail mount
  // answer a press this one already gave up on.
  //
  // The clear waits one microtask and checks the instance is still gone.
  // `next dev` mounts every effect, unmounts it and mounts it again inside
  // the same commit, and a clear made straight from the cleanup answered that
  // rehearsal by dropping the letter the palette or the centre had just
  // asked for, on every development mount. A real unmount is still gone when
  // the microtask runs; the rehearsal has mounted again by then.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current) clearOpenThreadRequest();
      });
    };
  }, []);

  const startCompose = useCallback(
    (accountId: string) => {
      const account = selectedMailAccount(accountsStateRef.current, accountId);
      if (!account?.capabilities.compose || !account.capabilities.send) {
        onToast?.("Sending isn’t available for this account yet.");
        return;
      }
      composerActionEpochRef.current += 1;
      openComposer({
        accountId,
        mode: "compose",
        intent: { kind: "compose" },
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        text: "",
        replyToMessageId: null,
        notice: null,
      });
    },
    [onToast, openComposer],
  );

  /**
   * The From menu chose another account. The same letter opens there with
   * the fields as they stand, and the draft it leaves behind closes with
   * delete at once, so the first account's Drafts never lists a letter the
   * writer moved. Compose only: a reply goes from the account it arrived in.
   *
   * IN PLACE. The move happens under a sheet that stays: the new composer
   * state keeps the old one's key, so React keeps the mounted sheet, its
   * caret and the files that live only in it, and the one thing the writer
   * sees change is the name in From. The close and the open land in one
   * render, so there is never a frame without a sheet.
   */
  const switchComposerAccount = useCallback(
    (accountId: string, fields: MailComposerFields) => {
      const account = selectedMailAccount(accountsStateRef.current, accountId);
      if (!account?.capabilities.compose || !account.capabilities.send) return;
      const sheetKey = composerRef.current?.draft.idempotencyKey;
      closeComposer(true);
      composerActionEpochRef.current += 1;
      openComposer({
        accountId,
        mode: "compose",
        intent: { kind: "compose" },
        to: fields.to,
        cc: fields.cc,
        bcc: fields.bcc,
        subject: fields.subject,
        text: fields.text,
        replyToMessageId: null,
        notice: null,
        idempotencyKey: sheetKey,
      });
    },
    [closeComposer, openComposer],
  );

  const startReply = useCallback(
    (detail: MailThreadDetail) => {
      composerActionEpochRef.current += 1;
      const latest = detail.messages.at(-1);
      const subject = detail.thread.subject?.trim() ?? "";
      const account =
        accountsStateRef.current.kind === "ready"
          ? accountsStateRef.current.accounts.find(
              (candidate) => candidate.accountId === detail.thread.accountId,
            )
          : undefined;
      if (!account?.capabilities.reply || !account.capabilities.send) {
        onToast?.("Reply isn’t available for this account yet.");
        return;
      }
      if (!latest?.messageId) return;
      const recipients = deriveReplyRecipients(
        latest,
        account,
        detail.thread.participants,
      );
      openComposer({
        accountId: detail.thread.accountId,
        mode: "reply",
        intent: { kind: "reply", sourceMessageId: latest.messageId },
        to: formatDraftAddresses(recipients.to),
        cc: formatDraftAddresses(recipients.cc),
        bcc: "",
        subject: subject && !/^re:/i.test(subject) ? `Re: ${subject}` : subject,
        text: "",
        replyToMessageId: latest.messageId,
        notice: null,
      });
    },
    [onToast, openComposer],
  );

  const startReplyAll = useCallback(
    (detail: MailThreadDetail) => {
      composerActionEpochRef.current += 1;
      const latest = detail.messages.at(-1);
      const subject = detail.thread.subject?.trim() ?? "";
      const account =
        accountsStateRef.current.kind === "ready"
          ? accountsStateRef.current.accounts.find(
              (candidate) => candidate.accountId === detail.thread.accountId,
            )
          : undefined;
      if (!account?.capabilities.reply || !account.capabilities.send) {
        onToast?.("Reply isn’t available for this account yet.");
        return;
      }
      if (!latest?.messageId) return;
      const recipients = deriveReplyAllRecipients(
        latest,
        account,
        detail.thread.participants,
      );
      openComposer({
        accountId: detail.thread.accountId,
        mode: "replyAll",
        intent: { kind: "reply_all", sourceMessageId: latest.messageId },
        to: formatDraftAddresses(recipients.to),
        cc: formatDraftAddresses(recipients.cc),
        bcc: "",
        subject: subject && !/^re:/i.test(subject) ? `Re: ${subject}` : subject,
        text: "",
        replyToMessageId: latest.messageId,
        notice: null,
      });
    },
    [onToast, openComposer],
  );

  const startForward = useCallback(
    async (detail: MailThreadDetail) => {
      const latest = detail.messages.at(-1);
      if (!latest) return;
      const actionEpoch = ++composerActionEpochRef.current;
      const accountId = detail.thread.accountId;
      const threadId = detail.thread.threadId;
      const account = selectedMailAccount(
        accountsStateRef.current,
        accountId,
      );
      if (!account?.capabilities.compose || !account.capabilities.send) {
        onToast?.("Forward isn’t available for this account yet.");
        return;
      }
      if (!account.capabilities.messageBodies) {
        onToast?.("Forward needs the complete message body.");
        return;
      }
      let body = readableMailBody(latest.textBody);
      let sourceHasAttachments = latest.hasAttachments;
      try {
        let content = await client.getMessageContent({
          accountId,
          messageId: latest.messageId,
        });
        if (content.state !== "ready") {
          content = await client.requestMessageContent({
            accountId,
            messageId: latest.messageId,
          });
        }
        if (content.state === "ready") {
          body = readableMailBody(content.textBody) ?? body;
          sourceHasAttachments ||= content.attachments.length > 0;
        }
      } catch {
        // The bounded cached body or snippet remains safe to forward.
      }
      if (
        composerActionEpochRef.current !== actionEpoch ||
        (selectedAccountIdRef.current !== accountId &&
          selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) ||
        selectedThreadIdRef.current !== threadId
      ) {
        return;
      }
      openComposer({
        accountId,
        mode: "forward",
        intent: { kind: "forward", sourceMessageId: latest.messageId },
        to: "",
        cc: "",
        bcc: "",
        subject: forwardedSubject(latest.subject ?? detail.thread.subject),
        text: forwardedPlainText(latest, body),
        replyToMessageId: null,
        notice: sourceHasAttachments
          ? "Original attachments aren’t included."
          : null,
      });
    },
    [client, onToast, openComposer],
  );

  const send = useCallback(
    async (input: MailSendInput) => {
      const sync = draftSyncRef.current;
      const activeComposer = composerRef.current;
      if (
        !sync ||
        !activeComposer ||
        activeComposer.accountId !== input.accountId ||
        activeComposer.draft.idempotencyKey !== input.idempotencyKey ||
        sync.draftId !== activeComposer.draftId
      ) {
        onToast?.("Draft account changed. Open a new message and try again.");
        return;
      }
      const updateSubmittedComposer = (
        update: (current: ComposerState) => ComposerState,
      ) => {
        setComposer((current) => {
          if (!isComposerSubmission(current, input)) return current;
          const next = update(current);
          composerRef.current = next;
          return next;
        });
      };
      const account = selectedMailAccount(
        accountsStateRef.current,
        input.accountId,
      );
      if (!account?.capabilities.send) {
        // A refusal of the writer's own press, said on the sheet in its slot:
        // the composer is up and is where they are looking.
        updateSubmittedComposer((current) => ({
          ...current,
          sending: false,
          error: "Sending isn’t available for this account yet.",
        }));
        return;
      }
      updateSubmittedComposer((current) => ({
        ...current,
        sending: true,
        error: null,
      }));
      // Freeze autosave and persist the latest edit before the atomic handoff,
      // so the Mail service builds MIME from exactly what the writer sees.
      sync.frozen = true;
      try {
        await flushDraftSync(sync);
      } catch {
        // Autosave is best-effort; the send reconciles from the stored draft.
      }
      if (sync.closed || draftSyncRef.current !== sync) return;
      if (
        sync.revision === null ||
        (sync.pendingFields !== null &&
          !draftFieldsEqual(sync.pendingFields, sync.savedFields))
      ) {
        sync.frozen = false;
        updateSubmittedComposer((current) => ({
          ...current,
          sending: false,
          error: "Couldn’t save this draft. Try again.",
        }));
        return;
      }
      // The sheet's files ride on the send, never on the draft: the service
      // builds them into the message it makes from the draft, so a letter
      // with files is bound to its draft like any other and cannot go twice.
      const withFiles = input.attachments.length > 0;
      try {
        const result = await client.sendDraft({
          accountId: sync.accountId,
          draftId: sync.draftId,
          mutationId: createMutationId(),
          expectedRevision: sync.revision,
          sendIdempotencyKey: randomUuidV4(),
          sendOperationId: createSendOperationId(),
          attachments: input.attachments,
        });
        if (
          !isComposerSubmission(composerRef.current, input) ||
          draftSyncRef.current !== sync
        ) {
          return;
        }
        if (
          result.status === "sent" ||
          result.status === "queued" ||
          result.status === "sending"
        ) {
          clearDraftRecovery(sync.draftId);
          if (sync.recoverySourceDraftId) {
            clearDraftRecovery(sync.recoverySourceDraftId);
            sync.recoverySourceDraftId = null;
          }
          sync.closed = true;
          draftSyncRef.current = null;
          composerRef.current = null;
          setComposer(null);
          setSaveStatus("idle");
          onToast?.(result.status === "sent" ? "Message sent" : "Message queued");
          // A queued handoff is a promise, not an outcome. Watch the operation
          // so a failure hours from now still reaches the writer.
          if (result.status !== "sent") watchSendOperation(result.operationId, withFiles);
          return;
        }
        if (result.status === "failed") {
          try {
            const refreshed = await client.getDraft({
              accountId: sync.accountId,
              draftId: sync.draftId,
            });
            if (draftSyncRef.current === sync && !sync.closed) {
              sync.revision = refreshed.revision;
              sync.savedFields = {
                to: refreshed.to,
                cc: refreshed.cc,
                bcc: refreshed.bcc,
                subject: refreshed.subject,
                text: refreshed.text,
              };
            }
          } catch {
            // Keep the last known revision; the next send re-reads on conflict.
          }
          sync.frozen = false;
          updateSubmittedComposer((current) => ({
            ...current,
            sending: false,
            error: "Message wasn’t sent. Try again.",
          }));
          setSaveStatus("saved");
          return;
        }
        // delivery_unknown: the Mail service holds the draft frozen so an
        // ambiguous DATA handoff is never resent. Block and keep it visible.
        //
        // `appliedRevision` is the revision the draft reached when it entered
        // `submitting`, captured before the outbox transition. Reaching a
        // terminal status bumps it again through the drafts/outbox trigger, so
        // re-read to learn the revision Discard has to present.
        try {
          const refreshed = await client.getDraft({
            accountId: sync.accountId,
            draftId: sync.draftId,
          });
          if (draftSyncRef.current === sync && !sync.closed) {
            // Revision only. The stored body is frozen and unpatchable, and the
            // writer must keep seeing exactly what they tried to send.
            sync.revision = refreshed.revision;
          }
        } catch {
          // Discard falls back to the pre-send revision and the Drafts list,
          // which always deletes with the revision it just listed.
        }
        updateSubmittedComposer((current) => ({
          ...current,
          sending: false,
          blocked: true,
          error: "Delivery status is unknown. Check Sent before trying again.",
          errorSettings: false,
        }));
      } catch (error) {
        // A rejected request never reached the atomic handoff, so the draft is
        // intact and Send stays live. Anything Brain cannot classify — a lost
        // response, a 5xx — blocks, because a second send could duplicate a
        // delivery that already happened.
        const failure = classifySendFailure(error);
        if (!failure.blocked) sync.frozen = false;
        if (
          error instanceof MailApiError &&
          error.code === "mail_draft_revision_conflict"
        ) {
          try {
            const refreshed = await client.getDraft({
              accountId: sync.accountId,
              draftId: sync.draftId,
            });
            if (draftSyncRef.current === sync && !sync.closed) {
              sync.revision = refreshed.revision;
              sync.savedFields = {
                to: refreshed.to,
                cc: refreshed.cc,
                bcc: refreshed.bcc,
                subject: refreshed.subject,
                text: refreshed.text,
              };
            }
          } catch {
            // Keep the last known revision; the next send re-reads on conflict.
          }
        }
        updateSubmittedComposer((current) => ({
          ...current,
          sending: false,
          blocked: failure.blocked,
          error: failure.message,
          errorSettings: failure.settings ?? false,
        }));
      }
    },
    [client, flushDraftSync, onToast, watchSendOperation],
  );

  /**
   * The two single-account surfaces where a freshly read thread would leave
   * or re-sort the visible list on a page-1 refetch: the unread smart view
   * (server-filtered to unread) and the unread-first sort. Search results
   * list read and unread alike, so an active query is exempt.
   */
  const singleHoldEligible = useCallback(
    () =>
      selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID &&
      searchQueryRef.current.trim() === "" &&
      (selectedViewRef.current === "unread" ||
        threadSortRef.current === "unread"),
    [],
  );

  /**
   * Undo of Move to Inbox: the letter leaves the Inbox again. The pill stands
   * for nine seconds and the reader may have moved on inside them, so the
   * answer goes where the letter is on screen. An Inbox column, the account's
   * own or All inboxes, no longer holds it: a reader open on it there closes,
   * as Archive closes it, and the column is read again. All inboxes takes the
   * row out first, as its Archive does, because its re-read is page one and
   * keeps whatever a deep stream holds below it. The account's Inbox is
   * read through `refreshAfterRun`, so a list still loading or showing a
   * search is not skipped. Any other folder lists the letter either
   * way, and a reader on it there takes it in place and offers Move to Inbox
   * again.
   */
  const undoMoveToInbox = useCallback(
    async (thread: MailThreadListItem) => {
      const { accountId, threadId } = thread;
      mutationLockRef.current = true;
      setMutating(true);
      try {
        await client.updateThread({ accountId, threadId, archive: true });
      } catch (error) {
        onToast?.(threadActionFailure(error));
        return;
      } finally {
        mutationLockRef.current = false;
        setMutating(false);
      }
      const unified = selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID;
      const accountInbox =
        selectedAccountIdRef.current === accountId &&
        selectedMailboxIdRef.current === "inbox";
      const reader = readerStateRef.current;
      if (
        (unified || accountInbox) &&
        selectedThreadIdRef.current === threadId &&
        selectedThreadAccountIdRef.current === accountId
      ) {
        selectedThreadIdRef.current = null;
        selectedThreadAccountIdRef.current = null;
        setSelectedThreadId(null);
        setReaderState({ kind: "idle" });
        clearStickyOpen();
      } else if (
        reader.kind === "ready" &&
        reader.detail.thread.accountId === accountId &&
        reader.detail.thread.threadId === threadId
      ) {
        setReaderState({
          kind: "ready",
          detail: withLetterInInbox(reader.detail, false),
        });
      }
      if (unified) {
        const state = unifiedStateRef.current;
        if (state.kind === "ready") {
          commitUnifiedState({
            kind: "ready",
            streams: removeStreamItems(state.streams, [thread]),
          });
        }
        void refreshUnifiedSilently(new AbortController().signal);
      } else if (accountInbox) {
        refreshAfterRunRef.current = { accountId, mailboxId: "inbox" };
        refreshAfterRun();
      }
    },
    [
      clearStickyOpen,
      client,
      commitUnifiedState,
      onToast,
      refreshAfterRun,
      refreshUnifiedSilently,
    ],
  );

  /** The sentence a landed reader action says. Move to Inbox carries an Undo:
   *  the strip's Archive reverses it only while the reader stays on the
   *  letter, and the pill outlasts a reader that has moved on. */
  const confirmThreadAction = useCallback(
    (
      thread: MailThreadListItem,
      action: Exclude<MailReaderAction, "toggle-read">,
    ) => {
      if (action !== "move-to-inbox") {
        onToast?.(threadActionConfirmation(action));
        return;
      }
      onToast?.(threadActionConfirmation(action), {
        icon: "inbox-linear",
        actionLabel: "Undo",
        pendingLabel: "Undoing…",
        durationMs: SMART_UNDO_MS,
        // Refused while another mail action holds the lock: the pill keeps
        // standing and the press can be made again.
        onAction: () =>
          mutationLockRef.current ? false : undoMoveToInbox(thread),
      });
    },
    [onToast, undoMoveToInbox],
  );

  /**
   * Non-removing mutation for the held open thread (single-account unread
   * view / unread-first sort). The server PATCH fires exactly as everywhere
   * else — server truth stays immediate — but the page-1 refetch is
   * suppressed: refetching would drop the row from the unread view or
   * re-sort it away while the reader still shows it. The row and the reader
   * header are patched in place (the unread dot clears, position holds); the
   * list settles through the release refetch when the selection moves on or
   * the reader closes. No timers. Archive and Move to Inbox come here only
   * outside the Inbox, where the folder lists the letter either way: they
   * change no row, only the reader's way in or out.
   */
  const updateThreadHeld = useCallback(
    async (
      thread: MailThreadListItem,
      action: Extract<
        MailReaderAction,
        "toggle-read" | "star" | "unstar" | "archive" | "move-to-inbox"
      >,
    ) => {
      if (mutationLockRef.current) return;
      const accountId = thread.accountId;
      const mailboxId = selectedMailboxIdRef.current;
      const threadId = thread.threadId;
      if (
        selectedAccountIdRef.current !== accountId ||
        selectedThreadIdRef.current !== threadId ||
        selectedMailboxIdRef.current !== mailboxId
      ) {
        return;
      }
      const account = selectedMailAccount(accountsStateRef.current, accountId);
      if (!account?.capabilities.threadMutations) {
        onToast?.("Mail actions aren’t available for this account yet.", {
          urgent: true,
        });
        return;
      }
      mutationLockRef.current = true;
      setMutating(true);
      try {
        await client.updateThread(threadMutationInput(thread, action));
        if (
          selectedAccountIdRef.current !== accountId ||
          selectedMailboxIdRef.current !== mailboxId ||
          selectedThreadIdRef.current !== threadId ||
          selectedThreadAccountIdRef.current !== accountId
        ) {
          return;
        }
        singleHoldRef.current = true;
        const reader = readerStateRef.current;
        const readerOnIt =
          reader.kind === "ready" &&
          reader.detail.thread.accountId === accountId &&
          reader.detail.thread.threadId === threadId;
        if (action === "archive" || action === "move-to-inbox") {
          if (readerOnIt) {
            setReaderState({
              kind: "ready",
              detail: withLetterInInbox(
                reader.detail,
                action === "move-to-inbox",
              ),
            });
          }
          confirmThreadAction(thread, action);
          return;
        }
        const patchItem = (item: MailThreadListItem) => withReadOrStar(item, action);
        const current = threadStateRef.current;
        if (current.kind === "ready") {
          commitThreadState({
            kind: "ready",
            page: {
              ...current.page,
              items: current.page.items.map((item) =>
                item.threadId === threadId && item.accountId === accountId
                  ? patchItem(item)
                  : item,
              ),
            },
          });
        }
        if (readerOnIt) {
          setReaderState({
            kind: "ready",
            detail: {
              ...reader.detail,
              thread: patchItem(reader.detail.thread),
            },
          });
        }
        if (action !== "toggle-read") {
          onToast?.(threadActionConfirmation(action));
        }
      } catch (error) {
        onToast?.(threadActionFailure(error));
      } finally {
        mutationLockRef.current = false;
        setMutating(false);
      }
    },
    [client, commitThreadState, confirmThreadAction, onToast],
  );

  const updateThread = useCallback(
    async (thread: MailThreadListItem, action: MailReaderAction) => {
      if (mutationLockRef.current) return;
      const accountId = thread.accountId;
      const mailboxId = selectedMailboxIdRef.current;
      const view = selectedViewRef.current;
      const sort = threadSortRef.current;
      const query = searchQueryRef.current;
      const threadId = thread.threadId;
      if (
        selectedAccountIdRef.current !== accountId ||
        selectedThreadIdRef.current !== threadId ||
        selectedMailboxIdRef.current !== mailboxId
      ) {
        return;
      }
      const account = selectedMailAccount(accountsStateRef.current, accountId);
      if (!account?.capabilities.threadMutations) {
        onToast?.("Mail actions aren’t available for this account yet.", {
          urgent: true,
        });
        return;
      }
      mutationLockRef.current = true;
      const listEpoch = ++listEpochRef.current;
      setMutating(true);
      try {
        await client.updateThread(threadMutationInput(thread, action));
        if (
          selectedAccountIdRef.current !== accountId ||
          selectedMailboxIdRef.current !== mailboxId ||
          selectedViewRef.current !== view ||
          threadSortRef.current !== sort ||
          searchQueryRef.current !== query ||
          selectedThreadIdRef.current !== threadId ||
          listEpochRef.current !== listEpoch
        ) {
          return;
        }

        const listInput = {
          accountId,
          limit: 50,
          ...(view ? { view } : {}),
          ...(sort !== "date" ? { sort } : {}),
        };
        let page: MailThreadListPage;
        try {
          if (
            query.trim() !== "" &&
            normalizeMailSearchQueryText(query) === null
          ) {
            commitThreadState({ kind: "invalid-search" });
            selectedThreadIdRef.current = null;
            setSelectedThreadId(null);
            setReaderState({ kind: "idle" });
            clearStickyOpen();
            if (action !== "toggle-read") confirmThreadAction(thread, action);
            return;
          }
          page =
            query.trim() !== ""
              ? await client.searchThreads({
                  accountId,
                  mailboxId,
                  query,
                  limit: 50,
                })
              : mailboxId === "inbox"
              ? await client.listThreads(listInput)
              : await client.listMailboxThreads({ ...listInput, mailboxId });
        } catch {
          onToast?.("Action saved. Refresh Mail to see the latest state.");
          return;
        }
        if (
          selectedAccountIdRef.current !== accountId ||
          selectedMailboxIdRef.current !== mailboxId ||
          selectedViewRef.current !== view ||
          threadSortRef.current !== sort ||
          searchQueryRef.current !== query ||
          selectedThreadIdRef.current !== threadId ||
          listEpochRef.current !== listEpoch
        ) {
          return;
        }

        commitThreadState({ kind: "ready", page });
        const refreshedThread = page.items.find(
          (item) => item.accountId === accountId && item.threadId === threadId,
        );
        const reader = readerStateRef.current;
        if (
          !refreshedThread &&
          (action === "toggle-read" ||
            action === "star" ||
            action === "unstar" ||
            action === "move-to-inbox" ||
            (action === "archive" && mailboxId !== "inbox")) &&
          reader.kind === "ready" &&
          reader.detail.thread.accountId === accountId &&
          reader.detail.thread.threadId === threadId
        ) {
          // A letter beyond the mailbox's first page, the palette's pick from
          // deep in All Mail, is missing from the refetch without having gone
          // anywhere. A read or a star moves nothing, and a move between the
          // Inbox and out of it, offered as such only in All Mail and Starred,
          // leaves it in the folder on screen, so the reader stays and takes
          // the answer in place, as the held path does. Only an action that
          // moves the letter out closes it.
          setReaderState({
            kind: "ready",
            detail:
              action === "move-to-inbox" || action === "archive"
                ? withLetterInInbox(reader.detail, action === "move-to-inbox")
                : {
                    ...reader.detail,
                    thread: withReadOrStar(reader.detail.thread, action),
                  },
          });
        } else if (!refreshedThread) {
          selectedThreadIdRef.current = null;
          setSelectedThreadId(null);
          setReaderState({ kind: "idle" });
          clearStickyOpen();
        } else {
          try {
            const detail =
              mailboxId === "inbox"
                ? await client.readThread({ accountId, threadId })
                : await client.readMailboxThread({
                    accountId,
                    mailboxId,
                    threadId,
                  });
            if (
              selectedAccountIdRef.current !== accountId ||
              selectedMailboxIdRef.current !== mailboxId ||
              selectedViewRef.current !== view ||
              threadSortRef.current !== sort ||
              searchQueryRef.current !== query ||
              selectedThreadIdRef.current !== threadId ||
              listEpochRef.current !== listEpoch
            ) {
              return;
            }
            setReaderState({ kind: "ready", detail });
          } catch {
            if (
              selectedAccountIdRef.current === accountId &&
              selectedMailboxIdRef.current === mailboxId &&
              selectedViewRef.current === view &&
              threadSortRef.current === sort &&
              searchQueryRef.current === query &&
              selectedThreadIdRef.current === threadId &&
              listEpochRef.current === listEpoch
            ) {
              setReaderState({ kind: "error", thread: refreshedThread });
            }
          }
        }
        if (action !== "toggle-read") confirmThreadAction(thread, action);
      } catch (error) {
        onToast?.(threadActionFailure(error));
      } finally {
        mutationLockRef.current = false;
        setMutating(false);
      }
    },
    [clearStickyOpen, client, commitThreadState, confirmThreadAction, onToast],
  );

  /**
   * Local patch for a confirmed unified mutation. The single-mode
   * refetch-page-1 pattern does not fit a merged list, so streams are patched
   * in place: read/star flip the item, archive/trash/spam remove it (closing
   * the reader when it showed that thread), and an open reader's header stays
   * truthful without a refetch.
   */
  const applyUnifiedThreadPatch = useCallback(
    (thread: MailThreadListItem, action: MailReaderAction) => {
      const state = unifiedStateRef.current;
      if (state.kind !== "ready") return;
      const key = unifiedThreadKey(thread);
      const removes =
        action === "archive" || action === "trash" || action === "mark-spam";
      const patchItem = (item: MailThreadListItem): MailThreadListItem => {
        if (action === "toggle-read") return { ...item, unread: !item.unread };
        if (action === "star") return { ...item, starred: true };
        if (action === "unstar") return { ...item, starred: false };
        return item;
      };
      commitUnifiedState({
        kind: "ready",
        streams: state.streams.map((stream) => {
          if (stream.accountId !== thread.accountId) return stream;
          return {
            ...stream,
            items: removes
              ? stream.items.filter((item) => unifiedThreadKey(item) !== key)
              : stream.items.map((item) =>
                  unifiedThreadKey(item) === key ? patchItem(item) : item,
                ),
          };
        }),
      });
      if (removes) {
        if (
          selectedThreadIdRef.current === thread.threadId &&
          selectedThreadAccountIdRef.current === thread.accountId
        ) {
          selectedThreadIdRef.current = null;
          selectedThreadAccountIdRef.current = null;
          setSelectedThreadId(null);
          setReaderState({ kind: "idle" });
          clearStickyOpen();
        }
        return;
      }
      const reader = readerStateRef.current;
      if (
        reader.kind === "ready" &&
        reader.detail.thread.accountId === thread.accountId &&
        reader.detail.thread.threadId === thread.threadId
      ) {
        setReaderState({
          kind: "ready",
          detail: {
            ...reader.detail,
            thread: patchItem(reader.detail.thread),
          },
        });
      }
    },
    [clearStickyOpen, commitUnifiedState],
  );

  const updateUnifiedThread = useCallback(
    async (thread: MailThreadListItem, action: MailReaderAction) => {
      if (mutationLockRef.current) return;
      if (selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
      if (unifiedStateRef.current.kind !== "ready") return;
      const account = selectedMailAccount(
        accountsStateRef.current,
        thread.accountId,
      );
      if (!account?.capabilities.threadMutations) {
        onToast?.("Mail actions aren’t available for this account yet.", {
          urgent: true,
        });
        return;
      }
      mutationLockRef.current = true;
      const listEpoch = ++listEpochRef.current;
      setMutating(true);
      try {
        await client.updateThread(threadMutationInput(thread, action));
        if (
          selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID ||
          listEpochRef.current !== listEpoch
        ) {
          return;
        }
        applyUnifiedThreadPatch(thread, action);
        if (action !== "toggle-read") {
          onToast?.(threadActionConfirmation(action));
        }
      } catch (error) {
        onToast?.(threadActionFailure(error));
      } finally {
        mutationLockRef.current = false;
        setMutating(false);
      }
    },
    [applyUnifiedThreadPatch, client, onToast],
  );

  /**
   * Routes reader-scoped mutations: unified mode patches streams locally; a
   * held single-account thread (auto-read under the unread view or
   * unread-first sort) keeps non-removing actions in the suppressed in-place
   * path so the row cannot leave or re-sort mid-read; everything else takes
   * the refetching flow.
   */
  const mutateOpenThread = useCallback(
    (thread: MailThreadListItem, action: MailReaderAction) => {
      if (selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID) {
        return updateUnifiedThread(thread, action);
      }
      // A held letter keeps its row through what leaves it in the folder on
      // screen: a read or a star anywhere, and the move in or out of the
      // Inbox outside the Inbox, which lists the letter either way there.
      if (
        singleHoldRef.current &&
        (action === "toggle-read" ||
          action === "star" ||
          action === "unstar" ||
          ((action === "archive" || action === "move-to-inbox") &&
            selectedMailboxIdRef.current !== "inbox")) &&
        selectedThreadIdRef.current === thread.threadId &&
        selectedThreadAccountIdRef.current === thread.accountId
      ) {
        return updateThreadHeld(thread, action);
      }
      return updateThread(thread, action);
    },
    [updateThread, updateThreadHeld, updateUnifiedThread],
  );

  /** Put a set of threads back into the merged list in ONE commit: the rows
   *  an Undo of a Block returns, which a refresh may have dropped since. */
  const putBackUnifiedThreads = useCallback(
    (items: readonly MailThreadListItem[]) => {
      if (items.length === 0) return;
      const state = unifiedStateRef.current;
      if (
        selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID ||
        state.kind !== "ready"
      ) {
        return;
      }
      commitUnifiedState({
        kind: "ready",
        streams: restoreStreamItems(state.streams, items),
      });
    },
    [commitUnifiedState],
  );

  /** The column's rows as the service last listed them, before any shown
   *  decision is laid over them. */
  const rawListItems = useCallback((): readonly MailThreadListItem[] => {
    if (selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID) {
      const state = unifiedStateRef.current;
      return state.kind === "ready" ? mergedDisplayItems(state.streams).items : [];
    }
    const state = threadStateRef.current;
    return state.kind === "ready" ? state.page.items : [];
  }, []);

  /** Whether the column stands at a list a block's archive empties. */
  const columnIsInbox = useCallback(
    () =>
      selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID ||
      selectedMailboxIdRef.current === "inbox",
    [],
  );

  /** Some rows, as the reader's decisions and a section's Done leave them in
   *  the column. */
  const shownRows = useCallback(
    (
      items: readonly MailThreadListItem[],
      decisions: readonly SenderDecisionEntry[] = senderDecisionsRef.current,
    ) => {
      const overlay = { inbox: columnIsInbox() };
      return hideDone(
        applyShownDecisions(items, decisions, overlay),
        doneOverlayRef.current,
        overlay,
      );
    },
    [columnIsInbox],
  );

  /** "Everyone at <domain>", as the handlers ask it (`domainScopeAllowed`). */
  const domainScopeOf = useCallback(
    (domain: string) => domainScopeAllowed(senderScreenRef.current, domain),
    [],
  );

  /** Close the reader when the letter it holds is one a Block takes away. */
  const closeReaderOn = useCallback(
    (items: readonly MailThreadListItem[]) => {
      const openThread = selectedThreadIdRef.current;
      const openAccount = selectedThreadAccountIdRef.current;
      if (
        openThread === null ||
        !items.some(
          (item) => item.threadId === openThread && item.accountId === openAccount,
        )
      ) {
        return;
      }
      selectedThreadIdRef.current = null;
      selectedThreadAccountIdRef.current = null;
      setSelectedThreadId(null);
      setReaderState({ kind: "idle" });
      clearStickyOpen();
    },
    [clearStickyOpen],
  );

  /**
   * Shows a new set of decisions, and moves the column to it.
   *
   * The change is committed synchronously (`flushSync`) between two
   * measurements of the column, so what moved can be played back from where
   * it stood (`mail-flip.ts`): rows that changed sections travel, rows that
   * leave go as ghosts, rows that return come in from the side they left by.
   * When nothing will be left waiting, the New senders header leaves with the
   * last row instead of blinking out under it. `alongside` rides the same
   * commit, for the reader or a stream that has to change with the column.
   */
  const showSenderDecisions = useCallback(
    (
      next: readonly SenderDecisionEntry[],
      motion: {
        readonly travel?: ReadonlySet<string>;
        readonly leave?: ReadonlySet<string>;
        readonly enter?: ReadonlySet<string>;
        readonly leaveMode?: "left" | "fade";
        readonly dragged?: { readonly key: string; readonly x: number };
      } = {},
      alongside?: () => void,
    ) => {
      const root = document.querySelector<HTMLElement>(".brain-mail-list");
      const reduce = reduceMotionRef.current === true;
      const before = root ? new Map(snapshotFlip(root)) : null;
      if (before && motion.dragged) {
        const from = before.get(motion.dragged.key);
        if (from) {
          before.set(motion.dragged.key, {
            left: from.left + motion.dragged.x,
            top: from.top,
          });
        }
      }
      const leaving =
        root && motion.leave && motion.leave.size > 0
          ? flipElements(root, motion.leave)
          : [];
      const stillWaiting = shownRows(rawListItems(), next).some(
        (item) => waitsOn(item) !== null,
      );
      if (root) handFocusOn(root, new Set([...(motion.leave ?? []), ...(motion.travel ?? [])]));
      const header =
        root && !stillWaiting
          ? root.querySelector<HTMLElement>(
              '[data-flip="section:new-senders"] > .brain-mail-section-head',
            )
          : null;
      const letGo = root
        ? ghostFlip(
            root,
            header ? [...leaving, header] : leaving,
            motion.leaveMode ?? "left",
            reduce,
          )
        : null;
      flushSync(() => {
        senderDecisionsRef.current = next;
        setSenderDecisions(next);
        alongside?.();
      });
      letGo?.();
      if (root && before) {
        playFlip(root, before, {
          travel: motion.travel,
          arrive: motion.travel,
          enter: motion.enter,
          reduce,
        });
      }
    },
    [rawListItems, shownRows],
  );

  /** A quiet read of whatever the column stands at, for after the service
   *  has changed its mind about who waits. */
  const rereadColumn = useCallback(() => {
    const accountId = selectedAccountIdRef.current;
    if (accountId === UNIFIED_ACCOUNT_ID) {
      void refreshUnifiedSilently(new AbortController().signal);
    } else if (accountId !== null) {
      void refreshThreadsSilently(
        accountId,
        selectedMailboxIdRef.current,
        new AbortController().signal,
      );
    }
  }, [refreshThreadsSilently, refreshUnifiedSilently]);

  /**
   * The threads an Undo gives back to New senders, as waiting rows again in
   * the lists that hold them. A read that landed after the Accept already
   * lists them as ordinary letters, and without this they would sit in
   * People until the read after the Undo.
   */
  const waitAgain = useCallback(
    (taken: readonly MailThreadListItem[]) => {
      const byKey = new Map(taken.map((item) => [unifiedThreadKey(item), item]));
      const rewait = (item: MailThreadListItem) => {
        const before = byKey.get(unifiedThreadKey(item));
        return before && !item.newSender && before.newSenderFrom
          ? { ...item, newSender: true, newSenderFrom: before.newSenderFrom }
          : item;
      };
      const unified = unifiedStateRef.current;
      if (selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID && unified.kind === "ready") {
        commitUnifiedState({
          kind: "ready",
          streams: unified.streams.map((stream) => ({
            ...stream,
            items: stream.items.map(rewait),
          })),
        });
        return;
      }
      const single = threadStateRef.current;
      if (single.kind === "ready") {
        commitThreadState({
          kind: "ready",
          page: { ...single.page, items: single.page.items.map(rewait) },
        });
      }
    },
    [commitThreadState, commitUnifiedState],
  );

  /**
   * Decisions and Undos about one key, in the order they were made. The
   * service answers the same verdict with the id that stands, so an Accept
   * sent while the Undo of the last Accept is still out could be answered
   * with the id that DELETE is about to remove. Each waits for the one
   * before it about the same key.
   */
  const senderLanesRef = useRef(new Map<string, Promise<void>>());
  const inSenderLane = useCallback((lane: string, work: () => Promise<void>) => {
    const lanes = senderLanesRef.current;
    const run = (lanes.get(lane) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => {});
    lanes.set(lane, settled);
    void settled.then(() => {
      if (lanes.get(lane) === settled) lanes.delete(lane);
    });
    return run;
  }, []);

  /**
   * The toast's Undo. The rows come back at the press, the way they left,
   * and the DELETE follows. A decision the service no longer has
   * (`mail_sender_decision_not_found`) is one already undone, and one a later
   * decision replaced (`mail_sender_decision_changed`) is the later toast's to
   * speak for, so neither says anything. Any other failure means the decision
   * still stands, and the column shows it again and says so.
   */
  const undoSenderDecision = useCallback(
    async (token: number): Promise<void> => {
      const entry = senderDecisionsRef.current.find((each) => each.token === token);
      if (!entry || entry.decisionId === null) return;
      const decisionId = entry.decisionId;
      const keys = new Set(entry.taken.map(flipRowKey));
      showSenderDecisions(
        senderDecisionsRef.current.filter((each) => each.token !== token),
        !columnIsInbox()
          ? {}
          : entry.verdict === "accept"
            ? { travel: keys }
            : { enter: keys },
        entry.verdict === "block"
          ? () => putBackUnifiedThreads(entry.taken)
          : () => waitAgain(entry.taken),
      );
      await inSenderLane(`${entry.scope}:${entry.key}`, async () => {
        try {
          await client.undoSenderDecision({ decisionId });
        } catch (error) {
          if (
            !(
              error instanceof MailApiError &&
              (error.code === "mail_sender_decision_not_found" ||
                error.code === "mail_sender_decision_changed")
            )
          ) {
            const inbox = columnIsInbox();
            showSenderDecisions(
              [...senderDecisionsRef.current, entry],
              !inbox
                ? {}
                : entry.verdict === "accept"
                  ? { travel: keys }
                  : { leave: keys, leaveMode: "left" },
              entry.verdict === "block" && inbox ? () => closeReaderOn(entry.taken) : undefined,
            );
            onToast?.("Couldn’t undo. Try again.", { urgent: true });
            return;
          }
          // Already undone, or replaced by a later decision: nothing to say,
          // but the service's lists are the truth now, so the column reads.
        }
        // The service moved back what a block archived, which can be more than
        // the column held, and flags again who an accept had let in. A quiet
        // read brings the column level with it.
        rereadColumn();
      });
    },
    [
      client,
      closeReaderOn,
      columnIsInbox,
      inSenderLane,
      onToast,
      putBackUnifiedThreads,
      rereadColumn,
      showSenderDecisions,
      waitAgain,
    ],
  );

  /**
   * Accept or Block, from a row, the reader, the row menu, a swipe or a key.
   *
   * The decision names the sender by the thread's first From
   * (`newSenderFrom`), never by `participants` or a Reply-To. It shows at once
   * and for every row it covers: an Accept sends them to their sections, a
   * Block takes them out of an Inbox (and closes the letter if it is the one
   * open). Any other list still holds a blocked sender's letters, so there
   * they only stop waiting. The POST follows; a refusal takes the decision back off the
   * column and says so at once, and an answer brings the toast with its
   * Undo. The service recomputes `newSender` only on the next list read, so
   * until then the shown decision is what keeps the rows where the reader
   * put them.
   */
  const decideSender: SenderDecide = useCallback(
    (thread, verdict, scope, options) => {
      const from = waitsOn(thread);
      if (from === null) return;
      const address = from.address.toLowerCase();
      const key = scope === "domain" ? senderDomain(address) : address;
      if (scope === "domain" && !domainScopeOf(key)) return;
      const covered = (item: MailThreadListItem) => {
        const sender = waitsOn(item);
        if (sender === null) return false;
        const other = sender.address.toLowerCase();
        return scope === "domain" ? senderDomain(other) === key : other === key;
      };
      const taken = shownRows(rawListItems()).filter(covered);
      if (
        !taken.some(
          (item) => item.accountId === thread.accountId && item.threadId === thread.threadId,
        )
      ) {
        taken.push(thread);
      }
      const entry: SenderDecisionEntry = {
        token: ++senderTokenRef.current,
        scope,
        key,
        verdict,
        archived: new Set(),
        decisionId: null,
        taken,
        answeredAt: null,
      };
      const keys = new Set(taken.map(flipRowKey));
      const dragged =
        options?.dragged !== undefined && options.dragged !== 0
          ? { key: flipRowKey(thread), x: options.dragged }
          : undefined;
      // Any list but an Inbox keeps the rows where they stand, settled, and
      // the letter open.
      const inbox = columnIsInbox();
      showSenderDecisions(
        [...senderDecisionsRef.current, entry],
        !inbox
          ? {}
          : verdict === "accept"
            ? { travel: keys, leaveMode: "fade", dragged }
            : { leave: keys, leaveMode: "left", dragged },
        verdict === "block" && inbox ? () => closeReaderOn(taken) : undefined,
      );
      const name = scope === "domain" ? key : senderName(from);
      const senders = new Set(
        taken.map((item) => waitsOn(item)?.address.toLowerCase() ?? ""),
      ).size;
      void inSenderLane(`${scope}:${key}`, async () => {
        let decided: { readonly decisionId: string; readonly archived: ReadonlySet<string> };
        try {
          const result = await client.decideSender({
            address: from.address,
            scope,
            decision: verdict,
          });
          decided = {
            decisionId: result.decisionId,
            archived: new Set(result.archived.map(unifiedThreadKey)),
          };
        } catch (error) {
          const current = senderDecisionsRef.current;
          if (current.some((each) => each.token === entry.token)) {
            showSenderDecisions(
              current.filter((each) => each.token !== entry.token),
              !columnIsInbox()
                ? {}
                : verdict === "accept"
                  ? { travel: keys }
                  : { enter: keys },
            );
          }
          onToast?.(senderDecisionFailure(error, verdict, name), { urgent: true });
          return;
        }
        const current = senderDecisionsRef.current;
        if (current.some((each) => each.token === entry.token)) {
          // A block can archive more than the column was showing under New
          // senders; any of those still on screen in an Inbox leave the same
          // way.
          const more = new Set(
            columnIsInbox()
              ? shownRows(rawListItems(), current)
                  .filter((item) => decided.archived.has(unifiedThreadKey(item)))
                  .map(flipRowKey)
              : [],
          );
          showSenderDecisions(
            current.map((each) =>
              each.token === entry.token
                ? {
                    ...each,
                    decisionId: decided.decisionId,
                    archived: decided.archived,
                    answeredAt: inboxReadsRef.current,
                  }
                : each,
            ),
            { leave: more, leaveMode: "left" },
          );
        }
        onToast?.(verdict === "accept" ? `Accepted ${name}` : `Blocked ${name}`, {
          icon:
            scope === "domain"
              ? "users-group-rounded-linear"
              : verdict === "accept"
                ? "user-check-rounded-linear"
                : "user-block-rounded-linear",
          subtitle:
            verdict === "block"
              ? "Next letters go to Blocked too."
              : scope === "domain" && senders > 1
                ? `${senders} senders in. Next ones come straight in.`
                : "In People. Next ones come straight in.",
          actionLabel: "Undo",
          pendingLabel: "Undoing…",
          durationMs: SMART_UNDO_MS,
          id: `mail-sender:${entry.token}`,
          onAction: () => undoSenderDecision(entry.token),
        });
      });
    },
    [
      client,
      closeReaderOn,
      columnIsInbox,
      domainScopeOf,
      inSenderLane,
      onToast,
      rawListItems,
      showSenderDecisions,
      shownRows,
      undoSenderDecision,
    ],
  );

  /** The open letter while it still waits, with the reach its switch holds
   *  (the address unless the domain is both chosen and allowed). */
  const openLetterTarget = useCallback((): {
    readonly thread: MailThreadListItem;
    readonly scope: SenderScope;
  } | null => {
    // The letter on screen is the one decided, whether or not its messages
    // have arrived yet: the row it was opened from already names its sender.
    const reader = readerStateRef.current;
    if (reader.kind === "idle") return null;
    const [open] = shownRows([reader.kind === "ready" ? reader.detail.thread : reader.thread]);
    const from = open ? waitsOn(open) : null;
    if (!open || from === null) return null;
    const held = readerScopeRef.current;
    const scope =
      held?.key === flipRowKey(open) &&
      held.scope === "domain" &&
      domainScopeOf(senderDomain(from.address))
        ? "domain"
        : "address";
    return { thread: open, scope };
  }, [domainScopeOf, shownRows]);

  /** What A and B act on. While a letter is open it is that letter (still
   *  waiting, else nothing): j and k move the reader and leave the focus
   *  where a press put it, so a row focused earlier is not what the reader is
   *  looking at. With nothing open, the New senders row the keyboard stands
   *  on. Null when neither is a first letter. */
  const waitingTargetForKey = useCallback((): {
    readonly thread: MailThreadListItem;
    readonly scope: SenderScope;
  } | null => {
    if (readerStateRef.current.kind !== "idle") return openLetterTarget();
    const active = document.activeElement;
    const row =
      active instanceof HTMLElement ? active.closest<HTMLElement>("[data-waiting]") : null;
    if (row === null) return null;
    const found = shownRows(rawListItems()).find(
      (item) => flipRowKey(item) === row.dataset.waiting && waitsOn(item) !== null,
    );
    return found ? { thread: found, scope: "address" } : null;
  }, [openLetterTarget, rawListItems, shownRows]);

  /** The reader's two controls for a first letter: the reach its switch
   *  holds for the letter now open, and the decision made with that reach. */
  const holdReaderScope = useCallback((scope: SenderScope) => {
    const reader = readerStateRef.current;
    if (reader.kind === "idle") return;
    const held = {
      key: flipRowKey(reader.kind === "ready" ? reader.detail.thread : reader.thread),
      scope,
    };
    readerScopeRef.current = held;
    setReaderScope(held);
  }, []);

  const decideOpenLetter = useCallback(
    (verdict: SenderVerdict) => {
      const target = openLetterTarget();
      if (target !== null) decideSender(target.thread, verdict, target.scope);
    },
    [decideSender, openLetterTarget],
  );

  /** THE TRANSPORT of a section's Done, and the reading of its failures. One
   *  queue for every Done still going out, so their requests stay one at a
   *  time. A batch endpoint replaces the first function here and nothing
   *  else. It sends through the client as given: the counting wrapper above
   *  is about list reads and leaves a mutation as it is. */
  const sectionDoneQueue = useMemo(
    () =>
      doneQueue(
        (mutation, { keepalive }) =>
          givenClient.updateThread(
            mutation,
            undefined,
            keepalive ? { keepalive: true } : undefined,
          ),
        sectionDoneFailure,
      ),
    [givenClient],
  );

  /**
   * The run has landed. Success is silent: the one sentence was said at the
   * press and its pill is gone. Anything else is ONE report, with no Undo,
   * because the window closed before the first request went out and a letter
   * comes back through Move to Inbox now.
   *
   * What stayed returns to the column in one commit, by coming off the
   * overlay: the streams never dropped it. A letter the server no longer
   * recognises (`mail_thread_stale`: moved by another client, or its mailbox
   * re-keyed under the list) did not "stay put". It is not where the column
   * had it, so it is held out like one that moved, and the next read says
   * where it is.
   *
   * The report waits its turn behind a standing Undo like any other, and
   * wears no id: the Done pill's id may by now belong to a later Done, and a
   * report must not take that one's way back.
   */
  const reportSectionDone = useCallback(
    (run: SectionDoneRun, outcome: DoneOutcome) => {
      commitDoneOverlay(
        releaseDone(
          landDone(doneOverlayRef.current, outcome.changed, inboxReadsRef.current),
          outcome.stayed,
        ),
      );
      if (outcome.stayed.length === 0 && outcome.changed.length === 0) return;
      /* Why the threads that stayed are never coming back on their own. A
         refusal is the server's folder layout, not a bad minute, so "try
         again" would be a lie and the reader is owed the actual reason. An
         account that went quiet is named apart from one that refused, because
         "no folder for it" would be a lie about it. */
      const missing = [
        ...(outcome.refused.size === 0
          ? []
          : [
              outcome.refused.size === 1
                ? "that account has no folder for it"
                : "those accounts have no folder for it",
            ]),
        ...(outcome.silent.size === 0
          ? []
          : [
              outcome.silent.size === 1
                ? "that account stopped answering"
                : "those accounts stopped answering",
            ]),
      ];
      /* What the press could never have moved, named in every report: a row
         that stays behind with nothing said about it never corrects itself. */
      const held = run.blocked === 0 ? [] : [`${run.blocked} can’t leave`];
      const changed =
        outcome.changed.length === 0
          ? []
          : [`${outcome.changed.length} changed on the server`];
      if (outcome.moved.length === 0) {
        onToast?.(`Couldn’t clear ${run.label}`, {
          icon: "danger-triangle-linear",
          subtitle: [
            ...(outcome.stayed.length === 0
              ? []
              : [`${threadWord(outcome.stayed.length)} stayed put`]),
            ...changed,
            ...missing,
            ...held,
          ].join(", "),
        });
        return;
      }
      onToast?.(`${run.label} partly cleared`, {
        icon: "check-linear",
        subtitle: [
          `${outcome.moved.length} archived`,
          ...(outcome.stayed.length === 0
            ? []
            : [`${outcome.stayed.length} stayed put`]),
          ...changed,
          ...missing,
          ...held,
        ].join(", "),
      });
    },
    [commitDoneOverlay, onToast],
  );

  /**
   * The window closed: the run goes to the queue, in the background. It takes
   * no mutation lock and moves no list epoch, so every other mail action
   * works while it sends, and it goes on to its end whatever the column does
   * meanwhile. Leaving All inboxes or switching account stops nothing.
   *
   * Each archive that answers marks its thread's hold as landed. The hold
   * itself stays until a list read begun after that answer lands
   * (`doneReadLandedRef`): a read that left earlier may still list the
   * thread, and the mail events the run's own mutations raise bring exactly
   * such reads.
   */
  const commitSectionDone = useCallback(
    (run: SectionDoneRun) => {
      void sectionDoneQueue
        .commit(run.threads, (thread) =>
          commitDoneOverlay(
            landDone(doneOverlayRef.current, [thread], inboxReadsRef.current),
          ),
        )
        .then((outcome) => reportSectionDone(run, outcome));
    },
    [commitDoneOverlay, reportSectionDone, sectionDoneQueue],
  );

  /**
   * The way back is gone before its window ran out: a second Done was
   * pressed, the surface is unmounting, or the page is leaving. The waiting
   * run goes to the queue now, and the sentence is said again under its id
   * without an Undo, so no pill is left offering a way back over archives
   * already out (see `flushDeferredDiscard`, whose shape this is).
   *
   * At pagehide (`keepalive`) the queue is emptied in the same task: what
   * this run and any run still going out have not sent leaves at once,
   * allowed to outlive the tab.
   */
  const flushSectionDone = useCallback(
    (options?: { readonly keepalive?: boolean }) => {
      const parked = sectionDoneParkedRef.current;
      sectionDoneParkedRef.current = null;
      if (parked?.flush()) {
        onToast?.(sectionDoneTitle(parked.parcel), {
          id: SECTION_DONE_TOAST_ID,
          icon: "check-linear",
          subtitle: sectionDoneSubtitle(parked.parcel),
        });
      }
      if (options?.keepalive) sectionDoneQueue.unload();
    },
    [onToast, sectionDoneQueue],
  );
  useEffect(() => {
    flushSectionDoneRef.current = flushSectionDone;
  }, [flushSectionDone]);

  /**
   * "Done" over one whole section: every thread in it leaves the inbox.
   *
   * **The section goes at the press, in one commit, and nothing is sent.**
   * The rows are hidden through the overlay (`mail-section-done.ts`), the
   * pill appears with its Undo and the window every other Undo in Brain has
   * (`SMART_UNDO_MS`), and the ring counts from that moment. It used to send
   * from the press under the mail lock, with a pill that had no window until
   * the last request landed: fifteen newsletters were half a minute of a pill
   * with no ring and of every other mail action refused.
   *
   * **Undo inside the window takes the threads off the overlay.** The rows
   * are back, no request was ever made, and so it cannot fail.
   *
   * **When the window closes the commit runs in the background**
   * (`commitSectionDone`). The shell owns the window, hover included, and
   * says so through `onExpire`. One Done waits at a time: a second press
   * lets the first go at once and opens a window of its own.
   *
   * The count in the message is a statement about the COLUMN, which is true
   * when it is made: this many letters just left the list. It is not a
   * receipt from the provider, and when the provider disagrees the rows
   * return and one report says so ("2 archived, 1 stayed put").
   *
   * A thread on an account that reports no thread mutations at all
   * (`threadMutations` false) never leaves. It used to be filtered out and
   * forgotten, which in a mixed unified inbox meant the label promised
   * fourteen, eleven went, the report counted eleven and three rows sat in
   * the column with nothing said about them. So the split is explicit:
   * `pending` is what Done will try, `blocked` is what it will not, the
   * header counts `pending` before the press, and every sentence names
   * `blocked` after it. A section with nothing archivable in it draws no
   * Done at all, so the spoken refusal below is the guard for the race where
   * the capability changes under a button already on screen.
   */
  const markSectionDone = useCallback(
    (items: readonly MailThreadListItem[], label: string) => {
      if (selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
      const pending: MailThreadListItem[] = [];
      const blocked: MailThreadListItem[] = [];
      for (const item of items) {
        const account = selectedMailAccount(
          accountsStateRef.current,
          item.accountId,
        );
        (account?.capabilities.threadMutations ? pending : blocked).push(item);
      }
      if (pending.length === 0) {
        onToast?.(`Nothing in ${label} can leave this account`, { urgent: true });
        return;
      }
      // One Done waits at a time: this press lets an earlier one go.
      flushSectionDone();
      const run: SectionDoneRun = { label, threads: pending, blocked: blocked.length };
      commitDoneOverlay(holdDone(doneOverlayRef.current, pending));
      // A letter open in the reader leaves with its row, as Archive closes it.
      closeReaderOn(pending);
      // No toast channel, no Undo to offer, and so nothing to wait for.
      if (!onToast) {
        commitSectionDone(run);
        return;
      }
      const parked = parkDiscard<SectionDoneRun>(run, (parcel) =>
        commitSectionDone(parcel),
      );
      sectionDoneParkedRef.current = parked;
      onToast(sectionDoneTitle(run), {
        id: SECTION_DONE_TOAST_ID,
        icon: "check-linear",
        subtitle: sectionDoneSubtitle(run),
        actionLabel: "Undo",
        durationMs: SMART_UNDO_MS,
        onAction: () => {
          // Nothing left to bring back (the run already went to the queue):
          // the press is refused rather than spending a pill that was
          // replaced.
          const back = parked.restore();
          if (!back) return false;
          if (sectionDoneParkedRef.current === parked) {
            sectionDoneParkedRef.current = null;
          }
          commitDoneOverlay(releaseDone(doneOverlayRef.current, back.threads));
        },
        onExpire: () => {
          if (sectionDoneParkedRef.current === parked) {
            sectionDoneParkedRef.current = null;
          }
          parked.flush();
        },
      });
    },
    [
      closeReaderOn,
      commitDoneOverlay,
      commitSectionDone,
      flushSectionDone,
      onToast,
    ],
  );

  // Reading a message is reading it: the reader's ready state marks an unread
  // thread read through the exact mutation path the header button uses. The
  // key makes it once per open — re-renders, content polls, and silent
  // refreshes see a consumed key and stand down; closing the reader clears it.
  useEffect(() => {
    if (readerState.kind === "idle") {
      autoReadKeyRef.current = null;
      return;
    }
    if (readerState.kind !== "ready") return;
    const thread = readerState.detail.thread;
    const key = `${thread.accountId}:${thread.threadId}`;
    if (autoReadKeyRef.current === key) return;
    // A held mutation lock defers instead of spending the key: `mutating`
    // mirrors the lock into state, so this runs again when the lock lifts and
    // marks the letter read then. It used to spend the key and skip, which
    // left a letter opened during another mail action unread with nothing
    // said.
    if (mutating || mutationLockRef.current) return;
    autoReadKeyRef.current = key;
    if (!thread.unread) return;
    const account = selectedMailAccount(
      accountsStateRef.current,
      thread.accountId,
    );
    if (!account?.capabilities.threadMutations) return;
    // Route: unified mode patches streams locally; the unread view and the
    // unread-first sort take the suppressed in-place path (a refetch would
    // remove or re-sort the letter that was just opened); the default takes
    // the refetching flow. The kick is a microtask so the effect body never
    // reaches a synchronous setState — same pattern as the other loaders.
    const mutate =
      selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID
        ? updateUnifiedThread
        : singleHoldEligible()
          ? updateThreadHeld
          : updateThread;
    queueMicrotask(() => void mutate(thread, "toggle-read"));
  }, [
    mutating,
    readerState,
    singleHoldEligible,
    updateThread,
    updateThreadHeld,
    updateUnifiedThread,
  ]);

  const sync = useCallback(async () => {
    const accountId = selectedAccountIdRef.current;
    const mailboxId = selectedMailboxIdRef.current;
    const view = selectedViewRef.current;
    const sort = threadSortRef.current;
    const query = searchQueryRef.current;
    const account = accountId
      ? selectedMailAccount(accountsStateRef.current, accountId)
      : null;
    if (!accountId || !account?.capabilities.sync || syncing) return;
    setSyncing(true);
    try {
      await client.sync({ accountId });
      if (
        selectedAccountIdRef.current !== accountId ||
        selectedMailboxIdRef.current !== mailboxId ||
        selectedViewRef.current !== view ||
        threadSortRef.current !== sort ||
        searchQueryRef.current !== query
      ) {
        return;
      }
      if (
        query.trim() !== "" &&
        normalizeMailSearchQueryText(query) === null
      ) {
        commitThreadState({ kind: "invalid-search" });
      } else if (query.trim() !== "") {
        await loadSearch(accountId, mailboxId, query);
      } else {
        await loadThreads(accountId, mailboxId, view, sort);
      }
    } catch {
      onToast?.("Mail sync failed. Try again.");
    } finally {
      setSyncing(false);
    }
  }, [
    client,
    commitThreadState,
    loadThreads,
    loadSearch,
    onToast,
    syncing,
  ]);

  const loadMore = useCallback(
    async (cursor: string) => {
      if (mutationLockRef.current) return;
      const accountId = selectedAccountIdRef.current;
      const mailboxId = selectedMailboxIdRef.current;
      const view = selectedViewRef.current;
      const sort = threadSortRef.current;
      const query = searchQueryRef.current;
      const baseState = threadStateRef.current;
      if (
        !accountId ||
        baseState.kind !== "ready" ||
        baseState.page.nextCursor !== cursor
      ) {
        return;
      }
      const account = selectedMailAccount(accountsStateRef.current, accountId);
      if (!account?.capabilities.mailboxes.includes(mailboxId)) return;
      const listInput = {
        accountId,
        limit: 50,
        ...(view ? { view } : {}),
        ...(sort !== "date" ? { sort } : {}),
      };
      const basePage = baseState.page;
      const listEpoch = ++listEpochRef.current;
      const stillHere = () =>
        selectedAccountIdRef.current === accountId &&
        selectedMailboxIdRef.current === mailboxId &&
        selectedViewRef.current === view &&
        threadSortRef.current === sort &&
        searchQueryRef.current === query &&
        listEpochRef.current === listEpoch;
      /** One page from `from`, or page one for `null`. */
      const read = (from: string | null): Promise<MailThreadListPage> => {
        if ("scope" in basePage) {
          return client.searchThreads({
            accountId,
            mailboxId,
            query,
            ...(from === null ? {} : { cursor: from }),
            limit: 50,
          });
        }
        const input = from === null ? listInput : { ...listInput, cursor: from };
        return mailboxId === "inbox"
          ? client.listThreads(input)
          : client.listMailboxThreads({ ...input, mailboxId });
      };
      try {
        // The rows the new ones go below, and the page they come from.
        let rows = basePage;
        let from = cursor;
        let next: MailThreadListPage;
        try {
          next = await read(cursor);
        } catch (error) {
          // A cursor a sync has made stale (outside the Inbox any history
          // advance does it, and a new generation does it everywhere) heals
          // the way a merged stream does: page one is read again, the rows
          // below it stay, and the walk goes on from its cursor past them.
          // An open letter a hold keeps in place stays where it stood.
          if ("scope" in basePage || !isSyncHold(error) || !stillHere()) throw error;
          const pageOne = await read(null);
          if (!stillHere()) return;
          rows = pageWithHeldThread(
            pageWithLoadedDepth(pageOne, basePage, { keepCursor: false, drop: null }),
            basePage,
            {
              accountId: selectedThreadAccountIdRef.current,
              threadId: singleHoldRef.current ? selectedThreadIdRef.current : null,
            },
          );
          if (pageOne.nextCursor === null) {
            next = { ...pageOne, items: [] };
          } else {
            from = pageOne.nextCursor;
            next = await read(from);
          }
        }
        // Every press walks: after a refresh or a heal the cursor can start
        // inside rows this list already holds, and a mark saying so did not
        // survive every commit that replaced the page. A page that brings
        // nothing new is walked past, no more of them than the list is deep
        // plus one, and a cursor already read ends the walk rather than
        // leading back over the same pages. An ordinary page ends it at once
        // with its first new row.
        const held = new Set(rows.items.map((item) => item.threadId));
        const cap = Math.ceil(rows.items.length / 50) + 1;
        const asked = new Set([from]);
        const gathered = [...next.items];
        while (
          asked.size < cap &&
          next.nextCursor !== null &&
          gathered.every((item) => held.has(item.threadId)) &&
          stillHere()
        ) {
          if (asked.has(next.nextCursor)) {
            next = { ...next, nextCursor: null };
            break;
          }
          asked.add(next.nextCursor);
          next = await read(next.nextCursor);
          gathered.push(...next.items);
        }
        next = { ...next, items: gathered };
        if (!stillHere()) return;
        const current = threadStateRef.current;
        if (
          current.kind !== "ready" ||
          current.page !== basePage ||
          current.page.nextCursor !== cursor
        ) {
          return;
        }
        const seen = new Set(rows.items.map((item) => item.threadId));
        commitThreadState({
          kind: "ready",
          page: {
            ...next,
            items: [
              ...rows.items,
              ...next.items.filter((item) => !seen.has(item.threadId)),
            ],
          },
        });
      } catch {
        if (
          selectedAccountIdRef.current === accountId &&
          selectedMailboxIdRef.current === mailboxId &&
          selectedViewRef.current === view &&
          threadSortRef.current === sort &&
          searchQueryRef.current === query &&
          listEpochRef.current === listEpoch
        ) {
          onToast?.("More messages couldn’t load.");
        }
      }
    },
    [client, commitThreadState, onToast],
  );

  // Mail-scoped keyboard layer. The surface only mounts while Mail is the open
  // route, mirroring the conditional-scope precedent in shell.tsx (⌘Z
  // undo-delete). Modifier chords belong to the app-level shortcuts, typing
  // surfaces keep every key, and an open composer swallows everything except
  // Escape. The handler reads refs, so the window listener binds once below.
  const handleMailKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.isComposing) return;
      /* The compose sheet answers Escape itself (Radix, at the document, and
         it marks the event handled), and it has already closed the composer
         by the time this window listener runs. Without this the same press
         fell through to the next branch and closed the reader under it. */
      if (event.defaultPrevented) return;
      if (isEditableEventTarget(event.target)) return;
      /* A question on top owns the keyboard. Radix dismisses its dialog from
         a document listener and this window listener runs after it, with the
         dialog still in the DOM because React has not re-rendered yet — so
         without this one Escape answered "Discard this draft?" AND threw the
         composer away behind it, which is the opposite of what Cancel
         means. */
      if (document.querySelector('[role="alertdialog"]')) return;
      /* An open menu owns the keyboard too. Radix reads letters for its
         typeahead without marking them handled, so an a typed to reach
         "Accept" in a row menu, or an e in the nav menu, would otherwise
         also decide or archive the open letter behind it. */
      if (
        (event.target instanceof Element && event.target.closest('[role="menu"]')) ||
        document.querySelector('[role="menu"][data-state="open"]')
      ) {
        return;
      }
      /* The attachment viewer owns the keyboard the same way, and all of it:
         it answers ←, → and Esc itself, and an e or a u that fell through
         would archive or mark the letter under the picture. */
      if (attachmentViewerOpenRef.current) return;
      const composerOpen = composerRef.current !== null;
      if (composerOpen && event.key !== "Escape") return;

      if (event.key === "Escape") {
        if (composerOpen) {
          event.preventDefault();
          closeComposer(
            draftSyncRef.current ? isDraftSyncEmpty(draftSyncRef.current) : false,
          );
          return;
        }
        if (selectedThreadIdRef.current !== null && isSinglePaneMailViewport()) {
          event.preventDefault();
          closeReader();
          return;
        }
        if (searchQueryRef.current !== "") {
          event.preventDefault();
          changeSearchQuery("");
        }
        return;
      }

      if (
        event.key === "j" ||
        event.key === "k" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowUp"
      ) {
        // In unified mode the keyboard walks the flattened rendered order —
        // sections in order, collapsed remainders and a collapsed Seen
        // excluded — so j/k can never land on an invisible row.
        const unified = selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID;
        let items: readonly MailThreadListItem[];
        if (unified) {
          const state = unifiedStateRef.current;
          if (state.kind !== "ready") return;
          const accountsForSections =
            accountsStateRef.current.kind === "ready"
              ? accountsStateRef.current.accounts
              : [];
          items = visibleUnifiedItems(
            deriveUnifiedSections(
              hideDone(
                applyShownDecisions(
                  mergedDisplayItems(state.streams).items,
                  senderDecisionsRef.current,
                ),
                doneOverlayRef.current,
              ),
              accountsForSections,
              stickyOpenRef.current,
            ),
            unifiedExpandSnapshot(),
          );
        } else {
          const state = threadStateRef.current;
          if (state.kind !== "ready") return;
          const shown = shownRows(state.page.items);
          // A plain Inbox draws New senders first, so it walks them first.
          if (
            selectedMailboxIdRef.current === "inbox" &&
            selectedViewRef.current === null &&
            searchQueryRef.current.trim() === ""
          ) {
            const { waiting, rest } = splitNewSenders(shown);
            items = [...waiting, ...rest];
          } else {
            items = shown;
          }
        }
        if (items.length === 0) return;
        event.preventDefault();
        // One step per frame: key autorepeat fires faster than the reader can
        // load, so later repeats inside the same frame are swallowed (still
        // prevented, so a held arrow key cannot scroll the page underneath).
        if (keyNavFrameRef.current) return;
        keyNavFrameRef.current = true;
        window.requestAnimationFrame(() => {
          keyNavFrameRef.current = false;
        });
        const forward = event.key === "j" || event.key === "ArrowDown";
        const currentIndex = items.findIndex(
          (item) =>
            item.threadId === selectedThreadIdRef.current &&
            (!unified ||
              item.accountId === selectedThreadAccountIdRef.current),
        );
        const nextIndex =
          currentIndex === -1
            ? 0
            : Math.min(
                items.length - 1,
                Math.max(0, currentIndex + (forward ? 1 : -1)),
              );
        const next = items[nextIndex];
        if (
          next &&
          (next.threadId !== selectedThreadIdRef.current ||
            (unified &&
              next.accountId !== selectedThreadAccountIdRef.current))
        ) {
          void selectThread(next);
        }
        return;
      }

      if (event.key === "Enter") {
        if (selectedThreadIdRef.current === null) return;
        const pane = document.querySelector<HTMLElement>(
          "[data-mail-reader-scroll]",
        );
        if (!pane) return;
        event.preventDefault();
        pane.focus({ preventScroll: true });
        return;
      }

      if (event.key === "e" || event.key === "u" || event.key === "s") {
        const reader = readerStateRef.current;
        if (reader.kind !== "ready") return;
        const openThread = reader.detail.thread;
        const account = selectedMailAccount(
          accountsStateRef.current,
          openThread.accountId,
        );
        if (!account?.capabilities.threadMutations) return;
        if (event.key === "e") {
          // Outside the Inbox `e` is a toggle, Move to Inbox and then Archive,
          // so a held key's repeats would move the letter back and forth.
          if (event.repeat) return;
          const direct = directActionForMailbox(
            selectedMailboxIdRef.current,
            letterInInbox(reader.detail),
          );
          if (!direct) return;
          event.preventDefault();
          void mutateOpenThread(openThread, direct.action);
          return;
        }
        event.preventDefault();
        void mutateOpenThread(
          openThread,
          event.key === "u"
            ? "toggle-read"
            : openThread.starred
              ? "unstar"
              : "star",
        );
        return;
      }

      /* A accepts and B blocks: the open letter when one is open (j and k
         move the reader, not the focus, so a row pressed earlier can still
         hold it), else the New senders row the keyboard stands on. The open
         letter takes the reach its switch holds; a row decides for its own
         address. A held key decides once: the second decision would land on
         whatever the first one brought up next. */
      if (event.key === "a" || event.key === "b") {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        const target = waitingTargetForKey();
        if (target === null) return;
        event.preventDefault();
        decideSender(target.thread, event.key === "a" ? "accept" : "block", target.scope);
        return;
      }

      if (event.key === "c") {
        if (selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID) {
          const target = firstComposeAccount(accountsStateRef.current);
          if (!target) return;
          event.preventDefault();
          startCompose(target.accountId);
          return;
        }
        const accountId = selectedAccountIdRef.current;
        const account = accountId
          ? selectedMailAccount(accountsStateRef.current, accountId)
          : null;
        if (
          !accountId ||
          !account?.capabilities.compose ||
          !account.capabilities.send
        ) {
          return;
        }
        event.preventDefault();
        startCompose(accountId);
        return;
      }

      if (event.key === "/") {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Search mail"]',
        );
        if (!input) return;
        event.preventDefault();
        input.focus();
      }
    },
    [
      changeSearchQuery,
      closeComposer,
      closeReader,
      decideSender,
      mutateOpenThread,
      selectThread,
      shownRows,
      startCompose,
      waitingTargetForKey,
    ],
  );

  const handleMailKeyDownRef = useRef(handleMailKeyDown);
  useEffect(() => {
    handleMailKeyDownRef.current = handleMailKeyDown;
  }, [handleMailKeyDown]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) =>
      handleMailKeyDownRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Palette → Mail bridge. Commands route through the same handlers the nav
  // menu uses, behind the same capability gates its rows render against.
  useEffect(
    () =>
      onMailCommand((command) => {
        if (selectedAccountIdRef.current === UNIFIED_ACCOUNT_ID) {
          if (command === "compose") {
            const target = firstComposeAccount(accountsStateRef.current);
            if (target) startCompose(target.accountId);
            return;
          }
          // goto-* destinations are single-account surfaces: exit unified to
          // the last single account (or the first usable one) before routing.
          const snapshot = accountsStateRef.current;
          if (snapshot.kind !== "ready") return;
          const lastId = lastSingleAccountIdRef.current;
          const exitId =
            (lastId &&
            snapshot.accounts.some((account) => account.accountId === lastId)
              ? lastId
              : null) ??
            snapshot.accounts.find(
              (account) => account.status === "connected",
            )?.accountId ??
            snapshot.accounts[0]?.accountId ??
            null;
          if (!exitId) return;
          selectAccount(exitId);
        }
        const accountId = selectedAccountIdRef.current;
        const account = accountId
          ? selectedMailAccount(accountsStateRef.current, accountId)
          : null;
        if (!accountId || !account) return;
        if (command === "compose") {
          if (account.capabilities.compose && account.capabilities.send) {
            startCompose(accountId);
          }
          return;
        }
        if (command === "goto-drafts") {
          if (account.capabilities.compose) openDrafts();
          return;
        }
        if (command === "goto-inbox" || command === "goto-starred") {
          selectMailbox(command === "goto-inbox" ? "inbox" : "starred");
          return;
        }
        const view = MAIL_VIEW_COMMANDS[command];
        const item = mailSmartViewItems(account.capabilities.mailboxes).find(
          (candidate) => candidate.view === view,
        );
        if (item) selectView(item.mailboxId, item.view);
      }),
    [openDrafts, selectAccount, selectMailbox, selectView, startCompose],
  );

  /** THE COMPOSE ASK THAT ARRIVED BEFORE THIS SURFACE DID.
   *
   *  The New menu's Message row is drawn on every surface, so from a page or
   *  from Home the shell opens Mail and leaves an ask standing; a command
   *  event would have been shouted at a room nobody was in yet. The latch is
   *  taken the moment there are accounts to compose from, which is why the
   *  effect is keyed on `accountsState` and not on mount, and it is taken
   *  exactly once, because it is cleared before anything is opened.
   *
   *  What it then does is emit the command, so the unified branch, the
   *  capability gates and the toast for an account that cannot send are the
   *  ones the palette's Compose already goes through. One compose path. */
  useEffect(() => {
    const take = () => {
      if (!pendingComposeRequest()) return;
      if (accountsStateRef.current.kind !== "ready") return;
      clearComposeRequest();
      emitMailCommand("compose");
    };
    take();
    return subscribeComposeRequest(take);
  }, [accountsState]);

  if (accountsState.kind === "loading") {
    return <MailSurfaceSkeleton />;
  }

  if (accountsState.kind === "unavailable") {
    return (
      <MailSurfaceMessage
        title="Mail isn’t running"
        body="Brain’s mail service is a second container. Add it to your compose file to connect Gmail or IMAP. Notes work without it."
        actions={
          <>
            <Button type="button" onClick={() => void loadAccounts()}>
              Try again
            </Button>
            {/* `Button` has no `asChild`, so the link carries the ghost
                variant's classes from components/ui/button.tsx itself. */}
            <a
              href={`${PROJECT_URL}#install`}
              target="_blank"
              rel="noopener noreferrer"
              className="brain-touch-min rounded-md px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
            >
              How to add it
            </a>
          </>
        }
      />
    );
  }

  if (accountsState.kind === "error") {
    return (
      <MailSurfaceMessage
        title="Mail couldn’t load"
        body="Your accounts are still safe. Try loading them again or open Mail settings."
        actions={
          <>
            <Button type="button" onClick={() => void loadAccounts()}>
              Try again
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={(event) => onOpenSettings(event.currentTarget)}
            >
              Mail settings
            </Button>
          </>
        }
      />
    );
  }

  if (accountsState.accounts.length === 0) {
    return (
      <MailSurfaceMessage
        title="Mail"
        body="Connect Gmail or a custom-domain mailbox to start."
        actions={
          <Button
            type="button"
            onClick={(event) => onOpenSettings(event.currentTarget)}
          >
            Connect account
          </Button>
        }
      />
    );
  }

  const unifiedMode = selectedAccountId === UNIFIED_ACCOUNT_ID;
  const selectedAccount = unifiedMode
    ? null
    : (accountsState.accounts.find(
        (account) => account.accountId === selectedAccountId,
      ) ?? null);
  if (!unifiedMode && !selectedAccount) return <MailSurfaceSkeleton />;
  const composerAccount = composer
    ? accountsState.accounts.find((account) => account.accountId === composer.accountId)
    : null;
  // Where else the letter could go from: the composer draws its From switch
  // only when there are two or more of these.
  const sendableAccounts = accountsState.accounts.filter(
    (account) => account.capabilities.compose && account.capabilities.send,
  );
  // Compose in unified mode targets the first compose-capable account.
  const composeTarget = unifiedMode
    ? firstComposeAccount(accountsState)
    : selectedAccount;
  const readerThread =
    readerState.kind === "ready"
      ? readerState.detail.thread
      : readerState.kind === "idle"
        ? null
        : readerState.thread;
  // The reader always acts with the OPEN thread's account capabilities — in
  // unified mode that is never "the selected account", which does not exist.
  const readerCapabilities = unifiedMode
    ? ((readerThread &&
        accountsState.accounts.find(
          (account) => account.accountId === readerThread.accountId,
        )?.capabilities) ??
      NO_MAIL_CAPABILITIES)
    : (selectedAccount?.capabilities ?? NO_MAIL_CAPABILITIES);
  const selectedThreadKey =
    readerThread && selectedThreadId
      ? `${readerThread.accountId}:${readerThread.threadId}`
      : null;
  const unifiedMerged =
    unifiedMode && unifiedState.kind === "ready"
      ? mergedDisplayItems(unifiedState.streams)
      : null;
  const unifiedSections = unifiedMerged
    ? deriveUnifiedSections(
        hideDone(
          applyShownDecisions(unifiedMerged.items, senderDecisions),
          doneOverlay,
        ),
        accountsState.accounts,
        stickyOpen,
      )
    : null;
  /* NEW SENDERS IN ONE ACCOUNT. A plain Inbox draws the waiting letters as
     the same group the merged list draws, first, and the rest under it; a
     smart view, a search or another mailbox lists them as ordinary rows.
     Either way the decisions the reader has made are laid over the page. */
  const singleSectioned =
    !unifiedMode &&
    selectedMailboxId === "inbox" &&
    selectedView === null &&
    searchQuery.trim() === "";
  let listThreadState = threadState;
  let listWaiting: readonly MailThreadListItem[] = unifiedSections
    ? unifiedSections.newSenders.items
    : [];
  // A block's archive leaves the Inboxes and nowhere else, and so does what a
  // section's Done is holding out.
  const overlay = { inbox: unifiedMode || selectedMailboxId === "inbox" };
  if (!unifiedMode && threadState.kind === "ready") {
    const shown = hideDone(
      applyShownDecisions(threadState.page.items, senderDecisions, overlay),
      doneOverlay,
      overlay,
    );
    if (singleSectioned) {
      const split = splitNewSenders(shown);
      listWaiting = split.waiting;
      listThreadState = {
        kind: "ready",
        page: { ...threadState.page, items: split.rest },
      };
    } else if (shown !== threadState.page.items) {
      listThreadState = { kind: "ready", page: { ...threadState.page, items: shown } };
    }
  }
  const domainScopeFor = (domain: string) => domainScopeAllowed(senderScreen, domain);
  const shownReaderThread = readerThread
    ? (hideDone(
        applyShownDecisions([readerThread], senderDecisions, overlay),
        doneOverlay,
        overlay,
      )[0] ?? null)
    : null;
  const readerFrom = shownReaderThread ? waitsOn(shownReaderThread) : null;
  const readerDomain = readerFrom ? senderDomain(readerFrom.address) : "";
  const readerDomainScope = domainScopeFor(readerDomain);
  const readerWaiting =
    shownReaderThread && readerFrom
      ? {
          from: readerFrom,
          scope:
            readerDomainScope && readerScope?.key === flipRowKey(shownReaderThread)
              ? readerScope.scope
              : ("address" as const),
          domainScope: readerDomainScope,
          waitingAtDomain: waitingAtDomain(
            listWaiting.length > 0 ? listWaiting : [shownReaderThread],
            readerDomain,
          ),
          onScope: holdReaderScope,
          onDecide: decideOpenLetter,
        }
      : undefined;

  // Which pane owns the surface when only one fits (below `panes`). The
  // composer used to be a third occupant; it is a sheet over the whole window
  // now, so the pane keeps whatever it held and Esc returns to it.
  const singlePane = selectedThreadId ? "reader" : "list";
  // The badge only reports a count it can stand behind: the plain Inbox
  // list, no smart view, no search. Anything else renders nothing — no zero.
  // A letter a section's Done is holding out of that list is not counted.
  const inboxUnreadCount =
    !unifiedMode &&
    threadState.kind === "ready" &&
    selectedMailboxId === "inbox" &&
    selectedView === null &&
    searchQuery.trim() === "" &&
    "sync" in threadState.page
      ? hideDone(threadState.page.items, doneOverlay).filter((item) => item.unread)
          .length
      : null;
  /* ONE CONTROL, ONE OWNER, EVERY WIDTH AND EVERY MODE. The rail used to hold
     account and folder navigation from inside the shell sidebar, which made
     "is the rail on screen" a question the list head had to ask and answer
     twice — a duplicate pair of selects between 768 and 1023, and no switcher
     at all in focus mode. Neither symptom is reachable now, and neither is the
     cure: navigation has one owner, it lives in the head of the column it
     navigates, and the shell knows nothing about it. Built once here so the
     three columns that can hold the pane — the thread list, the merged list
     and the drafts list — wear the same object. */
  const nav = (
    <MailNav
      accounts={accountsState.accounts}
      selectedAccountId={
        selectedAccount ? selectedAccount.accountId : UNIFIED_ACCOUNT_ID
      }
      selectedMailboxId={selectedMailboxId}
      selectedView={selectedView}
      draftsOpen={draftsOpen}
      inboxUnreadCount={inboxUnreadCount}
      failedDraftCount={draftBadge.failed}
      submittingDraftCount={draftBadge.submitting}
      onSelectAccount={selectAccount}
      onSelectMailbox={selectMailbox}
      onSelectView={selectView}
      onOpenDrafts={openDrafts}
    />
  );
  // Compose has ONE place on this surface: the column's own toolbar pill, in
  // both modes and at every width. It used to be portalled into the sidebar
  // head as well, as the shell's accent circle, which put two controls for the
  // same action on one screen and made that circle mean something different in
  // mail than in notes — while ⌘⌥N, the shortcut written on it, went on making
  // pages. The circle is New page everywhere now. The merged list used to move
  // it once more, onto the account row's free right edge, because the toolbar
  // row there held nothing else; the nav pill fills that row in every mode, so
  // Compose sits at its right edge and never travels.
  //
  // THE SURFACE IS THE WINDOW, top to bottom. It used to subtract 52 for the
  // shell's mobile title row — a row that carried the word "Mail" and is not
  // drawn any more — and that 52 was the row's CONTENT only: the row is
  // `52 + safe-area-inset-top` tall, so on any phone with an inset the
  // surface stood ~59px taller than the space left for it and the whole mail
  // screen could be dragged up inside the shell's scroller. The reserve at
  // the foot is the mobile tab bar's (54 + the 8 inset, twice), so the last
  // row of a column can be scrolled clear of it.
  return (
    <div className="flex h-dvh min-h-0 w-full pt-[env(safe-area-inset-top,0px)] pb-[calc(70px+env(safe-area-inset-bottom))] md:pb-0">
      <div
        className={`${singlePane === "list" ? "flex" : "hidden"} min-h-0 w-full panes:flex panes:w-auto`}
      >
        {draftsOpen ? (
          <MailDraftsList
            state={draftsState}
            nav={nav}
            onRetry={() => void refreshDrafts()}
            onResume={(summary) => void resumeDraft(summary)}
            onDelete={(summary, invoker) => {
              draftDeleteInvokerRef.current = invoker;
              setConfirmDraftDelete(summary);
            }}
          />
        ) : unifiedMode ? (
          <MailUnifiedList
            accounts={accountsState.accounts}
            nav={nav}
            state={unifiedState}
            sections={unifiedSections}
            hasMore={unifiedMerged ? !unifiedMerged.exhausted : false}
            expand={unifiedExpand}
            selectedThreadKey={selectedThreadKey}
            exitFades={mutating}
            unserved={unifiedUnserved}
            onToggleExpand={toggleUnifiedExpand}
            onSelectThread={(thread) => void selectThread(thread)}
            onCompose={
              composeTarget
                ? () => startCompose(composeTarget.accountId)
                : undefined
            }
            onLoadMore={() => void loadMoreUnified()}
            onRetryStream={(accountId) => void retryUnifiedStream(accountId)}
            onSectionDone={markSectionDone}
            onOpenSettings={onOpenSettings}
            onDecideSender={decideSender}
            domainScope={domainScopeFor}
          />
        ) : selectedAccount ? (
          <MailThreadList
            accounts={accountsState.accounts}
            nav={nav}
            selectedAccountId={selectedAccount.accountId}
            selectedMailboxId={selectedMailboxId}
            selectedView={selectedView}
            threadSort={threadSort}
            selectedThreadId={selectedThreadId}
            searchQuery={searchQuery}
            state={listThreadState}
            syncing={syncing}
            newSenders={
              singleSectioned && listWaiting.length > 0 ? (
                <NewSendersSection
                  items={listWaiting}
                  avatars={false}
                  reduce={reduceMotion}
                  entrance={false}
                  selectedThreadKey={selectedThreadKey}
                  onSelectThread={(thread) => void selectThread(thread)}
                  onDecideSender={decideSender}
                  domainScope={domainScopeFor}
                />
              ) : undefined
            }
            onSelectSort={selectSort}
            onSelectThread={(thread) => void selectThread(thread)}
            onSearchQueryChange={changeSearchQuery}
            onCompose={() => startCompose(selectedAccount.accountId)}
            onOpenDrafts={
              selectedAccount.capabilities.compose ? openDrafts : undefined
            }
            failedDraftCount={draftBadge.failed}
            submittingDraftCount={draftBadge.submitting}
            onSync={() => void sync()}
            onRetry={() => {
              const query = searchQueryRef.current;
              if (query.trim() !== "") {
                void loadSearch(selectedAccount.accountId, selectedMailboxId, query);
              } else {
                void loadThreads(
                  selectedAccount.accountId,
                  selectedMailboxId,
                  selectedViewRef.current,
                  threadSortRef.current,
                );
              }
            }}
            onLoadMore={(cursor) => void loadMore(cursor)}
            onOpenSettings={onOpenSettings}
          />
        ) : null}
      </div>

      {/* The reader pane. It declares no ground: the canvas is the only
          ground (v3), so an empty pane and a loading one stand on the same
          canvas the column beside them stands on, and no plate edge runs down
          the gutter. The one opaque plane left on this surface is the message
          sheet inside the reader — foreign HTML needs its white page, our own
          markup does not. The composer used to swap in here; it is a sheet
          over the whole window now (below), so the open message stays put
          under it and is what Esc comes back to. */}
      <div
        className={`${singlePane === "list" ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 panes:flex`}
      >
        <MailReader
          state={readerState}
          mutating={mutating}
          onBack={closeReader}
          onRetry={retryReader}
          onReply={startReply}
          onReplyAll={startReplyAll}
          onForward={(detail) => void startForward(detail)}
          mailboxId={selectedMailboxId}
          capabilities={readerCapabilities}
          onAction={(thread, action) => void mutateOpenThread(thread, action)}
          contentClient={client}
          onAttachmentViewerOpenChange={onAttachmentViewerOpenChange}
          waiting={readerWaiting}
        />
      </div>

      {/* THE COMPOSE SHEET. A portal at the body over the whole window; the
          shell under it is inert (`onSheetOpenChange`). The presence keeps
          the sheet mounted through its exit, so the surface's state can go
          null the moment a send lands or a draft closes and the sheet still
          gets to leave the way it was dismissed. */}
      <AnimatePresence>
        {composer && composerAccount && (
          <MailComposer
            key={composer.draft.idempotencyKey}
            account={composerAccount}
            accounts={sendableAccounts}
            initialDraft={composer.draft}
            sending={composer.sending}
            sendError={composer.error}
            sendBlocked={composer.blocked}
            sendErrorSettings={composer.errorSettings}
            onOpenSettings={(invoker) => onOpenSettings(invoker, composerAccount.accountId)}
            saveStatus={saveStatus}
            onCancel={(leaving) => {
              const empty = draftSyncRef.current
                ? isDraftSyncEmpty(draftSyncRef.current)
                : false;
              const blocked = composerRef.current?.blocked ?? false;
              closeComposer(empty);
              // A blocked sheet's letter may already be on its way, files and
              // all: the warning is what it leaves with, and nothing about
              // files, which would read as an invitation to attach them again.
              if (blocked) {
                onToast?.(DRAFT_KEPT_CHECK_SENT, { urgent: true });
                return;
              }
              // A kept draft is the words: the files lived only on the sheet.
              // With no words there is no draft, and the files are all that
              // went, which is what is said.
              if (leaving.withFiles) {
                onToast?.(empty ? FILES_DISCARDED : DRAFT_WITHOUT_FILES, { urgent: true });
              }
            }}
            onDiscard={discardComposer}
            onDraftChange={onComposerDraftChange}
            onRetrySave={retryDraftSave}
            onSend={(input) => void send(input)}
            onSwitchAccount={switchComposerAccount}
          />
        )}
      </AnimatePresence>

      {/* Deleting a stored draft is the one thing on this surface that cannot
          be taken back, so it is the one thing that asks. The browser used to
          ask for us — a system alert with the origin in its title, no theme,
          no typography, and nothing said about what disappears. */}
      <ConfirmDialog
        open={confirmDraftDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDraftDelete(null);
        }}
        title="Delete this draft?"
        description={draftDeleteDescription(confirmDraftDelete ?? undefined)}
        confirmLabel="Delete draft"
        returnFocus={() => draftDeleteInvokerRef.current}
        onConfirm={() => {
          const target = confirmDraftDelete;
          setConfirmDraftDelete(null);
          if (target) void deleteDraftFromList(target);
        }}
      />
    </div>
  );
}

/** Names what leaves: the draft's own subject when it has one, and where it
 *  is being removed from. A confirmation that does not say what disappears is
 *  a speed bump, not a question. */
function draftDeleteDescription(summary?: MailDraftSummary): string {
  const subject = summary?.subject.trim();
  return subject
    ? `“${subject}” will be removed from Drafts. This can’t be undone.`
    : "This draft will be removed from Drafts. This can’t be undone.";
}

function MailSurfaceSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading Mail"
      className="mx-auto w-full max-w-[720px] px-5 pt-20 md:px-6 md:pt-24"
    >
      <Skeleton className="h-8 w-28" />
      <Skeleton className="mt-4 h-4 w-[min(100%,360px)]" />
    </div>
  );
}

function MailSurfaceMessage({
  title,
  body,
  actions,
}: {
  title: string;
  body: string;
  actions: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby="mail-surface-title"
      className="mx-auto w-full max-w-[720px] px-5 pt-20 md:px-6 md:pt-24"
    >
      <h1
        id="mail-surface-title"
        className="text-[28px] font-semibold tracking-[-0.02em] text-ink"
      >
        {title}
      </h1>
      <p className="mt-3 max-w-[52ch] text-[14px] leading-relaxed text-ink-2">
        {body}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-2">{actions}</div>
    </section>
  );
}

const MAIL_VIEW_COMMANDS = {
  "goto-unread": "unread",
  "goto-lists": "lists",
  "goto-people": "people",
  "goto-attachments": "attachments",
} as const satisfies Partial<Record<string, MailThreadView>>;

/** Same breakpoint the layout uses: below `panes` the reader replaces the
 *  list, so Escape is the only thing besides Back that returns to it. The
 *  question is whether three panes fit, not whether the viewport is a phone —
 *  see `--breakpoint-panes` in globals.css for where 1160 comes from. */
function isSinglePaneMailViewport(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return !window.matchMedia(`(min-width: ${MAIL_PANES_MIN_WIDTH}px)`).matches;
}

/** No request can be pending before the browser has run, so the server render
 *  is always the empty answer. Named rather than inline so the snapshot passed
 *  to `useSyncExternalStore` is one stable reference. */
function pendingOpenThreadServerSnapshot(): MailOpenRequest | null {
  return null;
}

/** Whether `request` is still the one request `mail-surface-client` holds. A
 *  second press before the first is answered replaces the slot rather than
 *  queuing behind it, so a fetch started for the first must not clear a slot
 *  that now belongs to the second, or open a letter nobody asked for anymore. */
function isPendingRequest(request: MailOpenRequest): boolean {
  const pending = pendingOpenThread();
  return (
    pending !== null &&
    pending.accountId === request.accountId &&
    pending.threadId === request.threadId &&
    pending.mailboxId === request.mailboxId
  );
}

/** The requested thread, if it is in the list the column is showing.
 *
 *  Which list that is depends on the mode, and asking the other one would be a
 *  trap: the unified streams survive a move into a single account, so a letter
 *  found there while the column stands in one address would be opened against
 *  a list it is not in and the reader would never leave "loading".
 */
function loadedThread(
  request: MailOpenRequest,
  selectedAccountId: string | null,
  threadState: MailThreadListState,
  unifiedState: UnifiedState,
): MailThreadListItem | null {
  const matches = (item: MailThreadListItem) =>
    item.accountId === request.accountId && item.threadId === request.threadId;
  if (selectedAccountId === UNIFIED_ACCOUNT_ID) {
    if (unifiedState.kind !== "ready") return null;
    for (const stream of unifiedState.streams) {
      const found = stream.items.find(matches);
      if (found) return found;
    }
    return null;
  }
  if (selectedAccountId !== request.accountId) return null;
  if (threadState.kind !== "ready") return null;
  return threadState.page.items.find(matches) ?? null;
}

function selectedMailAccount(
  state: AccountsState,
  accountId: string,
): PublicMailAccount | null {
  if (state.kind !== "ready") return null;
  return (
    state.accounts.find((account) => account.accountId === accountId) ?? null
  );
}

/**
 * Accounts that can back a unified stream: they must list threads and carry an
 * inbox. Connected accounts get a fetch; reauth accounts render a degraded
 * inline notice instead.
 */
function unifiedStreamAccounts(
  state: AccountsState,
): readonly PublicMailAccount[] {
  if (state.kind !== "ready") return [];
  return state.accounts.filter(
    (account) =>
      account.capabilities.listThreads &&
      account.capabilities.mailboxes.includes("inbox"),
  );
}

/** Compose in unified mode targets the first compose-capable account. */
function firstComposeAccount(state: AccountsState): PublicMailAccount | null {
  if (state.kind !== "ready") return null;
  return (
    state.accounts.find(
      (account) => account.capabilities.compose && account.capabilities.send,
    ) ?? null
  );
}

/** Reader fallback while no thread is open in unified mode: no actions. */
const NO_MAIL_CAPABILITIES: MailAccountCapabilities = {
  mailboxes: ["inbox"],
  listThreads: false,
  sync: false,
  headerPreview: false,
  messageBodies: false,
  threadMutations: false,
  compose: false,
  send: false,
  reply: false,
};

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomUuidV4(): string {
  const cryptoObj = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === "function") return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return (
    `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-` +
    `${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
  );
}

function createDraftId(): string {
  return `draft-${randomUuidV4()}`;
}

function createMutationId(): string {
  return `draft-mutation-${randomUuidV4()}`;
}

function createSendOperationId(): string {
  return `send-${randomUuidV4()}`;
}

function draftBadgeCounts(
  drafts: readonly MailDraftSummary[],
): DraftBadgeCounts {
  let failed = 0;
  let submitting = 0;
  for (const draft of drafts) {
    if (draft.state === "failed") failed += 1;
    else if (draft.state === "submitting") submitting += 1;
  }
  return { failed, submitting };
}

/** 5s, 10s, 20s … doubling toward a three-minute ceiling between polls. */
function sendPollDelayMs(attempt: number): number {
  return Math.min(SEND_POLL_BASE_DELAY_MS * 2 ** attempt, SEND_POLL_MAX_DELAY_MS);
}

/**
 * Sort is a per-account, per-mailbox preference. View is deliberately not
 * persisted — it is a destination in the nav menu, not a mode.
 */
function readStoredThreadSort(
  accountId: string,
  mailboxId: MailSystemMailbox,
): MailThreadSort {
  if (typeof window === "undefined") return "date";
  try {
    const value = window.localStorage.getItem(
      `${THREAD_SORT_PREFIX}${accountId}:${mailboxId}`,
    );
    return value === "unread" || value === "sender" || value === "size"
      ? value
      : "date";
  } catch {
    return "date";
  }
}

/**
 * Which unified sections are open — an external store on `sessionStorage`.
 *
 * WHERE, and why there. Bundling is an answer to the pile in front of you,
 * not a preference. The answer has to survive everything inside one sitting:
 * switching to one account and back (which unmounts the list), opening a
 * thread, reloading the page you were reading on. It should NOT survive to
 * tomorrow, when the sixty-four newsletters are a different sixty-four and
 * the collapsed default is the right question again. `sessionStorage` is
 * exactly that lifetime, and this is an external store rather than component
 * state because the state outlives the component that shows it.
 *
 * The snapshot is cached against the raw string so `useSyncExternalStore` can
 * compare it by identity, and the server snapshot is always the collapsed
 * default, so hydration renders what the server rendered.
 */
const UNIFIED_EXPAND_KEY = "brain.mail.unified-expand";

const unifiedExpandListeners = new Set<() => void>();
let unifiedExpandCache: UnifiedExpandState = UNIFIED_EXPAND_COLLAPSED;
let unifiedExpandCacheRaw: string | null = null;

function parseUnifiedExpand(raw: string | null): UnifiedExpandState {
  if (raw === null) return UNIFIED_EXPAND_COLLAPSED;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return UNIFIED_EXPAND_COLLAPSED;
    }
    const record = parsed as Partial<Record<UnifiedExpandKey, unknown>>;
    return {
      people: record.people === true,
      notifications: record.notifications === true,
      newsletters: record.newsletters === true,
      seen: record.seen === true,
    };
  } catch {
    return UNIFIED_EXPAND_COLLAPSED;
  }
}

function subscribeUnifiedExpand(listener: () => void): () => void {
  unifiedExpandListeners.add(listener);
  return () => {
    unifiedExpandListeners.delete(listener);
  };
}

function unifiedExpandSnapshot(): UnifiedExpandState {
  if (typeof window === "undefined") return UNIFIED_EXPAND_COLLAPSED;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(UNIFIED_EXPAND_KEY);
  } catch {
    // Storage disabled — the cache is the whole truth for this session.
    return unifiedExpandCache;
  }
  if (raw !== unifiedExpandCacheRaw) {
    unifiedExpandCacheRaw = raw;
    unifiedExpandCache = parseUnifiedExpand(raw);
  }
  return unifiedExpandCache;
}

function unifiedExpandServerSnapshot(): UnifiedExpandState {
  return UNIFIED_EXPAND_COLLAPSED;
}

function writeUnifiedExpand(state: UnifiedExpandState): void {
  unifiedExpandCache = state;
  const raw = JSON.stringify(state);
  unifiedExpandCacheRaw = raw;
  try {
    window.sessionStorage.setItem(UNIFIED_EXPAND_KEY, raw);
  } catch {
    // Storage may be disabled. The cache still carries the session.
  }
  for (const listener of unifiedExpandListeners) listener();
}

function writeStoredThreadSort(
  accountId: string,
  mailboxId: MailSystemMailbox,
  sort: MailThreadSort,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = `${THREAD_SORT_PREFIX}${accountId}:${mailboxId}`;
    if (sort === "date") window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, sort);
  } catch {
    // Storage may be disabled. The in-memory sort still applies this session.
  }
}

function writeDraftRecovery(
  sync: DraftSync,
  fields: MailComposerFields,
): boolean {
  if (typeof window === "undefined") return false;
  const recovery: DraftRecovery = {
    version: 1,
    draftId: sync.draftId,
    accountId: sync.accountId,
    intent: sync.createInput.intent,
    fields,
    updatedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(
      `${DRAFT_RECOVERY_PREFIX}${sync.draftId}`,
      JSON.stringify(recovery),
    );
    return true;
  } catch {
    // Quota/privacy-mode failure falls back to normal autosave + keepalive.
    return false;
  }
}

function clearConfirmedDraftRecovery(
  sync: DraftSync,
  savedFields: MailComposerFields,
): void {
  clearDraftRecoveryIfMatches(sync.draftId, savedFields);
  if (
    sync.recoverySourceDraftId &&
    (!sync.pendingFields || draftFieldsEqual(sync.pendingFields, savedFields))
  ) {
    clearDraftRecovery(sync.recoverySourceDraftId);
    sync.recoverySourceDraftId = null;
  }
}

function clearDraftRecovery(draftId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${DRAFT_RECOVERY_PREFIX}${draftId}`);
  } catch {
    // Storage may be disabled. There is nothing else to clear locally.
  }
}

function clearDraftRecoveryIfMatches(
  draftId: string,
  savedFields: MailComposerFields,
): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(
      `${DRAFT_RECOVERY_PREFIX}${draftId}`,
    );
    if (!raw) return;
    const recovery = readDraftRecovery(raw);
    if (recovery && draftFieldsEqual(recovery.fields, savedFields)) {
      clearDraftRecovery(draftId);
    }
  } catch {
    // A malformed or unavailable store must never interrupt server autosave.
  }
}

function clearDraftRecoveriesForRemovedAccounts(
  activeAccountIds: ReadonlySet<string>,
): void {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(DRAFT_RECOVERY_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const raw = window.localStorage.getItem(key);
      const recovery = raw ? readDraftRecovery(raw) : null;
      if (!recovery || !activeAccountIds.has(recovery.accountId)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage cleanup is best-effort and must not block account loading.
  }
}

function latestDraftRecoveryAcrossAccounts(
  accounts: readonly PublicMailAccount[],
): DraftRecovery | null {
  let latest: DraftRecovery | null = null;
  for (const account of accounts) {
    const recovery = latestDraftRecovery(account.accountId);
    if (recovery && (!latest || recovery.updatedAt > latest.updatedAt)) {
      latest = recovery;
    }
  }
  return latest;
}

function latestDraftRecovery(accountId: string): DraftRecovery | null {
  if (typeof window === "undefined") return null;
  let latest: DraftRecovery | null = null;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(DRAFT_RECOVERY_PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const recovery = readDraftRecovery(raw);
      if (
        recovery?.accountId === accountId &&
        (!latest || recovery.updatedAt > latest.updatedAt)
      ) {
        latest = recovery;
      }
    }
  } catch {
    return null;
  }
  return latest;
}

function readDraftRecovery(raw: string): DraftRecovery | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      typeof record.draftId !== "string" ||
      !record.draftId.startsWith("draft-") ||
      typeof record.accountId !== "string" ||
      typeof record.updatedAt !== "number" ||
      !Number.isFinite(record.updatedAt) ||
      !record.fields ||
      typeof record.fields !== "object" ||
      Array.isArray(record.fields)
    ) {
      return null;
    }
    const fields = record.fields as Record<string, unknown>;
    if (
      typeof fields.to !== "string" ||
      typeof fields.cc !== "string" ||
      typeof fields.bcc !== "string" ||
      typeof fields.subject !== "string" ||
      typeof fields.text !== "string" ||
      fields.text.length > 1_048_576
    ) {
      return null;
    }
    const intent = readDraftRecoveryIntent(record.intent);
    if (!intent) return null;
    return {
      version: 1,
      draftId: record.draftId,
      accountId: record.accountId,
      intent,
      fields: {
        to: fields.to,
        cc: fields.cc,
        bcc: fields.bcc,
        subject: fields.subject,
        text: fields.text,
      },
      updatedAt: record.updatedAt,
    };
  } catch {
    return null;
  }
}

function readDraftRecoveryIntent(value: unknown): MailDraftIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "compose") return { kind: "compose" };
  if (
    (record.kind === "reply" ||
      record.kind === "reply_all" ||
      record.kind === "forward") &&
    typeof record.sourceMessageId === "string"
  ) {
    return { kind: record.kind, sourceMessageId: record.sourceMessageId };
  }
  return null;
}

function fieldsFromCreateInput(input: MailDraftCreateInput): MailComposerFields {
  return {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
  };
}

function draftFieldsEqual(a: MailComposerFields, b: MailComposerFields): boolean {
  return (
    a.to === b.to &&
    a.cc === b.cc &&
    a.bcc === b.bcc &&
    a.subject === b.subject &&
    a.text === b.text
  );
}

function isDraftSyncEmpty(sync: DraftSync): boolean {
  const fields = sync.pendingFields ?? sync.savedFields;
  return !(
    fields.to.trim() ||
    fields.cc.trim() ||
    fields.bcc.trim() ||
    fields.subject.trim() ||
    fields.text.trim()
  );
}

function composerModeFromIntent(
  intent: MailDraftIntent,
): MailComposerDraft["mode"] {
  if (intent.kind === "reply") return "reply";
  if (intent.kind === "reply_all") return "replyAll";
  if (intent.kind === "forward") return "forward";
  return "compose";
}

/**
 * Split a send failure into "the writer can fix this and try again" and "Brain
 * cannot tell whether the message went out".
 *
 * Only the second kind may block the composer, because blocking exists to stop
 * a duplicate delivery — not to punish a rejected request. A request the
 * service refused before the atomic handoff (any 4xx) left no submission
 * behind, so the draft is intact and Send stays live. An idempotency conflict
 * is the exception: it means a submission with that send identity already
 * exists, so the message may already be on its way.
 */
function classifySendFailure(error: unknown): {
  readonly blocked: boolean;
  readonly message: string;
  readonly settings?: boolean;
} {
  if (!(error instanceof MailApiError) || error.status >= 500) {
    return {
      blocked: true,
      message: "Couldn’t confirm delivery. Check Sent before trying again.",
    };
  }
  if (
    error.code === "mail_draft_idempotency_conflict" ||
    error.code === "mail_send_idempotency_conflict"
  ) {
    return {
      blocked: true,
      message: "This message may already be on its way. Check Sent first.",
    };
  }
  return {
    blocked: false,
    // A 413 is the body's size whatever its code: the draft door cuts a body
    // off by its bytes before it reads a code into it, and only files can
    // carry a send that far.
    message: sendFailureMessage(
      error.status === 413 ? "mail_send_attachments_too_large" : error.code,
    ),
    settings:
      error.code === "mail_draft_account_reauth_required" ||
      error.code === "mail_send_account_reauth_required",
  };
}

/**
 * One code, one sentence. `mail_draft_request_invalid` covers separators,
 * address syntax, recipient count, duplicates, the 998-byte subject cap and the
 * body cap behind a single code, so its copy names all of them rather than
 * guessing which one tripped.
 */
function sendFailureMessage(code: string | null): string {
  switch (code) {
    case "mail_draft_request_invalid":
    case "mail_send_request_invalid":
      return "This message wasn’t accepted. Check the recipients, the subject length, and the message length.";
    case "mail_draft_revision_conflict":
      return "This draft changed somewhere else. Brain loaded the newest version — read it over, then send.";
    case "mail_draft_state_invalid":
      return "This message is already being sent.";
    case "mail_draft_quota_exceeded":
      return "You’ve hit the saved-draft limit. Delete a draft, then send.";
    case "mail_draft_account_reauth_required":
    case "mail_send_account_reauth_required":
      return "This account needs to be reconnected in Settings.";
    case "mail_draft_capability_unavailable":
      return "This account can’t send mail.";
    case "mail_draft_not_found":
    case "mail_send_reply_target_not_found":
    case "mail_draft_reply_target_not_found":
      return "Brain couldn’t find this draft. Reopen it from Drafts.";
    case "mail_send_rate_limited":
      return "Too many sends right now. Wait a moment, then try again.";
    case "mail_send_attachments_too_large":
      return ATTACHMENT_REFUSALS.tooLarge;
    case "mail_send_attachments_invalid":
      return "One of these files can’t be sent. Remove it and try again.";
    default:
      return "This message wasn’t sent. Try again.";
  }
}

function formatDraftAddresses(
  values: readonly { readonly address: string }[],
): string {
  return values.map((value) => value.address).join(", ");
}

function isComposerSubmission(
  composer: ComposerState | null,
  input: Pick<MailSendInput, "accountId" | "idempotencyKey">,
): composer is ComposerState {
  return (
    composer?.accountId === input.accountId &&
    composer.draft.idempotencyKey === input.idempotencyKey
  );
}

/**
 * A fresh page one folded into the single-account list on screen, the way the
 * merge folds one into a stream: the fresh window replaces the head, and the
 * rows the list holds below the fresh window's last row stay, less any the
 * window lists itself. Without that, every refresh (now one per change,
 * echoes of the owner's own actions included) threw away the rows Load more
 * had brought in. A fresh page with no cursor is the whole list and stands
 * alone, and so does one that leaves nothing below it.
 *
 * The anchor is the last row of the window that the list also holds, found
 * from the window's end, not the last row it lists anywhere: a deep thread
 * answered moves to the head, and anchoring on it would drop every row
 * between. A window with no row the list holds stands alone, or rows that
 * left the list elsewhere would stay below it for good.
 *
 * The cursor: an Inbox cursor names the active generation and outlives an
 * incremental sync, so the one that loads on from the kept rows stays. A
 * cursor into any other mailbox carries the history id its snapshot was read
 * at, and the service calls it stale after the next advance, so the fresh
 * page's cursor is taken instead and the next Load more walks past the rows
 * the list already holds. A list loaded to the end keeps its missing cursor:
 * it holds every row, and a cursor would bring back a Load more with nothing
 * behind it.
 *
 * `drop` is a thread the list shows only because a hold kept it, released
 * and read under the Unread view: it leaves the kept rows too.
 */
function pageWithLoadedDepth(
  fresh: MailThreadListPage,
  current: MailThreadListPage,
  options: { readonly keepCursor: boolean; readonly drop: string | null },
): MailThreadListPage {
  if (fresh.nextCursor === null) return fresh;
  const listed = new Set(fresh.items.map(unifiedThreadKey));
  let anchor = -1;
  for (let at = fresh.items.length - 1; at >= 0 && anchor === -1; at -= 1) {
    const key = unifiedThreadKey(fresh.items[at]!);
    anchor = current.items.findIndex((item) => unifiedThreadKey(item) === key);
  }
  if (anchor === -1) return fresh;
  const below = current.items
    .slice(anchor + 1)
    .filter(
      (item) =>
        !listed.has(unifiedThreadKey(item)) && unifiedThreadKey(item) !== options.drop,
    );
  if (below.length === 0) return fresh;
  const items = [...fresh.items, ...below];
  return options.keepCursor || current.nextCursor === null
    ? { ...fresh, items, nextCursor: current.nextCursor }
    : { ...fresh, items };
}

/**
 * Presentation-only splice for silent single-account page commits while the
 * open thread is held (auto-read under the unread view / unread-first sort):
 * the fresh server page wins everywhere except the held row, which keeps its
 * local item and list position. Server truth is untouched — the next unheld
 * commit settles the row for real. A null threadId means no hold.
 */
function pageWithHeldThread(
  fresh: MailThreadListPage,
  current: MailThreadListPage,
  held: {
    readonly accountId: string | null;
    readonly threadId: string | null;
  },
): MailThreadListPage {
  if (held.threadId === null) return fresh;
  const heldIndex = current.items.findIndex(
    (item) =>
      item.threadId === held.threadId && item.accountId === held.accountId,
  );
  if (heldIndex === -1) return fresh;
  const heldItem = current.items[heldIndex]!;
  const items = fresh.items.filter(
    (item) =>
      !(item.threadId === held.threadId && item.accountId === held.accountId),
  );
  items.splice(Math.min(heldIndex, items.length), 0, heldItem);
  return { ...fresh, items };
}

/** A conversation moved into or out of the Inbox, as the provider moves it:
 *  every message at once. */
function withLetterInInbox(
  detail: MailThreadDetail,
  inInbox: boolean,
): MailThreadDetail {
  return {
    ...detail,
    messages: detail.messages.map((message) => ({ ...message, inInbox })),
  };
}

/** A read or star action's answer, applied to the row it was taken on. */
function withReadOrStar(
  item: MailThreadListItem,
  action: Extract<MailReaderAction, "toggle-read" | "star" | "unstar">,
): MailThreadListItem {
  if (action === "toggle-read") return { ...item, unread: !item.unread };
  if (action === "star") return { ...item, starred: true };
  return { ...item, starred: false };
}

function threadMutationInput(
  thread: MailThreadListItem,
  action: MailReaderAction,
): MailThreadMutationInput & { readonly threadId: string } {
  const base = {
    accountId: thread.accountId,
    threadId: thread.threadId,
  };
  if (action === "toggle-read") return { ...base, read: thread.unread };
  if (action === "archive") return { ...base, archive: true };
  if (action === "move-to-inbox") return { ...base, archive: false };
  if (action === "trash") return { ...base, trash: true };
  if (action === "restore") return { ...base, restore: true };
  if (action === "mark-spam") return { ...base, spam: true };
  if (action === "unmark-spam") return { ...base, spam: false };
  if (action === "star") return { ...base, starred: true };
  return { ...base, starred: false };
}

/**
 * The account's server has no mailbox for this action. It is a refusal and not
 * an outage: the same request will be refused for the same reason on the next
 * thread, and on this one tomorrow.
 */
function isMutationUnsupported(error: unknown): boolean {
  return (
    error instanceof MailApiError &&
    error.code === "mail_thread_mutation_unsupported"
  );
}

/**
 * The service's `mail_thread_stale`: the letter is no longer what the list
 * said — moved by another client, or its mailbox re-keyed — so the mutation
 * that named it has nothing to act on. It arrived as "unavailable" once and
 * was answered with "Try again", which could never have helped.
 */
function isThreadStale(error: unknown): boolean {
  return error instanceof MailApiError && error.code === "mail_thread_stale";
}

/**
 * What a mutation a section's Done sent and lost says about the rest of its
 * run (`DoneFailure`). A 409 that names no folder is the account's server
 * answering for every thread on it, and a request the client's own clock
 * ended (`MAIL_MUTATION_TIMEOUT_MS`) is an account the next request would sit
 * on just as long, so both close the account. Anything else is that thread's
 * alone.
 */
function sectionDoneFailure(error: unknown): DoneFailure {
  if (isThreadStale(error)) return "changed";
  if (isMutationUnsupported(error)) return "refused";
  if (isMailMutationTimeout(error)) return "silent";
  return "failed";
}

/** The service's `mail_sync_in_progress` on a list read: a sync is moving the
 *  account's cache, and the same account answers again a moment later. */
function isSyncHold(error: unknown): boolean {
  return error instanceof MailApiError && error.code === "mail_sync_in_progress";
}

/** Waits `ms`, or less if `signal` aborts first; the caller reads the signal
 *  after. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * A refusal and a failure read the same to the user unless the copy separates
 * them. A 409 says the account's server has no mailbox for this action, so it
 * will not work later either and "try again" would be a lie.
 */
function threadActionFailure(error: unknown): string {
  if (isMutationUnsupported(error)) return "Your mail server has no folder for that.";
  if (isThreadStale(error)) {
    return "That conversation changed on the server. Refresh Mail to see it.";
  }
  return "Mail action failed. Try again.";
}

/**
 * A refused New senders decision, said at once. Two refusals are the
 * service's reasons and will not change on a second press, so they say what
 * the reason is; everything else is the same press worth making again.
 */
function senderDecisionFailure(
  error: unknown,
  verdict: SenderVerdict,
  name: string,
): string {
  if (error instanceof MailApiError && error.code === "mail_sender_own_address") {
    return `${name} is one of your own addresses.`;
  }
  if (
    error instanceof MailApiError &&
    error.code === "mail_sender_domain_scope_refused"
  ) {
    return `Everyone at ${name} can’t be decided on at once.`;
  }
  return `Couldn’t ${verdict} ${name}. Try again.`;
}

function threadActionConfirmation(action: Exclude<MailReaderAction, "toggle-read">): string {
  if (action === "archive") return "Conversation archived";
  if (action === "move-to-inbox") return "Moved to Inbox";
  if (action === "trash") return "Conversation moved to trash";
  if (action === "restore") return "Conversation restored";
  if (action === "mark-spam") return "Conversation marked as spam";
  if (action === "unmark-spam") return "Conversation removed from spam";
  if (action === "star") return "Conversation starred";
  return "Star removed";
}
