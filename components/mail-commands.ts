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

/**
 * THE ASK THAT OUTLIVES THE ROUTE.
 *
 * A command above is heard only by a surface already on screen. The New menu's
 * Message row is drawn on every surface, so from a page or from Home the ask
 * arrives before Mail has mounted and an event would be shouted at an empty
 * room. This is a latch instead: the shell opens Mail and leaves the ask
 * standing, and the surface takes it the moment it has accounts to compose
 * from. A mounted surface hears it through the same call, on the notification
 * below, so there is one entry point and not two.
 *
 * It is a flag rather than a queue on purpose. Two presses before Mail arrives
 * are one composer, which is what a reader who pressed twice wanted.
 */
let composeRequested = false;
const composeListeners = new Set<() => void>();

export function requestCompose(): void {
  composeRequested = true;
  for (const listener of composeListeners) listener();
}

export function pendingComposeRequest(): boolean {
  return composeRequested;
}

export function clearComposeRequest(): void {
  composeRequested = false;
}

export function subscribeComposeRequest(listener: () => void): () => void {
  composeListeners.add(listener);
  return () => {
    composeListeners.delete(listener);
  };
}
