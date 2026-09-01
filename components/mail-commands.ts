/**
 * Typed window bus between the command palette and the mounted Mail surface.
 * The palette cannot reach MailSurface callbacks through props without
 * threading them across shell.tsx, so it emits a command here and the surface
 * routes it through the same handlers the nav menu uses, behind the same
 * capability gates its rows render against.
 * Mirrors the register of lib/editor-events.ts.
 */

export const MAIL_COMMAND_EVENT = "brain:mail-command";

export const MAIL_COMMANDS = [
  "compose",
  "goto-inbox",
  "goto-starred",
  "goto-unread",
  "goto-lists",
  "goto-people",
  "goto-attachments",
  "goto-drafts",
] as const;

export type MailCommand = (typeof MAIL_COMMANDS)[number];

function isMailCommand(value: unknown): value is MailCommand {
  return (MAIL_COMMANDS as readonly unknown[]).includes(value);
}

export function emitMailCommand(command: MailCommand) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MAIL_COMMAND_EVENT, { detail: command }));
}

/** Subscribe to palette commands. Returns the unsubscribe function. */
export function onMailCommand(
  handler: (command: MailCommand) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isMailCommand(detail)) handler(detail);
  };
  window.addEventListener(MAIL_COMMAND_EVENT, listener);
  return () => window.removeEventListener(MAIL_COMMAND_EVENT, listener);
}
