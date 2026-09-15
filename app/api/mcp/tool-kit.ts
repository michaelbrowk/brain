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

/** A domain refusal an agent can read: never a thrown JSON-RPC error, because
 *  a transport error arrives without a reason and the agent retries blind. */
export function refusal(error: string, reason?: string) {
  return {
    ...text(reason === undefined ? { error } : { error, reason }),
    isError: true as const,
  };
}

export const insufficientScope = (scope: McpToolScope) => ({
  ...text({
    error: "This connection does not have permission for this tool.",
    code: "insufficient_scope",
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
 *  the client id: a person reading the log wants the name they approved. */
export async function clientNameOf(extra: {
  authInfo?: { clientId?: string };
}): Promise<string> {
  const clientId = extra.authInfo?.clientId;
  if (!clientId) return "Unknown app";
  if (clientId === "brain-legacy-bearer") return "Legacy token";
  return (await getOAuthStateStore().getClient(clientId))?.name ?? "Unknown app";
}

/** Page mutations plus the task writes. The task names are here before their
 *  tools exist on purpose: the gate is a name check that runs ahead of the
 *  handler, so a name listed here and not yet registered is refused rather
 *  than mis-scoped, and the task that registers it cannot forget one. */
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
