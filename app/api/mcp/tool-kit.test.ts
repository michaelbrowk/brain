import { describe, expect, it } from "vitest";
import {
  MAIL_SEND_TOOLS,
  MAIL_TOOLS,
  WRITE_TOOLS,
  insufficientScope,
  refusal,
  text,
  toolScopeOf,
} from "./tool-kit";
import {
  MCP_SCOPES,
  MCP_CONNECTION_SCOPES,
  MCP_SCOPE_LABELS,
  normalizeScopes,
  ownerEffectiveScopes,
} from "@/lib/oauth/config";

describe("the tool scope table", () => {
  it.each([
    ["list_tree", null],
    ["read_page", null],
    ["search", null],
    ["list_tasks", null],
    ["get_task", null],
    ["write_page", "brain:write"],
    ["create_task", "brain:write"],
    ["promote_task_line", "brain:write"],
    ["delete_task", "brain:write"],
    ["notion_find_page", "brain:import"],
    ["list_mail_accounts", "brain:mail"],
    ["list_mail_threads", "brain:mail"],
    ["search_mail", "brain:mail"],
    ["get_mail_thread", "brain:mail"],
    ["read_mail_message", "brain:mail"],
    ["update_mail_thread", "brain:mail"],
    ["save_mail_attachment", "brain:mail"],
    ["send_mail", "brain:mail:send"],
    ["reply_mail", "brain:mail:send"],
    ["get_mail_send_status", "brain:mail:send"],
  ] as const)("puts %s under %s", (name, scope) => {
    expect(toolScopeOf(name)).toBe(scope);
  });

  it("keeps the three sets disjoint", () => {
    for (const name of MAIL_TOOLS) expect(WRITE_TOOLS.has(name)).toBe(false);
    for (const name of MAIL_SEND_TOOLS) expect(MAIL_TOOLS.has(name)).toBe(false);
  });
});

describe("scope closure", () => {
  it("closes send onto mail, and mail onto read, without touching write", () => {
    expect(normalizeScopes(["brain:mail:send"])).toEqual([
      "brain:read",
      "brain:mail",
      "brain:mail:send",
    ]);
    expect(normalizeScopes(["brain:mail"])).toEqual(["brain:read", "brain:mail"]);
  });

  it("still closes import onto write onto read", () => {
    expect(normalizeScopes(["brain:import"])).toEqual([
      "brain:read",
      "brain:write",
      "brain:import",
    ]);
  });

  it("widens an owner write grant to every scope, mail included", () => {
    expect(ownerEffectiveScopes(["brain:read", "brain:write"])).toEqual([...MCP_SCOPES]);
  });

  it("leaves a read-only grant read-only", () => {
    expect(ownerEffectiveScopes(["brain:read"])).toEqual(["brain:read"]);
  });

  it("advertises all five scopes during connection, and labels every one", () => {
    expect([...MCP_CONNECTION_SCOPES]).toEqual([...MCP_SCOPES]);
    for (const scope of MCP_SCOPES) {
      expect(MCP_SCOPE_LABELS[scope].length).toBeGreaterThan(0);
    }
  });
});

describe("the answer shapes", () => {
  it("puts one JSON text block in every answer", () => {
    const answer = text({ ok: true });
    expect(answer.content).toHaveLength(1);
    expect(answer.content[0].type).toBe("text");
    expect(JSON.parse(answer.content[0].text)).toEqual({ ok: true });
  });

  it("marks a domain refusal as an error an agent can read", () => {
    const answer = refusal("agent sending is off", "turn it on in Settings, Connections");
    expect(answer.isError).toBe(true);
    expect(JSON.parse(answer.content[0].text)).toEqual({
      error: "agent sending is off",
      reason: "turn it on in Settings, Connections",
    });
  });

  it("carries a reason on every refusal, so an agent branches on one field", () => {
    // The shape is not optional any more: the task tools used to answer a
    // bare code in `error`, and an agent had three shapes to tell apart on
    // one endpoint.
    expect(JSON.parse(refusal("no such account", "account_not_found").content[0].text)).toEqual({
      error: "no such account",
      reason: "account_not_found",
    });
  });

  it("names the missing scope on an insufficient-scope answer", () => {
    const answer = insufficientScope("brain:mail:send");
    expect(answer.isError).toBe(true);
    expect(JSON.parse(answer.content[0].text)).toEqual({
      error: "This connection does not have permission for this tool.",
      reason: "insufficient_scope",
      requiredScope: "brain:mail:send",
    });
  });
});
