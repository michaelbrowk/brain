import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "@/lib/store/atomic";
import { mcpStateDirectory } from "./state-dir";

/** WHICH SENT MESSAGES AN AGENT PUT ON THE WIRE.
 *
 *  The Sent row is the provider's own row and carries no operation id, so the
 *  caption that says an agent wrote it is a Brain-side join: the send
 *  operation is recorded here at send time, and its thread is filled in once,
 *  lazily, when something first asks for the marks.
 *
 *  A mark is three ids and an app name. No body, no subject, no address, no
 *  title. The client name is the name the owner approved on the consent
 *  screen, and it stays on this side: the mail service takes `origin: "mcp"`
 *  and nothing about which app it was.
 */

export const MCP_AGENT_SENDS_FILE = "agent-sends.json";

/** Enough to caption every Sent row a person is likely to scroll back to,
 *  small enough that the file stays a few tens of kilobytes. */
export const MCP_AGENT_SEND_MAX = 200;

export interface McpAgentSend {
  readonly operationId: string;
  readonly accountId: string;
  readonly clientName: string;
  /** null until the Sent copy has been found by its Message-ID. */
  readonly threadId: string | null;
}

function parseMark(value: unknown): McpAgentSend | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const mark = value as Record<string, unknown>;
  if (
    typeof mark.operationId !== "string" ||
    typeof mark.accountId !== "string" ||
    typeof mark.clientName !== "string"
  ) {
    return null;
  }
  return {
    operationId: mark.operationId,
    accountId: mark.accountId,
    clientName: mark.clientName,
    threadId: typeof mark.threadId === "string" ? mark.threadId : null,
  };
}

async function readMarks(dir: string): Promise<McpAgentSend[]> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(dir, MCP_AGENT_SENDS_FILE), "utf8"),
    );
    if (!Array.isArray(parsed)) return [];
    const out: McpAgentSend[] = [];
    for (const value of parsed) {
      const mark = parseMark(value);
      if (mark) out.push(mark);
    }
    return out;
  } catch {
    // A missing or unreadable marks file costs a caption, not a message. It is
    // reconstructible in the only sense that matters: the mail is unaffected.
    return [];
  }
}

async function writeMarks(dir: string, marks: McpAgentSend[]): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, MCP_AGENT_SENDS_FILE);
  await atomicWrite(file, JSON.stringify(marks) + "\n");
  // atomicWrite opens the temp file with the process umask, which on a
  // developer machine is 0022. The systemd unit sets UMask=0077 so production
  // already lands at 0600; this makes the mode the same everywhere.
  await fs.chmod(/* turbopackIgnore: true */ file, 0o600);
}

/** One writer at a time. A send being recorded while an earlier one is being
 *  resolved would otherwise write the other's change away. */
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function recordAgentSend(
  send: Omit<McpAgentSend, "threadId">,
): Promise<void> {
  const dir = mcpStateDirectory();
  await enqueue(async () => {
    const marks = await readMarks(dir);
    // A replay under the same key records the same operation a second time.
    // The thread that was resolved for it in between is the whole point of
    // the mark, so it is carried onto the fresh one rather than cleared and
    // waited for again.
    const held = marks.find((mark) => mark.operationId === send.operationId);
    const mark: McpAgentSend = {
      operationId: send.operationId,
      accountId: send.accountId,
      clientName: send.clientName,
      threadId: held?.threadId ?? null,
    };
    const rest = marks.filter(
      (other) => other.operationId !== mark.operationId,
    );
    rest.push(mark);
    await writeMarks(dir, rest.slice(-MCP_AGENT_SEND_MAX));
  });
}

/** The mark a send could not write for itself. A send whose answer never
 *  arrived has no operation id to record, so the first caller that learns the
 *  id writes the mark instead, and the Sent row still says which app wrote
 *  the message. An operation already marked keeps the mark it has, thread and
 *  all: this fills a gap, it does not overwrite a record. */
export async function recordAgentSendIfAbsent(
  send: Omit<McpAgentSend, "threadId">,
): Promise<void> {
  const mark: McpAgentSend = {
    operationId: send.operationId,
    accountId: send.accountId,
    clientName: send.clientName,
    threadId: null,
  };
  const dir = mcpStateDirectory();
  await enqueue(async () => {
    const marks = await readMarks(dir);
    if (marks.some((held) => held.operationId === mark.operationId)) return;
    marks.push(mark);
    await writeMarks(dir, marks.slice(-MCP_AGENT_SEND_MAX));
  });
}

/** Oldest first, the order they were sent in. */
export async function readAgentSends(): Promise<McpAgentSend[]> {
  return readMarks(mcpStateDirectory());
}

export async function resolveAgentSendThread(
  operationId: string,
  threadId: string,
): Promise<void> {
  const dir = mcpStateDirectory();
  await enqueue(async () => {
    const marks = await readMarks(dir);
    let changed = false;
    const next = marks.map((mark) => {
      if (mark.operationId !== operationId || mark.threadId === threadId) return mark;
      changed = true;
      return { ...mark, threadId };
    });
    if (!changed) return;
    await writeMarks(dir, next);
  });
}
