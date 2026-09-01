/**
 * Pure types and algorithms for the unified smart inbox: a client-side k-way
 * merge over up to three per-account inbox streams. No React in here — the
 * surface owns state and effects, this module owns the total order, the
 * safe-horizon cut, page-one reconciliation, and section derivation, so every
 * rule is unit-testable without a DOM.
 */

import type {
  MailThreadListItem,
  MailThreadPage,
} from "@/lib/mail/message-types";

/**
 * Sentinel stored in `selectedAccountId` while the unified inbox is open.
 * Deliberately outside the `account-a<32 hex>` shape real accounts use, so
 * every account lookup misses and account-scoped paths early-return.
 */
export const UNIFIED_ACCOUNT_ID = "all-inboxes";

/** Page size for every unified page-1 load, load-more, and refresh. */
export const UNIFIED_PAGE_SIZE = 50;

/** Collapsed sections show this many rows before the header discloses. */
export const UNIFIED_SECTION_PREVIEW = 3;

/**
 * What the section is showing of itself.
 *
 * - `rows` — every thread in the section (expanded, or a section small enough
 *   that nothing is hidden).
 * - `preview` — the first `UNIFIED_SECTION_PREVIEW` rows, the collapsed state
 *   of a section that keeps only a little back.
 * - `bundle` — one digest row for the whole pile. Three rows can stand for
 *   four threads; they cannot stand for sixty-four, and pretending otherwise
 *   is what made the column feel sparse and long at the same time.
 */
export type UnifiedSectionForm = "rows" | "preview" | "bundle";

/**
 * The rule, stated once: a collapsed section previews while it hides no more
 * than it shows, and bundles as soon as it hides more. `hidesEverything` is
 * Seen, which collapses to nothing of itself and therefore always bundles.
 */
export function unifiedSectionForm(
  total: number,
  expanded: boolean,
  hidesEverything = false,
): UnifiedSectionForm {
  if (expanded || total === 0) return "rows";
  if (hidesEverything) return "bundle";
  if (total <= UNIFIED_SECTION_PREVIEW) return "rows";
  return total - UNIFIED_SECTION_PREVIEW > UNIFIED_SECTION_PREVIEW
    ? "bundle"
    : "preview";
}

export type UnifiedStreamStatus = "loading" | "ready" | "error" | "reauth";

export type UnifiedStream = {
  readonly accountId: string;
  /** For section sub-headers and per-stream failure notices. */
  readonly emailAddress: string;
  /** Loaded prefix in server order: date DESC, threadId DESC. */
  readonly items: readonly MailThreadListItem[];
  /** null = exhausted (or not loadable: error/reauth streams carry null). */
  readonly nextCursor: string | null;
  readonly status: UnifiedStreamStatus;
  readonly sync: MailThreadPage["sync"] | null;
};

export type UnifiedState =
  | { readonly kind: "idle" | "loading" }
  | { readonly kind: "ready"; readonly streams: readonly UnifiedStream[] };

/** The confirmed unique key — thread ids are provider-scoped per account. */
export function unifiedThreadKey(item: {
  readonly accountId: string;
  readonly threadId: string;
}): string {
  return `${item.accountId}\u0000${item.threadId}`;
}

/**
 * Total order for the merged list: (lastMessageAt ?? -1) DESC, then accountId
 * ASC, then threadId DESC. Matches the per-stream server order
 * (COALESCE(last_message_at, -1) DESC, thread_id DESC), so a merge of sorted
 * prefixes is sorted, and cross-account timestamp ties break the same way on
 * every refill.
 */
export function compareUnified(
  a: MailThreadListItem,
  b: MailThreadListItem,
): number {
  const aTime = a.lastMessageAt ?? -1;
  const bTime = b.lastMessageAt ?? -1;
  if (aTime !== bTime) return bTime - aTime;
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  if (a.threadId !== b.threadId) return a.threadId > b.threadId ? -1 : 1;
  return 0;
}

export type MergedDisplayItems = {
  /** The safe-horizon cut of the merged, deduplicated streams. */
  readonly items: readonly MailThreadListItem[];
  /** Streams whose next page would extend the horizon — fetch these. */
  readonly starvedAccountIds: readonly string[];
  /** True when no stream has a cursor left. */
  readonly exhausted: boolean;
};

/**
 * Declarative k-way merge with a safe horizon. A stream imposes a horizon iff
 * it is `ready` with a cursor; its horizon key is its last loaded item (a
 * ready non-exhausted stream with zero items imposes a horizon of
 * "everything" and must be fetched before any emit). The global cut is the
 * newest horizon among imposing streams; merged items strictly older than the
 * cut are withheld — inclusive at the cut, which is safe because the
 * comparator is total and per-stream pages are contiguous. `error`, `reauth`,
 * and exhausted streams impose no horizon.
 */
export function mergedDisplayItems(
  streams: readonly UnifiedStream[],
): MergedDisplayItems {
  const seen = new Set<string>();
  const merged: MailThreadListItem[] = [];
  for (const stream of streams) {
    for (const item of stream.items) {
      const key = unifiedThreadKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  merged.sort(compareUnified);

  const imposing = streams.filter(
    (stream) => stream.status === "ready" && stream.nextCursor !== null,
  );
  const exhausted = streams.every((stream) => stream.nextCursor === null);

  const empty = imposing.filter((stream) => stream.items.length === 0);
  if (empty.length > 0) {
    // Defensive: the server should not produce a ready page with a cursor and
    // no items, but if it does the cut is "everything" — emit nothing until
    // those streams are fetched.
    return {
      items: [],
      starvedAccountIds: empty.map((stream) => stream.accountId),
      exhausted,
    };
  }
  if (imposing.length === 0) {
    return { items: merged, starvedAccountIds: [], exhausted };
  }

  let cut = imposing[0]!.items.at(-1)!;
  for (const stream of imposing.slice(1)) {
    const horizon = stream.items.at(-1)!;
    if (compareUnified(horizon, cut) < 0) cut = horizon;
  }
  return {
    items: merged.filter((item) => compareUnified(item, cut) <= 0),
    starvedAccountIds: imposing
      .filter((stream) => compareUnified(stream.items.at(-1)!, cut) === 0)
      .map((stream) => stream.accountId),
    exhausted,
  };
}

/**
 * Fold a fresh page 1 into a loaded stream on the silent refresh tick. New
 * mail sorts to the top by definition, so page 1 captures arrivals without
 * discarding loaded depth. A shallow stream (nothing beyond page 1) is
 * replaced wholesale; a deep stream keeps its older tail and its cursor, with
 * the same duplicate/gap tolerance the load-more dedupe already accepts.
 */
export function reconcileStreamPageOne(
  stream: UnifiedStream,
  page: Pick<MailThreadPage, "items" | "nextCursor" | "sync">,
): UnifiedStream {
  if (stream.items.length <= UNIFIED_PAGE_SIZE || page.items.length === 0) {
    return {
      ...stream,
      items: page.items,
      nextCursor: page.nextCursor,
      status: "ready",
      sync: page.sync,
    };
  }
  const pageKeys = new Set(page.items.map(unifiedThreadKey));
  const lastPageItem = page.items.at(-1)!;
  const tail = stream.items.filter(
    (item) =>
      compareUnified(item, lastPageItem) > 0 &&
      !pageKeys.has(unifiedThreadKey(item)),
  );
  return {
    ...stream,
    items: [...page.items, ...tail],
    nextCursor: stream.nextCursor,
    status: "ready",
    sync: page.sync,
  };
}

/**
 * Take threads out of the streams that hold them, in one pass.
 *
 * Done empties a section at the gesture, before the first request goes out, so
 * the removal is ONE commit for the same reason the undo is: pressing Done is
 * one act, and a group that drains row by row over half a minute is not what
 * the reader did. `restoreStreamItems` is the exact inverse, and it is what
 * puts back whatever the loop then fails to move.
 */
export function removeStreamItems(
  streams: readonly UnifiedStream[],
  items: readonly MailThreadListItem[],
): readonly UnifiedStream[] {
  if (items.length === 0) return streams;
  const dropped = new Set(items.map(unifiedThreadKey));
  let changed = false;
  const next = streams.map((stream) => {
    const kept = stream.items.filter(
      (item) => !dropped.has(unifiedThreadKey(item)),
    );
    if (kept.length === stream.items.length) return stream;
    changed = true;
    return { ...stream, items: kept };
  });
  return changed ? next : streams;
}

/**
 * Put archived threads back into the streams they were removed from.
 *
 * Undoing a Done has to restore the list, not only the mailbox. The rows left
 * one at a time, so they go back into their own account's stream, in
 * `compareUnified` order — sorted insertion rather than an append, because the
 * merge reads a stream as a sorted prefix and takes its horizon from the last
 * item, and an out-of-order tail would move the safe cut and withhold rows
 * that were on screen a second ago. A thread the stream already holds is left
 * alone: a refresh tick can land it back before the undo does, and a duplicate
 * key would render two of the same row.
 */
export function restoreStreamItems(
  streams: readonly UnifiedStream[],
  items: readonly MailThreadListItem[],
): readonly UnifiedStream[] {
  if (items.length === 0) return streams;
  const byAccount = new Map<string, MailThreadListItem[]>();
  for (const item of items) {
    const bucket = byAccount.get(item.accountId);
    if (bucket) bucket.push(item);
    else byAccount.set(item.accountId, [item]);
  }
  return streams.map((stream) => {
    const restored = byAccount.get(stream.accountId);
    if (restored === undefined) return stream;
    const held = new Set(stream.items.map(unifiedThreadKey));
    const merged = [...stream.items];
    for (const item of restored) {
      const key = unifiedThreadKey(item);
      if (held.has(key)) continue;
      held.add(key);
      merged.push(item);
    }
    if (merged.length === stream.items.length) return stream;
    merged.sort(compareUnified);
    return { ...stream, items: merged };
  });
}

export type MailUnifiedPeopleGroup = {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly items: readonly MailThreadListItem[];
};

export type MailUnifiedSections = {
  readonly people: {
    readonly groups: readonly MailUnifiedPeopleGroup[];
    readonly total: number;
  };
  readonly notifications: { readonly items: readonly MailThreadListItem[] };
  readonly newsletters: { readonly items: readonly MailThreadListItem[] };
  readonly seen: { readonly items: readonly MailThreadListItem[] };
};

/**
 * Presentation state of the open thread, captured at the moment it was
 * selected — before auto-read flips its live `unread`. While a capture is
 * active, partition uses the captured values for that one thread, so the
 * letter stays in its section and position while the reader shows it. The row
 * itself still renders the live item (the unread dot clears); only the
 * PARTITION is pinned. Server truth is untouched.
 */
export type UnifiedStickyOpen = {
  readonly accountId: string;
  readonly threadId: string;
  readonly unread: boolean;
  readonly category: MailThreadListItem["category"];
};

/**
 * Single order-preserving pass over the merged cut: read threads of any
 * category land in Seen; unread threads split by category. People buckets per
 * account, groups ordered by the accounts array (accounts the list no longer
 * knows keep first-seen order at the end, with the item's own address). The
 * optional `stickyOpen` capture pins the open thread's partition — see
 * `UnifiedStickyOpen`.
 */
export function deriveUnifiedSections(
  items: readonly MailThreadListItem[],
  accounts: readonly {
    readonly accountId: string;
    readonly emailAddress: string;
  }[],
  stickyOpen: UnifiedStickyOpen | null = null,
): MailUnifiedSections {
  const peopleByAccount = new Map<string, MailThreadListItem[]>();
  const notifications: MailThreadListItem[] = [];
  const newsletters: MailThreadListItem[] = [];
  const seen: MailThreadListItem[] = [];
  for (const item of items) {
    const sticky =
      stickyOpen !== null &&
      item.accountId === stickyOpen.accountId &&
      item.threadId === stickyOpen.threadId;
    const unread = sticky ? stickyOpen.unread : item.unread;
    const category = sticky ? stickyOpen.category : item.category;
    if (!unread) {
      seen.push(item);
      continue;
    }
    if (category === "notification") {
      notifications.push(item);
      continue;
    }
    if (category === "newsletter") {
      newsletters.push(item);
      continue;
    }
    const bucket = peopleByAccount.get(item.accountId);
    if (bucket) bucket.push(item);
    else peopleByAccount.set(item.accountId, [item]);
  }
  const groups: MailUnifiedPeopleGroup[] = [];
  for (const account of accounts) {
    const bucket = peopleByAccount.get(account.accountId);
    if (!bucket) continue;
    peopleByAccount.delete(account.accountId);
    groups.push({
      accountId: account.accountId,
      emailAddress: account.emailAddress,
      items: bucket,
    });
  }
  for (const [accountId, bucket] of peopleByAccount) {
    groups.push({ accountId, emailAddress: "", items: bucket });
  }
  return {
    people: {
      groups,
      total: groups.reduce((sum, group) => sum + group.items.length, 0),
    },
    notifications: { items: notifications },
    newsletters: { items: newsletters },
    seen: { items: seen },
  };
}

export type UnifiedExpandKey = "people" | "notifications" | "newsletters" | "seen";

export type UnifiedExpandState = Readonly<Record<UnifiedExpandKey, boolean>>;

export const UNIFIED_EXPAND_COLLAPSED: UnifiedExpandState = {
  people: false,
  notifications: false,
  newsletters: false,
  seen: false,
};

/**
 * People groups with the section's form applied — every row when it shows
 * rows, the first `UNIFIED_SECTION_PREVIEW` across groups in group order when
 * it previews, and nothing at all when it is bundled. The list renders
 * exactly this, so keyboard order and visual order cannot drift.
 */
export function visiblePeopleGroups(
  people: MailUnifiedSections["people"],
  expanded: boolean,
): readonly MailUnifiedPeopleGroup[] {
  const form = unifiedSectionForm(people.total, expanded);
  if (form === "rows") return people.groups;
  if (form === "bundle") return [];
  let remaining = UNIFIED_SECTION_PREVIEW;
  const visible: MailUnifiedPeopleGroup[] = [];
  for (const group of people.groups) {
    if (remaining <= 0) break;
    const items = group.items.slice(0, remaining);
    remaining -= items.length;
    visible.push({ ...group, items });
  }
  return visible;
}

/** The rows one plain section contributes, given its form. */
export function visibleSectionItems(
  items: readonly MailThreadListItem[],
  expanded: boolean,
  hidesEverything = false,
): readonly MailThreadListItem[] {
  const form = unifiedSectionForm(items.length, expanded, hidesEverything);
  if (form === "rows") return items;
  if (form === "bundle") return [];
  return items.slice(0, UNIFIED_SECTION_PREVIEW);
}

/**
 * The flattened rendered order — sections in order, only visible rows:
 * previewed remainders and every bundled section are excluded. The keyboard
 * layer navigates exactly this list, so `j`/`k` can never land on a thread
 * its section is keeping back.
 */
export function visibleUnifiedItems(
  sections: MailUnifiedSections,
  expand: UnifiedExpandState,
): readonly MailThreadListItem[] {
  const items: MailThreadListItem[] = [];
  for (const group of visiblePeopleGroups(sections.people, expand.people)) {
    items.push(...group.items);
  }
  items.push(
    ...visibleSectionItems(sections.notifications.items, expand.notifications),
  );
  items.push(
    ...visibleSectionItems(sections.newsletters.items, expand.newsletters),
  );
  items.push(...visibleSectionItems(sections.seen.items, expand.seen, true));
  return items;
}

export type UnifiedBundleSummary = {
  /** Up to two distinct senders, freshest first — the names AND the stack. */
  readonly senders: readonly MailThreadListItem[];
  /** Threads the named senders do not account for. */
  readonly more: number;
  readonly total: number;
  readonly unread: number;
  readonly newest: MailThreadListItem | null;
};

/**
 * What a bundled section says in its one row: who is in the pile, how big it
 * is, and the newest thing in it. The senders are distinct by display label,
 * because a pile of sixty-four newsletters is usually a handful of mailers
 * repeating, and two identical avatars would say nothing.
 *
 * Two, not three: two names is what the line can carry at 360, and a third
 * avatar over the stack would be one of the faces the count has already
 * promised to hide. `more` counts from the names the row actually says, not
 * from two — a pile of seven from a single sender names one, and "and 5 more"
 * under a header reading "Newsletters 7" was the row contradicting itself.
 */
export function unifiedBundleSummary(
  items: readonly MailThreadListItem[],
): UnifiedBundleSummary {
  const senders: MailThreadListItem[] = [];
  const seenLabels = new Set<string>();
  for (const item of items) {
    const first = item.participants[0];
    const label = (first?.name?.trim() || first?.address || "").toLowerCase();
    if (label !== "" && seenLabels.has(label)) continue;
    seenLabels.add(label);
    senders.push(item);
    if (senders.length === 2) break;
  }
  return {
    senders,
    more: Math.max(0, items.length - senders.length),
    total: items.length,
    unread: items.filter((item) => item.unread).length,
    newest: items[0] ?? null,
  };
}
