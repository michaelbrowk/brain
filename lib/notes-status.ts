// Owner-only facts about where the notes live. Display data for
// Settings → Data; nothing here mutates the store.

import fs from "node:fs";
import path from "node:path";
import { getStore } from "@/lib/store";
import { COMMIT_DELAY_MS, headCommit, type HeadCommit } from "@/lib/store/git";

export interface NotesStatus {
  apiVersion: 1;
  /** Absolute notes root the server is using (the host path in Docker is the
   *  bind mount's other side — the UI says so). */
  root: string;
  repository: boolean;
  head: HeadCommit | null;
  commitDelaySeconds: number;
}

export async function readNotesStatus(): Promise<NotesStatus> {
  const store = await getStore();
  return {
    apiVersion: 1,
    root: store.root,
    repository: fs.existsSync(path.join(store.root, ".git")),
    head: await headCommit(store.root),
    commitDelaySeconds: Math.round(COMMIT_DELAY_MS / 1000),
  };
}
