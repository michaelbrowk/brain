"use client";

// Account: session controls and the About group. "Log out everywhere" bumps
// the session epoch — it signs out every browser and device, including this
// one, and asks for a second press before firing. About shows the running
// version and the update check's answer from the shared store.

import { useState } from "react";
import { formatAgo } from "@/lib/format-ago";
import { Button, IconButton } from "../ui/button";
import { Icon } from "../ui/icon";
import { SettingsGroup, SettingsRow } from "./shared";
import { useUpdateStatus, type UpdateLoadState } from "./use-update-status";

function updateHint(state: UpdateLoadState): string {
  if (state.kind === "loading") return "Checking…";
  if (state.kind === "error") return "Could not read the update status";
  const s = state.status;
  if (s.updateCheck === "off") {
    return "Off (BRAIN_UPDATE_CHECK=off). Remove the switch to check once a day.";
  }
  if (s.updateAvailable && s.latest) return `${s.latest.version} is available`;
  if (!s.checkedAt) return "Not checked yet. The first check runs shortly after start.";
  if (s.error) return `Checked ${formatAgo(s.checkedAt)}, GitHub did not answer`;
  if (s.version === null && s.latest) {
    // a development build has no version to compare, so name the release
    return `Latest release is ${s.latest.version} · checked ${formatAgo(s.checkedAt)}`;
  }
  return `Up to date · checked ${formatAgo(s.checkedAt)}`;
}

export function AccountSection({
  onToast,
}: {
  onToast: (title: string) => void;
}) {
  const [logoutArmed, setLogoutArmed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const update = useUpdateStatus();

  return (
    <div className="space-y-7">
      <SettingsGroup title="Sessions">
        <SettingsRow
          label="Log out everywhere"
          hint="Signs out every browser and device, including this one. Share links and connected apps stay untouched"
        >
          <Button
            variant="destructive"
            disabled={loggingOut}
            onClick={() => {
              if (!logoutArmed) {
                setLogoutArmed(true);
                // arm expires on its own — no effect-driven reset
                window.setTimeout(
                  () => setLogoutArmed(false),
                  4000,
                );
                return;
              }
              setLoggingOut(true);
              void (async () => {
                try {
                  const response = await fetch("/api/auth", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ scope: "everywhere" }),
                  });
                  if (!response.ok) throw new Error();
                  window.location.assign("/login");
                } catch {
                  setLoggingOut(false);
                  setLogoutArmed(false);
                  onToast?.("Could not log out everywhere");
                }
              })();
            }}
          >
            {loggingOut
              ? "Logging out…"
              : logoutArmed
                ? "Confirm log out"
                : "Log out everywhere"}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="About">
        <SettingsRow
          label={
            update.state.kind === "ready"
              ? update.state.status.version
                ? `Brain ${update.state.status.version}`
                : "Brain (development build)"
              : "Brain"
          }
          hint={
            update.state.kind === "ready" && update.state.status.buildTime
              ? `Built ${new Date(update.state.status.buildTime).toLocaleDateString()}`
              : undefined
          }
        >
          <span className="truncate font-mono text-caption text-ink-2">
            {update.state.kind === "ready"
              ? update.state.status.commit.slice(0, 12)
              : ""}
          </span>
        </SettingsRow>
        <SettingsRow label="Updates" hint={updateHint(update.state)}>
          {update.state.kind === "error" && (
            <Button variant="quiet" onClick={() => void update.retry()}>
              Try again
            </Button>
          )}
          {update.state.kind === "ready" &&
            update.state.status.latest &&
            update.state.status.updateAvailable && (
              <a
                className="text-table underline underline-offset-2"
                href={update.state.status.latest.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                What changed
              </a>
            )}
          {update.state.kind === "ready" &&
            update.state.status.updateCheck === "on" && (
              <IconButton
                size={28}
                aria-label="Check for updates"
                disabled={update.refreshing}
                onClick={() => {
                  void update.refresh().then((ok) => {
                    if (!ok) onToast("Could not check for updates");
                  });
                }}
              >
                <Icon name="restart-linear" size={16} />
              </IconButton>
            )}
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
