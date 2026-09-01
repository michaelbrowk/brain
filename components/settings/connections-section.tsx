"use client";

// Connections: the MCP endpoint, OAuth connect, the legacy bearer token,
// connected apps, and the AI-requests note. Session controls live in
// Account.

import { useCallback, useEffect, useState } from "react";
import { Button, IconButton } from "../ui/button";
import { Icon } from "../ui/icon";
import { SettingsGroup, SettingsRow, CopyRow } from "./shared";

type ConnectedApp = {
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: Array<"brain:read" | "brain:write" | "brain:import">;
  connectedAt: number;
};
type McpSettings = {
  endpoint: string;
  token: string;
  oauth: { issuer: string; authorizationEndpoint: string };
  connectedApps: ConnectedApp[];
};
type McpStatus = "idle" | "loading" | "ready" | "error";

const MCP_CONNECTION_CHECK_PROMPT =
  "Use Brain's connection_check tool and tell me whether read and write access are active. Do not change any pages.";

function mcpScopeLabel(scope: ConnectedApp["scopes"][number]): string {
  if (scope === "brain:read") return "Read";
  if (scope === "brain:write") return "Write";
  return "Import";
}

export function ConnectionsSection({
  onToast,
}: {
  onToast: (title: string) => void;
}) {
  const [mcp, setMcp] = useState<McpSettings | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatus>("idle");
  const [revokingGrant, setRevokingGrant] = useState<string | null>(null);

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

  // The section mounts on each visit, so a deferred load per mount keeps the
  // per-visit refresh behaviour the dialog had.
  useEffect(() => {
    const timer = window.setTimeout(() => void loadMcp(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMcp]);

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
            stray hairline while the settings load or fail */}
        {(mcp?.connectedApps.length ?? 0) === 0 && (
          <div className="brain-settings-row">
            <p className="text-table text-ink-3">
              {mcp ? "No apps connected with OAuth yet" : "…"}
            </p>
          </div>
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
