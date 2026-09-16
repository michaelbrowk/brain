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
 */
const VERB: Readonly<Record<string, string>> = {
  send_mail: "sent a message",
  reply_mail: "replied to a message",
  save_mail_attachment: "saved an attachment",
  create_task: "created a task",
  promote_task_line: "made a task from a line",
  update_task: "changed a task",
  complete_task: "completed a task",
  reopen_task: "reopened a task",
  delete_task: "deleted a task",
  write_page: "wrote a page",
  append_page: "added to a page",
  create_page: "created a page",
  update_meta: "changed a page",
  move_page: "moved a page",
  delete_page: "deleted a page",
};

const TRIAGE_TOOL = "update_mail_thread";

/** One tool, six changes, and the line names which one it ran
 *  (`app/api/mcp/mail-tools.ts`). `read` and `starred` are the two that can go
 *  either way, and the line does not say which, so the row does not either: a
 *  "marked a thread read" over an unread is worse than a plainer word. */
const TRIAGE_VERB: Readonly<Record<string, string>> = {
  archive: "archived a thread",
  trash: "moved a thread to the trash",
  restore: "took a thread out of the trash",
  spam: "marked a thread as spam",
  starred: "changed a thread's star",
  read: "changed a thread's read mark",
};

/** What a triage line that named no change says. Reachable only for a line
 *  written before the change token existed, or by a caller that skipped it. */
const TRIAGE_FALLBACK = "sorted a thread";

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

function verbOf(entry: AgentActivityEntry): string | null {
  if (entry.tool === TRIAGE_TOOL) {
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
    title: `${clientName(entry.client)} ${verb}`.slice(0, MAX_TITLE),
    ...(body !== undefined && body.length > 0 ? { body } : {}),
    // An id the store minted is a path already; an id from anywhere else is
    // checked before it becomes one, and the surface is the fallback.
    href: isNotificationHref(href) ? href : SURFACE_HREF[surfaceOf(entry.tool)],
  };
}
