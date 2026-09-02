"use client";

// Settings → Data, first group: where the notes live. The one fact Brain is
// built around — files on disk, in git — was invisible inside the product.
// Display only. Fetch-on-mount with refresh-in-place, like BackupStatusPanel.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatAgo } from "@/lib/format-ago";
import { Button, IconButton } from "../ui/button";
import { Icon } from "../ui/icon";
import { SettingsGroup, SettingsRow } from "./shared";

interface NotesStatus {
  apiVersion: 1;
  root: string;
  repository: boolean;
  head: { hash: string; at: string } | null;
  commitDelaySeconds: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; status: NotesStatus };

function isNotesStatus(value: unknown): value is NotesStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    v.apiVersion !== 1 ||
    typeof v.root !== "string" ||
    typeof v.repository !== "boolean"
  ) {
    return false;
  }
  if (typeof v.commitDelaySeconds !== "number") return false;
  if (v.head === null) return true;
  if (typeof v.head !== "object" || v.head === null) return false;
  const h = v.head as Record<string, unknown>;
  return typeof h.hash === "string" && typeof h.at === "string";
}

async function fetchNotesStatus(): Promise<NotesStatus> {
  const response = await fetch("/api/settings/notes", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("notes status unavailable");
  const status = (await response.json()) as unknown;
  if (!isNotesStatus(status)) throw new Error("invalid notes status");
  return status;
}

const WORDS: Record<number, string> = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
};

export function NotesStatusPanel({
  onToast,
}: {
  onToast?: (title: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const inFlightRef = useRef(false);

  // Refresh revalidates in place: the facts stay while the icon spins, and
  // only the answer (or its failure) replaces them.
  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      setState({ kind: "ready", status: await fetchNotesStatus() });
    } catch {
      setState({ kind: "error" });
    } finally {
      inFlightRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetchNotesStatus()
      .then((status) => {
        if (active) setState({ kind: "ready", status });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, []);

  const copyRoot = async (root: string) => {
    try {
      await navigator.clipboard.writeText(root);
      onToast?.("Copied the folder path");
    } catch {
      onToast?.("Could not copy");
    }
  };

  const delay = state.kind === "ready" ? state.status.commitDelaySeconds : 4;
  const delayWord = WORDS[delay] ?? String(delay);

  return (
    <SettingsGroup
      title="Where your notes live"
      description={`Every page is a folder with an index.md inside. A save becomes a git commit about ${delayWord} seconds after you stop typing.`}
      action={
        <IconButton
          size={28}
          aria-label="Refresh notes status"
          title="Refresh"
          disabled={state.kind === "loading" || refreshing}
          onClick={() => void load()}
        >
          <Icon
            name="restart-linear"
            size={16}
            className={refreshing ? "motion-safe:animate-spin" : undefined}
          />
        </IconButton>
      }
    >
      {state.kind === "loading" && (
        <SettingsRow label="Folder">
          <span className="text-table text-ink-2">Loading…</span>
        </SettingsRow>
      )}
      {state.kind === "error" && (
        <SettingsRow label="Folder">
          <span role="alert" className="text-table text-ink-2">
            Could not read the notes folder.
          </span>
          <Button type="button" variant="quiet" onClick={() => void load()}>
            Try again
          </Button>
        </SettingsRow>
      )}
      {state.kind === "ready" && (
        <>
          <SettingsRow
            label="Folder"
            hint="The path the server sees. In Docker it is the container side of your NOTES_ROOT mount."
          >
            <span className="truncate font-mono text-caption text-ink-2">
              {state.status.root}
            </span>
            <IconButton
              size={28}
              aria-label="Copy folder path"
              onClick={() => void copyRoot(state.status.root)}
            >
              <Icon name="copy-linear" size={16} />
            </IconButton>
          </SettingsRow>
          <SettingsRow label="History">
            <span className="text-table text-ink-2">
              {!state.status.repository
                ? "Not a repository yet. Brain runs git init on the first save."
                : state.status.head
                  ? `Git repository · last commit ${formatAgo(state.status.head.at)}`
                  : "Git repository · no commit yet"}
            </span>
          </SettingsRow>
        </>
      )}
    </SettingsGroup>
  );
}
