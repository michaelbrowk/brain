import { describe, expect, it } from "vitest";
import {
  appendStreamPage,
  compareUnified,
  deriveUnifiedSections,
  mergedDisplayItems,
  reconcileStreamPageOne,
  removeStreamItems,
  restoreStreamItems,
  UNIFIED_ACCOUNT_ID,
  UNIFIED_EXPAND_COLLAPSED,
  unifiedBundleSummary,
  unifiedSectionForm,
  visibleSectionItems,
  visibleUnifiedItems,
  type UnifiedStream,
} from "./mail-unified";
import type { MailThreadListItem } from "@/lib/mail/message-types";

const ACCOUNT_A = "account-a0123456789abcdef0123456789abcdef";
const ACCOUNT_B = "account-affffffffffffffffffffffffffffffff";

function item(
  overrides: Partial<MailThreadListItem> & {
    readonly accountId: string;
    readonly threadId: string;
  },
): MailThreadListItem {
  return {
    subject: "Subject",
    participants: [{ name: "Sender", address: "sender@example.test" }],
    snippet: "Preview",
    lastMessageAt: 1_700_000_000_000,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
    newSender: false,
    ...overrides,
  };
}

function stream(
  accountId: string,
  overrides: Partial<UnifiedStream> = {},
): UnifiedStream {
  return {
    accountId,
    emailAddress: `${accountId.slice(8, 12)}@example.test`,
    items: [],
    nextCursor: null,
    status: "ready",
    sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    ...overrides,
  };
}

describe("UNIFIED_ACCOUNT_ID", () => {
  it("never collides with a real account id", () => {
    expect(UNIFIED_ACCOUNT_ID).not.toMatch(/^account-a[0-9a-f]{32}$/);
  });
});

describe("compareUnified", () => {
  it("orders newest first, then accountId ASC, then threadId DESC", () => {
    const newer = item({ accountId: ACCOUNT_A, threadId: "t1", lastMessageAt: 2_000 });
    const older = item({ accountId: ACCOUNT_A, threadId: "t2", lastMessageAt: 1_000 });
    expect(compareUnified(newer, older)).toBeLessThan(0);
    expect(compareUnified(older, newer)).toBeGreaterThan(0);

    const tieA = item({ accountId: ACCOUNT_A, threadId: "t1", lastMessageAt: 1_000 });
    const tieB = item({ accountId: ACCOUNT_B, threadId: "t1", lastMessageAt: 1_000 });
    expect(compareUnified(tieA, tieB)).toBeLessThan(0);
    expect(compareUnified(tieB, tieA)).toBeGreaterThan(0);

    const idHigh = item({ accountId: ACCOUNT_A, threadId: "t9", lastMessageAt: 1_000 });
    const idLow = item({ accountId: ACCOUNT_A, threadId: "t1", lastMessageAt: 1_000 });
    expect(compareUnified(idHigh, idLow)).toBeLessThan(0);
    expect(compareUnified(idLow, idLow)).toBe(0);
  });

  it("sorts null timestamps as -1, matching the server COALESCE", () => {
    const dated = item({ accountId: ACCOUNT_A, threadId: "t1", lastMessageAt: 0 });
    const nullish = item({ accountId: ACCOUNT_A, threadId: "t2", lastMessageAt: null });
    expect(compareUnified(dated, nullish)).toBeLessThan(0);
    const otherNull = item({ accountId: ACCOUNT_B, threadId: "t3", lastMessageAt: null });
    expect(compareUnified(nullish, otherNull)).toBeLessThan(0);
  });
});

describe("mergedDisplayItems", () => {
  it("merges streams of unequal depth up to the safe horizon", () => {
    const a = stream(ACCOUNT_A, {
      items: [
        item({ accountId: ACCOUNT_A, threadId: "a1", lastMessageAt: 900 }),
        item({ accountId: ACCOUNT_A, threadId: "a2", lastMessageAt: 500 }),
      ],
      nextCursor: "cursor-a",
    });
    const b = stream(ACCOUNT_B, {
      items: [
        item({ accountId: ACCOUNT_B, threadId: "b1", lastMessageAt: 800 }),
        item({ accountId: ACCOUNT_B, threadId: "b2", lastMessageAt: 700 }),
        item({ accountId: ACCOUNT_B, threadId: "b3", lastMessageAt: 100 }),
      ],
      nextCursor: "cursor-b",
    });
    const merged = mergedDisplayItems([a, b]);
    // Stream A's horizon (500) is the newest cut; b3 (100) is withheld.
    expect(merged.items.map((entry) => entry.threadId)).toEqual([
      "a1",
      "b1",
      "b2",
      "a2",
    ]);
    expect(merged.starvedAccountIds).toEqual([ACCOUNT_A]);
    expect(merged.exhausted).toBe(false);
  });

  it("breaks cross-account timestamp ties by the total order at the cut", () => {
    const a = stream(ACCOUNT_A, {
      items: [item({ accountId: ACCOUNT_A, threadId: "a1", lastMessageAt: 500 })],
      nextCursor: "cursor-a",
    });
    const b = stream(ACCOUNT_B, {
      items: [
        item({ accountId: ACCOUNT_B, threadId: "b1", lastMessageAt: 500 }),
        item({ accountId: ACCOUNT_B, threadId: "b2", lastMessageAt: 400 }),
      ],
      nextCursor: "cursor-b",
    });
    const merged = mergedDisplayItems([a, b]);
    // The cut is A's horizon key (500, accountA, a1) — inclusive at exactly
    // that key. The equal-timestamp b1 sorts after it in the total order
    // (accountId ASC breaks the tie), so it waits until A's pages pass it —
    // A's next page may still hold keys between the cut and b1.
    expect(merged.items.map((entry) => entry.threadId)).toEqual(["a1"]);
    expect(merged.starvedAccountIds).toEqual([ACCOUNT_A]);
  });

  it("lets exhausted and failed streams merge fully without imposing a horizon", () => {
    const exhausted = stream(ACCOUNT_A, {
      items: [item({ accountId: ACCOUNT_A, threadId: "a1", lastMessageAt: 100 })],
      nextCursor: null,
    });
    const failed = stream(ACCOUNT_B, {
      items: [item({ accountId: ACCOUNT_B, threadId: "b1", lastMessageAt: 50 })],
      nextCursor: null,
      status: "error",
    });
    const merged = mergedDisplayItems([exhausted, failed]);
    expect(merged.items.map((entry) => entry.threadId)).toEqual(["a1", "b1"]);
    expect(merged.starvedAccountIds).toEqual([]);
    expect(merged.exhausted).toBe(true);
  });

  it("withholds everything for a ready cursor-bearing stream with zero items", () => {
    const starvedEmpty = stream(ACCOUNT_A, { items: [], nextCursor: "cursor-a" });
    const full = stream(ACCOUNT_B, {
      items: [item({ accountId: ACCOUNT_B, threadId: "b1" })],
      nextCursor: null,
    });
    const merged = mergedDisplayItems([starvedEmpty, full]);
    expect(merged.items).toEqual([]);
    expect(merged.starvedAccountIds).toEqual([ACCOUNT_A]);
    expect(merged.exhausted).toBe(false);
  });

  it("dedupes by the accountId+threadId pair, keeping same ids across accounts distinct", () => {
    const shared = item({ accountId: ACCOUNT_A, threadId: "t1", lastMessageAt: 900 });
    const a = stream(ACCOUNT_A, { items: [shared, shared], nextCursor: null });
    const b = stream(ACCOUNT_B, {
      items: [item({ accountId: ACCOUNT_B, threadId: "t1", lastMessageAt: 800 })],
      nextCursor: null,
    });
    const merged = mergedDisplayItems([a, b]);
    expect(merged.items).toHaveLength(2);
    expect(
      merged.items.map((entry) => `${entry.accountId}:${entry.threadId}`),
    ).toEqual([`${ACCOUNT_A}:t1`, `${ACCOUNT_B}:t1`]);
  });
});

describe("reconcileStreamPageOne", () => {
  const page = (
    items: readonly MailThreadListItem[],
    nextCursor: string | null = "page-cursor",
  ) => ({
    items,
    nextCursor,
    sync: { status: "idle" as const, lastSuccessfulAt: 1_700_000_000_500 },
  });

  it("replaces a shallow stream wholesale, cursor included", () => {
    const before = stream(ACCOUNT_A, {
      items: [item({ accountId: ACCOUNT_A, threadId: "old", lastMessageAt: 100 })],
      nextCursor: "stale-cursor",
    });
    const fresh = [
      item({ accountId: ACCOUNT_A, threadId: "new", lastMessageAt: 200 }),
    ];
    const next = reconcileStreamPageOne(before, page(fresh, null));
    expect(next.items).toEqual(fresh);
    expect(next.nextCursor).toBeNull();
    expect(next.status).toBe("ready");
    expect(next.sync?.lastSuccessfulAt).toBe(1_700_000_000_500);
  });

  it("keeps the deep tail and the old cursor on a deep stream", () => {
    const deepItems = Array.from({ length: 60 }, (_value, index) =>
      item({
        accountId: ACCOUNT_A,
        threadId: `t${String(index).padStart(2, "0")}`,
        lastMessageAt: 10_000 - index * 10,
      }),
    );
    const before = stream(ACCOUNT_A, {
      items: deepItems,
      nextCursor: "deep-cursor",
    });
    const freshTop = [
      item({ accountId: ACCOUNT_A, threadId: "brand-new", lastMessageAt: 20_000 }),
      ...deepItems.slice(0, 49),
    ];
    const next = reconcileStreamPageOne(before, page(freshTop));
    // Page-1 window first, then only the strictly-older non-duplicate tail.
    expect(next.items.slice(0, 50)).toEqual(freshTop);
    expect(next.items.slice(50)).toEqual(deepItems.slice(49));
    expect(next.nextCursor).toBe("deep-cursor");
  });

  it.each(["loading", "error"] as const)(
    "gives a deep %s stream page one's cursor to re-page from, keeping its rows",
    (status) => {
      // A sync hold or a failed Load more took the cursor (null because the
      // page was never answered, not because the stream ended). Keeping that
      // null stopped the account paging until a reload.
      const deepItems = Array.from({ length: 60 }, (_value, index) =>
        item({
          accountId: ACCOUNT_A,
          threadId: `t${String(index).padStart(2, "0")}`,
          lastMessageAt: 10_000 - index * 10,
        }),
      );
      const before = stream(ACCOUNT_A, {
        items: deepItems,
        nextCursor: null,
        status,
      });
      const next = reconcileStreamPageOne(
        before,
        page(deepItems.slice(0, 50), "fresh-page-two"),
      );
      expect(next.items).toEqual(deepItems);
      expect(next.status).toBe("ready");
      expect(next.nextCursor).toBe("fresh-page-two");
      expect(next.repage).toBe(true);
    },
  );

  it("leaves a deep stream that ended as ended", () => {
    const deepItems = Array.from({ length: 60 }, (_value, index) =>
      item({
        accountId: ACCOUNT_A,
        threadId: `t${String(index).padStart(2, "0")}`,
        lastMessageAt: 10_000 - index * 10,
      }),
    );
    const before = stream(ACCOUNT_A, { items: deepItems, nextCursor: null });
    const next = reconcileStreamPageOne(
      before,
      page(deepItems.slice(0, 50), "fresh-page-two"),
    );
    expect(next.nextCursor).toBeNull();
    expect(next.repage).toBeFalsy();
  });

  it("drops the re-page mark when page one replaces the stream", () => {
    const before = stream(ACCOUNT_A, {
      items: [item({ accountId: ACCOUNT_A, threadId: "old" })],
      nextCursor: "fresh-page-two",
      repage: true,
    });
    const next = reconcileStreamPageOne(before, page([], null));
    expect(next.repage).toBe(false);
  });

  it("heals an errored stream to ready", () => {
    const broken = stream(ACCOUNT_A, { status: "error", items: [], sync: null });
    const fresh = [item({ accountId: ACCOUNT_A, threadId: "t1" })];
    const next = reconcileStreamPageOne(broken, page(fresh, null));
    expect(next.status).toBe("ready");
    expect(next.items).toEqual(fresh);
  });

  it("counts a heal, shallow or deep, and not a refresh of a ready stream", () => {
    // The scroll sentinel re-arms on this count: a heal can hand back exactly
    // the rows the stream had, so the row count alone never moves.
    const rows = (length: number) =>
      Array.from({ length }, (_value, index) =>
        item({
          accountId: ACCOUNT_A,
          threadId: `t${String(index).padStart(2, "0")}`,
          lastMessageAt: 10_000 - index * 10,
        }),
      );
    const shallow = stream(ACCOUNT_A, { items: rows(50), status: "loading" });
    const healed = reconcileStreamPageOne(shallow, page(rows(50)));
    expect(healed.heals).toBe(1);
    expect(reconcileStreamPageOne(healed, page(rows(50))).heals).toBe(1);

    const deep = stream(ACCOUNT_A, { items: rows(60), status: "error", heals: 1 });
    expect(reconcileStreamPageOne(deep, page(rows(60).slice(0, 50))).heals).toBe(2);
  });

  it("treats an empty fresh page as authoritative even for a deep stream", () => {
    const deepItems = Array.from({ length: 60 }, (_value, index) =>
      item({
        accountId: ACCOUNT_A,
        threadId: `t${index}`,
        lastMessageAt: 10_000 - index,
      }),
    );
    const before = stream(ACCOUNT_A, { items: deepItems, nextCursor: "cursor" });
    const next = reconcileStreamPageOne(before, page([], null));
    expect(next.items).toEqual([]);
    expect(next.nextCursor).toBeNull();
  });
});

describe("deriveUnifiedSections", () => {
  const accounts = [
    { accountId: ACCOUNT_A, emailAddress: "a@example.test" },
    { accountId: ACCOUNT_B, emailAddress: "b@example.test" },
  ];

  it("partitions read threads into Seen and unread threads by category", () => {
    const items = [
      item({ accountId: ACCOUNT_A, threadId: "p1", category: "people" }),
      item({ accountId: ACCOUNT_B, threadId: "n1", category: "notification" }),
      item({ accountId: ACCOUNT_A, threadId: "l1", category: "newsletter" }),
      item({
        accountId: ACCOUNT_B,
        threadId: "s1",
        category: "newsletter",
        unread: false,
      }),
    ];
    const sections = deriveUnifiedSections(items, accounts);
    expect(sections.people.total).toBe(1);
    expect(sections.notifications.items.map((entry) => entry.threadId)).toEqual([
      "n1",
    ]);
    expect(sections.newsletters.items.map((entry) => entry.threadId)).toEqual([
      "l1",
    ]);
    expect(sections.seen.items.map((entry) => entry.threadId)).toEqual(["s1"]);
  });

  it("groups People per account in the accounts-array order, preserving item order", () => {
    const items = [
      item({ accountId: ACCOUNT_B, threadId: "b1", lastMessageAt: 900 }),
      item({ accountId: ACCOUNT_A, threadId: "a1", lastMessageAt: 800 }),
      item({ accountId: ACCOUNT_B, threadId: "b2", lastMessageAt: 700 }),
    ];
    const sections = deriveUnifiedSections(items, accounts);
    expect(
      sections.people.groups.map((group) => ({
        accountId: group.accountId,
        emailAddress: group.emailAddress,
        threads: group.items.map((entry) => entry.threadId),
      })),
    ).toEqual([
      {
        accountId: ACCOUNT_A,
        emailAddress: "a@example.test",
        threads: ["a1"],
      },
      {
        accountId: ACCOUNT_B,
        emailAddress: "b@example.test",
        threads: ["b1", "b2"],
      },
    ]);
    expect(sections.people.total).toBe(3);
  });

  it("puts a thread that waits on its sender in New senders, and only there", () => {
    const from = { name: "Lena Okafor", address: "lena@okafor.example" };
    const items = [
      item({ accountId: ACCOUNT_B, threadId: "friend" }),
      item({ accountId: ACCOUNT_A, threadId: "lena", newSender: true, newSenderFrom: from }),
      // Opened already: read first, then decide, so it waits where it was.
      item({
        accountId: ACCOUNT_B,
        threadId: "read-first",
        unread: false,
        newSender: true,
        newSenderFrom: from,
      }),
      item({ accountId: ACCOUNT_A, threadId: "old", unread: false }),
    ];
    const sections = deriveUnifiedSections(items, accounts);
    expect(sections.newSenders.items.map((entry) => entry.threadId)).toEqual([
      "lena",
      "read-first",
    ]);
    expect(sections.people.total).toBe(1);
    expect(sections.people.groups.flatMap((group) => group.items).map((entry) => entry.threadId)).toEqual([
      "friend",
    ]);
    expect(sections.seen.items.map((entry) => entry.threadId)).toEqual(["old"]);
  });
});

describe("deriveUnifiedSections sticky open", () => {
  const accounts = [
    { accountId: ACCOUNT_A, emailAddress: "a@example.test" },
    { accountId: ACCOUNT_B, emailAddress: "b@example.test" },
  ];

  it("keeps the open thread in its captured section and position while it is read", () => {
    // The letter was unread People when it was selected; auto-read has since
    // flipped its live unread. The captured state pins the partition, the
    // live item still flows through (the row's dot clears).
    const items = [
      item({ accountId: ACCOUNT_A, threadId: "p1", lastMessageAt: 900 }),
      item({
        accountId: ACCOUNT_A,
        threadId: "open",
        lastMessageAt: 800,
        unread: false,
      }),
      item({ accountId: ACCOUNT_A, threadId: "p2", lastMessageAt: 700 }),
    ];
    const sections = deriveUnifiedSections(items, accounts, {
      accountId: ACCOUNT_A,
      threadId: "open",
      unread: true,
      category: "people",
    });
    expect(
      sections.people.groups[0]?.items.map((entry) => entry.threadId),
    ).toEqual(["p1", "open", "p2"]);
    expect(sections.seen.items).toEqual([]);
    // The section holds the LIVE item — only the partition used the capture.
    expect(sections.people.groups[0]?.items[1]?.unread).toBe(false);
  });

  it("pins the partition with the captured category", () => {
    const items = [
      item({
        accountId: ACCOUNT_A,
        threadId: "open",
        category: "notification",
        unread: false,
      }),
    ];
    const sections = deriveUnifiedSections(items, accounts, {
      accountId: ACCOUNT_A,
      threadId: "open",
      unread: true,
      category: "notification",
    });
    expect(
      sections.notifications.items.map((entry) => entry.threadId),
    ).toEqual(["open"]);
    expect(sections.seen.items).toEqual([]);
  });

  it("settles the thread into Seen once the capture clears", () => {
    const items = [
      item({
        accountId: ACCOUNT_A,
        threadId: "open",
        unread: false,
      }),
    ];
    const sections = deriveUnifiedSections(items, accounts, null);
    expect(sections.people.total).toBe(0);
    expect(sections.seen.items.map((entry) => entry.threadId)).toEqual([
      "open",
    ]);
  });

  it("releases the previous thread when the capture moves to the next selection", () => {
    // Both letters are read on the server. Only the newly selected one keeps
    // its captured placement; the previous one settles into Seen.
    const items = [
      item({
        accountId: ACCOUNT_A,
        threadId: "previous",
        lastMessageAt: 900,
        unread: false,
      }),
      item({
        accountId: ACCOUNT_B,
        threadId: "next",
        lastMessageAt: 800,
        unread: false,
      }),
    ];
    const sections = deriveUnifiedSections(items, accounts, {
      accountId: ACCOUNT_B,
      threadId: "next",
      unread: true,
      category: "people",
    });
    expect(
      sections.people.groups.map((group) => ({
        accountId: group.accountId,
        threads: group.items.map((entry) => entry.threadId),
      })),
    ).toEqual([{ accountId: ACCOUNT_B, threads: ["next"] }]);
    expect(sections.seen.items.map((entry) => entry.threadId)).toEqual([
      "previous",
    ]);
  });

  it("matches the sticky item by both accountId and threadId", () => {
    // The same provider-scoped thread id in the other account must not stick.
    const items = [
      item({ accountId: ACCOUNT_A, threadId: "t1", unread: false }),
      item({ accountId: ACCOUNT_B, threadId: "t1", unread: false }),
    ];
    const sections = deriveUnifiedSections(items, accounts, {
      accountId: ACCOUNT_A,
      threadId: "t1",
      unread: true,
      category: "people",
    });
    expect(sections.people.total).toBe(1);
    expect(sections.people.groups[0]?.accountId).toBe(ACCOUNT_A);
    expect(sections.seen.items.map((entry) => entry.accountId)).toEqual([
      ACCOUNT_B,
    ]);
  });
});

describe("visibleUnifiedItems", () => {
  const accounts = [
    { accountId: ACCOUNT_A, emailAddress: "a@example.test" },
    { accountId: ACCOUNT_B, emailAddress: "b@example.test" },
  ];

  function bigSections() {
    const people = Array.from({ length: 5 }, (_value, index) =>
      item({ accountId: ACCOUNT_A, threadId: `p${index}` }),
    );
    const notifications = Array.from({ length: 4 }, (_value, index) =>
      item({
        accountId: ACCOUNT_B,
        threadId: `n${index}`,
        category: "notification",
      }),
    );
    const seen = [
      item({ accountId: ACCOUNT_A, threadId: "s0", unread: false }),
      item({ accountId: ACCOUNT_B, threadId: "s1", unread: false }),
    ];
    return deriveUnifiedSections([...people, ...notifications, ...seen], accounts);
  }

  it("collapsed: first three rows per section, Seen hidden entirely", () => {
    const visible = visibleUnifiedItems(bigSections(), UNIFIED_EXPAND_COLLAPSED);
    expect(visible.map((entry) => entry.threadId)).toEqual([
      "p0",
      "p1",
      "p2",
      "n0",
      "n1",
      "n2",
    ]);
  });

  it("expanders reveal the full section and the Seen rows", () => {
    const visible = visibleUnifiedItems(bigSections(), {
      people: true,
      notifications: false,
      newsletters: false,
      seen: true,
    });
    expect(visible.map((entry) => entry.threadId)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "n0",
      "n1",
      "n2",
      "s0",
      "s1",
    ]);
  });

  it("caps the collapsed People preview across account groups", () => {
    const sections = deriveUnifiedSections(
      [
        item({ accountId: ACCOUNT_A, threadId: "a1", lastMessageAt: 900 }),
        item({ accountId: ACCOUNT_A, threadId: "a2", lastMessageAt: 800 }),
        item({ accountId: ACCOUNT_B, threadId: "b1", lastMessageAt: 950 }),
        item({ accountId: ACCOUNT_B, threadId: "b2", lastMessageAt: 700 }),
      ],
      accounts,
    );
    const visible = visibleUnifiedItems(sections, UNIFIED_EXPAND_COLLAPSED);
    // Groups render in accounts order (A first): both A rows, then one B row.
    expect(visible.map((entry) => entry.threadId)).toEqual(["a1", "a2", "b1"]);
  });

  it("walks New senders first, every waiting row whatever the others hide", () => {
    const from = { name: null, address: "new@stranger.example" };
    const waiting = Array.from({ length: 5 }, (_value, index) =>
      item({
        accountId: ACCOUNT_B,
        threadId: `w${index}`,
        newSender: true,
        newSenderFrom: from,
      }),
    );
    const sections = deriveUnifiedSections(
      [item({ accountId: ACCOUNT_A, threadId: "p0" }), ...waiting],
      accounts,
    );
    const visible = visibleUnifiedItems(sections, UNIFIED_EXPAND_COLLAPSED);
    expect(visible.map((entry) => entry.threadId)).toEqual([
      "w0",
      "w1",
      "w2",
      "w3",
      "w4",
      "p0",
    ]);
  });
});

describe("unifiedSectionForm", () => {
  it("shows every row when the section is expanded", () => {
    expect(unifiedSectionForm(64, true)).toBe("rows");
    expect(unifiedSectionForm(2, true)).toBe("rows");
  });

  it("shows every row when a collapsed section hides nothing", () => {
    expect(unifiedSectionForm(3, false)).toBe("rows");
    expect(unifiedSectionForm(0, false)).toBe("rows");
  });

  it("previews while it hides no more than it shows", () => {
    expect(unifiedSectionForm(4, false)).toBe("preview");
    expect(unifiedSectionForm(6, false)).toBe("preview");
  });

  it("bundles as soon as it hides more than it shows", () => {
    // Three rows can stand for four threads. They cannot stand for
    // sixty-four, and the ring holds one digest row instead.
    expect(unifiedSectionForm(7, false)).toBe("bundle");
    expect(unifiedSectionForm(64, false)).toBe("bundle");
  });

  it("always bundles a section that hides all of itself (Seen)", () => {
    expect(unifiedSectionForm(2, false, true)).toBe("bundle");
    expect(unifiedSectionForm(9, false, true)).toBe("bundle");
    expect(unifiedSectionForm(9, true, true)).toBe("rows");
  });
});

describe("visibleSectionItems", () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    item({ accountId: ACCOUNT_A, threadId: `n${index}` }),
  );

  it("contributes nothing while bundled, so the keyboard cannot land there", () => {
    expect(visibleSectionItems(many, false)).toEqual([]);
    expect(visibleSectionItems(many, true)).toHaveLength(9);
    expect(visibleSectionItems(many.slice(0, 5), false)).toHaveLength(3);
  });
});

describe("unifiedBundleSummary", () => {
  const pile = [
    item({
      accountId: ACCOUNT_A,
      threadId: "n0",
      subject: "Three people answered your notice",
      participants: [{ name: "Roundhouse", address: "no-reply@roundhouse.test" }],
    }),
    item({
      accountId: ACCOUNT_A,
      threadId: "n1",
      participants: [{ name: "Kettle & Bell", address: "letters@kettle.test" }],
    }),
    item({
      accountId: ACCOUNT_A,
      threadId: "n2",
      participants: [{ name: "Roundhouse", address: "no-reply@roundhouse.test" }],
      unread: false,
    }),
    item({
      accountId: ACCOUNT_A,
      threadId: "n3",
      participants: [{ name: "Bramble Post", address: "hello@bramble.test" }],
    }),
  ];

  it("stacks the two distinct senders it names and counts the rest", () => {
    const summary = unifiedBundleSummary(pile);
    expect(
      summary.senders.map((entry) => entry.participants[0]?.name),
    ).toEqual(["Roundhouse", "Kettle & Bell"]);
    expect(summary.more).toBe(2);
    expect(summary.total).toBe(4);
    expect(summary.unread).toBe(3);
    expect(summary.newest?.subject).toBe("Three people answered your notice");
  });

  it("counts the rest from the names it says, not from two", () => {
    // Seven threads, one sender: the row can only name one, so "and N more"
    // has to start from one. Counting from two said "and 5 more" under a
    // header reading 7.
    const oneSender = Array.from({ length: 7 }, (_, index) =>
      item({
        accountId: ACCOUNT_A,
        threadId: `s${index}`,
        participants: [{ name: "The Slow Ferry", address: "post@slowferry.test" }],
      }),
    );
    const summary = unifiedBundleSummary(oneSender);
    expect(summary.senders).toHaveLength(1);
    expect(summary.more).toBe(6);
    expect(summary.more + summary.senders.length).toBe(summary.total);
  });

  it("has no senders and no newest thread for an empty pile", () => {
    const summary = unifiedBundleSummary([]);
    expect(summary.senders).toEqual([]);
    expect(summary.newest).toBeNull();
  });
});

describe("restoreStreamItems", () => {
  const older = item({
    accountId: ACCOUNT_A,
    threadId: "old",
    lastMessageAt: 1_000,
  });
  const middle = item({
    accountId: ACCOUNT_A,
    threadId: "mid",
    lastMessageAt: 2_000,
  });
  const newer = item({
    accountId: ACCOUNT_A,
    threadId: "new",
    lastMessageAt: 3_000,
  });

  it("puts each thread back in its own stream, in merge order", () => {
    const streams = [
      stream(ACCOUNT_A, { items: [newer, older] }),
      stream(ACCOUNT_B, { items: [] }),
    ];
    const restored = restoreStreamItems(streams, [middle]);
    expect(restored[0]?.items.map((entry) => entry.threadId)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    // A sorted insertion, not an append: the merge takes a stream's horizon
    // from its last item, and an out-of-order tail would move the safe cut.
    expect(restored[1]).toBe(streams[1]);
  });

  it("restores across accounts and leaves untouched streams identical", () => {
    const theirs = item({
      accountId: ACCOUNT_B,
      threadId: "b1",
      lastMessageAt: 2_500,
    });
    const streams = [
      stream(ACCOUNT_A, { items: [newer] }),
      stream(ACCOUNT_B, { items: [] }),
    ];
    const restored = restoreStreamItems(streams, [middle, theirs]);
    expect(restored[0]?.items.map((entry) => entry.threadId)).toEqual([
      "new",
      "mid",
    ]);
    expect(restored[1]?.items.map((entry) => entry.threadId)).toEqual(["b1"]);
  });

  it("never doubles a row a refresh already brought back", () => {
    const streams = [stream(ACCOUNT_A, { items: [newer, middle] })];
    const restored = restoreStreamItems(streams, [middle]);
    expect(restored[0]).toBe(streams[0]);
  });

  it("is a no-op when nothing moved", () => {
    const streams = [stream(ACCOUNT_A, { items: [newer] })];
    expect(restoreStreamItems(streams, [])).toBe(streams);
  });
});

describe("appendStreamPage", () => {
  const page = (
    items: readonly MailThreadListItem[],
    nextCursor: string | null = "next",
  ) => ({
    items,
    nextCursor,
    sync: { status: "idle" as const, lastSuccessfulAt: 1_700_000_000_500 },
  });
  const loaded = [
    item({ accountId: ACCOUNT_A, threadId: "t1", lastMessageAt: 300 }),
    item({ accountId: ACCOUNT_A, threadId: "t2", lastMessageAt: 200 }),
  ];

  it("puts an ordinary page on the end, less the rows already loaded", () => {
    const older = item({ accountId: ACCOUNT_A, threadId: "t3", lastMessageAt: 100 });
    const next = appendStreamPage(
      stream(ACCOUNT_A, { items: loaded, nextCursor: "this" }),
      page([loaded[1]!, older]),
    );
    expect(next.items).toEqual([...loaded, older]);
    expect(next.nextCursor).toBe("next");
  });

  it("sorts a re-paged walk's rows in among the loaded ones and drops the mark", () => {
    // Moved back into Inbox since the rows were loaded: between them by date.
    const moved = item({ accountId: ACCOUNT_A, threadId: "moved", lastMessageAt: 250 });
    const older = item({ accountId: ACCOUNT_A, threadId: "t3", lastMessageAt: 100 });
    const next = appendStreamPage(
      stream(ACCOUNT_A, { items: loaded, nextCursor: "this", repage: true }),
      page([loaded[0]!, moved, loaded[1]!, older], null),
    );
    expect(next.items).toEqual([loaded[0], moved, loaded[1], older]);
    expect(next.nextCursor).toBeNull();
    expect(next.repage).toBe(false);
  });

  it("keeps the mark for a walk its cap stopped short of the last loaded row", () => {
    const moved = item({ accountId: ACCOUNT_A, threadId: "moved", lastMessageAt: 250 });
    const next = appendStreamPage(
      stream(ACCOUNT_A, { items: loaded, nextCursor: "this", repage: true }),
      page([loaded[0]!, moved, loaded[1]!], "further"),
    );
    // The next press walks on from "further", and what it brings still sorts
    // in among the loaded rows.
    expect(next.items).toEqual([loaded[0], moved, loaded[1]]);
    expect(next.nextCursor).toBe("further");
    expect(next.repage).toBe(true);
  });

  it("takes a walk's fresh row over the loaded copy of the same thread", () => {
    // Read elsewhere since the stream loaded it: the walk re-read it from the
    // newer snapshot, and the loaded copy is the stale one.
    const readSince = { ...loaded[0]!, unread: false };
    const older = item({ accountId: ACCOUNT_A, threadId: "t3", lastMessageAt: 100 });
    const next = appendStreamPage(
      stream(ACCOUNT_A, { items: loaded, nextCursor: "this", repage: true }),
      page([readSince, loaded[1]!, older], null),
    );
    expect(next.items).toEqual([readSince, loaded[1], older]);
  });

  it("moves a thread a walk found with newer mail to where it now sorts", () => {
    const answered = { ...loaded[1]!, lastMessageAt: 400 };
    const older = item({ accountId: ACCOUNT_A, threadId: "t3", lastMessageAt: 100 });
    const next = appendStreamPage(
      stream(ACCOUNT_A, { items: loaded, nextCursor: "this", repage: true }),
      page([answered, loaded[0]!, older], null),
    );
    expect(next.items).toEqual([answered, loaded[0], older]);
  });

  it("keeps the later read's copy where a walk's pages overlap", () => {
    // Read between the walk's two reads: the second copy is the current one.
    const older = item({ accountId: ACCOUNT_A, threadId: "t3", lastMessageAt: 100 });
    const readSince = { ...older, unread: false };
    const next = appendStreamPage(
      stream(ACCOUNT_A, { items: loaded, nextCursor: "this", repage: true }),
      page([older, readSince], null),
    );
    expect(next.items).toEqual([...loaded, readSince]);
  });

  it.each([false, true])(
    "keeps one row per thread when the pages overlap (re-paged %s)",
    (repage) => {
      // A row that moved down between two of a walk's reads is on both pages.
      const older = item({ accountId: ACCOUNT_A, threadId: "t3", lastMessageAt: 100 });
      const oldest = item({ accountId: ACCOUNT_A, threadId: "t4", lastMessageAt: 50 });
      const next = appendStreamPage(
        stream(ACCOUNT_A, { items: loaded, nextCursor: "this", repage }),
        page([older, older, oldest], null),
      );
      expect(next.items).toEqual([...loaded, older, oldest]);
    },
  );
});

describe("removeStreamItems", () => {
  const first = item({ accountId: ACCOUNT_A, threadId: "a1", lastMessageAt: 3_000 });
  const second = item({ accountId: ACCOUNT_A, threadId: "a2", lastMessageAt: 2_000 });
  const theirs = item({ accountId: ACCOUNT_B, threadId: "b1", lastMessageAt: 2_500 });

  it("takes a whole section out in one pass, each row from its own stream", () => {
    const streams = [
      stream(ACCOUNT_A, { items: [first, second] }),
      stream(ACCOUNT_B, { items: [theirs] }),
    ];
    const next = removeStreamItems(streams, [second, theirs]);
    expect(next[0]?.items.map((entry) => entry.threadId)).toEqual(["a1"]);
    expect(next[1]?.items).toEqual([]);
  });

  it("leaves a stream it did not touch identical", () => {
    const streams = [
      stream(ACCOUNT_A, { items: [first] }),
      stream(ACCOUNT_B, { items: [theirs] }),
    ];
    const next = removeStreamItems(streams, [first]);
    expect(next[1]).toBe(streams[1]);
  });

  it("is a no-op when nothing was asked for, or nothing matched", () => {
    const streams = [stream(ACCOUNT_A, { items: [first] })];
    expect(removeStreamItems(streams, [])).toBe(streams);
    expect(removeStreamItems(streams, [theirs])).toBe(streams);
  });

  it("round-trips with restoreStreamItems", () => {
    const streams = [stream(ACCOUNT_A, { items: [first, second] })];
    const emptied = removeStreamItems(streams, [first, second]);
    expect(emptied[0]?.items).toEqual([]);
    const back = restoreStreamItems(emptied, [second, first]);
    expect(back[0]?.items.map((entry) => entry.threadId)).toEqual(["a1", "a2"]);
  });
});
