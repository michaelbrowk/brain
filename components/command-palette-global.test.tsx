// @vitest-environment jsdom

// The two groups that make the palette a global search: Mail, fetched from
// `POST /api/mail/search/all`, and Tasks, ranked from the records the shell
// already holds. Each group loads, fails and expands on its own.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIL_CHANGED_EVENT,
  MAIL_EVENT_DEBOUNCE_MS,
} from "@/lib/mail/mail-events";
import type {
  MailMailboxUnavailableReason,
  MailSearchAllAccountStatus,
} from "@/lib/mail/message-types";
import type { TaskView } from "@/lib/tasks/model";
import type { TreeNode } from "@/lib/store/types";
import {
  CommandPalette,
  mailUnsearchedLine,
  rankTasks,
  type CommandPaletteSelection,
} from "./command-palette";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";
const OWN_ADDRESS = "person@example.test";
const TODAY = "2026-09-28";

function node(title = "Quarterly planning page"): TreeNode {
  const timestamp = "2026-07-29T08:00:00.000Z";
  return {
    id: "page",
    parentId: null,
    title,
    order: "a",
    created: timestamp,
    updated: timestamp,
    hasChildren: false,
    children: [],
  };
}

function thread(
  threadId: string,
  subject: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    accountId: ACCOUNT_ID,
    threadId,
    subject,
    participants: [
      { name: "Personal", address: OWN_ADDRESS },
      { name: "Ben Johnson", address: "ben@example.test" },
    ],
    snippet: "Cached quarterly preview match",
    lastMessageAt: Date.now(),
    messageCount: 2,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 1200,
    category: "people",
    ...overrides,
  };
}

const SEARCHED_ACCOUNT: MailSearchAllAccountStatus = {
  accountId: ACCOUNT_ID,
  emailAddress: OWN_ADDRESS,
  mailboxId: "all",
  availability: {
    status: "available",
    lastSuccessfulAt: 1_700_000_000_000,
    windowTruncated: false,
  },
  indexStatus: "ready",
  resultsTruncated: false,
};

function mailBody(threads: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 1,
    threads,
    accounts: [SEARCHED_ACCOUNT],
    indexBuilding: false,
    truncated: false,
    ...overrides,
  };
}

/** An account the search could not read: the route still answers 200 for it,
 *  with no rows and the cache's own reason. `resultsTruncated` is true because
 *  the codec holds the service to it (`validateMailSearchThreadPage`): a page
 *  from an unreadable mailbox is by definition short of the whole. */
function unsearchedAccount(
  accountId: string,
  emailAddress: string,
  reason: MailMailboxUnavailableReason,
): MailSearchAllAccountStatus {
  return {
    accountId,
    emailAddress,
    mailboxId: "inbox",
    availability: {
      status: "unavailable",
      reason,
      lastSuccessfulAt: null,
      windowTruncated: null,
    },
    indexStatus: "ready",
    resultsTruncated: true,
  };
}

/** An account whose index has not reached every thread yet. The same codec
 *  rule: a building index always answers `resultsTruncated`. */
const INDEXING_ACCOUNT: MailSearchAllAccountStatus = {
  ...SEARCHED_ACCOUNT,
  indexStatus: "building",
  resultsTruncated: true,
};

/** The route's answer when some account is short of the whole, folded the way
 *  the route folds it: `indexBuilding` from the accounts, `truncated` set. */
function shortBody(threads: unknown[], accounts: MailSearchAllAccountStatus[]) {
  return mailBody(threads, {
    accounts,
    indexBuilding: accounts.some(
      (account) => "indexStatus" in account && account.indexStatus === "building",
    ),
    truncated: true,
  });
}

const EVENT_ACCOUNT = `account-a${"0".repeat(32)}`;

function mailEvent(detail: unknown) {
  window.dispatchEvent(new CustomEvent(MAIL_CHANGED_EVENT, { detail }));
}

function synced(mailboxIds: string[] = ["inbox"]) {
  return { kind: "mail", changeKind: "sync", accountId: EVENT_ACCOUNT, mailboxIds };
}

function task(id: string, title: string, overrides: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title,
    created: "2026-09-20T08:00:00.000Z",
    updated: "2026-09-20T08:00:00.000Z",
    done: false,
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function group(heading: string): HTMLElement | null {
  return (
    ([...document.body.querySelectorAll("[cmdk-group]")].find(
      (candidate) =>
        candidate.querySelector("[cmdk-group-heading]")?.textContent === heading,
    ) as HTMLElement | undefined) ?? null
  );
}

function rows(heading: string): HTMLElement[] {
  return [...(group(heading)?.querySelectorAll("[cmdk-item]") ?? [])] as HTMLElement[];
}

function item(text: string): HTMLElement {
  const found = [...document.body.querySelectorAll("[cmdk-item]")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`no palette row containing ${JSON.stringify(text)}`);
  return found as HTMLElement;
}

function mailRequests() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([input]) => String(input) === "/api/mail/search/all");
}

describe("CommandPalette global search", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn<(value: CommandPaletteSelection) => void>>;
  let mailAnswer: () => Promise<Response>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    onSelect = vi.fn();
    mailAnswer = async () =>
      response(mailBody([thread("thread-1", "Quarterly launch review")]));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/search?")) return response({ hits: [] });
        if (url === "/api/mail/search/all") return mailAnswer();
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState({}, "", "/");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(
    props: Partial<Parameters<typeof CommandPalette>[0]> = {},
  ) {
    await act(async () =>
      root.render(
        <CommandPalette
          open
          onOpenChange={vi.fn()}
          tree={[]}
          onSelect={onSelect}
          hasCurrent={false}
          searchMail
          tasks={[]}
          today={TODAY}
          {...props}
        />,
      ),
    );
  }

  async function type(value: string) {
    const input = document.body.querySelector(
      'input[aria-label="Search pages, mail and tasks"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(200));
    await settle();
    return input;
  }

  it("asks every account once and draws the mail rows from the answer", async () => {
    await render({ tree: [node()] });
    await type("quarterly");

    expect(mailRequests()).toHaveLength(1);
    const [, init] = mailRequests()[0] as [RequestInfo, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({ query: "quarterly", limit: 20 });

    const mail = rows("Mail");
    expect(mail).toHaveLength(1);
    const row = mail[0];
    // The subject carries the highlight and the unread weight.
    const subject = row.querySelector("mark");
    expect(subject?.textContent).toBe("Quarterly");
    expect(subject?.closest("span")?.className).toContain("font-semibold");
    // The meta is the correspondent, never the account's own address, and a
    // same-day date reads as Today plus the clock.
    expect(row.textContent).toContain("Ben Johnson");
    expect(row.textContent).not.toContain("Personal");
    expect(row.textContent).toMatch(/Today \d/);
    expect(row.textContent).toContain("Cached quarterly preview match");
    // Pages stand above Mail.
    const headings = [...document.body.querySelectorAll("[cmdk-group-heading]")].map(
      (heading) => heading.textContent,
    );
    expect(headings.indexOf("Pages")).toBeLessThan(headings.indexOf("Mail"));
  });

  it("names a subjectless thread and says when the index is still building", async () => {
    mailAnswer = async () =>
      response(
        shortBody([thread("thread-1", null, { unread: false })], [INDEXING_ACCOUNT]),
      );
    await render();
    await type("quarterly");

    expect(rows("Mail")[0].textContent).toContain("(no subject)");
    expect(rows("Mail")[0].querySelector(".font-semibold")).toBeNull();
    expect(group("Mail")?.textContent).toContain("Older mail is still being indexed");
  });

  it("says the index is still building when it has no row to stand above", async () => {
    // The line used to ride on the rows, so an index that had not reached the
    // match yet answered a bare "No results" for a letter that exists.
    mailAnswer = async () => response(shortBody([], [INDEXING_ACCOUNT]));
    await render();
    await type("quarterly");

    expect(rows("Mail")).toHaveLength(0);
    expect(group("Mail")?.textContent).toContain("Older mail is still being indexed");
    expect(document.body.textContent).not.toContain("No results for");
  });

  it("names the mailbox that could not be searched instead of claiming no results", async () => {
    // For a few minutes after the mail service restarts an account answers
    // `unavailable` and no rows, which read as "nothing matched".
    mailAnswer = async () =>
      response(
        shortBody(
          [],
          [unsearchedAccount(ACCOUNT_ID, "design@example.test", "global_syncing")],
        ),
      );
    await render();
    await type("quarterly");

    expect(rows("Mail")).toHaveLength(0);
    const note = group("Mail")?.querySelector('[role="status"]');
    expect(note?.textContent).toBe(
      "design@example.test is still syncing. Some letters may be missing.",
    );
    // It arrives after the rest of the panel, so it is announced, and without
    // interrupting what is being read.
    expect(note?.getAttribute("aria-live")).toBe("polite");
    // An address is one unbreakable word and the sheet is 320 wide at its
    // narrowest, and with no row under it the line closes the group.
    expect(note?.classList.contains("break-words")).toBe(true);
    expect(note?.classList.contains("pb-2")).toBe(true);
    expect(document.body.textContent).not.toContain("No results for");
  });

  it("keeps the line above the rows another account answered, and drops it on the next answer", async () => {
    mailAnswer = async () =>
      response(
        // Both gaps at once still read as one line: the mailbox that was
        // not searched says more than the index that is not finished.
        shortBody(
          [thread("thread-1", "Quarterly launch review")],
          [
            INDEXING_ACCOUNT,
            unsearchedAccount("account-b", "design@example.test", "mailbox_syncing"),
          ],
        ),
      );
    await render();
    await type("quarterly");

    expect(rows("Mail")).toHaveLength(1);
    const statuses = [...(group("Mail")?.querySelectorAll('[role="status"]') ?? [])];
    expect(statuses.map((status) => status.textContent)).toEqual([
      "design@example.test is still syncing. Some letters may be missing.",
    ]);
    // A row under it gives the line its foot, so it takes no padding of its own.
    expect(statuses[0].classList.contains("pb-2")).toBe(false);

    // The line belongs to the answer it came with. The next ask finds the
    // mailbox synced, and nothing of the line is left.
    mailAnswer = async () =>
      response(mailBody([thread("thread-1", "Quarterly launch review")]));
    await type("quarterly launch");
    expect(rows("Mail")).toHaveLength(1);
    expect(group("Mail")?.textContent).not.toContain("still syncing");
    expect(group("Mail")?.querySelector('[role="status"]')).toBeNull();
  });

  it("words the line by why each mailbox was left out", () => {
    expect(mailUnsearchedLine([SEARCHED_ACCOUNT])).toBeNull();
    expect(
      mailUnsearchedLine([
        unsearchedAccount("a", "a@example.test", "mailbox_reauth_required"),
      ]),
    ).toBe("a@example.test needs to be reconnected. Some letters may be missing.");
    for (const reason of ["mailbox_backoff", "mailbox_cache_capacity"] as const) {
      expect(
        mailUnsearchedLine([unsearchedAccount("a", "a@example.test", reason)]),
        reason,
      ).toBe("a@example.test could not be searched. Some letters may be missing.");
    }
    expect(
      mailUnsearchedLine([
        unsearchedAccount("a", "a@example.test", "mailbox_reauth_required"),
        unsearchedAccount("b", "b@example.test", "mailbox_reauth_required"),
      ]),
    ).toBe(
      "a@example.test and b@example.test need to be reconnected. Some letters may be missing.",
    );
    // An account whose search threw carries words instead of a page.
    expect(
      mailUnsearchedLine([
        {
          accountId: "a",
          emailAddress: "a@example.test",
          error: "this account needs to be reconnected",
          reason: "mail_account_reauth_required",
        },
      ]),
    ).toBe("a@example.test needs to be reconnected. Some letters may be missing.");
    expect(
      mailUnsearchedLine([
        SEARCHED_ACCOUNT,
        unsearchedAccount("a", "a@example.test", "mailbox_uninitialized"),
        unsearchedAccount("b", "b@example.test", "history_mismatch"),
      ]),
    ).toBe(
      "a@example.test and b@example.test are still syncing. Some letters may be missing.",
    );
    // Mixed reasons share the one thing true of all of them, and a long run
    // of addresses is counted rather than listed.
    expect(
      mailUnsearchedLine([
        unsearchedAccount("a", "a@example.test", "global_syncing"),
        unsearchedAccount("b", "b@example.test", "mailbox_reauth_required"),
        unsearchedAccount("c", "c@example.test", "mailbox_cache_capacity"),
      ]),
    ).toBe(
      "a@example.test and 2 more could not be searched. Some letters may be missing.",
    );
  });

  it("holds the line back while the panel-wide Searching stands, and for an answer the query has left", async () => {
    const syncing = () =>
      response(
        shortBody(
          [thread("thread-1", "Quarterly launch review")],
          [
            SEARCHED_ACCOUNT,
            unsearchedAccount("account-b", "design@example.test", "global_syncing"),
          ],
        ),
      );
    let releasePages!: () => void;
    const pages = new Promise<Response>((resolve) => {
      releasePages = () => resolve(response({ hits: [] }));
    });
    const pendingMail: ((value: Response) => void)[] = [];
    let mailHeld = false;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/search?")) return mailHeld ? response({ hits: [] }) : pages;
      if (url === "/api/mail/search/all") {
        if (!mailHeld) return syncing();
        return new Promise<Response>((resolve) => pendingMail.push(resolve));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await render();
    await type("quarterly");

    // Mail has answered and the pages have not: one status line at a time,
    // and it is the panel's.
    const statuses = () =>
      [...document.body.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    expect(statuses()).toEqual(["Searching…"]);

    await act(async () => releasePages());
    await settle();
    expect(statuses()).toEqual([
      "design@example.test is still syncing. Some letters may be missing.",
    ]);

    // The query moves on and its answer is still out. The line was about the
    // answer the reader has left, and goes with its rows.
    mailHeld = true;
    await type("quarterly launch");
    expect(pendingMail).toHaveLength(1);
    expect(statuses()).toEqual(["Searching…"]);
    expect(document.body.textContent).not.toContain("still syncing");
  });

  describe("the line follows the mail events", () => {
    const syncingBody = () =>
      shortBody(
        [thread("thread-1", "Quarterly launch review")],
        [
          SEARCHED_ACCOUNT,
          unsearchedAccount("account-b", "design@example.test", "global_syncing"),
        ],
      );
    const wholeBody = () =>
      mailBody([
        thread("thread-1", "Quarterly launch review"),
        thread("thread-2", "Quarterly design sync"),
      ]);
    const noteText = () => group("Mail")?.querySelector('[role="status"]')?.textContent ?? null;

    async function pass(ms: number) {
      await act(async () => vi.advanceTimersByTime(ms));
      await settle();
    }

    it("asks the same query again a debounce after a sync, and drops the line on a whole answer", async () => {
      // The palette asked once per query, so a mailbox that finished syncing
      // while the reader looked at the line never took the line away.
      mailAnswer = async () => response(syncingBody());
      await render();
      await type("quarterly");
      expect(mailRequests()).toHaveLength(1);
      expect(noteText()).toContain("still syncing");

      let release!: () => void;
      mailAnswer = () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(response(wholeBody()));
        });
      await act(async () => {
        mailEvent(synced());
        mailEvent(synced(["all"]));
      });
      await pass(MAIL_EVENT_DEBOUNCE_MS - 1);
      expect(mailRequests()).toHaveLength(1);
      await pass(1);
      // One ask for the burst, of the query on screen.
      expect(mailRequests()).toHaveLength(2);
      const [, init] = mailRequests()[1] as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ query: "quarterly", limit: 20 });
      // While it is out the answer on screen stays: no Searching, no lost row.
      expect(rows("Mail")).toHaveLength(1);
      expect(noteText()).toContain("still syncing");

      await act(async () => release());
      await settle();
      expect(rows("Mail")).toHaveLength(2);
      expect(noteText()).toBeNull();

      // A whole answer has nothing to wait for, so an event asks nothing.
      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(mailRequests()).toHaveLength(2);
    });

    it("asks again on a reset under the still-indexing line", async () => {
      mailAnswer = async () => response(shortBody([], [INDEXING_ACCOUNT]));
      await render();
      await type("quarterly");
      expect(noteText()).toBe("Older mail is still being indexed");

      mailAnswer = async () => response(wholeBody());
      await act(async () => mailEvent({ kind: "mail", changeKind: "reset" }));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(mailRequests()).toHaveLength(2);
      expect(rows("Mail")).toHaveLength(2);
      expect(noteText()).toBeNull();
    });

    it("lets pass what says nothing about a sync, and everything in a hidden tab", async () => {
      mailAnswer = async () => response(syncingBody());
      await render();
      await type("quarterly");

      await act(async () => {
        // A mark-read or an archive and a body becoming ready finish no sync.
        mailEvent({ ...synced(), changeKind: "mutation" });
        mailEvent({ ...synced(), changeKind: "content_ready", messageIds: ["message-1"] });
        mailEvent({ kind: "mail", changeKind: "sync" });
        mailEvent(null);
      });
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(mailRequests()).toHaveLength(1);

      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("hidden");
      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      visibility.mockRestore();
      expect(mailRequests()).toHaveLength(1);

      // Armed while visible, hidden inside the debounce: not asked either.
      await act(async () => mailEvent(synced()));
      const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      hidden.mockRestore();
      expect(mailRequests()).toHaveLength(1);
    });

    it("keeps one ask out at a time, and asks once more for what arrived meanwhile", async () => {
      mailAnswer = async () => response(syncingBody());
      await render();
      await type("quarterly");

      const held: ((value: Response) => void)[] = [];
      mailAnswer = () => new Promise<Response>((resolve) => held.push(resolve));
      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(mailRequests()).toHaveLength(2);

      // Three more syncs while that ask is out: none of them asks beside it.
      for (let beat = 0; beat < 3; beat += 1) {
        await act(async () => mailEvent(synced()));
        await pass(MAIL_EVENT_DEBOUNCE_MS);
      }
      expect(mailRequests()).toHaveLength(2);

      // It lands still short, and the syncs it missed are one more ask.
      await act(async () => held[0](response(syncingBody())));
      await settle();
      expect(noteText()).toContain("still syncing");
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(mailRequests()).toHaveLength(3);
      await act(async () => held[1](response(wholeBody())));
      await settle();
      expect(noteText()).toBeNull();
    });

    it("keeps the answer on screen when the ask fails", async () => {
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      mailAnswer = async () => response(syncingBody());
      await render();
      await type("quarterly");

      mailAnswer = async () => response({ error: "boom" }, 500);
      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(mailRequests()).toHaveLength(2);
      // The reader did not ask for this read, so its failure is not theirs to
      // see: the rows and the line stand, and the next event asks again.
      expect(rows("Mail")).toHaveLength(1);
      expect(noteText()).toContain("still syncing");
      expect(document.body.textContent).not.toContain("Mail search failed");

      mailAnswer = async () => response(wholeBody());
      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(mailRequests()).toHaveLength(3);
      expect(noteText()).toBeNull();
      warnings.mockRestore();
    });

    it("drops an answer for a query the reader has left, and listens for nothing once closed", async () => {
      mailAnswer = async () => response(syncingBody());
      await render();
      await type("quarterly");

      let releaseStale!: () => void;
      let signal: AbortSignal | null | undefined;
      vi.mocked(fetch).mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.startsWith("/api/search?")) return response({ hits: [] });
          if (url === "/api/mail/search/all") {
            const { query } = JSON.parse(String(init?.body)) as { query: string };
            if (query === "quarterly") {
              signal = init?.signal;
              return new Promise<Response>((resolve) => {
                releaseStale = () => resolve(response(wholeBody()));
              });
            }
            return response(
              shortBody(
                [thread("thread-9", "Quarterly launch notes")],
                [
                  SEARCHED_ACCOUNT,
                  unsearchedAccount("account-b", "design@example.test", "global_syncing"),
                ],
              ),
            );
          }
          throw new Error(`unexpected fetch: ${url}`);
        },
      );
      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(signal?.aborted).toBe(false);

      await type("quarterly launch");
      expect(signal?.aborted).toBe(true);
      await act(async () => releaseStale());
      await settle();
      // The late answer for "quarterly" writes nothing over the new query's.
      expect(rows("Mail")).toHaveLength(1);
      expect(rows("Mail")[0].textContent).toContain("Quarterly launch notes");
      expect(noteText()).toContain("still syncing");

      const asked = mailRequests().length;
      const added = vi.spyOn(window, "addEventListener");
      const removed = vi.spyOn(window, "removeEventListener");
      await render({ open: false });
      await act(async () => mailEvent(synced()));
      await pass(MAIL_EVENT_DEBOUNCE_MS);
      expect(mailRequests()).toHaveLength(asked);
      expect(
        removed.mock.calls.filter(([type]) => type === MAIL_CHANGED_EVENT).length,
      ).toBeGreaterThan(
        added.mock.calls.filter(([type]) => type === MAIL_CHANGED_EVENT).length,
      );
      added.mockRestore();
      removed.mockRestore();
    });
  });

  it("reads a snippet's entities the way the mail list does", async () => {
    // Gmail sends snippets HTML-escaped. The list row decodes them through
    // `sanitizeSnippet`, and the palette row showed the same letter raw.
    mailAnswer = async () =>
      response(
        mailBody([
          thread("thread-1", "Quarterly launch review", {
            snippet: "[image] what&#39;s next &amp; more",
          }),
        ]),
      );
    await render();
    await type("next");

    const row = rows("Mail")[0];
    expect(row.textContent).toContain("what's next & more");
    expect(row.textContent).not.toContain("&#39;");
    expect(row.textContent).not.toContain("&amp;");
    expect(row.textContent).not.toContain("[image]");
    // The highlight runs over the decoded text, so the match still marks.
    expect(row.querySelector("mark")?.textContent).toBe("next");
  });

  it("ranks tasks by title with open ones first and labels each by its day", async () => {
    const tasks = [
      task("done", "Quarterly numbers", {
        done: true,
        when: TODAY,
        updated: "2026-09-27T08:00:00.000Z",
      }),
      task("inbox", "Send quarterly deck"),
      task("someday", "Quarterly retreat ideas", { when: "someday" }),
      task("evening", "Quarterly review call", { when: TODAY, evening: true }),
      task("tomorrow", "Quarterly recap", { when: "2026-09-29" }),
      task("dated", "Quarterly budget", { when: "2026-10-15" }),
      task("other", "Water the plants"),
    ];
    // Rank first among the open ones (a title that starts with the query
    // beats a word-boundary hit), ties by input order here since every
    // `updated` is equal, and the done one last however well it ranks.
    expect(rankTasks(tasks, "quarterly").map((entry) => entry.id)).toEqual([
      "someday",
      "evening",
      "tomorrow",
      "dated",
      "inbox",
      "done",
    ]);

    await render({ tasks, searchMail: false });
    await type("quarterly");

    // Six matches fold to five and a Show all; the sixth is the done one.
    expect(rows("Tasks")).toHaveLength(6);
    expect(rows("Tasks")[5].textContent).toContain("Show all 6");
    await act(async () => item("Show all 6").click());
    const labels = rows("Tasks").map((row) => row.textContent);
    expect(labels).toHaveLength(6);
    expect(labels[0]).toContain("Someday");
    expect(labels[1]).toContain("Today Evening");
    expect(labels[2]).toContain("Tomorrow");
    expect(labels[3]).toMatch(/Oct 15/);
    expect(labels[4]).toContain("Inbox");
    // Done last, struck through, and its mark drawn checked.
    const done = rows("Tasks")[5];
    expect(done.textContent).toContain("Done");
    expect(done.querySelector(".line-through")?.textContent).toContain("Quarterly numbers");
    expect(done.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    expect(rows("Tasks")[4].querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(rows("Tasks")[4].querySelector("mark")?.textContent).toBe("quarterly");
    expect(mailRequests()).toHaveLength(0);
  });

  it("shows five rows and a Show all that expands, then resets on a new query", async () => {
    const tasks = Array.from({ length: 7 }, (_, index) =>
      task(`t${index}`, `Quarterly task ${index}`),
    );
    mailAnswer = async () =>
      response(
        mailBody(
          Array.from({ length: 8 }, (_, index) =>
            thread(`thread-${index}`, `Quarterly letter ${index}`),
          ),
        ),
      );
    await render({ tasks });
    await type("quarterly");

    expect(rows("Mail")).toHaveLength(6);
    expect(rows("Mail")[5].textContent).toContain("Show all 8");
    expect(rows("Tasks")).toHaveLength(6);
    expect(rows("Tasks")[5].textContent).toContain("Show all 7");

    await act(async () => item("Show all 8").click());
    expect(rows("Mail")).toHaveLength(8);
    expect(rows("Mail").some((row) => row.textContent?.includes("Show all"))).toBe(false);
    // The other group keeps its own fold.
    expect(rows("Tasks")).toHaveLength(6);
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => item("Show all 7").click());
    expect(rows("Tasks")).toHaveLength(7);

    await type("quarterly l");
    expect(rows("Mail")).toHaveLength(6);
    expect(rows("Mail")[5].textContent).toContain("Show all 8");
  });

  it("keeps a failed mail search to its own group and retries only that group", async () => {
    mailAnswer = async () => response({ error: "boom" }, 503);
    await render({ tree: [node()] });
    await type("quarterly");

    expect(rows("Pages")).toHaveLength(1);
    const mail = group("Mail");
    expect(mail?.textContent).toContain("Mail search failed");
    expect(document.body.textContent).not.toContain("Search couldn't load");
    const pageSearches = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).startsWith("/api/search?")).length;

    mailAnswer = async () =>
      response(mailBody([thread("thread-1", "Quarterly launch review")]));
    await act(async () => item("Try again").click());
    await act(async () => vi.advanceTimersByTime(200));
    await settle();

    expect(mailRequests()).toHaveLength(2);
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith("/api/search?"))
        .length,
    ).toBe(pageSearches);
    expect(rows("Mail")[0].textContent).toContain("Quarterly launch review");
  });

  it("has no Mail group when the mail service is not running, and logs no error", async () => {
    // Brain runs without its mail container, and the route then answers 503
    // mail_service_unavailable for every query. That is an install without
    // mail, not an outage: a failure row under every search would be noise,
    // and a console error would raise the development overlay.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mailAnswer = async () =>
      response({ apiVersion: 1, error: { code: "mail_service_unavailable" } }, 503);
    await render({ tree: [node()] });
    await type("quarterly");

    expect(mailRequests()).toHaveLength(1);
    expect(group("Mail")).toBeNull();
    expect(document.body.textContent).not.toContain("Mail search failed");
    expect(rows("Pages")).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("reports a real failure without a console error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    mailAnswer = async () => response({ error: "boom" }, 500);
    await render({ tree: [node()] });
    await type("quarterly");

    expect(group("Mail")?.textContent).toContain("Mail search failed");
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalled();
    errors.mockRestore();
    warnings.mockRestore();
  });

  it("treats a paused module's 409 as no group at all", async () => {
    mailAnswer = async () => response({ error: "module_off" }, 409);
    await render({ tree: [node()] });
    await type("quarterly");

    expect(group("Mail")).toBeNull();
    expect(document.body.textContent).not.toContain("Mail search failed");
    expect(rows("Pages")).toHaveLength(1);
  });

  it("issues no mail request when Mail is off or a page filter is active", async () => {
    await render({ searchMail: false, tree: [node()] });
    await type("quarterly");
    expect(mailRequests()).toHaveLength(0);
    expect(group("Mail")).toBeNull();

    await render({ tree: [node()], tasks: [task("t", "Quarterly task")] });
    await type("tag:work quarterly");
    expect(mailRequests()).toHaveLength(0);
    expect(group("Mail")).toBeNull();
    expect(group("Tasks")).toBeNull();
  });

  it("returns the mail and task intents from a click, from Enter and from a phone tap", async () => {
    await render({ tasks: [task("t1", "Quarterly task")] });
    await type("quarterly");

    await act(async () => item("Quarterly launch review").click());
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "mail",
      accountId: ACCOUNT_ID,
      threadId: "thread-1",
      mailboxId: "all",
    });
    // A pick clears the query, as a close does, so the list is typed again.
    await type("quarterly");
    await act(async () => item("Quarterly task").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "task", id: "t1" });

    // With nothing above it, the mail row is the first item and Enter takes it.
    await render({ tasks: undefined });
    const input = await type("quarterly");
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "mail",
      accountId: ACCOUNT_ID,
      threadId: "thread-1",
      mailboxId: "all",
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ mobile: true, tasks: [task("t1", "Quarterly task")] });
    await type("quarterly");
    // The phone's sheet draws the same groups as the desktop panel.
    expect(group("Mail")).not.toBeNull();
    expect(group("Tasks")).not.toBeNull();
    await act(async () => item("Quarterly task").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "task", id: "t1" });
  });

  it("names on a mail pick the mailbox that account's search read", async () => {
    // Gmail searches All Mail and a server without one searches Inbox, and
    // Mail opens the letter where it was found: a letter archived long ago
    // is not in Inbox, and the Inbox read answers 404 for it.
    const OTHER_ID = "account-affffffffffffffffffffffffffffffff";
    const [allMail] = mailBody([]).accounts;
    mailAnswer = async () =>
      response(
        mailBody(
          [
            thread("thread-1", "Quarterly launch review"),
            thread("thread-2", "Quarterly office move", { accountId: OTHER_ID }),
          ],
          {
            accounts: [
              allMail,
              {
                ...allMail,
                accountId: OTHER_ID,
                emailAddress: "work@example.test",
                mailboxId: "inbox",
              },
            ],
          },
        ),
      );
    await render();
    await type("quarterly");

    await act(async () => item("Quarterly launch review").click());
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "mail",
      accountId: ACCOUNT_ID,
      threadId: "thread-1",
      mailboxId: "all",
    });
    await type("quarterly");
    await act(async () => item("Quarterly office move").click());
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "mail",
      accountId: OTHER_ID,
      threadId: "thread-2",
      mailboxId: "inbox",
    });

    // An answer that names no mailbox for the row's account leaves Inbox,
    // where every account has its new mail.
    mailAnswer = async () =>
      response(mailBody([thread("thread-1", "Quarterly launch review")], { accounts: [] }));
    await type("quarterly l");
    await act(async () => item("Quarterly launch review").click());
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "mail",
      accountId: ACCOUNT_ID,
      threadId: "thread-1",
      mailboxId: "inbox",
    });
  });

  it("names the route actions after the route they belong to, apart from the results", async () => {
    window.history.replaceState({}, "", "/tasks");
    await render({ onOpenTasks: vi.fn(), tasks: [task("t1", "Today review")] });
    expect(group("Tasks actions")?.textContent).toContain("Move to Today");
    expect(group("Tasks")).toBeNull();
    expect(group("Mail actions")).toBeNull();
    // A word both an action and a task answer to: both groups stand, under two
    // headings a reader can tell apart.
    await type("today");
    expect(group("Tasks actions")?.textContent).toContain("Move to Today");
    expect(group("Tasks")?.textContent).toContain("Today review");
  });

  it("asks nothing for a query the route would refuse, and hides the group on a refusal", async () => {
    await render({ tree: [node()] });
    // Punctuation only: no term for the index, so no request and no group.
    await type("..");
    expect(mailRequests()).toHaveLength(0);
    expect(group("Mail")).toBeNull();
    expect(document.body.textContent).not.toContain("Mail search failed");

    // A refusal the palette did not foresee is still not an outage to report.
    mailAnswer = async () =>
      response({ apiVersion: 1, error: { code: "invalid_query" } }, 400);
    await type("quarterly");
    expect(mailRequests()).toHaveLength(1);
    expect(group("Mail")).toBeNull();
    expect(document.body.textContent).not.toContain("Mail search failed");
    expect(rows("Pages")).toHaveLength(1);

    // A session that has lapsed is.
    mailAnswer = async () => response({ error: "unauthorized" }, 401);
    await type("quarterly launch");
    expect(group("Mail")?.textContent).toContain("Mail search failed");
  });

  it("keeps the cursor on the first revealed row after Show all", async () => {
    mailAnswer = async () =>
      response(
        mailBody(
          Array.from({ length: 8 }, (_, index) =>
            thread(`thread-${index}`, `Quarterly letter ${index}`),
          ),
        ),
      );
    await render();
    const input = await type("quarterly");
    const selected = () =>
      document.body.querySelector('[cmdk-item][aria-selected="true"]')?.textContent;
    // Nothing above the mail rows here, so End lands on Show all.
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    await settle();
    expect(selected()).toContain("Show all 8");

    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await settle();

    expect(rows("Mail")).toHaveLength(8);
    expect(selected()).toContain("Quarterly letter 5");
    // The arrows carry on from there.
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    await settle();
    expect(selected()).toContain("Quarterly letter 6");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows one status line at a time while both searches run", async () => {
    let releasePages!: () => void;
    const pages = new Promise<Response>((resolve) => {
      releasePages = () => resolve(response({ hits: [] }));
    });
    let releaseMail!: () => void;
    mailAnswer = () =>
      new Promise<Response>((resolve) => {
        releaseMail = () =>
          resolve(response(mailBody([thread("thread-1", "Quarterly launch review")])));
      });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/search?")) return pages;
      if (url === "/api/mail/search/all") return mailAnswer();
      throw new Error(`unexpected fetch: ${url}`);
    });
    await render();
    await type("quarterly");

    const statuses = () => [...document.body.querySelectorAll('[role="status"]')];
    expect(statuses()).toHaveLength(1);
    expect(group("Mail")).toBeNull();

    await act(async () => releasePages());
    await settle();
    // Pages are in; Mail is still searching, and says so in its own group.
    expect(statuses()).toHaveLength(1);
    expect(group("Mail")?.textContent).toContain("Searching");

    await act(async () => releaseMail());
    await settle();
    expect(statuses()).toHaveLength(0);
    expect(rows("Mail")).toHaveLength(1);
  });

  it("hides the task mark from assistive tech, the trailing word carrying the state", async () => {
    await render({ tasks: [task("t1", "Quarterly task", { done: true })], searchMail: false });
    await type("quarterly");
    const mark = rows("Tasks")[0].querySelector('[role="checkbox"]');
    expect(mark?.getAttribute("aria-checked")).toBe("true");
    expect(mark?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(rows("Tasks")[0].textContent).toContain("Done");
  });

  it("marks the matched letters of a title whose lower case is longer than it", async () => {
    // "İ" lowers to two code units, so an index found in the lowered copy
    // lands one character late in the original unless it is mapped back.
    await render({ tasks: [task("t1", "İstanbul trip")], searchMail: false });
    await type("stan");
    expect(rows("Tasks")[0].querySelector("mark")?.textContent).toBe("stan");

    await type("İst");
    expect(rows("Tasks")[0].querySelector("mark")?.textContent).toBe("İst");

    await type("sbl");
    const letters = [...rows("Tasks")[0].querySelectorAll("mark")].map(
      (mark) => mark.textContent,
    );
    expect(letters).toEqual(["s", "b", "l"]);
  });

  it("reads a mail answer for a query the reader has left as loading, never as rows", async () => {
    const pending = new Map<string, (value: Response) => void>();
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/search?")) return response({ hits: [] });
        if (url === "/api/mail/search/all") {
          const { query } = JSON.parse(String(init?.body)) as { query: string };
          return new Promise<Response>((resolve) => pending.set(query, resolve));
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    );
    await render();
    await type("quarterly");
    await type("quarterly launch");
    expect([...pending.keys()]).toEqual(["quarterly", "quarterly launch"]);

    // The older answer lands first, carrying a subject the newer one lacks.
    await act(async () =>
      pending.get("quarterly")!(
        response(mailBody([thread("thread-old", "Quarterly stale letter")])),
      ),
    );
    await settle();
    expect(document.body.textContent).not.toContain("Quarterly stale letter");
    expect(group("Mail")?.textContent).toContain("Searching");

    await act(async () =>
      pending.get("quarterly launch")!(
        response(mailBody([thread("thread-new", "Quarterly launch review")])),
      ),
    );
    await settle();
    expect(rows("Mail")).toHaveLength(1);
    expect(rows("Mail")[0].textContent).toContain("Quarterly launch review");
  });

  it("aborts the mail request in flight when the palette closes", async () => {
    let signal: AbortSignal | null | undefined;
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/search?")) return response({ hits: [] });
        if (url === "/api/mail/search/all") {
          signal = init?.signal;
          // never answers: the abort is what ends it
          return new Promise<Response>(() => {});
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    );
    await render();
    await type("quarterly");
    expect(signal?.aborted).toBe(false);

    await render({ open: false });
    expect(signal?.aborted).toBe(true);
  });

  it("does not claim no results while tasks alone match, and names every scope when nothing does", async () => {
    await render({ searchMail: false, tasks: [task("t1", "Quarterly task")] });
    await type("quarterly");
    expect(rows("Tasks")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("No results for");

    await type("zzzz");
    expect(document.body.textContent).toContain("No results for");
    expect(document.body.textContent).toContain(
      "Searches page titles and text, mail and tasks",
    );
  });

  it("folds an expanded group back when the palette closes", async () => {
    const tasks = Array.from({ length: 7 }, (_, index) =>
      task(`t${index}`, `Quarterly task ${index}`),
    );
    await render({ tasks, searchMail: false });
    await type("quarterly");
    await act(async () => item("Show all 7").click());
    expect(rows("Tasks")).toHaveLength(7);

    await render({ tasks, searchMail: false, open: false });
    await render({ tasks, searchMail: false, open: true });
    await type("quarterly");
    expect(rows("Tasks")).toHaveLength(6);
    expect(rows("Tasks")[5].textContent).toContain("Show all 7");
  });
});
