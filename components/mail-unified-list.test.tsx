// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionRender } from "@/test/framer-motion-mock";
import { MailUnifiedList } from "./mail-unified-list";
import {
  deriveUnifiedSections,
  UNIFIED_EXPAND_COLLAPSED,
  type UnifiedExpandState,
  type UnifiedState,
  type UnifiedStream,
} from "./mail-unified";
import type {
  MailThreadListItem,
  PublicMailAccount,
} from "./mail-surface-client";

// The mock surfaces `initial` and `exit` as data attributes so the entrance
// and exit-gating rules can be asserted structurally: animation playback is
// not under test, the props the rows would hand framer-motion are. `initial`
// is captured at mount (a useState initializer), exactly like framer, which
// ignores later `initial` changes on a mounted node; `exit` stays live, like
// framer, which reads the last rendered value when the node leaves.
vi.mock("framer-motion", async () => {
  const { useState } = await import("react");
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  const useMotionAttributes = ({ motion }: MotionRender) => {
    const [initialAtMount] = useState(motion.initial);
    return {
      "data-motion-initial": initialAtMount === false ? "none" : "animated",
      "data-motion-exit": motion.exit === undefined ? "none" : "fade",
    };
  };
  return createFramerMotionMock({
    reducedMotion: false,
    onRender: useMotionAttributes,
  });
});

const gmailCapabilities = {
  mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
  listThreads: true,
  sync: true,
  headerPreview: true,
  messageBodies: true,
  threadMutations: true,
  compose: true,
  send: true,
  reply: true,
} as const;

const accountA: PublicMailAccount = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  emailAddress: "a@example.test",
  displayName: "Personal",
  status: "connected",
  connectedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerKind: "gmail",
  capabilities: gmailCapabilities,
};

const accountB: PublicMailAccount = {
  ...accountA,
  accountId: "account-affffffffffffffffffffffffffffffff",
  emailAddress: "b@example.test",
  displayName: null,
};

/** The owner's second mailbox: IMAP cannot mutate threads at all. */
const imapB: PublicMailAccount = {
  ...accountB,
  providerKind: "imap",
  capabilities: { ...gmailCapabilities, threadMutations: false },
  imap: {
    hostname: "imap.example.test",
    port: 993,
    tls: "implicit",
    username: "b@example.test",
  },
};

function item(
  overrides: Partial<MailThreadListItem> & {
    readonly accountId: string;
    readonly threadId: string;
  },
): MailThreadListItem {
  return {
    subject: overrides.threadId,
    participants: [{ name: "Casey Sender", address: "casey@sender.test" }],
    snippet: "Preview text",
    lastMessageAt: 1_700_000_000_000,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
    ...overrides,
  };
}

function readyStream(
  account: PublicMailAccount,
  items: readonly MailThreadListItem[],
  overrides: Partial<UnifiedStream> = {},
): UnifiedStream {
  return {
    accountId: account.accountId,
    emailAddress: account.emailAddress,
    items,
    nextCursor: null,
    status: "ready",
    sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    ...overrides,
  };
}

type Overrides = Partial<Parameters<typeof MailUnifiedList>[0]>;

describe("MailUnifiedList", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function render(
    items: readonly MailThreadListItem[],
    overrides: Overrides = {},
    expand: UnifiedExpandState = UNIFIED_EXPAND_COLLAPSED,
  ) {
    const accounts = [accountA, accountB];
    const state: UnifiedState = {
      kind: "ready",
      streams: [
        readyStream(
          accountA,
          items.filter((entry) => entry.accountId === accountA.accountId),
        ),
        readyStream(
          accountB,
          items.filter((entry) => entry.accountId === accountB.accountId),
        ),
      ],
    };
    const props = {
      accounts,
      nav: <div data-testid="mail-nav" />,
      state,
      sections: deriveUnifiedSections(items, accounts),
      hasMore: false,
      expand,
      selectedThreadKey: null,
      exitFades: false,
      onToggleExpand: vi.fn(),
      onSelectThread: vi.fn(),
      onLoadMore: vi.fn(),
      onRetryStream: vi.fn(),
      onSectionDone: vi.fn(),
      onOpenSettings: vi.fn(),
      ...overrides,
    };
    await act(async () => root.render(<MailUnifiedList {...props} />));
    return props;
  }

  function button(name: string): HTMLButtonElement {
    const found = [...document.body.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.trim() === name ||
        candidate.getAttribute("aria-label") === name,
    );
    if (!(found instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${name}`);
    }
    return found;
  }

  it("renders sections in order with counts, sub-headers, and a collapsed Seen", async () => {
    await render([
      item({ accountId: accountA.accountId, threadId: "People A1" }),
      item({ accountId: accountB.accountId, threadId: "People B1" }),
      item({
        accountId: accountA.accountId,
        threadId: "Note A1",
        category: "notification",
      }),
      item({
        accountId: accountB.accountId,
        threadId: "Letter B1",
        category: "newsletter",
      }),
      item({
        accountId: accountA.accountId,
        threadId: "Seen A1",
        unread: false,
      }),
    ]);

    const sections = [
      ...document.body.querySelectorAll('[role="list"] > section'),
    ];
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(
      ["People", "Notifications", "Newsletters", "Seen"],
    );
    // Both accounts contribute People rows, so their sub-headers render.
    expect(sections[0]?.textContent).toContain("a@example.test");
    expect(sections[0]?.textContent).toContain("b@example.test");
    expect(sections[0]?.textContent).toContain("People A1");
    expect(sections[0]?.textContent).toContain("People B1");
    expect(sections[1]?.textContent).toContain("Note A1");
    expect(sections[2]?.textContent).toContain("Letter B1");
    // Seen is collapsed: header with count, no rows.
    expect(sections[3]?.textContent).toContain("1");
    expect(sections[3]?.textContent).not.toContain("Seen A1");
    expect(
      sections[3]?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("discloses past three rows from the header chevron and toggles through the callback", async () => {
    const items = Array.from({ length: 5 }, (_value, index) =>
      item({ accountId: accountA.accountId, threadId: `Row ${index}` }),
    );
    const props = await render(items);

    expect(document.body.textContent).toContain("Row 0");
    expect(document.body.textContent).toContain("Row 2");
    expect(document.body.textContent).not.toContain("Row 3");
    // The chevron lives on the People header, beside Done — the same
    // place and the same object Seen's disclosure uses.
    const header = document.body.querySelector(
      'section[aria-label="People"] .brain-mail-section-head',
    ) as HTMLElement;
    const disclose = button("Show all 5 in People");
    expect(header.contains(disclose)).toBe(true);
    expect(disclose.getAttribute("aria-expanded")).toBe("false");
    await act(async () => disclose.click());
    expect(props.onToggleExpand).toHaveBeenCalledWith("people");

    await render(items, {}, { ...UNIFIED_EXPAND_COLLAPSED, people: true });
    expect(document.body.textContent).toContain("Row 3");
    expect(document.body.textContent).toContain("Row 4");
    expect(button("Collapse People").getAttribute("aria-expanded")).toBe("true");
  });

  it("hides the disclosure at three rows or fewer", async () => {
    await render([
      item({ accountId: accountA.accountId, threadId: "Only 1" }),
      item({ accountId: accountA.accountId, threadId: "Only 2" }),
      item({ accountId: accountA.accountId, threadId: "Only 3" }),
    ]);
    expect(
      document.body.querySelector(
        'section[aria-label="People"] [aria-expanded]',
      ),
    ).toBeNull();
  });

  /** The unlearnable inconsistency this replaced: Seen opened from its header
   *  while the other three opened from a button under their rows. Every
   *  section that hides rows now discloses from the same slot. */
  it("puts the disclosure on the header of every section that hides rows", async () => {
    const many = (
      category: MailThreadListItem["category"],
      prefix: string,
    ) =>
      Array.from({ length: 4 }, (_value, index) =>
        item({
          accountId: accountA.accountId,
          threadId: `${prefix}${index}`,
          category,
        }),
      );
    await render([
      ...many("people", "P"),
      ...many("notification", "N"),
      ...many("newsletter", "L"),
      item({ accountId: accountA.accountId, threadId: "S0", unread: false }),
    ]);

    for (const label of ["People", "Notifications", "Newsletters", "Seen"]) {
      const head = document.body.querySelector(
        `section[aria-label="${label}"] .brain-mail-section-head`,
      );
      expect(head?.querySelector("[aria-expanded]")).not.toBeNull();
    }
    // No control survives below the rows.
    expect(document.body.textContent).not.toContain("Show all (");
  });

  it("toggles the Seen section from its header row", async () => {
    const items = [
      item({ accountId: accountA.accountId, threadId: "Fresh" }),
      item({
        accountId: accountA.accountId,
        threadId: "Old news",
        unread: false,
      }),
    ];
    const props = await render(items);
    expect(document.body.textContent).not.toContain("Old news");
    const seenHeader = document.body.querySelector(
      'section[aria-label="Seen"] [aria-expanded]',
    ) as HTMLButtonElement;
    await act(async () => seenHeader.click());
    expect(props.onToggleExpand).toHaveBeenCalledWith("seen");

    await render(items, {}, { ...UNIFIED_EXPAND_COLLAPSED, seen: true });
    expect(document.body.textContent).toContain("Old news");
    expect(
      document.body
        .querySelector('section[aria-label="Seen"] [aria-expanded]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("offers Done per unread section with the full section rows", async () => {
    const peopleItems = [
      item({ accountId: accountA.accountId, threadId: "P1" }),
      item({ accountId: accountB.accountId, threadId: "P2" }),
    ];
    const noteItems = [
      item({
        accountId: accountA.accountId,
        threadId: "N1",
        category: "notification",
      }),
    ];
    const onSectionDone = vi.fn();
    await render(
      [
        ...peopleItems,
        ...noteItems,
        item({ accountId: accountA.accountId, threadId: "S1", unread: false }),
      ],
      { onSectionDone },
    );

    await act(async () => button("Done — archive all 2 in People").click());
    expect(onSectionDone).toHaveBeenCalledTimes(1);
    const peopleArg = onSectionDone.mock.calls[0]?.[0] as
      | readonly MailThreadListItem[]
      | undefined;
    expect(peopleArg?.map((entry) => entry.threadId).sort()).toEqual([
      "P1",
      "P2",
    ]);
    expect(onSectionDone.mock.calls[0]?.[1]).toBe("People");

    await act(async () =>
      button("Done — archive all 1 in Notifications").click(),
    );
    const noteArg = onSectionDone.mock.calls[1]?.[0] as
      | readonly MailThreadListItem[]
      | undefined;
    expect(noteArg?.map((entry) => entry.threadId)).toEqual(["N1"]);
    expect(onSectionDone.mock.calls[1]?.[1]).toBe("Notifications");

    // Seen gets Done as well: a pile already read is the pile a reader most
    // wants out of the column, and the protection is the undo, not the hiding.
    await act(async () => button("Done — archive all 1 in Seen").click());
    const seenArg = onSectionDone.mock.calls[2]?.[0] as
      | readonly MailThreadListItem[]
      | undefined;
    expect(seenArg?.map((entry) => entry.threadId)).toEqual(["S1"]);
    expect(onSectionDone.mock.calls[2]?.[1]).toBe("Seen");
  });

  it("keeps the chevron's slot when a section has nothing to disclose", async () => {
    // Two threads under People: no disclosure, and Done must still not be the
    // control on the column's edge — the position reserved for the harmless
    // one — nor jump 34px between one section of the column and the next.
    await render([
      item({ accountId: accountA.accountId, threadId: "P1" }),
      item({ accountId: accountA.accountId, threadId: "P2" }),
      item({
        accountId: accountA.accountId,
        threadId: "N1",
        category: "notification",
      }),
      item({
        accountId: accountA.accountId,
        threadId: "N2",
        category: "notification",
      }),
      item({
        accountId: accountA.accountId,
        threadId: "N3",
        category: "notification",
      }),
      item({
        accountId: accountA.accountId,
        threadId: "N4",
        category: "notification",
      }),
    ]);
    const people = document.body.querySelector(
      'section[aria-label="People"] .brain-mail-section-head',
    );
    expect(people?.querySelector("[aria-expanded]")).toBeNull();
    // Done, then a spacer holding the chevron's place.
    const trailing = people?.lastElementChild;
    expect(trailing?.getAttribute("aria-hidden")).toBe("true");
    expect(trailing?.className).toContain("size-7");
    // Notifications does disclose, and its chevron is the same last child —
    // so the two Done glyphs line up down the column.
    const notes = document.body.querySelector(
      'section[aria-label="Notifications"] .brain-mail-section-head',
    );
    expect(notes?.lastElementChild?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("hands Done a bundled section's whole contents, not the preview", async () => {
    // Eight newsletters bundle: the list shows one digest row and no rows at
    // all, and clearing 64 of them at once is the entire point of the control.
    const letters = Array.from({ length: 8 }, (_, index) =>
      item({
        accountId: accountA.accountId,
        threadId: `NL${index}`,
        category: "newsletter",
      }),
    );
    const onSectionDone = vi.fn();
    await render(letters, { onSectionDone });

    expect(
      document.body.querySelectorAll(
        'section[aria-label="Newsletters"] [role="listitem"]',
      ).length,
    ).toBe(1);
    await act(async () =>
      button("Done — archive all 8 in Newsletters").click(),
    );
    const arg = onSectionDone.mock.calls[0]?.[0] as
      | readonly MailThreadListItem[]
      | undefined;
    expect(arg?.length).toBe(8);
  });

  it("counts what Done can move, not what the section holds", async () => {
    // Mixed section: three of the five sit on the IMAP mailbox, which cannot
    // archive. "All 5" would be a promise the button cannot keep, and the
    // three left behind would stay in the column with nothing said of them.
    const onSectionDone = vi.fn();
    await render(
      [
        item({ accountId: accountA.accountId, threadId: "P1" }),
        item({ accountId: accountA.accountId, threadId: "P2" }),
        item({ accountId: accountB.accountId, threadId: "P3" }),
        item({ accountId: accountB.accountId, threadId: "P4" }),
        item({ accountId: accountB.accountId, threadId: "P5" }),
      ],
      { accounts: [accountA, imapB], onSectionDone },
    );

    const done = button("Done — archive 2 of 5 in People");
    expect(done.getAttribute("title")).toBe("Done — archive 2 of 5 in People");
    // It still hands over the WHOLE section: the surface owns the split, and
    // it is the one that has to name what stayed.
    await act(async () => done.click());
    const arg = onSectionDone.mock.calls[0]?.[0] as
      | readonly MailThreadListItem[]
      | undefined;
    expect(arg?.length).toBe(5);
  });

  it("draws no Done on a section nothing can archive", async () => {
    await render(
      [
        item({ accountId: accountB.accountId, threadId: "P1" }),
        item({ accountId: accountB.accountId, threadId: "P2" }),
      ],
      { accounts: [accountA, imapB] },
    );

    // An always-visible destructive control that silently does nothing is
    // worse than an absent one; the section is still there, and so is its
    // count.
    expect(
      [...document.body.querySelectorAll("button")].filter((candidate) =>
        candidate.getAttribute("aria-label")?.startsWith("Done — "),
      ),
    ).toHaveLength(0);
    expect(
      document.body.querySelector('section[aria-label="People"]'),
    ).not.toBeNull();
  });

  it("draws Done without waiting for a hover", async () => {
    await render([item({ accountId: accountA.accountId, threadId: "P1" })]);
    const done = button("Done — archive all 1 in People");
    expect(done.className).not.toContain("brain-mail-section-mark");
  });

  it("leads rows with the sender icon and falls back to the monogram on error", async () => {
    await render([
      item({ accountId: accountA.accountId, threadId: "Icon row" }),
    ]);

    const icon = document.body.querySelector(
      'section[aria-label="People"] img',
    ) as HTMLImageElement;
    expect(icon.getAttribute("src")).toBe(
      "/api/mail/sender-icon/sender.test",
    );
    await act(async () => {
      icon.dispatchEvent(new Event("error"));
    });
    expect(
      document.body.querySelector('section[aria-label="People"] img'),
    ).toBeNull();
    expect(
      document.body.querySelector('section[aria-label="People"]')?.textContent,
    ).toContain("C");
  });

  it("bounds every group with a rule and keeps its header outside the rows", async () => {
    await render([
      item({ accountId: accountA.accountId, threadId: "p1" }),
      item({
        accountId: accountA.accountId,
        threadId: "n1",
        category: "notification",
        listMessage: true,
      }),
    ]);
    const people = host.querySelector('section[aria-label="People"]')!;
    const rows = people.querySelector(".brain-mail-rows")!;
    expect(rows).not.toBeNull();
    // The rows box is one level deeper than the list, so it has to be
    // invisible to it: a listitem's required owner is the list, not a wrapper.
    expect(rows.getAttribute("role")).toBe("presentation");
    // The header is a sibling of the rows, never inside them: a group is
    // named above the block it bounds.
    expect(rows.querySelector(".brain-mail-section-head")).toBeNull();
    expect(people.querySelector(".brain-mail-section-head")).not.toBeNull();
    // A group is bounded by a rule, not drawn as a contour. Nothing in the
    // column carries the ring the sections used to stand in.
    expect(host.querySelector(".brain-mail-ring")).toBeNull();
    // The boundary belongs to the section, and the first group in the column
    // does not draw one — the rule between People and Notifications is
    // Notifications' own.
    const sections = host.querySelectorAll(".brain-mail-section");
    expect(sections.length).toBeGreaterThan(1);
  });

  it("bundles a pile into one digest row inside the same group", async () => {
    const senders = ["Roundhouse", "Kettle & Bell", "Bramble Post", "The Slow Ferry"];
    await render(
      Array.from({ length: 8 }, (_, index) =>
        item({
          accountId: accountA.accountId,
          threadId: `news-${index}`,
          subject: `Newsletter ${index}`,
          category: "newsletter",
          listMessage: true,
          participants: [
            {
              name: senders[index % senders.length]!,
              address: `list-${index % senders.length}@lists.test`,
            },
          ],
          lastMessageAt: 1_700_000_000_000 - index * 1_000,
        }),
      ),
    );
    const section = host.querySelector('section[aria-label="Newsletters"]')!;
    const bundle = section.querySelector(".brain-mail-bundle")!;
    expect(bundle).not.toBeNull();
    // The names truncate, the count does not — so they are separate spans.
    expect(bundle.textContent).toContain("Roundhouse, Kettle & Bell");
    expect(bundle.textContent).toContain("and 6 more");
    expect(bundle.textContent).toContain("Newsletter 0");
    // Eight newsletters occupy one row: no thread row is rendered at all.
    expect(section.querySelectorAll(".brain-mail-row").length).toBe(0);
    expect(bundle.querySelector(".brain-mail-dot")).not.toBeNull();
    // The digest is an item of the list it stands in, and its dot is a mark:
    // the count the mark stands for is only said in the sr-only word.
    expect(bundle.getAttribute("role")).toBe("listitem");
    expect(bundle.textContent).toContain("8 unread");
    // The stack shows exactly the senders the line names.
    expect(bundle.querySelectorAll(".brain-mail-avstack > *").length).toBe(2);
  });

  it("gives every account a word no other account answers to", async () => {
    // Two mailboxes, one local part. The word is the only thing on the row
    // that says which one a letter landed in, so it cannot be "misha" twice.
    const personal = { ...accountA, emailAddress: "misha@example.test" };
    const studio = { ...accountB, emailAddress: "misha@studio.example" };
    const items = [
      item({ accountId: personal.accountId, threadId: "p1" }),
      item({ accountId: studio.accountId, threadId: "p2" }),
    ];
    await render(items, {
      accounts: [personal, studio],
      state: {
        kind: "ready",
        streams: [
          readyStream(personal, [items[0]!]),
          readyStream(studio, [items[1]!]),
        ],
      },
      sections: deriveUnifiedSections(items, [personal, studio]),
    });
    const words = [...host.querySelectorAll(".brain-mail-row")].map(
      (row) => row.querySelector(".max-w-\\[9ch\\]")?.textContent ?? "",
    );
    expect(words).toEqual(["example", "studio"]);
  });

  it("collapses Seen to a count rather than to a preview", async () => {
    await render([
      item({ accountId: accountA.accountId, threadId: "s1", unread: false }),
      item({ accountId: accountA.accountId, threadId: "s2", unread: false }),
    ]);
    const seen = host.querySelector('section[aria-label="Seen"]')!;
    expect(seen.textContent).toContain("2 threads, nothing unread");
    expect(seen.querySelectorAll(".brain-mail-row").length).toBe(0);
  });

  it("renders per-stream failure notices with retry and settings affordances", async () => {
    const items = [item({ accountId: accountA.accountId, threadId: "Alive" })];
    const state: UnifiedState = {
      kind: "ready",
      streams: [
        readyStream(accountA, items),
        readyStream(accountB, [], { status: "error" }),
      ],
    };
    const props = await render(items, { state });
    expect(document.body.textContent).toContain("b@example.test couldn’t load");
    await act(async () => button("Try again").click());
    expect(props.onRetryStream).toHaveBeenCalledWith(accountB.accountId);

    const reauthState: UnifiedState = {
      kind: "ready",
      streams: [
        readyStream(accountA, items),
        readyStream(accountB, [], { status: "reauth" }),
      ],
    };
    const reauthProps = await render(items, { state: reauthState });
    expect(document.body.textContent).toContain(
      "b@example.test needs to be reconnected",
    );
    await act(async () => button("Mail settings").click());
    // the reauth affordance deep-links the failing account's settings
    expect(reauthProps.onOpenSettings).toHaveBeenCalledWith(
      expect.any(HTMLButtonElement),
      accountB.accountId,
    );
  });

  it("shows Inbox zero only when every stream is ready and empty", async () => {
    await render([]);
    expect(document.body.textContent).toContain("Inbox zero");
    expect(document.body.textContent).toContain(
      "Nothing unread across your accounts",
    );

    const degraded: UnifiedState = {
      kind: "ready",
      streams: [
        readyStream(accountA, []),
        readyStream(accountB, [], { status: "error" }),
      ],
    };
    await render([], { state: degraded });
    expect(document.body.textContent).not.toContain("Inbox zero");
    // A failed stream never leaves the pane blank under its notice.
    expect(document.body.textContent).toContain("Nothing to show yet");
    expect(document.body.textContent).toContain("retry above");
  });

  it("plays the entrance fade only on the first rows render, never on re-derive", async () => {
    const first = [
      item({ accountId: accountA.accountId, threadId: "Row one" }),
      item({ accountId: accountA.accountId, threadId: "Row two" }),
    ];
    await render(first);
    const initialRows = [
      ...document.body.querySelectorAll('[role="listitem"]'),
    ];
    expect(initialRows.length).toBe(2);
    for (const row of initialRows) {
      expect(row.getAttribute("data-motion-initial")).toBe("animated");
    }

    // A re-partition within the same mounted list: one row turns read (moves
    // to Seen, expanded here so it stays rendered) and a new one arrives.
    // Rows mounting now render settled — no mount fade, no stagger replay —
    // while the row that stayed in place keeps its already-played mount.
    const repartitioned = [
      item({ accountId: accountA.accountId, threadId: "Row new" }),
      item({ accountId: accountA.accountId, threadId: "Row two" }),
      item({ accountId: accountA.accountId, threadId: "Row one", unread: false }),
    ];
    await render(repartitioned, {}, { ...UNIFIED_EXPAND_COLLAPSED, seen: true });
    const mountKind = (subject: string) => {
      const row = [
        ...document.body.querySelectorAll('[role="listitem"]'),
      ].find((candidate) => candidate.textContent?.includes(subject));
      return row?.getAttribute("data-motion-initial");
    };
    // Newly arrived row: settled mount.
    expect(mountKind("Row new")).toBe("none");
    // Row that moved People→Seen remounts in the other section: settled, no
    // enter fade.
    expect(mountKind("Row one")).toBe("none");
  });

  it("keeps the entrance settled even when the list first renders empty", async () => {
    await render([]);
    expect(document.body.textContent).toContain("Inbox zero");
    await render([item({ accountId: accountA.accountId, threadId: "Arrival" })]);
    const row = document.body.querySelector('[role="listitem"]');
    expect(row?.getAttribute("data-motion-initial")).toBe("none");
  });

  it("arms the exit fade only while an explicit mutation is in flight", async () => {
    const items = [
      item({ accountId: accountA.accountId, threadId: "Plain row" }),
    ];
    await render(items);
    expect(
      document.body
        .querySelector('[role="listitem"]')
        ?.getAttribute("data-motion-exit"),
    ).toBe("none");

    await render(items, { exitFades: true });
    expect(
      document.body
        .querySelector('[role="listitem"]')
        ?.getAttribute("data-motion-exit"),
    ).toBe("fade");
  });

  /* ONE HEAD, ONE ROW, AND COMPOSE NEVER MOVES. The merged column used to
     draw an account `<select>` with Compose riding its free right edge where
     the rail was off screen, and the toolbar pill over the rows where it was
     on — so switching from All inboxes to one account on a phone moved
     Compose between rows. The nav pill fills the first row in both modes and
     Compose keeps the toolbar's right edge in both. */
  it("draws one head row with the navigation it is given and Compose beside it", async () => {
    await render([], { onCompose: vi.fn() });

    expect(document.body.querySelector('[data-testid="mail-nav"]')).not.toBeNull();
    expect(document.body.querySelectorAll("select")).toHaveLength(0);
    expect(
      document.body.querySelectorAll('button[aria-label="New message"]').length,
    ).toBe(1);
    // no search capsule and so no second row: the merged column reads no
    // cross-account index
    expect(document.body.querySelector(".brain-mail-search")).toBeNull();
    expect(
      document.body
        .querySelector(".brain-mail-list")
        ?.getAttribute("data-chrome-rows"),
    ).toBe("1");
    expect(document.body.querySelector(".brain-mail-scrollpad")).not.toBeNull();
  });

  /* The head is there whether or not anything can compose, so the pad and the
     edge under it no longer hang off the pill. */
  it("keeps the head and its reserve where no account can compose", async () => {
    await render([], { onCompose: undefined });

    expect(document.body.querySelector('[data-testid="mail-nav"]')).not.toBeNull();
    expect(
      document.body.querySelectorAll('button[aria-label="New message"]').length,
    ).toBe(0);
    expect(document.body.querySelector(".brain-mail-scrollpad")).not.toBeNull();
  });
});
