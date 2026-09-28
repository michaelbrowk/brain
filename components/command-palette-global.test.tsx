// @vitest-environment jsdom

// The two groups that make the palette a global search: Mail, fetched from
// `POST /api/mail/search/all`, and Tasks, ranked from the records the shell
// already holds. Each group loads, fails and expands on its own.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskView } from "@/lib/tasks/model";
import type { TreeNode } from "@/lib/store/types";
import {
  CommandPalette,
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

function mailBody(threads: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 1,
    threads,
    accounts: [
      {
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
      },
    ],
    indexBuilding: false,
    truncated: false,
    ...overrides,
  };
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
      'input[aria-label="Search pages and text"]',
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
        mailBody([thread("thread-1", null, { unread: false })], {
          indexBuilding: true,
        }),
      );
    await render();
    await type("quarterly");

    expect(rows("Mail")[0].textContent).toContain("(no subject)");
    expect(rows("Mail")[0].querySelector(".font-semibold")).toBeNull();
    expect(group("Mail")?.textContent).toContain("Mail index is still building");
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

  it("names the route actions after the route they belong to", async () => {
    window.history.replaceState({}, "", "/tasks");
    await render({ onOpenTasks: vi.fn() });
    expect(group("Tasks")?.textContent).toContain("Move to Today");
    expect(group("Mail")).toBeNull();
  });
});
