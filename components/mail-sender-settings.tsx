"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";
import { SettingsGroup, SettingsRow, Segmented } from "./settings/shared";
import {
  defaultMailSurfaceClient,
  MailApiError,
  type MailSurfaceClient,
} from "./mail-surface-client";
import type {
  MailBlockedSender,
  MailSenderScreenState,
} from "@/lib/mail/message-types";

type SenderSettingsClient = Pick<
  MailSurfaceClient,
  | "getSenderScreenState"
  | "setSenderScreenEnabled"
  | "listBlockedSenders"
  | "undoSenderDecision"
>;

const SCREEN_LABEL = "Screen new senders";

/**
 * Settings › Mail, under the accounts: the new-senders switch and the Blocked
 * senders list.
 *
 * The switch is the settings surface's two-segment control, writing once and
 * disabled while its write is out, and its toast names the rule it now keeps
 * rather than reporting a save. Turning it on shows nothing more here: the
 * service works out who is already known in the background, and until it has
 * nothing waits.
 *
 * The list is every blocked address and domain with Unblock, which removes
 * the decision and leaves the mail it archived where it is (the toast in the
 * column is the way to put a block's mail back; this is for the next letter).
 * A screen that cannot be reached leaves no trace here at all, the way the
 * palette answers the same 503: a row that can only apologise is worse than
 * none.
 */
export function MailSenderSettings({
  client = defaultMailSurfaceClient,
  onToast,
}: {
  client?: SenderSettingsClient;
  onToast: (title: string) => void;
}) {
  const [screen, setScreen] = useState<MailSenderScreenState | null>(null);
  const [blocked, setBlocked] = useState<readonly MailBlockedSender[] | null>(null);
  const [writing, setWriting] = useState(false);
  const [unblocking, setUnblocking] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    client.getSenderScreenState(controller.signal).then(
      (state) => {
        if (!controller.signal.aborted) setScreen(state);
      },
      () => {},
    );
    client.listBlockedSenders(controller.signal).then(
      (list) => {
        if (!controller.signal.aborted) setBlocked(list.blocked);
      },
      () => {},
    );
    return () => controller.abort();
  }, [client]);

  const switchScreen = useCallback(
    async (enabled: boolean) => {
      if (writing || screen === null || screen.enabled === enabled) return;
      setWriting(true);
      try {
        setScreen(await client.setSenderScreenEnabled(enabled));
        onToast(enabled ? "New senders wait for you" : "New senders come straight in");
      } catch {
        onToast("Couldn’t change that. Try again.");
      } finally {
        setWriting(false);
      }
    },
    [client, onToast, screen, writing],
  );

  const unblock = useCallback(
    async (entry: MailBlockedSender) => {
      setUnblocking((current) => new Set(current).add(entry.decisionId));
      const drop = () =>
        setBlocked((current) =>
          current === null
            ? current
            : current.filter((each) => each.decisionId !== entry.decisionId),
        );
      try {
        await client.undoSenderDecision({ decisionId: entry.decisionId, restore: false });
        drop();
        onToast(`Unblocked ${entry.key}`);
      } catch (error) {
        // Gone already: undone from its toast, or unblocked in another tab.
        if (error instanceof MailApiError && error.status === 404) drop();
        else onToast(`Couldn’t unblock ${entry.key}. Try again.`);
      } finally {
        setUnblocking((current) => {
          const next = new Set(current);
          next.delete(entry.decisionId);
          return next;
        });
      }
    },
    [client, onToast],
  );

  if (screen === null) return null;
  return (
    <>
      <SettingsGroup
        title="New senders"
        description="A first letter from someone you have never written with waits at the top of Mail until you accept or block them."
      >
        <SettingsRow label={SCREEN_LABEL}>
          <Segmented
            label={SCREEN_LABEL}
            value={screen.enabled ? "on" : "off"}
            disabled={writing}
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            onChange={(value) => void switchScreen(value === "on")}
          />
        </SettingsRow>
      </SettingsGroup>
      {blocked !== null && (
        <SettingsGroup
          title="Blocked senders"
          description="Their next letters are archived as they arrive. Unblocking lets them in again. Old mail stays where it is."
        >
          {blocked.length === 0 ? (
            <SettingsRow stack>
              <Empty icon="user-block-rounded-linear" title="Nobody is blocked" className="py-2" />
            </SettingsRow>
          ) : (
            blocked.map((entry) => (
              <div key={entry.decisionId} className="brain-settings-row">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-table font-semibold text-ink">{entry.key}</p>
                  <p className="truncate text-caption text-ink-3">{blockedCaption(entry)}</p>
                </div>
                <Button
                  type="button"
                  variant="quiet"
                  className="shrink-0"
                  aria-label={`Unblock ${entry.key}`}
                  disabled={unblocking.has(entry.decisionId)}
                  onClick={() => void unblock(entry)}
                >
                  Unblock
                </Button>
              </div>
            ))
          )}
        </SettingsGroup>
      )}
    </>
  );
}

/** What the block covers, since when, and what it has moved so far. */
function blockedCaption(entry: MailBlockedSender): string {
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(entry.decidedAt));
  const parts = [
    entry.scope === "domain" ? `Everyone at this domain, blocked ${date}` : `Blocked ${date}`,
  ];
  if (entry.archivedCount > 0) {
    parts.push(
      entry.archivedCount === 1 ? "1 letter archived" : `${entry.archivedCount} letters archived`,
    );
  }
  return parts.join(" · ");
}
