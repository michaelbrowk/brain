export interface StoredTitleDraft {
  title: string;
  baseTitle: string;
  updatedAt: number;
}

export interface RecoveredTitleDraft extends StoredTitleDraft {
  key: string;
}

export const titleDraftStoragePrefix = (pageId: string) =>
  `brain-title-draft-v1:${encodeURIComponent(pageId)}:`;

export const titleDraftStorageKey = (pageId: string, clientId: string) =>
  `${titleDraftStoragePrefix(pageId)}${clientId}`;

export function normalizeTitle(title: string): string {
  return title.trim() || "Untitled";
}

function decodeTitleDraft(raw: string): StoredTitleDraft | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredTitleDraft>;
    if (
      typeof value.title !== "string" ||
      typeof value.baseTitle !== "string" ||
      typeof value.updatedAt !== "number" ||
      !Number.isFinite(value.updatedAt)
    ) {
      return null;
    }
    return {
      title: value.title,
      baseTitle: value.baseTitle,
      updatedAt: value.updatedAt,
    };
  } catch {
    return null;
  }
}

export function persistTitleDraft(
  storage: Storage,
  pageId: string,
  clientId: string,
  title: string,
  baseTitle: string,
  updatedAt = Date.now(),
): boolean {
  try {
    storage.setItem(
      titleDraftStorageKey(pageId, clientId),
      JSON.stringify({ title, baseTitle, updatedAt } satisfies StoredTitleDraft),
    );
    return true;
  } catch {
    return false;
  }
}

export function recoverTitleDraft(
  storage: Storage,
  pageId: string,
  serverTitle: string,
): RecoveredTitleDraft | null {
  const candidates: RecoveredTitleDraft[] = [];
  const prefix = titleDraftStoragePrefix(pageId);
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const draft = decodeTitleDraft(raw);
      if (draft?.baseTitle === serverTitle) {
        candidates.push({ key, ...draft });
      }
    }
  } catch {
    return null;
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0] ?? null;
}

export function clearCommittedTitleDrafts(
  storage: Storage,
  pageId: string,
  committedTitle: string,
): void {
  const keys: string[] = [];
  const prefix = titleDraftStoragePrefix(pageId);
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const draft = decodeTitleDraft(raw);
      if (draft && normalizeTitle(draft.title) === committedTitle) {
        keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // A confirmed server rename is still successful when localStorage is
    // unavailable. A stale recovery record is harmless and base-title guarded.
  }
}
