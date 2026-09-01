// Pure helpers of the app shell: navigation-presence reducer, tree
// operations, daily-note lookup, page-cache shapes, structure reconciliation
// reads, share-scope guards, DOM focus probes. Nothing here closes over
// component state — every function takes what it needs as arguments.
// Extracted verbatim from shell.tsx (S1 of the shell extraction).

import { apiFetch } from "@/lib/client";
import type { SetStateAction } from "react";
import type { ShareScopeSnapshot, Sticker, TreeNode } from "@/lib/store/types";
import { TEMPLATES, type Template } from "@/lib/templates";
import {
  standalonePageRefOccurrences,
  type StandalonePageRefRestorePoint,
} from "@/lib/page-ref-nesting";
import { structureMutationConfirmed } from "@/lib/structure-reconciliation";
import type { SettingsSection } from "../settings/sections";
import type { PageRefEffectReceipt } from "./page-ref-reconcile";
import type { ToastOptions } from "../ui/primitives";

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

/**
 * What the shell's general-purpose snackbar is showing. It used to be the
 * title alone, which is all a message that only reports needs — an action
 * that MOVES something needs a way back in the same breath, so the state
 * carries the Snackbar's optional half too.
 */
export type ShellToast = { readonly title: string } & ToastOptions;

/**
 * Who gets the pill when a message arrives.
 *
 * A standing UNDO is not overwritten. Replacing it used to throw the way back
 * away with nothing said — press Done on Notifications, then on Newsletters
 * inside the window, and the first Undo was gone — and because the mail lock
 * refuses a second bulk action until the first has finished, that order is the
 * likely one rather than a rare one. So a live action holds the pill and what
 * arrives meanwhile waits its turn.
 *
 * The one message that may take the pill from it wears the SAME id: that is
 * the same sentence corrected, not a second one owed to the reader, and it
 * carries its own way back with it. An id already waiting is corrected in
 * place for the same reason, so a report and its correction never both stand
 * in the queue.
 *
 * `present: null` means "leave what is showing alone".
 *
 * A REFUSAL never comes here. Waiting is right for a report and wrong for an
 * answer to a gesture, so `showToast` routes an urgent message to its own pill
 * before this function is reached — see `ToastOptions.urgent`.
 */
export function toastAdmit(
  standing: ShellToast | null,
  waiting: readonly ShellToast[],
  next: ShellToast,
): { readonly present: ShellToast | null; readonly waiting: readonly ShellToast[] } {
  if (!standing?.onAction || (next.id != null && next.id === standing.id)) {
    return { present: next, waiting };
  }
  const at = next.id ? waiting.findIndex((entry) => entry.id === next.id) : -1;
  return {
    present: null,
    waiting:
      at >= 0
        ? waiting.map((entry, index) => (index === at ? next : entry))
        : [...waiting, next],
  };
}

/** The canvas surface: notes (a page or the hub), mail, or settings. */
export type ShellSurface = "notes" | "mail" | "settings";

export type NavigationPresenceState = {
  selectedId: string | null;
  surface: ShellSurface;
  /** The open settings section; null is the mobile root list. Meaningful
   *  only while `surface` is "settings". */
  settingsSection: SettingsSection | null;
  epoch: number;
};

export type NavigationPresenceAction =
  | { type: "selected-id"; value: SetStateAction<string | null> }
  | {
      type: "surface";
      surface: ShellSurface;
      settingsSection?: SettingsSection | null;
    };

export function navigationPresenceIdentity(state: NavigationPresenceState): string {
  if (state.surface === "mail") return "mail";
  if (state.surface === "settings")
    return `settings:${state.settingsSection ?? "root"}`;
  return state.selectedId ? `page:${state.selectedId}` : "hub";
}

export function navigationPresenceReducer(
  state: NavigationPresenceState,
  action: NavigationPresenceAction,
): NavigationPresenceState {
  const next = { ...state };
  if (action.type === "selected-id") {
    next.selectedId =
      typeof action.value === "function"
        ? action.value(state.selectedId)
        : action.value;
  } else {
    next.surface = action.surface;
    next.settingsSection =
      action.surface === "settings" ? (action.settingsSection ?? null) : null;
  }
  if (
    next.selectedId === state.selectedId &&
    next.surface === state.surface &&
    next.settingsSection === state.settingsSection
  ) {
    return state;
  }
  next.epoch =
    navigationPresenceIdentity(next) === navigationPresenceIdentity(state)
      ? state.epoch
      : state.epoch + 1;
  return next;
}

/** One canvas mount per navigation target: `page:<id>` / `hub` / `mail` /
 *  `settings:<section>`, suffixed with the epoch so A→B→A gets a fresh
 *  enter. Skeleton, load error and the resolved page all swap INSIDE this
 *  child — arrival never re-keys the canvas, which is what used to leave it
 *  at opacity 0 mid-exit. */
export function canvasPresenceKey(state: NavigationPresenceState): string {
  return `${navigationPresenceIdentity(state)}:${state.epoch}`;
}

export type FocusDialogSession = { open: boolean; owner: number };
export type FocusPageDialogTarget = FocusDialogSession & {
  id: string;
  title: string;
};
export type EditorContextPageRef = {
  id: string;
  occurrence: number;
  label?: string;
};
export type PageRefRemoveTarget = FocusPageDialogTarget & {
  sourcePageId: string;
  sourceTitle: string;
  targetMissing: boolean;
  occurrence: number;
  fingerprint: string;
};
export type PageRefUndo = {
  sourcePageId: string;
  targetTitle: string;
  mappedMarkdown: string;
  restorePoint: StandalonePageRefRestorePoint | null;
  restoreAttempt?: PageRefEffectReceipt;
  status: "ready" | "restoring" | "error";
  error?: string;
};
export type PageRefNestingOperation = {
  id: string;
  pageId: string;
  sourceId: string;
  sourceOccurrence: number;
  targetId: string;
  result: Promise<boolean>;
};

// value #4 — instantaneity. A small LRU of loaded pages so revisiting a page in
// a session is instant (show cached, revalidate by rev in the background), and
// hovering a tree row prefetches it. Cache holds server-authoritative bodies
// only (never unsaved edits) so revalidation can't clobber your typing.
export const PAGE_CACHE_CAP = 30;
export const RECENT_STORAGE_KEY = "brain-recent";
export const FOCUS_STORAGE_KEY = "brain-focus";
export const LOCAL_RECOVERY_UNAVAILABLE =
  "Keep this tab open — local recovery is unavailable";
export const STRUCTURE_MUTATION_TIMEOUT_MS = 3_000;
export const PAGE_REF_READBACK_FAILED = "page-ref read-back failed";
export const PAGE_REF_BODY_CHANGED = "page-ref body changed";
export const STRUCTURE_READ_TIMEOUT_MS = 1_500;

export const saveOperationKey = (id: string, operationId: string) =>
  `${id}\0${operationId}`;

export function dialogFocusFallback(): HTMLElement | null {
  const candidates = [
    document.querySelector<HTMLElement>(
      '.ProseMirror[contenteditable="true"]',
    ),
    ...document.querySelectorAll<HTMLElement>('[aria-label="Page actions"]'),
    document.querySelector<HTMLElement>("[data-dialog-focus-fallback]"),
  ];
  return (
    candidates.find((candidate) => {
      if (!candidate?.isConnected || candidate.getClientRects().length === 0)
        return false;
      const style = getComputedStyle(candidate);
      return style.display !== "none" && style.visibility !== "hidden";
    }) ?? null
  );
}

export function isVisibleFocusTarget(target: HTMLElement | null): target is HTMLElement {
  if (
    !target?.isConnected ||
    target.getClientRects().length === 0 ||
    target.closest('[aria-hidden="true"], [inert]')
  ) {
    return false;
  }
  const rect = target.getBoundingClientRect();
  const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
  const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
  return visibleWidth >= 1 && visibleHeight >= 1;
}

export async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

const QUICK_CAPTURE_TIMEOUT_MS = 10_000;

/** Create a root page from the hub's capture box and return its id.
 *
 *  A 409 that names a page is a success as well. The page id is derived from
 *  the capture key, so the page the server refuses to re-create is the page
 *  this very capture already made: the first answer was lost on the wire,
 *  and the retry crossed a deploy that changed what the fingerprint covers.
 *  Without the id the hub said "Couldn't capture" on a capture that had in
 *  fact landed, and the only way out was to change the text and get a
 *  duplicate. */
export async function captureThought(
  title: string,
  idempotencyKey: string,
): Promise<string> {
  const response = await fetchWithDeadline(
    "/api/page",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: null, title, idempotencyKey }),
    },
    QUICK_CAPTURE_TIMEOUT_MS,
  );
  const payload = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  const id = typeof payload?.id === "string" && payload.id ? payload.id : null;
  if (id && (response.ok || response.status === 409)) return id;
  throw new Error(response.ok ? "missing page id" : String(response.status));
}

export async function readTreeSnapshot(): Promise<TreeNode[]> {
  const response = await fetchWithDeadline(
    "/api/tree",
    {},
    STRUCTURE_READ_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`tree returned ${response.status}`);
  const payload = (await response.json()) as { tree?: TreeNode[] };
  if (!Array.isArray(payload.tree)) throw new Error("invalid tree response");
  return payload.tree;
}

export async function destinationContainsPageRef(
  destinationId: string,
  sourceId: string,
): Promise<boolean> {
  const response = await fetchWithDeadline(
    `/api/page/${encodeURIComponent(destinationId)}`,
    {},
    STRUCTURE_READ_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`page returned ${response.status}`);
  const payload = (await response.json()) as { markdown?: unknown };
  return (
    typeof payload.markdown === "string" &&
    standalonePageRefOccurrences(
      payload.markdown,
      sourceId,
      window.location.origin,
    ).length > 0
  );
}

export async function reconcileStructureMutation(
  id: string,
  parentId: string | null,
  beforeId: string | null,
  destinationRefRequired = false,
): Promise<{ confirmed: boolean; tree: TreeNode[] | null }> {
  let latest: TreeNode[] | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      latest = await readTreeSnapshot();
      const structureConfirmed = structureMutationConfirmed(
        latest,
        id,
        parentId,
        beforeId,
      );
      const bodyConfirmed =
        !destinationRefRequired ||
        (structureConfirmed &&
          parentId !== null &&
          (await destinationContainsPageRef(parentId, id)));
      if (structureConfirmed && bodyConfirmed) {
        return { confirmed: true, tree: latest };
      }
    } catch {}
    if (attempt < 2) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  return { confirmed: false, tree: latest };
}

export const RECENT_LIMIT = 6;
export const DAILY_PARENT_TITLE = "Daily";
export const DAILY_PARENT_ICON = "📅";
export const DAILY_PAGE_ICON = "☀️";
export const DAILY_NOTE_TEMPLATE = TEMPLATES.find((template) => template.id === "daily");
export const DAILY_PARENT_TEMPLATE: Template = {
  id: "daily-parent",
  name: DAILY_PARENT_TITLE,
  emoji: DAILY_PARENT_ICON,
  title: DAILY_PARENT_TITLE,
  markdown: "",
};
export const COVER_GRADIENTS: Record<string, string> = {
  "grad:1":
    "linear-gradient(135deg, var(--surface) 0%, color-mix(in oklch, var(--ink) 9%, var(--paper)) 100%)",
  "grad:2":
    "linear-gradient(135deg, color-mix(in oklch, var(--paper) 92%, var(--ink)) 0%, var(--line) 50%, color-mix(in oklch, var(--ink-2) 13%, var(--paper)) 100%)",
  "grad:3":
    "linear-gradient(160deg, color-mix(in oklch, var(--paper) 88%, var(--ink-2)) 0%, var(--paper) 42%, color-mix(in oklch, var(--ink) 12%, var(--surface)) 100%)",
  "grad:4":
    "linear-gradient(120deg, var(--paper) 0%, color-mix(in oklch, var(--ink) 6%, var(--paper)) 42%, color-mix(in oklch, var(--ink) 18%, var(--paper)) 100%)",
  "grad:5":
    "linear-gradient(145deg, color-mix(in oklch, var(--surface) 85%, var(--ink)) 0%, color-mix(in oklch, var(--line) 68%, var(--paper)) 52%, color-mix(in oklch, var(--paper) 82%, var(--ink-3)) 100%)",
};


export interface LoadedPage {
  id: string;
  title: string;
  icon?: string;
  cover?: string;
  stickers: Sticker[];
  markdown: string;
  rev: string;
}

export interface CreatedPageRef {
  id: string;
  title: string;
  icon?: string;
}

/** Raw `/api/page/:id` body → the shell's page shape. */
export type PageResponseBody = {
  meta: { title: string; icon?: string; cover?: string; stickers?: Sticker[] };
  markdown: string;
  rev: string;
};

/** A page read on the server for a deep link, so the canvas paints content
 *  with the HTML instead of a cold skeleton. Same shape as the API body. */
export type ShellInitialPage = PageResponseBody & { id: string };

export function loadedPageFromResponse(id: string, p: PageResponseBody): LoadedPage {
  return {
    id,
    title: p.meta.title,
    icon: p.meta.icon,
    cover: p.meta.cover,
    stickers: p.meta.stickers ?? [],
    markdown: p.markdown,
    rev: p.rev,
  };
}

/** A page load that adopts an in-flight hover prefetch instead of issuing a
 *  second GET. The prefetch carries no abort, so the adopting load's signal
 *  (cleanup + 12s timeout) still bounds the wait. */
export function adoptPrefetch<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function firstId(tree: TreeNode[]): string | null {
  return tree[0]?.id ?? null;
}

export function findPath(tree: TreeNode[], id: string): TreeNode[] {
  const dfs = (nodes: TreeNode[], trail: TreeNode[]): TreeNode[] | null => {
    for (const n of nodes) {
      const next = [...trail, n];
      if (n.id === id) return next;
      const found = dfs(n.children, next);
      if (found) return found;
    }
    return null;
  };
  return dfs(tree, []) ?? [];
}

export function smartChildSignature(children: TreeNode[]): string {
  return JSON.stringify(
    children
      .map((child) => [child.id, child.title, child.category ?? ""] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function findDailyParent(tree: TreeNode[]): TreeNode | null {
  return (
    tree.find((node) => node.title === DAILY_PARENT_TITLE && node.icon === DAILY_PARENT_ICON) ??
    null
  );
}

export function findDailyChild(parent: TreeNode, date: string): TreeNode | null {
  return parent.children.find((node) => node.title === date) ?? null;
}

export function formatLocalISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}


export function dailyTemplateFor(date: string): Template {
  return {
    id: DAILY_NOTE_TEMPLATE?.id ?? "daily",
    name: DAILY_NOTE_TEMPLATE?.name ?? "Daily note",
    emoji: DAILY_PAGE_ICON,
    title: date,
    markdown: DAILY_NOTE_TEMPLATE?.markdown ?? "",
  };
}

/** Optimistically remove a node (and subtree) from the local tree. */
export function removeNode(tree: TreeNode[], id: string): TreeNode[] {
  const t: TreeNode[] = structuredClone(tree);
  const strip = (nodes: TreeNode[]): TreeNode[] =>
    nodes.filter((n) => {
      if (n.id === id) return false;
      n.children = strip(n.children);
      n.hasChildren = n.children.length > 0;
      return true;
    });
  return strip(t);
}

/** Optimistically move a node in the tree (mirror of store.movePage) so the
 *  sidebar updates instantly on drop instead of snapping back. */
export function applyMove(
  tree: TreeNode[],
  id: string,
  newParentId: string | null,
  beforeId: string | null,
): TreeNode[] {
  const t: TreeNode[] = structuredClone(tree);
  let moved: TreeNode | null = null;
  const remove = (nodes: TreeNode[]): TreeNode[] =>
    nodes.filter((n) => {
      if (n.id === id) {
        moved = n;
        return false;
      }
      n.children = remove(n.children);
      n.hasChildren = n.children.length > 0;
      return true;
    });
  const roots = remove(t);
  if (!moved) return tree;
  (moved as TreeNode).parentId = newParentId;
  const insertInto = (nodes: TreeNode[]) => {
    const idx = beforeId ? nodes.findIndex((n) => n.id === beforeId) : -1;
    if (idx === -1) nodes.push(moved!);
    else nodes.splice(idx, 0, moved!);
  };
  if (newParentId === null) {
    insertInto(roots);
    return roots;
  }
  const find = (nodes: TreeNode[]): TreeNode | null => {
    for (const n of nodes) {
      if (n.id === newParentId) return n;
      const f = find(n.children);
      if (f) return f;
    }
    return null;
  };
  const parent = find(roots);
  if (parent) {
    insertInto(parent.children);
    parent.hasChildren = true;
  }
  return roots;
}

export function isShareScopeSnapshot(value: unknown): value is ShareScopeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const overlappingRoots = snapshot.overlappingRoots;
  return (
    typeof snapshot.rootId === "string" &&
    typeof snapshot.descendantCount === "number" &&
    Number.isInteger(snapshot.descendantCount) &&
    snapshot.descendantCount >= 0 &&
    Array.isArray(overlappingRoots) &&
    overlappingRoots.every((root) => {
      if (!root || typeof root !== "object" || Array.isArray(root)) return false;
      const candidate = root as Record<string, unknown>;
      return (
        typeof candidate.rootId === "string" &&
        typeof candidate.title === "string" &&
        (candidate.relation === "ancestor" ||
          candidate.relation === "descendant") &&
        (candidate.shareExpiresAt === null ||
          typeof candidate.shareExpiresAt === "string")
      );
    }) &&
    typeof snapshot.scopeToken === "string" &&
    /^[0-9a-f]{64}$/.test(snapshot.scopeToken) &&
    typeof snapshot.public === "boolean" &&
    typeof snapshot.shareLocked === "boolean" &&
    (snapshot.shareExpiresAt === null ||
      typeof snapshot.shareExpiresAt === "string") &&
    typeof snapshot.shareVersion === "number" &&
    Number.isInteger(snapshot.shareVersion) &&
    snapshot.shareVersion >= 0
  );
}

export function shareTreeRevision(nodes: TreeNode[]): string {
  const fields: string[] = [];
  const visit = (items: TreeNode[]) => {
    for (const node of items) {
      fields.push(
        `${node.id}:${node.parentId ?? ""}:${node.updated}:${!!node.public}:${
          node.shareExpiresAt ?? ""
        }`,
      );
      visit(node.children);
    }
  };
  visit(nodes);
  return fields.join("|");
}
