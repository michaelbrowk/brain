import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "@/lib/store/atomic";
import { mcpStateDirectory } from "./state-dir";

/** WHAT AN AGENT DID, AND NOTHING ABOUT WHAT IT SAID.
 *
 *  An append-only JSONL beside the other state directories. It is the place a
 *  person looks after handing a connection their mail, so it has to be
 *  readable without being a second copy of the mailbox.
 *
 *  The entry shape below is the redaction. There is no field a subject, an
 *  address, a body or a title could enter through, and `appendMcpActivity`
 *  writes the named fields one by one, so a caller that hands it an extra key
 *  does not put that key on disk.
 */

export type { McpEnv } from "./state-dir";
export { mcpStateDirectory } from "./state-dir";

export const MCP_ACTIVITY_FILE = "mcp-activity.jsonl";

/** 2000 lines of ids is under 400 KB, which is small enough to read whole on
 *  every append and still be the file a person scrolls. */
export const MCP_ACTIVITY_MAX_LINES = 2000;

/** An outcome is a code, not a sentence a mail server wrote. Bounded and
 *  reduced to letters, digits, spaces and the three punctuation marks an id or
 *  a hostname needs, so a refusal reason that quoted an address cannot carry
 *  the address into the log. */
const MAX_OUTCOME_LENGTH = 120;

export interface McpActivityEntry {
  readonly at: string; // ISO instant
  readonly client: string; // the grant's client name, or "Legacy token"
  readonly tool: string;
  readonly accountId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly attachmentId?: string;
  readonly page?: string;
  readonly task?: string;
  readonly operationId?: string;
  readonly outcome: string; // "ok", or a refusal code
}

const OPTIONAL_FIELDS = [
  "accountId",
  "threadId",
  "messageId",
  "attachmentId",
  "page",
  "task",
  "operationId",
] as const;

function tidyOutcome(value: string): string {
  // Lowercase first so a capital in a hand-written code is kept as a letter
  // rather than stripped, which reads on disk like a corrupted line.
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ._-]/g, "")
    .trim()
    .slice(0, MAX_OUTCOME_LENGTH);
}

/** Copy the named fields and nothing else. */
function closedEntry(entry: McpActivityEntry): McpActivityEntry {
  const out: Record<string, string> = {
    at: String(entry.at),
    client: String(entry.client),
    tool: String(entry.tool),
  };
  for (const field of OPTIONAL_FIELDS) {
    const value = entry[field];
    if (typeof value === "string" && value.length > 0) out[field] = value;
  }
  out.outcome = tidyOutcome(String(entry.outcome));
  return out as unknown as McpActivityEntry;
}

function parseLine(line: string): McpActivityEntry | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.at !== "string" ||
      typeof value.client !== "string" ||
      typeof value.tool !== "string" ||
      typeof value.outcome !== "string"
    ) {
      return null;
    }
    return closedEntry(value as unknown as McpActivityEntry);
  } catch {
    return null;
  }
}

async function readLines(dir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, MCP_ACTIVITY_FILE), "utf8");
  } catch {
    // A missing or unreadable log is an empty log. It is machine state about
    // the notes, so failing to read it must never stop the tool that was
    // about to write a line to it.
    return [];
  }
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

/** Replace the whole file. Used to trim at the cap and to clear, both rare.
 *  The ordinary append does not come through here. */
async function rewrite(dir: string, lines: string[]): Promise<void> {
  const file = path.join(dir, MCP_ACTIVITY_FILE);
  await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
  await atomicWrite(file, lines.length === 0 ? "" : lines.join("\n") + "\n");
  // atomicWrite opens the temp file with the process umask, which on a
  // developer machine is 0022. The systemd unit sets UMask=0077 so production
  // already lands at 0600; this makes the mode the same everywhere.
  await fs.chmod(/* turbopackIgnore: true */ file, 0o600);
}

/** One writer at a time, the way `OAuthStateStore` serialises its own file.
 *  Two tools finishing together would otherwise read the same tail and one
 *  would write the other's line away. */
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function appendMcpActivity(entry: McpActivityEntry): Promise<void> {
  const dir = mcpStateDirectory();
  const line = JSON.stringify(closedEntry(entry));
  await enqueue(async () => {
    const lines = await readLines(dir);
    if (lines.length + 1 > MCP_ACTIVITY_MAX_LINES) {
      lines.push(line);
      await rewrite(dir, lines.slice(-MCP_ACTIVITY_MAX_LINES));
      return;
    }
    // One O_APPEND write, no rename and no fsync. A log line is not a note: a
    // crash that loses the last few lines, or leaves half of one behind, costs
    // a record of what happened and nothing a person wrote. `readMcpActivity`
    // drops a line it cannot parse, so a torn tail reads as absent.
    await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, MCP_ACTIVITY_FILE);
    const handle = await fs.open(/* turbopackIgnore: true */ file, "a", 0o600);
    try {
      await handle.appendFile(line + "\n", "utf8");
    } finally {
      await handle.close();
    }
    // The open mode above applies only when this call created the file, and it
    // is still cut by the umask. Set it either way, as every state writer here
    // does.
    await fs.chmod(/* turbopackIgnore: true */ file, 0o600);
  });
}

/** Newest first, because that is the order the Settings list shows and the
 *  order a person asking "what has it been doing" reads in. */
export async function readMcpActivity(limit: number): Promise<McpActivityEntry[]> {
  if (limit <= 0) return [];
  const entries: McpActivityEntry[] = [];
  for (const line of await readLines(mcpStateDirectory())) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return entries.slice(-limit).reverse();
}

export async function clearMcpActivity(): Promise<void> {
  const dir = mcpStateDirectory();
  await enqueue(() => rewrite(dir, []));
}
