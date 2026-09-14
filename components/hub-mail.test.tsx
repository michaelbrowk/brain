// @vitest-environment jsdom

// THE MAIL BLOCK ON HOME. Three unread People rows, one digest row under
// them, and nothing at all when no account is connected, because an absent control
// takes its chrome with it. The architectural case is the seventh: Home never
// waits for mail. Mail is another process with its own latency and its own
// 503, and a dashboard that blocked on it would be a dashboard that is blank
// while the tasks it already has sit in memory.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MailThreadListItem,
  MailThreadPage,
} from "@/lib/mail/message-types";
import type { PublicMailAccount } from "./mail-surface-client";
import { HubMail } from "./hub-mail";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const NOW = new Date("2026-09-13T12:00:00.000Z");

function account(id: string, emailAddress: string): PublicMailAccount {
  return {
    accountId: id,
    emailAddress,
    displayName: null,
    status: "connected",
    connectedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    providerKind: "gmail",
    capabilities: {
      mailboxes: [],
      listThreads: true,
      sync: true,
      headerPreview: true,
      messageBodies: true,
      threadMutations: true,
      compose: true,
      send: true,
      reply: true,
    },
  } as PublicMailAccount;
}

let threadSeq = 0;

function thread(
  over: Partial<MailThreadListItem> & { accountId: string },
): MailThreadListItem {
  threadSeq += 1;
  return {
    threadId: `t${threadSeq}`,
    subject: `Subject ${threadSeq}`,
    participants: [{ name: `Person ${threadSeq}`, address: `p${threadSeq}@example.test` }],
    snippet: null,
    lastMessageAt: NOW.getTime() - threadSeq * 60_000,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "person",
    ...over,
  } as MailThreadListItem;
}

function page(items: MailThreadListItem[]): MailThreadPage {
  return {
    apiVersion: 1,
    items,
    nextCursor: null,
    sync: { status: "idle", lastSuccessfulAt: NOW.getTime() },
  } as MailThreadPage;
}

let host: HTMLDivElement;
let root: Root;
const opened: string[] = [];

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Stub {
  accounts?: PublicMailAccount[];
  accountsFail?: boolean;
  threads?: (accountId: string) => MailThreadPage | Promise<MailThreadPage>;
}

function client(stub: Stub) {
  return {
    loadAccounts: async () => {
      if (stub.accountsFail) throw new Error("mail unavailable");
      return stub.accounts ?? [];
    },
    listThreads: async (input: { accountId: string }) =>
      stub.threads ? stub.threads(input.accountId) : page([]),
  };
}

async function mount(stub: Stub) {
  await act(async () => {
    root.render(
      <HubMail onOpenMail={() => opened.push("mail")} client={client(stub)} />,
    );
  });
  await settle();
}

function rowTexts(): string[] {
  return [...host.querySelectorAll("[data-hub-mail-row]")].map(
    (row) => row.textContent ?? "",
  );
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  // The block asks its questions off the commit (one animation frame), so the
  // frame runs here as soon as it is asked for.
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  threadSeq = 0;
  opened.length = 0;
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Mail block on Home", () => {
  it("renders no block at all when no account is connected", async () => {
    await mount({ accounts: [] });

    expect(host.querySelector("[data-hub-mail]")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("shows at most three unread People rows, freshest first", async () => {
    const a = account("account-a1", "ada@example.test");
    await mount({
      accounts: [a],
      threads: () =>
        page([
          thread({ accountId: a.accountId, lastMessageAt: 5 }),
          thread({ accountId: a.accountId, lastMessageAt: 9 }),
          thread({ accountId: a.accountId, lastMessageAt: 7 }),
          thread({ accountId: a.accountId, lastMessageAt: 3 }),
        ]),
    });

    const people = [...host.querySelectorAll("[data-hub-mail-person]")];
    expect(people).toHaveLength(3);
    // t2 is the 9, t3 the 7, t1 the 5: the merge's own order, not the
    // stream's.
    expect(people.map((row) => row.getAttribute("data-hub-mail-person"))).toEqual([
      "t2",
      "t3",
      "t1",
    ]);
  });

  it("shows one digest row reading '12 notifications, 40 newsletters' with the tail '→ Mail'", async () => {
    const a = account("account-a1", "ada@example.test");
    await mount({
      accounts: [a],
      threads: () =>
        page([
          ...Array.from({ length: 12 }, () =>
            thread({ accountId: a.accountId, category: "notification" }),
          ),
          ...Array.from({ length: 40 }, () =>
            thread({ accountId: a.accountId, category: "newsletter" }),
          ),
        ]),
    });

    const digest = host.querySelector<HTMLElement>("[data-hub-mail-digest]");
    expect(digest?.textContent).toContain("12 notifications, 40 newsletters");
    expect(digest?.textContent).toContain("→ Mail");

    await act(async () => digest?.click());
    expect(opened).toEqual(["mail"]);
  });

  it("shows the digest row alone and no Empty when nothing unread is from a person", async () => {
    const a = account("account-a1", "ada@example.test");
    await mount({
      accounts: [a],
      threads: () =>
        page([thread({ accountId: a.accountId, category: "notification" })]),
    });

    expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(0);
    expect(host.querySelector("[data-hub-mail-digest]")).not.toBeNull();
    expect(host.textContent).not.toContain("Inbox is quiet");
  });

  it("shows 'Inbox is quiet' when nothing is unread at all", async () => {
    await mount({
      accounts: [account("account-a1", "ada@example.test")],
      threads: () => page([]),
    });

    expect(host.textContent).toContain("Inbox is quiet");
    expect(host.querySelector("[data-hub-mail-digest]")).toBeNull();
  });

  it("shows one row reading \"Couldn't reach ‹account›\" when the stream is unreachable", async () => {
    await mount({
      accounts: [account("account-a1", "ada@example.test")],
      threads: () => {
        throw new Error("503");
      },
    });

    expect(rowTexts().some((text) => text.includes("Couldn't reach ada@example.test"))).toBe(
      true,
    );
    // One row, not an empty state beside it.
    expect(host.textContent).not.toContain("Inbox is quiet");
  });

  /** THE SERVICE ITSELF, not one stream.
   *
   *  `loadAccounts` is the call that decides whether this block exists, so a
   *  503 from it used to leave whatever was on screen standing: no block on a
   *  fresh tab, and hours-old rows with no signal on a returning one. The spec
   *  asks for one row per account, by name. */
  describe("the mail service being down", () => {
    const SNAPSHOT_KEY = "brain-hub-mail-v2";

    function remember(over: Record<string, unknown> = {}) {
      sessionStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({
          people: [
            {
              accountId: "account-a1",
              threadId: "t-cached",
              sender: "Ada",
              subject: "Yesterday",
              at: NOW.getTime() - 3_600_000,
            },
          ],
          notifications: 0,
          newsletters: 0,
          unreachable: [],
          accounts: ["ada@example.test"],
          ...over,
        }),
      );
    }

    it("names every account this tab knows about when the accounts call 503s", async () => {
      remember();
      await mount({ accountsFail: true });

      expect(host.querySelector("[data-hub-mail]")).not.toBeNull();
      expect(
        rowTexts().some((text) => text.includes("Couldn't reach ada@example.test")),
      ).toBe(true);
    });

    it("keeps the cached rows beside the signal rather than blanking them", async () => {
      remember();
      await mount({ accountsFail: true });

      // Stale rows are useful; stale rows with nothing saying so are not.
      expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(1);
      expect(host.querySelectorAll("[data-hub-mail-unreachable]")).toHaveLength(1);
      expect(host.textContent).not.toContain("Inbox is quiet");
    });

    it("draws no block at all when it has never had an answer", async () => {
      // Nothing here knows whether a mailbox exists, so naming one would
      // invent it and claiming none would delete it. Silence is the honest
      // answer, and it is the same one "no account connected" gets.
      await mount({ accountsFail: true });

      expect(host.querySelector("[data-hub-mail]")).toBeNull();
      expect(host.textContent).toBe("");
    });

    it("turns a block that was ready into the signal when the next read 503s", async () => {
      const a = account("account-a1", "ada@example.test");
      const stub: Stub = {
        accounts: [a],
        threads: () => page([thread({ accountId: a.accountId })]),
      };
      await mount(stub);
      expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(1);
      expect(host.querySelectorAll("[data-hub-mail-unreachable]")).toHaveLength(0);

      stub.accountsFail = true;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();

      expect(
        rowTexts().some((text) => text.includes("Couldn't reach ada@example.test")),
      ).toBe(true);
      expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(1);
    });
  });

  describe("the snapshot and the revalidation", () => {
    it("paints this session's last answer before the network says anything", async () => {
      const a = account("account-a1", "ada@example.test");
      let release!: () => void;
      const held = new Promise<MailThreadPage>((resolve) => {
        release = () => resolve(page([thread({ accountId: a.accountId })]));
      });
      sessionStorage.setItem(
        "brain-hub-mail-v2",
        JSON.stringify({
          people: [
            {
              accountId: "account-a1",
              threadId: "t-cached",
              sender: "Ada",
              subject: "Yesterday",
              at: NOW.getTime() - 3_600_000,
            },
          ],
          notifications: 0,
          newsletters: 0,
          unreachable: [],
          accounts: ["ada@example.test"],
        }),
      );

      await mount({ accounts: [a], threads: () => held });

      // The cached row, not a skeleton: walking back to Home draws the block
      // it drew a moment ago.
      expect(host.querySelector("[data-hub-mail-pending]")).toBeNull();
      expect(
        host.querySelector("[data-hub-mail-person]")?.getAttribute("data-hub-mail-person"),
      ).toBe("t-cached");

      release();
      await settle();
      // And the answer replaces it when it lands.
      expect(
        host.querySelector("[data-hub-mail-person]")?.getAttribute("data-hub-mail-person"),
      ).toBe("t1");
    });

    it("writes the snapshot the next mount reads", async () => {
      const a = account("account-a1", "ada@example.test");
      await mount({
        accounts: [a],
        threads: () => page([thread({ accountId: a.accountId })]),
      });

      const stored = JSON.parse(
        sessionStorage.getItem("brain-hub-mail-v2") ?? "null",
      ) as { people: unknown[]; accounts: string[] } | null;
      expect(stored?.people).toHaveLength(1);
      expect(stored?.accounts).toEqual(["ada@example.test"]);
    });

    it("re-asks when the tab becomes visible again", async () => {
      const a = account("account-a1", "ada@example.test");
      let answers = 0;
      const stub: Stub = {
        accounts: [a],
        threads: () => {
          answers += 1;
          return page(
            Array.from({ length: answers }, () =>
              thread({ accountId: a.accountId }),
            ),
          );
        },
      };
      await mount(stub);
      expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(1);

      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();

      expect(answers).toBe(2);
      expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(2);
    });
  });

  it("renders Today and Changes immediately while mail is still loading", async () => {
    // THE DASHBOARD NEVER WAITS FOR MAIL. The block is its own subtree with
    // its own pending state, so a stream that never answers cannot keep the
    // rest of Home off the screen.
    const a = account("account-a1", "ada@example.test");
    let release!: () => void;
    const held = new Promise<MailThreadPage>((resolve) => {
      release = () => resolve(page([thread({ accountId: a.accountId })]));
    });

    await act(async () => {
      root.render(
        <div>
          <p data-sibling>Today</p>
          <HubMail
            onOpenMail={() => opened.push("mail")}
            client={client({ accounts: [a], threads: () => held })}
          />
        </div>,
      );
    });
    await settle();

    // Mail has not answered, and the rest of the page is already there.
    expect(host.querySelector("[data-sibling]")?.textContent).toBe("Today");
    expect(host.querySelector("[data-hub-mail-pending]")).not.toBeNull();
    expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(0);

    release();
    await settle();
    expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(1);
  });

  it("reports 50+ honestly at the derivation's limit", async () => {
    const a = account("account-a1", "ada@example.test");
    await mount({
      accounts: [a],
      threads: () =>
        page(
          Array.from({ length: 50 }, () =>
            thread({ accountId: a.accountId, category: "newsletter" }),
          ),
        ),
    });

    expect(host.querySelector("[data-hub-mail-digest]")?.textContent).toContain(
      "50+ newsletters",
    );
  });

  it("offers no mail action on the dashboard", async () => {
    const a = account("account-a1", "ada@example.test");
    await mount({
      accounts: [a],
      threads: () => page([thread({ accountId: a.accountId })]),
    });

    // Done carries its own undo machinery and belongs in the column. Every
    // control in this block is a way INTO mail and nothing else.
    const row = host.querySelector<HTMLElement>("[data-hub-mail-person]");
    expect(row?.querySelectorAll("button")).toHaveLength(0);
    await act(async () => row?.click());
    expect(opened).toEqual(["mail"]);
  });
});
