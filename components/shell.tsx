"use client";

import { apiFetch, CLIENT_ID } from "@/lib/client";
import {
  canResumeConflictedDraft,
  createKeyedQueue,
  decodeDraft,
  encodeSaveRequest,
  isDraftOperation,
  latchDraftConflict,
  persistDraft,
  SaveRequestError,
  saveMarkdown,
  type StoredDraft,
} from "@/lib/autosave";
import { canonicalPageMarkdown } from "@/lib/page-markdown";
import { sectionPageIds } from "@/lib/dated-sections";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Kbd, Skeleton, type ToastOptions } from "./ui/primitives";
import { Empty } from "./ui/empty";
import { Button } from "./ui/button";
import { Background } from "./ui/background";
import { DUR, EASE_OUT, pageFade, pageTransition } from "@/lib/motion";
import { isEditableEventTarget } from "@/lib/editable-target";
import { serverBuildDiffers } from "@/lib/stale-chunk";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type { TreeNode } from "@/lib/store/types";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import type { PageMenuHandlers } from "./tree/row-menu";
import {
  CommandPalette,
  type CommandPaletteSelection,
} from "./command-palette";
import {
  parseSettingsPath,
  settingsPath,
  type SettingsSection,
} from "./settings/sections";
// code-split the mail client out of the notes bundle the same way as the
// editor — opening a note must not download ~9k lines of mail UI
const MailSurface = dynamic(
  () => import("./mail-surface").then((m) => m.MailSurface),
  { ssr: false },
);
// the settings surface code-splits the same way: the sections load when
// /settings opens, not with every note
const SettingsSurface = dynamic(
  () => import("./settings/settings-surface").then((m) => m.SettingsSurface),
  { ssr: false },
);
import type { ShareEnableResult } from "./share-popover";
import { Hub } from "./hub";
import { MobileTabBar } from "./mobile-tab-bar";
import { MobilePagesView } from "./mobile-pages-view";
import { MOVE_BLOCKED_MESSAGE } from "./page-move-dialog";
import {
  claimDialogFocus,
  type DialogFocusLease,
} from "./ui/dialog-focus-return";
import type { Template } from "@/lib/templates";
import { StickersLayer, stickerPrintCanvasHeight } from "./stickers";
import type { Sticker } from "@/lib/store/types";
import { NESTED_TABLE_BLOCKED_EVENT } from "@/lib/editor-events";
import {
  mapMarkdownOffset,
  removeStandalonePageRefOccurrenceWithRestore,
  restoreStandalonePageRefAtOffset,
  standalonePageRefOccurrences,
  type StandalonePageRefRestorePoint,
} from "@/lib/page-ref-nesting";
import type {
  SearchHighlightRequest,
  SearchHighlightStatus,
  SearchTextTarget,
} from "@/lib/search-navigation";
import {
  isActiveShareGrant,
  isShareGrantExpired,
  resolveInheritedShareGrants,
} from "@/lib/share-grants";
import {
  loadStickerDraft,
  persistStickerDraft,
  saveStickerDraft,
} from "@/lib/sticker-draft";
import {
  PageRefNestingRequest,
  PageRefNestingScope,
  PageRefNestingSource,
  standalonePageRefAnchors,
  validatePageRefNestingTarget,
} from "./editor/page-ref-nesting";
import {
  adoptPrefetch,
  applyMove,
  canvasPresenceKey,
  DAILY_PARENT_TEMPLATE,
  dailyTemplateFor,
  dialogFocusFallback,
  fetchWithDeadline,
  findDailyChild,
  findDailyParent,
  findPath,
  firstId,
  FOCUS_STORAGE_KEY,
  formatLocalISODate,
  isShareScopeSnapshot,
  isVisibleFocusTarget,
  LOCAL_RECOVERY_UNAVAILABLE,
  loadedPageFromResponse,
  navigationPresenceReducer,
  PAGE_CACHE_CAP,
  PAGE_REF_BODY_CHANGED,
  PAGE_REF_READBACK_FAILED,
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  reconcileStructureMutation,
  removeNode,
  saveOperationKey,
  shareTreeRevision,
  smartChildSignature,
  STRUCTURE_MUTATION_TIMEOUT_MS,
  captureThought,
  type CreatedPageRef,
  type EditorContextPageRef,
  type FocusDialogSession,
  type FocusPageDialogTarget,
  type LoadedPage,
  type PageRefNestingOperation,
  type PageRefRemoveTarget,
  type PageRefUndo,
  toastAdmit,
  type SaveState,
  type ShellInitialPage,
  type ShellToast,
} from "./shell/helpers";
import {
  reconcilePageRefEffect,
  type PageRefEffectReceipt,
} from "./shell/page-ref-reconcile";
import { ShellSidebar } from "./shell/sidebar";
import { ShellTopbar, type ShellTopbarProps } from "./shell/topbar";
import { PageCover, PageHead } from "./shell/page-head";
import { PageBody } from "./shell/page-body";
import { ShellOverlays } from "./shell/overlays";
import {
  draftSourcesForOperation,
  draftStorageKey,
  draftStoragePrefix,
  isDraftStorageKeyForPage,
  legacyDraftStorageKey,
  mergeDraftSources,
} from "./shell/draft-sources";

export type { ShellInitialPage } from "./shell/helpers";

/**
 * How long a plain message stands. It is tuned for a sentence nobody has to
 * act on — a caller that owes the reader a way back passes its own window.
 */
const TOAST_MS = 2200;

/**
 * How long a refusal stands. Shorter than a report: it answers a gesture the
 * reader has just made and is still watching, so it has nothing to be found
 * and nothing to be reached for.
 */
const URGENT_TOAST_MS = 3200;
/** Window of the "Brain was updated" pill: the undo length, since it too
 *  carries a press the reader has to notice and reach. A pill with an
 *  action holds the queue behind it, so it cannot stand without a window. */
const REDEPLOY_TOAST_MS = 10_000;

/** Body of a notes canvas: a `fallback` (skeleton or load error) while the
 *  page is cold, then the resolved page. The fallback exits in place
 *  (absolute skeleton, fast fade) while the body fades in, so the canvas is
 *  never empty between the two. A page already on hand when the canvas
 *  mounted (SSR seed, cache hit) rides the canvas enter instead of running a
 *  second fade. */
function NotesCanvasBody({
  ready,
  fallback,
  children,
}: {
  ready: boolean;
  fallback: ReactNode;
  children: ReactNode;
}) {
  const [readyAtMount] = useState(ready);
  return (
    <>
      <AnimatePresence>{ready ? null : fallback}</AnimatePresence>
      {ready && (
        <motion.div
          className="brain-page-body"
          initial={readyAtMount ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: DUR.base, ease: EASE_OUT }}
        >
          {children}
        </motion.div>
      )}
    </>
  );
}

export function Shell({
  tree: initialTree,
  initialSelectedId,
  initialSurface = "notes",
  initialSettingsSection = null,
  initialMailSettingsAccountId = null,
  initialPage,
}: {
  tree: TreeNode[];
  initialSelectedId?: string | null;
  /** "settings" mounts the settings surface (/settings and
   *  /settings/[section]). */
  initialSurface?: "notes" | "mail" | "settings";
  /** The section of a /settings/[section] deep link; null is the root list
   *  (mobile) — desktop normalises it to "appearance" on mount. */
  initialSettingsSection?: SettingsSection | null;
  /** The /settings/mail?account=<id> deep link. */
  initialMailSettingsAccountId?: string | null;
  /** Server-read body of `initialSelectedId` (deep link / reload). Seeds the
   *  page cache so the first paint is content; the load effect still
   *  revalidates it against the server like any cache hit. */
  initialPage?: ShellInitialPage;
}) {
  const [tree, setTree] = useState(initialTree);
  const [
    { selectedId, surface, settingsSection, epoch: navigationPresenceEpoch },
    dispatchNavigationPresence,
  ] = useReducer(navigationPresenceReducer, {
    selectedId:
      initialSurface === "mail" || initialSurface === "settings"
        ? null
        : initialSelectedId === undefined
          ? firstId(initialTree)
          : initialSelectedId,
    surface:
      initialSurface === "mail"
        ? "mail"
        : initialSurface === "settings"
          ? "settings"
          : "notes",
    settingsSection:
      initialSurface === "settings" ? initialSettingsSection : null,
    epoch: 0,
  });
  const mailOpen = surface === "mail";
  const settingsActive = surface === "settings";
  const setSelectedId = useCallback(
    (value: SetStateAction<string | null>) =>
      dispatchNavigationPresence({ type: "selected-id", value }),
    [],
  );
  const setMailOpen = useCallback(
    (value: boolean) =>
      dispatchNavigationPresence({
        type: "surface",
        surface: value ? "mail" : "notes",
      }),
    [],
  );
  const [mailSurfaceRevision, setMailSurfaceRevision] = useState(0);
  const selectedIdRef = useRef(selectedId);
  const surfaceRef = useRef(surface);
  const treeRef = useRef(tree);
  useLayoutEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useLayoutEffect(() => {
    surfaceRef.current = surface;
  }, [surface]);
  useLayoutEffect(() => {
    treeRef.current = tree;
  }, [tree]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [seededPage] = useState(() =>
    initialPage && initialPage.id === selectedId
      ? loadedPageFromResponse(initialPage.id, initialPage)
      : null,
  );
  const [page, setPage] = useState<LoadedPage | null>(seededPage);
  // A cold page whose GET failed: id + HTTP status (null for a network-level
  // failure). Without it the reader sat on the skeleton forever. Cleared by
  // Try again (which re-runs the load effect via pageLoadAttempt) — a later
  // successful load renders `page`, which always wins over this branch.
  const [pageLoadError, setPageLoadError] = useState<{
    id: string;
    status: number | null;
  } | null>(null);
  const [pageLoadAttempt, setPageLoadAttempt] = useState(0);
  const retryPageLoad = useCallback(() => {
    setPageLoadError(null);
    setPageLoadAttempt((attempt) => attempt + 1);
  }, []);
  const [save, setSave] = useState<SaveState>("idle");
  const [recoveryCopyId, setRecoveryCopyId] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [localRecoveryUnavailableIds, setLocalRecoveryUnavailableIds] =
    useState<Set<string>>(new Set());
  const [mobilePagesOpen, setMobilePagesOpen] = useState(false);
  const mobilePagesOpenRef = useRef(false);
  useLayoutEffect(() => {
    mobilePagesOpenRef.current = mobilePagesOpen;
  }, [mobilePagesOpen]);
  const [mobileViewport, setMobileViewport] = useState(false);
  const mobileSearchTabRef = useRef<HTMLButtonElement | null>(null);
  const mobilePagesTabRef = useRef<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [focusModeLoaded, setFocusModeLoaded] = useState(false);
  // B5: the canvas offset follows the sidebar in ONE reflow — on collapse
  // once the transform spring settles (onCollapsed), on expand at once so
  // the panel slides into room that is already there.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // leaving focus mode re-arms the collapse for the next entry (a derived
  // reset during render, not an effect: the offset must be back before the
  // panel starts sliding in)
  if (!focusMode && sidebarCollapsed) setSidebarCollapsed(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    title: string;
    error?: string;
  } | null>(null);
  const [countdown, setCountdown] = useState(7);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const deletingRef = useRef<Set<string>>(new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const searchHighlightRequestRef = useRef(0);
  const searchHighlightRef = useRef<SearchHighlightRequest | null>(null);
  const [searchHighlight, setSearchHighlight] =
    useState<SearchHighlightRequest | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // /settings/mail?account=<id> — the account whose details the Mail section
  // opens. Set by the deep-link toasts and re-read from the URL on popstate.
  const [mailSettingsAccountId, setMailSettingsAccountId] = useState<
    string | null
  >(initialMailSettingsAccountId);
  // Settings entered from inside the app: closing goes history.back() and the
  // previous page restores from the cache. A cold /settings load exits home.
  const settingsEnteredInAppRef = useRef(false);
  // The mobile drill-down that pushed /settings/<section> over the root list:
  // its Back pops history; a deep link straight into a section rewrites in
  // place instead (no synthetic history).
  const settingsDrilledFromRootRef = useRef(false);
  // Settings opened from the mobile Pages drawer: leaving settings restores
  // the drawer and focuses its gear.
  const settingsOpenedFromPagesRef = useRef(false);
  const dialogFocusOwnerRef = useRef(0);
  const historyOpenRequestRef = useRef(0);
  const dialogReturnFocusRef = useRef<DialogFocusLease | null>(null);
  const [renameTarget, setRenameTarget] =
    useState<FocusPageDialogTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<FocusPageDialogTarget | null>(null);
  const [editorContextTargetId, setEditorContextTargetId] = useState<
    string | null
  >(null);
  const editorContextTargetRef = useRef<string | null>(null);
  const [editorContextPageRef, setEditorContextPageRef] =
    useState<EditorContextPageRef | null>(null);
  const editorContextPageRefRef = useRef<EditorContextPageRef | null>(null);
  const [pageRefRemoveTarget, setPageRefRemoveTarget] =
    useState<PageRefRemoveTarget | null>(null);
  const pageRefRemovalBusyRef = useRef(false);
  const pageRefRemovalAttemptRef = useRef<{
    key: string;
    markdown: string;
    restorePoint: StandalonePageRefRestorePoint;
    receipt: PageRefEffectReceipt;
  } | null>(null);
  const [pageRefUndo, setPageRefUndo] = useState<PageRefUndo | null>(null);
  const pageRefUndoRef = useRef<PageRefUndo | null>(null);
  const [mobileKeyboardOpen, setMobileKeyboardOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [historyDialog, setHistoryDialog] =
    useState<FocusDialogSession | null>(null);
  const historyOpen = historyDialog?.open ?? false;
  const [historyBaseRevision, setHistoryBaseRevision] = useState("");
  const [toast, setToast] = useState<ShellToast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The refusal channel: one sentence, its own pill, never queued. */
  const [urgentToast, setUrgentToast] = useState<string | null>(null);
  /** An action from the standing toast that has begun and not yet settled. */
  const [toastActionPending, setToastActionPending] = useState(false);
  const toastActionPendingRef = useRef(false);
  const urgentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The standing toast, readable synchronously from inside `showToast`. */
  const toastRef = useRef<ShellToast | null>(null);
  /** Messages waiting for a standing undo to live out its window. */
  const toastQueue = useRef<ShellToast[]>([]);
  const toastEndsAt = useRef(0);
  const toastLeftMs = useRef(0);
  const presentToastRef = useRef<(next: ShellToast | null) => void>(() => {});
  const [smartPreview, setSmartPreview] = useState<{
    pageId: string;
    childSig: string;
    sections: string[];
    assignments: Record<string, string>;
    /** Reading order across all sections. A dated one reads newest first. */
    order?: string[];
    count: number;
  } | null>(null);
  const [smartLoading, setSmartLoading] = useState(false);
  const [smartUndoOpen, setSmartUndoOpen] = useState(false);
  const [smartUndoPageId, setSmartUndoPageId] = useState<string | null>(null);
  const smartUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateMailConfiguredFromSettings = useCallback(
    () => {
      setMailSurfaceRevision((revision) => revision + 1);
    },
    [],
  );

  // Desktop has no settings root list: the bare /settings (a deep link, or
  // the viewport crossing to desktop) normalises to the first section in
  // place — no extra history entry.
  useEffect(() => {
    if (!settingsActive || settingsSection !== null) return;
    if (window.matchMedia("(max-width: 767px)").matches) return;
    window.history.replaceState({}, "", settingsPath("appearance"));
    dispatchNavigationPresence({
      type: "surface",
      surface: "settings",
      settingsSection: "appearance",
    });
  }, [settingsActive, settingsSection, mobileViewport]);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 767px)");
    const updateMobileViewport = () => setMobileViewport(mobile.matches);
    updateMobileViewport();
    mobile.addEventListener("change", updateMobileViewport);
    return () => mobile.removeEventListener("change", updateMobileViewport);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateKeyboard = () => {
      const covered =
        window.innerHeight - (viewport.offsetTop + viewport.height);
      setMobileKeyboardOpen(covered > 120);
    };
    updateKeyboard();
    viewport.addEventListener("resize", updateKeyboard);
    viewport.addEventListener("scroll", updateKeyboard);
    return () => {
      viewport.removeEventListener("resize", updateKeyboard);
      viewport.removeEventListener("scroll", updateKeyboard);
    };
  }, []);

  const rememberPaletteInvoker = useCallback((invoker?: HTMLElement) => {
    const target = invoker ?? document.activeElement;
    paletteReturnFocusRef.current =
      target instanceof HTMLElement && target !== document.body ? target : null;
  }, []);

  const clearSearchHighlightIntent = useCallback(() => {
    searchHighlightRequestRef.current += 1;
    searchHighlightRef.current = null;
    setSearchHighlight(null);
  }, []);

  useEffect(() => {
    const current = searchHighlightRef.current;
    if (current && current.pageId !== selectedId) {
      clearSearchHighlightIntent();
    }
  }, [clearSearchHighlightIntent, selectedId]);

  const openPalette = useCallback(
    (invoker?: HTMLElement) => {
      clearSearchHighlightIntent();
      rememberPaletteInvoker(invoker);
      if (mobileViewport) setMobilePagesOpen(false);
      setPaletteOpen(true);
    },
    [
      clearSearchHighlightIntent,
      mobileViewport,
      rememberPaletteInvoker,
    ],
  );

  const onPaletteOpenChange = useCallback((open: boolean) => {
    if (open) {
      setPaletteOpen(true);
      return;
    }
    const target = paletteReturnFocusRef.current;
    paletteReturnFocusRef.current = null;
    setPaletteOpen(false);
    // The desktop palette is a modal that stays mounted through its exit
    // tween, so the app is still aria-hidden for a few frames after close.
    // Poll (bounded) until a visible target exists instead of assuming two.
    let attemptsLeft = 24;
    const restoreFocus = () => {
      const currentSearchTrigger = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-mobile-tab="search"], [data-search-trigger="desktop"]',
        ),
      ).find(isVisibleFocusTarget);
      const focusTarget = isVisibleFocusTarget(target)
        ? target
        : (currentSearchTrigger ?? mainRef.current);
      if (isVisibleFocusTarget(focusTarget)) {
        focusTarget.focus({ preventScroll: true });
        return;
      }
      attemptsLeft -= 1;
      if (attemptsLeft > 0) window.requestAnimationFrame(restoreFocus);
    };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(restoreFocus);
    });
  }, []);
  // Smart Sort writes plain markdown (headings + page links) into the body;
  // undo restores the prior body verbatim
  const smartUndo = useRef<{
    id: string;
    markdown: string;
    rev: string;
  } | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [nestingEditor, setNestingEditor] = useState<{
    pageId: string;
    sourceId: string;
    occurrence: number;
  } | null>(null);
  const { theme, resolvedTheme, setTheme } = useTheme();
  const revisionsRef = useRef<Map<string, string>>(new Map());
  // Body paired with revisionsRef. Unlike the navigation cache, this advances
  // only when the editor adopts a server revision or a PUT is confirmed.
  const baseMarkdownRef = useRef<Map<string, string>>(new Map());
  const saveQueueRef = useRef(createKeyedQueue());
  const queuedSaveRef = useRef<Map<string, { id: string; promise: Promise<boolean> }>>(
    new Map(),
  );
  const conflictedPagesRef = useRef<Set<string>>(new Set());
  const localRecoveryUnavailableRef = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{
    id: string;
    md: string;
    operationId: string;
  } | null>(null);
  const flushPendingRef = useRef<() => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  const editorFlushRef = useRef<() => void>(() => {});
  const editorDirtyRef = useRef<string | null>(null);
  const coverQueueRef = useRef(createKeyedQueue());
  const coverConfirmedRef = useRef<Map<string, string | undefined>>(new Map());
  const coverLatestOperationRef = useRef<Map<string, number>>(new Map());
  const coverOperationRef = useRef(0);
  // Smart Sort snapshots the current direct-child set before its async preview.
  const curChildrenRef = useRef<TreeNode[]>([]);
  // Only one centre-drop may be active. The editor remains server-first and
  // frozen while this operation settles, so autosave cannot race its body move.
  const pageRefNestingOperationsRef = useRef(
    new Map<string, PageRefNestingOperation>(),
  );

  /** Arms the dismissal for the standing toast, `ms` from now. */
  const armToast = useCallback((ms: number) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastEndsAt.current = Date.now() + ms;
    toastLeftMs.current = ms;
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      presentToastRef.current(toastQueue.current.shift() ?? null);
    }, ms);
  }, []);

  /**
   * Puts one message on screen (or clears the pill) and starts its window.
   *
   * `durationMs: null` starts NO window. The pill stands until a message
   * wearing its id replaces it or its action is spent — which is what an
   * action whose end is not yet known needs, since the alternative is a
   * guessed duration that either takes the way back away mid-work or draws a
   * countdown over a deadline nobody has.
   */
  const presentToast = useCallback(
    (next: ShellToast | null) => {
      toastRef.current = next;
      setToast(next);
      if (!next || next.durationMs === null) {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = null;
        return;
      }
      armToast(next.durationMs ?? TOAST_MS);
    },
    [armToast],
  );
  useEffect(() => {
    presentToastRef.current = presentToast;
  }, [presentToast]);

  /**
   * The shell's one general-purpose snackbar. Most callers pass a sentence and
   * nothing else — it says it and goes. `options` is for the few that owe the
   * reader a way back: an undo action, and the longer window it takes to
   * notice one and reach it.
   *
   * A message never overwrites a standing UNDO. Replacing the pill used to
   * throw the way back away silently — press Done on Notifications, then on
   * Newsletters inside the window, and the first Undo was gone with nothing
   * said — and the mail lock makes that the likely order rather than a rare
   * one. So an action that is still live holds the pill, and what arrives
   * meanwhile waits its turn. The one thing that may take the pill from it is
   * a message wearing the SAME id: that is the same sentence corrected, not a
   * second one, and it carries its own way back with it.
   *
   * The exception is `urgent`. Waiting is right for a REPORT and wrong for a
   * REFUSAL — press Done a second time inside the window and the answer has to
   * arrive with the press, not ten seconds later when the first undo's window
   * closes and the sentence is no longer even true. So a refusal takes its own
   * pill above the standing one and never touches the queue.
   */
  const showToast = useCallback((title: string, options?: ToastOptions) => {
    if (options?.urgent) {
      setUrgentToast(title);
      if (urgentTimer.current) clearTimeout(urgentTimer.current);
      urgentTimer.current = setTimeout(() => {
        urgentTimer.current = null;
        setUrgentToast(null);
      }, URGENT_TOAST_MS);
      return;
    }
    const admitted = toastAdmit(toastRef.current, toastQueue.current, {
      title,
      ...options,
    });
    toastQueue.current = [...admitted.waiting];
    if (admitted.present) presentToastRef.current(admitted.present);
  }, []);

  /**
   * Runs the toast's own action, then takes the pill down so the undo cannot
   * be pressed twice while the restore is still running — in that order,
   * because an action that REFUSES (`false`: the mail lock is held by
   * something else) must not spend the way back. A refused press leaves the
   * message and its remaining window exactly where they were.
   */
  const runToastAction = useCallback(
    (action: () => boolean | void | Promise<unknown>) => {
      // One open action at a time. A second press, or ⌘Z, while the first is
      // still settling would start the same reversal twice.
      if (toastActionPendingRef.current) return;
      const outcome = action();
      if (outcome === false) return;
      if (!(outcome instanceof Promise)) {
        presentToastRef.current(toastQueue.current.shift() ?? null);
        return;
      }
      /* The action has begun but cannot finish yet — an undo waiting for the
         loop it stops to drop the mail lock. The pill stands, its button out
         of reach, until the promise settles; only THEN is it spent. The
         standing message is remembered so a pill that was replaced meanwhile
         (its own window ran out, or a same-id correction took it) is not the
         one taken down. */
      const standing = toastRef.current;
      toastActionPendingRef.current = true;
      setToastActionPending(true);
      void outcome.then(
        () => {},
        () => {},
      ).then(() => {
        toastActionPendingRef.current = false;
        setToastActionPending(false);
        if (toastRef.current !== standing) return;
        presentToastRef.current(toastQueue.current.shift() ?? null);
      });
    },
    [],
  );

  /** Hover holds the message. The drain ring pauses under the pointer (one
   *  `animation-play-state`), and until this existed the timer did not — so
   *  the pill left from under the hand reaching for Undo. */
  const pauseToast = useCallback(() => {
    if (!toastTimer.current) return;
    clearTimeout(toastTimer.current);
    toastTimer.current = null;
    toastLeftMs.current = Math.max(0, toastEndsAt.current - Date.now());
  }, []);
  const resumeToast = useCallback(() => {
    if (toastTimer.current || !toastRef.current) return;
    // A window-less pill has nothing to resume, and `toastLeftMs` still holds
    // whatever the last counted message left behind. The overlay does not wire
    // hover on such a pill either; this is the guard for the other order.
    if (toastRef.current.durationMs === null) return;
    armToast(toastLeftMs.current);
  }, [armToast]);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (urgentTimer.current) clearTimeout(urgentTimer.current);
    },
    [],
  );

  /**
   * ⌘Z reaches the standing toast's action, the way it already reaches a
   * pending page delete three hundred lines below. Without it the way back
   * lived only under the pointer — the pill is a `role="status"`, focus never
   * moves there, and the Tab order does not pass through it — so the ten
   * seconds a bulk archive offers were mouse-only.
   *
   * Not while the caret is in a typing surface. The window listener runs
   * AFTER the field or ProseMirror has done its own undo, so ⌘Z to fix a typo
   * in the composer would take the letter back AND roll an archive of eleven
   * threads back with it — the pill leaving looking spent, with nothing said.
   */
  useEffect(() => {
    const action = toast?.onAction;
    if (!action) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") {
        return;
      }
      if (isEditableEventTarget(event.target)) return;
      event.preventDefault();
      runToastAction(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast, runToastAction]);

  const onSearchHighlightStatus = useCallback(
    (requestId: number, status: SearchHighlightStatus) => {
      if (status === "exact") return;
      const current = searchHighlightRef.current;
      if (
        !current ||
        current.requestId !== requestId ||
        selectedIdRef.current !== current.pageId
      ) {
        return;
      }
      searchHighlightRef.current = null;
      setSearchHighlight(null);
      if (status === "missing" || status === "ambiguous") {
        showToast("That search match changed. Opened the page instead.");
      }
    },
    [showToast],
  );

  const clearPageRefNesting = useCallback((operationId: string) => {
    const operation = pageRefNestingOperationsRef.current.get(operationId);
    pageRefNestingOperationsRef.current.delete(operationId);
    if (operation) {
      setNestingEditor((current) =>
        current?.pageId === operation.pageId ? null : current,
      );
    }
  }, []);

  const markLocalRecoveryUnavailable = useCallback((id: string) => {
    if (localRecoveryUnavailableRef.current.has(id)) return;
    localRecoveryUnavailableRef.current.add(id);
    setLocalRecoveryUnavailableIds(
      new Set(localRecoveryUnavailableRef.current),
    );
  }, []);

  const clearLocalRecoveryUnavailable = useCallback((id: string) => {
    if (!localRecoveryUnavailableRef.current.delete(id)) return;
    setLocalRecoveryUnavailableIds(
      new Set(localRecoveryUnavailableRef.current),
    );
  }, []);

  const localRecoveryUnavailable =
    !!selectedId && localRecoveryUnavailableIds.has(selectedId);

  const blockConflictMutation = useCallback(
    (
      context: string | null | readonly (string | null)[],
      text = "Save a copy before changing page structure.",
    ) => {
      const ids =
        typeof context === "string" || context === null ? [context] : context;
      const conflictId = ids.find(
        (id): id is string => !!id && conflictedPagesRef.current.has(id),
      );
      if (!conflictId) return false;
      setRecoveryMessage({ id: conflictId, text });
      if (selectedIdRef.current !== conflictId) showToast("Save a copy first.");
      return true;
    },
    [showToast],
  );

  useEffect(() => {
    const onNestedTableBlocked = () => {
      showToast("Tables can't be nested");
    };
    window.addEventListener(NESTED_TABLE_BLOCKED_EVENT, onNestedTableBlocked);
    return () =>
      window.removeEventListener(
        NESTED_TABLE_BLOCKED_EVENT,
        onNestedTableBlocked,
      );
  }, [showToast]);

  const nextSaveOperation = useCallback(
    () =>
      `${CLIENT_ID}:${
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      }`,
    [],
  );

  const clearDraftOperation = useCallback(
    (id: string, operationId: string) => {
      try {
        const ownKey = draftStorageKey(id);
        const own = localStorage.getItem(ownKey);
        if (own !== null && isDraftOperation(own, operationId)) {
          const sources = decodeDraft(own).sources;
          localStorage.removeItem(ownKey);
          for (const source of sources) {
            if (!isDraftStorageKeyForPage(id, source.key)) continue;
            const sourceRaw = localStorage.getItem(source.key);
            if (
              sourceRaw !== null &&
              isDraftOperation(sourceRaw, source.operationId)
            ) {
              localStorage.removeItem(source.key);
            }
          }
        }
      } catch {}
    },
    [],
  );

  const registerEditorFlush = useCallback((flush: () => void) => {
    editorFlushRef.current = flush;
    return () => {
      if (editorFlushRef.current === flush) editorFlushRef.current = () => {};
    };
  }, []);

  // ── page cache (instant re-navigation + hover prefetch) ──────
  const pageCache = useRef<Map<string, LoadedPage>>(
    new Map(seededPage ? [[seededPage.id, seededPage]] : []),
  );
  // In-flight hover prefetches. The load effect adopts one for the same id
  // instead of re-fetching, so hover → click costs a single GET.
  const prefetchInflight = useRef<Map<string, Promise<LoadedPage | null>>>(
    new Map(),
  );
  // Id whose load-effect GET is in flight. The first SSE "ready" reconcile
  // skips `reloadCurrent` for it — the load already returns the latest body.
  const pageLoadInflightRef = useRef<string | null>(null);
  const cachePut = useCallback((p: LoadedPage) => {
    const m = pageCache.current;
    m.delete(p.id); // re-insert to move to MRU end
    m.set(p.id, p);
    if (m.size > PAGE_CACHE_CAP) {
      const evictedId = m.keys().next().value as string;
      m.delete(evictedId);
      // Baseline bodies follow the same cap. Preserve an active page until its
      // pending/queued write finishes even if aggressive prefetch evicts it.
      if (
        evictedId !== selectedIdRef.current &&
        pendingRef.current?.id !== evictedId &&
        !saveQueueRef.current.has(evictedId)
      ) {
        revisionsRef.current.delete(evictedId);
        baseMarkdownRef.current.delete(evictedId);
      }
    }
  }, []);
  const prefetchPage = useCallback(
    (id: string) => {
      // The open page is already being loaded or revalidated by the load
      // effect — a hover-intent timer that fires after the click must not
      // issue a second GET for it.
      if (
        id === selectedIdRef.current ||
        pageCache.current.has(id) ||
        prefetchInflight.current.has(id)
      )
        return;
      const request = apiFetch(`/api/page/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((p): LoadedPage | null => {
          if (!p) return null;
          const loaded = loadedPageFromResponse(id, p);
          cachePut(loaded);
          return loaded;
        })
        .catch(() => null)
        .finally(() => prefetchInflight.current.delete(id));
      prefetchInflight.current.set(id, request);
    },
    [cachePut],
  );

  // value #3 — a save failure must never be silent. The save-dot lives in the
  // sidebar, which is hidden in focus mode; a toast is fixed-position and shows
  // regardless, so an error is always visible where you're writing.
  useEffect(() => {
    if (save !== "error" || localRecoveryUnavailable) return;
    const frame = requestAnimationFrame(() => {
      showToast("Couldn't save. Your draft is safe.");
    });
    return () => cancelAnimationFrame(frame);
  }, [localRecoveryUnavailable, save, showToast]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        setFocusMode(localStorage.getItem(FOCUS_STORAGE_KEY) === "true");
      } catch {}
      setFocusModeLoaded(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!focusModeLoaded) return;
    try {
      localStorage.setItem(FOCUS_STORAGE_KEY, String(focusMode));
    } catch {}
  }, [focusMode, focusModeLoaded]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const raw = localStorage.getItem(RECENT_STORAGE_KEY);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setRecentIds(
            parsed
              .filter((id): id is string => typeof id === "string")
              .slice(0, RECENT_LIMIT),
          );
        }
      } catch {}
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const rememberRecent = useCallback((id: string) => {
    setRecentIds((ids) => {
      const next = [id, ...ids.filter((recentId) => recentId !== id)].slice(0, RECENT_LIMIT);
      try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const refreshTree = useCallback(async () => {
    const r = await apiFetch("/api/tree");
    if (!r.ok) throw new Error(`Tree request returned ${r.status}`);
    const { tree: nextTree } = (await r.json()) as { tree: TreeNode[] };
    const activeId = selectedIdRef.current;
    if (activeId) {
      const current = findPath(treeRef.current, activeId).at(-1);
      const incoming = findPath(nextTree, activeId).at(-1);
      const currentUsesEditor =
        current?.view !== "board" && !current?.collection;
      const incomingUsesEditor =
        incoming?.view !== "board" && !incoming?.collection;
      if (currentUsesEditor && !incomingUsesEditor) {
        // A tree refresh can conditionally replace the editor with a board or
        // imported collection, including after an external MCP change. Flush
        // at the exact boundary so the final transaction cannot disappear on
        // unmount.
        editorFlushRef.current();
        flushPendingRef.current();
      }
    }
    treeRef.current = nextTree;
    setTree(nextTree);
    return nextTree;
  }, []);

  // reload the open page from disk if it changed externally (MCP / another tab).
  // A rev match means it was our own write — skip it (no self-reload flicker).
  const reloadCurrent = useCallback(
    async (id: string) => {
      const revisionAtRequest = revisionsRef.current.get(id);
      const r = await apiFetch(`/api/page/${id}`);
      if (!r.ok) return;
      const p = await r.json();
      // A PUT or a newer GET may finish while this response is in flight. The
      // old body must not replace either the cache or the live editor after its
      // request baseline has advanced.
      if (revisionsRef.current.get(id) !== revisionAtRequest) return;
      if (p.rev === revisionsRef.current.get(id)) return;
      const loaded: LoadedPage = {
        id,
        title: p.meta.title,
        icon: p.meta.icon,
        cover: p.meta.cover,
        stickers: p.meta.stickers ?? [],
        markdown: p.markdown,
        rev: p.rev,
      };
      coverConfirmedRef.current.set(id, loaded.cover);
      cachePut(loaded);
      // An async SSE read may finish after navigation or after local typing
      // began. It may refresh the server cache, never the wrong active editor
      // or the base revision of an unsaved draft.
      if (
        pendingRef.current?.id === id ||
        editorDirtyRef.current === id ||
        coverQueueRef.current.has(id)
      )
        return;
      revisionsRef.current.set(id, p.rev);
      baseMarkdownRef.current.set(id, p.markdown);
      if (selectedIdRef.current !== id) return;
      setPage(loaded);
      setEditorEpoch((e) => e + 1);
      // silent — an external change just refreshes the page, no toast
    },
    [cachePut],
  );

  const mutate = useCallback(
    async (input: RequestInfo, init?: RequestInit) => {
      try {
        const res = await apiFetch(input, init);
        if (!res.ok) throw new Error(String(res.status));
        return true;
      } catch {
        showToast("Couldn't save. Brain refreshed the latest version.");
        void refreshTree().catch(() => {});
        return false;
      }
    },
    [showToast, refreshTree],
  );

  // live-sync: subscribe to store mutations. Structural changes refresh the
  // tree; a change to the OPEN page reloads it — unless you're mid-edit
  // (pending unsaved body), where a reload would clobber your typing.
  const startDialogFocus = useCallback((invoker: HTMLElement | null) => {
    const owner = ++dialogFocusOwnerRef.current;
    claimDialogFocus(
      dialogReturnFocusRef,
      owner,
      invoker,
      dialogFocusFallback,
    );
    return owner;
  }, []);
  const invalidateHistoryOpenRequests = useCallback(() => {
    historyOpenRequestRef.current += 1;
  }, []);
  const openRenameDialog = useCallback(
    (id: string, title: string, invoker: HTMLElement | null) => {
      invalidateHistoryOpenRequests();
      const owner = startDialogFocus(invoker);
      setRenameTarget({ id, title, open: true, owner });
    },
    [invalidateHistoryOpenRequests, startDialogFocus],
  );
  const openMoveDialog = useCallback(
    (id: string, title: string, invoker: HTMLElement | null) => {
      invalidateHistoryOpenRequests();
      const owner = startDialogFocus(invoker);
      setMoveTarget({ id, title, open: true, owner });
    },
    [invalidateHistoryOpenRequests, startDialogFocus],
  );
  const openHistory = useCallback(async (invoker: HTMLElement | null) => {
    const request = ++historyOpenRequestRef.current;
    const id = selectedIdRef.current;
    if (!id) return;
    editorFlushRef.current();
    const firstSaved = await flushPendingRef.current();
    // A newer History request, another page dialog, or any navigation cancels
    // this delayed continuation. The id check alone cannot catch A -> B -> A.
    if (
      historyOpenRequestRef.current !== request ||
      selectedIdRef.current !== id
    )
      return;
    // Milkdown marks the editor dirty synchronously, but its normal markdown
    // emission is delayed. Materialize the live document again after the PUT so
    // an edit made while that request was in flight cannot be mistaken for the
    // just-confirmed operation. Do this even when the PUT failed so the latest
    // live document reaches the recovery draft before History aborts.
    editorFlushRef.current();
    if (!firstSaved) return;
    // The editor stays usable while the first PUT is in flight. Flush once
    // more at this decision point so text typed during that request is also
    // confirmed. If yet another edit arrives during this bounded second pass,
    // abort instead of opening stale History or waiting forever.
    if (pendingRef.current?.id === id) {
      const secondSaved = await flushPendingRef.current();
      if (
        historyOpenRequestRef.current !== request ||
        selectedIdRef.current !== id
      )
        return;
      // Keep the wait bounded at two saves. A third edit is materialized for
      // crash recovery and normal autosave, then the final dirty check below
      // aborts this History opening instead of waiting indefinitely.
      editorFlushRef.current();
      if (!secondSaved) return;
    }
    if (
      pendingRef.current?.id === id ||
      editorDirtyRef.current === id
    )
      return;
    const owner = startDialogFocus(invoker);
    setHistoryBaseRevision(revisionsRef.current.get(id) ?? "");
    setHistoryDialog({ open: true, owner });
  }, [startDialogFocus]);
  useEffect(() => {
    let es: EventSource | null = null;
    let t: ReturnType<typeof setTimeout>;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    // The browser only auto-retries a dropped connection. An HTTP error or a
    // non-stream response — nginx answering 502 while a deploy restarts the
    // server — moves the EventSource to CLOSED permanently, which used to
    // kill live-sync for the rest of the tab's life. Recreate it ourselves
    // with backoff; `hasOpened` survives recreation, so the first successful
    // reopen still runs the reconcile pass.
    let reconnectDelay = 1_000;
    let disposed = false;
    let hasOpened = false;
    let reconciling = false;
    let reconcileAgain = false;

    const reconcile = async (options?: { skipInflightLoad?: boolean }) => {
      if (reconciling) {
        reconcileAgain = true;
        return;
      }
      reconciling = true;
      try {
        await refreshTree();
        const cur = selectedIdRef.current;
        if (
          cur &&
          pendingRef.current?.id !== cur &&
          editorDirtyRef.current !== cur &&
          !coverQueueRef.current.has(cur) &&
          !(options?.skipInflightLoad && pageLoadInflightRef.current === cur)
        )
          await reloadCurrent(cur);
      } catch {
        // EventSource keeps reconnecting. The next successful open retries this.
      } finally {
        reconciling = false;
        if (reconcileAgain) {
          reconcileAgain = false;
          void reconcile();
        }
      }
    };

    // A reopen after the server restarted is the moment to ask which build it
    // runs now. Once per effect lifetime, and the once is reserved BEFORE the
    // awaits: a restart drops the stream more than once, so two reopens land
    // close together and both would otherwise reach showToast. A "no", or an
    // ask that fails (offline, nginx still answering 502), hands the
    // reservation back so the next reopen asks again.
    let redeployNoticed = false;
    const noticeRedeploy = async () => {
      if (redeployNoticed) return;
      redeployNoticed = true;
      let differs = false;
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (response.ok) differs = serverBuildDiffers(await response.json());
      } catch {
        // offline: the stale-chunk recovery handles the next navigation
      }
      if (!differs) {
        redeployNoticed = false;
        return;
      }
      if (disposed) return;
      showToast("Brain was updated", {
        actionLabel: "Reload",
        onAction: () => window.location.reload(),
        durationMs: REDEPLOY_TOAST_MS,
      });
    };

    const connect = () => {
      if (disposed) return;
      const source = new EventSource("/api/events");
      es = source;
      source.onopen = () => {
        reconnectDelay = 1_000;
        if (hasOpened) {
          void reconcile();
          void noticeRedeploy();
        }
        hasOpened = true;
      };
      // Listener registration happens after the initial RSC/page read. A first
      // reconcile closes the gap where a mutation could otherwise be missed.
      // The open page is exempt while its own load is still in flight — that
      // GET already returns the current body, a second one would be a double.
      source.addEventListener(
        "ready",
        () => void reconcile({ skipInflightLoad: true }),
      );
      source.addEventListener("reconcile", () => void reconcile());
      source.onerror = () => {
        // CONNECTING means the browser is already retrying on its own.
        if (disposed || source.readyState !== EventSource.CLOSED) return;
        source.close();
        if (es === source) es = null;
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      };
      source.onmessage = (e) => {
      let ev: { type: string; id: string; rev?: string; src?: string };
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      // our own write echoed back — this tab already holds that state
      if (ev.src === CLIENT_ID) return;
      clearTimeout(t);
      t = setTimeout(() => void refreshTree().catch(() => {}), 500);
      const cur = selectedIdRef.current;
      if (
        cur !== ev.id ||
        pendingRef.current?.id === cur ||
        editorDirtyRef.current === cur ||
        coverQueueRef.current.has(cur)
      )
        return;
      // the event carries the resulting rev — skip the GET when we have it
      if (ev.rev && ev.rev === revisionsRef.current.get(cur)) return;
      void reloadCurrent(cur).catch(() => {});
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(t);
      clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [refreshTree, reloadCurrent, showToast]);

  const select = useCallback((id: string, target?: SearchTextTarget) => {
    const requestId = ++searchHighlightRequestRef.current;
    const nextSearchHighlight = target
      ? { requestId, pageId: id, target }
      : null;
    searchHighlightRef.current = nextSearchHighlight;
    setSearchHighlight(nextSearchHighlight);
    historyOpenRequestRef.current += 1;
    editorFlushRef.current();
    flushPendingRef.current();
    setSelectedId(id);
    setMailOpen(false);
    setSmartPreview(null);
    editorContextTargetRef.current = null;
    setEditorContextTargetId(null);
    editorContextPageRefRef.current = null;
    setEditorContextPageRef(null);
    setMobilePagesOpen(false);
    rememberRecent(id);
    window.history.pushState({}, "", `/p/${id}`);
    try {
      localStorage.setItem("brain-last-opened", id);
    } catch {}
  }, [rememberRecent, setMailOpen, setSelectedId]);

  const goHome = useCallback(() => {
    clearSearchHighlightIntent();
    historyOpenRequestRef.current += 1;
    editorFlushRef.current();
    flushPendingRef.current();
    setSelectedId(null);
    setMailOpen(false);
    setSmartPreview(null);
    editorContextTargetRef.current = null;
    setEditorContextTargetId(null);
    editorContextPageRefRef.current = null;
    setEditorContextPageRef(null);
    setMobilePagesOpen(false);
    window.history.pushState({}, "", "/");
  }, [clearSearchHighlightIntent, setMailOpen, setSelectedId]);

  const openMail = useCallback(() => {
    clearSearchHighlightIntent();
    historyOpenRequestRef.current += 1;
    editorFlushRef.current();
    flushPendingRef.current();
    setSelectedId(null);
    setMailOpen(true);
    setSmartPreview(null);
    editorContextTargetRef.current = null;
    setEditorContextTargetId(null);
    editorContextPageRefRef.current = null;
    setEditorContextPageRef(null);
    setMobilePagesOpen(false);
    if (window.location.pathname !== "/mail") {
      window.history.pushState({}, "", "/mail");
    }
  }, [clearSearchHighlightIntent, setMailOpen, setSelectedId]);

  // browser back/forward moves between pages, mail, and settings
  useEffect(() => {
    const onPop = () => {
      clearSearchHighlightIntent();
      historyOpenRequestRef.current += 1;
      editorFlushRef.current();
      flushPendingRef.current();
      setSmartPreview(null);
      const wasSettings = surfaceRef.current === "settings";
      const settingsTarget = parseSettingsPath(location.pathname);
      if (settingsTarget !== undefined) {
        // /settings or /settings/<section>. Desktop has no root list — a
        // popstate landing on the bare /settings normalises to appearance.
        let nextSection = settingsTarget;
        if (
          nextSection === null &&
          !window.matchMedia("(max-width: 767px)").matches
        ) {
          nextSection = "appearance";
          window.history.replaceState({}, "", settingsPath(nextSection));
        }
        // a forward-revisit re-enters over an in-app entry, so Back keeps
        // working as "leave settings"
        settingsEnteredInAppRef.current = true;
        if (!wasSettings) {
          settingsOpenedFromPagesRef.current = mobilePagesOpenRef.current;
        }
        setMailSettingsAccountId(
          nextSection === "mail"
            ? new URLSearchParams(location.search).get("account")
            : null,
        );
        dispatchNavigationPresence({
          type: "surface",
          surface: "settings",
          settingsSection: nextSection,
        });
        setSelectedId(null);
        setMobilePagesOpen(false);
        return;
      }
      const nextMailOpen = location.pathname === "/mail";
      const m = location.pathname.match(/^\/p\/([\w-]+)/);
      const nextSelectedId = !nextMailOpen && m ? m[1] : null;
      const pageChanged = nextSelectedId !== selectedIdRef.current;
      setSelectedId(nextSelectedId);
      setMailOpen(nextMailOpen);
      if (wasSettings) {
        settingsDrilledFromRootRef.current = false;
        const restorePages = settingsOpenedFromPagesRef.current;
        settingsOpenedFromPagesRef.current = false;
        if (restorePages) {
          setMobilePagesOpen(true);
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              const gear = Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  '[data-settings-trigger="mobile-pages"]',
                ),
              ).find(isVisibleFocusTarget);
              if (gear) gear.focus({ preventScroll: true });
            });
          });
          return;
        }
        // leaving settings returns focus the way the dialog did: the
        // Settings row, else the Pages tab — retried over a few frames while
        // that chrome slides back in — else the main region
        let attemptsLeft = 24;
        const focusReturnTarget = () => {
          const target = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              '[data-settings-trigger="desktop"], [data-mobile-tab="pages"]',
            ),
          ).find(isVisibleFocusTarget);
          if (target) {
            target.focus({ preventScroll: true });
            return;
          }
          attemptsLeft -= 1;
          if (attemptsLeft > 0) {
            window.requestAnimationFrame(focusReturnTarget);
            return;
          }
          if (isVisibleFocusTarget(mainRef.current)) {
            mainRef.current.focus({ preventScroll: true });
          }
        };
        window.requestAnimationFrame(focusReturnTarget);
        return;
      }
      if (pageChanged) setMobilePagesOpen(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [clearSearchHighlightIntent, setMailOpen, setSelectedId]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  // ── load selected page ──────────────────────────────
  useEffect(() => {
    let live = true;
    // Aborts the in-flight GET when the effect re-runs or unmounts. The
    // `live` guard in the catch keeps a cleanup abort silent — only the
    // 12s timeout below may surface the retry Empty state.
    const loadAbort = new AbortController();
    const frame = requestAnimationFrame(() => {
      if (!selectedId) {
        pageLoadInflightRef.current = null;
        setPage(null);
        return;
      }
      setSave("idle");
      let storedDraft: StoredDraft | null = null;
      let storedDraftSource: string | null = null;
      let storedDraftSourceRaw: string | null = null;
      const storedStickerDraft = loadStickerDraft(localStorage, selectedId);
      try {
        const ownKey = draftStorageKey(selectedId);
        const own = localStorage.getItem(ownKey);
        if (own !== null) {
          storedDraft = decodeDraft(own);
          storedDraftSource = ownKey;
          storedDraftSourceRaw = own;
        } else {
          const legacyKey = legacyDraftStorageKey(selectedId);
          const legacy = localStorage.getItem(legacyKey);
          if (legacy !== null) {
            storedDraft = decodeDraft(legacy);
            storedDraftSource = legacyKey;
            storedDraftSourceRaw = legacy;
          } else {
            // A closed/crashed tab leaves its tab-scoped localStorage draft. Do
            // not discard it: recover the newest candidate into this tab while
            // leaving every other operation intact until a server confirmation.
            const candidates: Array<{
              key: string;
              raw: string;
              draft: StoredDraft;
            }> = [];
            const prefix = draftStoragePrefix(selectedId);
            for (let i = 0; i < localStorage.length; i += 1) {
              const key = localStorage.key(i);
              if (!key?.startsWith(prefix)) continue;
              const raw = localStorage.getItem(key);
              if (raw !== null) {
                candidates.push({ key, raw, draft: decodeDraft(raw) });
              }
            }
            candidates.sort(
              (a, b) => (b.draft.updatedAt ?? 0) - (a.draft.updatedAt ?? 0),
            );
            if (candidates[0]) {
              storedDraft = candidates[0].draft;
              storedDraftSource = candidates[0].key;
              storedDraftSourceRaw = candidates[0].raw;
            }
          }
        }
      } catch {}
      if (storedDraft) {
      const operationId = storedDraft.operationId ?? nextSaveOperation();
      pendingRef.current = { id: selectedId, md: storedDraft.markdown, operationId };
      if (storedDraft.conflicted) {
        conflictedPagesRef.current.add(selectedId);
        setSave("conflict");
      }
      // A legacy draft has no trustworthy base revision. Empty rev forces a
      // safe 409 instead of allowing it to overwrite newer server content.
      revisionsRef.current.set(selectedId, storedDraft.revision ?? "");
      if (storedDraft.baseMarkdown !== null) {
        baseMarkdownRef.current.set(selectedId, storedDraft.baseMarkdown);
      } else {
        baseMarkdownRef.current.delete(selectedId);
      }
      const ownKey = draftStorageKey(selectedId);
      const sources =
        storedDraftSource !== null &&
        storedDraftSource !== ownKey &&
        storedDraft.operationId !== null
          ? mergeDraftSources(storedDraft.sources, {
              key: storedDraftSource,
              operationId: storedDraft.operationId,
            })
          : storedDraft.sources;
      const persisted = persistDraft(
        localStorage,
        ownKey,
        storedDraft.markdown,
        storedDraft.revision ?? "",
        operationId,
        storedDraft.updatedAt ?? Date.now(),
        storedDraft.baseMarkdown,
        storedDraft.conflicted,
        sources,
      );
      if (persisted) clearLocalRecoveryUnavailable(selectedId);
      else markLocalRecoveryUnavailable(selectedId);
      if (
        persisted &&
        storedDraft.operationId === null &&
        storedDraftSource !== null &&
        storedDraftSource !== ownKey &&
        storedDraftSourceRaw !== null
      ) {
        try {
          if (localStorage.getItem(storedDraftSource) === storedDraftSourceRaw) {
            localStorage.removeItem(storedDraftSource);
          }
        } catch {}
      }
      }
      // instant paint from cache; a cold page shows the skeleton
      const cached = pageCache.current.get(selectedId);
      if (cached) {
      setPage(
        storedDraft || storedStickerDraft
          ? {
              ...cached,
              ...(storedDraft ? { markdown: storedDraft.markdown } : {}),
              ...(storedStickerDraft
                ? { stickers: storedStickerDraft.stickers }
                : {}),
            }
          : cached,
      );
      if (!storedDraft) {
        revisionsRef.current.set(selectedId, cached.rev);
        baseMarkdownRef.current.set(selectedId, cached.markdown);
      }
      } else {
        setPage(null);
      }
      // always revalidate against the server
      const revisionAtRevalidation = revisionsRef.current.get(selectedId);
      const loadSignal = AbortSignal.any([
        loadAbort.signal,
        AbortSignal.timeout(12_000),
      ]);
      const fetchPage = (): Promise<LoadedPage> =>
        apiFetch(`/api/page/${selectedId}`, { signal: loadSignal })
          .then((r) =>
            r.ok
              ? r.json()
              : Promise.reject(
                  Object.assign(new Error(`page load failed: ${r.status}`), {
                    status: r.status,
                  }),
                ),
          )
          .then((p) => loadedPageFromResponse(selectedId, p));
      // A hover prefetch already on the wire is adopted, not duplicated. One
      // that resolved empty (non-OK, network) falls through to a real GET so
      // the error state still carries the status.
      const inflightPrefetch = prefetchInflight.current.get(selectedId);
      pageLoadInflightRef.current = selectedId;
      (inflightPrefetch
        ? adoptPrefetch(inflightPrefetch, loadSignal).then(
            (loaded) => loaded ?? fetchPage(),
          )
        : fetchPage()
      )
      .then((serverLoaded) => {
        if (!live) return;
        if (
          revisionsRef.current.get(selectedId) !== revisionAtRevalidation
        )
          return;
        const visibleLoaded = storedStickerDraft
          ? { ...serverLoaded, stickers: storedStickerDraft.stickers }
          : serverLoaded;
        coverConfirmedRef.current.set(selectedId, serverLoaded.cover);
        // The cache is server-authoritative. Local drafts stay in localStorage
        // and pendingRef until a response confirms that exact body.
        cachePut(serverLoaded);
        // A cached editor is interactive while this revalidation is in flight.
        // Turn the synchronous dirty marker into a real draft before deciding
        // whether a newer server body may replace the live editor.
        if (
          cached &&
          selectedIdRef.current === selectedId &&
          editorDirtyRef.current === selectedId
        ) {
          editorFlushRef.current();
        }
        const pending =
          pendingRef.current?.id === selectedId ? pendingRef.current : null;
        if (pending) {
          // Old drafts did not retain a base body. It is safe to recover one
          // only when their full revision still matches this exact response or
          // when the draft already equals the server body. Any other case stays
          // a real conflict rather than guessing over somebody else's text.
          if (
            !baseMarkdownRef.current.has(selectedId) &&
            (storedDraft?.revision === serverLoaded.rev ||
              (storedDraft !== null &&
                canonicalPageMarkdown(storedDraft.markdown) === serverLoaded.markdown))
          ) {
            baseMarkdownRef.current.set(selectedId, serverLoaded.markdown);
          }
          // Older releases permanently latched a draft after any 409. Recheck
          // that latch on a later clean load: metadata-only changes and an
          // already-committed local body can safely resume normal autosave.
          // A different server body remains a real conflict and is never
          // overwritten automatically.
          if (
            storedDraft?.conflicted === true &&
            conflictedPagesRef.current.has(selectedId) &&
            canResumeConflictedDraft(
              {
                markdown: pending.md,
                baseMarkdown:
                  baseMarkdownRef.current.get(selectedId) ??
                  storedDraft.baseMarkdown,
              },
              serverLoaded.markdown,
            )
          ) {
            conflictedPagesRef.current.delete(selectedId);
            revisionsRef.current.set(selectedId, serverLoaded.rev);
            baseMarkdownRef.current.set(selectedId, serverLoaded.markdown);
            const persisted = persistDraft(
              localStorage,
              draftStorageKey(selectedId),
              pending.md,
              serverLoaded.rev,
              pending.operationId,
              Date.now(),
              serverLoaded.markdown,
              false,
              draftSourcesForOperation(selectedId, pending.operationId),
            );
            if (persisted) clearLocalRecoveryUnavailable(selectedId);
            else markLocalRecoveryUnavailable(selectedId);
            if (selectedIdRef.current === selectedId) setSave("saving");
          }
          if (!cached) {
            setPage({
              ...visibleLoaded,
              markdown: pending.md,
              rev: revisionsRef.current.get(selectedId) ?? "",
            });
          }
          if (!conflictedPagesRef.current.has(selectedId)) {
            showToast("Recovered unsaved draft");
          }
          // Equality with the current server body is not proof that this edit
          // is confirmed: an older cross-tab request may still be in flight
          // (A-B-A). Reserve a real serialized save before cleanup.
          if (!conflictedPagesRef.current.has(selectedId)) {
            queueMicrotask(() => {
              if (
                pendingRef.current?.id === selectedId &&
                pendingRef.current.operationId === pending.operationId
              )
                flushPendingRef.current();
            });
          }
          return;
        }
        // If the editor could not serialize yet, preserving its live document
        // is safer than remounting it. The listener will retry on blur/save.
        if (editorDirtyRef.current === selectedId) return;
        revisionsRef.current.set(selectedId, serverLoaded.rev);
        baseMarkdownRef.current.set(selectedId, serverLoaded.markdown);
        // cached and unchanged → the editor already shows it, skip the remount
        if (
          cached &&
          cached.rev === serverLoaded.rev &&
          cached.markdown === serverLoaded.markdown
        )
          return;
        setPage(visibleLoaded);
        if (cached) setEditorEpoch((e) => e + 1); // content changed under a live key
        })
        .catch((error: unknown) => {
          if (!live || selectedIdRef.current !== selectedId) return;
          // A cached body keeps rendering and the SSE reconcile retries it
          // later. Only a cold page would otherwise sit on the skeleton
          // forever with nothing to click.
          if (cached) return;
          const status = (error as { status?: unknown }).status;
          setPageLoadError({
            id: selectedId,
            status: typeof status === "number" ? status : null,
          });
        })
        .finally(() => {
          // A superseded load (new id, retry) already re-armed the marker.
          if (live) pageLoadInflightRef.current = null;
        });
    });
    return () => {
      live = false;
      loadAbort.abort();
      cancelAnimationFrame(frame);
    };
  }, [
    selectedId,
    // Try again bumps the attempt counter to re-run this load for the same id.
    pageLoadAttempt,
    showToast,
    cachePut,
    clearLocalRecoveryUnavailable,
    markLocalRecoveryUnavailable,
    nextSaveOperation,
  ]);

  // ── autosave ────────────────────────────────────────
  const doSave = useCallback(
    (
      id: string,
      md: string,
      operationId: string,
      prerequisite?: Promise<boolean>,
    ): Promise<boolean> => {
      const operationKey = saveOperationKey(id, operationId);
      const queued = queuedSaveRef.current.get(operationKey);
      if (queued) return queued.promise;

      const promise = saveQueueRef.current.run(id, async () => {
        // A real body conflict is terminal for PUTs to this original page.
        // New edits still replace the local draft and can be recovered as a
        // sibling, but background/queued saves must stay fail-closed.
        if (conflictedPagesRef.current.has(id)) {
          return false;
        }
        // Programmatic rewrites reserve their position immediately after the
        // edit visible when the action was invoked. If that edit fails, the
        // rewrite is skipped; edits typed later are already queued after it.
        if (prerequisite && !(await prerequisite)) return false;
        try {
          const revision = await saveMarkdown({
            fetcher: apiFetch,
            id,
            markdown: md,
            getRevision: () => revisionsRef.current.get(id) ?? "",
            setRevision: (next) => revisionsRef.current.set(id, next),
            getBaseMarkdown: () => baseMarkdownRef.current.get(id),
            setBaseMarkdown: (next) => baseMarkdownRef.current.set(id, next),
          });
          setPage((current) =>
            current?.id === id ? { ...current, rev: revision } : current,
          );
          const currentPending =
            pendingRef.current?.id === id ? pendingRef.current : null;
          const isCurrentOperation =
            !currentPending || currentPending.operationId === operationId;
          if (selectedIdRef.current === id && isCurrentOperation) setSave("saved");
          // Keep the server-authoritative cache current. The operation identity
          // below, rather than markdown equality, decides draft cleanup.
          const prev = pageCache.current.get(id);
          if (prev) cachePut({ ...prev, markdown: md, rev: revision });
          const newerPending =
            pendingRef.current?.id === id ? pendingRef.current : null;
          if (newerPending && newerPending.operationId !== operationId) {
            const sources = draftSourcesForOperation(
              id,
              newerPending.operationId,
            );
            const persisted = persistDraft(
              localStorage,
              draftStorageKey(id),
              newerPending.md,
              revision,
              newerPending.operationId,
              Date.now(),
              canonicalPageMarkdown(md),
              false,
              sources,
            );
            if (persisted) clearLocalRecoveryUnavailable(id);
            else markLocalRecoveryUnavailable(id);
          }
          if (
            pendingRef.current?.id === id &&
            pendingRef.current.operationId === operationId
          ) {
            pendingRef.current = null;
            if (editorDirtyRef.current === id) editorDirtyRef.current = null;
          }
          clearDraftOperation(id, operationId);
          if (isCurrentOperation && !newerPending) {
            clearLocalRecoveryUnavailable(id);
          }
          if (selectedIdRef.current === id && isCurrentOperation) {
            setTimeout(() => setSave((s) => (s === "saved" ? "idle" : s)), 1200);
          }
          return true;
        } catch (error) {
          const currentPending =
            pendingRef.current?.id === id ? pendingRef.current : null;
          if (error instanceof SaveRequestError && error.status === 409) {
            conflictedPagesRef.current.add(id);
            const latest = currentPending ?? { id, md, operationId };
            const latched = latchDraftConflict(
              localStorage,
              draftStorageKey(id),
              {
                markdown: latest.md,
                revision: revisionsRef.current.get(id) ?? "",
                operationId: latest.operationId,
                updatedAt: Date.now(),
                baseMarkdown: baseMarkdownRef.current.get(id) ?? null,
                sources: draftSourcesForOperation(id, latest.operationId),
              },
            );
            if (latched.persisted) clearLocalRecoveryUnavailable(id);
            else markLocalRecoveryUnavailable(id);
            if (selectedIdRef.current === id) setSave("conflict");
            return false;
          }
          if (
            selectedIdRef.current === id &&
            (!currentPending || currentPending.operationId === operationId)
          )
            setSave("error");
          return false;
        }
      });
      queuedSaveRef.current.set(operationKey, { id, promise });
      void promise.finally(() => {
        if (queuedSaveRef.current.get(operationKey)?.promise === promise) {
          queuedSaveRef.current.delete(operationKey);
        }
      });
      return promise;
    },
    [
      cachePut,
      clearDraftOperation,
      clearLocalRecoveryUnavailable,
      markLocalRecoveryUnavailable,
    ],
  );

  useEffect(() => {
    flushPendingRef.current = () => {
      const pending = pendingRef.current;
      if (!pending) return Promise.resolve(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      return doSave(pending.id, pending.md, pending.operationId);
    };
  }, [doSave]);

  // Every navigation path, including internal setSelectedId calls, flushes the
  // page being left before the next editor can start producing changes.
  useEffect(
    () => () => {
      flushPendingRef.current();
    },
    [selectedId],
  );

  const mapPageRefUndoThroughEdit = useCallback(
    (pageId: string, markdown: string) => {
      const undo = pageRefUndoRef.current;
      if (!undo || undo.sourcePageId !== pageId) return;
      const mappedOffset =
        undo.restorePoint === null
          ? null
          : mapMarkdownOffset(
              undo.mappedMarkdown,
              markdown,
              undo.restorePoint.insertionOffset,
            );
      pageRefUndoRef.current = {
        ...undo,
        mappedMarkdown: markdown,
        restorePoint:
          undo.restorePoint === null || mappedOffset === null
            ? null
            : { ...undo.restorePoint, insertionOffset: mappedOffset },
      };
    },
    [],
  );

  const onChange = useCallback(
    (pageId: string, md: string) => {
      // A page switch intentionally defers the next load to the following
      // frame. The old editor may still deliver one final transaction during
      // that gap; bind edits to the page that rendered the editor and reject
      // them once selection has moved so A can never become a draft/save for B.
      if (selectedIdRef.current !== pageId) return;
      const undo = pageRefUndoRef.current;
      if (undo?.sourcePageId === pageId && undo.status === "restoring") return;
      const conflicted = conflictedPagesRef.current.has(pageId);
      mapPageRefUndoThroughEdit(pageId, md);
      // Keep the local body and editor value aligned with the real Markdown.
      // Page hierarchy no longer synthesizes or deletes references implicitly.
      setPage((p) =>
        p?.id === pageId && p.markdown !== md ? { ...p, markdown: md } : p,
      );
      // record the unsaved body: a crash-recovery draft + a flush target on unload
      const previousPending =
        pendingRef.current?.id === pageId ? pendingRef.current : null;
      const operationId = nextSaveOperation();
      const sources = previousPending
        ? draftSourcesForOperation(pageId, previousPending.operationId)
        : [];
      pendingRef.current = { id: pageId, md, operationId };
      const persisted = persistDraft(
        localStorage,
        draftStorageKey(pageId),
        md,
        revisionsRef.current.get(pageId) ?? "",
        operationId,
        Date.now(),
        baseMarkdownRef.current.get(pageId) ?? null,
        conflicted,
        sources,
      );
      if (persisted) clearLocalRecoveryUnavailable(pageId);
      else markLocalRecoveryUnavailable(pageId);
      if (conflicted) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        setSave("conflict");
        return;
      }
      setSave("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(
        () => doSave(pageId, md, operationId),
        700,
      );
    },
    [
      clearLocalRecoveryUnavailable,
      doSave,
      mapPageRefUndoThroughEdit,
      markLocalRecoveryUnavailable,
      nextSaveOperation,
    ],
  );

  // Save as soon as the tab backgrounds. pagehide adds a keepalive fallback;
  // the local draft remains until a confirmed response, so a hard close can be
  // recovered even when the browser terminates the request.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        editorFlushRef.current();
        flushPendingRef.current();
      }
    };
    const onOnline = () => {
      editorFlushRef.current();
      flushPendingRef.current();
    };
    const flushKeepalive = () => {
      editorFlushRef.current();
      const p = pendingRef.current;
      if (!p) return;
      if (conflictedPagesRef.current.has(p.id)) return;
      if (saveQueueRef.current.has(p.id)) return;
      void apiFetch(`/api/page/${p.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: encodeSaveRequest(
            p.md,
            revisionsRef.current.get(p.id) ?? "",
            baseMarkdownRef.current.get(p.id),
            60 * 1024,
          ),
          keepalive: true, // survives the unload
        }).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", flushKeepalive);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", flushKeepalive);
    };
  }, []);

  // ── mutations ───────────────────────────────────────
  const requestCreatePage = useCallback(
    async (
      parentId: string | null,
      template?: Template,
    ): Promise<CreatedPageRef | null> => {
      const body: Record<string, unknown> = { parentId, title: template?.title ?? "Untitled" };
      if (template && template.id !== "blank") {
        body.markdown = template.markdown;
        if (template.emoji) body.icon = template.emoji;
      }
      let r: Response;
      try {
        r = await apiFetch("/api/page", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        showToast("Couldn't create page");
        return null;
      }
      if (!r.ok) {
        showToast("Couldn't create page");
        return null;
      }
      let meta: CreatedPageRef;
      try {
        meta = (await r.json()) as CreatedPageRef;
        if (!meta.id || !meta.title) throw new Error("invalid page metadata");
      } catch {
        showToast("Couldn't confirm page creation. Refresh before retrying");
        return null;
      }
      return meta;
    },
    [showToast],
  );

  const createPage = useCallback(
    async (
      parentId: string | null,
      template?: Template,
      options?: { selectCreated?: boolean },
    ) => {
      if (
        blockConflictMutation(
          [selectedIdRef.current, parentId],
          "Save a copy before adding a child page.",
        )
      )
        return null;
      if (options?.selectCreated !== false) {
        editorFlushRef.current();
        flushPendingRef.current();
      }
      const meta = await requestCreatePage(parentId, template);
      if (!meta) return null;
      await refreshTree();
      if (parentId) setExpanded((s) => new Set(s).add(parentId));
      if (options?.selectCreated === false) return meta.id;
      // The request may have been slow enough for another editor transaction.
      // Flush once more at the exact navigation boundary, then use the common
      // selection path so URL/history and draft guarantees stay consistent.
      editorFlushRef.current();
      flushPendingRef.current();
      select(meta.id);
      // a template drops you into the body; a blank page focuses the title
      if (!template || template.id === "blank") setFocusTitleId(meta.id);
      return meta.id;
    },
    [blockConflictMutation, refreshTree, requestCreatePage, select],
  );

  const createPageFromSlash = useCallback(
    async (insertPageRef: (page: CreatedPageRef) => boolean) => {
      const parentId = selectedIdRef.current;
      if (!parentId) return;
      if (blockConflictMutation(parentId, "Save a copy before adding a child page."))
        return;

      // This flow deliberately defers refreshTree: a structural refresh would
      // auto-append the unlinked child and remount Milkdown before the slash
      // position can be replaced.
      const meta = await requestCreatePage(parentId);
      if (!meta) return;
      const refreshCreatedPage = async () => {
        try {
          await refreshTree();
          setExpanded((current) => new Set(current).add(parentId));
          return true;
        } catch {
          return false;
        }
      };
      if (
        selectedIdRef.current !== parentId ||
        !insertPageRef(meta)
      ) {
        void refreshCreatedPage().then((refreshed) => {
          if (selectedIdRef.current === parentId) {
            showToast(
              refreshed
                ? "Page created, but couldn't place it at the cursor"
                : "Page created. Refresh to update the sidebar",
            );
          }
        });
        return;
      }

      // Serialize the inserted page-ref synchronously, then await that exact
      // parent save before a tree refresh or navigation can tear down Milkdown.
      editorFlushRef.current();
      const pending =
        pendingRef.current?.id === parentId ? pendingRef.current : null;
      if (!pending) {
        void refreshCreatedPage().then((refreshed) => {
          showToast(
            refreshed
              ? "Page created, but couldn't save its link"
              : "Page created. Refresh to update the sidebar",
          );
        });
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const saved = await doSave(
        parentId,
        pending.md,
        pending.operationId,
      );
      if (!saved) {
        showToast(
          localRecoveryUnavailableRef.current.has(parentId)
            ? LOCAL_RECOVERY_UNAVAILABLE
            : "Page created. Its link is safe in your local draft",
        );
        void refreshCreatedPage();
        return;
      }
      if (selectedIdRef.current === parentId) {
        select(meta.id);
        setFocusTitleId(meta.id);
      }
      void refreshCreatedPage().then((refreshed) => {
        if (!refreshed) {
          showToast("Page created. Refresh to update the sidebar");
        }
      });
    },
    [
      blockConflictMutation,
      doSave,
      refreshTree,
      requestCreatePage,
      select,
      showToast,
    ],
  );

  const openingDailyRef = useRef<Promise<void> | null>(null);
  const openDailyPage = useCallback(
    (date = formatLocalISODate(new Date())) => {
      if (openingDailyRef.current) return openingDailyRef.current;

      const task = (async () => {
        let dailyParent = findDailyParent(tree);

        if (!dailyParent) {
          const parentId = await createPage(null, DAILY_PARENT_TEMPLATE, {
            selectCreated: false,
          });
          if (!parentId) return;

          const nextTree = await refreshTree();
          dailyParent = findDailyParent(nextTree);
          const existing = dailyParent ? findDailyChild(dailyParent, date) : null;
          if (existing) {
            setExpanded((s) => new Set(s).add(existing.parentId ?? parentId));
            select(existing.id);
            return;
          }

          const createdId = await createPage(
            dailyParent?.id ?? parentId,
            dailyTemplateFor(date),
            { selectCreated: false },
          );
          if (createdId) {
            setExpanded((s) => new Set(s).add(dailyParent?.id ?? parentId));
            select(createdId);
          }
          return;
        }

        const existing = findDailyChild(dailyParent, date);
        if (existing) {
          setExpanded((s) => new Set(s).add(dailyParent.id));
          select(existing.id);
          return;
        }

        const createdId = await createPage(dailyParent.id, dailyTemplateFor(date), {
          selectCreated: false,
        });
        if (createdId) {
          setExpanded((s) => new Set(s).add(dailyParent.id));
          select(createdId);
        }
      })().finally(() => {
        openingDailyRef.current = null;
      });

      openingDailyRef.current = task;
      return task;
    },
    [createPage, refreshTree, select, tree],
  );

  // App-level shortcuts. Milkdown owns editor formatting keymaps inside the editor.
  // ⌘K opens the command palette; ⌘⌥N creates a top-level blank page.
  // (plain ⌘N is reserved by the browser for a new window, so it never reaches
  //  the page — ⌥ makes it web-safe while keeping the "N = new" mnemonic)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      // ⌘K — match by key (K is never a dead key)
      if (e.key.toLowerCase() === "k" && !e.altKey) {
        e.preventDefault();
        if (paletteOpen) onPaletteOpenChange(false);
        else openPalette();
      }
      // ⌘⌥N — match by physical code: on Mac ⌥N is a dead key so e.key is "Dead",
      // never "n"; e.code stays "KeyN" regardless of modifiers.
      // Nests under the OPEN page — "create new while inside X" means "inside X"
      if (e.code === "KeyN" && e.altKey) {
        e.preventDefault();
        createPage(selectedIdRef.current);
      }
      // ⌘\ — focus mode is desktop-only; mobile has no sidebar to hide.
      if (e.code === "Backslash" || e.key === "\\") {
        e.preventDefault();
        if (window.matchMedia("(min-width: 768px)").matches) {
          setFocusMode((on) => !on);
        }
      }
      // ⌘/ — shortcuts cheatsheet.
      if ((e.code === "Slash" || e.key === "/") && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createPage, onPaletteOpenChange, openPalette, paletteOpen]);

  const clearDeleteTimers = useCallback(() => {
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    deleteTimer.current = null;
    countdownTimer.current = null;
  }, []);

  // the page is already soft-deleted server-side (in requestDelete); this just
  // ends the undo window
  const commitDelete = useCallback(() => {
    clearDeleteTimers();
    setPendingDelete(null);
  }, [clearDeleteTimers]);

  // Delete is reflected locally only after the server confirms it. This keeps a
  // failed request from hiding a page or presenting an Undo action for a delete
  // that never happened.
  const requestDelete = useCallback(
    async (id: string, title: string) => {
      const parentId = findPath(treeRef.current, id).at(-1)?.parentId ?? null;
      if (blockConflictMutation([selectedIdRef.current, id, parentId])) return;
      if (deletingRef.current.has(id)) return;
      deletingRef.current.add(id);
      try {
        if (selectedIdRef.current === id) editorFlushRef.current();
        const unsaved = pendingRef.current?.id === id ? pendingRef.current : null;
        if (unsaved) {
          if (timer.current) clearTimeout(timer.current);
          timer.current = null;
          if (!(await doSave(id, unsaved.md, unsaved.operationId))) {
            showToast(
              localRecoveryUnavailableRef.current.has(id)
                ? `Couldn't delete. ${LOCAL_RECOVERY_UNAVAILABLE}`
                : "Couldn't delete. Your unsaved draft is safe.",
            );
            return;
          }
        }
        const response = await apiFetch(`/api/page/${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(String(response.status));
        if (pendingDelete) commitDelete();
        if (pendingRef.current?.id === id) {
          pendingRef.current = null;
          if (timer.current) clearTimeout(timer.current);
          timer.current = null;
          try {
            localStorage.removeItem(draftStorageKey(id));
          } catch {}
        }
        pageCache.current.delete(id);
        revisionsRef.current.delete(id);
        baseMarkdownRef.current.delete(id);
        coverConfirmedRef.current.delete(id);
        coverLatestOperationRef.current.delete(id);
        if (editorDirtyRef.current === id) editorDirtyRef.current = null;
        setTree((current) => removeNode(current, id));
        setSelectedId((current) => (current === id ? null : current));
        setPendingDelete({ id, title });
        setCountdown(7);
        countdownTimer.current = setInterval(
          () => setCountdown((current) => Math.max(0, current - 1)),
          1000,
        );
        deleteTimer.current = setTimeout(() => commitDelete(), 7000);
      } catch {
        showToast("Couldn't move page to trash. Try again.");
      } finally {
        deletingRef.current.delete(id);
      }
    },
    [
      blockConflictMutation,
      pendingDelete,
      commitDelete,
      doSave,
      showToast,
      setSelectedId,
    ],
  );

  const undoDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target) return;
    clearDeleteTimers();
    try {
      const response = await apiFetch(`/api/trash/${target.id}`, { method: "POST" });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      setPendingDelete({ ...target, error: "Couldn't restore. Try again." });
      setCountdown(7);
      countdownTimer.current = setInterval(
        () => setCountdown((current) => Math.max(0, current - 1)),
        1000,
      );
      deleteTimer.current = setTimeout(() => commitDelete(), 7000);
      return;
    }

    setPendingDelete(null);
    try {
      const nextTree = await refreshTree();
      setSelectedId((current) => current ?? firstId(nextTree));
    } catch {
      showToast("Page restored. Refresh to see it.");
    }
  }, [
    pendingDelete,
    clearDeleteTimers,
    refreshTree,
    commitDelete,
    showToast,
    setSelectedId,
  ]);

  // hover pauses the delete timer (Sonner principle)
  const pauseDelete = useCallback(() => clearDeleteTimers(), [clearDeleteTimers]);
  const resumeDelete = useCallback(() => {
    const target = pendingDelete;
    if (!target) return;
    countdownTimer.current = setInterval(
      () => setCountdown((c) => Math.max(0, c - 1)),
      1000,
    );
    deleteTimer.current = setTimeout(() => commitDelete(), countdown * 1000);
  }, [pendingDelete, countdown, commitDelete]);

  /** A structure write can rewrite the destination's body, the old parent's
   *  body, or both. Whichever of them is the open page has to be serialized
   *  and settled first, so the composite Store write can never overtake a
   *  draft the reader has not saved. Any other page returns true untouched. */
  const prepareOpenPageForStructureWrite = useCallback(
    async (destinationId: string) => {
      if (selectedIdRef.current !== destinationId) return true;

      const failClosed = () => {
        showToast("Couldn't save this page. Move cancelled.");
        return false;
      };
      if (coverQueueRef.current.has(destinationId)) return failClosed();

      // A move into the open page writes that page body on the server. First
      // serialize and confirm the local editor so the composite Store write
      // can never overtake an unsaved destination draft.
      editorFlushRef.current();
      if (!(await flushPendingRef.current())) return failClosed();
      if (selectedIdRef.current !== destinationId) return false;

      // The editor remains usable while the first PUT is in flight. Mirror the
      // bounded History preflight: materialize once more and confirm at most
      // one newer draft, then fail closed if edits keep arriving.
      editorFlushRef.current();
      if (pendingRef.current?.id === destinationId) {
        if (!(await flushPendingRef.current())) return failClosed();
        if (selectedIdRef.current !== destinationId) return false;
        editorFlushRef.current();
      }

      // doSave owns the keyed queue, but an already-running operation may have
      // started before this preflight had a pending draft to flush.
      const queued = [...queuedSaveRef.current.values()]
        .filter((entry) => entry.id === destinationId)
        .map((entry) => entry.promise);
      if (queued.length) {
        const results = await Promise.all(queued);
        if (results.some((saved) => !saved)) return failClosed();
        editorFlushRef.current();
      }

      // Let the keyed queue finish retiring whatever it was already running.
      // Without this the page reads as busy for one microtask turn after its
      // save resolved — which is exactly the state a page is in a moment after
      // the editor normalizes it on open.
      await saveQueueRef.current.settled(destinationId);

      if (
        selectedIdRef.current !== destinationId ||
        pendingRef.current?.id === destinationId ||
        editorDirtyRef.current === destinationId ||
        saveQueueRef.current.has(destinationId) ||
        coverQueueRef.current.has(destinationId)
      ) {
        return failClosed();
      }
      return true;
    },
    [showToast],
  );

  // ⌘Z undoes a pending delete while the snackbar is up
  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoDelete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingDelete, undoDelete]);

  const onMove = useCallback(
    async (id: string, newParentId: string | null, beforeId: string | null) => {
      const oldParentId = findPath(treeRef.current, id).at(-1)?.parentId ?? null;
      if (
        blockConflictMutation([
          selectedIdRef.current,
          id,
          oldParentId,
          newParentId,
        ])
      )
        return false;
      const reparenting = oldParentId !== newParentId;
      if (
        reparenting &&
        newParentId !== null &&
        !(await prepareOpenPageForStructureWrite(newParentId))
      ) {
        return false;
      }
      // The old parent's body is the other document this move can edit: a page
      // that leaves stops being listed where it used to be.
      if (
        reparenting &&
        oldParentId !== null &&
        !(await prepareOpenPageForStructureWrite(oldParentId))
      ) {
        return false;
      }
      const previousTree = treeRef.current;
      const oldParentTitle = oldParentId
        ? (findPath(previousTree, oldParentId).at(-1)?.title ?? null)
        : null;
      const optimisticTree = applyMove(previousTree, id, newParentId, beforeId);
      treeRef.current = optimisticTree;
      setTree(optimisticTree); // optimistic — no snap-back
      if (newParentId) setExpanded((s) => new Set(s).add(newParentId));
      let saved = true;
      let unlinkedFrom: string | null = null;
      try {
        const res = await fetchWithDeadline(
          "/api/move",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, newParentId, beforeId }),
          },
          STRUCTURE_MUTATION_TIMEOUT_MS,
        );
        if (!res.ok) throw new Error(String(res.status));
        const payload = (await res.json().catch(() => null)) as {
          unlinkedFrom?: unknown;
        } | null;
        if (typeof payload?.unlinkedFrom === "string") {
          unlinkedFrom = payload.unlinkedFrom;
        }
      } catch {
        // A timeout can lose only the response after the Store has committed.
        // Read server truth before reverting so a successful move is never
        // presented as a failure or accidentally retried.
        const reconciled = await reconcileStructureMutation(
          id,
          newParentId,
          beforeId,
          oldParentId !== newParentId && newParentId !== null,
        );
        saved = reconciled.confirmed;
        const authoritativeTree = reconciled.tree ?? previousTree;
        treeRef.current = authoritativeTree;
        setTree(authoritativeTree);
        if (!saved) showToast("Couldn't move — reverted");
      }
      if (saved && reparenting && selectedIdRef.current !== null) {
        // Whichever of the two documents the reader is looking at, they watch
        // it change rather than find out later that it was stale.
        const open = selectedIdRef.current;
        if (open === newParentId || open === oldParentId) {
          await reloadCurrent(open).catch(() => {});
        }
      }
      // A move that only reorders the tree says nothing. A move that also took
      // a line out of a document does — the reader did not type that edit.
      if (saved && unlinkedFrom && unlinkedFrom !== selectedIdRef.current) {
        showToast(
          oldParentTitle
            ? `Moved — ${oldParentTitle} no longer lists it`
            : "Moved — its old page no longer lists it",
        );
      }
      // The mutation result is authoritative. Reconcile in the background so
      // a large tree (or a transient tree request) cannot keep the confirmed
      // Move dialog visibly busy after the server has already committed.
      void refreshTree().catch(() => {});
      return saved;
    },
    [
      blockConflictMutation,
      prepareOpenPageForStructureWrite,
      refreshTree,
      reloadCurrent,
      showToast,
    ],
  );

  const onReparentPageRef = useCallback(
    (
      dragged: PageRefNestingSource,
      targetId: string,
      scope: PageRefNestingScope = "sibling",
    ): PageRefNestingRequest | null => {
      if (pageRefNestingOperationsRef.current.size > 0) {
        showToast("Finish the current move first");
        return null;
      }
      const pageId = selectedIdRef.current;
      const sourceId = dragged.id;
      const validation = validatePageRefNestingTarget({
        tree: treeRef.current,
        pageId,
        source: dragged,
        targetId,
        scope,
      });
      if (!validation.valid || !pageId) {
        showToast("Can't nest this page here");
        return null;
      }
      const staleDirectChildCleanup = validation.cleanupRetry;
      if (blockConflictMutation([pageId, sourceId, targetId])) return null;

      // Serialize the last transaction and queue the composite mutation behind
      // that exact save immediately. The accepted drop freezes this document,
      // so no later body PUT can overtake the hierarchy + parent-body commit.
      // Serializing a pristine editor can normalize display-only page labels.
      // A real document transaction sets the synchronous dirty latch before the listener's
      // 200 ms delay; a pending body without that latch is passive
      // normalization and is discarded before the structural request.
      const hasDocumentEdit = editorDirtyRef.current === pageId;
      const passivePending =
        !hasDocumentEdit && pendingRef.current?.id === pageId
          ? pendingRef.current
          : null;
      if (passivePending) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        pendingRef.current = null;
        clearDraftOperation(pageId, passivePending.operationId);
        clearLocalRecoveryUnavailable(pageId);
        const authoritativeMarkdown = baseMarkdownRef.current.get(pageId) ?? "";
        setPage((current) =>
          current?.id === pageId
            ? { ...current, markdown: authoritativeMarkdown }
            : current,
        );
        setSave("idle");
      }
      if (hasDocumentEdit) {
        editorFlushRef.current();
      }
      const previousSave = flushPendingRef.current();
      const operationId = nextSaveOperation();

      const adoptParent = (parent: {
        meta: {
          id: string;
          title: string;
          icon?: string;
          cover?: string;
          stickers?: Sticker[];
        };
        markdown: string;
        rev: string;
      }) => {
        if (
          parent?.meta?.id !== pageId ||
          typeof parent.markdown !== "string" ||
          typeof parent.rev !== "string" ||
          !parent.rev
        ) {
          return false;
        }
        const loaded: LoadedPage = {
          id: pageId,
          title: parent.meta.title,
          icon: parent.meta.icon,
          cover: parent.meta.cover,
          stickers: parent.meta.stickers ?? [],
          markdown: parent.markdown,
          rev: parent.rev,
        };
        revisionsRef.current.set(pageId, parent.rev);
        baseMarkdownRef.current.set(pageId, parent.markdown);
        cachePut(loaded);
        if (selectedIdRef.current === pageId) {
          setPage(loaded);
          setEditorEpoch((epoch) => epoch + 1);
        }
        return true;
      };

      const fetchWithDeadline = async (
        input: RequestInfo | URL,
        init: RequestInit = {},
        timeoutMs = 5_000,
      ) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await apiFetch(input, { ...init, signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
      };

      const readAuthoritativeParent = async () => {
        const response = await fetchWithDeadline(
          `/api/page/${pageId}`,
          {},
          2_000,
        );
        if (!response.ok) return null;
        return (await response.json()) as Parameters<typeof adoptParent>[0];
      };

      const fetchTreeSnapshot = async () => {
        const response = await fetchWithDeadline("/api/tree", {}, 2_000);
        if (!response.ok) throw new Error(`Tree request returned ${response.status}`);
        const payload = (await response.json()) as { tree?: TreeNode[] };
        if (!Array.isArray(payload.tree)) throw new Error("Invalid tree response");
        return payload.tree;
      };

      const reconcileLostResponse = async (
        expectedParentRev: string,
        sourceOccurrence: number | null,
        sourceFingerprint: string | null,
        sourceReferenceCountBefore: number,
        sourceFingerprintCountBefore: number,
      ) => {
        // The Store moves the directory before committing the parent body. A
        // tree placement alone is therefore not a commit marker: require the
        // parent revision to advance too. Cleanup-only starts with the source
        // already nested, so also require the selected stale ref to disappear.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const nextTree = await fetchTreeSnapshot();
            const actual = findPath(nextTree, sourceId).at(-1);
            const parent =
              actual?.parentId === targetId
                ? await readAuthoritativeParent()
                : null;
            const authoritativeOccurrences = standalonePageRefOccurrences(
              parent?.markdown ?? "",
              sourceId,
              window.location.origin,
            );
            const cleanupConfirmed =
              !staleDirectChildCleanup ||
              (sourceOccurrence !== null &&
                sourceFingerprint !== null &&
                authoritativeOccurrences.length < sourceReferenceCountBefore &&
                authoritativeOccurrences.filter(
                  (fingerprint) => fingerprint === sourceFingerprint,
                ).length < sourceFingerprintCountBefore);
            if (
              parent?.rev &&
              parent.rev !== expectedParentRev &&
              cleanupConfirmed
            ) {
              treeRef.current = nextTree;
              setTree(nextTree);
              setExpanded((current) => new Set(current).add(targetId));
              return adoptParent(parent);
            }
          } catch {}
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        return false;
      };

      const result = saveQueueRef.current
        .run(pageId, async () => {
          if (!(await previousSave)) {
            showToast("Couldn't move. Your unsaved draft is safe.");
            return false;
          }

          const parentMarkdown = baseMarkdownRef.current.get(pageId) ?? "";
          const expectedParentRev = revisionsRef.current.get(pageId) ?? "";
          const occurrences = standalonePageRefOccurrences(
            parentMarkdown,
            sourceId,
            window.location.origin,
          );
          if (
            occurrences.length > 0 &&
            dragged.occurrence >= occurrences.length
          ) {
            showToast("Page changed. Try the move again.");
            return false;
          }
          const sourceFingerprint =
            occurrences.length === 0
              ? null
              : occurrences[dragged.occurrence] ?? null;
          const sourceOccurrence =
            sourceFingerprint === null ? null : dragged.occurrence;
          const sourceFingerprintCountBefore =
            sourceFingerprint === null
              ? 0
              : occurrences.filter(
                  (fingerprint) => fingerprint === sourceFingerprint,
                ).length;

          let response: Response;
          try {
            response = await fetchWithDeadline(
              "/api/page-ref/nest",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  sourceId,
                  targetId,
                  parentPageId: pageId,
                  expectedParentRev,
                  sourceOccurrence,
                  sourceFingerprint,
                  scope,
                }),
              },
              15_000,
            );
          } catch {
            const reconciled = await reconcileLostResponse(
              expectedParentRev,
              sourceOccurrence,
              sourceFingerprint,
              occurrences.length,
              sourceFingerprintCountBefore,
            );
            if (!reconciled) showToast("Couldn't move. Nothing changed.");
            return reconciled;
          }

          if (!response.ok) {
            if (
              response.status >= 500 &&
              (await reconcileLostResponse(
                expectedParentRev,
                sourceOccurrence,
                sourceFingerprint,
                occurrences.length,
                sourceFingerprintCountBefore,
              ))
            ) {
              return true;
            }
            showToast(
              response.status === 409
                ? "Page changed. Try the move again."
                : "Couldn't move. Nothing changed.",
            );
            return false;
          }

          try {
            const payload = (await response.json()) as {
              parent: Parameters<typeof adoptParent>[0];
            };
            if (
              payload.parent?.rev === expectedParentRev ||
              !adoptParent(payload.parent)
            ) {
              return await reconcileLostResponse(
                expectedParentRev,
                sourceOccurrence,
                sourceFingerprint,
                occurrences.length,
                sourceFingerprintCountBefore,
              );
            }
            // A stale grandparent reference can point at a page that is
            // already under this target. The server only cleans that exact
            // Markdown occurrence, so keep the already-correct tree order.
            const nextTree = staleDirectChildCleanup
              ? treeRef.current
              : applyMove(treeRef.current, sourceId, targetId, null);
            treeRef.current = nextTree;
            setTree(nextTree);
            setExpanded((current) => new Set(current).add(targetId));
            // The response already contains authoritative body + revision; a
            // tree refresh is best-effort and must not keep editing frozen.
            void refreshTree().catch(() => {});
            return true;
          } catch {
            return await reconcileLostResponse(
              expectedParentRev,
              sourceOccurrence,
              sourceFingerprint,
              occurrences.length,
              sourceFingerprintCountBefore,
            );
          }
        })
        .catch(() => {
          showToast("Couldn't move. Nothing changed.");
          return false;
        });

      const operation: PageRefNestingOperation = {
        id: operationId,
        pageId,
        sourceId,
        sourceOccurrence: dragged.occurrence,
        targetId,
        result,
      };
      pageRefNestingOperationsRef.current.set(operationId, operation);
      setNestingEditor({
        pageId,
        sourceId,
        occurrence: dragged.occurrence,
      });
      void result.then(
        () => clearPageRefNesting(operationId),
        () => clearPageRefNesting(operationId),
      );

      return { operationId, result };
    },
    [
      blockConflictMutation,
      cachePut,
      clearDraftOperation,
      clearLocalRecoveryUnavailable,
      clearPageRefNesting,
      nextSaveOperation,
      refreshTree,
      showToast,
    ],
  );

  const onDuplicate = useCallback(
    async (id: string) => {
      const parentId = findPath(treeRef.current, id).at(-1)?.parentId ?? null;
      if (blockConflictMutation([selectedIdRef.current, id, parentId])) return;
      // Duplicate the body the user can currently see, including a final
      // Milkdown transaction that has not reached the autosave debounce yet.
      if (selectedIdRef.current === id) editorFlushRef.current();
      const unsaved = pendingRef.current?.id === id ? pendingRef.current : null;
      if (unsaved) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        if (!(await doSave(id, unsaved.md, unsaved.operationId))) {
          showToast(
            localRecoveryUnavailableRef.current.has(id)
              ? `Couldn't duplicate. ${LOCAL_RECOVERY_UNAVAILABLE}`
              : "Couldn't duplicate. Your unsaved draft is safe.",
          );
          return;
        }
      }
      const before = new Set<string>();
      const collect = (nodes: TreeNode[]) => {
        for (const n of nodes) {
          before.add(n.id);
          collect(n.children);
        }
      };
      collect(tree);
      if (!(await mutate(`/api/page/${id}/duplicate`, { method: "POST" }))) return;
      const next = await refreshTree();
      const findCreated = (nodes: TreeNode[]): string | null => {
        for (const n of nodes) {
          if (!before.has(n.id)) return n.id;
          const found = findCreated(n.children);
          if (found) return found;
        }
        return null;
      };
      const createdId = findCreated(next);
      if (createdId) select(createdId);
    },
    [blockConflictMutation, tree, doSave, mutate, refreshTree, select, showToast],
  );

  const onTogglePin = useCallback(
    async (id: string, pinned: boolean) => {
      if (blockConflictMutation(id)) return;
      if (await mutate(`/api/page/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      }))
        refreshTree();
    },
    [blockConflictMutation, mutate, refreshTree],
  );

  const renamePage = useCallback(
    async (id: string, title: string) => {
      if (blockConflictMutation(id)) throw new Error("rename blocked");
      const previous = findPath(treeRef.current, id).at(-1)?.title ?? "Untitled";
      if (title === previous) return;
      if (selectedIdRef.current === id) {
        setPage((current) =>
          current?.id === id ? { ...current, title } : current,
        );
      }
      const ok = await mutate(`/api/page/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, expected: { title: previous } }),
      });
      if (!ok) {
        if (selectedIdRef.current === id) {
          setPage((current) =>
            current?.id === id ? { ...current, title: previous } : current,
          );
        }
        throw new Error("rename failed");
      }
      // The rename itself is already committed. A transient tree refresh
      // failure must not turn that successful mutation into a false error in
      // the dialog; SSE or the next refresh will reconcile the sidebar.
      void refreshTree().catch(() => {});
    },
    [blockConflictMutation, mutate, refreshTree],
  );

  const copyPageLink = useCallback(
    async (id: string) => {
      try {
        await navigator.clipboard.writeText(`${location.origin}/p/${id}`);
        showToast("Link copied");
      } catch {
        showToast("Couldn't copy. Try again.");
      }
    },
    [showToast],
  );

  // Stable identities for the tree props: the SortableTree memo exists so
  // typing in the editor does not re-render the whole tree, and an inline
  // arrow per render silently defeated it (audit 2026-08-19).
  const onTreeCopyLink = useCallback(
    (id: string) => {
      void copyPageLink(id);
    },
    [copyPageLink],
  );
  const onTreeMoveRequest = useCallback(
    (id: string, title: string, invoker: HTMLElement | null) => {
      const oldParentId = findPath(treeRef.current, id).at(-1)?.parentId ?? null;
      if (blockConflictMutation([selectedIdRef.current, id, oldParentId]))
        return;
      openMoveDialog(id, title, invoker);
    },
    [blockConflictMutation, openMoveDialog],
  );

  const commitTitle = useCallback(
    async (title: string) => {
      if (!page) return false;
      if (title === page.title) return true;
      try {
        await renamePage(page.id, title);
        return true;
      } catch {
        return false;
      }
    },
    [page, renamePage],
  );

  const setIcon = useCallback(
    async (icon: string) => {
      if (!page) return;
      const target = page;
      setPage((current) =>
        current?.id === target.id
          ? { ...current, icon: icon || undefined }
          : current,
      );
      if (await mutate(`/api/page/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icon }),
      }))
        refreshTree();
      else
        setPage((current) =>
          current?.id === target.id
            ? { ...current, icon: target.icon }
            : current,
        );
    },
    [page, mutate, refreshTree],
  );

  const setCover = useCallback(
    async (cover: string) => {
      if (!page) return false;
      const target = page;
      const next = cover || undefined;
      if (!coverQueueRef.current.has(target.id) && target.cover === next) return true;
      if (!coverConfirmedRef.current.has(target.id)) {
        coverConfirmedRef.current.set(target.id, target.cover);
      }
      const operation = ++coverOperationRef.current;
      coverLatestOperationRef.current.set(target.id, operation);
      setPage((current) =>
        selectedIdRef.current === target.id && current?.id === target.id
          ? { ...current, cover: next }
          : current,
      );
      const ok = await coverQueueRef.current.run(target.id, async () => {
        const saved = await mutate(`/api/page/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cover }),
        });
        if (saved) coverConfirmedRef.current.set(target.id, next);
        return saved;
      });
      if (ok) {
        void refreshTree().catch(() => {});
        return true;
      }
      // A failed older request must not roll back a newer optimistic choice.
      if (coverLatestOperationRef.current.get(target.id) === operation) {
        const confirmed = coverConfirmedRef.current.get(target.id);
        setPage((current) =>
          current?.id === target.id ? { ...current, cover: confirmed } : current,
        );
      }
      return false;
    },
    [page, mutate, refreshTree],
  );

  const uploadCover = useCallback(
    async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const r = await apiFetch("/api/upload", { method: "POST", body: fd });
        if (!r.ok) throw new Error(String(r.status));
        const { url } = (await r.json()) as { url?: string };
        if (!url) throw new Error("missing upload url");
        return setCover(url);
      } catch {
        showToast("Couldn't upload cover");
        return false;
      }
    },
    [setCover, showToast],
  );

  const path = useMemo(
    () => (selectedId ? findPath(tree, selectedId) : []),
    [tree, selectedId],
  );
  const currentNode = path.at(-1) ?? null;
  const inheritedShareGrants = resolveInheritedShareGrants(path);
  const inheritedShareRoot = inheritedShareGrants.active;
  const expiredInheritedShareRoot = inheritedShareGrants.expired;
  const activeShareRoot =
    currentNode?.public
      ? currentNode
      : inheritedShareRoot ?? expiredInheritedShareRoot ?? currentNode;
  const inheritedSettingsRoot =
    inheritedShareRoot ?? expiredInheritedShareRoot;
  const currentShareActive = currentNode
    ? isActiveShareGrant(currentNode)
    : false;
  const hasActiveShare = currentShareActive || !!inheritedShareRoot;
  const hasConfiguredShare =
    !!currentNode?.public ||
    !!inheritedShareRoot ||
    !!expiredInheritedShareRoot;
  const shareScopeRevision = useMemo(() => shareTreeRevision(tree), [tree]);
  const saveConflictCopy = useCallback(async () => {
    const sourceId = selectedIdRef.current;
    const sourcePath = sourceId ? findPath(treeRef.current, sourceId) : [];
    const sourceNode = sourcePath.at(-1) ?? null;
    const sourcePage = sourceId ? pageCache.current.get(sourceId) ?? null : null;
    if (
      !sourceId ||
      !conflictedPagesRef.current.has(sourceId) ||
      recoveryCopyId === sourceId
    )
      return;
    if (!sourceNode && !sourcePage) {
      setRecoveryMessage({
        id: sourceId,
        text: localRecoveryUnavailableRef.current.has(sourceId)
          ? LOCAL_RECOVERY_UNAVAILABLE
          : "Couldn't read the page details. Your local draft is still safe.",
      });
      return;
    }

    // Milkdown's normal listener is debounced. Serialize synchronously so the
    // recovery copy contains the exact document visible at the click.
    editorFlushRef.current();
    const draft =
      pendingRef.current?.id === sourceId ? pendingRef.current : null;
    if (!draft) {
      setRecoveryMessage({
        id: sourceId,
        text: "Couldn't read the local draft. Reload this page and try again.",
      });
      return;
    }

    setRecoveryCopyId(sourceId);
    setRecoveryMessage((current) => (current?.id === sourceId ? null : current));
    let copyId: string;
    try {
      const title = sourceNode?.title ?? sourcePage?.title ?? "Recovered page";
      const icon = sourceNode?.icon ?? sourcePage?.icon;
      const cover = sourceNode?.cover ?? sourcePage?.cover;
      const createCopy = (parentId: string | null) =>
        apiFetch("/api/page", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentId,
            title: `${title} (recovered)`,
            markdown: draft.md,
            ...(icon ? { icon } : {}),
            ...(cover ? { cover } : {}),
          }),
        });
      // A generic page cannot be inserted into an imported collection as a
      // row because it has no typed collectionRow metadata. Recover it next to
      // the collection instead, where it remains visible and editable.
      const collectionParent = sourceNode?.collectionRow
        ? sourcePath.at(-2) ?? null
        : null;
      const requestedParent = collectionParent
        ? collectionParent.parentId
        : sourceNode?.parentId ?? null;
      let response = await createCopy(requestedParent);
      // The source or its parent may disappear between the conflict and the
      // explicit recovery click. A root copy is still safe and discoverable.
      if (response.status === 404 && requestedParent !== null) {
        response = await createCopy(null);
      }
      if (!response.ok) throw new Error(`Recovery copy returned ${response.status}`);
      const created = (await response.json()) as { id?: unknown };
      if (typeof created.id !== "string" || !created.id) {
        throw new Error("Recovery copy response did not include an id");
      }
      copyId = created.id;
    } catch {
      if (selectedIdRef.current === sourceId) setSave("conflict");
      setRecoveryMessage({
        id: sourceId,
        text: localRecoveryUnavailableRef.current.has(sourceId)
          ? LOCAL_RECOVERY_UNAVAILABLE
          : "Couldn't save the copy. Your local draft is still safe.",
      });
      setRecoveryCopyId((current) => (current === sourceId ? null : current));
      return;
    }

    // POST 200 is the durability boundary. Only now may this exact operation's
    // draft be removed. If the user typed during the request, the newer draft
    // remains conflicted and gets its own explicit recovery.
    clearDraftOperation(sourceId, draft.operationId);
    let newerStoredDraft = false;
    try {
      const raw = localStorage.getItem(draftStorageKey(sourceId));
      newerStoredDraft =
        raw !== null && decodeDraft(raw).operationId !== draft.operationId;
    } catch {}
    const newerPendingDraft =
      pendingRef.current?.id === sourceId &&
      pendingRef.current.operationId !== draft.operationId;
    const hasNewerDraft = newerStoredDraft || newerPendingDraft;
    if (!hasNewerDraft) {
      if (pendingRef.current?.id === sourceId) pendingRef.current = null;
      if (editorDirtyRef.current === sourceId) editorDirtyRef.current = null;
      conflictedPagesRef.current.delete(sourceId);
      clearLocalRecoveryUnavailable(sourceId);
      if (selectedIdRef.current === sourceId) setSave("saved");
    }
    setRecoveryMessage((current) => (current?.id === sourceId ? null : current));
    setRecoveryCopyId((current) => (current === sourceId ? null : current));
    await refreshTree().catch(() => {});
    if (hasNewerDraft) {
      showToast("Copy saved. Newer edits are still in your local draft.");
      return;
    }
    showToast("Draft saved as a copy");
    if (selectedIdRef.current === sourceId) select(copyId);
  }, [
    clearDraftOperation,
    clearLocalRecoveryUnavailable,
    recoveryCopyId,
    refreshTree,
    select,
    showToast,
  ]);
  const editorContextNode = useMemo(
    () =>
      editorContextTargetId
        ? findPath(tree, editorContextTargetId).at(-1) ?? null
        : null,
    [editorContextTargetId, tree],
  );
  const getEditorContextNode = useCallback(() => {
    const id = editorContextTargetRef.current;
    return id ? findPath(treeRef.current, id).at(-1) ?? null : null;
  }, []);

  const adoptPageRefBody = useCallback(
    (
      sourcePageId: string,
      payload: {
        meta?: {
          id?: unknown;
          title?: unknown;
          icon?: string;
          cover?: string;
          stickers?: Sticker[];
        };
        markdown?: unknown;
        rev?: unknown;
      },
    ) => {
      if (
        payload.meta?.id !== sourcePageId ||
        typeof payload.meta.title !== "string" ||
        typeof payload.markdown !== "string" ||
        typeof payload.rev !== "string" ||
        !payload.rev
      ) {
        return false;
      }
      const loaded: LoadedPage = {
        id: sourcePageId,
        title: payload.meta.title,
        icon: payload.meta.icon,
        cover: payload.meta.cover,
        stickers: payload.meta.stickers ?? [],
        markdown: payload.markdown,
        rev: payload.rev,
      };
      revisionsRef.current.set(sourcePageId, payload.rev);
      baseMarkdownRef.current.set(sourcePageId, payload.markdown);
      cachePut(loaded);
      if (selectedIdRef.current === sourcePageId) {
        setPage(loaded);
        setEditorEpoch((epoch) => epoch + 1);
      }
      return true;
    },
    [cachePut],
  );

  const persistAndReadPageRefBody = useCallback(
    async (sourcePageId: string, expectedMarkdown: string) => {
      if (
        (baseMarkdownRef.current.get(sourcePageId) ?? "") !== expectedMarkdown
      ) {
        await saveQueueRef.current.run(sourcePageId, () =>
          saveMarkdown({
            fetcher: apiFetch,
            id: sourcePageId,
            markdown: expectedMarkdown,
            getRevision: () => revisionsRef.current.get(sourcePageId) ?? "",
            setRevision: (revision) =>
              revisionsRef.current.set(sourcePageId, revision),
            getBaseMarkdown: () => baseMarkdownRef.current.get(sourcePageId),
            setBaseMarkdown: (markdown) =>
              baseMarkdownRef.current.set(sourcePageId, markdown),
          }),
        );
      }
      const response = await apiFetch(`/api/page/${sourcePageId}`);
      if (!response.ok) throw new Error(PAGE_REF_READBACK_FAILED);
      const payload = await response.json();
      if (
        payload.markdown !== expectedMarkdown ||
        !adoptPageRefBody(sourcePageId, payload)
      ) {
        throw new Error(PAGE_REF_BODY_CHANGED);
      }
    },
    [adoptPageRefBody],
  );

  const openPageRefRemoveDialog = useCallback(
    (invoker: HTMLElement | null) => {
      const context = editorContextPageRefRef.current;
      const sourcePageId = selectedIdRef.current;
      const source = sourcePageId
        ? findPath(treeRef.current, sourcePageId).at(-1)
        : null;
      const target = context
        ? findPath(treeRef.current, context.id).at(-1)
        : null;
      if (!context || !sourcePageId || !source) return;
      if (blockConflictMutation(sourcePageId)) return;
      if (pageRefRemovalBusyRef.current) {
        showToast("Finish removing the current reference first");
        return;
      }

      editorFlushRef.current();
      const markdown =
        pendingRef.current?.id === sourcePageId
          ? pendingRef.current.md
          : (baseMarkdownRef.current.get(sourcePageId) ?? "");
      const fingerprint = standalonePageRefOccurrences(
        markdown,
        context.id,
        window.location.origin,
      )[context.occurrence];
      if (!fingerprint) {
        showToast("This reference changed. Try again.");
        return;
      }

      invalidateHistoryOpenRequests();
      const owner = startDialogFocus(invoker);
      pageRefRemovalAttemptRef.current = null;
      setPageRefRemoveTarget({
        id: context.id,
        title: target?.title ?? context.label?.trim() ?? context.id,
        sourcePageId,
        sourceTitle: source.title,
        targetMissing: !target,
        occurrence: context.occurrence,
        fingerprint,
        open: true,
        owner,
      });
    },
    [
      blockConflictMutation,
      invalidateHistoryOpenRequests,
      showToast,
      startDialogFocus,
    ],
  );

  const requestEditorPageRefRemoval = useCallback(
    (source: EditorContextPageRef) => {
      editorContextTargetRef.current = source.id;
      setEditorContextTargetId(source.id);
      editorContextPageRefRef.current = source;
      setEditorContextPageRef(source);
      openPageRefRemoveDialog(
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      );
    },
    [openPageRefRemoveDialog],
  );

  const removeConfirmedPageRef = useCallback(async () => {
    const target = pageRefRemoveTarget;
    if (!target || pageRefRemovalBusyRef.current) return;
    pageRefRemovalBusyRef.current = true;
    const attemptKey = `${target.sourcePageId}:${target.id}:${target.occurrence}:${target.fingerprint}`;
    try {
      if (selectedIdRef.current !== target.sourcePageId) {
        throw new Error("The source page changed. Close this dialog and retry.");
      }
      if (blockConflictMutation(target.sourcePageId)) {
        throw new Error(
          "Page changed elsewhere. Close this dialog, review it, and retry.",
        );
      }

      editorFlushRef.current();
      if (!(await flushPendingRef.current())) {
        throw new Error(
          conflictedPagesRef.current.has(target.sourcePageId)
            ? "Page changed elsewhere. Close this dialog, review it, and retry."
            : "Couldn't save your latest text. It is still safe in this tab.",
        );
      }

      const currentMarkdown =
        baseMarkdownRef.current.get(target.sourcePageId) ?? "";
      let attempt =
        pageRefRemovalAttemptRef.current?.key === attemptKey
          ? pageRefRemovalAttemptRef.current
          : null;
      let mappedNotApplied:
        | { receipt: PageRefEffectReceipt; offset: number }
        | null = null;
      if (attempt) {
        const reconciliation = reconcilePageRefEffect(
          attempt.receipt,
          currentMarkdown,
          window.location.origin,
        );
        if (
          reconciliation.state === "applied" &&
          reconciliation.mappedOffset !== undefined
        ) {
          attempt = {
            ...attempt,
            markdown: currentMarkdown,
            restorePoint: {
              ...attempt.restorePoint,
              insertionOffset: reconciliation.mappedOffset,
            },
          };
          pageRefRemovalAttemptRef.current = attempt;
        } else if (
          reconciliation.state === "not-applied" &&
          reconciliation.mappedOffset !== undefined
        ) {
          mappedNotApplied = {
            receipt: attempt.receipt,
            offset: reconciliation.mappedOffset,
          };
          attempt = null;
          pageRefRemovalAttemptRef.current = null;
        } else {
          throw new Error(
            "Couldn't safely verify this removal. Close the dialog and review the page before trying again.",
          );
        }
      }
      if (!attempt) {
        const mappedText = mappedNotApplied?.receipt.text;
        const mappedOffset = mappedNotApplied?.offset;
        const mappedIdentityMatches =
          mappedText !== undefined &&
          mappedOffset !== undefined &&
          mappedText.includes(target.fingerprint) &&
          currentMarkdown.slice(
            mappedOffset,
            mappedOffset + mappedText.length,
          ) === mappedText;
        const removal = mappedNotApplied
          ? mappedIdentityMatches
            ? {
                markdown:
                  currentMarkdown.slice(0, mappedOffset) +
                  currentMarkdown.slice(mappedOffset + mappedText.length),
                removed: true,
                restorePoint: {
                  removedMarkdown: mappedText,
                  insertionOffset: mappedOffset,
                },
              }
            : { markdown: currentMarkdown, removed: false }
          : removeStandalonePageRefOccurrenceWithRestore(
              currentMarkdown,
              target.id,
              target.occurrence,
              target.fingerprint,
            );
        if (!removal.removed || !removal.restorePoint) {
          throw new Error(
            "Page changed elsewhere. Close this dialog, review it, and retry.",
          );
        }
        const canonicalRemoval = canonicalPageMarkdown(removal.markdown);
        const canonicalOffset = mapMarkdownOffset(
          removal.markdown,
          canonicalRemoval,
          removal.restorePoint.insertionOffset,
        );
        if (canonicalOffset === null) {
          throw new Error(
            "The reference position changed. Close this dialog and retry.",
          );
        }
        attempt = {
          key: attemptKey,
          markdown: canonicalRemoval,
          restorePoint: {
            ...removal.restorePoint,
            insertionOffset: canonicalOffset,
          },
          receipt: {
            kind: "remove",
            pageRefId: target.id,
            fingerprint: target.fingerprint,
            beforeMarkdown: currentMarkdown,
            afterMarkdown: canonicalRemoval,
            beforeOffset: removal.restorePoint.insertionOffset,
            afterOffset: canonicalOffset,
            text: removal.restorePoint.removedMarkdown,
          },
        };
        pageRefRemovalAttemptRef.current = attempt;
      }

      await persistAndReadPageRefBody(target.sourcePageId, attempt.markdown);

      const undo: PageRefUndo = {
        sourcePageId: target.sourcePageId,
        targetTitle: target.title,
        mappedMarkdown: attempt.markdown,
        restorePoint: attempt.restorePoint,
        status: "ready",
      };
      pageRefUndoRef.current = undo;
      setPageRefUndo(undo);
      pageRefRemovalAttemptRef.current = null;
    } catch (cause) {
      if (cause instanceof SaveRequestError && cause.status === 409) {
        await reloadCurrent(target.sourcePageId).catch(() => {});
        throw new Error(
          "Page changed elsewhere. Close this dialog, review it, and retry.",
        );
      }
      if (cause instanceof Error && cause.message === PAGE_REF_READBACK_FAILED) {
        throw new Error(
          "Couldn't verify the removal. Retry to check the saved page.",
        );
      }
      if (cause instanceof Error && cause.message === PAGE_REF_BODY_CHANGED) {
        await reloadCurrent(target.sourcePageId).catch(() => {});
        throw new Error(
          "Page changed elsewhere. Close this dialog, review it, and retry.",
        );
      }
      if (cause instanceof Error) throw cause;
      throw new Error("Couldn't remove this reference. Try again.");
    } finally {
      pageRefRemovalBusyRef.current = false;
    }
  }, [
    blockConflictMutation,
    pageRefRemoveTarget,
    persistAndReadPageRefBody,
    reloadCurrent,
  ]);

  const restoreRemovedPageRef = useCallback(async () => {
    const initial = pageRefUndoRef.current;
    if (!initial || initial.status === "restoring") return;
    if (selectedIdRef.current !== initial.sourcePageId) {
      const failed: PageRefUndo = {
        ...initial,
        status: "error",
        error: "Open the source page to restore this reference.",
      };
      pageRefUndoRef.current = failed;
      setPageRefUndo(failed);
      return;
    }
    if (blockConflictMutation(initial.sourcePageId)) {
      const failed: PageRefUndo = {
        ...initial,
        status: "error",
        error: "Page changed elsewhere. Save a copy before retrying.",
      };
      pageRefUndoRef.current = failed;
      setPageRefUndo(failed);
      return;
    }

    // Capture the last accepted editor transaction before the synchronous
    // restoring latch makes every later mutation a no-op.
    editorFlushRef.current();
    const restoring: PageRefUndo = {
      ...initial,
      status: "restoring",
      error: undefined,
    };
    pageRefUndoRef.current = restoring;
    setPageRefUndo(restoring);

    try {
      if (!(await flushPendingRef.current())) {
        throw new Error(
          conflictedPagesRef.current.has(restoring.sourcePageId)
            ? "Page changed elsewhere. Save a copy before retrying."
            : "Couldn't save your latest text. It is still safe in this tab.",
        );
      }

      const currentMarkdown =
        baseMarkdownRef.current.get(restoring.sourcePageId) ?? "";
      let restoreAttempt = restoring.restoreAttempt;
      let expectedMarkdown: string | null = null;
      if (restoreAttempt) {
        const reconciliation = reconcilePageRefEffect(
          restoreAttempt,
          currentMarkdown,
          window.location.origin,
        );
        if (reconciliation.state === "applied") {
          expectedMarkdown = currentMarkdown;
        } else if (reconciliation.state === "not-applied") {
          restoreAttempt = undefined;
          pageRefUndoRef.current = {
            ...restoring,
            restoreAttempt: undefined,
          };
        } else {
          throw new Error(
            "Couldn't safely verify this restore. Review the page before trying again.",
          );
        }
      }
      if (!restoreAttempt) {
        const mappedOffset =
          restoring.restorePoint === null
            ? null
            : mapMarkdownOffset(
                restoring.mappedMarkdown,
                currentMarkdown,
                restoring.restorePoint.insertionOffset,
              );
        if (mappedOffset === null || restoring.restorePoint === null) {
          throw new Error(
            "The original position changed. Review the page and retry.",
          );
        }
        const restored = restoreStandalonePageRefAtOffset(currentMarkdown, {
          ...restoring.restorePoint,
          insertionOffset: mappedOffset,
        });
        if (!restored.restored) {
          throw new Error(
            "The original position changed. Review the page and retry.",
          );
        }
        expectedMarkdown = canonicalPageMarkdown(restored.markdown);
        const canonicalOffset = mapMarkdownOffset(
          restored.markdown,
          expectedMarkdown,
          mappedOffset,
        );
        if (canonicalOffset === null) {
          throw new Error(
            "The original position changed. Review the page and retry.",
          );
        }
        restoreAttempt = {
          kind: "restore",
          beforeMarkdown: currentMarkdown,
          afterMarkdown: expectedMarkdown,
          beforeOffset: mappedOffset,
          afterOffset: canonicalOffset,
          text: restoring.restorePoint.removedMarkdown,
        };
        const attempted: PageRefUndo = {
          ...restoring,
          restoreAttempt,
        };
        pageRefUndoRef.current = attempted;
      }

      if (expectedMarkdown === null) {
        throw new Error(
          "Couldn't safely verify this restore. Review the page before trying again.",
        );
      }
      await persistAndReadPageRefBody(
        restoring.sourcePageId,
        expectedMarkdown,
      );
      pageRefUndoRef.current = null;
      setPageRefUndo(null);
      showToast("Reference restored");
    } catch (cause) {
      const bodyConflict =
        cause instanceof Error && cause.message === PAGE_REF_BODY_CHANGED;
      const saveConflict =
        cause instanceof SaveRequestError && cause.status === 409;
      if (saveConflict || bodyConflict) {
        await reloadCurrent(restoring.sourcePageId).catch(() => {});
      }
      const message =
        cause instanceof Error && cause.message === PAGE_REF_READBACK_FAILED
          ? "Couldn't verify the restore. Retry to check the saved page."
          : cause instanceof Error && cause.message === PAGE_REF_BODY_CHANGED
            ? "Page changed elsewhere. Review the page and retry."
            : cause instanceof Error
              ? cause.message
              : "Couldn't restore this reference. Try again.";
      const failed: PageRefUndo = {
        ...(pageRefUndoRef.current ?? restoring),
        status: "error",
        error: message,
      };
      pageRefUndoRef.current = failed;
      setPageRefUndo(failed);
    }
  }, [
    blockConflictMutation,
    persistAndReadPageRefBody,
    reloadCurrent,
    showToast,
  ]);
  const reduce = useReducedMotion();
  const setPageAppearance = useCallback(
    async (
      patch: Partial<
        Pick<TreeNode, "font" | "smallText" | "fullWidth">
      >,
    ) => {
      const id = selectedIdRef.current;
      if (!id) return;
      const current = findPath(treeRef.current, id).at(-1);
      if (!current) return;
      const expected = Object.fromEntries(
        Object.keys(patch).map((field) => [
          field,
          current[field as keyof TreeNode] ?? null,
        ]),
      );
      const walk = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((node) => ({
          ...(node.id === id ? { ...node, ...patch } : node),
          children: walk(node.children),
        }));
      setTree((current) => walk(current));
      const ok = await mutate(`/api/page/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, expected }),
      });
      if (ok) await refreshTree().catch(() => {});
    },
    [mutate, refreshTree],
  );
  const ordinaryChildren = useMemo(
    () => currentNode?.children.filter((child) => !child.collectionRow) ?? [],
    [currentNode],
  );
  useEffect(() => {
    curChildrenRef.current = ordinaryChildren;
  }, [ordinaryChildren]);
  const isBoard = currentNode?.view === "board";
  const isCollection = !!currentNode?.collection;
  const parentCollection = currentNode?.collectionRow
    ? path.at(-2)?.collection
    : undefined;
  const sidebarSelectedId = currentNode?.collectionRow
    ? path.at(-2)?.id ?? selectedId
    : selectedId;
  // The editor renders only persisted Markdown. Tree hierarchy never
  // auto-materializes a missing page reference.
  const editorValue = page?.markdown ?? "";
  const pageRefRestorePending =
    pageRefUndo?.status === "restoring" &&
    pageRefUndo.sourcePageId === page?.id;

  // one walk of the tree, memoized — recomputed only when the tree changes, not
  // on every keystroke (setPage used to trigger four full walks of it each)
  const { allPages, pinnedPages, allCategories } = useMemo(() => {
    const all: { id: string; title: string; icon?: string }[] = [];
    const pinned: { id: string; title: string; icon?: string }[] = [];
    const cats = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        const lite = { id: n.id, title: n.title, icon: n.icon };
        all.push(lite);
        if (n.pinned) pinned.push(lite);
        if (n.category) cats.add(n.category);
        walk(n.children);
      }
    };
    walk(tree);
    return {
      allPages: all,
      pinnedPages: pinned,
      allCategories: [...cats].sort(),
    };
  }, [tree]);

  const createFromHub = useCallback(
    async (title: string, idempotencyKey: string): Promise<string | null> => {
      // a captured thought becomes a root page and opens straight away — also
      // when the server says the key already made it (`captureThought`)
      try {
        const id = await captureThought(title, idempotencyKey);
        void refreshTree().catch(() => {});
        select(id);
        return id;
      } catch {
        showToast("Couldn't capture this note. Try again.");
        return null;
      }
    },
    [refreshTree, select, showToast],
  );

  const stickerTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const stickerSaveQueueRef = useRef(createKeyedQueue());
  const flushStickerDraft = useCallback(
    (id: string): Promise<boolean> =>
      stickerSaveQueueRef.current.run(id, async () => {
        const result = await saveStickerDraft(localStorage, id, apiFetch);
        if (result === "retry") {
          if (selectedIdRef.current === id)
            showToast("Stickers are safe here. Brain will retry.");
          return false;
        }
        if (result === "conflict") {
          if (selectedIdRef.current === id)
            showToast("Stickers changed elsewhere. Your draft is still safe.");
          return false;
        }
        return true;
      }),
    [showToast],
  );
  useEffect(
    () => () => {
      stickerTimers.current.forEach((timer) => clearTimeout(timer));
      stickerTimers.current.clear();
    },
    [],
  );
  const setStickers = useCallback(
    (next: Sticker[]) => {
      const id = selectedIdRef.current;
      if (!id) return;
      const existingDraft = loadStickerDraft(localStorage, id);
      const expected =
        existingDraft?.expected ??
        (page?.id === id ? (page.stickers ?? []) : undefined);
      const operationId = nextSaveOperation();
      if (
        !persistStickerDraft(localStorage, {
          version: 1,
          pageId: id,
          stickers: next,
          expected,
          operationId,
          updatedAt: Date.now(),
        })
      ) {
        showToast("Stickers couldn't be stored on this device.");
        return;
      }
      setPage((current) =>
        current?.id === id ? { ...current, stickers: next } : current,
      );
      const existing = stickerTimers.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        stickerTimers.current.delete(id);
        void flushStickerDraft(id);
      }, 500);
      stickerTimers.current.set(id, timer);
    },
    [flushStickerDraft, nextSaveOperation, page, showToast],
  );

  useEffect(() => {
    if (!selectedId) return;
    const id = selectedId;
    const recover = () => {
      const draft = loadStickerDraft(localStorage, id);
      if (!draft) return;
      setPage((current) =>
        current?.id === id
          ? { ...current, stickers: draft.stickers }
          : current,
      );
      void flushStickerDraft(id);
    };
    recover();
    window.addEventListener("online", recover);
    return () => window.removeEventListener("online", recover);
  }, [flushStickerDraft, selectedId]);

  const setView = useCallback(
    async (view: "board" | null) => {
      if (!selectedId) return;
      if (await mutate(`/api/page/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ view }),
      }))
        refreshTree();
    },
    [selectedId, mutate, refreshTree],
  );

  const addCard = useCallback(
    async (status: string, title: string) => {
      if (!selectedId || !currentNode) return;
      // the composer sits at the TOP of the column — the card must land there,
      // not at the sibling-append position createPage gives it
      const cols = currentNode.sections?.length
        ? currentNode.sections
        : ["Backlog", "In progress", "Done"];
      const head = currentNode.children.find(
        (c) => (c.status ?? cols[0]) === status,
      );
      const r = await apiFetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: selectedId, title, status }),
      });
      if (!r.ok) {
        showToast("Couldn't add this card. Try again.");
        return;
      }
      if (r.ok && head) {
        const meta = (await r.json()) as { id: string };
        if (!(await mutate("/api/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: meta.id,
            newParentId: selectedId,
            beforeId: head.id,
          }),
        }))) return;
      }
      void refreshTree().catch(() => {});
    },
    [selectedId, currentNode, mutate, refreshTree, showToast],
  );

  // ── board columns + card tags ─────────────────────────
  const boardColumns = () =>
    currentNode?.sections?.length ? currentNode.sections : ["Backlog", "In progress", "Done"];

  // optimistic tree patch — the board reflects a column op instantly, the
  // network follows, refreshTree reconciles (same pattern as onMove)
  const patchTreeNode = useCallback((id: string, patch: Partial<TreeNode>) => {
    const walk = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) => ({
        ...(n.id === id ? { ...n, ...patch } : n),
        children: walk(n.children),
      }));
    setTree((t) => walk(t));
  }, []);

  // A board drop is optimistic in the UI but one crash-recoverable Store
  // mutation on disk: status and fractional order can never split.
  const onMoveCard = useCallback(
    async (cardId: string, status: string, beforeId: string | null) => {
      if (!selectedId) return;
      patchTreeNode(cardId, { status });
      setTree((t) => applyMove(t, cardId, selectedId, beforeId));
      if (!(await mutate("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "move-card",
          boardId: selectedId,
          cardId,
          status,
          beforeId,
        }),
      }))) return;
      void refreshTree().catch(() => {});
    },
    [selectedId, mutate, patchTreeNode, refreshTree],
  );

  const setColumns = useCallback(
    async (cols: string[]) => {
      if (!selectedId) return false;
      patchTreeNode(selectedId, { sections: cols });
      return mutate(`/api/page/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: cols }),
      });
    },
    [selectedId, mutate, patchTreeNode],
  );

  const addColumn = useCallback(
    async (name: string) => {
      if (await setColumns([...boardColumns(), name])) refreshTree();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setColumns, refreshTree],
  );

  const renameColumn = useCallback(
    async (from: string, to: string) => {
      if (!currentNode || !selectedId) return;
      const next = boardColumns().map((c) => (c === from ? to : c));
      const cards = currentNode.children.filter(
        (c) => (c.status ?? boardColumns()[0]) === from,
      );
      // instant: retitle the column and restatus its cards locally
      patchTreeNode(selectedId, { sections: next });
      cards.forEach((c) => patchTreeNode(c.id, { status: to }));
      if (
        await mutate("/api/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "rename-column",
            boardId: selectedId,
            from,
            to,
          }),
        })
      )
        refreshTree();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentNode, selectedId, mutate, patchTreeNode, refreshTree],
  );

  const deleteColumn = useCallback(
    async (name: string) => {
      if (!currentNode || !selectedId) return;
      const rest = boardColumns().filter((c) => c !== name);
      const fallback = rest[0] ?? "Backlog";
      const cards = currentNode.children.filter(
        (c) => (c.status ?? boardColumns()[0]) === name,
      );
      // instant: drop the column, move its cards to the fallback locally
      patchTreeNode(selectedId, { sections: rest });
      cards.forEach((c) => patchTreeNode(c.id, { status: fallback }));
      if (
        await mutate("/api/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "delete-column",
            boardId: selectedId,
            name,
            fallback,
          }),
        })
      )
        refreshTree();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentNode, selectedId, mutate, patchTreeNode, refreshTree],
  );

  const setTags = useCallback(
    async (cardId: string, tags: string[]) => {
      if (await mutate(`/api/page/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      }))
        refreshTree();
    },
    [mutate, refreshTree],
  );

  // ── Smart Sorting (AI broom) ──────────────────────────
  const patchParentSections = useCallback(
    async (
      targetId: string,
      sections: string[],
      view?: "board" | "sections" | null,
    ) => {
      return mutate(`/api/page/${targetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections, ...(view !== undefined ? { view } : {}) }),
      });
    },
    [mutate],
  );

  const runSmartSort = useCallback(async () => {
    if (!selectedId) return;
    const targetId = selectedId;
    if (
      blockConflictMutation(
        targetId,
        "Save a copy before sorting this local draft.",
      )
    )
      return;
    const expectedChildren = smartChildSignature(curChildrenRef.current);
    setSmartLoading(true);
    setSmartPreview(null);
    try {
      const r = await apiFetch("/api/smart-sort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: targetId }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const preview = await r.json();
      if (selectedIdRef.current === targetId) {
        setSmartPreview({
          ...preview,
          pageId: targetId,
          childSig: expectedChildren,
        });
      }
    } catch {
      if (selectedIdRef.current === targetId) {
        showToast("Couldn't sort these pages. Try again.");
      }
    } finally {
      setSmartLoading(false);
    }
  }, [blockConflictMutation, selectedId, showToast]);

  // Write the AI grouping as plain markdown into the page body: `## Section`
  // headings + the child pages as links. Result is an ordinary doc the user
  // can freely edit, reorder, or strip headings from — no special view/state.
  const writeBody = useCallback(
    async (
      target: { id: string; rev: string },
      md: string,
    ): Promise<boolean> => {
      if (selectedIdRef.current === target.id) editorFlushRef.current();
      const pending =
        pendingRef.current?.id === target.id ? pendingRef.current : null;
      if (pending && timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const pendingSave = pending
        ? doSave(target.id, pending.md, pending.operationId)
        : Promise.resolve(true);
      // Queue immediately, before awaiting the older edit. Any keystroke that
      // happens after Smart Sort was invoked therefore remains newer than it.
      const programmaticSave = doSave(
        target.id,
        md,
        nextSaveOperation(),
        pendingSave,
      );
      const saved = await programmaticSave;
      if (!saved) return false;
      const revision = revisionsRef.current.get(target.id) ?? target.rev;
      if (pendingRef.current?.id === target.id) return false;
      setPage((current) =>
        current?.id === target.id
          ? { ...current, markdown: md, rev: revision }
          : current,
      );
      if (selectedIdRef.current === target.id) {
        setEditorEpoch((e) => e + 1); // force the editor to reload the new body
      }
      return true;
    },
    [doSave, nextSaveOperation],
  );

  const applySmartSort = useCallback(async () => {
    const p = smartPreview;
    if (!p || !currentNode || !page) return;
    if (
      blockConflictMutation(
        page.id,
        "Save a copy before sorting this local draft.",
      )
    )
      return;
    const liveChildSig = smartChildSignature(ordinaryChildren);
    if (p.pageId !== page.id || p.childSig !== liveChildSig) {
      setSmartPreview(null);
      showToast("Pages changed — run Smart sort again");
      return;
    }
    const target = page;
    // Milkdown's transaction listener can still be inside its 200 ms window.
    // Serialize it before capturing Undo so the snapshot includes the final
    // keystroke visible when Apply was pressed.
    if (selectedIdRef.current === target.id) editorFlushRef.current();
    const visibleBody =
      pendingRef.current?.id === target.id
        ? pendingRef.current.md
        : target.markdown;
    const visibleRevision = revisionsRef.current.get(target.id) ?? target.rev;
    setSmartPreview(null);
    smartUndo.current = {
      id: target.id,
      markdown: visibleBody,
      rev: visibleRevision,
    };
    setSmartUndoPageId(target.id);
    const byId = new Map(currentNode.children.map((c) => [c.id, c] as const));
    const blocks: string[] = [];
    for (const section of p.sections) {
      const links = sectionPageIds(p, section)
        .map((id) => byId.get(id))
        .filter((c): c is TreeNode => !!c)
        .map((c) => `[${c.icon ? c.icon + " " : ""}${c.title}](/p/${c.id})`);
      if (links.length) blocks.push(`## ${section}\n\n${links.join("\n\n")}`);
    }
    // lay the sections out in two columns (Notion-style) — split in reading
    // order, left column first. Drops to a single flow for one section.
    let organized: string;
    if (blocks.length >= 2) {
      const mid = Math.ceil(blocks.length / 2);
      const colA = blocks.slice(0, mid).join("\n\n");
      const colB = blocks.slice(mid).join("\n\n");
      organized = `::::cols\n:::col\n${colA}\n:::\n\n:::col\n${colB}\n:::\n::::`;
    } else {
      organized = blocks.join("\n\n");
    }
    // replace the body with the fresh layout (re-running the broom re-organizes,
    // it doesn't stack). Undo restores the prior body verbatim.
    if (!(await writeBody(target, organized))) return;
    // it's a plain doc now — drop any legacy sections-view state
    await patchParentSections(target.id, [], null);
    await refreshTree();
    if (selectedIdRef.current !== target.id) {
      smartUndo.current = null;
      setSmartUndoPageId(null);
      return;
    }
    setSmartUndoOpen(true);
    if (smartUndoTimer.current) clearTimeout(smartUndoTimer.current);
    smartUndoTimer.current = setTimeout(() => setSmartUndoOpen(false), 9000);
  }, [
    smartPreview,
    currentNode,
    page,
    ordinaryChildren,
    blockConflictMutation,
    showToast,
    writeBody,
    patchParentSections,
    refreshTree,
  ]);

  const undoSmartSort = useCallback(async () => {
    const u = smartUndo.current;
    if (!u) return;
    if (selectedIdRef.current !== u.id) {
      smartUndo.current = null;
      setSmartUndoPageId(null);
      setSmartUndoOpen(false);
      return;
    }
    if (await writeBody(u, u.markdown)) {
      smartUndo.current = null;
      setSmartUndoPageId(null);
    }
  }, [writeBody]);

  const setCategory = useCallback(
    async (category: string) => {
      if (!selectedId) return;
      if (await mutate(`/api/page/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      }))
        refreshTree();
    },
    [selectedId, mutate, refreshTree],
  );

  const readShareScope = useCallback(async (rootId: string) => {
    const response = await apiFetch(`/api/page/${rootId}/share`);
    if (!response.ok) {
      throw new Error(`Share scope request returned ${response.status}`);
    }
    const snapshot: unknown = await response.json();
    if (!isShareScopeSnapshot(snapshot) || snapshot.rootId !== rootId) {
      throw new Error("Invalid share scope read-back");
    }
    return snapshot;
  }, []);

  const updateShareSettings = useCallback(
    async ({
      password,
      expiresAt,
    }: {
      password?: string | null;
      expiresAt?: string | null;
    }) => {
      if (!selectedId) throw new Error("no page selected");
      const rootId = selectedId;
      const disclosed = await readShareScope(rootId);
      if (!disclosed.public) {
        throw new Error("share settings require an active direct grant");
      }

      const response = await apiFetch(`/api/page/${rootId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          expectedScopeToken: disclosed.scopeToken,
          ...(password !== undefined ? { password } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (
        !response.ok ||
        !isShareScopeSnapshot(payload) ||
        payload.rootId !== rootId ||
        !payload.public
      ) {
        throw new Error(`Share settings update returned ${response.status}`);
      }

      // Do not report a settings save until the durable authority can be read
      // independently and matches the requested credential change.
      const readBack = await readShareScope(rootId);
      if (
        !readBack.public ||
        (password !== undefined && readBack.shareLocked !== !!password) ||
        (expiresAt !== undefined && readBack.shareExpiresAt !== expiresAt)
      ) {
        throw new Error("Share settings read-back mismatch");
      }
      await refreshTree().catch(() => {});
      return readBack;
    },
    [readShareScope, refreshTree, selectedId],
  );

  const onSetShareProtection = useCallback(
    async (input: {
      password?: string | null;
      expiresAt?: string | null;
    }) => {
      await updateShareSettings(input);
      showToast("Link protection updated");
    },
    [showToast, updateShareSettings],
  );

  const onPrepareShare = useCallback(
    async (rootId: string) => readShareScope(rootId),
    [readShareScope],
  );

  const onEnableShare = useCallback(
    async ({
      expectedScopeToken,
      password,
      expiresAt,
    }: {
      expectedScopeToken: string;
      password?: string | null;
      expiresAt?: string | null;
    }): Promise<ShareEnableResult> => {
      if (!currentNode) throw new Error("no page selected");
      const rootId = currentNode.id;
      const response = await apiFetch(`/api/page/${rootId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          expectedScopeToken,
          password,
          expiresAt,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409) {
        const snapshot =
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          "snapshot" in payload
            ? (payload as { snapshot: unknown }).snapshot
            : null;
        if (!isShareScopeSnapshot(snapshot) || snapshot.rootId !== rootId) {
          throw new Error("Invalid refreshed share scope");
        }
        return { status: "conflict", snapshot };
      }
      if (
        !response.ok ||
        !isShareScopeSnapshot(payload) ||
        payload.rootId !== rootId
      ) {
        throw new Error(`Share enable returned ${response.status}`);
      }

      // Prove the durable authority visible to later public requests. Success
      // and clipboard effects are forbidden until this separate read-back.
      const readBack = await readShareScope(rootId);
      if (
        !readBack.public ||
        (password !== undefined &&
          readBack.shareLocked !== !!password) ||
        (expiresAt !== undefined &&
          readBack.shareExpiresAt !== expiresAt)
      ) {
        throw new Error("Share enable read-back mismatch");
      }
      await refreshTree().catch(() => {});
      if (
        readBack.public &&
        !isShareGrantExpired(readBack.shareExpiresAt)
      ) {
        try {
          await navigator.clipboard.writeText(
            `${location.origin}/share/${rootId}`,
          );
          showToast("Public link copied");
        } catch {
          showToast("Sharing enabled — copy the link manually");
        }
      } else {
        showToast("Sharing enabled, but the link is expired");
      }
      return { status: "enabled", snapshot: readBack };
    },
    [currentNode, readShareScope, refreshTree, showToast],
  );

  const revokeShare = useCallback(async (rootId: string) => {
    const response = await apiFetch(`/api/page/${rootId}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (
      !response.ok ||
      !isShareScopeSnapshot(payload) ||
      payload.rootId !== rootId
    ) {
      throw new Error(`Share revoke returned ${response.status}`);
    }
    const readBack = await readShareScope(rootId);
    if (readBack.public) throw new Error("Share revoke read-back mismatch");
    await refreshTree().catch(() => {});
    return readBack;
  }, [readShareScope, refreshTree]);

  const onDisableShare = useCallback(async () => {
    if (!currentNode) throw new Error("no page selected");
    const readBack = await revokeShare(currentNode.id);
    showToast(
      inheritedShareRoot
        ? "Own link turned off; parent share remains"
        : expiredInheritedShareRoot
          ? "Own link turned off; parent link is expired"
        : "Sharing turned off",
    );
    return readBack;
  }, [
    currentNode,
    expiredInheritedShareRoot,
    inheritedShareRoot,
    revokeShare,
    showToast,
  ]);

  const copyVerifiedShareLink = useCallback(async (
    rootId: string,
    targetId: string,
  ) => {
    const readBack = await readShareScope(rootId);
    if (
      !readBack.public ||
      isShareGrantExpired(readBack.shareExpiresAt)
    ) {
      throw new Error("Share is not active");
    }
    const url = `${location.origin}/share/${rootId}${
      rootId !== targetId
        ? `?page=${encodeURIComponent(targetId)}`
        : ""
    }`;
    await navigator.clipboard.writeText(url);
    showToast("Link copied");
  }, [readShareScope, showToast]);

  const onCopyShareLink = useCallback(async (rootId: string) => {
    if (!currentNode) throw new Error("no page selected");
    await copyVerifiedShareLink(rootId, currentNode.id);
  }, [copyVerifiedShareLink, currentNode]);

  const createChildPage = useCallback(() => {
    if (currentNode) createPage(currentNode.id);
  }, [createPage, currentNode]);

  const toggleTheme = useCallback(() => {
    const currentTheme = theme === "system" ? resolvedTheme : theme;
    setTheme(currentTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme, theme]);

  const exportPdf = useCallback(() => {
    editorFlushRef.current();
    flushPendingRef.current();
    requestAnimationFrame(() => window.print());
  }, []);

  const exportMarkdown = useCallback(async () => {
    if (!currentNode) return;
    editorFlushRef.current();
    if (!(await flushPendingRef.current())) {
      showToast("Couldn't export. Your unsaved draft is safe.");
      return;
    }
    try {
      const response = await fetch(
        `/api/portable/export?id=${encodeURIComponent(currentNode.id)}`,
      );
      if (!response.ok) throw new Error(String(response.status));
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileName =
        /filename="([^"]+)"/.exec(disposition)?.[1] ??
        "brain-page.brain.tar.gz";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      showToast("Markdown archive downloaded");
    } catch {
      showToast("Couldn't export this page. Try again.");
    }
  }, [currentNode, showToast]);

  /** Navigate to the settings surface. Without a section it is the front
   *  door: /settings/appearance on desktop, the /settings root list on
   *  mobile. With one (a deep link — Mail reauth, sharing) both go straight
   *  to /settings/<section>. */
  const openSettings = useCallback(
    (section?: SettingsSection, options?: { accountId?: string | null }) => {
      clearSearchHighlightIntent();
      historyOpenRequestRef.current += 1;
      editorFlushRef.current();
      flushPendingRef.current();
      if (paletteOpen) {
        paletteReturnFocusRef.current = null;
        setPaletteOpen(false);
      }
      settingsOpenedFromPagesRef.current = mobilePagesOpen;
      settingsEnteredInAppRef.current = true;
      settingsDrilledFromRootRef.current = false;
      const mobile = window.matchMedia("(max-width: 767px)").matches;
      const target: SettingsSection | null =
        section === undefined ? (mobile ? null : "appearance") : section;
      const accountId = target === "mail" ? (options?.accountId ?? null) : null;
      setMailSettingsAccountId(accountId);
      dispatchNavigationPresence({
        type: "surface",
        surface: "settings",
        settingsSection: target,
      });
      setSelectedId(null);
      setSmartPreview(null);
      editorContextTargetRef.current = null;
      setEditorContextTargetId(null);
      editorContextPageRefRef.current = null;
      setEditorContextPageRef(null);
      setMobilePagesOpen(false);
      window.history.pushState(
        {},
        "",
        settingsPath(target) +
          (accountId ? `?account=${encodeURIComponent(accountId)}` : ""),
      );
    },
    [
      clearSearchHighlightIntent,
      mobilePagesOpen,
      paletteOpen,
      setSelectedId,
    ],
  );

  /** A section change inside the surface. The mobile root list drills down
   *  with a real history entry (Back returns to the list); a desktop change
   *  rewrites in place (Back leaves settings in one step). */
  const selectSettingsSection = useCallback(
    (section: SettingsSection) => {
      setMailSettingsAccountId(null);
      const fromRoot = settingsSection === null;
      dispatchNavigationPresence({
        type: "surface",
        surface: "settings",
        settingsSection: section,
      });
      if (fromRoot) {
        settingsDrilledFromRootRef.current = true;
        window.history.pushState({}, "", settingsPath(section));
      } else {
        window.history.replaceState({}, "", settingsPath(section));
      }
    },
    [settingsSection],
  );

  /** Leave the settings surface: history.back() restores the page the user
   *  came from (instant from the cache); a cold /settings load goes home. */
  const exitSettings = useCallback(() => {
    if (settingsEnteredInAppRef.current) {
      window.history.back();
      return;
    }
    goHome();
    window.requestAnimationFrame(() => {
      const trigger = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-settings-trigger="desktop"]',
        ),
      ).find(isVisibleFocusTarget);
      const target = trigger ?? mainRef.current;
      if (isVisibleFocusTarget(target)) target.focus({ preventScroll: true });
    });
  }, [goHome]);

  /** The mobile Back of a settings screen: a drilled section pops back to
   *  the root list, a deep-linked section rewrites to the list in place,
   *  and the root exits the surface. */
  const settingsBack = useCallback(() => {
    if (settingsSection !== null && window.matchMedia("(max-width: 767px)").matches) {
      if (settingsDrilledFromRootRef.current) {
        settingsDrilledFromRootRef.current = false;
        window.history.back();
        return;
      }
      setMailSettingsAccountId(null);
      dispatchNavigationPresence({
        type: "surface",
        surface: "settings",
        settingsSection: null,
      });
      window.history.replaceState({}, "", settingsPath(null));
      return;
    }
    exitSettings();
  }, [exitSettings, settingsSection]);

  // Esc leaves settings (desktop) or steps back one screen (mobile) — unless
  // an overlay owns the key, or the user is typing in a field.
  useEffect(() => {
    if (!settingsActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (paletteOpen || trashOpen || shortcutsOpen) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input, textarea, select, [contenteditable]") ||
          target.closest('[role="dialog"], [role="menu"], [role="listbox"]'))
      ) {
        return;
      }
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      if (window.matchMedia("(max-width: 767px)").matches) {
        settingsBack();
      } else {
        exitSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    exitSettings,
    paletteOpen,
    settingsActive,
    settingsBack,
    shortcutsOpen,
    trashOpen,
  ]);

  const closeMobilePages = useCallback(() => {
    setMobilePagesOpen(false);
  }, []);

  const closePaletteForNavigation = useCallback(() => {
    // Mobile tab changes own their destination focus. Skip the palette's
    // generic Search-trigger restore so it cannot steal focus later.
    paletteReturnFocusRef.current = null;
    setPaletteOpen(false);
  }, []);

  const focusMobileHomeAfterTransition = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const homeTab = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[data-mobile-tab="home"]',
          ),
        ).find(isVisibleFocusTarget);
        const target = homeTab ?? mainRef.current;
        if (isVisibleFocusTarget(target)) {
          target.focus({ preventScroll: true });
        }
      });
    });
  }, []);

  const openMobilePages = useCallback((invoker: HTMLElement) => {
    if (invoker instanceof HTMLButtonElement) mobilePagesTabRef.current = invoker;
    if (paletteOpen) closePaletteForNavigation();
    setMobilePagesOpen(true);
  }, [closePaletteForNavigation, paletteOpen]);

  const mobileSearchOpen = paletteOpen && mobileViewport;
  const mobileBlockingSurfaceOpen = mobilePagesOpen || mobileSearchOpen;
  // The sidebar is translated off-canvas on mobile (Pages is its own view)
  // and in desktop focus mode. Off-screen must also mean out of the tab order
  // and the accessibility tree, or Tab walks into invisible controls. That is
  // all it does now — it used to carry a second job, telling mail whether the
  // rail was on screen to own account and folder navigation, and mail's head
  // read it. Mail's navigation has one owner in its own column at every width,
  // so the sidebar has nothing left to say about it.
  const sidebarOffCanvas =
    mobileViewport || focusMode || mobileBlockingSurfaceOpen;

  const mobileTabBarHidden =
    mobileKeyboardOpen ||
    settingsActive ||
    trashOpen ||
    historyOpen ||
    !!renameTarget ||
    !!moveTarget ||
    !!smartPreview;

  const mobileTabBarProps = {
    homeActive:
      !mailOpen &&
      !settingsActive &&
      !selectedId &&
      !mobilePagesOpen &&
      !mobileSearchOpen,
    searchActive: mobileSearchOpen,
    pagesActive: mobilePagesOpen,
    mailActive: mailOpen && !mobilePagesOpen && !mobileSearchOpen,
    hidden: mobileTabBarHidden,
    searchRef: mobileSearchTabRef,
    pagesRef: mobilePagesTabRef,
    onHome: () => {
      if (paletteOpen) closePaletteForNavigation();
      goHome();
      if (mobileViewport) focusMobileHomeAfterTransition();
    },
    onSearch: openPalette,
    onNew: () => {
      if (paletteOpen) closePaletteForNavigation();
      setMobilePagesOpen(false);
      void createPage(null);
    },
    onPages: openMobilePages,
    onMail: () => {
      if (paletteOpen) closePaletteForNavigation();
      openMail();
    },
  };

  const commandPalette = (
    <CommandPalette
      open={paletteOpen}
      onOpenChange={onPaletteOpenChange}
      tree={tree}
      onSelect={(selection: CommandPaletteSelection) => {
        if (selection.kind === "text" && !selection.target) {
          select(selection.id);
          showToast("That search match changed. Opened the page instead.");
          return;
        }
        select(
          selection.id,
          selection.kind === "text"
            ? (selection.target ?? undefined)
            : undefined,
        );
      }}
      hasCurrent={!!currentNode && !isCollection}
      recentIds={recentIds}
      onNewPage={async () => {
        await createPage(null);
      }}
      onNewChild={createChildPage}
      onToday={() => openDailyPage()}
      onHome={goHome}
      onOpenMail={openMail}
      onOpenTrash={() => setTrashOpen(true)}
      onOpenSettings={openSettings}
      onToggleTheme={toggleTheme}
      mobile={mobileViewport}
      mobileFooter={<MobileTabBar {...mobileTabBarProps} contained />}
    />
  );

  // Shared by the mobile and desktop header rows; a plain object, rebuilt
  // every render like the JSX props it replaces.
  const topbarProps: Omit<ShellTopbarProps, "variant"> = {
    currentNode,
    path,
    surface,
    settingsSection,
    onSelectSettingsSection: selectSettingsSection,
    isBoard,
    isCollection,
    activeShareRoot,
    inheritedShareRoot,
    expiredInheritedShareRoot,
    inheritedSettingsRoot,
    hasActiveShare,
    hasConfiguredShare,
    shareScopeRevision,
    onSelect: select,
    onPrepareShare,
    onEnableShare,
    onDisableShare,
    onCopyShareLink,
    onSetShareProtection,
    onOpenSharingSettings: () => openSettings("sharing"),
    onSetPageAppearance: setPageAppearance,
    onTogglePin,
    onCopyPageLink: copyPageLink,
    onDuplicate,
    onDialogIntent: invalidateHistoryOpenRequests,
    onOpenMoveDialog: openMoveDialog,
    onExportPdf: exportPdf,
    onExportMarkdown: exportMarkdown,
    onOpenHistory: openHistory,
    onRequestDelete: requestDelete,
  };

  // Right-click page menu over the editor. Plain closures rebuilt every
  // render, like the JSX props they replace: each resolves its target from
  // the refs at click time and runs the conflict guard first.
  const editorContextMenu: PageMenuHandlers = {
    pinned: editorContextNode?.pinned,
    canAddChild:
      save !== "conflict" &&
      !!editorContextNode &&
      !editorContextNode.collection,
    onAddChild: () => {
      if (blockConflictMutation(selectedIdRef.current)) return;
      const target = getEditorContextNode();
      if (target && !target.collection) void createPage(target.id);
    },
    onRename: (invoker) => {
      if (blockConflictMutation(selectedIdRef.current)) return;
      const target = getEditorContextNode();
      if (target)
        openRenameDialog(target.id, target.title, invoker);
    },
    onCopyLink: () => {
      const target = getEditorContextNode();
      if (target) void copyPageLink(target.id);
    },
    onDuplicate: () => {
      if (blockConflictMutation(selectedIdRef.current)) return;
      const target = getEditorContextNode();
      if (target) void onDuplicate(target.id);
    },
    onDialogIntent: invalidateHistoryOpenRequests,
    onMoveRequest: (invoker) => {
      if (blockConflictMutation(selectedIdRef.current)) return;
      const target = getEditorContextNode();
      if (target)
        openMoveDialog(target.id, target.title, invoker);
    },
    onTogglePin: () => {
      if (blockConflictMutation(selectedIdRef.current)) return;
      const target = getEditorContextNode();
      if (target) void onTogglePin(target.id, !target.pinned);
    },
    deleteLabel: editorContextPageRef ? "Remove reference" : undefined,
    deleteReturnsFocus: !!editorContextPageRef,
    onDelete: (invoker) => {
      if (blockConflictMutation(selectedIdRef.current)) return;
      if (editorContextPageRefRef.current) {
        openPageRefRemoveDialog(invoker);
        return;
      }
      const target = getEditorContextNode();
      if (target) requestDelete(target.id, target.title);
    },
  };

  const onEditorContextMenuCapture = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest(
      "a[data-page-ref]",
    );
    const id = anchor?.getAttribute("data-page-ref") ?? null;
    if (!id) {
      editorContextPageRefRef.current = null;
      setEditorContextPageRef(null);
      event.stopPropagation();
      return;
    }
    const editor = anchor?.closest<HTMLElement>(".ProseMirror") ?? null;
    let standalone: EditorContextPageRef | null = null;
    if (editor) {
      // The row menu removes one exact reference, so it has to number the rows
      // the same way the drag does — every lane, document order.
      const occurrence = standalonePageRefAnchors(editor)
        .filter((candidate) => candidate.dataset.pageRef === id)
        .indexOf(anchor as HTMLElement);
      if (occurrence >= 0) {
        standalone = {
          id,
          occurrence,
          label: anchor?.textContent?.trim() || id,
        };
      }
    }
    editorContextTargetRef.current = id;
    setEditorContextTargetId(id);
    editorContextPageRefRef.current = standalone;
    setEditorContextPageRef(standalone);
  };

  const onEditorDirty = (pageId: string) => {
    if (searchHighlight?.pageId === pageId) {
      clearSearchHighlightIntent();
    }
    const undo = pageRefUndoRef.current;
    if (
      undo?.sourcePageId !== pageId ||
      undo.status !== "restoring"
    ) {
      editorDirtyRef.current = pageId;
    }
  };

  const onEditorSerialized = (pageId: string) => {
    if (
      editorDirtyRef.current === pageId &&
      pendingRef.current?.id !== pageId
    ) {
      editorDirtyRef.current = null;
    }
  };

  return (
    <div
      className="brain-shell flex h-dvh overflow-hidden"
      data-sidebar-collapsed={focusMode && sidebarCollapsed ? "" : undefined}
    >
      {/* the paper and the static edge tints the glass refracts — on the
          shell, which never scrolls; the scroller above it is transparent */}
      <Background />
      <ShellSidebar
        tree={tree}
        selectedId={selectedId}
        sidebarSelectedId={sidebarSelectedId}
        expanded={expanded}
        focusMode={focusMode}
        offCanvas={sidebarOffCanvas}
        surface={surface}
        settingsSection={settingsSection}
        onSelectSettingsSection={selectSettingsSection}
        pinnedPages={pinnedPages}
        onGoHome={goHome}
        onCloseSettings={exitSettings}
        onOpenPalette={openPalette}
        onCreatePage={createPage}
        onOpenDailyPage={openDailyPage}
        onOpenMail={openMail}
        onSelect={select}
        onToggleExpand={toggleExpand}
        onDelete={requestDelete}
        onRename={openRenameDialog}
        onCopyLink={onTreeCopyLink}
        onDuplicate={onDuplicate}
        onDialogIntent={invalidateHistoryOpenRequests}
        onMoveRequest={onTreeMoveRequest}
        onTogglePin={onTogglePin}
        onMove={onMove}
        onReparentPageRef={onReparentPageRef}
        onPrefetch={prefetchPage}
        onOpenSettings={openSettings}
        onOpenTrash={() => setTrashOpen(true)}
        onCollapsed={() => setSidebarCollapsed(true)}
      />

      <main
        ref={mainRef}
        tabIndex={-1}
        data-dialog-focus-fallback
        aria-hidden={mobileBlockingSurfaceOpen || undefined}
        inert={mobileBlockingSurfaceOpen || undefined}
        className="brain-main flex min-w-0 flex-1 flex-col outline-none"
      >
        {focusMode && (
          /* a thin chip, quiet until hovered */
          <button
            type="button"
            onClick={() => setFocusMode(false)}
            title={"Exit focus mode (⌘\\)"}
            className="brain-focus-exit mat-thin text-control"
          >
            <Kbd>{"⌘\\"}</Kbd>
            <span>Exit focus</span>
          </button>
        )}
        <ShellTopbar variant="mobile" {...topbarProps} />
        <ShellTopbar variant="desktop" {...topbarProps} />

        <div className="brain-page-scroll flex-1 overflow-y-auto overflow-x-clip">
          {/* initial={false}: the first canvas (hub, or an SSR-seeded page)
              paints at once instead of fading in behind hydration */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={canvasPresenceKey({
                selectedId,
                surface,
                settingsSection,
                epoch: navigationPresenceEpoch,
              })}
              {...(reduce ? pageFade : pageTransition)}
              className={
                mailOpen || settingsActive
                  ? "min-h-full"
                  : selectedId
                    ? "brain-page-frame relative pb-40"
                    : undefined
              }
            >
            {mailOpen ? (
              <MailSurface
                onOpenSettings={(invoker, accountId) =>
                  openSettings("mail", { accountId })
                }
                onToast={showToast}
                refreshToken={mailSurfaceRevision}
              />
            ) : settingsActive ? (
              <SettingsSurface
                section={settingsSection}
                tree={tree}
                mailAccountId={mailSettingsAccountId}
                onSelectSection={selectSettingsSection}
                onBack={settingsBack}
                onOpenMail={openMail}
                onMailAccountStatusChange={updateMailConfiguredFromSettings}
                onUnshare={async (id) => {
                  await revokeShare(id);
                  showToast("Sharing is off");
                }}
                onCopyShareLink={(id) => copyVerifiedShareLink(id, id)}
                onToast={showToast}
              />
            ) : selectedId ? (
              <NotesCanvasBody
                ready={!!page && page.id === selectedId}
                fallback={
                  pageLoadError?.id === selectedId ? (
                    <motion.div
                      key="load-error"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, transition: { duration: DUR.exit } }}
                      transition={{ duration: DUR.base }}
                      className="brain-page-top mx-auto flex max-w-[720px] flex-col items-center px-5 md:px-6"
                    >
                      <Empty
                        icon="cloud-cross-linear"
                        title={"Couldn't load this page"}
                        hint={
                          pageLoadError.status === 404
                            ? "It may have been deleted or moved"
                            : "The server didn't respond. It may be restarting"
                        }
                      />
                      <Button
                        variant="ghost"
                        onClick={retryPageLoad}
                        className="mt-4 border border-line"
                      >
                        Try again
                      </Button>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="skeleton"
                      initial={{ opacity: 0 }}
                      // anti-flash delay belongs to the enter only — the exit
                      // must not inherit it or the resolved page waits behind
                      // a stale skeleton. Absolute so the exiting skeleton
                      // never pushes the arriving body down.
                      animate={{
                        opacity: 1,
                        transition: { delay: DUR.fast, duration: DUR.base },
                      }}
                      exit={{ opacity: 0, transition: { duration: DUR.exit } }}
                      className="pointer-events-none absolute inset-x-0 top-0"
                    >
                      <div className="brain-page-top mx-auto max-w-[720px] px-5 md:px-6">
                        {/* skeleton mirrors the real layout: a cover plate (so
                            the title doesn't jump down when a covered page
                            resolves), then a title line + paragraph lines */}
                        {currentNode?.cover && (
                          <Skeleton className="-mx-5 mb-6 h-[180px] rounded-none md:-mx-6 md:h-[220px]" />
                        )}
                        <Skeleton className="h-9 w-1/2 md:h-10" />
                        <div className="mt-6 space-y-3">
                          <Skeleton className="h-4 w-full" />
                          <Skeleton className="h-4 w-5/6" />
                          <Skeleton className="h-4 w-2/3" />
                        </div>
                      </div>
                    </motion.div>
                  )
                }
              >
              {page && page.id === selectedId && (
              <>
                <PageCover
                  cover={page.cover}
                  reduceMotion={reduce}
                  onSetCover={setCover}
                  onUpload={uploadCover}
                />
                <article
                  data-page-font={currentNode?.font}
                  data-small-text={currentNode?.smallText ? "true" : undefined}
                  data-full-width={currentNode?.fullWidth ? "true" : undefined}
                  style={
                    {
                      "--brain-print-sticker-bottom": `${stickerPrintCanvasHeight(page.stickers)}px`,
                    } as CSSProperties
                  }
                  className={`relative px-5 md:px-6 ${
                    page.cover ? "-mt-9 pt-0" : "brain-page-top"
                  } ${
                    isBoard || isCollection
                      ? "w-full"
                      : currentNode?.fullWidth
                        ? "brain-page-article mx-auto w-full max-w-[1440px] md:px-10"
                        : "brain-page-article mx-auto max-w-[720px]"
                  }`}
                >
                {!isBoard && !isCollection && (
                  <StickersLayer stickers={page.stickers} onChange={setStickers} />
                )}
                <PageHead
                  page={page}
                  currentNode={currentNode}
                  save={save}
                  localRecoveryUnavailable={localRecoveryUnavailable}
                  isBoard={isBoard}
                  isCollection={isCollection}
                  parentCollection={parentCollection}
                  categorySuggestions={allCategories}
                  canAddTags={path.at(-2)?.view === "board"}
                  focusTitleId={focusTitleId}
                  smartSortLoading={smartLoading}
                  onSetIcon={setIcon}
                  onCommitTitle={commitTitle}
                  onTitleFocused={() => setFocusTitleId(null)}
                  onSetCategory={setCategory}
                  onSetTags={setTags}
                  onSetCover={setCover}
                  onUploadCover={uploadCover}
                  onSetView={setView}
                  onRunSmartSort={runSmartSort}
                  onSetStickers={setStickers}
                />

                <PageBody
                  page={page}
                  currentNode={currentNode}
                  isBoard={isBoard}
                  isCollection={isCollection}
                  onSelect={select}
                  onMoveCard={onMoveCard}
                  onAddCard={addCard}
                  onAddColumn={addColumn}
                  onRenameColumn={renameColumn}
                  onDeleteColumn={deleteColumn}
                  onSetTags={setTags}
                  contextMenu={editorContextMenu}
                  onEditorContextMenuCapture={onEditorContextMenuCapture}
                  editorEpoch={editorEpoch}
                  nestingEditor={nestingEditor}
                  pageRefRestorePending={pageRefRestorePending}
                  editorValue={editorValue}
                  onChange={onChange}
                  onEditorDirty={onEditorDirty}
                  onEditorSerialized={onEditorSerialized}
                  registerFlush={registerEditorFlush}
                  pages={allPages}
                  searchHighlight={searchHighlight}
                  onSearchHighlightStatus={onSearchHighlightStatus}
                  onReparentPageRef={onReparentPageRef}
                  onRequestRemovePageRef={requestEditorPageRefRemoval}
                  onCreatePageAtCursor={createPageFromSlash}
                  subpages={ordinaryChildren}
                />
                </article>
              </>
              )}
              </NotesCanvasBody>
            ) : (
              <Hub tree={tree} onSelect={select} onCreate={createFromHub} />
            )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <MobilePagesView
        open={mobilePagesOpen}
        tree={tree}
        selectedId={selectedId}
        footer={<MobileTabBar {...mobileTabBarProps} contained />}
        returnFocusRef={mobilePagesTabRef}
        fallbackFocusRef={mainRef}
        nestedModalOpen={paletteOpen}
        onClose={closeMobilePages}
        onOpenSettings={() => openSettings()}
        onSelect={select}
      />

      {!mobileBlockingSurfaceOpen && <MobileTabBar {...mobileTabBarProps} />}
      {commandPalette}

      <ShellOverlays
        tree={tree}
        selectedId={selectedId}
        currentNode={currentNode}
        save={save}
        localRecoveryUnavailable={localRecoveryUnavailable}
        dialogReturnFocusRef={dialogReturnFocusRef}
        shortcutsOpen={shortcutsOpen}
        onShortcutsOpenChange={setShortcutsOpen}
        pageRefRemoveTarget={pageRefRemoveTarget}
        setPageRefRemoveTarget={setPageRefRemoveTarget}
        onRemoveConfirmedPageRef={removeConfirmedPageRef}
        renameTarget={renameTarget}
        setRenameTarget={setRenameTarget}
        onRenamePage={renamePage}
        moveTarget={moveTarget}
        setMoveTarget={setMoveTarget}
        onMoveDialogMove={async (id, parentId, beforeId) => {
          const oldParentId =
            findPath(treeRef.current, id).at(-1)?.parentId ?? null;
          if (
            blockConflictMutation([
              selectedIdRef.current,
              id,
              oldParentId,
              parentId,
            ])
          ) {
            throw new Error(MOVE_BLOCKED_MESSAGE);
          }
          if (!(await onMove(id, parentId, beforeId))) {
            throw new Error("move failed");
          }
        }}
        smartPreview={smartPreview}
        onApplySmartSort={applySmartSort}
        onCancelSmartSort={() => setSmartPreview(null)}
        smartUndoOpen={smartUndoOpen}
        smartUndoPageId={smartUndoPageId}
        onUndoSmartSort={() => {
          setSmartUndoOpen(false);
          undoSmartSort();
        }}
        pageRefUndo={pageRefUndo}
        onRestoreRemovedPageRef={restoreRemovedPageRef}
        trashOpen={trashOpen}
        onTrashOpenChange={setTrashOpen}
        onTrashChanged={() => {
          refreshTree();
        }}
        historyDialog={historyDialog}
        setHistoryDialog={setHistoryDialog}
        historyBaseRevision={historyBaseRevision}
        onHistoryRestored={async () => {
          if (!selectedId) return;
          const restoredId = selectedId;
          const r = await apiFetch(`/api/page/${restoredId}`);
          if (r.ok) {
            const p = await r.json();
            const loaded: LoadedPage = {
              id: restoredId,
              title: p.meta.title,
              icon: p.meta.icon,
              cover: p.meta.cover,
              stickers: p.meta.stickers ?? [],
              markdown: p.markdown,
              rev: p.rev,
            };
            cachePut(loaded);
            if (pendingRef.current?.id !== restoredId) {
              revisionsRef.current.set(restoredId, p.rev);
              baseMarkdownRef.current.set(restoredId, p.markdown);
              if (selectedIdRef.current === restoredId) {
                setPage(loaded);
                setEditorEpoch((e) => e + 1);
              }
            }
          }
          void refreshTree().catch(() => {});
        }}
        pendingDelete={pendingDelete}
        recoveryMessage={recoveryMessage}
        recoveryCopyId={recoveryCopyId}
        onSaveConflictCopy={saveConflictCopy}
        toast={toast}
        toastActionPending={toastActionPending}
        urgentToast={urgentToast}
        onToastAction={runToastAction}
        onPauseToast={pauseToast}
        onResumeToast={resumeToast}
        countdown={countdown}
        onUndoDelete={undoDelete}
        onPauseDelete={pauseDelete}
        onResumeDelete={resumeDelete}
      />
    </div>
  );
}
