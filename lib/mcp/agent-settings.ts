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

export interface McpAgentSettingsState {
  readonly settings: McpAgentSettings;
  /** True when the file is there and this process could not read it or make
   *  sense of it. A missing file is the first run, not a fault. The send
   *  tools refuse on this: a switch whose whole purpose is to stop an agent
   *  must not be one unreadable file away from being on again. Everything
   *  else keeps reading the defaults, so a bad edit costs no mail. */
  readonly unreadable: boolean;
}

export async function readAgentSettingsState(): Promise<McpAgentSettingsState> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsFile(), "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return {
      settings: MCP_AGENT_SETTINGS_DEFAULT,
      unreadable: code !== "ENOENT",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { settings: MCP_AGENT_SETTINGS_DEFAULT, unreadable: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { settings: MCP_AGENT_SETTINGS_DEFAULT, unreadable: true };
  }
  const value = parsed as Record<string, unknown>;
  // A field the file leaves out or spells wrong is not a file this process
  // failed to read: the object parsed, and the documented default is the
  // answer for that field alone.
  return {
    settings: {
      tellRecipients:
        typeof value.tellRecipients === "boolean"
          ? value.tellRecipients
          : MCP_AGENT_SETTINGS_DEFAULT.tellRecipients,
      allowSending:
        typeof value.allowSending === "boolean"
          ? value.allowSending
          : MCP_AGENT_SETTINGS_DEFAULT.allowSending,
    },
    unreadable: false,
  };
}

/** The settings as the owner's own screens read them. A file nobody can read
 *  answers the documented defaults here, because a bad edit must not empty a
 *  settings page. Anything deciding whether an agent may act asks
 *  `readAgentSettingsState` and honours `unreadable`. */
export async function readAgentSettings(): Promise<McpAgentSettings> {
  return (await readAgentSettingsState()).settings;
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
