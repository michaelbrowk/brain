import { describe, expect, it } from "vitest";
import type { McpActivityEntry } from "@/lib/mcp/activity-log";
import {
  AGENT_FOLD_WINDOW_MS,
  agentActionFold,
  agentActionFoldKey,
  agentActionNotification,
  type AgentActivityEntry,
  type AgentFold,
} from "./agent-producer";
import { decodeAgentMailHref } from "./ids";
import { notificationSchema } from "./model";

/** The producer reads one log line and nothing else, so its input is a
 *  structural copy of the log's own entry rather than an import that would
 *  make the two modules point at each other. These two assignments are what
 *  hold the copy to the original: a field the log adds and this misses stops
 *  compiling here. */
const _entryIsAnActivityLine: AgentActivityEntry = {} as McpActivityEntry;
const _activityLineIsAnEntry: McpActivityEntry = {} as AgentActivityEntry;
void _entryIsAnActivityLine;
void _activityLineIsAnEntry;

const AT = "2026-09-14T12:00:00.000Z";
const ACCOUNT = "account-adeadbeefdeadbeefdeadbeefdeadbeef";

const line = (patch: Partial<AgentActivityEntry>): AgentActivityEntry => ({
  at: AT,
  client: "Claude",
  tool: "create_task",
  outcome: "ok",
  ...patch,
});

describe("what an agent did, as a row", () => {
  it("names the client and the verb, and nothing the agent wrote", () => {
    const row = agentActionNotification(line({ task: "task-alpha" }), "Water the plants");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("agent-action");
    expect(row!.title).toBe("Claude created a task");
    expect(row!.body).toBe("Water the plants");
    expect(row!.at).toBe(AT);
    expect(row!.readAt).toBeUndefined();
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  it("leaves the body out when the call site had no title in hand", () => {
    const row = agentActionNotification(line({ task: "task-alpha" }));
    expect(row!.body).toBeUndefined();
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  /** One row per tool, with the destination beside it. The table is the
   *  contract: a tool added to the log and not to this table writes no row. */
  const verbs: Array<[string, Partial<AgentActivityEntry>, string, string]> = [
    ["send_mail", { tool: "send_mail", accountId: ACCOUNT, operationId: "op-1" }, "Claude sent a message", "/mail"],
    ["save_mail_attachment", { tool: "save_mail_attachment", accountId: ACCOUNT, page: "meeting-notes" }, "Claude saved an attachment", "/p/meeting-notes"],
    ["create_task", { tool: "create_task", task: "task-alpha" }, "Claude created a task", "/tasks?task=task-alpha"],
    ["promote_task_line", { tool: "promote_task_line", task: "task-alpha", page: "notes" }, "Claude made a task from a line", "/tasks?task=task-alpha"],
    ["update_task", { tool: "update_task", task: "task-alpha", change: "title" }, "Claude changed a task", "/tasks?task=task-alpha"],
    ["complete_task", { tool: "complete_task", task: "task-alpha" }, "Claude completed a task", "/tasks?task=task-alpha"],
    ["reopen_task", { tool: "reopen_task", task: "task-alpha" }, "Claude reopened a task", "/tasks?task=task-alpha"],
    // The record is gone, so the column is the whole answer: "?task=" would
    // name a row nothing can select.
    ["delete_task", { tool: "delete_task", task: "task-alpha" }, "Claude deleted a task", "/tasks"],
    ["write_page", { tool: "write_page", page: "notes" }, "Claude wrote a page", "/p/notes"],
    ["append_page", { tool: "append_page", page: "notes" }, "Claude added to a page", "/p/notes"],
    ["create_page", { tool: "create_page", page: "notes" }, "Claude created a page", "/p/notes"],
    ["update_meta", { tool: "update_meta", page: "notes" }, "Claude changed a page", "/p/notes"],
    ["move_page", { tool: "move_page", page: "notes" }, "Claude moved a page", "/p/notes"],
    ["delete_page", { tool: "delete_page", page: "notes" }, "Claude deleted a page", "/"],
    // An app page is a page, so its row opens `/p/<id>` like any other. The
    // verb says "app page" because that is the thing the owner has to go and
    // look at: a page that appeared with a program in it reads differently
    // from a page that appeared with a paragraph in it.
    ["create_app_page", { tool: "create_app_page", page: "app1" }, "Claude built an app page", "/p/app1"],
    ["write_app_page", { tool: "write_app_page", page: "app1" }, "Claude rebuilt an app page", "/p/app1"],
  ];

  it.each(verbs)("%s", (_name, patch, title, href) => {
    const row = agentActionNotification(line(patch));
    expect(row).not.toBeNull();
    expect(row!.title).toBe(title);
    expect(row!.href).toBe(href);
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  /** One triage tool, six changes. `read` and `starred` carry no direction in
   *  the log line, and the row says what the line knows rather than guessing
   *  which way it went. */
  const triage: Array<[string, string]> = [
    ["archive", "Claude archived a thread"],
    ["trash", "Claude moved a thread to the trash"],
    ["restore", "Claude took a thread out of the trash"],
    ["spam", "Claude marked a thread as spam"],
    ["starred", "Claude changed a thread's star"],
  ];

  it.each(triage)("update_mail_thread, %s", (change, title) => {
    const row = agentActionNotification(
      line({ tool: "update_mail_thread", accountId: ACCOUNT, threadId: "thread-one", change }),
    );
    expect(row!.title).toBe(title);
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  /** A READ MARK IS NOT NEWS. It is triage, and a row about the marking would
   *  leave the badge at one for a letter the owner has just had dealt with.
   *  Michael's ruling, and the one triage change that says nothing. */
  it("says nothing about a thread's read mark", () => {
    expect(
      agentActionNotification(
        line({ tool: "update_mail_thread", accountId: ACCOUNT, threadId: "thread-one", change: "read" }),
      ),
    ).toBeNull();
  });

  it("falls back to one word for a triage line that named no change", () => {
    const row = agentActionNotification(
      line({ tool: "update_mail_thread", accountId: ACCOUNT, threadId: "thread-one" }),
    );
    expect(row!.title).toBe("Claude sorted a thread");
  });

  it("carries the thread in the href a mail row is opened through", () => {
    const row = agentActionNotification(
      line({ tool: "reply_mail", accountId: ACCOUNT, threadId: "thread-one", messageId: "m-1" }),
    );
    expect(row!.title).toBe("Claude replied to a message");
    expect(decodeAgentMailHref(row!.href)).toEqual({
      accountId: ACCOUNT,
      threadId: "thread-one",
    });
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  it("opens the surface alone when the line names no thread", () => {
    const row = agentActionNotification(line({ tool: "send_mail", accountId: ACCOUNT }));
    expect(row!.href).toBe("/mail");
  });

  it("derives one id from the line, so a replay is one row", () => {
    const entry = line({ task: "task-alpha" });
    const first = agentActionNotification(entry)!.id;
    expect(agentActionNotification(entry)!.id).toBe(first);
    expect(first).toMatch(/^agent:2026-09-14T12:00:00\.000Z:create_task:[0-9a-f]{16}$/);
  });

  it("gives two different lines two ids", () => {
    const alpha = agentActionNotification(line({ task: "task-alpha" }))!.id;
    const beta = agentActionNotification(line({ task: "task-beta" }))!.id;
    expect(alpha).not.toBe(beta);
    // The client's own name is not in the digest, so it is the ids that make
    // a row distinct, the way the id's own shape says.
    const sameIds = agentActionNotification(line({ task: "task-alpha", client: "Other" }))!.id;
    expect(sameIds).toBe(alpha);
  });

  it("says nothing about a call that was refused", () => {
    expect(agentActionNotification(line({ task: "task-alpha", outcome: "not_found" }))).toBeNull();
    expect(agentActionNotification(line({ task: "task-alpha", outcome: "conflict" }))).toBeNull();
  });

  it("says nothing about a read", () => {
    for (const tool of [
      "get_task",
      "list_tasks",
      "read_page",
      "search",
      "list_tree",
      "list_mail_threads",
      "get_mail_thread",
      "read_mail_message",
      "search_mail",
      "list_mail_accounts",
      "get_mail_send_status",
    ]) {
      expect(agentActionNotification(line({ tool }))).toBeNull();
    }
  });

  it("says nothing about the import family or the handshake", () => {
    for (const tool of [
      "notion_reserve_page",
      "notion_upload_attachment",
      "notion_finalize_page",
      "connection_check",
    ]) {
      expect(agentActionNotification(line({ tool, page: "notes" }))).toBeNull();
    }
  });

  it("says nothing about a line whose instant the centre would refuse", () => {
    expect(agentActionNotification(line({ at: "2026-09-14", task: "task-alpha" }))).toBeNull();
    expect(agentActionNotification(line({ at: "not an instant", task: "task-alpha" }))).toBeNull();
  });

  it("keeps a client name the bell can draw, and a row for one it cannot", () => {
    expect(agentActionNotification(line({ client: "  Claude\nDesktop  " }))!.title).toBe(
      "Claude Desktop created a task",
    );
    expect(agentActionNotification(line({ client: "   " }))!.title).toBe("An app created a task");
    expect(agentActionNotification(line({ client: "c".repeat(400) }))!.title.length).toBe(200);
  });

  it("cuts a title from the store to what the centre holds", () => {
    const row = agentActionNotification(line({ task: "task-alpha" }), "t".repeat(500));
    expect(row!.body!.length).toBe(400);
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  it("opens the surface rather than a path the centre would refuse", () => {
    // A page id the store would never mint. The derived path is checked
    // against the centre's own rule, so a row lands on the surface instead of
    // being written, announced and then refused at the next read.
    const row = agentActionNotification(line({ tool: "write_page", page: "a b#c" }));
    expect(row!.href).toBe("/");
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });
});

/** BURSTS COALESCE (Michael's ruling). An agent archiving a mailbox left one
 *  row per thread, and the centre's five hundred are shared with the reminders
 *  it was pushing out. Rows of the same shape inside five minutes are one row
 *  with a count. */
describe("what a burst of the same thing folds into", () => {
  const held = (patch: Partial<AgentFold> = {}): AgentFold => ({
    id: "agent:2026-09-14T12:00:00.000Z:update_mail_thread:1111111111111111",
    first: "2026-09-14T12:00:00.000Z",
    at: "2026-09-14T12:00:00.000Z",
    count: 1,
    href: "/mail?account=account-a1&thread=7468726561642d31",
    ...patch,
  });

  const archive = (at: string, thread: string) =>
    line({ at, tool: "update_mail_thread", accountId: "account-a1", threadId: thread, change: "archive" });

  it("counts the rows and keeps the first one's id", () => {
    const entry = archive("2026-09-14T12:01:00.000Z", "thread-2");
    const folded = agentActionFold(entry, agentActionNotification(entry)!, held());
    expect(folded).not.toBeNull();
    expect(folded!.row.id).toBe(held().id);
    expect(folded!.row.title).toBe("Claude archived 2 threads");
    // The newest line's instant, so the row rises to the head of the centre.
    expect(folded!.row.at).toBe("2026-09-14T12:01:00.000Z");
    expect(folded!.fold.count).toBe(2);
    expect(notificationSchema.safeParse(folded!.row).success).toBe(true);
  });

  it("drops the body, which named one of the things and not the rest", () => {
    const entry = line({ at: "2026-09-14T12:01:00.000Z", task: "task-beta" });
    const folded = agentActionFold(
      entry,
      agentActionNotification(entry, "Call the bank")!,
      held({
        id: "agent:2026-09-14T12:00:00.000Z:create_task:2222222222222222",
        href: "/tasks?task=task-alpha",
        body: "Water the plants",
      }),
    );
    expect(folded!.row.title).toBe("Claude created 2 tasks");
    expect(folded!.row.body).toBeUndefined();
    expect(folded!.fold.body).toBeUndefined();
  });

  it("falls back to the surface once the rows name different things", () => {
    const entry = archive("2026-09-14T12:01:00.000Z", "thread-2");
    const folded = agentActionFold(entry, agentActionNotification(entry)!, held());
    expect(folded!.row.href).toBe("/mail");
  });

  it("keeps the destination while every row names the same thing", () => {
    // The same task ticked and unticked and ticked again is still that task.
    const entry = line({ at: "2026-09-14T12:01:00.000Z", task: "task-alpha" });
    const folded = agentActionFold(
      entry,
      agentActionNotification(entry)!,
      held({
        id: "agent:2026-09-14T12:00:00.000Z:create_task:3333333333333333",
        href: "/tasks?task=task-alpha",
      }),
    );
    expect(folded!.row.href).toBe("/tasks?task=task-alpha");
  });

  it("starts a new row once the window has passed", () => {
    const entry = archive("2026-09-14T12:06:00.000Z", "thread-2");
    expect(agentActionFold(entry, agentActionNotification(entry)!, held())).toBeNull();
    expect(AGENT_FOLD_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  /** THE WINDOW IS A BOX, NOT A GAP (Michael's ruling). Five minutes from the
   *  row's FIRST line, whatever has landed in it since. Measured from the
   *  newest instead, an agent doing one thing every four minutes would fold
   *  into one row forever, and that row would sit at the head of the bell for
   *  as long as it kept working. */
  it("measures the window from the first line and not from the newest", () => {
    const late = archive("2026-09-14T12:07:00.000Z", "thread-3");
    expect(
      agentActionFold(late, agentActionNotification(late)!, held({
        // A row opened at 12:00 whose newest line landed at 12:03: four
        // minutes of gap, seven minutes of life.
        first: "2026-09-14T12:00:00.000Z",
        at: "2026-09-14T12:03:00.000Z",
        count: 2,
      })),
    ).toBeNull();
  });

  it("keeps the first line's instant as the row fills up", () => {
    const entry = archive("2026-09-14T12:04:00.000Z", "thread-2");
    const folded = agentActionFold(entry, agentActionNotification(entry)!, held());
    expect(folded!.fold.first).toBe("2026-09-14T12:00:00.000Z");
    expect(folded!.fold.at).toBe("2026-09-14T12:04:00.000Z");
  });

  it("folds a line stamped a little before the row it joins", () => {
    // Two clocks inside one window. The row keeps the later instant rather
    // than walking backwards down the centre.
    const entry = archive("2026-09-14T11:59:30.000Z", "thread-2");
    const folded = agentActionFold(entry, agentActionNotification(entry)!, held());
    expect(folded!.row.at).toBe("2026-09-14T12:00:00.000Z");
  });

  it("keys the fold on the client, the tool and the change, and nothing else", () => {
    const base = archive("2026-09-14T12:00:00.000Z", "thread-1");
    expect(agentActionFoldKey(base)).toBe(
      agentActionFoldKey(archive("2026-09-14T12:04:00.000Z", "thread-9")),
    );
    expect(agentActionFoldKey({ ...base, client: "Other" })).not.toBe(
      agentActionFoldKey(base),
    );
    expect(agentActionFoldKey({ ...base, change: "trash" })).not.toBe(
      agentActionFoldKey(base),
    );
    expect(agentActionFoldKey({ ...base, tool: "create_task" })).not.toBe(
      agentActionFoldKey(base),
    );
  });

  /** Every verb has a plural, because a count reads as a sentence or it reads
   *  as a bug: "Claude archived 12 threads", never "Claude archived a thread
   *  12". */
  const plurals: Array<[Partial<AgentActivityEntry>, string]> = [
    [{ tool: "send_mail", accountId: "account-a1" }, "Claude sent 4 messages"],
    [{ tool: "reply_mail", accountId: "account-a1", threadId: "t" }, "Claude replied to 4 messages"],
    [{ tool: "save_mail_attachment", page: "notes" }, "Claude saved 4 attachments"],
    [{ tool: "create_task", task: "t" }, "Claude created 4 tasks"],
    [{ tool: "promote_task_line", task: "t" }, "Claude made 4 tasks from lines"],
    [{ tool: "update_task", task: "t" }, "Claude changed 4 tasks"],
    [{ tool: "complete_task", task: "t" }, "Claude completed 4 tasks"],
    [{ tool: "reopen_task", task: "t" }, "Claude reopened 4 tasks"],
    [{ tool: "delete_task", task: "t" }, "Claude deleted 4 tasks"],
    [{ tool: "write_page", page: "p" }, "Claude wrote 4 pages"],
    [{ tool: "append_page", page: "p" }, "Claude added to 4 pages"],
    [{ tool: "create_page", page: "p" }, "Claude created 4 pages"],
    [{ tool: "update_meta", page: "p" }, "Claude changed 4 pages"],
    [{ tool: "move_page", page: "p" }, "Claude moved 4 pages"],
    [{ tool: "delete_page", page: "p" }, "Claude deleted 4 pages"],
    [{ tool: "update_mail_thread", change: "archive" }, "Claude archived 4 threads"],
    [{ tool: "update_mail_thread", change: "trash" }, "Claude moved 4 threads to the trash"],
    [{ tool: "update_mail_thread", change: "restore" }, "Claude took 4 threads out of the trash"],
    [{ tool: "update_mail_thread", change: "spam" }, "Claude marked 4 threads as spam"],
    [{ tool: "update_mail_thread", change: "starred" }, "Claude changed the star on 4 threads"],
    [{ tool: "update_mail_thread" }, "Claude sorted 4 threads"],
  ];

  it.each(plurals)("%o", (patch, title) => {
    const entry = line({ at: "2026-09-14T12:01:00.000Z", ...patch });
    const folded = agentActionFold(
      entry,
      agentActionNotification(entry)!,
      held({ id: `agent:2026-09-14T12:00:00.000Z:${patch.tool ?? "create_task"}:4444444444444444`, count: 3 }),
    );
    expect(folded!.row.title).toBe(title);
  });
});

describe("a row an app earned", () => {
  const entry = {
    at: "2026-09-22T10:00:00.000Z",
    client: "Trainer (app)",
    tool: "write_page",
    page: "words1",
    change: "markdown",
    outcome: "ok",
  };

  it("reads as the app doing the thing, not as a grant writing a page", () => {
    const row = agentActionNotification(entry, "Words");
    expect(row?.title).toBe("Trainer updated Words");
    expect(row?.href).toBe("/p/words1");
    expect(row?.kind).toBe("agent-action");
  });

  it("names the page it made when an app creates one", () => {
    const row = agentActionNotification({ ...entry, tool: "create_page", change: "create" }, "Session log");
    expect(row?.title).toBe("Trainer added Session log");
  });

  it("says something sensible when the page has no title to name", () => {
    expect(agentActionNotification(entry)?.title).toBe("Trainer updated a page");
  });

  it("folds a burst into one row with a count", () => {
    const first = agentActionNotification(entry, "Words")!;
    const second = { ...entry, at: "2026-09-22T10:01:00.000Z" };
    const next = agentActionNotification(second, "Words")!;
    const folded = agentActionFold(second, next, {
      id: first.id,
      first: first.at,
      at: first.at,
      count: 1,
      href: first.href,
    });
    expect(folded?.row.title).toBe("Trainer updated 2 pages");
  });

  it("still reads normally for an ordinary grant", () => {
    expect(agentActionNotification({ ...entry, client: "Claude" }, "Words")?.title).toBe("Claude wrote a page");
  });

  it("does not repeat the page's name under a title that already says it", () => {
    expect(agentActionNotification(entry, "Words")?.body).toBeUndefined();
    // a grant's row still carries one, because its title does not
    expect(agentActionNotification({ ...entry, client: "Claude" }, "Words")?.body).toBe("Words");
  });

  it("cuts one assembled title rather than its parts", () => {
    const long = agentActionNotification(
      { ...entry, client: `${"T".repeat(150)} (app)` },
      "W".repeat(150),
    )!;
    expect(long.title).toHaveLength(200);
    expect(long.title.startsWith("T".repeat(150))).toBe(true);
  });

  it("carries no em-dash", () => {
    expect(agentActionNotification(entry, "Words")?.title).not.toContain("—");
  });
});
