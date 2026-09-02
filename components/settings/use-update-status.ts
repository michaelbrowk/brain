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

async function load(method: "GET" | "POST") {
  if (method === "POST") {
    refreshing = true;
    emit();
  }
  try {
    state = { kind: "ready", status: await request(method) };
  } catch {
    // a failed refresh keeps the last good status on screen
    if (state.kind !== "ready") state = { kind: "error" };
  } finally {
    refreshing = false;
    emit();
  }
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
  refresh: () => Promise<void>;
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
    started = true;
    void load("GET");
  }, []);
  const refresh = useCallback(() => load("POST"), []);
  return { state: current, refresh, refreshing: isRefreshing };
}
