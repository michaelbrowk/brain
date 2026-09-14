import os from "node:os";
import path from "node:path";

/** WHERE PUSH STATE LIVES, AS ITS OWN MODULE.
 *
 *  Split out of `store.ts` on the pattern `lib/notifications/state-dir.ts`
 *  set, so a route test can redirect the directory with one `vi.mock` without
 *  stubbing the store's logic as well. The store re-exports it, so a caller
 *  still has one import.
 */

/** The slice of the environment this module reads. `scripts/check-env-docs.mjs`
 *  counts a read only when it is spelled `process.env.NAME`, so the default
 *  names every variable here; tests pass a literal. A narrower type than
 *  NodeJS.ProcessEnv because Next declares NODE_ENV there as required, which a
 *  literal without it fails. */
export interface PushEnv {
  NODE_ENV?: string;
  BRAIN_PUSH_STATE_DIR?: string;
}

function processEnv(): PushEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    BRAIN_PUSH_STATE_DIR: process.env.BRAIN_PUSH_STATE_DIR,
  };
}

export function pushStateDirectory(env: PushEnv = processEnv()): string {
  if (env.BRAIN_PUSH_STATE_DIR) return env.BRAIN_PUSH_STATE_DIR;
  if (env.NODE_ENV === "production") return "/var/lib/brain/push";
  return path.join(
    /* turbopackIgnore: true */ os.tmpdir(),
    `brain-push-${process.getuid?.() ?? "dev"}`,
  );
}
