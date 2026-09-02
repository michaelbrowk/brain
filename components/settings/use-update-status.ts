"use client";

// One shared fetch of /api/settings/update per page load. The sidebar's dot
// and the Account section read the same store, and a refresh (POST) updates
// both. useSyncExternalStore keeps it a plain module, no context.

import { useCallback, useEffect, useSyncExternalStore } from "react";

export interface UpdateStatus {
  apiVersion: 1;
  version: string | null;
  commit: string;
  buildTime: string | null;
  updateCheck: "on" | "off";
  checkedAt: string | null;
  latest: { version: string; url: string; publishedAt: string } | null;
  updateAvailable: boolean;
  error: string | null;
}

export type UpdateLoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; status: UpdateStatus };

function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.apiVersion === 1 &&
    typeof v.commit === "string" &&
    typeof v.updateAvailable === "boolean" &&
    (v.updateCheck === "on" || v.updateCheck === "off")
  );
}

let state: UpdateLoadState = { kind: "loading" };
let started = false;
let refreshing = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

async function request(method: "GET" | "POST") {
  const response = await fetch("/api/settings/update", {
    method,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("update status unavailable");
  const body = (await response.json()) as unknown;
  if (!isUpdateStatus(body)) throw new Error("invalid update status");
  return body;
}

/** Resolves to whether the request landed. */
async function load(method: "GET" | "POST"): Promise<boolean> {
  if (method === "POST") {
    refreshing = true;
    emit();
  }
  try {
    state = { kind: "ready", status: await request(method) };
    return true;
  } catch {
    // a failed refresh keeps the last good status on screen; a failed first
    // read lets the next mount, or a retry, ask again
    if (state.kind !== "ready") {
      state = { kind: "error" };
      started = false;
    }
    return false;
  } finally {
    refreshing = false;
    emit();
  }
}

/** The one shared read: marks the store started so a second consumer, or a
 *  mount while a retry is in flight, does not ask again. */
function start(): Promise<boolean> {
  started = true;
  return load("GET");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests render fresh trees; the module cache must not leak between them. */
export function resetUpdateStatusForTests() {
  state = { kind: "loading" };
  started = false;
  refreshing = false;
}

export function useUpdateStatus(): {
  state: UpdateLoadState;
  refresh: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  refreshing: boolean;
} {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  const isRefreshing = useSyncExternalStore(
    subscribe,
    () => refreshing,
    () => refreshing,
  );
  useEffect(() => {
    if (started) return;
    void start();
  }, []);
  const refresh = useCallback(() => load("POST"), []);
  const retry = useCallback(() => start(), []);
  return { state: current, refresh, retry, refreshing: isRefreshing };
}
