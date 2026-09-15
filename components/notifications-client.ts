"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/client";
import { mailNotificationId } from "@/lib/notifications/ids";

/** ONE FETCH OF THE CENTRE, READ BY EVERYTHING THAT DRAWS IT.
 *
 *  The bell carries the count and the menu under it carries the rows. Both are
 *  one question asked of one file, so it is asked once and the answer lives
 *  here. A second request for the number would answer at a different instant
 *  from the rows beside it, and a row marked read has to decrement the badge
 *  ONCE rather than once per source.
 *
 *  Built on the machinery of `components/tasks-client.ts`, with two
 *  differences, each for its own reason:
 *
 *  - No day and no offset, so no midnight timer. A notification carries its
 *    own instant and the list does not turn over at midnight.
 *  - There IS a `visibilitychange` reload, because a tab that was in the
 *    background missed its SSE events while the stream was asleep, and the
 *    bell it comes back to would be counting yesterday.
 */

/** THE ROW, AS THE BROWSER SEES IT.
 *
 *  Structurally `BrainNotification` from `lib/notifications/model.ts`, and
 *  written out again rather than imported. `components/notifications-read.ts`
 *  re-exports the mail seam through this module, and its own test walks the
 *  import graph looking for zod: `model.ts` builds `notificationSchema` at
 *  module scope and `package.json` declares no `sideEffects`, so a reference
 *  to that file from anywhere in this graph is a schema in Mail's chunk.
 *
 *  The two shapes are held to each other in `notifications-client.test.ts`,
 *  which is not in the bundler's graph: a field added to the schema and not
 *  here stops compiling there. The route validates against the schema before
 *  it answers, so nothing the browser sees has skipped it.
 */
export interface NotificationRow {
  readonly id: string;
  readonly kind: "task-reminder" | "task-missed" | "mail-new";
  readonly at: string;
  readonly title: string;
  readonly body?: string;
  readonly href: string;
  readonly readAt?: string;
}

export interface NotificationsState {
  readonly notifications: readonly NotificationRow[];
  readonly unread: number;
  readonly loading: boolean;
  /** The route's `reason`, else its `error`, else the transport's message. */
  readonly error: string | null;
}

const EMPTY: readonly NotificationRow[] = [];

let state: NotificationsState = {
  notifications: EMPTY,
  unread: 0,
  loading: false,
  error: null,
};
const listeners = new Set<() => void>();

/** The ids of the rows this tab holds unread, rebuilt on every commit. It is
 *  what lets a read that has no row behind it cost nothing, which is the
 *  common case for mail: the seam marks a thread read whether or not the
 *  centre ever produced a notification for it. */
let unreadIds = new Set<string>();

/** Whether the centre has ever answered. Before it has there is no set to
 *  consult, and a read that arrives then must still reach the server: the
 *  alternative is a thread read in a tab that never opened the bell staying
 *  unread in it for good. */
let loaded = false;

/** The refresh token of the records in hand. A load that would repeat it is
 *  skipped, which is what makes two subscribers one request. */
let loadedKey: string | null = null;
let lastToken = 0;
let inFlight: AbortController | null = null;
let watchers = 0;

function publish(): void {
  for (const listener of listeners) listener();
}

function set(patch: Partial<NotificationsState>): void {
  state = { ...state, ...patch };
  publish();
}

/** THE COUNT IS DERIVED FROM THE ROWS, not taken from the route's own
 *  `unread` field. They are the same count of the same records at the instant
 *  the route answered, and the field is there for a caller that wants the
 *  number without the list. Here the list is already in hand, and a derived
 *  number cannot drift from the rows drawn beside it, which is the whole
 *  reason the two live in one module. */
function commit(rows: readonly NotificationRow[]): void {
  const next = new Set<string>();
  for (const item of rows) if (item.readAt === undefined) next.add(item.id);
  unreadIds = next;
  set({ notifications: rows, unread: next.size, loading: false, error: null });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getState(): NotificationsState {
  return state;
}

async function reasonOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const shape = body as { error?: unknown; reason?: unknown };
      if (typeof shape.reason === "string") return shape.reason;
      if (typeof shape.error === "string") return shape.error;
    }
  } catch {
    // a body that is not JSON says nothing a reader can act on
  }
  return `Request failed (${response.status})`;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Notifications could not load";
}

async function load(token: number): Promise<void> {
  lastToken = token;
  const key = String(token);
  if (key === loadedKey) return;
  loadedKey = key;

  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  set({ loading: true, error: null });
  try {
    const response = await apiFetch("/api/notifications", { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (!response.ok) throw new Error(await reasonOf(response));
    const body = (await response.json()) as {
      notifications?: readonly NotificationRow[];
    };
    if (controller.signal.aborted) return;
    loaded = true;
    commit(body.notifications ?? EMPTY);
  } catch (error) {
    if (controller.signal.aborted) return;
    // A key that failed has to be askable again, or the next event would find
    // the store already holding it and ask nothing.
    loadedKey = null;
    set({ loading: false, error: messageOf(error) });
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

/** Ask again for the same token: after a write the server refused, and on
 *  coming back to a tab that slept through its own events. */
export function reloadNotifications(): void {
  loadedKey = null;
  void load(lastToken);
}

function onVisible(): void {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  reloadNotifications();
}

function watch(): void {
  watchers += 1;
  if (watchers === 1 && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }
}

function release(): void {
  watchers = Math.max(0, watchers - 1);
  if (watchers > 0) return;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisible);
  }
}

/** The rows, the count and the state of the request that fetched them.
 *  `refreshToken` is the shell's count of `notification` store events; a new
 *  one re-asks. */
export function useNotifications(refreshToken = 0): NotificationsState {
  const snapshot = useSyncExternalStore(subscribe, getState, getState);
  useEffect(() => {
    watch();
    return release;
  }, []);
  useEffect(() => {
    void load(refreshToken);
  }, [refreshToken]);
  return snapshot;
}

/** Whether this tab holds an unread row under that id. The mail seam's skip
 *  reads it, and so does anything else that wants to know before it asks. */
export function hasUnreadRow(id: string): boolean {
  return unreadIds.has(id);
}

/** Whether a read under this id is worth a request at all. Before the centre
 *  has answered there is no set to consult and every read must reach the
 *  server; after it, only an id it holds unread. The seam asks this before the
 *  id joins a batch, and `sendable` asks it again for whatever did. */
function worthAsking(id: string): boolean {
  return !loaded || hasUnreadRow(id);
}

/** The ids worth a request, in the order they were offered. */
function sendable(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter(worthAsking);
}

function commitRead(ids: readonly string[], at: string): void {
  const marked = new Set(ids);
  commit(
    state.notifications.map((item) =>
      marked.has(item.id) && item.readAt === undefined ? { ...item, readAt: at } : item,
    ),
  );
}

/** Mark rows read: the commit is optimistic, and a refusal is answered with a
 *  re-read rather than a rollback. The server is the truth, a re-read is one
 *  request, and a rollback would be a guess about which of the ids landed. */
export async function markRead(ids: readonly string[]): Promise<void> {
  const owed = sendable(ids);
  if (owed.length === 0) return;
  commitRead(owed, new Date().toISOString());
  try {
    const response = await apiFetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: owed }),
    });
    if (!response.ok) throw new Error(await reasonOf(response));
  } catch {
    reloadNotifications();
  }
}

/** Clear the centre. It touches no mailbox: the route's own comment says why,
 *  and the row that calls this is drawn only while something is unread. */
export async function markAllRead(): Promise<void> {
  const at = new Date().toISOString();
  commit(
    state.notifications.map((item) =>
      item.readAt === undefined ? { ...item, readAt: at } : item,
    ),
  );
  try {
    const response = await apiFetch("/api/notifications/read-all", { method: "POST" });
    if (!response.ok) throw new Error(await reasonOf(response));
  } catch {
    reloadNotifications();
  }
}

/** ONE POST PER RUN, NOT ONE PER LETTER.
 *
 *  Bulk Done marks every unread thread it archives, one at a time, and each
 *  POST reads and re-parses the whole centre file through the store's
 *  serialised queue. Forty threads was forty of those, for rows that in the
 *  common case do not exist at all. The ids collect instead and go out in one
 *  body a quarter second after the last one lands, so a run of forty is one
 *  request on a bell the reader is not looking at.
 */
const FLUSH_MS = 250;

/** A reader holding the down arrow auto-reads a thread per keypress, and a
 *  window that restarts on every mark would never close while they held it.
 *  The route takes up to `NOTIFICATION_CAP` ids, so this is far inside it. */
const MAX_BATCH = 100;

const pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function send(ids: readonly string[]): void {
  try {
    void markRead(ids).catch(() => undefined);
  } catch {
    // A `fetch` that throws synchronously rather than rejecting, which a test
    // double or a locked-down runtime can do. The mail mutation already
    // landed; the bell is not worth failing it for.
  }
}

/** Everything collected so far, now. Exported for a caller that knows its run
 *  is over and does not want to wait out the window. */
export function flushMailNotificationReads(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size === 0) return;
  const ids = [...pending];
  pending.clear();
  send(ids);
}

/** THE SEAM FOR "THIS THREAD IS READ" (spec §7, D6).
 *
 *  Every read in Mail reaches the service through one method,
 *  `MailSurfaceClient.updateThread`, so the centre's half of it hangs there
 *  rather than being threaded to four call sites inside a five-thousand line
 *  component. The id is derived from the account and the thread, so there is
 *  no lookup, and a thread the centre holds no unread row for is dropped by
 *  `sendable` before a request is made.
 *
 *  It never throws at its caller. A mail mutation that worked must not be
 *  reported as failed because the bell could not be updated.
 */
export function markMailNotificationRead(accountId: string, threadId: string): void {
  let id: string;
  try {
    id = mailNotificationId(accountId, threadId);
  } catch {
    return;
  }
  // THE CENTRE IS ASKED BEFORE THE ID JOINS THE BATCH. `hasUnreadRow` is the
  // public form of that question and this is its caller: a mailbox read in a
  // tab whose bell holds no row for the thread is the common case, and it now
  // costs neither a batch entry nor a timer. `sendable` asks the same thing of
  // whatever did join, because the centre can answer between the two.
  if (!worthAsking(id)) return;
  // A Set, so a thread marked twice inside one window costs one id and not
  // two. The centre answers `{ read: 0 }` for the second anyway, but the
  // cheapest request is the one nobody sent.
  pending.add(id);
  if (pending.size >= MAX_BATCH) {
    flushMailNotificationReads();
    return;
  }
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushMailNotificationReads, FLUSH_MS);
}

/** The tests own this. Module state outlives a test file's cases, and a bell
 *  mounted in the next one would read the last one's rows. */
export function resetNotificationsStore(): void {
  inFlight?.abort();
  inFlight = null;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  pending.clear();
  watchers = 0;
  loaded = false;
  loadedKey = null;
  lastToken = 0;
  unreadIds = new Set();
  state = { notifications: EMPTY, unread: 0, loading: false, error: null };
  listeners.clear();
}
