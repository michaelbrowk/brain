"use client";

// Account: session controls and the About group. "Log out everywhere" bumps
// the session epoch — it signs out every browser and device, including this
// one, and asks for a second press before firing. About shows the running
// version and the update check's answer from the shared store.

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useMemo, useState } from "react";
import { formatAgo } from "@/lib/format-ago";
import { deviceZone } from "../tasks-client";
import { Button, IconButton } from "../ui/button";
import { Field } from "../ui/field";
import { Icon } from "../ui/icon";
import { ScrollEdge } from "../ui/scroll-edge";
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

/** The one zone this notebook keeps, and the two ways to change it: pick a
 *  name, or hand the server the one this browser reports. The picker is the
 *  category picker's construction (a popover, a field, a filtered list of
 *  menu items), because a long list of names filtered by typing is the same
 *  control whichever list it holds. */
function ZoneRow({
  zone,
  onSet,
  onToast,
}: {
  /** undefined while the first read is in flight, null when nothing is set. */
  zone: string | null | undefined;
  onSet: (zone: string) => void;
  onToast: (title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // The browser's own list of names, with UTC in front of it. The platform
  // answers canonical regions only, 418 of them, and no Etc/* entry at all, so
  // UTC is a zone the server accepts and the list never offers: a Brain on a
  // server, or a traveller who wants one fixed clock, has to be able to pick
  // it. An old browser may not have the call, and the fallback is this device
  // and UTC, because a control that offers two names beats one that offers
  // none.
  const zones = useMemo(() => {
    try {
      return ["UTC", ...Intl.supportedValuesOf("timeZone")];
    } catch {
      return [deviceZone(), "UTC"].filter((name) => name !== "");
    }
  }, []);

  const save = async (next: string) => {
    setSaving(true);
    try {
      const response = await fetch("/api/settings/zone", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ timeZone: next }),
      });
      if (!response.ok) throw new Error();
      onSet(next);
    } catch {
      // The zone on screen is the one the server still holds, so it stays.
      onToast("Could not save the time zone");
    } finally {
      setSaving(false);
      setOpen(false);
      setDraft("");
    }
  };

  const needle = draft.trim().toLowerCase();
  const filtered = needle
    ? zones.filter((name) => name.toLowerCase().includes(needle))
    : zones;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          {/* `.btn` is nowrap with no overflow of its own, so the name goes in
              a span that can shrink: the longest canonical zone is 30
              characters (`America/Argentina/Buenos_Aires`) and the action
              beside it must survive a 375px phone whole. */}
          <Button variant="quiet" className="min-w-0" disabled={saving}>
            <span className="min-w-0 truncate">
              {zone ?? (zone === null ? "Not set yet" : "…")}
            </span>
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="end"
            sideOffset={6}
            onOpenAutoFocus={(event) => event.preventDefault()}
            className="brain-menu brain-keyboard-popover z-[var(--z-modal)] w-[264px]"
          >
            <div className="brain-keyboard-popover-panel">
              <Field
                on="glass"
                autoFocus
                aria-label="Time zone"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setOpen(false);
                }}
                placeholder="Search zones"
                className="max-md:text-[16px]"
              />
              <ScrollEdge variant="fade" className="mt-1.5 max-h-44">
                {filtered.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => void save(name)}
                    className="brain-menu-item w-full"
                  >
                    {name}
                  </button>
                ))}
              </ScrollEdge>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Button
        variant="quiet"
        className="shrink-0"
        aria-label="Use this device's zone"
        disabled={saving}
        onClick={() => void save(deviceZone())}
      >
        Use this device
      </Button>
    </div>
  );
}

export function AccountSection({
  onToast,
}: {
  onToast: (title: string) => void;
}) {
  const [logoutArmed, setLogoutArmed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [zone, setZone] = useState<string | null | undefined>(undefined);
  const update = useUpdateStatus();

  useEffect(() => {
    let live = true;
    void (async () => {
      let answer: string | null = null;
      try {
        const response = await fetch("/api/settings/zone", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.ok) {
          const body = (await response.json()) as { timeZone?: unknown };
          if (typeof body.timeZone === "string") answer = body.timeZone;
        }
      } catch {
        // A zone that could not be read reads as unset, the same answer the
        // server gives before a client has offered one.
      }
      if (live) setZone(answer);
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="space-y-7">
      <SettingsGroup title="Time zone">
        {/* `stack` because the control is a value and two actions: beside a
            label on a 375px phone the row runs out of width at a zone name of
            about 17 characters, and the group clips rather than scrolls. */}
        <SettingsRow
          stack
          label="Reminders fire in"
          hint="One zone for this notebook, whichever device you are on. Until you pick one, the first browser to open Tasks sets it."
        >
          <ZoneRow zone={zone} onSet={setZone} onToast={onToast} />
        </SettingsRow>
      </SettingsGroup>

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
