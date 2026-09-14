"use client";

// Settings → Notifications: the one press that turns push on for this
// device, the devices already registered, what a push is allowed to carry,
// and the zone a reminder is read in.
//
// Nothing in here throws. A person opens this section when the notification
// they expected never arrived, so every refusal and every failed request
// lands as a sentence beside the control that produced it. A thrown error
// would blank the one screen that is supposed to explain the silence.

import { useCallback, useEffect, useState } from "react";
import { formatAgo } from "@/lib/format-ago";
import type { PushDeviceView, PushKindPreferences } from "@/lib/push/model";
import { enablePushOnThisDevice, homeScreenRequired, pushSupported } from "../push-client";
import { Button } from "../ui/button";
import { Empty } from "../ui/empty";
import { SettingsGroup, SettingsRow, Segmented } from "./shared";

/** Every sentence the section can say, in one place. Each names the cure,
 *  because a refusal a person cannot act on is the same as no answer. */
const HOME_SCREEN =
  "Add Brain to your Home Screen first. On iPhone and iPad, notifications reach a web app only once it is installed: open the share sheet and pick Add to Home Screen.";
const DENIED =
  "This browser refused notifications. Allow them for Brain in the browser's own settings, then try again.";
const UNSUPPORTED = "This browser cannot receive push notifications.";
const FAILED = "Couldn't turn notifications on. Try again.";
const PRIVACY =
  "A push carries the task's title, or the sender's name and the subject, and nothing else. It is encrypted to the device.";
const NO_ZONE = "No time zone is set, so no reminder will fire. Set one in Account.";
const ZONE_UNREADABLE = "Couldn't read the time zone.";
const NO_DEVICE = "No device is registered yet.";
const NONE_TOOK_IT = "No device took the message. Try again.";
const KIND_OFF = "Task reminders are switched off, so nothing was sent.";
const LOAD_FAILED = "Couldn't load your notification settings.";
const SAVE_FAILED = "Couldn't save that. Try again.";
const TEST_FAILED = "Couldn't send a test. Try again.";

const REASON: Record<"unsupported" | "denied" | "home-screen" | "failed", string> = {
  unsupported: UNSUPPORTED,
  denied: DENIED,
  "home-screen": HOME_SCREEN,
  failed: FAILED,
};

/** What a test press answers with. `skipped` is the server saying it never
 *  tried: the kind is switched off, or nothing is registered. `sent === 0`
 *  with `skipped === null` is a third case: devices exist and every one of
 *  them refused the message, which is not the same silence as none being
 *  registered. */
function testSentence(result: { sent: number; skipped: string | null }): string {
  if (result.skipped === "kind-off") return KIND_OFF;
  if (result.skipped === "no-devices") return NO_DEVICE;
  if (result.sent === 0) return NONE_TOOK_IT;
  if (result.sent === 1) return "Sent to 1 device.";
  return `Sent to ${result.sent} devices.`;
}

/** A sentence the section states rather than a control, in the voice of the
 *  rows around it. */
function Sentence({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-[56ch] text-caption leading-relaxed text-ink-2">{children}</p>
  );
}

export function NotificationsSection({ onToast }: { onToast: (title: string) => void }) {
  const [devices, setDevices] = useState<PushDeviceView[] | null>(null);
  const [kinds, setKinds] = useState<PushKindPreferences | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // What this browser can do, read after mount (see the effect below).
  const [environment, setEnvironment] = useState<{
    supported: boolean;
    homeScreen: boolean;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [kindProblem, setKindProblem] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [zoneStatus, setZoneStatus] = useState<"loading" | "ready" | "error">("loading");

  const loadState = useCallback(async (isAlive: () => boolean = () => true) => {
    try {
      const answer = await fetch("/api/push/state");
      if (!answer.ok) throw new Error(String(answer.status));
      const body = (await answer.json()) as {
        devices: PushDeviceView[];
        kinds: PushKindPreferences;
      };
      if (!isAlive()) return;
      setDevices(body.devices);
      setKinds(body.kinds);
      setLoadFailed(false);
    } catch {
      if (!isAlive()) return;
      setDevices(null);
      setKinds(null);
      setLoadFailed(true);
    }
  }, []);

  // The section mounts on each visit, so a load per mount keeps the surface
  // fresh; the microtask is the same rule as the effect below, no setState
  // synchronously inside an effect body. The `alive` guard reads the same as
  // the zone effect's: a slow load outliving the mount must not setState.
  useEffect(() => {
    let alive = true;
    queueMicrotask(() => void loadState(() => alive));
    return () => {
      alive = false;
    };
  }, [loadState]);

  // Both facts are read after the first render commits, in a microtask and
  // never synchronously in the effect body: `navigator` is absent on the
  // server, so a read while rendering is a hydration mismatch, and a sync
  // setState here is a cascading render.
  useEffect(() => {
    queueMicrotask(() =>
      setEnvironment({
        supported: pushSupported(),
        homeScreen: homeScreenRequired(
          navigator.userAgent,
          (navigator as Navigator & { standalone?: boolean }).standalone,
        ),
      }),
    );
  }, []);

  // The zone the scheduler reads belongs to Account; this section only quotes
  // it, so a failure here says so rather than claiming no zone is set.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const answer = await fetch("/api/settings/zone");
        if (!answer.ok) throw new Error(String(answer.status));
        const body = (await answer.json()) as { timeZone: string | null };
        if (!alive) return;
        setTimeZone(body.timeZone);
        setZoneStatus("ready");
      } catch {
        if (alive) setZoneStatus("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const turnOn = () => {
    setProblem(null);
    setTestResult(null);
    setEnabling(true);
    // THE PRESS REACHES THE PERMISSION PROMPT. Nothing is awaited above this
    // line: iOS grants Notification.requestPermission() only from inside the
    // gesture, and a single await before the call loses it.
    void enablePushOnThisDevice()
      .then((result) => {
        setEnabling(false);
        if (!result.ok) {
          setProblem(REASON[result.reason]);
          return;
        }
        setLoadFailed(false);
        setDevices((list) => [
          result.device,
          ...(list ?? []).filter((device) => device.id !== result.device.id),
        ]);
      })
      .catch(() => {
        // enablePushOnThisDevice is total today and never rejects; this is the
        // fallback if that ever changes, so the button never sticks disabled
        // with no sentence.
        setEnabling(false);
        setProblem(FAILED);
      });
  };

  const removeDevice = async (device: PushDeviceView) => {
    if (removing) return;
    setRemoving(device.id);
    try {
      const answer = await fetch("/api/push/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: device.id }),
      });
      if (!answer.ok) throw new Error(String(answer.status));
      setDevices((list) => (list ?? []).filter((entry) => entry.id !== device.id));
      onToast("Device removed");
    } catch {
      onToast("Couldn't remove that device. Try again.");
    } finally {
      setRemoving(null);
    }
  };

  const setKind = async (kind: keyof PushKindPreferences, on: boolean) => {
    if (!kinds) return;
    const previous = kinds;
    setKindProblem(null);
    setKinds({ ...kinds, [kind]: on });
    try {
      const answer = await fetch("/api/push/state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kinds: { [kind]: on } }),
      });
      if (!answer.ok) throw new Error(String(answer.status));
      const body = (await answer.json()) as { kinds: PushKindPreferences };
      setKinds(body.kinds);
    } catch {
      setKinds(previous);
      setKindProblem(SAVE_FAILED);
    }
  };

  const sendTest = async () => {
    if (testing) return;
    setTesting(true);
    try {
      const answer = await fetch("/api/push/test", { method: "POST" });
      if (!answer.ok) throw new Error(String(answer.status));
      const body = (await answer.json()) as {
        sent: number;
        removed: number;
        skipped: string | null;
      };
      setTestResult(testSentence(body));
      // The send dropped subscriptions the push service called gone, so the
      // list on screen is behind the server.
      if (body.removed > 0) await loadState();
    } catch {
      setTestResult(TEST_FAILED);
    } finally {
      setTesting(false);
    }
  };

  const zoneSentence =
    zoneStatus === "error"
      ? ZONE_UNREADABLE
      : zoneStatus === "loading"
        ? "…"
        : timeZone
          ? `Reminders fire on ${timeZone} time.`
          : NO_ZONE;

  const segment = (kind: keyof PushKindPreferences, label: string) => (
    <Segmented
      label={label}
      value={kinds?.[kind] ? "on" : "off"}
      disabled={!kinds}
      options={[
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ]}
      onChange={(next) => void setKind(kind, next === "on")}
    />
  );

  return (
    <div className="space-y-7">
      <SettingsGroup
        title="This device"
        description="Push is turned on once on every device you want notified"
      >
        {environment === null && (
          <SettingsRow label="Push on this device">
            <span className="text-caption text-ink-3">…</span>
          </SettingsRow>
        )}
        {environment?.homeScreen && (
          <SettingsRow stack>
            <Sentence>{HOME_SCREEN}</Sentence>
          </SettingsRow>
        )}
        {environment !== null && !environment.homeScreen && !environment.supported && (
          <SettingsRow stack>
            <Sentence>{UNSUPPORTED}</Sentence>
          </SettingsRow>
        )}
        {environment !== null && !environment.homeScreen && environment.supported && (
          <SettingsRow
            label="Push on this device"
            hint="The browser asks for permission on the press"
          >
            <Button variant="ink" disabled={enabling} onClick={turnOn}>
              Turn on on this device
            </Button>
          </SettingsRow>
        )}
        {problem && (
          <SettingsRow stack>
            <p role="alert" className="max-w-[56ch] text-caption leading-relaxed text-ink-2">
              {problem}
            </p>
          </SettingsRow>
        )}
        <SettingsRow
          label="Test notification"
          hint={testResult ?? "Rings every device in the list below"}
        >
          <Button variant="quiet" disabled={testing} onClick={() => void sendTest()}>
            Send a test
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Devices" description="Remove one and it stops being rung">
        {/* the ring always holds a row: an empty group collapses into a stray
            hairline while the state loads or fails */}
        {loadFailed && (
          <div role="alert" className="brain-settings-row">
            <p className="min-w-0 flex-1 text-table text-ink-2">{LOAD_FAILED}</p>
            <Button variant="quiet" onClick={() => void loadState()}>
              Try again
            </Button>
          </div>
        )}
        {!loadFailed && devices === null && (
          <div className="brain-settings-row">
            <p className="text-table text-ink-3">…</p>
          </div>
        )}
        {devices !== null && devices.length === 0 && (
          <SettingsRow stack>
            <Empty icon="bell-linear" title={NO_DEVICE} className="py-2" />
          </SettingsRow>
        )}
        {devices?.map((device) => (
          <div key={device.id} className="brain-settings-row" data-lead="">
            <div className="min-w-0 flex-1">
              <p className="truncate text-table font-medium text-ink">{device.deviceLabel}</p>
              <p className="truncate text-caption text-ink-3">
                Last seen {formatAgo(device.lastSeenAt)}
              </p>
            </div>
            {/* Remove and Revoke end the same way, in one grammar */}
            <Button
              variant="destructive"
              disabled={removing !== null}
              onClick={() => void removeDevice(device)}
              aria-label={`Remove ${device.deviceLabel}`}
            >
              {removing === device.id ? "Removing…" : "Remove"}
            </Button>
          </div>
        ))}
      </SettingsGroup>

      <div>
        <SettingsGroup title="What gets pushed">
          <SettingsRow label="Task reminders" hint="A reminder you set on a task">
            {segment("task-reminder", "Task reminders")}
          </SettingsRow>
          <SettingsRow label="New mail" hint="Mail from a person, not from a list">
            {segment("mail-new", "New mail")}
          </SettingsRow>
          {kindProblem && (
            <SettingsRow stack>
              <p role="alert" className="max-w-[56ch] text-caption leading-relaxed text-ink-2">
                {kindProblem}
              </p>
            </SettingsRow>
          )}
        </SettingsGroup>
        {/* the one paragraph here long enough to need a measure, at the 56ch
            the AI-requests note settled on */}
        <p className="mt-2.5 max-w-[56ch] text-caption leading-relaxed text-ink-3">{PRIVACY}</p>
      </div>

      <SettingsGroup title="Time zone">
        <div className="brain-settings-row">
          <p className="min-w-0 flex-1 text-table text-ink-2">{zoneSentence}</p>
          {/* Account owns the setting; this row quotes it. A full navigation
              is what the surface already does to leave itself
              (account-section.tsx). */}
          <Button variant="quiet" onClick={() => location.assign("/settings/account")}>
            Account
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}
