import { createHash } from "node:crypto";
import { agentMailHref, decodeAgentMailHref } from "./ids";
import { DIGEST_ID_CAP, DIGEST_KINDS, DIGEST_TARGET_CAP, digestTitle, type AgentDigest, type DigestKind, type DigestTarget } from "./agent-digest";
import { isNotificationHref, isNotificationInstant, type BrainNotification } from "./model";

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

/** Only successful mutations already recorded by MCP earn a digest. Reads,
 * imports, handshakes and mail read marks keep their existing silence. */
const TOOL_KIND: Readonly<Record<string, DigestKind>> = {
  write_page: "page", append_page: "page", create_page: "page", update_meta: "page",
  move_page: "page", delete_page: "page", create_app_page: "page", write_app_page: "page",
  save_mail_attachment: "page",
  create_task: "task", promote_task_line: "task", update_task: "task", complete_task: "task",
  reopen_task: "task", delete_task: "task",
  update_mail_thread: "thread", send_mail: "message", reply_mail: "message",
};
const SURFACE = { page: "/", task: "/tasks", thread: "/mail", message: "/mail" };
const LABEL = { page: "Page", task: "Task", thread: "Mail thread", message: "Sent message" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const tidy = (value: string, cap: number) => value.replace(/\s+/g, " ").trim().slice(0, cap);

/** Same owner IANA zone as reminders. Before it is captured, UTC is explicit
 * fallback; the server's process zone never participates. */
function localDay(at: string, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function digestRow(digest: AgentDigest, at: string): BrainNotification {
  return {
    id: `agent-digest:${digest.day}:${hash(digest.agent)}`,
    kind: "agent-action", at, title: digestTitle(digest), href: "/", digest,
  };
}

export function agentActionNotification(
  entry: AgentActivityEntry,
  label?: string,
  zone = "UTC",
): BrainNotification | null {
  const kind = TOOL_KIND[entry.tool];
  if (entry.outcome !== "ok" || kind === undefined || !isNotificationInstant(entry.at)) return null;
  if (entry.tool === "update_mail_thread" && entry.change === "read") return null;
  const agent = tidy(entry.client, 200) || "An app";
  const day = localDay(entry.at, zone);
  const deleted = entry.tool === "delete_page" || entry.tool === "delete_task";
  let href = SURFACE[kind];
  let identity: string | undefined;
  if (kind === "page") {
    identity = entry.page;
    if (!deleted && entry.page) href = `/p/${entry.page}`;
  } else if (kind === "task") {
    identity = entry.task;
    if (!deleted && entry.task) href = `/tasks?task=${entry.task}`;
  } else {
    // A send/reply is one outbound operation, while triage is one thread.
    // Operation ids also deduplicate a send retried across process restarts.
    identity = kind === "thread" ? entry.threadId : entry.operationId ?? entry.messageId;
    if (identity) identity = `${entry.accountId ?? ""}\0${identity}`;
    if (entry.accountId && entry.threadId) href = agentMailHref(entry.accountId, entry.threadId);
  }
  const id = hash(identity ?? JSON.stringify(entry));
  const target: DigestTarget = {
    id, kind, at: entry.at, title: tidy(label ?? "", 200) || LABEL[kind],
    href: isNotificationHref(href) ? href : SURFACE[kind],
  };
  return digestRow({ agent, day, ids: { page: [], task: [], thread: [], message: [], [kind]: [id] }, saturated: [], targets: [target] }, entry.at);
}

/** The store calls this under its own mutex using the file's current row.
 * No process-local fold memo and no dependence on read state. */
export function mergeAgentDigests(held: BrainNotification, incoming: BrainNotification): BrainNotification {
  const a = held.digest!;
  const b = incoming.digest!;
  const ids = { ...a.ids };
  const saturated = new Set([...a.saturated, ...b.saturated]);
  for (const kind of DIGEST_KINDS) {
    const union = [...new Set([...a.ids[kind], ...b.ids[kind]])];
    if (union.length > DIGEST_ID_CAP) saturated.add(kind);
    ids[kind] = union.slice(0, DIGEST_ID_CAP);
  }
  const detail = new Map<string, DigestTarget>();
  for (const target of [...a.targets, ...b.targets]) {
    const key = `${target.kind}:${target.id}`;
    const previous = detail.get(key);
    if (!previous || previous.at <= target.at) detail.set(key, target);
  }
  const targets = [...detail.values()].sort((x, y) => y.at.localeCompare(x.at) || x.id.localeCompare(y.id)).slice(0, DIGEST_TARGET_CAP);
  return { ...digestRow({ ...a, ids, saturated: [...saturated], targets }, held.at > incoming.at ? held.at : incoming.at), ...(held.readAt ? { readAt: held.readAt } : {}) };
}

/** V1 stored no client/target structure. Recover only a known singular
 * sentence with an identifiable destination. Aggregate bursts and ambiguous
 * app prose stay verbatim rather than inventing distinct targets or names. */
const LEGACY_VERBS: Readonly<Record<string, string>> = {
  write_page: "wrote a page", append_page: "added to a page", create_page: "created a page",
  update_meta: "changed a page", move_page: "moved a page", create_app_page: "built an app page",
  write_app_page: "rebuilt an app page", save_mail_attachment: "saved an attachment",
  create_task: "created a task", promote_task_line: "made a task from a line", update_task: "changed a task",
  complete_task: "completed a task", reopen_task: "reopened a task",
  send_mail: "sent a message", reply_mail: "replied to a message",
};
const LEGACY_TRIAGE = ["archived a thread", "moved a thread to the trash", "took a thread out of the trash", "marked a thread as spam", "changed a thread's star", "sorted a thread"];

export function migrateAgentRows(rows: BrainNotification[], zone: string): BrainNotification[] {
  const digests = new Map<string, BrainNotification>();
  const retained: BrainNotification[] = [];
  for (const row of rows) {
    if (row.kind !== "agent-action" || row.digest) { retained.push(row); continue; }
    const tool = /^agent:.*Z:([a-z_]+):/.exec(row.id)?.[1];
    const phrases = tool === "update_mail_thread" ? LEGACY_TRIAGE : tool && LEGACY_VERBS[tool] ? [LEGACY_VERBS[tool]] : [];
    const phrase = phrases.find((p) => row.title.endsWith(` ${p}`));
    if (!tool || !phrase) { retained.push(row); continue; }
    const entry: AgentActivityEntry = { at: row.at, client: row.title.slice(0, -phrase.length - 1), tool, outcome: "ok" };
    const page = /^\/p\/([^/?]+)$/.exec(row.href)?.[1];
    const task = /^\/tasks\?task=([^&]+)$/.exec(row.href)?.[1];
    const mail = decodeAgentMailHref(row.href);
    if (!page && !task && !mail) { retained.push(row); continue; }
    const next = agentActionNotification({ ...entry, ...(page ? { page } : {}), ...(task ? { task } : {}), ...(mail ?? {}), ...(TOOL_KIND[tool] === "message" ? { operationId: row.id } : {}) }, row.body, zone)!;
    if (row.readAt) next.readAt = row.readAt;
    const held = digests.get(next.id);
    digests.set(next.id, held ? mergeAgentDigests(held, next) : next);
  }
  return [...retained, ...digests.values()];
}
