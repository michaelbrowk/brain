"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/client";
import type { TaskView } from "@/lib/tasks/model";

/** ONE FETCH OF THE TASKS, READ BY EVERYTHING THAT NEEDS THEM.
 *
 *  The surface draws the lists and the sidebar row draws the count of what is
 *  open today, and both are the same question asked of the same records. A
 *  second request for the number would answer at a different instant from the
 *  rows beside it, so the count could disagree with the list the reader is
 *  looking at, and a completion has to decrement it ONCE, not once per
 *  source. So the records live here, in one module, and both consumers
 *  subscribe: the surface's optimistic write moves the rows and the number in
 *  the same commit.
 *
 *  The day is the reader's own. No route derives a list without `today` and
 *  `offset`, because a date from the server's clock flips the list at 03:00
 *  in Moscow and a day early in Dubai. This module is where the browser's
 *  answer to that comes from, and it re-asks on `visibilitychange`, on focus
 *  and on a timer armed for the next local midnight.
 */

export interface TasksDay {
  readonly today: string;
  readonly offsetMinutes: number;
}

export interface TasksState {
  /** null until the first mount has read the browser's clock. */
  readonly day: TasksDay | null;
  readonly tasks: readonly TaskView[];
  readonly loading: boolean;
  /** The route's `reason`, else its `error`, else the transport's message. */
  readonly error: string | null;
}

const EMPTY: readonly TaskView[] = [];

let state: TasksState = { day: null, tasks: EMPTY, loading: false, error: null };
const listeners = new Set<() => void>();

/** `${today}|${offset}|${refreshToken}` of the records in hand. A load that
 *  would repeat it is skipped, which is what makes two subscribers one
 *  request. */
let loadedKey: string | null = null;
let lastToken = 0;
let inFlight: AbortController | null = null;
let dayTimer: ReturnType<typeof setTimeout> | null = null;
let watchers = 0;

function set(patch: Partial<TasksState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getState(): TasksState {
  return state;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** The browser's own calendar day and its offset east of UTC. The one clock
 *  read in the subsystem, and it happens here so nothing below it has to. */
export function localDay(now: Date = new Date()): TasksDay {
  return {
    today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    offsetMinutes: -now.getTimezoneOffset(),
  };
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
  return error instanceof Error && error.message ? error.message : "Tasks could not load";
}

async function load(token: number): Promise<void> {
  lastToken = token;
  const day = state.day;
  if (!day) return;
  const key = `${day.today}|${day.offsetMinutes}|${token}`;
  if (key === loadedKey) return;
  loadedKey = key;

  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  set({ loading: true, error: null });
  try {
    const response = await apiFetch(
      `/api/tasks?today=${day.today}&offset=${day.offsetMinutes}`,
      { signal: controller.signal },
    );
    if (controller.signal.aborted) return;
    if (!response.ok) throw new Error(await reasonOf(response));
    const body = (await response.json()) as { tasks?: readonly TaskView[] };
    if (controller.signal.aborted) return;
    set({ tasks: body.tasks ?? EMPTY, loading: false, error: null });
  } catch (error) {
    if (controller.signal.aborted) return;
    // A key that failed has to be askable again, or Try again would be a
    // button that does nothing.
    loadedKey = null;
    set({ loading: false, error: messageOf(error) });
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

function syncDay(): void {
  const next = localDay();
  const day = state.day;
  if (!day || day.today !== next.today || day.offsetMinutes !== next.offsetMinutes) {
    loadedKey = null;
    set({ day: next });
    void load(lastToken);
  }
  armMidnight();
}

/** A second past the next local midnight, so the timer never lands on the
 *  boundary itself and reads the day it just left. */
function armMidnight(): void {
  if (dayTimer) clearTimeout(dayTimer);
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    1,
  );
  dayTimer = setTimeout(syncDay, Math.max(1_000, midnight.getTime() - now.getTime()));
}

function watchDay(): void {
  watchers += 1;
  if (watchers === 1 && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", syncDay);
    window.addEventListener("focus", syncDay);
  }
  syncDay();
}

function releaseDay(): void {
  watchers = Math.max(0, watchers - 1);
  if (watchers > 0) return;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", syncDay);
    window.removeEventListener("focus", syncDay);
  }
  if (dayTimer) clearTimeout(dayTimer);
  dayTimer = null;
}

/** The records, the day they answer for, and the state of the request that
 *  fetched them. `refreshToken` is the shell's count of task events this tab
 *  did not write; a new one re-asks. */
export function useTasks(refreshToken: number): TasksState {
  const snapshot = useSyncExternalStore(subscribe, getState, getState);
  useEffect(() => {
    watchDay();
    return releaseDay;
  }, []);
  useEffect(() => {
    void load(refreshToken);
  }, [refreshToken, snapshot.day]);
  return snapshot;
}

/** Move the records this tab already knows about, without a round trip: an
 *  optimistic completion, its revert, a created task landing at the top. Both
 *  the column and the sidebar count read the result of this one call. */
export function mutateTasks(
  update: (tasks: readonly TaskView[]) => readonly TaskView[],
): void {
  set({ tasks: update(state.tasks) });
}

/** Ask again for the same day, after a write or from "Try again". */
export function reloadTasks(): void {
  loadedKey = null;
  void load(lastToken);
}

/** The tests own this. Module state outlives a test file's cases, and a
 *  surface mounted in the next one would read the last one's records. */
export function resetTasksStore(): void {
  inFlight?.abort();
  inFlight = null;
  if (dayTimer) clearTimeout(dayTimer);
  dayTimer = null;
  watchers = 0;
  loadedKey = null;
  lastToken = 0;
  state = { day: null, tasks: EMPTY, loading: false, error: null };
  listeners.clear();
}

/** What a route refused, in the words it used. Every task route answers
 *  `{ error, reason? }`, so a caller shows `reason` when there is one. */
export class TaskRequestError extends Error {}

async function refuse(response: Response): Promise<never> {
  throw new TaskRequestError(await reasonOf(response));
}

export interface CreateTaskInput {
  title: string;
  when?: string;
  deadline?: string;
  category?: string;
}

export async function createTask(input: CreateTaskInput): Promise<TaskView> {
  const response = await apiFetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) await refuse(response);
  const body = (await response.json()) as { task: TaskView };
  return body.task;
}

export interface TaskPatch {
  title?: string;
  when?: string | null;
  deadline?: string | null;
  category?: string | null;
  done?: boolean;
}

/** `today` rides along only where the store takes it: completing a repeating
 *  task, whose next occurrence is computed from max(when, today). Anywhere
 *  else the route answers `unexpected_today`, on purpose. */
export async function patchTask(
  id: string,
  patch: TaskPatch,
  today?: string,
): Promise<TaskView> {
  const query = today ? `?today=${today}` : "";
  const response = await apiFetch(`/api/tasks/${id}${query}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) await refuse(response);
  const body = (await response.json()) as { task: TaskView };
  return body.task;
}
