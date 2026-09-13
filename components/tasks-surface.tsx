"use client";

// The Tasks canvas: the fourth shell surface, beside notes, mail and
// settings. It owns its own head the way mail does, so the shell draws no
// toolbar over it. The body is a placeholder until the lists land. The
// surface exists here so the route, the sidebar row, the palette entries and
// the tab-bar slot all have something to mount, and the shell is not touched
// again to fill it in.

import { Empty } from "./ui/empty";
import type { TasksListState } from "./shell/helpers";
import type { ToastOptions } from "./ui/primitives";

export interface TasksSurfaceProps {
  /** The open list, or a category view. Navigation state, so Back and
   *  Forward move through it and the shell owns it. */
  list?: TasksListState | null;
  onSelectList?: (list: TasksListState | null) => void;
  onToast?: (title: string, options?: ToastOptions) => void;
  /** Bumped by the shell on every store event of type "task" this tab did
   *  not write itself. A task changed somewhere else (another tab, an MCP
   *  call, the repeat rule advancing one). The list refetches on it. */
  refreshToken?: number;
  /** Bumped by "New task" from the palette: the caret goes to the capture
   *  field. */
  captureRequest?: number;
}

export function TasksSurface({ refreshToken = 0 }: TasksSurfaceProps) {
  return (
    <section
      aria-label="Tasks"
      data-testid="tasks-surface"
      data-refresh-token={refreshToken}
      className="flex min-h-full items-center justify-center px-5"
    >
      <Empty
        icon="checklist-linear"
        title="Tasks"
        hint="The lists arrive with the next change."
      />
    </section>
  );
}
