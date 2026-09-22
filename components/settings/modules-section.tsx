"use client";

// Settings → Modules: the two switches that decide what this installation is.
//
// Off means hidden and stopped, never deleted. Mail keeps its accounts, its
// tokens and its cache and stops syncing and sending; Tasks keeps every
// record under `_tasks/` and every checkbox line in every note, and stops
// drawing a surface, firing a reminder and answering a tool.
//
// Nothing here throws. A switch that failed has to say so beside itself: an
// owner who has just taken Mail away and cannot tell whether it landed is the
// one reader this screen exists for.

import { useState } from "react";
import type { ModuleSwitches } from "@/lib/modules";
import { SettingsGroup, SettingsRow, Segmented } from "./shared";

const SAVE_FAILED = "Couldn't save that. Try again.";
/** The switch landed and the other process did not hear it. Not a failure of
 *  the flip: the setting is the truth, and boot tells the service again. */
const MAIL_SERVICE_SILENT =
  "The mail service did not answer; it will be told again on the next start";

const ROWS: { key: keyof ModuleSwitches; label: string; hint: string }[] = [
  { key: "mail", label: "Mail", hint: "Accounts stay connected; syncing stops." },
  {
    key: "tasks",
    label: "Tasks",
    hint: "Checkboxes in notes keep working; tasks and reminders sleep.",
  },
];

export function ModulesSection({
  modules,
  onToast,
}: {
  /** The live pair, seeded by the server and kept fresh by the shell's SSE
   *  subscription. This section never fetches it: one question, one answer. */
  modules: ModuleSwitches;
  onToast: (title: string) => void;
}) {
  // What the rows show while the server has not answered, and what they show
  // after it has: the answer's own body, not the guess. A PUT naming one key
  // answers the whole pair, so a flip made in another tab while this one was
  // in flight lands here instead of being overwritten by the optimism. Held
  // until the `modules` prop catches up over SSE, and then dropped.
  const [shownOverride, setShownOverride] = useState<ModuleSwitches | null>(null);
  const [pending, setPending] = useState<keyof ModuleSwitches | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // AND THIS IS THE DROPPING, which is the half that was missing.
  //
  // The override outlives its request on purpose: the `modules` prop is a
  // beat behind, because the shell only learns the new pair when the SSE
  // event lands. But once the server has spoken through the prop, the
  // override has nothing left to add, and leaving it makes this screen the
  // one place a later flip cannot reach: tab A turns Tasks off, tab B turns
  // it back on, and tab A's sidebar redraws the Tasks row from the event
  // while this row still reads Off. A screen contradicting the shell around
  // it is the one state it must not hold.
  //
  // Adjusted during render, the way React's own "adjusting state when a prop
  // changes" is written, rather than cleared from an effect: the React
  // compiler's rules forbid a setState in an effect body, and a stale pair
  // must not survive even the single commit an effect would take to clear it.
  // Compared by value and not by identity, so an unrelated re-render carrying
  // a fresh object cannot discard a flip that is still in flight.
  const [serverPair, setServerPair] = useState(modules);
  if (serverPair.mail !== modules.mail || serverPair.tasks !== modules.tasks) {
    setServerPair(modules);
    setShownOverride(null);
  }

  const shown = shownOverride ?? modules;

  const flip = async (key: keyof ModuleSwitches, on: boolean) => {
    if (pending !== null) return;
    setProblem(null);
    setPending(key);
    setShownOverride({ ...shown, [key]: on });
    try {
      const answer = await fetch("/api/settings/modules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: on }),
      });
      const body = (await answer.json()) as {
        mail?: unknown;
        tasks?: unknown;
        reason?: unknown;
        mailService?: unknown;
      };
      if (!answer.ok) {
        setShownOverride(null);
        setProblem(typeof body.reason === "string" ? body.reason : SAVE_FAILED);
        return;
      }
      if (typeof body.mail === "boolean" && typeof body.tasks === "boolean") {
        setShownOverride({ mail: body.mail, tasks: body.tasks });
      } else {
        setShownOverride(null);
      }
      // The switch landed; the other process did not hear it yet. Not a
      // revert: the setting is written and the startup call repairs it.
      if (body.mailService === "unreachable") setProblem(MAIL_SERVICE_SILENT);
      else onToast(on ? `${labelOf(key)} is on` : `${labelOf(key)} is off`);
    } catch {
      setShownOverride(null);
      setProblem(SAVE_FAILED);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-7">
      <SettingsGroup
        title="Modules"
        description="What this Brain runs. Turning one off hides it and stops its background work; nothing is deleted"
      >
        {ROWS.map((row) => (
          <SettingsRow key={row.key} label={row.label} hint={row.hint}>
            <Segmented
              label={row.label}
              value={shown[row.key] ? "on" : "off"}
              // BOTH rows, not just the one in flight. `flip` refuses a
              // second call while one is outstanding, so a switch that still
              // looked live would do nothing and say nothing about it.
              disabled={pending !== null}
              options={[
                { value: "off", label: "Off" },
                { value: "on", label: "On" },
              ]}
              onChange={(next) => void flip(row.key, next === "on")}
            />
          </SettingsRow>
        ))}
        {problem && (
          <SettingsRow stack>
            <p
              role="alert"
              className="max-w-[56ch] text-caption leading-relaxed text-ink-2"
            >
              {problem}
            </p>
          </SettingsRow>
        )}
      </SettingsGroup>
    </div>
  );
}

function labelOf(key: keyof ModuleSwitches): string {
  return key === "mail" ? "Mail" : "Tasks";
}
