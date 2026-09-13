"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Fragment } from "react";

import type { TaskRepeat, TaskView, WeekDay } from "@/lib/tasks/model";

import { weekdayOf } from "./tasks-lists";
import { Icon } from "./ui/icon";

/** THE REPEAT CHIP, AND THE THREE RULES THERE ARE.
 *
 *  Every day, every week on a weekday, every month on a day of the month, and
 *  Don't repeat. No interval field, no end date, no count, and no "this one or
 *  all future" dialog: the dialog is unnecessary by construction, because
 *  editing the rule is the future and editing the instance is this one. A
 *  control that does not exist cannot be asked for.
 *
 *  The weekday and the day of the month are not asked for either. They come
 *  off the day the task is already on, which is the day a person is looking at
 *  when they reach for this menu, so the row reads back as the sentence they
 *  chose: a task sitting on Monday the 15th offers "Every week on Mon" and
 *  "Every month on the 15th". To repeat on another day, move the task and set
 *  the rule there.
 *
 *  The chip names the rule in one word and the menu names what each row would
 *  set, which is why the two do not read the same: a chip has to fit beside
 *  four others in a 76px row, and a menu row has to be unambiguous about the
 *  weekday it is about to commit to.
 */

export type RepeatKind = "daily" | "weekly" | "monthly" | "none";

/** One row of the menu: the words it shows and the rule it would set. */
export interface RepeatOption {
  readonly kind: RepeatKind;
  readonly label: string;
  readonly repeat: TaskRepeat | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The word on the chip. One word, because it sits in a row of chips. */
export function repeatWord(repeat: TaskRepeat | undefined): string {
  if (!repeat) return "Repeat";
  if (repeat.freq === "daily") return "Daily";
  return repeat.freq === "weekly" ? "Weekly" : "Monthly";
}

/** The day a rule set from this row would be built around: the day the task is
 *  already on, or today for one that has no day at all. */
function anchorDay(task: TaskView, today: string): string {
  return DAY_RE.test(task.when ?? "") ? (task.when as string) : today;
}

/** `1st`, `2nd`, `3rd`, `4th`, and the three teens that break the pattern. */
function ordinal(day: number): string {
  const teen = day % 100;
  if (teen >= 11 && teen <= 13) return `${day}th`;
  const last = day % 10;
  if (last === 1) return `${day}st`;
  if (last === 2) return `${day}nd`;
  if (last === 3) return `${day}rd`;
  return `${day}th`;
}

/** The rows this task's menu shows, in order. The stop appears only once
 *  there is a rule to stop: an offer to clear nothing is a dead row. */
export function repeatOptions(task: TaskView, today: string): RepeatOption[] {
  const day = anchorDay(task, today);
  const weekday = weekdayOf(day);
  const monthDay = Number(day.slice(8, 10));
  const options: RepeatOption[] = [
    { kind: "daily", label: "Every day", repeat: { freq: "daily" } },
    {
      kind: "weekly",
      label: `Every week on ${weekday}`,
      // `weekdayOf` writes `Mon` and the rule stores `mon`, which keeps the
      // seven words in one place rather than in a second table here.
      repeat: { freq: "weekly", byWeekday: [weekday.toLowerCase() as WeekDay] },
    },
    {
      kind: "monthly",
      label: `Every month on the ${ordinal(monthDay)}`,
      repeat: { freq: "monthly", byMonthDay: monthDay },
    },
  ];
  if (task.repeat) options.push({ kind: "none", label: "Don't repeat", repeat: null });
  return options;
}

export function TasksRepeatMenu({
  task,
  today,
  onSet,
}: {
  task: TaskView;
  today: string;
  onSet: (repeat: TaskRepeat | null) => void;
}) {
  const options = repeatOptions(task, today);
  const value: RepeatKind = task.repeat ? task.repeat.freq : "none";
  const label = repeatWord(task.repeat);

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          className="chip"
          data-task-control
          aria-label={`Repeat: ${label}`}
        >
          <span className="chip-glyph">
            <Icon name="restart" size={14} />
          </span>
          {label}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="brain-menu z-[var(--z-modal)] w-[220px]"
        >
          <Dropdown.RadioGroup
            value={value}
            onValueChange={(next) => {
              const picked = options.find((option) => option.kind === next);
              if (picked) onSet(picked.repeat);
            }}
          >
            {/* The three rules carry no glyph. They are three grades of one
                rule, so the same drawing three times would say nothing the
                words do not, and the check is what a reader is looking for.
                The reasoning `TasksListMenu` gives its categories. The stop
                does carry one, and the same `close-linear` the When chip's
                Clear row carries. */}
            {options.map((option) => (
              <Fragment key={option.kind}>
                {option.kind === "none" && (
                  <Dropdown.Separator className="brain-menu-sep" />
                )}
                <Dropdown.RadioItem value={option.kind} className="brain-menu-item">
                  {option.kind === "none" && (
                    <Icon name="close-linear" size={16} className="brain-menu-icon" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {value === option.kind && (
                    <Icon name="check-linear" size={14} className="shrink-0 text-ink-2" />
                  )}
                </Dropdown.RadioItem>
              </Fragment>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
