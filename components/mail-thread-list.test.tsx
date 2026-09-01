// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatSizeBytes,
  MailThreadList,
  type MailThreadListState,
} from "./mail-thread-list";
import { SOLAR } from "./ui/solar-icons.generated";
import type {
  MailThreadListItem,
  MailThreadPage,
  PublicMailAccount,
} from "./mail-surface-client";

// framer-motion is mocked — assert structure and props, not playback. The
// harness records motion.div renders (the rows container and each row) plus
// the AnimatePresence mode so the stagger contract is inspectable.
const motionHarness = vi.hoisted(() => ({
  reduce: false as boolean,
  divs: [] as Array<Record<string, unknown>>,
  presenceModes: [] as Array<string | undefined>,
}));

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => motionHarness.reduce,
    onRender: ({ tag, motion, props }) => {
      if (tag !== "div") return;
      motionHarness.divs.push({
        role: props.role,
        initial: motion.initial,
        animate: motion.animate,
        transition: motion.transition,
      });
    },
    AnimatePresence: ({ children, mode }) => {
      motionHarness.presenceModes.push(mode);
      return children;
    },
  });
});

const account: PublicMailAccount = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  emailAddress: "person@example.test",
  displayName: "Personal",
  status: "connected",
  connectedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerKind: "gmail",
  capabilities: {
    mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: true,
    send: true,
    reply: true,
  },
};

function makeThread(
  overrides: Partial<MailThreadListItem> & { threadId: string },
): MailThreadListItem {
  return {
    accountId: account.accountId,
    subject: "Subject",
    participants: [{ name: "Ben Johnson", address: "ben@example.test" }],
    snippet: "Preview",
    lastMessageAt: 1_700_000_000_000,
    messageCount: 1,
    unread: false,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
    ...overrides,
  };
}

function readyState(items: readonly MailThreadListItem[]): MailThreadListState {
  const page: MailThreadPage = {
    apiVersion: 1,
    items,
    nextCursor: null,
    sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
  };
  return { kind: "ready", page };
}

function defaultProps(state: MailThreadListState) {
  return {
    accounts: [account] as readonly PublicMailAccount[],
    nav: <div data-testid="mail-nav" />,
    selectedAccountId: account.accountId,
    selectedMailboxId: "inbox" as const,
    selectedView: null,
    threadSort: "date" as const,
    selectedThreadId: null,
    searchQuery: "",
    state,
    syncing: false,
    onSelectSort: vi.fn(),
    onSelectThread: vi.fn(),
    onSearchQueryChange: vi.fn(),
    onCompose: vi.fn(),
    onOpenDrafts: vi.fn(),
    onSync: vi.fn(),
    onRetry: vi.fn(),
    onLoadMore: vi.fn(),
    onOpenSettings: vi.fn(),
  };
}

/** jsdom normalizes markup, so compare icon bodies through the same parser. */
function normalizedIconBody(name: string): string {
  const probe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  probe.innerHTML = SOLAR[name]!;
  return probe.innerHTML;
}

function rowFor(subject: string): HTMLElement {
  const row = [
    ...document.body.querySelectorAll<HTMLElement>('[role="listitem"]'),
  ].find((candidate) => candidate.textContent?.includes(subject));
  if (!row) throw new Error(`Row not found: ${subject}`);
  return row;
}

function rowIcons(row: HTMLElement): string[] {
  return [...row.querySelectorAll("svg")].map((svg) => svg.innerHTML);
}

describe("MailThreadList", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    motionHarness.reduce = false;
    motionHarness.divs.length = 0;
    motionHarness.presenceModes.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("marks a starred thread with the star glyph before the date", async () => {
    const starred = makeThread({ threadId: "t-1", subject: "Starred one", starred: true });
    const plain = makeThread({ threadId: "t-2", subject: "Plain one" });
    await act(async () =>
      root.render(<MailThreadList {...defaultProps(readyState([starred, plain]))} />),
    );

    const starBody = normalizedIconBody("star-linear");
    expect(rowIcons(rowFor("Starred one"))).toContain(starBody);
    expect(rowIcons(rowFor("Plain one"))).not.toContain(starBody);
  });

  it("replaces the attachment text with the paperclip glyph plus a spoken label", async () => {
    const withAttachment = makeThread({
      threadId: "t-1",
      subject: "Files inside",
      hasAttachments: true,
    });
    await act(async () =>
      root.render(<MailThreadList {...defaultProps(readyState([withAttachment]))} />),
    );

    const row = rowFor("Files inside");
    expect(row.textContent).not.toContain("· Attachment");
    expect(rowIcons(row)).toContain(normalizedIconBody("paperclip-linear"));
    const spoken = [...row.querySelectorAll("span")].find(
      (span) => span.textContent === "Has attachment",
    );
    expect(spoken?.className).toContain("sr-only");
  });

  it("swaps the date column for the thread size while sorting by size", async () => {
    const sized = makeThread({
      threadId: "t-1",
      subject: "Big one",
      listMessage: true,
      sizeBytes: 5_452_595,
    });
    const unknown = makeThread({ threadId: "t-2", subject: "No size" });
    await act(async () =>
      root.render(
        <MailThreadList
          {...defaultProps(readyState([sized, unknown]))}
          threadSort="size"
        />,
      ),
    );

    expect(rowFor("Big one").querySelector("time")).toBeNull();
    expect(rowFor("Big one").textContent).toContain("5.2 MB");
    expect(rowFor("No size").textContent).toContain("—");
    // The non-default sort marks its trigger.
    const trigger = document.body.querySelector('[aria-label="Sort: Size"]');
    expect(trigger?.querySelector("span[aria-hidden]")).not.toBeNull();
  });

  it("staggers only the first eight rows and keeps the popLayout container", async () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      makeThread({ threadId: `t-${index}`, subject: `Thread ${index}` }),
    );
    await act(async () =>
      root.render(<MailThreadList {...defaultProps(readyState(items))} />),
    );

    expect(motionHarness.presenceModes).toContain("popLayout");
    const rows = motionHarness.divs.filter((div) => div.role === "listitem");
    expect(rows).toHaveLength(10);
    expect(rows[0]?.initial).toEqual({ opacity: 0, y: 4 });
    expect(rows[3]?.transition).toMatchObject({ delay: 3 * 0.025 });
    expect(rows[7]?.transition).toMatchObject({ delay: 7 * 0.025 });
    expect(rows[8]?.transition).toMatchObject({ delay: 0 });
    expect(rows[9]?.transition).toMatchObject({ delay: 0 });
    const container = motionHarness.divs.find((div) => div.role === "list");
    expect(container?.initial).toEqual({ opacity: 0 });
  });

  it("drops the y offset and the stagger under reduced motion", async () => {
    motionHarness.reduce = true;
    const items = Array.from({ length: 4 }, (_, index) =>
      makeThread({ threadId: `t-${index}`, subject: `Thread ${index}` }),
    );
    await act(async () =>
      root.render(<MailThreadList {...defaultProps(readyState(items))} />),
    );

    const rows = motionHarness.divs.filter((div) => div.role === "listitem");
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.initial).toEqual({ opacity: 0 });
      expect(row.transition).toMatchObject({ delay: 0 });
    }
  });

  /* THE HEAD OWNS NO NAVIGATION OF ITS OWN. It used to carry two native
     selects — an account switcher and a folder picker — drawn exactly where
     the rail was not, which is a mode this column no longer has. The one
     control that names the account and the folder is built by the surface and
     handed down, so the head renders it and holds no second opinion about
     where the reader is. */
  it("renders the navigation it is given and draws no switcher of its own", async () => {
    await act(async () =>
      root.render(<MailThreadList {...defaultProps(readyState([]))} />),
    );

    expect(document.body.querySelector('[data-testid="mail-nav"]')).not.toBeNull();
    expect(document.body.querySelectorAll("select")).toHaveLength(0);
    expect(
      document.body.querySelector('[aria-label="Mail folder"]'),
    ).toBeNull();
    // and the head floats over the rows in every mode, so the column always
    // declares its chrome height and always reserves it
    expect(
      document.body
        .querySelector(".brain-mail-list")
        ?.getAttribute("data-chrome-rows"),
    ).toBe("2");
    expect(
      document.body.querySelector(".brain-mail-scrollpad"),
    ).not.toBeNull();
  });

  /* A CONTROL LIVES AS LONG AS ITS REASON. Drafts is a destination and its
     door is the nav menu; the toolbar icon was a second door to the same
     place. What the menu cannot do is shout, so the icon comes back for
     exactly as long as there is a failed send to report. */
  it("shows the drafts icon only while a send has failed", async () => {
    await act(async () =>
      root.render(<MailThreadList {...defaultProps(readyState([]))} />),
    );
    expect(
      document.body.querySelector('[aria-label^="Drafts"]'),
    ).toBeNull();

    await act(async () =>
      root.render(
        <MailThreadList
          {...defaultProps(readyState([]))}
          failedDraftCount={2}
        />,
      ),
    );
    const drafts = document.body.querySelector(
      '[aria-label="Drafts, 2 didn’t send"]',
    );
    expect(drafts).not.toBeNull();
    expect(drafts?.textContent).toContain("2");

    // an in-flight send is not a reason: it corrects itself
    await act(async () =>
      root.render(
        <MailThreadList
          {...defaultProps(readyState([]))}
          submittingDraftCount={1}
        />,
      ),
    );
    expect(
      document.body.querySelector('[aria-label^="Drafts"]'),
    ).toBeNull();
  });

  it("formats thread sizes for the size column", () => {
    expect(formatSizeBytes(0)).toBe("—");
    expect(formatSizeBytes(1)).toBe("1 KB");
    expect(formatSizeBytes(1_023)).toBe("1 KB");
    expect(formatSizeBytes(1_536)).toBe("2 KB");
    expect(formatSizeBytes(524_288)).toBe("512 KB");
    expect(formatSizeBytes(1_048_576)).toBe("1.0 MB");
    expect(formatSizeBytes(5_452_595)).toBe("5.2 MB");
    expect(formatSizeBytes(1_073_741_824)).toBe("1.0 GB");
  });
});
