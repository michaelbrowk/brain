/**
 * Typed window bus between the command palette and the mounted Tasks surface.
 *
 * The two moves a row can make live on two paths: an unmodified key while
 * the capsule is on a row, and a palette row. The palette cannot reach the
 * surface's selection through props without threading it across shell.tsx,
 * and the shell has no business holding a copy of which task is selected, so
 * the palette emits here and the surface applies the command to whatever row
 * its capsule is standing on. A command that arrives with no selection does
 * nothing.
 *
 * Mirrors `components/mail-commands.ts`, which is the same problem solved the
 * same way one surface over.
 */

export const TASK_COMMAND_EVENT = "brain:task-command";

export const TASK_COMMANDS = ["move-today", "move-someday"] as const;

export type TaskCommand = (typeof TASK_COMMANDS)[number];

function isTaskCommand(value: unknown): value is TaskCommand {
  return (TASK_COMMANDS as readonly unknown[]).includes(value);
}

export function emitTaskCommand(command: TaskCommand) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TASK_COMMAND_EVENT, { detail: command }));
}

/** Subscribe to palette commands. Returns the unsubscribe function. */
export function onTaskCommand(handler: (command: TaskCommand) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isTaskCommand(detail)) handler(detail);
  };
  window.addEventListener(TASK_COMMAND_EVENT, listener);
  return () => window.removeEventListener(TASK_COMMAND_EVENT, listener);
}
