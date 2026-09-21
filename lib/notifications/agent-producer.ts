import { createHash } from "node:crypto";
import { agentMailHref } from "./ids";
import {
  isNotificationHref,
  isNotificationInstant,
  type BrainNotification,
} from "./model";

/** WHAT AN AGENT DID, AS A ROW IN THE BELL.
 *
 *  One row per successful mutation an agent made through MCP, out of the one
 *  line that mutation already wrote to the activity log
 *  (`lib/mcp/activity-log.ts`). Pure, the way `mail-producer.ts` is: it reads
 *  a line and answers a row or nothing, and the choke point around it does the
 *  writing.
 *
 *  THREE THINGS IT NEVER SAYS.
 *
 *  A read. An agent reading mail or opening a note is the ordinary case, the
 *  log does not record it either, and a bell that did would bury the sends.
 *
 *  A refusal. Only `outcome: "ok"` produces a row. Settings, Connections is
 *  where the attempts are, whatever became of them.
 *
 *  Anything the agent wrote. The title is this module's own words and the
 *  client's name; the body is a title read back out of the owner's own store
 *  at the call site, never a string the agent handed in. The log line carries
 *  ids and nothing else by design, so there is no path from a subject, an
 *  address or a body into a row.
 */

/** The fields of one activity line, structurally. `McpActivityEntry` is not
 *  imported: the log calls this module, and a type import back the other way
 *  makes two files point at each other for a shape that is a dozen strings.
 *  `agent-producer.test.ts` assigns each to the other, so the copy cannot
 *  drift from the original without the test stopping compiling. */
export interface AgentActivityEntry {
  readonly at: string;
  readonly client: string;
  readonly tool: string;
  readonly accountId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly attachmentId?: string;
  readonly page?: string;
  readonly task?: string;
  readonly operationId?: string;
  readonly change?: string;
  readonly outcome: string;
}

/** THE VERB TABLE, WHICH IS ALSO THE GUEST LIST.
 *
 *  A tool with no verb here writes no row, so every read is out by omission
 *  rather than by a second list that could disagree with this one. The phrases
 *  are the row's whole title after the client's name, and they are written to
 *  read as a sentence a person says: "Claude completed a task".
 *
 *  TWO FORMS EACH, because a burst of the same thing folds into one row with a
 *  count (`agentActionFold`), and a count reads as a sentence or it reads as a
 *  bug: "Claude archived 12 threads", never "Claude archived a thread 12".
 *  `%n` is where the number goes.
 */
interface Verb {
  readonly one: string;
  readonly many: string;
}

const VERB: Readonly<Record<string, Verb>> = {
  send_mail: { one: "sent a message", many: "sent %n messages" },
  reply_mail: { one: "replied to a message", many: "replied to %n messages" },
  save_mail_attachment: {
    one: "saved an attachment",
    many: "saved %n attachments",
  },
  create_task: { one: "created a task", many: "created %n tasks" },
  promote_task_line: {
    one: "made a task from a line",
    many: "made %n tasks from lines",
  },
  update_task: { one: "changed a task", many: "changed %n tasks" },
  complete_task: { one: "completed a task", many: "completed %n tasks" },
  reopen_task: { one: "reopened a task", many: "reopened %n tasks" },
  delete_task: { one: "deleted a task", many: "deleted %n tasks" },
  write_page: { one: "wrote a page", many: "wrote %n pages" },
  append_page: { one: "added to a page", many: "added to %n pages" },
  create_page: { one: "created a page", many: "created %n pages" },
  update_meta: { one: "changed a page", many: "changed %n pages" },
  move_page: { one: "moved a page", many: "moved %n pages" },
  delete_page: { one: "deleted a page", many: "deleted %n pages" },
};

const TRIAGE_TOOL = "update_mail_thread";

/** One tool, six changes, and the line names which one it ran
 *  (`app/api/mcp/mail-tools.ts`). `starred` can go either way and the line does
 *  not say which, so the row does not either: a "starred a thread" over an
 *  unstar is worse than a plainer word. */
const TRIAGE_VERB: Readonly<Record<string, Verb>> = {
  archive: { one: "archived a thread", many: "archived %n threads" },
  trash: {
    one: "moved a thread to the trash",
    many: "moved %n threads to the trash",
  },
  restore: {
    one: "took a thread out of the trash",
    many: "took %n threads out of the trash",
  },
  spam: { one: "marked a thread as spam", many: "marked %n threads as spam" },
  starred: {
    one: "changed a thread's star",
    many: "changed the star on %n threads",
  },
};

/** THE ONE MUTATION THAT SAYS NOTHING.
 *
 *  A read mark is triage. A row about the marking would put the badge back to
 *  one for a letter the owner has just had dealt with, which is the opposite
 *  of what the centre is for. Michael's ruling. The line is still written, so
 *  Settings, Connections shows it like every other mutation. */
const SILENT_CHANGE = "read";

/** What a triage line that named no change says. Reachable only for a line
 *  written before the change token existed, or by a caller that skipped it. */
const TRIAGE_FALLBACK: Verb = {
  one: "sorted a thread",
  many: "sorted %n threads",
};

/** The import family has its own ledger and its own batch, and the handshake
 *  changes nothing at all. Both are excluded by name rather than by leaving
 *  them out of the table, because `notion_*` is a family that grows. */
const IMPORT_PREFIX = "notion_";
const HANDSHAKE = "connection_check";

/** The fields the id's digest is taken over: every id-shaped field a line may
 *  carry, plus the change token, in one fixed order. Two calls that touched
 *  the same things at the same millisecond through the same tool are one row,
 *  which is what makes a replay of the log idempotent. */
const DIGEST_FIELDS = [
  "accountId",
  "threadId",
  "messageId",
  "attachmentId",
  "page",
  "task",
  "operationId",
  "change",
] as const;

/** The separator inside a fold key. A NUL, because a client name or a change
 *  token can hold anything else and two fields must not be able to run into
 *  one another. */
const FOLD_KEY_SEPARATOR = "\u0000";

/** Where the count goes in a plural verb. */
const COUNT_MARK = "%n";

/** Half a sha256, hex. Sixteen characters is short enough to read in a file
 *  and far past what a collision inside one instant's worth of tool calls
 *  would need. */
const DIGEST_CHARS = 16;

/** The centre's own bounds (`notificationSchema`). Cut here rather than left
 *  to the schema, which refuses the whole row for one long field. */
const MAX_TITLE = 200;
const MAX_BODY = 400;

/** A name the bell can draw: one line, no runs of space. The OAuth client
 *  picks it, so it is not prose an agent writes per call, but it is still a
 *  string this side did not choose. */
const CLIENT_FALLBACK = "An app";

function clientName(value: string): string {
  const tidy = value.replace(/\s+/g, " ").trim();
  return tidy.length > 0 ? tidy : CLIENT_FALLBACK;
}

function verbOf(entry: AgentActivityEntry): Verb | null {
  if (entry.tool === TRIAGE_TOOL) {
    if (entry.change === SILENT_CHANGE) return null;
    if (entry.change === undefined) return TRIAGE_FALLBACK;
    return TRIAGE_VERB[entry.change] ?? TRIAGE_FALLBACK;
  }
  return VERB[entry.tool] ?? null;
}

/** WHERE THE ROW GOES.
 *
 *  The surface the mutation happened on, naming the thing itself wherever a
 *  route takes one: Tasks selects a task from `?task=`, a note is its own
 *  `/p/<id>`, and Mail has no per-thread route, so the pair rides in the
 *  query and the bell asks Mail to open it (`decodeAgentMailHref`).
 *
 *  A delete names no thing: the record or the note is gone, and a path to it
 *  is a 404 with a notification in front of it.
 */
function hrefOf(entry: AgentActivityEntry): string {
  const { accountId, threadId, page, task } = entry;
  const deleted = entry.tool === "delete_page" || entry.tool === "delete_task";
  switch (surfaceOf(entry.tool)) {
    case "page":
      return deleted || page === undefined ? "/" : `/p/${page}`;
    case "task":
      return deleted || task === undefined ? "/tasks" : `/tasks?task=${task}`;
    default:
      return accountId !== undefined && threadId !== undefined
        ? agentMailHref(accountId, threadId)
        : "/mail";
  }
}

/** Which of the three surfaces a tool's row belongs to. `save_mail_attachment`
 *  is a mail tool whose row opens the note the file landed in, which is the
 *  thing the reader wants to see. */
function surfaceOf(tool: string): "page" | "task" | "mail" {
  if (tool === "save_mail_attachment") return "page";
  if (tool.endsWith("_page") || tool === "update_meta") return "page";
  if (tool.endsWith("_task") || tool === "promote_task_line") return "task";
  return "mail";
}

/** The bare surface, for a row whose derived path the centre would refuse. */
const SURFACE_HREF: Readonly<Record<"page" | "task" | "mail", string>> = {
  page: "/",
  task: "/tasks",
  mail: "/mail",
};

export function agentActionNotificationId(entry: AgentActivityEntry): string {
  const hash = createHash("sha256");
  for (const field of DIGEST_FIELDS) hash.update(`${field}=${entry[field] ?? ""}\n`);
  return `agent:${entry.at}:${entry.tool}:${hash.digest("hex").slice(0, DIGEST_CHARS)}`;
}

/** The row one activity line earns, or `null` for the lines that earn none.
 *
 *  `label` is a title the call site already had in hand out of the owner's own
 *  store: the task it just wrote, the note it just saved a file into. It is
 *  the body and nothing else, and a call site without one leaves it out rather
 *  than reading a file to fill it.
 */
export function agentActionNotification(
  entry: AgentActivityEntry,
  label?: string,
): BrainNotification | null {
  if (entry.outcome !== "ok") return null;
  if (entry.tool.startsWith(IMPORT_PREFIX) || entry.tool === HANDSHAKE) return null;
  // The centre sorts on this string and never re-reads it, so a line whose
  // instant it would refuse is dropped here rather than written, announced and
  // then lost at the next read.
  if (!isNotificationInstant(entry.at)) return null;
  const verb = verbOf(entry);
  if (verb === null) return null;

  const href = hrefOf(entry);
  const body = label?.replace(/\s+/g, " ").trim().slice(0, MAX_BODY);
  return {
    id: agentActionNotificationId(entry),
    kind: "agent-action",
    at: entry.at,
    title: `${clientName(entry.client)} ${verb.one}`.slice(0, MAX_TITLE),
    ...(body !== undefined && body.length > 0 ? { body } : {}),
    // An id the store minted is a path already; an id from anywhere else is
    // checked before it becomes one, and the surface is the fallback.
    href: isNotificationHref(href) ? href : SURFACE_HREF[surfaceOf(entry.tool)],
  };
}

/** HOW LONG A BURST IS.
 *
 *  Five minutes (Michael's ruling). Long enough that an agent working through a
 *  mailbox or a list is one row, short enough that two sittings are two rows,
 *  which is what a reader coming back to the bell wants to be able to tell
 *  apart.
 *
 *  A BOX, NOT A GAP. The five minutes run from the row's FIRST line, whatever
 *  has landed in it since. Measured from the newest line instead, an agent
 *  doing one thing every four minutes folds into one row forever: the count
 *  grows without a bound and the row is pushed back to the head of the bell on
 *  every fold, so it can never age down the list while the agent is working.
 *  A box says the true thing about a long session: several rows, each one five
 *  minutes of it. */
export const AGENT_FOLD_WINDOW_MS = 5 * 60 * 1000;

/** WHAT THE CENTRE ALREADY HOLDS FOR ONE SHAPE OF ACTION.
 *
 *  Kept by the choke point, not by this module: the fold has to be decided
 *  before the write, and this file reads no clock and no file.
 *
 *  Three instants' worth of state in two fields. `id` is the first line's,
 *  which is the row's id for its whole life. `first` is when the row opened,
 *  which is what the window is measured against. `at` is the newest line's,
 *  which is where the centre sorts it. */
export interface AgentFold {
  readonly id: string;
  readonly first: string;
  readonly at: string;
  readonly count: number;
  readonly href: string;
  readonly body?: string;
}

/** THE SHAPE A BURST IS COUNTED BY: who did it, with which tool, and which
 *  change of that tool's. Never the thing it was done to, which is the whole
 *  point: twelve threads archived by Claude is one row, and a thread archived
 *  by Claude beside one archived by a second grant is two. */
export function agentActionFoldKey(entry: AgentActivityEntry): string {
  return [entry.client, entry.tool, entry.change ?? ""].join(FOLD_KEY_SEPARATOR);
}

/** The row `held` becomes when this line joins it, or `null` when it does not:
 *  the window has passed, or the line is one that earns no row at all.
 *
 *  `next` is what this line produced on its own, which the caller has in hand
 *  already and which carries the checked href and the bounded title.
 */
export function agentActionFold(
  entry: AgentActivityEntry,
  next: BrainNotification,
  held: AgentFold,
): { row: BrainNotification; fold: AgentFold } | null {
  const verb = verbOf(entry);
  if (verb === null) return null;
  // Against the row's first line, never against its newest: the window is the
  // row's whole life, not the gap since the last thing that joined it.
  const apart = Date.parse(next.at) - Date.parse(held.first);
  if (!Number.isFinite(apart) || Math.abs(apart) > AGENT_FOLD_WINDOW_MS) return null;
  const count = held.count + 1;
  // The later of the two instants. Two clocks inside one window would
  // otherwise walk the row backwards down a centre that sorts on this string.
  const at = next.at > held.at ? next.at : held.at;
  // And the earlier of the two opens it, for the same reason read the other
  // way: a line stamped before the row it joins makes the row that old, and
  // the box closes five minutes after the earliest thing in it.
  const first = next.at < held.first ? next.at : held.first;
  // The destination survives only while every line named the same thing. A
  // burst over a dozen threads goes to Mail, not to the twelfth thread.
  const href = held.href === next.href ? held.href : SURFACE_HREF[surfaceOf(entry.tool)];
  return {
    row: {
      id: held.id,
      kind: "agent-action",
      at,
      title: `${clientName(entry.client)} ${verb.many.replace(COUNT_MARK, String(count))}`.slice(
        0,
        MAX_TITLE,
      ),
      // No body past the first: it named one of the things and says nothing
      // about the rest, and a count with one name beside it reads as a lie.
      href,
    },
    fold: { id: held.id, first, at, count, href },
  };
}
