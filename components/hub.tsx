"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import type { TreeNode } from "@/lib/store/types";
import { DUR, EASE_OUT } from "@/lib/motion";
import { Empty } from "./ui/empty";
import { Field } from "./ui/field";
import { Kbd } from "./ui/primitives";
import { formatAgo } from "@/lib/format-ago";

const QUICK_CAPTURE_STORAGE_PREFIX = "brain-quick-capture-record-v3:";
const QUICK_CAPTURE_ACTIVE_KEY = "brain-quick-capture-active-record-v3";
const QUICK_CAPTURE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const QUICK_CAPTURE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const QUICK_CAPTURE_MAX_LENGTH = 500;

interface StoredQuickCapture {
  draft: string;
  idempotencyKey: string;
  attempted: boolean;
  updatedAt: number;
  orphanedAt?: number;
}

function newOpaqueId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function quickCaptureStorageKey(recordId: string): string {
  return `${QUICK_CAPTURE_STORAGE_PREFIX}${recordId}`;
}

function decodeQuickCapture(
  raw: string,
  now: number,
): StoredQuickCapture | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredQuickCapture>;
    return typeof value.draft === "string" &&
      value.draft.length > 0 &&
      value.draft.length <= QUICK_CAPTURE_MAX_LENGTH &&
      typeof value.idempotencyKey === "string" &&
      QUICK_CAPTURE_ID_RE.test(value.idempotencyKey) &&
      typeof value.attempted === "boolean" &&
      typeof value.updatedAt === "number" &&
      Number.isFinite(value.updatedAt) &&
      value.updatedAt >= 0 &&
      (value.orphanedAt === undefined ||
        (typeof value.orphanedAt === "number" &&
          Number.isFinite(value.orphanedAt) &&
          value.orphanedAt >= 0)) &&
      now - value.updatedAt <= QUICK_CAPTURE_TTL_MS
      ? {
          draft: value.draft,
          idempotencyKey: value.idempotencyKey,
          attempted: value.attempted,
          updatedAt: value.updatedAt,
          orphanedAt: value.orphanedAt,
        }
      : null;
  } catch {
    return null;
  }
}

function loadQuickCapture(): {
  capture: (StoredQuickCapture & { recordId: string }) | null;
  storageAvailable: boolean;
} {
  try {
    const now = Date.now();
    const activeRecordId = sessionStorage.getItem(QUICK_CAPTURE_ACTIVE_KEY);
    let activeCapture:
      | (StoredQuickCapture & { recordId: string })
      | null = null;
    if (activeRecordId && QUICK_CAPTURE_ID_RE.test(activeRecordId)) {
      const activeStorageKey = quickCaptureStorageKey(activeRecordId);
      const activeRaw = localStorage.getItem(activeStorageKey);
      const active = activeRaw
        ? decodeQuickCapture(activeRaw, now)
        : null;
      if (active) {
        activeCapture = { recordId: activeRecordId, ...active };
      } else {
        if (activeRaw !== null) localStorage.removeItem(activeStorageKey);
        sessionStorage.removeItem(QUICK_CAPTURE_ACTIVE_KEY);
      }
    } else if (activeRecordId) {
      sessionStorage.removeItem(QUICK_CAPTURE_ACTIVE_KEY);
    }

    // Scan only our own namespace on every mount. Expired/malformed records can
    // never be recovered safely; every valid record remains available to its
    // tab. Without a valid pointer, the freshest orphan wins this tab.
    const storageKeys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(QUICK_CAPTURE_STORAGE_PREFIX)) {
        storageKeys.push(key);
      }
    }
    let freshest: (StoredQuickCapture & { recordId: string }) | null = null;
    for (const storageKey of storageKeys) {
      const recordId = storageKey.slice(QUICK_CAPTURE_STORAGE_PREFIX.length);
      const raw = localStorage.getItem(storageKey);
      const capture =
        QUICK_CAPTURE_ID_RE.test(recordId) && raw !== null
          ? decodeQuickCapture(raw, now)
          : null;
      if (!capture) {
        localStorage.removeItem(storageKey);
        continue;
      }
      if (
        capture.orphanedAt !== undefined &&
        (!freshest ||
          (capture.updatedAt > freshest.updatedAt ||
            (capture.updatedAt === freshest.updatedAt &&
              recordId > freshest.recordId)))
      ) {
        freshest = { recordId, ...capture };
      }
    }
    return {
      capture: activeCapture ?? freshest,
      storageAvailable: true,
    };
  } catch {
    return { capture: null, storageAvailable: false };
  }
}

function persistQuickCapture(
  recordId: string,
  draft: string,
  idempotencyKey: string,
  attempted: boolean,
  orphanedAt?: number,
): boolean {
  try {
    localStorage.setItem(
      quickCaptureStorageKey(recordId),
      JSON.stringify({
        draft,
        idempotencyKey,
        attempted,
        updatedAt: Date.now(),
        ...(orphanedAt === undefined ? {} : { orphanedAt }),
      }),
    );
    sessionStorage.setItem(QUICK_CAPTURE_ACTIVE_KEY, recordId);
    return true;
  } catch {
    return false;
  }
}

function clearQuickCapture(recordId: string): void {
  try {
    localStorage.removeItem(quickCaptureStorageKey(recordId));
  } catch {}
  try {
    if (sessionStorage.getItem(QUICK_CAPTURE_ACTIVE_KEY) === recordId) {
      sessionStorage.removeItem(QUICK_CAPTURE_ACTIVE_KEY);
    }
  } catch {}
}

interface FlatPage {
  id: string;
  title: string;
  icon?: string;
  created: string;
  updated: string;
  updatedBy?: "me" | "claude";
  public?: boolean;
}

function flatten(tree: TreeNode[]): FlatPage[] {
  const out: FlatPage[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push({
        id: n.id,
        title: n.title,
        icon: n.icon,
        created: n.created,
        updated: n.updated,
        updatedBy: n.updatedBy,
        public: n.public,
      });
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

const WEEK = 7 * 24 * 3600 * 1000;

/** The smart hub — "/" landing: what changed (incl. Claude), where you left
 *  off, and a capture box that needs no destination. */
export function Hub({
  tree,
  onSelect,
  onCreate,
}: {
  tree: TreeNode[];
  onSelect: (id: string) => void;
  onCreate: (title: string, idempotencyKey: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState("");
  const [capturePending, setCapturePending] = useState(false);
  const [captureFailed, setCaptureFailed] = useState(false);
  const [localRecoveryAvailable, setLocalRecoveryAvailable] = useState(true);
  const [lastVisit, setLastVisit] = useState<number | null>(null);
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [activityExpanded, setActivityExpanded] = useState(false);
  // `now` is null until mount so the SSR HTML (which has no clock) matches the
  // first client render — the time-based feed + labels only render after mount
  const [now, setNow] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef("");
  const captureRecordIdRef = useRef<string | null>(null);
  const captureKeyRef = useRef<string | null>(null);
  const captureAttemptedRef = useRef(false);
  const capturePendingRef = useRef(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setNow(Date.now());
      try {
        const recovered = loadQuickCapture();
        setLocalRecoveryAvailable(recovered.storageAvailable);
        if (recovered.capture) {
          const ownedRecordId = newOpaqueId();
          captureRecordIdRef.current = ownedRecordId;
          captureKeyRef.current = recovered.capture.idempotencyKey;
          captureAttemptedRef.current = recovered.capture.attempted;
          draftRef.current = recovered.capture.draft;
          setDraft(recovered.capture.draft);
          setCaptureFailed(recovered.capture.attempted);
          const cloned = persistQuickCapture(
            ownedRecordId,
            recovered.capture.draft,
            recovered.capture.idempotencyKey,
            recovered.capture.attempted,
          );
          setLocalRecoveryAvailable(cloned);
          if (cloned && recovered.capture.orphanedAt !== undefined) {
            clearQuickCapture(recovered.capture.recordId);
          }
        }
        const v = localStorage.getItem("brain-hub-visit");
        setLastVisit(v ? Number(v) : null);
        setLastOpened(localStorage.getItem("brain-last-opened"));
        localStorage.setItem("brain-hub-visit", String(Date.now()));
      } catch {}
      // autofocus only where a pointer hovers: on a touch device a focused
      // field raises the keyboard on every arrival at Home, and the width
      // says nothing about the finger — an iPad at 1024 is as much a touch
      // device as a phone at 390
      if (window.matchMedia?.("(hover: hover)").matches) inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const markOwnedRecordOrphaned = () => {
      const recordId = captureRecordIdRef.current;
      const idempotencyKey = captureKeyRef.current;
      const exactDraft = draftRef.current;
      if (!recordId || !idempotencyKey || !exactDraft) return;
      persistQuickCapture(
        recordId,
        exactDraft,
        idempotencyKey,
        captureAttemptedRef.current,
        Date.now(),
      );
    };
    window.addEventListener("pagehide", markOwnedRecordOrphaned);
    return () => {
      window.removeEventListener("pagehide", markOwnedRecordOrphaned);
      markOwnedRecordOrphaned();
    };
  }, []);

  const updateDraft = (value: string) => {
    const previousDraft = draftRef.current;
    draftRef.current = value;
    setDraft(value);
    setCaptureFailed(false);
    if (!value) {
      const previousRecordId = captureRecordIdRef.current;
      captureRecordIdRef.current = null;
      captureKeyRef.current = null;
      captureAttemptedRef.current = false;
      if (previousRecordId) clearQuickCapture(previousRecordId);
      return;
    }
    const recordId = captureRecordIdRef.current ?? newOpaqueId();
    const key =
      previousDraft.length > 0 && value !== previousDraft
        ? newOpaqueId()
        : (captureKeyRef.current ?? newOpaqueId());
    captureRecordIdRef.current = recordId;
    captureKeyRef.current = key;
    captureAttemptedRef.current = false;
    setLocalRecoveryAvailable(
      persistQuickCapture(recordId, value, key, false),
    );
  };

  const submitCapture = async () => {
    const exactDraft = draftRef.current;
    const title = exactDraft.trim();
    if (!title || capturePendingRef.current) return;
    const recordId = captureRecordIdRef.current ?? newOpaqueId();
    const key = captureKeyRef.current ?? newOpaqueId();
    captureRecordIdRef.current = recordId;
    captureKeyRef.current = key;
    captureAttemptedRef.current = true;
    setLocalRecoveryAvailable(
      persistQuickCapture(recordId, exactDraft, key, true),
    );
    capturePendingRef.current = true;
    setCapturePending(true);
    setCaptureFailed(false);
    let confirmedId: string | null = null;
    try {
      confirmedId = await onCreate(title, key);
    } catch {}
    capturePendingRef.current = false;
    setCapturePending(false);
    if (confirmedId) {
      clearQuickCapture(recordId);
      captureRecordIdRef.current = null;
      captureKeyRef.current = null;
      captureAttemptedRef.current = false;
      draftRef.current = "";
      setDraft("");
      return;
    }
    setCaptureFailed(true);
  };

  const pages = flatten(tree);
  const nowMs = now ?? 0;
  const fmtAgo = (iso: string) => (now ? formatAgo(iso, { compact: true }) : ""); // empty until mounted
  const continuePage = lastOpened ? pages.find((p) => p.id === lastOpened) : null;
  // Before the clock mounts (SSR + first client render) every page passes the
  // week filter — gate the feed on the mounted clock so "Review all" never
  // flashes a count of the whole tree. Hydration-safe: both renders see the
  // same empty list.
  const allActivity =
    now === null
      ? []
      : pages
          .filter((p) => nowMs - new Date(p.updated).getTime() < WEEK)
          .filter((p) => p.id !== continuePage?.id) // Continue already shows it
          .sort((a, b) => (a.updated < b.updated ? 1 : -1));
  const feed = activityExpanded ? allActivity : allActivity.slice(0, 5);
  const splitIdx = lastVisit
    ? feed.findIndex((p) => new Date(p.updated).getTime() <= lastVisit)
    : -1;
  const shared = pages.filter((p) => p.public);
  const localRecoveryUnavailable =
    draft.length > 0 && !localRecoveryAvailable;

  const enter = (i: number) => ({
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 6 },
    animate: reduce ? { opacity: 1 } : { opacity: 1, y: 0 },
    transition: reduce
      ? { duration: DUR.base }
      : { duration: DUR.base, ease: EASE_OUT, delay: 0.03 * i },
  });

  return (
    <div className="brain-page-top mx-auto max-w-[720px] px-5 pb-40 md:px-6">
      {/* quick capture — a thought needs no destination: a Field 32 on
          paper (hairline ring, blue on focus) */}
      <motion.div {...enter(0)}>
        <Field
          ref={inputRef}
          icon="pen-new-square"
          value={draft}
          readOnly={capturePending}
          maxLength={QUICK_CAPTURE_MAX_LENGTH}
          aria-busy={capturePending}
          onChange={(e) => updateDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              void submitCapture();
            }
          }}
          placeholder="New thought…"
          aria-label="New thought"
        />
        {(capturePending || captureFailed || localRecoveryUnavailable) && (
          <div className="mt-2 flex min-h-6 items-center gap-3 text-[12px] text-ink-3">
            <span
              role={
                captureFailed || localRecoveryUnavailable ? "alert" : "status"
              }
            >
              {localRecoveryUnavailable
                ? "Keep this tab open — local recovery is unavailable."
                : capturePending
                ? "Capturing…"
                : "Couldn't capture this note. Your draft is safe."}
            </span>
            {captureFailed && (
              <button
                type="button"
                aria-label="Retry quick capture"
                onClick={() => void submitCapture()}
                className="rounded-xs border border-line px-2 py-1 text-ink-2 transition-colors hover:bg-fill-hover"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </motion.div>

      {/* continue where you left off */}
      {continuePage && (
        <motion.div {...enter(1)} className="mt-8">
          <SectionLabel>Continue on this device</SectionLabel>
          <Row page={continuePage} onSelect={onSelect} trailing={fmtAgo(continuePage.updated)} />
        </motion.div>
      )}

      {/* a brand-new notebook teaches the interface instead of claiming a
          "quiet week" that never happened */}
      {pages.length === 0 ? (
        <motion.div {...enter(1)} className="mt-10">
          <p className="text-[14px] text-ink-2">
            Your notebook is empty. Capture a thought above, or:
          </p>
          <ul className="mt-4 space-y-3 text-[13px] text-ink-2 [@media(hover:none)]:hidden">
            <li className="flex items-center gap-3">
              <Kbd>⌘K</Kbd>
              <span>jump to or search any page</span>
            </li>
            <li className="flex items-center gap-3">
              <Kbd>/</Kbd>
              <span>in the editor for headings, lists, callouts, tables…</span>
            </li>
            <li className="flex items-center gap-3">
              <Kbd>⌘⌥N</Kbd>
              <span>start a new page</span>
            </li>
          </ul>
          {/* no keyboard on a phone — point at the tab bar instead */}
          <p className="mt-4 hidden text-[13px] text-ink-2 [@media(hover:none)]:block">
            tap Search below to find any page, or New to start one.
          </p>
        </motion.div>
      ) : (
        <>
      {/* This timeline is based on this browser's local visit marker. Keep the
          label honest: it is not cross-device activity tracking. */}
      <motion.div {...enter(2)} className="mt-8">
        <SectionLabel>Since this device was last open</SectionLabel>
        {now !== null && feed.length === 0 && (
          <Empty
            icon="clock-circle-linear"
            title="Quiet week"
            hint="Nothing changed yet"
            className="px-2 py-5"
          />
        )}
        {feed.map((p, i) => (
          <div key={p.id}>
            {i === splitIdx && i > 0 && (
              <div className="my-1.5 flex items-center gap-2 px-2">
                <span className="h-px flex-1 bg-hair-soft" />
                <span className="text-label text-ink-3">Last opened here</span>
                <span className="h-px flex-1 bg-hair-soft" />
              </div>
            )}
            <Row
              page={p}
              onSelect={onSelect}
              isNew={lastVisit != null && new Date(p.created).getTime() > lastVisit}
              byClaude={p.updatedBy === "claude"}
              trailing={fmtAgo(p.updated)}
            />
          </div>
        ))}
        {now !== null && allActivity.length > 5 && (
          <button
            type="button"
            aria-expanded={activityExpanded}
            onClick={() => setActivityExpanded((expanded) => !expanded)}
            className="-mx-2 mt-1 rounded-sm px-2 py-1.5 text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2"
          >
            {activityExpanded ? "Show less" : `Review all (${allActivity.length})`}
          </button>
        )}
      </motion.div>

      {/* public surface audit */}
      {shared.length > 0 && (
        <motion.div {...enter(3)} className="mt-8">
          <SectionLabel>Public</SectionLabel>
          {shared.map((p) => (
            <Row key={p.id} page={p} onSelect={onSelect} trailing={fmtAgo(p.updated)} />
          ))}
        </motion.div>
      )}
        </>
      )}
    </div>
  );
}

/* Section heading on paper: the H3 register (15/600), sentence case.
   No inline padding: a HubRow pulls its hover capsule 8px out of the column
   and pays it back as padding, so the row's own content sits on the column's
   content edge. Anything that is not a capsule has to start there too, or the
   column grows a second left rule 8px in — which is what it had. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-h3 pb-1.5 text-ink">{children}</p>;
}

function Row({
  page,
  onSelect,
  trailing,
  isNew = false,
  byClaude = false,
}: {
  page: FlatPage;
  onSelect: (id: string) => void;
  trailing?: string;
  isNew?: boolean;
  byClaude?: boolean;
}) {
  return (
    <button
      onClick={() => onSelect(page.id)}
      className="-mx-2 flex h-10 w-[calc(100%+16px)] items-center gap-2.5 rounded-[var(--r-block)] px-2 text-left transition-colors hover:bg-blue-tint md:h-9"
    >
      <span className="grid size-5 shrink-0 place-items-center text-[15px] leading-none">
        {page.icon ?? DEFAULT_PAGE_ICON}
      </span>
      {isNew && (
        <span
          aria-label="new since your last visit"
          className="size-1.5 shrink-0 rounded-full bg-ink"
        />
      )}
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{page.title}</span>
      {byClaude && (
        <span className="shrink-0 rounded-xs border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
          Brain AI
        </span>
      )}
      {trailing && <span className="shrink-0 text-[12px] text-ink-3">{trailing}</span>}
    </button>
  );
}
