import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "@/lib/store/atomic";
import { mcpStateDirectory } from "./state-dir";

/** THE TWO THINGS THE OWNER CAN TURN OFF WITHOUT REVOKING A GRANT.
 *
 *  Beside the activity log, under the same 0700 directory: the log says what
 *  an agent did and these say what it may do next, so a person acting on what
 *  they read is reaching for a control in the same place.
 *
 *  Revoking the grant is the heavy answer and costs the agent its notes too.
 *  `allowSending` is the light one.
 */

export const MCP_AGENT_SETTINGS_FILE = "agent-settings.json";

export interface McpAgentSettings {
  /** Add a line to an outgoing message saying an agent wrote it. Off by
   *  default: it is the owner's mail, under the owner's name. */
  readonly tellRecipients: boolean;
  /** On by default. Off refuses `send_mail` and `reply_mail` before the mail
   *  client is touched. */
  readonly allowSending: boolean;
}

export const MCP_AGENT_SETTINGS_DEFAULT: McpAgentSettings = {
  tellRecipients: false,
  allowSending: true,
};

function settingsFile(): string {
  return path.join(mcpStateDirectory(), MCP_AGENT_SETTINGS_FILE);
}

export async function readAgentSettings(): Promise<McpAgentSettings> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(settingsFile(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return MCP_AGENT_SETTINGS_DEFAULT;
    }
    const value = parsed as Record<string, unknown>;
    return {
      tellRecipients:
        typeof value.tellRecipients === "boolean"
          ? value.tellRecipients
          : MCP_AGENT_SETTINGS_DEFAULT.tellRecipients,
      allowSending:
        typeof value.allowSending === "boolean"
          ? value.allowSending
          : MCP_AGENT_SETTINGS_DEFAULT.allowSending,
    };
  } catch {
    // A missing file is the first run. A file this process cannot read or
    // parse is one a person edited badly, and a bad edit must not stop mail:
    // the answer is the documented default, not a throw.
    return MCP_AGENT_SETTINGS_DEFAULT;
  }
}

export async function writeAgentSettings(
  next: McpAgentSettings,
): Promise<McpAgentSettings> {
  const value: McpAgentSettings = {
    tellRecipients: next.tellRecipients === true,
    allowSending: next.allowSending === true,
  };
  const dir = mcpStateDirectory();
  await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, MCP_AGENT_SETTINGS_FILE);
  await atomicWrite(file, JSON.stringify(value) + "\n");
  // atomicWrite opens the temp file with the process umask, which on a
  // developer machine is 0022. The systemd unit sets UMask=0077 so production
  // already lands at 0600; this makes the mode the same everywhere.
  await fs.chmod(/* turbopackIgnore: true */ file, 0o600);
  return value;
}
