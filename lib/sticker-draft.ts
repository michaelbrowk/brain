import type { Sticker } from "./store/types";

const STICKER_DRAFT_PREFIX = "brain-sticker-draft:";
const acknowledgedStickerBaselines = new Map<string, Sticker[]>();

export interface StickerDraft {
  version: 1;
  pageId: string;
  stickers: Sticker[];
  /** Server-authoritative value observed before this local edit sequence. */
  expected?: Sticker[];
  operationId: string;
  updatedAt: number;
}

export const stickerDraftKey = (pageId: string) =>
  `${STICKER_DRAFT_PREFIX}${pageId}`;

const isSticker = (value: unknown): value is Sticker => {
  if (!value || typeof value !== "object") return false;
  const sticker = value as Partial<Sticker>;
  return (
    typeof sticker.id === "string" &&
    typeof sticker.text === "string" &&
    typeof sticker.x === "number" &&
    Number.isFinite(sticker.x) &&
    typeof sticker.y === "number" &&
    Number.isFinite(sticker.y)
  );
};

export function decodeStickerDraft(raw: string | null): StickerDraft | null {
  if (raw === null) return null;
  try {
    const draft = JSON.parse(raw) as Partial<StickerDraft>;
    if (
      draft.version !== 1 ||
      typeof draft.pageId !== "string" ||
      typeof draft.operationId !== "string" ||
      typeof draft.updatedAt !== "number" ||
      !Number.isFinite(draft.updatedAt) ||
      !Array.isArray(draft.stickers) ||
      !draft.stickers.every(isSticker) ||
      (draft.expected !== undefined &&
        (!Array.isArray(draft.expected) || !draft.expected.every(isSticker)))
    ) {
      return null;
    }
    return draft as StickerDraft;
  } catch {
    return null;
  }
}

export function loadStickerDraft(
  storage: Pick<Storage, "getItem">,
  pageId: string,
): StickerDraft | null {
  try {
    const draft = decodeStickerDraft(storage.getItem(stickerDraftKey(pageId)));
    return draft?.pageId === pageId ? draft : null;
  } catch {
    return null;
  }
}

export function persistStickerDraft(
  storage: Pick<Storage, "setItem">,
  draft: StickerDraft,
): boolean {
  try {
    storage.setItem(stickerDraftKey(draft.pageId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearStickerDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
  pageId: string,
  operationId: string,
): boolean {
  try {
    const key = stickerDraftKey(pageId);
    const current = decodeStickerDraft(storage.getItem(key));
    if (!current || current.operationId !== operationId) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Confirm one acknowledged sticker write without losing a newer local edit.
 * If another draft replaced the in-flight operation, advance that draft's CAS
 * baseline to the exact stickers now known to be on the server. */
export function confirmStickerDraft(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  acknowledged: StickerDraft,
): boolean {
  try {
    const key = stickerDraftKey(acknowledged.pageId);
    const current = decodeStickerDraft(storage.getItem(key));
    if (!current) return false;
    if (current.operationId === acknowledged.operationId) {
      storage.removeItem(key);
      return true;
    }
    storage.setItem(
      key,
      JSON.stringify({
        ...current,
        expected: acknowledged.stickers,
      } satisfies StickerDraft),
    );
    return true;
  } catch {
    return false;
  }
}

const sameStickers = (a: Sticker[], b: Sticker[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Drop a draft whose stickers already match the server. Nothing is lost and
 * nothing is left behind for recover() to re-flush on every page open. */
function settleNoOpDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
  draft: StickerDraft,
): "idle" {
  clearStickerDraft(storage, draft.pageId, draft.operationId);
  acknowledgedStickerBaselines.delete(draft.pageId);
  return "idle";
}

async function fetchServerStickers(
  fetcher: (input: RequestInfo | URL) => Promise<Response>,
  pageId: string,
): Promise<Sticker[] | null> {
  const response = await fetcher(`/api/page/${pageId}`);
  if (!response.ok) return null;
  const current = (await response.json()) as { meta?: { stickers?: unknown } };
  const stickers = current.meta?.stickers ?? [];
  return Array.isArray(stickers) && stickers.every(isSticker) ? stickers : null;
}

export async function saveStickerDraft(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  pageId: string,
  fetcher: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
  recoveryDepth = 0,
): Promise<"idle" | "saved" | "retry" | "conflict"> {
  const draft = loadStickerDraft(storage, pageId);
  if (!draft) {
    acknowledgedStickerBaselines.delete(pageId);
    return "idle";
  }
  try {
    const acknowledged = acknowledgedStickerBaselines.get(pageId);
    const expected = acknowledged ?? draft.expected;
    if (acknowledged) {
      const serverStickers = await fetchServerStickers(fetcher, pageId);
      if (serverStickers && sameStickers(serverStickers, draft.stickers)) {
        return settleNoOpDraft(storage, draft);
      }
      if (!serverStickers || !sameStickers(serverStickers, acknowledged)) {
        acknowledgedStickerBaselines.delete(pageId);
        return "conflict";
      }
    } else if (expected && sameStickers(expected, draft.stickers)) {
      // The edit sequence ended where it started: the server already holds
      // exactly these stickers.
      return settleNoOpDraft(storage, draft);
    }
    const response = await fetcher(`/api/page/${pageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stickers: draft.stickers,
        ...(expected ? { expected: { stickers: expected } } : {}),
      }),
    });
    if (response.status === 409) {
      // A lost ACK leaves the server already holding this draft. Treat that
      // as settled instead of a conflict that re-fires on every open.
      const serverStickers = await fetchServerStickers(fetcher, pageId);
      if (serverStickers && sameStickers(serverStickers, draft.stickers)) {
        return settleNoOpDraft(storage, draft);
      }
      acknowledgedStickerBaselines.delete(pageId);
      return "conflict";
    }
    if (!response.ok) return "retry";
    if (!confirmStickerDraft(storage, draft)) {
      acknowledgedStickerBaselines.set(pageId, draft.stickers);
      if (recoveryDepth >= 8) return "retry";
      return saveStickerDraft(storage, pageId, fetcher, recoveryDepth + 1);
    }
    acknowledgedStickerBaselines.delete(pageId);
    return "saved";
  } catch {
    return "retry";
  }
}
