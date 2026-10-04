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

import {
  MAIL_CHANGED_EVENT,
  MAIL_EVENT_DEBOUNCE_MS,
} from "@/lib/mail/mail-events";
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
  /** The accounts call itself, for a case that holds it or fails it by turn.
   *  It wins over `accounts` and `accountsFail`. */
  loadAccounts?: () => Promise<PublicMailAccount[]>;
  threads?: (accountId: string) => MailThreadPage | Promise<MailThreadPage>;
}

function client(stub: Stub) {
  return {
    loadAccounts: async () => {
      if (stub.loadAccounts) return stub.loadAccounts();
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

  describe("the mail events", () => {
    const EVENT_ACCOUNT = `account-a${"0".repeat(32)}`;

    function mailEvent(detail: unknown) {
      window.dispatchEvent(new CustomEvent(MAIL_CHANGED_EVENT, { detail }));
    }

    function synced(mailboxIds: string[] = ["inbox"]) {
      return { kind: "mail", changeKind: "sync", accountId: EVENT_ACCOUNT, mailboxIds };
    }

    /** One more row per answer, so the block shows how many times it read.
     *  `asks` counts the accounts call, which is where every read starts: a
     *  read that is dropped before it lists a thread still asked the mail
     *  service a question, and counting the lists alone cannot see it. */
    function countingStub(): { stub: Stub; asks: () => number; answers: () => number } {
      const a = account("account-a1", "ada@example.test");
      let asks = 0;
      let answers = 0;
      return {
        stub: {
          loadAccounts: async () => {
            asks += 1;
            return [a];
          },
          threads: () => {
            answers += 1;
            return page(
              Array.from({ length: answers }, () => thread({ accountId: a.accountId })),
            );
          },
        },
        asks: () => asks,
        answers: () => answers,
      };
    }

    async function pass(ms: number) {
      await act(async () => vi.advanceTimersByTime(ms));
      await settle();
    }

    beforeEach(() => {
      // The debounce is a timer, so these cases fake it beside the clock.
      vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
    });

    it("reads again once for a burst of events about an inbox", async () => {
      const { stub, asks, answers } = countingStub();
      await mount(stub);
      expect(asks()).toBe(1);
      expect(answers()).toBe(1);

      await act(async () => {
        mailEvent(synced());
        mailEvent({ ...synced(["inbox", "all"]), changeKind: "mutation" });
        mailEvent(synced());
      });
      await pass(MAIL_EVENT_DEBOUNCE_MS - 1);
      // Still inside the burst's quiet window: nothing has been asked.
      expect(asks()).toBe(1);

      await pass(1);
      // One read for the three of them, counted where a read starts.
      expect(asks()).toBe(2);
      expect(answers()).toBe(2);
      expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(2);
    });

    it("reads again on a reset, which names no account", async () => {
      const { stub, asks } = countingStub();
      await mount(stub);

      await act(async () => mailEvent({ kind: "mail", changeKind: "reset" }));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(asks()).toBe(2);
    });

    it("lets pass what cannot change the block", async () => {
      const { stub, asks } = countingStub();
      await mount(stub);

      await act(async () => {
        // A body arriving changes no row, a change that names no Inbox changes
        // no unread Inbox letter, and a malformed event is not an event.
        mailEvent({
          ...synced(),
          changeKind: "content_ready",
          messageIds: ["message-1"],
        });
        mailEvent(synced(["sent"]));
        mailEvent(synced(["all"]));
        mailEvent(synced(["starred"]));
        mailEvent(synced([]));
        mailEvent({ ...synced(), accountId: "nope" });
        mailEvent({ ...synced(), kind: "page" });
        mailEvent({ ...synced(), mailboxIds: "inbox" });
        mailEvent({ kind: "mail", changeKind: "sync" });
        mailEvent("reset");
        mailEvent(null);
      });
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(asks()).toBe(1);
    });

    it("lets an event pass in a hidden tab, which reads on the way back anyway", async () => {
      const { stub, asks } = countingStub();
      await mount(stub);

      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("hidden");
      expect(document.visibilityState).toBe("hidden");
      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(asks()).toBe(1);
      visibility.mockRestore();
    });

    it("does not read for a timer that was armed before the tab hid", async () => {
      // The event arrived in a visible tab and the tab was hidden inside the
      // debounce. Coming back reads the block anyway, so the armed read is a
      // question nobody is there to see the answer to.
      const { stub, asks } = countingStub();
      await mount(stub);

      await act(async () => mailEvent(synced()));
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("hidden");
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      visibility.mockRestore();
      expect(asks()).toBe(1);
    });

    it("asks nothing once Home is gone, and leaves no listener or timer behind", async () => {
      const { stub, asks } = countingStub();
      const added = vi.spyOn(window, "addEventListener");
      const removed = vi.spyOn(window, "removeEventListener");
      await mount(stub);
      const timersAtRest = vi.getTimerCount();

      await act(async () => mailEvent(synced()));
      expect(vi.getTimerCount()).toBe(timersAtRest + 1);
      await act(async () => root.render(null));
      // The armed read went with the block.
      expect(vi.getTimerCount()).toBe(timersAtRest);
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(asks()).toBe(1);

      // And an event after the unmount finds no listener.
      const listeners = (spy: typeof added) =>
        spy.mock.calls.filter(([type]) => type === MAIL_CHANGED_EVENT).length;
      expect(listeners(added)).toBeGreaterThan(0);
      expect(listeners(removed)).toBe(listeners(added));
      const timersAfter = vi.getTimerCount();
      await act(async () => mailEvent(synced()));
      expect(vi.getTimerCount()).toBe(timersAfter);
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(asks()).toBe(1);
      added.mockRestore();
      removed.mockRestore();
    });

    it("lands the older read when the newer one fails", async () => {
      // The guard used to compare a read with the one STARTED last, so an
      // answer was dropped the moment another read began, whether or not that
      // one ever landed. Here the second accounts call fails: the first read's
      // rows were thrown away and the block stayed a skeleton.
      const a = account("account-a1", "ada@example.test");
      let asks = 0;
      const held: ((value: MailThreadPage) => void)[] = [];
      await mount({
        loadAccounts: async () => {
          asks += 1;
          if (asks >= 2) throw new Error("mail unavailable");
          return [a];
        },
        threads: () => new Promise<MailThreadPage>((resolve) => held.push(resolve)),
      });
      expect(host.querySelector("[data-hub-mail-pending]")).not.toBeNull();

      // The tab is looked at again while the first read is still out.
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();
      expect(asks).toBe(2);

      await act(async () =>
        held[0](page([thread({ accountId: a.accountId, threadId: "first" })])),
      );
      await settle();
      expect(host.querySelector("[data-hub-mail-pending]")).toBeNull();
      expect(
        host.querySelector("[data-hub-mail-person]")?.getAttribute("data-hub-mail-person"),
      ).toBe("first");
    });

    it("lands the older read when the newer one fails, through a mail event too", async () => {
      const a = account("account-a1", "ada@example.test");
      let asks = 0;
      const held: ((value: MailThreadPage) => void)[] = [];
      await mount({
        loadAccounts: async () => {
          asks += 1;
          if (asks >= 2) throw new Error("mail unavailable");
          return [a];
        },
        threads: () => new Promise<MailThreadPage>((resolve) => held.push(resolve)),
      });

      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(asks).toBe(2);

      await act(async () =>
        held[0](page([thread({ accountId: a.accountId, threadId: "first" })])),
      );
      await settle();
      expect(host.querySelector("[data-hub-mail-pending]")).toBeNull();
      expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(1);
    });

    it("lets an answer land under events that arrive faster than a read takes", async () => {
      // A mailbox syncing in batches: an Inbox event every 500ms, a read that
      // takes 900. Each read was superseded before it answered, so none of
      // them ever wrote and the block stayed a skeleton for as long as the
      // sync ran.
      const a = account("account-a1", "ada@example.test");
      let reads = 0;
      await mount({
        accounts: [a],
        threads: () => {
          reads += 1;
          return new Promise<MailThreadPage>((resolve) =>
            setTimeout(() => resolve(page([thread({ accountId: a.accountId })])), 900),
          );
        },
      });
      expect(host.querySelector("[data-hub-mail-pending]")).not.toBeNull();

      for (let beat = 0; beat < 6; beat += 1) {
        await act(async () => mailEvent(synced()));
        await pass(500);
      }
      expect(reads).toBeGreaterThan(2);
      expect(host.querySelector("[data-hub-mail-pending]")).toBeNull();
      expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(1);
    });

    it("lets no older read speak once a newer one has landed", async () => {
      // The other two places an older read could still write: its accounts
      // call answering late with no account, which deletes the block, and
      // failing late, which marks every mailbox unreachable.
      const a = account("account-a1", "ada@example.test");
      for (const late of ["empty", "failed"] as const) {
        let settleFirst!: () => void;
        let asks = 0;
        await mount({
          loadAccounts: () => {
            asks += 1;
            if (asks > 1) return Promise.resolve([a]);
            return new Promise<PublicMailAccount[]>((resolve, reject) => {
              settleFirst = () =>
                late === "empty" ? resolve([]) : reject(new Error("mail unavailable"));
            });
          },
          threads: () => page([thread({ accountId: a.accountId, threadId: "newer" })]),
        });
        await act(async () => mailEvent(synced()));
        await pass(MAIL_EVENT_DEBOUNCE_MS);
        expect(asks).toBe(2);
        expect(host.querySelectorAll("[data-hub-mail-person]")).toHaveLength(1);

        await act(async () => settleFirst());
        await settle();
        expect(host.querySelector("[data-hub-mail]"), late).not.toBeNull();
        expect(host.querySelectorAll("[data-hub-mail-person]"), late).toHaveLength(1);
        expect(host.querySelector("[data-hub-mail-unreachable]"), late).toBeNull();
        expect(sessionStorage.getItem("brain-hub-mail-v2"), late).toContain("newer");

        await act(async () => root.render(null));
        sessionStorage.clear();
      }
    });

    it("keeps the newer read when an older one answers after it", async () => {
      // Events make reads frequent enough to overlap, and a slow first answer
      // landing last would put back the rows the second one had replaced.
      const a = account("account-a1", "ada@example.test");
      const held: ((value: MailThreadPage) => void)[] = [];
      await mount({
        accounts: [a],
        threads: () => new Promise<MailThreadPage>((resolve) => held.push(resolve)),
      });
      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(held).toHaveLength(2);

      await act(async () =>
        held[1](page([thread({ accountId: a.accountId, threadId: "newer" })])),
      );
      await settle();
      await act(async () =>
        held[0](page([thread({ accountId: a.accountId, threadId: "older" })])),
      );
      await settle();

      expect(
        [...host.querySelectorAll("[data-hub-mail-person]")].map((row) =>
          row.getAttribute("data-hub-mail-person"),
        ),
      ).toEqual(["newer"]);
      // Nor does the dropped answer reach the snapshot the next mount paints.
      expect(sessionStorage.getItem("brain-hub-mail-v2")).toContain("newer");
      expect(sessionStorage.getItem("brain-hub-mail-v2")).not.toContain("older");
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
