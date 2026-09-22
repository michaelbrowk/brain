import { staticClientName } from "@/lib/oauth/config";
import { getOAuthStateStore } from "@/lib/oauth/state";

/** THE SHARED SHAPES EVERY MCP TOOL ANSWERS IN, AND THE ONE SCOPE TABLE.
 *
 *  Split out of `route.ts` so the tool registrars can import the helpers
 *  without importing the handler, and so `toolScopeOf` is a unit under test on
 *  its own. The gate in `route.ts` runs before the handler, off the tool name
 *  alone, which is why the name sets below are the whole answer to "what may
 *  this grant call".
 */

/** The scopes a tool can be declared against. `brain:read` is not here: it is
 *  the floor every connection already holds, so a tool needing nothing more
 *  maps to `null`. */
export type McpToolScope = "brain:write" | "brain:import" | "brain:mail" | "brain:mail:send";

export const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/** THE FOUR HINTS A HOST READS BEFORE IT DECIDES WHETHER TO CONFIRM A CALL.
 *
 *  MCP's tool annotations are how a host such as Claude tells `read_page`
 *  from `delete_page` without calling either. Brain declared none of them, so
 *  every tool arrived looking equally safe and a host had nothing to put a
 *  confirmation behind.
 *
 *  Four words, in a fixed order, instead of four named booleans spelled out
 *  at every registration site. The argument's type is the sixteen legal
 *  sentences, so a misspelling or a swapped pair is a typecheck failure
 *  rather than a hint that quietly reads as its opposite.
 *  `tool-annotations.test.ts` pins the same table in the same words, and
 *  `docs/mcp-tools.md` publishes it.
 *
 *  - `read` / `write` — whether the tool changes anything at all.
 *  - `keeps` / `destroys` — whether the change can be taken back. A note
 *    write is `keeps` because every save is a git commit. A delete, a send
 *    and a triage move to trash or spam are not.
 *  - `idempotent` / `repeats` — whether calling it twice with the same input
 *    leaves the same result, or a second thing.
 *  - `local` / `outside` — whether it stays inside the notes folder, or
 *    reaches a service Brain does not own.
 *
 *  All four are set on every tool and none is left to the SDK's default: a
 *  default is indistinguishable from a tool nobody thought about, which is
 *  the state this replaced. */
export type ToolHints = `${"read" | "write"} ${"keeps" | "destroys"} ${
  | "idempotent"
  | "repeats"} ${"local" | "outside"}`;

export function hints(row: ToolHints): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const [access, loss, repeat, reach] = row.split(" ");
  return {
    readOnlyHint: access === "read",
    destructiveHint: loss === "destroys",
    idempotentHint: repeat === "idempotent",
    openWorldHint: reach === "outside",
  };
}

/** THE ONE SHAPE EVERY REFUSAL ON THIS ENDPOINT ANSWERS IN.
 *
 *  `{ error, reason }` with `isError` set, never a thrown JSON-RPC error: a
 *  transport error arrives without a reason and the agent retries blind.
 *
 *  `error` is the sentence, and `reason` is the machine code where the
 *  refusal has one, or else the field, the id or the measurement that names
 *  the cause. Both are required, because the three tool families each used to
 *  fill them their own way: the mail tools put a code in `reason`, the
 *  attachment save put prose there, and the task tools put the code in
 *  `error` with no `reason` at all. An agent could not branch on one field
 *  across the endpoint. Making `reason` required is what keeps the next tool
 *  from inventing a fourth way.
 *
 *  A refusal that carries more than the two fields (`currentRev`,
 *  `currentWhen`) spreads them beside these, rather than folding them into
 *  the sentence. */
export function refusal(error: string, reason: string) {
  return { ...text({ error, reason }), isError: true as const };
}

/** The code every store failure answers under, whatever the tool. */
export const STORE_FAILED = "store_failed";

/** WHAT THE NOTES FOLDER FAILING LOOKS LIKE TO AN AGENT.
 *
 *  A store error that is none of the refusals the store decided on is a Node
 *  `fs` one: a full disk, a read-only mount, a permission. Its message carries
 *  the absolute path of the notes folder, and the SDK hands a thrown error's
 *  message to the agent verbatim, so a rethrow published that path and arrived
 *  as the transport error `docs/mcp-tools.md` calls a bug. One sentence of
 *  Brain's own and one code instead, and the caller writes its line the way it
 *  writes one for every other refusal.
 *
 *  The sentence is the tool's, because "could not be saved" and "could not
 *  answer" are different things to an agent deciding whether to retry. The
 *  code is the same everywhere, so `reason` stays the field to branch on. */
export function storeFailed(error = "the notes folder could not answer") {
  return refusal(error, STORE_FAILED);
}

/** The code the full-text engine failing answers under, which is not the
 *  notes folder failing. */
export const SEARCH_BACKEND = "search_backend";

/** WHAT RIPGREP FAILING LOOKS LIKE TO AN AGENT.
 *
 *  `search` reads the store like every other page tool, so it is wrapped in
 *  the same catch-all, and that swallowed the one failure it has of its own:
 *  `rg` missing from the release or off `PATH`, a timeout, an output cap, a
 *  bad exit. All four arrived as `store_failed`, and an agent cannot tell a
 *  notes folder it should stop writing to from a search binary somebody has
 *  to install. Its own code, and Brain's own sentence for it: all four
 *  messages `lib/search.ts` throws are written there and none interpolates
 *  anything of the machine's. The bad-exit one used to carry ripgrep's stderr
 *  and no longer does — that text is a third-party binary's to choose, so it
 *  goes to the server's log and the exit code travels alone. */
export function searchBackendFailed(error: string) {
  return refusal(error, SEARCH_BACKEND);
}

/** The permission answer, in the same two fields every refusal uses, with the
 *  scope it wanted beside them. The `insufficient_scope` word itself is the
 *  OAuth one, and the 403 this endpoint answers at the HTTP level
 *  (`lib/oauth/http.ts`) keeps its own RFC 6750 body. */
export const insufficientScope = (scope: McpToolScope) => ({
  ...text({
    error: "This connection does not have permission for this tool.",
    reason: "insufficient_scope",
    requiredScope: scope,
  }),
  isError: true,
});

export function hasScope(
  extra: { authInfo?: { scopes: string[] } },
  scope: McpToolScope,
): boolean {
  return Boolean(extra.authInfo?.scopes.includes(scope));
}

/** The grant's own name, for the activity log and the Sent-row caption. Never
 *  the client id: a person reading the log wants the name they approved.
 *
 *  Not memoised: `extra` is rebuilt per tool call by the handler underneath,
 *  with nothing shaped like a per-request context to hang a cache on, and a
 *  batch is the only case where one request makes more than one of these
 *  calls. Caching here would mean inventing that context first, for a read
 *  that costs one already-open state file. Revisit if a request-scoped
 *  object appears for another reason.
 *
 *  The static bearer has no registered name to read, so the owner supplies one
 *  in `MCP_TOKEN_NAME` and `staticClientName` is the only place it is read.
 *  Lines already written keep the word they were written with: the log is
 *  history, not a view. */
export async function clientNameOf(extra: {
  authInfo?: { clientId?: string };
}): Promise<string> {
  const clientId = extra.authInfo?.clientId;
  if (!clientId) return "Unknown app";
  if (clientId === "brain-legacy-bearer") return staticClientName();
  return (await getOAuthStateStore().getClient(clientId))?.name ?? "Unknown app";
}

/** Page mutations plus the task writes and the two app builds. The task names
 *  are here before their tools exist on purpose: the gate is a name check
 *  that runs ahead of the handler, so a name listed here and not yet
 *  registered is refused rather than mis-scoped, and the task that registers
 *  it cannot forget one.
 *
 *  An app page is a page, so building one needs `brain:write` and nothing
 *  more: Michael's ruling of 2026-09-22, no extra consent line. What stops an
 *  agent reaching for one is the rule in `create_app_page`'s description, not
 *  a scope. `read_app_page` is absent, which is how a read stays on the
 *  floor every connection already holds. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_page",
  "append_page",
  "create_page",
  "update_meta",
  "move_page",
  "delete_page",
  "create_task",
  "promote_task_line",
  "update_task",
  "complete_task",
  "reopen_task",
  "delete_task",
  "create_app_page",
  "write_app_page",
]);

/** Reading and sorting mail, and saving one of its attachments into a note. */
export const MAIL_TOOLS: ReadonlySet<string> = new Set([
  "list_mail_accounts",
  "list_mail_threads",
  "search_mail",
  "get_mail_thread",
  "read_mail_message",
  "update_mail_thread",
  "save_mail_attachment",
]);

/** Putting a message on the wire, and asking what became of one. */
export const MAIL_SEND_TOOLS: ReadonlySet<string> = new Set([
  "send_mail",
  "reply_mail",
  "get_mail_send_status",
]);

/** The only place a tool name maps to a scope. */
export function toolScopeOf(name: string): McpToolScope | null {
  if (name.startsWith("notion_")) return "brain:import";
  if (MAIL_SEND_TOOLS.has(name)) return "brain:mail:send";
  if (MAIL_TOOLS.has(name)) return "brain:mail";
  if (WRITE_TOOLS.has(name)) return "brain:write";
  return null;
}

/** The code a call into a module that is off answers under. */
export const MODULE_OFF = "module_off";

/** One sentence per module, naming where the switch is. An agent prints this
 *  to a person, so it says the cure rather than the state: "off" alone leaves
 *  a reader looking for a setting that is two words away. */
export const MODULE_OFF_SENTENCE: Record<"mail" | "tasks", string> = {
  mail: "Mail is turned off in Settings › Modules",
  tasks: "Tasks are turned off in Settings › Modules",
};

export function moduleOff(module: "mail" | "tasks") {
  return refusal(MODULE_OFF_SENTENCE[module], MODULE_OFF);
}
