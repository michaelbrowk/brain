import os from "node:os";
import path from "node:path";

/** WHERE THE AGENT STATE LIVES, AS ITS OWN MODULE.
 *
 *  On the pattern `lib/notifications/state-dir.ts` set, so a route test can
 *  redirect the directory with one `vi.mock` without stubbing the log's logic
 *  as well. The activity log re-exports it, so a caller still has one import.
 *
 *  Never the notes folder and never the portable archive: an activity line is
 *  machine state about the notes and the mail, not a note. A person who
 *  restores an archive on a new machine wants their pages back, not last
 *  month's tool calls.
 */

/** The slice of the environment this module reads. `scripts/check-env-docs.mjs`
 *  counts a read only when it is spelled `process.env.NAME`, so the default
 *  names every variable here; tests pass a literal. A narrower type than
 *  NodeJS.ProcessEnv because Next declares NODE_ENV there as required, which a
 *  literal without it fails. */
export interface McpEnv {
  NODE_ENV?: string;
  BRAIN_MCP_STATE_DIR?: string;
}

function processEnv(): McpEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    BRAIN_MCP_STATE_DIR: process.env.BRAIN_MCP_STATE_DIR,
  };
}

export function mcpStateDirectory(env: McpEnv = processEnv()): string {
  if (env.BRAIN_MCP_STATE_DIR) return env.BRAIN_MCP_STATE_DIR;
  if (env.NODE_ENV === "production") return "/var/lib/brain/mcp";
  return path.join(
    /* turbopackIgnore: true */ os.tmpdir(),
    `brain-mcp-${process.getuid?.() ?? "dev"}`,
  );
}
