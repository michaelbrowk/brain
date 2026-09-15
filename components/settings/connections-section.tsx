"use client";

// Connections: the MCP endpoint, OAuth connect, the legacy bearer token,
// connected apps, what agents may do, what they did, and the AI-requests
// note. Session controls live in Account.
//
// The two agent switches sit here rather than in Notifications because they
// gate what a grant may do, which is what every other row on this surface is
// about; the bell's surface is about what reaches this instance from outside
// it. And the log a person acts on is two rows above the control they act
// with.

import { useCallback, useEffect, useState } from "react";
import { formatAgo } from "@/lib/format-ago";
import { Button, IconButton } from "../ui/button";
import { Empty } from "../ui/empty";
import { Icon } from "../ui/icon";
import { SettingsGroup, SettingsRow, CopyRow, Segmented } from "./shared";

type ConnectedApp = {
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: Array<
    "brain:read" | "brain:write" | "brain:import" | "brain:mail" | "brain:mail:send"
  >;
  connectedAt: number;
};
type McpSettings = {
  endpoint: string;
  token: string;
  oauth: { issuer: string; authorizationEndpoint: string };
  connectedApps: ConnectedApp[];
};
type McpStatus = "idle" | "loading" | "ready" | "error";

/** One line of the agent log, the shape `lib/mcp/activity-log.ts` writes.
 *  Declared here rather than imported, the way `ConnectedApp` above is: that
 *  module opens files, and a client component has no business importing it
 *  even for a type. */
type McpActivityEntry = {
  at: string;
  client: string;
  tool: string;
  accountId?: string;
  threadId?: string;
  messageId?: string;
  attachmentId?: string;
  page?: string;
  task?: string;
  operationId?: string;
  change?: string;
  outcome: string;
};
type McpAgentSettings = { tellRecipients: boolean; allowSending: boolean };
/** The switches as the route answers them, with the one thing that is not a
 *  switch: whether the file holding them could be read at all. */
type McpAgentState = McpAgentSettings & { unreadable: boolean };

const MCP_CONNECTION_CHECK_PROMPT =
  "Use Brain's connection_check tool and tell me whether read and write access are active. Do not change any pages.";

const SAVE_FAILED = "Couldn't save that. Try again.";
/** What the send tools do with an unreadable settings file, said on the
 *  screen they point the owner at. A switch whose whole purpose is to stop an
 *  agent fails closed, so the row reads Off and says why.
 *
 *  Both rows carry the sentence while the file is unreadable, and both are
 *  held still: the values on screen are the documented defaults standing in
 *  for a file that did not answer, so a write of either of them is a write of
 *  a guess. */
const SENDING_HINT = "Off refuses every agent send before the mail service is reached";
const UNREADABLE_HINT =
  "The saved switches could not be read, so every agent send is refused and neither switch can be set until Brain can read that file again";
const NO_APPS = "No apps connected with OAuth yet";
const NO_ACTIVITY = "No agent activity yet";

/** Brain is a single-owner service, so an owner write grant reaches the whole
 *  owner API whatever words were stored on it (`ownerEffectiveScopes`).
 *  `listConnectedApps` sends what a grant can reach rather than what it asked
 *  for, because the one screen a person revokes from must not understate what
 *  it is revoking: a grant minted before 0.11.0 can send mail. */
function mcpScopeLabel(scope: ConnectedApp["scopes"][number]): string {
  if (scope === "brain:read") return "Read";
  if (scope === "brain:write") return "Write";
  if (scope === "brain:mail") return "Mail";
  if (scope === "brain:mail:send") return "Send mail";
  return "Import";
}

/** Which record a line touched, if it names one: the thread a mail triage
 *  changed, or the page or task a task write changed. Shown by its head the
 *  same way the account id is, so a line like `update_task` says what it
 *  touched instead of ending at the outcome. */
function activityTarget(entry: McpActivityEntry): string | undefined {
  return entry.threadId ?? entry.page ?? entry.task;
}

/** The second line of a log row: which mutation, which account, which
 *  record, how it ended. The account and the record are shown by their
 *  head, the way the legacy bearer token above is, because the whole string
 *  names nothing a person reads. */
function activityDetail(entry: McpActivityEntry): string {
  const parts: string[] = [];
  if (entry.change) parts.push(entry.change);
  if (entry.accountId) parts.push(`${entry.accountId.slice(0, 12)}…`);
  const target = activityTarget(entry);
  if (target) parts.push(`${target.slice(0, 12)}…`);
  parts.push(entry.outcome);
  return parts.join(" · ");
}

export function ConnectionsSection({
  onToast,
}: {
  onToast: (title: string) => void;
}) {
  const [mcp, setMcp] = useState<McpSettings | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatus>("idle");
  const [revokingGrant, setRevokingGrant] = useState<string | null>(null);
  const [activity, setActivity] = useState<McpActivityEntry[]>([]);
  // The documented defaults stand in while the read is in flight, so the
  // switches never draw in a position the server never held.
  const [agent, setAgent] = useState<McpAgentState>({
    tellRecipients: false,
    allowSending: true,
    unreadable: false,
  });
  const [savingAgent, setSavingAgent] = useState(false);

  const loadMcp = useCallback(async () => {
    setMcpStatus("loading");
    try {
      const response = await fetch("/api/settings/mcp");
      if (!response.ok) throw new Error(String(response.status));
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("endpoint" in payload) ||
        !("token" in payload) ||
        !("oauth" in payload) ||
        !("connectedApps" in payload) ||
        typeof payload.endpoint !== "string" ||
        typeof payload.token !== "string" ||
        typeof payload.oauth !== "object" ||
        payload.oauth === null ||
        !("issuer" in payload.oauth) ||
        !("authorizationEndpoint" in payload.oauth) ||
        typeof payload.oauth.issuer !== "string" ||
        typeof payload.oauth.authorizationEndpoint !== "string" ||
        !Array.isArray(payload.connectedApps) ||
        !payload.endpoint
      ) {
        throw new Error("invalid MCP settings");
      }
      setMcp({
        endpoint: payload.endpoint,
        token: payload.token,
        oauth: {
          issuer: payload.oauth.issuer,
          authorizationEndpoint: payload.oauth.authorizationEndpoint,
        },
        connectedApps: payload.connectedApps as ConnectedApp[],
      });
      setMcpStatus("ready");
    } catch {
      setMcp(null);
      setMcpStatus("error");
    }
  }, []);

  const loadAgent = useCallback(async () => {
    // Neither read blanks the section when it fails. A log that cannot be read
    // says so with its empty row, and the switches keep the documented
    // defaults: this is the surface a person opens to understand a connection,
    // and a blank one explains nothing.
    try {
      const answer = await fetch("/api/settings/mcp-activity");
      if (!answer.ok) throw new Error(String(answer.status));
      const body = (await answer.json()) as { entries: McpActivityEntry[] };
      setActivity(Array.isArray(body.entries) ? body.entries : []);
    } catch {
      setActivity([]);
    }
    try {
      const answer = await fetch("/api/settings/mcp-agent");
      if (!answer.ok) throw new Error(String(answer.status));
      const body = (await answer.json()) as McpAgentState;
      setAgent({
        tellRecipients: body.tellRecipients === true,
        allowSending: body.allowSending === true,
        unreadable: body.unreadable === true,
      });
    } catch {
      // keep the defaults already on screen
    }
  }, []);

  // The section mounts on each visit, so a deferred load per mount keeps the
  // per-visit refresh behaviour the dialog had.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadMcp();
      void loadAgent();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadMcp, loadAgent]);

  const revokeConnectedApp = async (grantId: string) => {
    if (!mcp || revokingGrant) return;
    setRevokingGrant(grantId);
    try {
      const response = await fetch("/api/settings/mcp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setMcp({
        ...mcp,
        connectedApps: mcp.connectedApps.filter((app) => app.grantId !== grantId),
      });
      onToast("Access revoked");
    } catch {
      onToast("Couldn't revoke access. Try again.");
    } finally {
      setRevokingGrant(null);
    }
  };

  /** Each switch says what it now means rather than that it was saved: the
   *  owner threw it to change what an agent may do, and the sentence is the
   *  new rule.
   *
   *  The request names the one switch that was thrown. It used to carry both,
   *  spread off the state on screen, so throwing one row wrote the other row's
   *  drawn value back as though the owner had set it. */
  const saveAgent = async (patch: Partial<McpAgentSettings>, said: string) => {
    if (savingAgent || agent.unreadable) return;
    const previous = agent;
    setSavingAgent(true);
    setAgent({ ...agent, ...patch, unreadable: false });
    try {
      const response = await fetch("/api/settings/mcp-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(String(response.status));
      // Adopted the way `notifications-section.tsx`'s own switches adopt
      // theirs: the route echoes what it wrote, and that is the value on
      // screen from here, not the optimistic guess that is already showing.
      const body = (await response.json()) as McpAgentState;
      setAgent({
        tellRecipients: body.tellRecipients === true,
        allowSending: body.allowSending === true,
        unreadable: body.unreadable === true,
      });
      onToast(said);
    } catch {
      setAgent(previous);
      onToast(SAVE_FAILED);
    } finally {
      setSavingAgent(false);
    }
  };

  const clearActivity = async () => {
    try {
      const response = await fetch("/api/settings/mcp-activity", { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      setActivity([]);
      onToast("Agent activity cleared");
    } catch {
      onToast(SAVE_FAILED);
    }
  };

  const copy = async (v: string, label: string) => {
    try {
      await navigator.clipboard.writeText(v);
      onToast(label);
    } catch {
      onToast("Couldn't copy. Try again.");
    }
  };

  return (
    <div aria-busy={mcpStatus === "loading"} className="space-y-7">
      {mcpStatus === "loading" && (
        <p role="status" className="sr-only">
          Loading MCP settings
        </p>
      )}
      {mcpStatus === "error" && (
        <div role="alert" className="brain-settings-group">
          <div className="brain-settings-row">
            <p className="min-w-0 flex-1 text-table text-ink-2">
              Couldn&apos;t load MCP settings.
            </p>
            <Button variant="quiet" onClick={() => void loadMcp()}>
              Try again
            </Button>
          </div>
        </div>
      )}
      <SettingsGroup
        title="MCP server"
        description="Connect Claude and other MCP clients to your notes"
      >
        <SettingsRow
          label="Connect with OAuth"
          hint="Your client opens Brain so you can approve its access"
          stack
        >
          <CopyRow
            label="Copy endpoint"
            value={mcp?.endpoint ?? "…"}
            onCopy={() => mcp && copy(mcp.endpoint, "Endpoint copied")}
            disabled={!mcp}
          />
        </SettingsRow>
        <SettingsRow label="Connect Claude Code" stack>
          <CopyRow
            label="Copy Claude Code command"
            mono
            value={
              mcp
                ? `claude mcp add brain --scope user --transport http ${mcp.endpoint}`
                : "…"
            }
            onCopy={() =>
              mcp &&
              copy(
                `claude mcp add brain --scope user --transport http ${mcp.endpoint}`,
                "Command copied",
              )
            }
            disabled={!mcp}
          />
        </SettingsRow>
        <SettingsRow
          label="Verify connection"
          hint="Checks authentication and read access without changing your notes"
          stack
        >
          <CopyRow
            label="Copy verification prompt"
            value={MCP_CONNECTION_CHECK_PROMPT}
            onCopy={() =>
              copy(MCP_CONNECTION_CHECK_PROMPT, "Verification prompt copied")
            }
          />
        </SettingsRow>
        {mcp?.token && (
          <SettingsRow
            label="Legacy bearer token"
            hint="Full access. Keep it only for clients that do not support OAuth yet"
            stack
          >
            <CopyRow
              label="Copy legacy bearer token"
              value={mcp.token.slice(0, 12) + "…"}
              onCopy={() => copy(mcp.token, "Token copied")}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
      <SettingsGroup
        title="Connected apps"
        description="Revoke access without changing your Brain password"
        action={
          <IconButton
            size={28}
            aria-label="Refresh connected apps"
            title="Refresh"
            onClick={() => void loadMcp()}
            disabled={mcpStatus === "loading"}
          >
            <Icon
              name="restart-linear"
              size={16}
              className={
                mcpStatus === "loading" ? "motion-safe:animate-spin" : undefined
              }
            />
          </IconButton>
        }
      >
        {/* the ring always holds a row — an empty group collapses into a
            stray hairline while the settings load or fail. Same shape the
            Agent activity group below uses, so the pane keeps one
            empty-state grammar rather than two. */}
        {(mcp?.connectedApps.length ?? 0) === 0 && (
          <SettingsRow stack>
            <Empty
              icon="plug-circle-linear"
              title={mcp ? NO_APPS : "…"}
              className="py-2"
            />
          </SettingsRow>
        )}
        {mcp?.connectedApps.map((app) => (
          <div key={app.grantId} className="brain-settings-row" data-lead="">
            <div className="min-w-0 flex-1">
              <p className="truncate text-table font-semibold text-ink">
                {app.clientName}
              </p>
              <p className="truncate text-caption text-ink-3">
                {app.scopes.map(mcpScopeLabel).join(" · ")}
              </p>
            </div>
            {/* Revoke and Remove account end the same way — one grammar */}
            <Button
              variant="destructive"
              disabled={revokingGrant !== null}
              onClick={() => void revokeConnectedApp(app.grantId)}
              aria-label={`Revoke access for ${app.clientName}`}
            >
              {revokingGrant === app.grantId ? "Revoking…" : "Revoke"}
            </Button>
          </div>
        ))}
      </SettingsGroup>
      <SettingsGroup
        title="What agents may do"
        description="Narrow a connection without revoking it"
      >
        <SettingsRow
          label="Tell recipients when an agent writes"
          hint={
            agent.unreadable
              ? UNREADABLE_HINT
              : "Adds a line to the outgoing message saying an agent wrote it"
          }
        >
          <Segmented
            label="Tell recipients when an agent writes"
            value={agent.tellRecipients ? "on" : "off"}
            disabled={savingAgent || agent.unreadable}
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            onChange={(next) =>
              void saveAgent(
                { tellRecipients: next === "on" },
                next === "on" ? "Recipients will be told" : "Recipients will not be told",
              )
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Let agents send mail"
          hint={agent.unreadable ? UNREADABLE_HINT : SENDING_HINT}
        >
          <Segmented
            label="Let agents send mail"
            value={agent.allowSending && !agent.unreadable ? "on" : "off"}
            disabled={savingAgent || agent.unreadable}
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            onChange={(next) =>
              void saveAgent(
                { allowSending: next === "on" },
                next === "on" ? "Agents can send mail" : "Agents can no longer send mail",
              )
            }
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        title="Agent activity"
        description="What agents changed through MCP. Reads are not listed"
        action={
          <Button
            variant="quiet"
            aria-label="Clear agent activity"
            disabled={activity.length === 0}
            onClick={() => void clearActivity()}
          >
            Clear
          </Button>
        }
      >
        {/* the ring always holds a row, the same rule the grants keep above */}
        {activity.length === 0 && (
          <SettingsRow stack>
            <Empty icon="history-2-linear" title={NO_ACTIVITY} className="py-2" />
          </SettingsRow>
        )}
        {activity.map((entry, index) => (
          <div
            // The list is replaced wholesale on every load and clear, never
            // patched in place, so the index is safe here and closes the gap
            // `at` alone leaves: a batch can write two lines with the same
            // millisecond, tool and outcome.
            key={`${entry.at}|${entry.tool}|${entry.outcome}|${index}`}
            data-testid="mcp-activity-row"
            className="brain-settings-row"
            data-lead=""
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-table text-ink-2">
                {entry.client} · {entry.tool}
              </p>
              <p className="truncate text-caption text-ink-3">{activityDetail(entry)}</p>
            </div>
            <time
              dateTime={entry.at}
              className="text-caption shrink-0 tabular-nums text-ink-3"
            >
              {formatAgo(entry.at, { compact: true })}
            </time>
          </div>
        ))}
      </SettingsGroup>
      <div>
        <h3 className="text-h3 text-ink">AI requests</h3>
        {/* the one paragraph on the surface long enough to need a measure:
            at the group's full width it ran ~109 characters a line. The ch
            unit is the zero's advance, not this face's average, so 60ch set
            the longest line to 77 — over the readable ceiling. 56ch measures
            424px, whose longest line is 72. A group description is one line
            and never reaches the ceiling, so this is not the return of the
            52ch islands. */}
        <p className="mt-0.5 max-w-[56ch] text-caption leading-relaxed text-ink-3">
          Inline AI sends your selected text, up to 12,000 characters, to
          OpenRouter. Smart sort and emoji suggestions send only the page
          titles and IDs they need.
        </p>
      </div>
    </div>
  );
}
