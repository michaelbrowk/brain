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

/** 2000 lines of ids is under 400 KB in the ordinary case, which is small
 *  enough to be the file a person scrolls. `MCP_ACTIVITY_MAX_FILE_BYTES`
 *  below is the second cap for the case a caller's fields are all near their
 *  own bound at once. */
export const MCP_ACTIVITY_MAX_LINES = 2000;

/** Every field on a line is bounded (below), so the ordinary line is a few
 *  hundred bytes. This is the backstop for the line those bounds still miss:
 *  a caller whose fields are mostly multi-byte characters, where a character
 *  count under the field caps can still add up to several times as many
 *  UTF-8 bytes. `boundLine` shrinks fields until the serialized line fits
 *  under this, rather than ever dropping one. */
export const MCP_ACTIVITY_MAX_LINE_BYTES = 4096;

/** The file cap beside the line-count cap. 2000 lines at the ordinary size is
 *  nowhere near this; it exists for the caller that keeps every line near its
 *  own per-line bound, where the line-count cap alone would still let the
 *  file grow past what a person scrolls. Trimming checks both caps and stops
 *  removing lines only once neither is exceeded. */
export const MCP_ACTIVITY_MAX_FILE_BYTES = 512 * 1024;

/** An outcome is a code, not a sentence a mail server wrote. Bounded and
 *  reduced to letters, digits, spaces and the three punctuation marks an id or
 *  a hostname needs, so a refusal reason that quoted an address cannot carry
 *  the address into the log. */
const MAX_OUTCOME_LENGTH = 120;

/** `change` is a short fixed token a caller names, not a place for prose:
 *  which mutation a triage line ran (`read`, `archive`, `trash`, `restore`,
 *  `spam`, `starred`) or which field a task write changed. Bounded the same
 *  way `outcome` is, so a caller that passed a sentence by mistake cannot
 *  make the line unreadable. */
const MAX_CHANGE_LENGTH = 64;

/** Every id-shaped optional field, the grant's client name and the tool name
 *  itself: generous enough that a real id never notices, and finite so a
 *  caller that skipped its own validation cannot spend the log's byte budget
 *  on one line. `lib/mcp/activity-log.ts`'s own callers validate their ids
 *  before this is ever reached; this is the second lock, for the caller that
 *  does not. */
const MAX_ID_FIELD_CHARS = 200;
const MAX_CLIENT_CHARS = 120;
const MAX_TOOL_CHARS = 80;
const MAX_AT_CHARS = 64;

/** Marks a field as shortened rather than whole, so a line that hit the cap
 *  reads as cut, not as a shorter id that happens to look real. */
const TRUNCATION_MARK = "...(cut)";

/** The byte budget every shrinkable field is cut to in `boundLine`'s backstop
 *  pass. Small enough that the full set of fields at this size is always
 *  under `MCP_ACTIVITY_MAX_LINE_BYTES`, so that pass never has to loop. */
const LINE_BACKSTOP_FIELD_BYTES = 64;

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
  readonly change?: string; // which mutation or field, never free text
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

/** Cut `value` to at most `maxChars` UTF-16 code units, marking a cut rather
 *  than leaving one silent. Character count, not bytes: this is the primary
 *  bound every field gets, cheap and predictable; `boundLine` below is the
 *  byte-accurate backstop for the multi-byte case this one can still miss. */
function boundChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.max(0, maxChars - TRUNCATION_MARK.length);
  return value.slice(0, keep) + TRUNCATION_MARK;
}

/** Cut `value` to at most `maxBytes` UTF-8 bytes, marking a cut. Removes one
 *  UTF-16 code unit at a time rather than computing an offset, so a
 *  surrogate pair is never split; the loop runs at most `value.length` times,
 *  and every caller here has already run its value through `boundChars`
 *  first, so that length is already small. */
function boundBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markBytes = Buffer.byteLength(TRUNCATION_MARK, "utf8");
  const budget = Math.max(0, maxBytes - markBytes);
  let cut = value;
  while (cut.length > 0 && Buffer.byteLength(cut, "utf8") > budget) {
    cut = cut.slice(0, -1);
  }
  return cut + TRUNCATION_MARK;
}

/** The fields a line can still be over budget on after `boundChars`: every
 *  one whose bytes can run ahead of its character count. `outcome` is not
 *  here because `tidyOutcome` already strips it to ASCII. */
const LINE_SHRINKABLE_FIELDS = [
  "at",
  "client",
  "tool",
  "change",
  ...OPTIONAL_FIELDS,
] as const;

/** The line-level backstop. Ordinary content never reaches this: every field
 *  is already bounded in characters by the time this runs, and for ASCII
 *  content that bound is a byte bound too. It exists for the field that is
 *  mostly multi-byte characters, where a character count under the cap can
 *  still serialize to several times as many bytes. A flat, small per-field
 *  byte budget on every shrinkable field guarantees the line fits by
 *  construction, so there is nothing to loop or measure twice. */
function boundLine(out: Record<string, string>): Record<string, string> {
  if (Buffer.byteLength(JSON.stringify(out), "utf8") <= MCP_ACTIVITY_MAX_LINE_BYTES) {
    return out;
  }
  for (const field of LINE_SHRINKABLE_FIELDS) {
    const value = out[field];
    if (value !== undefined) out[field] = boundBytes(value, LINE_BACKSTOP_FIELD_BYTES);
  }
  return out;
}

/** Copy the named fields and nothing else, every one of them bounded. A field
 *  a caller sends unbounded, an id above all, must never turn one line into
 *  the log's whole byte budget: `MCP_ACTIVITY_MAX_LINES` counts lines on the
 *  reading that each one costs a bounded, small number of bytes, and that
 *  reading has to hold here for it to hold anywhere. */
function closedEntry(entry: McpActivityEntry): McpActivityEntry {
  const out: Record<string, string> = {
    at: boundChars(String(entry.at), MAX_AT_CHARS),
    client: boundChars(String(entry.client), MAX_CLIENT_CHARS),
    tool: boundChars(String(entry.tool), MAX_TOOL_CHARS),
  };
  for (const field of OPTIONAL_FIELDS) {
    const value = entry[field];
    if (typeof value === "string" && value.length > 0) {
      out[field] = boundChars(value, MAX_ID_FIELD_CHARS);
    }
  }
  if (typeof entry.change === "string" && entry.change.length > 0) {
    out.change = entry.change.slice(0, MAX_CHANGE_LENGTH);
  }
  out.outcome = tidyOutcome(String(entry.outcome));
  return boundLine(out) as unknown as McpActivityEntry;
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
 *  would write the other's line away. Also what makes the cache below safe
 *  to read and write without its own lock: every turn that touches it runs
 *  to completion before the next one starts. */
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface DirectoryCounts {
  lines: number;
  bytes: number;
}

/** What the file looked like from outside at the moment this process last
 *  left it: the two numbers a `stat` answers. */
interface FileStamp {
  size: number;
  mtimeMs: number;
}

type DirectoryState = DirectoryCounts & FileStamp;

/** The cost `appendMcpActivity` used to pay on every call: a full read, a
 *  full parse and a full re-count, which is why a call at line 1999 cost 8ms
 *  against 0.3ms at an empty log. Keyed by directory because a test
 *  redirects it per run and a production process never does; one process
 *  never holds more than a couple of entries either way.
 *
 *  The counts are this process's own belief, and `size` and `mtimeMs` are
 *  what makes that belief checkable. Every append stats the file first: two
 *  numbers that still match means nothing else has written since, and the
 *  cached counts stand. One that has moved means a sibling process on the
 *  same state directory appended, and the counts are built again from the
 *  file. Two `pnpm dev` instances under one uid share a state directory
 *  (`state-dir.ts`), so this is reachable outside a test, and without the
 *  check neither process would ever see the cap. */
const directoryState = new Map<string, DirectoryState>();

function countsFromLines(lines: readonly string[]): DirectoryCounts {
  let bytes = 0;
  for (const raw of lines) bytes += Buffer.byteLength(raw, "utf8") + 1;
  return { lines: lines.length, bytes };
}

/** The file as it stands, or the zeroes that stand for "nothing this cache
 *  could be holding": a log nobody has written yet, and a file this process
 *  cannot stat, both send the append down the counting path. */
async function stampOf(dir: string): Promise<FileStamp> {
  try {
    const stats = await fs.stat(
      /* turbopackIgnore: true */ path.join(dir, MCP_ACTIVITY_FILE),
    );
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

export async function appendMcpActivity(entry: McpActivityEntry): Promise<void> {
  const dir = mcpStateDirectory();
  const line = JSON.stringify(closedEntry(entry));
  const lineBytes = Buffer.byteLength(line, "utf8") + 1;
  await enqueue(async () => {
    // Taken before the read below, never after: a stamp older than the lines
    // this turn counted only costs one more read on the next append, while a
    // stamp newer than them would hide a write that landed in between.
    const stamp = await stampOf(dir);
    let state = directoryState.get(dir);
    // A line this process cannot parse back never reaches `readMcpActivity`,
    // so it is not one of the log's slots; kept only for the rare rewrite
    // below, which drops it rather than carrying it forward forever.
    let validLines: string[] | null = null;
    if (
      state === undefined ||
      state.size !== stamp.size ||
      state.mtimeMs !== stamp.mtimeMs
    ) {
      validLines = (await readLines(dir)).filter((raw) => parseLine(raw) !== null);
      state = { ...countsFromLines(validLines), ...stamp };
      directoryState.set(dir, state);
    }

    const overLineCap = state.lines + 1 > MCP_ACTIVITY_MAX_LINES;
    const overByteCap = state.bytes + lineBytes > MCP_ACTIVITY_MAX_FILE_BYTES;
    if (overLineCap || overByteCap) {
      if (validLines === null) {
        validLines = (await readLines(dir)).filter((raw) => parseLine(raw) !== null);
      }
      validLines.push(line);
      let trimmed = validLines.slice(-MCP_ACTIVITY_MAX_LINES);
      let trimmedCounts = countsFromLines(trimmed);
      while (trimmed.length > 0 && trimmedCounts.bytes > MCP_ACTIVITY_MAX_FILE_BYTES) {
        trimmed = trimmed.slice(1);
        trimmedCounts = countsFromLines(trimmed);
      }
      await rewrite(dir, trimmed);
      // A rewrite replaces the file, so its size is the bytes counted above
      // and only the mtime has to be asked for.
      directoryState.set(dir, {
        ...trimmedCounts,
        size: trimmedCounts.bytes,
        mtimeMs: (await stampOf(dir)).mtimeMs,
      });
      return;
    }

    // One O_APPEND write, no rename and no fsync. A log line is not a note: a
    // crash that loses the last few lines, or leaves half of one behind, costs
    // a record of what happened and nothing a person wrote. `readMcpActivity`
    // drops a line it cannot parse, so a torn tail reads as absent. Bounded
    // and O(1) in the file's size: this path reads none of it, only the two
    // stats around the write and the cached counts updated below.
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
    // does. A chmod moves the ctime and leaves the mtime alone, so the stamp
    // read after it is still the one this append landed on.
    await fs.chmod(/* turbopackIgnore: true */ file, 0o600);
    // The size is computed rather than asked for: what the stat at the top of
    // this turn saw, plus the line this turn wrote. A sibling process that
    // in between leaves the real file bigger than that, which is exactly the
    // mismatch the next append reads and counts again on.
    directoryState.set(dir, {
      lines: state.lines + 1,
      bytes: state.bytes + lineBytes,
      size: stamp.size + lineBytes,
      mtimeMs: (await stampOf(dir)).mtimeMs,
    });
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
  await enqueue(async () => {
    await rewrite(dir, []);
    directoryState.set(dir, {
      lines: 0,
      bytes: 0,
      size: 0,
      mtimeMs: (await stampOf(dir)).mtimeMs,
    });
  });
}
