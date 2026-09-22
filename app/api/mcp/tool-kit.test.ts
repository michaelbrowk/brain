import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAIL_SEND_TOOLS,
  MAIL_TOOLS,
  WRITE_TOOLS,
  clientNameOf,
  insufficientScope,
  refusal,
  text,
  toolScopeOf,
} from "./tool-kit";
import {
  DEFAULT_STATIC_CLIENT_NAME,
  MCP_SCOPES,
  MCP_CONNECTION_SCOPES,
  MCP_SCOPE_LABELS,
  normalizeScopes,
  ownerEffectiveScopes,
  staticClientName,
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

  it("puts the two app writes behind brain:write and leaves the read on the floor", () => {
    expect(toolScopeOf("create_app_page")).toBe("brain:write");
    expect(toolScopeOf("write_app_page")).toBe("brain:write");
    expect(toolScopeOf("read_app_page")).toBeNull();
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
    const answer = refusal(
      "agent sending is off, turn it on in Settings, Connections",
      "agent_sending_off",
    );
    expect(answer.isError).toBe(true);
    expect(JSON.parse(answer.content[0].text)).toEqual({
      error: "agent sending is off, turn it on in Settings, Connections",
      reason: "agent_sending_off",
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

describe("the static token's name", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls the static bearer whatever MCP_TOKEN_NAME says, trimmed", async () => {
    vi.stubEnv("MCP_TOKEN_NAME", "  Claude  ");
    expect(staticClientName()).toBe("Claude");
    await expect(
      clientNameOf({ authInfo: { clientId: "brain-legacy-bearer" } }),
    ).resolves.toBe("Claude");
  });

  it("calls it API token when nothing names it", async () => {
    vi.stubEnv("MCP_TOKEN_NAME", "");
    expect(DEFAULT_STATIC_CLIENT_NAME).toBe("API token");
    expect(staticClientName()).toBe("API token");
    await expect(
      clientNameOf({ authInfo: { clientId: "brain-legacy-bearer" } }),
    ).resolves.toBe("API token");
  });

  // A name is drawn in a bell row and in a settings list, so a value that
  // would not draw is not half-used: it falls back whole.
  it.each([
    ["a name past forty characters", "N".repeat(60)],
    ["a name carrying a control character", "Claude"],
    ["a name carrying a newline", "Claude\nand more"],
    ["a name that is only whitespace", "   "],
  ])("falls back to the default for %s", (_case, value) => {
    vi.stubEnv("MCP_TOKEN_NAME", value);
    expect(staticClientName()).toBe("API token");
  });

  it("keeps a forty-character name, and a name of letters outside ASCII", () => {
    vi.stubEnv("MCP_TOKEN_NAME", "N".repeat(40));
    expect(staticClientName()).toBe("N".repeat(40));
    vi.stubEnv("MCP_TOKEN_NAME", "Мишин токен");
    expect(staticClientName()).toBe("Мишин токен");
  });
});
