"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { DUR, EASE_OUT, pageTransition } from "@/lib/motion";
import { isEditableEventTarget } from "@/lib/editable-target";
import {
  MailComposer,
  type MailComposerDraft,
  type MailComposerFields,
  type MailComposerSaveStatus,
} from "./mail-composer";
import { MailDraftsList, type MailDraftsState } from "./mail-drafts";
import {
  directActionForMailbox,
  MailReader,
  waitForContentPoll,
  type MailReaderAction,
  type MailReaderState,
} from "./mail-reader";
import { onMailCommand } from "./mail-commands";
import {
  defaultMailSurfaceClient,
  isListedDraft,
  isMailMutationTimeout,
  MailApiError,
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
import {
  MailThreadList,
  mailSmartViewItems,
  type MailThreadListPage,
  type MailThreadListState,
} from "./mail-thread-list";
import {
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
  type UnifiedExpandKey,
  type UnifiedExpandState,
  type UnifiedState,
  type UnifiedStickyOpen,
  type UnifiedStream,
} from "./mail-unified";
import { MailUnifiedList } from "./mail-unified-list";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Skeleton, type ToastOptions } from "./ui/primitives";
import type {
  MailThreadMutationInput,
  MailThreadPage,
  MailThreadSort,
  MailThreadView,
} from "@/lib/mail/message-types";
import { normalizeMailSearchQueryText } from "@/lib/mail/search-query";
import { readableMailBody } from "@/lib/mail/reader-content";
import {
  deriveReplyAllRecipients,
  deriveReplyRecipients,
  forwardedPlainText,
  forwardedSubject,
} from "@/lib/mail/reply-forward";

type AccountsState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly accounts: readonly PublicMailAccount[] }
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
 * How long the Done toast stands ONCE THE RUN HAS SETTLED, before it takes its
 * Undo away. Long, next to the 2.2s a plain message gets, because this one has
 * to be READ before it can be acted on: a reader who pressed Done is looking
 * at a section that just emptied, not at the bottom of the window.
 *
 * It is the only window Done arms. The press-time pill has none — see
 * `markSectionDone`.
 */
const SECTION_DONE_UNDO_MS = 10_000;

/**
 * One thread a Done moved, and whether Done is the thing that marked it read.
 * The undo needs both: archive has an inverse, and so does the read flag, but
 * only for the threads whose read state this action actually changed.
 */
type SectionDoneEntry = {
  readonly thread: MailThreadListItem;
  readonly wasUnread: boolean;
};

/**
 * One Done, from the press to the last request.
 *
 * It exists because the section leaves the column at the gesture and the way
 * back is offered from that same second — so Undo can arrive while the loop is
 * still sending. The honest answer to Undo at second two is to STOP sending
 * and reverse what has gone, not to make the reader wait out a hundred and
 * twenty-eight round trips for a window that is ten seconds long. `aborted` is
 * how Undo says so, `settled` is how it waits for the loop to drop the lock,
 * and the two lists are what it reverses: `moved` needs the provider, `stayed`
 * only needs the rows put back.
 */
type SectionDoneRun = {
  /**
   * Set by Undo. The loop reads it at the top of every iteration; a request
   * already in flight is left to land (or to run into the client's deadline)
   * rather than cut, because a cut request has an outcome nobody knows and
   * the reversal below has to know exactly what left.
   */
  aborted: boolean;
  /** True while the loop holds the mutation lock. */
  active: boolean;
  /** What left the inbox, and whether Done is what marked it read. */
  readonly moved: SectionDoneEntry[];
  /** What never left: a provider refusal, or the abort catching up. */
  readonly stayed: MailThreadListItem[];
  /**
   * What the server no longer recognises (`mail_thread_stale`): moved by
   * another client, or its mailbox re-keyed under the list. Not "stayed put"
   * — it is not where the column had it — so it is not put back, and there
   * is nothing of this run's on it for Undo to reverse.
   */
  readonly changed: MailThreadListItem[];
  /**
   * The pill's id, shared by every sentence this run and its undo make: the
   * press-time report, its correction, Undo's own "working" pill and Undo's
   * report are one message said again, and each takes the pill from the last.
   */
  readonly toastId: string;
  /**
   * Resolves when the loop has exited and released the lock. Undo waits on it
   * before reversing, and it is what the press-time pill's lifetime is: the
   * pill stands with no window until this resolves, then the report re-posts
   * the same sentence with the ordinary one.
   */
  readonly settled: Promise<void>;
};

/** "1 thread" / "9 threads" — the toast counts out loud, so it has to agree. */
function threadWord(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

export function MailSurface({
  onOpenSettings,
  onAccountStatusChange,
  onToast,
  refreshToken,
  client = defaultMailSurfaceClient,
}: {
  /** Open Mail settings; `accountId` deep-links that account's details
   *  (/settings/mail?account=<id>) — the reauth affordances pass it. */
  onOpenSettings: (invoker: HTMLElement, accountId?: string) => void;
  onAccountStatusChange?: (configured: boolean) => void;
  onToast?: (title: string, options?: ToastOptions) => void;
  refreshToken?: number;
  client?: MailSurfaceClient;
}) {
  const reduce = useReducedMotion();
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

  const commitThreadState = useCallback((next: MailThreadListState) => {
    threadStateRef.current = next;
    setThreadState(next);
  }, []);

  const commitUnifiedState = useCallback((next: UnifiedState) => {
    unifiedStateRef.current = next;
    setUnifiedState(next);
  }, []);

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
            await client.deleteDraft({
              accountId: sync.accountId,
              draftId: sync.draftId,
              mutationId: createMutationId(),
              expectedRevision: sync.revision,
            });
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
    [client, persistDraftStep],
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
    }) => {
      const existing = draftSyncRef.current;
      if (existing) closeComposer(isDraftSyncEmpty(existing));
      const draftId = createDraftId();
      const idempotencyKey = createIdempotencyKey();
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
    [closeComposer, enqueueDraftSync],
  );

  const resumeComposer = useCallback(
    (draft: MailDraft) => {
      const existing = draftSyncRef.current;
      if (existing) closeComposer(isDraftSyncEmpty(existing));
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
    [closeComposer],
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
    (operationId: string) => {
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
            onToast?.("Message didn’t send. It’s in Drafts.");
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

  useEffect(() => {
    readerStateRef.current = readerState;
  }, [readerState]);

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
      const sync = draftSyncRef.current;
      if (!sync || sync.closed || sync.frozen) return;
      // `keepalive` lets the browser finish this bounded request after the tab
      // starts unloading. Reuse the pending mutation id so a simultaneous
      // autosave and pagehide retry are idempotent rather than two writes.
      void persistDraftStep(sync, { keepalive: true }).catch(() => undefined);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
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
      } catch {
        if (signal?.aborted || accountsRequestEpochRef.current !== requestEpoch) return;
        if (accountsStateRef.current.kind !== "ready") {
          const error = { kind: "error" } as const;
          accountsStateRef.current = error;
          setAccountsState(error);
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
      visibleLoading = true,
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
        commitThreadState({ kind: "invalid-search" });
        return;
      }
      if (visibleLoading) commitThreadState({ kind: "loading" });
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
          commitThreadState({ kind: "error" });
        }
      }
    },
    [client, commitThreadState],
  );

  const refreshThreadsSilently = useCallback(
    async (
      accountId: string,
      mailboxId: MailSystemMailbox,
      signal: AbortSignal,
    ) => {
      if (
        signal.aborted ||
        mutationLockRef.current ||
        searchQueryRef.current.trim() !== "" ||
        selectedAccountIdRef.current !== accountId ||
        selectedMailboxIdRef.current !== mailboxId ||
        threadStateRef.current.kind !== "ready"
      ) {
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
          listEpochRef.current !== listEpoch ||
          selectedAccountIdRef.current !== accountId ||
          selectedMailboxIdRef.current !== mailboxId ||
          selectedViewRef.current !== view ||
          threadSortRef.current !== sort
        ) {
          return;
        }
        const current = threadStateRef.current;
        if (current.kind === "ready") {
          // While the open thread is held (auto-read under the unread view or
          // unread-first sort), the fresh page wins everywhere except that
          // row: it keeps its local item and position until the hold releases
          // on selection change or reader close.
          commitThreadState({
            kind: "ready",
            page: pageWithHeldThread(page, current.page, {
              accountId: selectedThreadAccountIdRef.current,
              threadId: singleHoldRef.current
                ? selectedThreadIdRef.current
                : null,
            }),
          });
        }
      } catch {
        // The visible list stays usable. Explicit Sync and Try again own errors.
      }
    },
    [client, commitThreadState],
  );

  /**
   * A single list the reader switched into while a Done was still landing
   * archives on that account. The list loaded at the switch, before the last
   * request landed, so it can still show a row the server has since
   * archived — and the next silent refresh is up to a minute away. Asked
   * again as soon as it is ready; a switch elsewhere drops the request.
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
    void refreshThreadsSilently(
      pending.accountId,
      pending.mailboxId,
      new AbortController().signal,
    );
  }, [refreshThreadsSilently]);
  useEffect(() => {
    refreshAfterRun();
  }, [refreshAfterRun, threadState]);

  /**
   * Page-1 loads for every eligible account in parallel. One account failing
   * degrades to a per-stream notice — the rest still merge. The first-sync
   * kick is deliberately skipped in unified mode: background sync owns
   * freshness for non-focused accounts.
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
      const results = await Promise.allSettled(
        connected.map((account) =>
          client.listThreads(
            { accountId: account.accountId, limit: UNIFIED_PAGE_SIZE },
            signal,
          ),
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
        if (result.status === "rejected") return { ...base, status: "error" };
        return {
          ...base,
          items: result.value.items,
          nextCursor: result.value.nextCursor,
          status: "ready",
          sync: result.value.sync,
        };
      });
      commitUnifiedState({ kind: "ready", streams });
    },
    [client, commitUnifiedState],
  );

  /** Fetch the next page of exactly the streams that starve the horizon. */
  const loadMoreUnified = useCallback(async () => {
    if (mutationLockRef.current) return;
    if (selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID) return;
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
    const results = await Promise.allSettled(
      starved.map((stream) =>
        client.listThreads({
          accountId: stream.accountId,
          cursor: stream.nextCursor as string,
          limit: UNIFIED_PAGE_SIZE,
        }),
      ),
    );
    if (
      listEpochRef.current !== listEpoch ||
      selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID
    ) {
      return;
    }
    const current = unifiedStateRef.current;
    if (current.kind !== "ready") return;
    const byAccount = new Map<string, PromiseSettledResult<MailThreadPage>>();
    starved.forEach((stream, index) => {
      byAccount.set(stream.accountId, results[index]!);
    });
    commitUnifiedState({
      kind: "ready",
      streams: current.streams.map((stream) => {
        const result = byAccount.get(stream.accountId);
        if (!result) return stream;
        if (result.status === "rejected") {
          // A stale cursor or an outage degrades this stream to a notice with
          // retry; its loaded rows keep merging and no longer hold a horizon.
          return { ...stream, nextCursor: null, status: "error" as const };
        }
        const seen = new Set(stream.items.map(unifiedThreadKey));
        return {
          ...stream,
          items: [
            ...stream.items,
            ...result.value.items.filter(
              (item) => !seen.has(unifiedThreadKey(item)),
            ),
          ],
          nextCursor: result.value.nextCursor,
          status: "ready" as const,
          sync: result.value.sync,
        };
      }),
    });
  }, [client, commitUnifiedState]);

  /**
   * The 60s tick in unified mode refreshes page-1 windows per account and
   * reconciles, never rebuilding: a rebuild would discard loaded depth and
   * scroll position every minute for no correctness gain — new mail sorts to
   * the top, so page 1 captures arrivals.
   */
  const refreshUnifiedSilently = useCallback(
    async (signal: AbortSignal) => {
      const state = unifiedStateRef.current;
      if (
        signal.aborted ||
        mutationLockRef.current ||
        selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID ||
        state.kind !== "ready"
      ) {
        return;
      }
      const refreshable = state.streams.filter(
        (stream) => stream.status === "ready" || stream.status === "error",
      );
      if (refreshable.length === 0) return;
      const listEpoch = ++listEpochRef.current;
      const results = await Promise.allSettled(
        refreshable.map((stream) =>
          client.listThreads(
            { accountId: stream.accountId, limit: UNIFIED_PAGE_SIZE },
            signal,
          ),
        ),
      );
      if (
        signal.aborted ||
        listEpochRef.current !== listEpoch ||
        selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID
      ) {
        return;
      }
      const current = unifiedStateRef.current;
      if (current.kind !== "ready") return;
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
    [client, commitUnifiedState],
  );

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
        void loadSearch(accountId, mailboxId, query, controller.signal, false);
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

    const stopInterval = () => {
      if (interval !== null) clearInterval(interval);
      interval = null;
    };
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      // The same tick keeps the Drafts badge honest, so a send that failed in
      // the durable outbox surfaces within a minute even after a reload.
      if (account.capabilities.compose) void refreshDraftBadge(selectedAccountId);
      if (requestRunning) return;
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
      });
    };
    const startInterval = () => {
      if (interval === null) interval = setInterval(refresh, 60_000);
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
    };

    if (document.visibilityState === "visible") startInterval();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
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

  // The unified sibling of the single-account 60s tick: visibility-gated, one
  // request generation in flight, aborted the moment the tab hides.
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

    const stopInterval = () => {
      if (interval !== null) clearInterval(interval);
      interval = null;
    };
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (requestRunning) return;
      const generation = ++requestGeneration;
      const controller = new AbortController();
      requestController = controller;
      requestRunning = true;
      void refreshUnifiedSilently(controller.signal).finally(() => {
        if (generation !== requestGeneration) return;
        requestRunning = false;
        requestController = null;
      });
    };
    const startInterval = () => {
      if (interval === null) interval = setInterval(refresh, 60_000);
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
    };

    if (document.visibilityState === "visible") startInterval();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
      );
    }
  }, [clearStickyOpen, refreshThreadsSilently]);

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
      const account = selectedMailAccount(
        accountsStateRef.current,
        input.accountId,
      );
      if (!account?.capabilities.send) {
        onToast?.("Sending isn’t available for this account yet.");
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
      try {
        const result = await client.sendDraft({
          accountId: sync.accountId,
          draftId: sync.draftId,
          mutationId: createMutationId(),
          expectedRevision: sync.revision,
          sendIdempotencyKey: randomUuidV4(),
          sendOperationId: createSendOperationId(),
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
          if (result.status !== "sent") watchSendOperation(result.operationId);
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
   * Non-removing mutation for the held open thread (single-account unread
   * view / unread-first sort). The server PATCH fires exactly as everywhere
   * else — server truth stays immediate — but the page-1 refetch is
   * suppressed: refetching would drop the row from the unread view or
   * re-sort it away while the reader still shows it. The row and the reader
   * header are patched in place (the unread dot clears, position holds); the
   * list settles through the release refetch when the selection moves on or
   * the reader closes. No timers.
   */
  const updateThreadHeld = useCallback(
    async (
      thread: MailThreadListItem,
      action: Extract<MailReaderAction, "toggle-read" | "star" | "unstar">,
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
        const patchItem = (item: MailThreadListItem): MailThreadListItem => {
          if (action === "toggle-read") return { ...item, unread: !item.unread };
          if (action === "star") return { ...item, starred: true };
          return { ...item, starred: false };
        };
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
        const reader = readerStateRef.current;
        if (
          reader.kind === "ready" &&
          reader.detail.thread.accountId === accountId &&
          reader.detail.thread.threadId === threadId
        ) {
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
    [client, commitThreadState, onToast],
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
            if (action !== "toggle-read") {
              onToast?.(threadActionConfirmation(action));
            }
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
        if (!refreshedThread) {
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
    [clearStickyOpen, client, commitThreadState, onToast],
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
      if (
        singleHoldRef.current &&
        (action === "toggle-read" || action === "star" || action === "unstar") &&
        selectedThreadIdRef.current === thread.threadId &&
        selectedThreadAccountIdRef.current === thread.accountId
      ) {
        return updateThreadHeld(thread, action);
      }
      return updateThread(thread, action);
    },
    [updateThread, updateThreadHeld, updateUnifiedThread],
  );

  /**
   * Take a set of threads out of the merged list in ONE commit, and close the
   * reader if it is holding one of them.
   *
   * `applyUnifiedThreadPatch` does this a row at a time, which is right for a
   * row the reader acted on. A section is not sixty-four acts.
   */
  const dropUnifiedThreads = useCallback(
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
        streams: removeStreamItems(state.streams, items),
      });
      const openThread = selectedThreadIdRef.current;
      const openAccount = selectedThreadAccountIdRef.current;
      if (
        openThread !== null &&
        items.some(
          (item) =>
            item.threadId === openThread && item.accountId === openAccount,
        )
      ) {
        selectedThreadIdRef.current = null;
        selectedThreadAccountIdRef.current = null;
        setSelectedThreadId(null);
        setReaderState({ kind: "idle" });
        clearStickyOpen();
      }
    },
    [clearStickyOpen, commitUnifiedState],
  );

  /** The exact inverse, and the same single commit. */
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

  /**
   * Undo of one Done: everything it moved comes back to the inbox, everything
   * it marked read goes back to unread, and everything the loop had not
   * reached simply comes back to the column.
   *
   * It stops the loop first. `aborted` is read at the top of every iteration,
   * so the run drops the lock at its next boundary and `settled` is when that
   * happened — the undo can then take the lock the ordinary way. Whatever was
   * still queued never leaves at all, which is the cheapest possible reversal
   * and the reason Undo is worth offering during the loop rather than after.
   *
   * The rows return in ONE commit, before the first request, for the same
   * reason they left in one: an undo reverses a single gesture and should look
   * like a single gesture. The provider work then runs to the end whatever the
   * view is doing — mail is mail, and a reader who pressed Undo and then
   * switched account still meant it — and anything the provider refuses is
   * taken back out of the column at the end.
   */
  const undoSectionDone = useCallback(
    async (run: SectionDoneRun) => {
      run.aborted = true;
      await run.settled;
      if (mutationLockRef.current) {
        onToast?.("Finish the current mail action first", { urgent: true });
        return;
      }
      const entries = [...run.moved];
      const never = [...run.stayed];
      if (entries.length === 0 && never.length === 0) return;
      mutationLockRef.current = true;
      setMutating(true);
      putBackUnifiedThreads([
        ...entries.map((entry) => entry.thread),
        ...never,
      ]);
      /* Mirror of Done's press. The rows are back in one commit and the
         provider work is going out one request at a time — on a slow account
         that is ten seconds — so a pill says so under the SAME id: it takes
         the one whose Undo was just pressed, has no window and no way back
         of its own, and the report below replaces it when the last request
         lands. Without it the column said "back" and the pills said nothing
         until the finish. Nothing to post when no request is owed. */
      if (entries.length > 0) {
        onToast?.("Putting back…", {
          icon: "inbox-linear",
          subtitle: `${threadWord(entries.length)} on the way back`,
          durationMs: null,
          id: run.toastId,
        });
      }
      const refused: MailThreadListItem[] = [];
      /* `mail_thread_stale` on the way back: the letter is no longer the one
         this run archived — another client moved it, or its mailbox was
         re-keyed. It is not "still archived" and it is not back; the refresh
         will say where it is. */
      const changed: MailThreadListItem[] = [];
      try {
        for (const entry of entries) {
          const key = {
            accountId: entry.thread.accountId,
            threadId: entry.thread.threadId,
          };
          try {
            await client.updateThread({ ...key, archive: false });
          } catch (error) {
            (isThreadStale(error) ? changed : refused).push(entry.thread);
            continue;
          }
          if (entry.wasUnread) {
            try {
              await client.updateThread({ ...key, read: false });
            } catch {
              // Back in the inbox is the half the reader asked for; the dot
              // returns on the next refresh if this call did not land.
            }
          }
        }
      } finally {
        mutationLockRef.current = false;
        setMutating(false);
      }
      dropUnifiedThreads([...refused, ...changed]);
      /* The count is what came BACK from the archive. The rows that never
         left were put on the column above with no request, and counting them
         as restored said "40 threads restored" over a run that had moved
         five — the same lie in the other direction as a receipt. */
      const asked = entries.length;
      const back = asked - refused.length - changed.length;
      if (asked === 0) {
        onToast?.("Back in your inbox", {
          icon: "inbox-linear",
          subtitle: "Nothing had left yet",
          id: run.toastId,
        });
        return;
      }
      if (back === 0) {
        onToast?.("Couldn’t put anything back", {
          icon: "danger-triangle-linear",
          // "Try again" is offered only where it can help. A letter the
          // server no longer recognises answers a second press the same way.
          subtitle:
            refused.length === 0
              ? "Your mail changed on the server. Refresh Mail to see it."
              : "Your mail is where the archive left it. Try again.",
          id: run.toastId,
        });
        return;
      }
      onToast?.(
        back === asked ? "Back in your inbox" : `Put back ${back} of ${asked}`,
        {
          icon: "inbox-linear",
          subtitle:
            back === asked
              ? `${threadWord(back)} restored`
              : [
                  ...(refused.length === 0
                    ? []
                    : [`${refused.length} stayed archived`]),
                  ...(changed.length === 0
                    ? []
                    : [`${changed.length} changed on the server`]),
                ].join(", "),
          id: run.toastId,
        },
      );
    },
    [client, dropUnifiedThreads, onToast, putBackUnifiedThreads],
  );

  /**
   * "Done" over one whole section: every thread in it leaves the inbox.
   *
   * **The section goes at the press, in one commit, before a single request.**
   * It used to empty row by row as the loop landed, and the toast carrying the
   * Undo appeared only after the last thread — on sixty-four newsletters that
   * is the protection arriving half a minute after the gesture that needed it,
   * long after the reader has looked away, and an always-drawn destructive
   * control is only defensible because that protection is there. So the column
   * answers the press immediately and the requests follow. What the loop then
   * fails to move comes back, and the message corrects itself in place.
   *
   * The count in that first message is a statement about the COLUMN, which is
   * true when it is made: this many letters just left the list. It is not a
   * receipt from the provider, and when the provider disagrees the rows return
   * and the same message says so ("2 archived, 1 stayed put").
   *
   * **The pill's lifetime is the run's, not a number computed from the count.**
   * It is posted with no window at the press and stands until `run.settled`
   * resolves; the report then says the same sentence again under the same id
   * with the ordinary ten seconds. `run.settled` already existed for Undo to
   * wait on, and holding the pill to it is exact where predicting a duration
   * from a thread count was a guess in both directions.
   *
   * **The sentence does not count the run out loud, and that is deliberate.**
   * Forty threads are eighty sequential requests and the pill is the only
   * thing on screen that knows they are happening, so a live "12 of 40" is
   * tempting. Three things are against it. The pill is one `role="status"`
   * with `aria-atomic`, so a ticking number is the whole message re-announced
   * once per thread — the pill would get noisier for a screen reader than it
   * is quiet for anyone else. The number would be a provider receipt inside
   * the one sentence that is deliberately a statement about the column, and a
   * line cannot hold both registers (the same argument that keeps "archived"
   * out of it). And it changes no decision: the pill's one action is Undo,
   * which is live at every value of that counter and does the same thing at
   * each — abort the rest, reverse what has gone. What the reader actually
   * needed was not a number but an answer to "is this stuck", and that is the
   * ring's absence and then its arrival, not a count.
   *
   * Archive is not read — Gmail’s archive drops the INBOX label and touches
   * nothing else — so Done sends both mutations, archive first. That order is
   * the one that fails safely: a failed archive leaves the thread exactly
   * where it was, unread and in its section, while a read that fails after a
   * successful archive costs nothing a reader can see, because the thread is
   * out of the inbox either way and `wasUnread` still carries what the undo
   * needs.
   *
   * A failing thread does not stop the loop. Clearing sixty-four newsletters
   * and stopping at the fourth would be the worst of both — most of the pile
   * still there and no account of which — so every failure is counted, its
   * thread is put back, and the message says the number out loud.
   *
   * A REFUSED thread stops its account. A 409 is the account's server saying
   * it has no folder for this, which is as true of the next thread as of this
   * one, so carrying on buys nothing but one login per thread and a report
   * that could never have said anything else. The account is closed for the
   * rest of the run and the reason is named in the report.
   *
   * A thread on an account that reports no thread mutations at all
   * (`threadMutations` false) is not one of those failures — it never leaves.
   * It used to be filtered out and forgotten, which in a mixed unified inbox
   * meant the label promised fourteen, eleven went, the report counted eleven
   * and three rows sat in the column with nothing said about them. Unlike a
   * rollback that never corrects itself. So the split is explicit: `pending`
   * is what Done will try, `blocked` is what it will not, the header counts
   * `pending` before the press, and every report names `blocked` after it. A
   * section with nothing archivable in it draws no Done at all, so the spoken
   * refusal below it is the guard for the race where the capability changes
   * under a button already on screen.
   *
   * The lock is taken once for the whole loop; every iteration re-checks the
   * epoch and the mode, so an account switch or a mode change stops it, and a
   * second Done is refused OUT LOUD rather than silently (`undoSectionDone`
   * has always answered that condition in words; this is the same sentence).
   *
   * **It stays taken for the whole loop, and forty threads is minutes of it.**
   * That is a real cost — every other mail action answers "Finish the current
   * mail action first" until the last request lands — and it is NOT this
   * function's to fix. The lock's length is the run's length, and the run is
   * eighty sequential round trips because each mutation is its own request.
   * Releasing it between threads would not shorten anything and would break
   * what it guards: a second Done could interleave into this one's `moved` and
   * `stayed`, and Undo, which waits on `run.settled` and then takes the lock
   * itself, assumes one owner. The run gets shorter when the mutations stop
   * being one-at-a-time — a batch through the mail service's private HTTP
   * surface, deliberately deferred — and the lock gets shorter with it. Until
   * then it is long on purpose.
   */
  const markSectionDone = useCallback(
    async (items: readonly MailThreadListItem[], label: string) => {
      if (mutationLockRef.current) {
        onToast?.("Finish the current mail action first", { urgent: true });
        return;
      }
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
      mutationLockRef.current = true;
      const listEpoch = ++listEpochRef.current;
      setMutating(true);
      /* The press-time message and its correction are ONE sentence: the id
         lets the second take the pill from the first instead of queueing
         behind its own undo. Undo's two sentences wear it too. */
      const toastId = `mail-section-done:${listEpoch}`;
      let settle: () => void = () => {};
      const run: SectionDoneRun = {
        aborted: false,
        active: true,
        moved: [],
        stayed: [],
        changed: [],
        toastId,
        settled: new Promise<void>((resolve) => {
          settle = resolve;
        }),
      };
      /* Refuse rather than spend the way back when the lock is held by some
         other mail action — the toast keeps standing and the reader can press
         again. A lock held by this run’s own loop is the abort path, not a
         conflict. The answer is the run's own settling: the shell keeps the
         pill up, its button out of reach and reading "Undoing…", until the
         loop has dropped the lock — which is when the reversal can begin. A
         pill taken down at the press looked spent over a run that was still
         sending, and once the loop hung on one request there was nothing
         left on screen to press. */
      const undo = (): boolean | Promise<void> => {
        if (mutationLockRef.current && !run.active) return false;
        void undoSectionDone(run);
        return run.settled;
      };

      /* What the loop will never try, and why. It is named in every report
         this run makes, because a row that stays behind with nothing said
         about it never corrects itself — unlike a rollback, which does. It
         says LEAVE, not archive: this clause rides beside "out of your
         inbox", which is the column's fact in the column's words, and one
         sentence cannot hold both that and the provider's verb. */
      const held =
        blocked.length === 0 ? [] : [`${blocked.length} can’t leave`];

      /* The press-time sentence, and the same sentence again when the loop is
         done. Only the window differs: the first has NONE and stands until the
         loop reports, the second is the ordinary ten seconds counted from the
         moment the last request landed. */
      const cleared = (durationMs: number | null): void => {
        onToast?.(
          blocked.length === 0 ? `${label} cleared` : `${label} partly cleared`,
          {
            icon: "check-linear",
            /* The column's fact in the column's words. "Archived" is the
               provider's verb and this sentence is not a receipt from it. */
            subtitle: [
              `${threadWord(pending.length)} out of your inbox`,
              ...held,
            ].join(", "),
            actionLabel: "Undo",
            pendingLabel: "Undoing…",
            onAction: undo,
            durationMs,
            id: toastId,
          },
        );
      };

      dropUnifiedThreads(pending);
      /* No window, and so no ring: the pill stands until the loop below
         resolves `run.settled` and the report re-arms the plain ten seconds.
         The window used to be predicted from the count — ten seconds plus six
         a thread — which was wrong twice over. Too short, because a thread is
         up to two mutations and each may spend the service's whole request
         budget, so the estimate could expire mid-run and take the way back
         away from work still going out. And too long: forty threads armed four
         minutes, the ring crawled a pixel a second, and a countdown that does
         not visibly count reads as a frozen pill — which is how the owner met
         it. A ring is a promise of a deadline. There is no deadline until the
         last request lands, so until then the pill makes no promise and wears
         no ring (DESIGN.md §13: the icon slot is the ring's host, and a pill
         with nothing to count wears none). The ring APPEARING is the finish
         line, and it drains an honest ten seconds from there. */
      cleared(null);

      /* An account whose server has no folder for the action answers 409, and
         it will answer 409 for every other thread on it. Carrying on is one
         more login per thread for one more refusal each, ending in a "14
         stayed put" that could never have said anything else. So the first
         refusal closes that account for this run, and the report says why. */
      const refused = new Set<string>();
      /* An account whose server did not answer inside the client's deadline
         (`MAIL_MUTATION_TIMEOUT_MS`). Not a bad minute either: the next
         request to it would sit just as long, and forty of those is ten
         minutes of a held lock. Closed for the run like a refusal, and named
         apart from one, because "no folder for it" would be a lie. */
      const silent = new Set<string>();
      /* The reader left All inboxes (or the list was replaced under the run)
         while it was still sending. What was in flight lands and counts;
         nothing after it goes. The report names this, since "stayed put"
         alone reads as a refusal that never happened. */
      let interrupted = false;
      const stale = () =>
        listEpochRef.current !== listEpoch ||
        selectedAccountIdRef.current !== UNIFIED_ACCOUNT_ID;
      try {
        for (const item of pending) {
          if (
            run.aborted ||
            refused.has(item.accountId) ||
            silent.has(item.accountId)
          ) {
            run.stayed.push(item);
            continue;
          }
          if (stale()) {
            interrupted = true;
            run.stayed.push(item);
            continue;
          }
          try {
            await client.updateThread({
              accountId: item.accountId,
              threadId: item.threadId,
              archive: true,
            });
          } catch (error) {
            if (isThreadStale(error)) {
              run.changed.push(item);
              continue;
            }
            if (isMutationUnsupported(error)) refused.add(item.accountId);
            else if (isMailMutationTimeout(error)) silent.add(item.accountId);
            run.stayed.push(item);
            continue;
          }
          if (item.unread) {
            try {
              await client.updateThread({
                accountId: item.accountId,
                threadId: item.threadId,
                read: true,
              });
            } catch (error) {
              // See above: out of the inbox either way. A server that went
              // quiet between the two still closes the account for the run.
              if (isMailMutationTimeout(error)) silent.add(item.accountId);
            }
          }
          run.moved.push({ thread: item, wasUnread: item.unread });
        }
      } finally {
        run.active = false;
        mutationLockRef.current = false;
        setMutating(false);
        settle();
      }
      /* The run landed archives on an account whose single list the reader
         is now looking at, loaded before those landed. Ask for it again. */
      if (interrupted) {
        const accountId = selectedAccountIdRef.current;
        if (
          accountId !== null &&
          accountId !== UNIFIED_ACCOUNT_ID &&
          run.moved.some((entry) => entry.thread.accountId === accountId)
        ) {
          refreshAfterRunRef.current = {
            accountId,
            mailboxId: selectedMailboxIdRef.current,
          };
          refreshAfterRun();
        }
      }
      // An abort means Undo is already on its way and owns both the restore
      // and the report.
      if (run.aborted) return;
      /* Why the threads that stayed are never coming back on their own. A
         refusal is the server's folder layout, not a bad minute, so "try
         again" would be a lie and the reader is owed the actual reason. */
      const missing = [
        ...(refused.size === 0
          ? []
          : [
              refused.size === 1
                ? "that account has no folder for it"
                : "those accounts have no folder for it",
            ]),
        ...(silent.size === 0
          ? []
          : [
              silent.size === 1
                ? "that account stopped answering"
                : "those accounts stopped answering",
            ]),
        ...(interrupted ? ["stopped when you left All inboxes"] : []),
      ];
      // Everything the loop tried moved. The press-time sentence was exactly
      // right — blocked threads and all — so it is said again unchanged, and
      // the only thing that moves is the window: ten seconds from HERE, where
      // the work ended, rather than from a press that may be a minute old.
      if (run.stayed.length === 0 && run.changed.length === 0) {
        cleared(SECTION_DONE_UNDO_MS);
        return;
      }
      putBackUnifiedThreads(run.stayed);
      /* What did not leave, in the column's words. A letter the server no
         longer recognises is named as such: it is not in the column and it
         is not archived, and "stayed put" would claim the first. */
      const short = [
        ...(run.stayed.length === 0
          ? []
          : [`${threadWord(run.stayed.length)} stayed put`]),
        ...(run.changed.length === 0
          ? []
          : [`${run.changed.length} changed on the server`]),
      ];
      if (run.moved.length === 0) {
        onToast?.(`Couldn’t clear ${label}`, {
          icon: "danger-triangle-linear",
          subtitle: [...short, ...missing, ...held].join(", "),
          id: toastId,
        });
        return;
      }
      onToast?.(`${label} partly cleared`, {
        icon: "check-linear",
        subtitle: [
          `${run.moved.length} archived`,
          ...(run.stayed.length === 0 ? [] : [`${run.stayed.length} stayed put`]),
          ...(run.changed.length === 0
            ? []
            : [`${run.changed.length} changed on the server`]),
          ...missing,
          ...held,
        ].join(", "),
        actionLabel: "Undo",
        pendingLabel: "Undoing…",
        onAction: undo,
        durationMs: SECTION_DONE_UNDO_MS,
        id: toastId,
      });
    },
    [
      client,
      dropUnifiedThreads,
      onToast,
      putBackUnifiedThreads,
      refreshAfterRun,
      undoSectionDone,
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
    // left a letter opened during a bulk Done unread with nothing said.
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
        cursor,
        limit: 50,
        ...(view ? { view } : {}),
        ...(sort !== "date" ? { sort } : {}),
      };
      const basePage = baseState.page;
      const listEpoch = ++listEpochRef.current;
      try {
        const next: MailThreadListPage =
          "scope" in basePage
            ? await client.searchThreads({
                accountId,
                mailboxId,
                query,
                cursor,
                limit: 50,
              })
            : mailboxId === "inbox"
            ? await client.listThreads(listInput)
            : await client.listMailboxThreads({ ...listInput, mailboxId });
        if (
          selectedAccountIdRef.current !== accountId ||
          selectedMailboxIdRef.current !== mailboxId ||
          selectedViewRef.current !== view ||
          threadSortRef.current !== sort ||
          searchQueryRef.current !== query ||
          listEpochRef.current !== listEpoch
        ) {
          return;
        }
        const current = threadStateRef.current;
        if (
          current.kind !== "ready" ||
          current.page !== basePage ||
          current.page.nextCursor !== cursor
        ) {
          return;
        }
        const seen = new Set(basePage.items.map((item) => item.threadId));
        commitThreadState({
          kind: "ready",
          page: {
            ...next,
            items: [
              ...basePage.items,
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
      if (isEditableEventTarget(event.target)) return;
      /* A question on top owns the keyboard. Radix dismisses its dialog from
         a document listener and this window listener runs after it, with the
         dialog still in the DOM because React has not re-rendered yet — so
         without this one Escape answered "Discard this draft?" AND threw the
         composer away behind it, which is the opposite of what Cancel
         means. */
      if (document.querySelector('[role="alertdialog"]')) return;
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
              mergedDisplayItems(state.streams).items,
              accountsForSections,
              stickyOpenRef.current,
            ),
            unifiedExpandSnapshot(),
          );
        } else {
          const state = threadStateRef.current;
          if (state.kind !== "ready") return;
          items = state.page.items;
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
          const direct = directActionForMailbox(selectedMailboxIdRef.current);
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
      mutateOpenThread,
      selectThread,
      startCompose,
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

  if (accountsState.kind === "loading") {
    return <MailSurfaceSkeleton />;
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
    ? deriveUnifiedSections(unifiedMerged.items, accountsState.accounts, stickyOpen)
    : null;

  // Which pane owns the surface when only one fits (below `panes`). Three
  // things can occupy it and the composer is one of them, so it is named
  // ahead of the open thread: composing over an open message replaces it.
  const singlePane = composer ? "composer" : selectedThreadId ? "reader" : "list";
  // The badge only reports a count it can stand behind: the plain Inbox
  // list, no smart view, no search. Anything else renders nothing — no zero.
  const inboxUnreadCount =
    !unifiedMode &&
    threadState.kind === "ready" &&
    selectedMailboxId === "inbox" &&
    selectedView === null &&
    searchQuery.trim() === "" &&
    "sync" in threadState.page
      ? threadState.page.items.filter((item) => item.unread).length
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
            onToggleExpand={toggleUnifiedExpand}
            onSelectThread={(thread) => void selectThread(thread)}
            onCompose={
              composeTarget
                ? () => startCompose(composeTarget.accountId)
                : undefined
            }
            onLoadMore={() => void loadMoreUnified()}
            onRetryStream={(accountId) => void retryUnifiedStream(accountId)}
            onSectionDone={(items, label) => void markSectionDone(items, label)}
            onOpenSettings={onOpenSettings}
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
            state={threadState}
            syncing={syncing}
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

      {/* Composer and reader swap under one presence: the leaving pane is
          popped out of flow and fades over 80ms while the arriving one fades
          in, instead of a hard cut. `relative` anchors the popped pane.
          The pane declares no ground: the canvas is the only ground (v3), so
          an empty pane, a loading one and a crossfade between two of them all
          stand on the same canvas the column beside them stands on, and no
          plate edge runs down the gutter. The one opaque plane left on this
          surface is the message sheet inside the reader — foreign HTML needs
          its white page, our own markup does not. */}
      <div
        className={`${singlePane === "list" ? "hidden" : "flex"} relative min-h-0 min-w-0 flex-1 panes:flex`}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={composer && composerAccount ? composer.draft.idempotencyKey : "reader"}
            className="flex min-h-0 min-w-0 flex-1"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 2 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={pageTransition.exit}
            transition={{ duration: DUR.fast, ease: EASE_OUT }}
          >
            {composer && composerAccount ? (
              <MailComposer
                account={composerAccount}
                initialDraft={composer.draft}
                sending={composer.sending}
                sendError={composer.error}
                sendBlocked={composer.blocked}
                sendErrorSettings={composer.errorSettings}
                onOpenSettings={(invoker) =>
                  onOpenSettings(invoker, composerAccount.accountId)
                }
                saveStatus={saveStatus}
                onCancel={() =>
                  closeComposer(
                    draftSyncRef.current
                      ? isDraftSyncEmpty(draftSyncRef.current)
                      : false,
                  )
                }
                onDiscard={() => closeComposer(true)}
                onDraftChange={onComposerDraftChange}
                onRetrySave={retryDraftSave}
                onSend={(input) => void send(input)}
                onToast={onToast}
              />
            ) : (
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
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

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
    message: sendFailureMessage(error.code),
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

function threadActionConfirmation(action: Exclude<MailReaderAction, "toggle-read">): string {
  if (action === "archive") return "Conversation archived";
  if (action === "trash") return "Conversation moved to trash";
  if (action === "restore") return "Conversation restored";
  if (action === "mark-spam") return "Conversation marked as spam";
  if (action === "unmark-spam") return "Conversation removed from spam";
  if (action === "star") return "Conversation starred";
  return "Star removed";
}
