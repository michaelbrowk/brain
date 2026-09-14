"use client";

import { useEffect, useRef, useState } from "react";

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
 */
export function TasksGhostRow({
  placeholder = "New task…",
  captureRequest = 0,
  onCreate,
}: {
  placeholder?: string;
  /** Bumped by "New task" from the palette: the caret comes here. */
  captureRequest?: number;
  onCreate: (title: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (captureRequest === 0) return;
    inputRef.current?.focus();
  }, [captureRequest]);

  const create = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    onCreate(title);
  };

  return (
    <li className="brain-task-row-item">
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
              onBlur={create}
            />
          </span>
        </span>
      </div>
    </li>
  );
}
