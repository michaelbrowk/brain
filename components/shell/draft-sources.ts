// localStorage keys for autosave drafts and the draft-source bookkeeping
// a save operation carries. Extracted verbatim from shell.tsx (S1 of the
// shell extraction).

import { CLIENT_ID } from "@/lib/client";
import { decodeDraft, type DraftSource } from "@/lib/autosave";

export const draftStoragePrefix = (id: string) =>
  `brain-draft-v2:${encodeURIComponent(id)}:`;
export const draftStorageKey = (id: string) => `${draftStoragePrefix(id)}${CLIENT_ID}`;
export const legacyDraftStorageKey = (id: string) => `brain-draft-${id}`;

export function isDraftStorageKeyForPage(id: string, key: string): boolean {
  return key === legacyDraftStorageKey(id) || key.startsWith(draftStoragePrefix(id));
}

export function mergeDraftSources(
  sources: DraftSource[],
  source: DraftSource,
): DraftSource[] {
  return [
    ...sources.filter((candidate) => candidate.key !== source.key),
    source,
  ];
}

export function draftSourcesForOperation(id: string, operationId: string): DraftSource[] {
  try {
    const raw = localStorage.getItem(draftStorageKey(id));
    if (raw === null) return [];
    const draft = decodeDraft(raw);
    return draft.operationId === operationId ? draft.sources : [];
  } catch {
    return [];
  }
}
