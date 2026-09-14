import os from "node:os";
import path from "node:path";

/** WHERE THE CENTRE LIVES, AS ITS OWN MODULE.
 *
 *  Split out of `store.ts` so a route test can redirect the directory with one
 *  `vi.mock` without stubbing the store's logic as well. The store re-exports
 *  it, so a caller still has one import.
 */

/** The slice of the environment this module reads. `scripts/check-env-docs.mjs`
 *  counts a read only when it is spelled `process.env.NAME`, so the default
 *  names every variable here; tests pass a literal. A narrower type than
 *  NodeJS.ProcessEnv because Next declares NODE_ENV there as required, which a
 *  literal without it fails. */
export interface NotificationEnv {
  NODE_ENV?: string;
  BRAIN_NOTIFICATIONS_STATE_DIR?: string;
}

function processEnv(): NotificationEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    BRAIN_NOTIFICATIONS_STATE_DIR: process.env.BRAIN_NOTIFICATIONS_STATE_DIR,
  };
}

export function notificationStateDirectory(env: NotificationEnv = processEnv()): string {
  if (env.BRAIN_NOTIFICATIONS_STATE_DIR) return env.BRAIN_NOTIFICATIONS_STATE_DIR;
  if (env.NODE_ENV === "production") return "/var/lib/brain/notifications";
  return path.join(
    /* turbopackIgnore: true */ os.tmpdir(),
    `brain-notifications-${process.getuid?.() ?? "dev"}`,
  );
}
