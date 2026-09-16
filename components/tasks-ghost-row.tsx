"use client";

import { useEffect, useRef, useState } from "react";

import { whenLabel } from "./tasks-lists";
import { TasksWhenPicker, type WhenValue } from "./tasks-when-picker";
import { Icon } from "./ui/icon";

/** The last request this row has already turned into a focus. Module scope,
 *  not a ref: the row (and the surface around it) fully remounts on every
 *  entry to Tasks, so a ref would reset with it, and every later arrival
 *  (the sidebar row, the tab bar's Tasks slot, the back button) would steal
 *  the caret back, keyboard included on a phone. This is what a fresh mount
 *  checks against, the same way `mail-commands.ts`'s latch outlives the
 *  surface that reads it. */
let lastFocusedCaptureRequest = 0;

/** Reset between tests: the module value outlives a render root. */
export function resetTaskCaptureFocus(): void {
  lastFocusedCaptureRequest = 0;
}

/** THE FIRST ROW OF EVERY LIST.
 *
 *  A capsule the size of a task with an outlined box and the placeholder
 *  where a title goes. It sits at the TOP because new tasks land newest
 *  first: a capture field at the foot would write a row the reader then has
 *  to go and find.
 *
 *  The box is a drawing, not a control, since there is nothing to tick until
 *  the line is a task, so it carries no role and no label, and the input is the
 *  row's only stop in the tab order. 16px on touch, so iOS does not zoom the
 *  page when the caret lands.
 *
 *  IT CARRIES ONE CHIP, the same When picker the written row carries, so a day
 *  can be given to a task before it exists rather than after. Nothing is
 *  required of it: a line typed into Today with no picking still lands today,
 *  because the LIST seeds the create and this only overrides it.
 */
export function TasksGhostRow({
  placeholder = "New task…",
  captureRequest = 0,
  today,
  onCreate,
  onLayer,
}: {
  placeholder?: string;
  /** Bumped by "New task" from the palette: the caret comes here. */
  captureRequest?: number;
  today: string;
  onCreate: (title: string, value: WhenValue) => void;
  /** WHETHER THIS ROW'S PICKER IS STANDING. It is the one layer on this
   *  surface that is not opened by the row it is drawn over, and Escape peels
   *  one layer at a time: the key belongs to this panel, and the expanded task
   *  row below is the next key's. */
  onLayer?: (open: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [when, setWhen] = useState<WhenValue>({
    when: null,
    evening: false,
    time: null,
  });

  useEffect(() => {
    if (captureRequest === 0 || captureRequest === lastFocusedCaptureRequest) return;
    lastFocusedCaptureRequest = captureRequest;
    inputRef.current?.focus();
  }, [captureRequest]);

  const create = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    // The day belonged to the line it was picked for. The next one starts
    // from the list's own seed again.
    setWhen({ when: null, evening: false, time: null });
    onCreate(title, when);
  };

  const chipLabel =
    when.when === null
      ? "When"
      : when.when === today && when.evening
        ? "This Evening"
        : whenLabel(when.when, today);

  return (
    <li
      className="brain-task-row-item"
      // THE CAPTURE IS COMMITTED WHEN THE FOCUS LEAVES THE ROW, not when it
      // leaves the field. Reaching for the When chip blurs the input, and the
      // picker's own popover is portalled to the body, so a create on the
      // field's blur filed every title the moment somebody went to give it a
      // day. Both of those still count as being in this row.
      onBlur={(event) => {
        const next = event.relatedTarget as Element | null;
        if (next?.closest?.(".brain-task-row-item, .brain-when-picker")) return;
        create();
      }}
    >
      <div className="brain-task-row brain-task-row_ghost">
        <span className="brain-task-boxcell">
          <span aria-hidden className="brain-task-box brain-task-box_ghost" />
        </span>
        <span className="brain-task-main">
          <span className="brain-task-line">
            <input
              ref={inputRef}
              aria-label="New task"
              className="brain-task-input"
              dir="auto"
              value={draft}
              placeholder={placeholder}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  create();
                }
                if (event.key === "Escape") setDraft("");
              }}
            />
            <span className="brain-task-tail">
              <TasksWhenPicker
                value={when}
                today={today}
                onPick={setWhen}
                onOpenChange={onLayer}
                ariaLabel={`When: ${chipLabel}${when.time ? ` at ${when.time}` : ""}`}
                trigger={
                  /* THE MARK, so a task row expanded below this one does not
                     read the press that opens this panel as the press that
                     ends it. One dismissal per press: this one was spent
                     opening the picker. `useFoldOnOutside` in `tasks-row.tsx`
                     is what reads it. */
                  <button type="button" className="chip" data-task-control>
                    <span className="chip-glyph">
                      <Icon name="calendar" size={14} />
                    </span>
                    {chipLabel}
                  </button>
                }
              />
            </span>
          </span>
        </span>
      </div>
    </li>
  );
}
