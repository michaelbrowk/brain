import { parseTaskLines, type TaskLine } from "./task-lines";

/** The one silent resolution a concurrent page write is allowed.
 *
 *  Somebody ticks a checkbox on their phone while the same note is open in a
 *  browser. The browser then saves a paragraph it was editing and its write
 *  carries the unticked line, because that is the body it loaded. Without
 *  this the tick is lost, and a lost tick is the failure nobody reports and
 *  everybody stops trusting.
 *
 *  So exactly one shape merges: the server changed nothing but checkbox
 *  tokens, and it changed them on lines the client did not touch. Everything
 *  else is a refusal, which the route answers as a 409 and a person resolves
 *  by reading both versions. This function is the boundary between those two
 *  outcomes, so every branch that is not one of the three rules below refuses,
 *  and there is no `catch` here that could turn a throw into an acceptance.
 *
 *  What counts as a checkbox comes from `parseTaskLines` and from nowhere
 *  else. A second regex in this file is how the editor's reading of a task
 *  line and the store's reading start to disagree (`AGENTS.md` invariant 7).
 *
 *  Nothing here reads the clock, the filesystem or a Store.
 */
export type CheckboxMergeResult = { ok: true; merged: string } | { ok: false };

export function mergeCheckboxStates(
  base: string,
  mine: string,
  theirs: string,
): CheckboxMergeResult {
  // Split on "\n" alone and join the same way, so a CRLF body comes back
  // byte for byte. `parseTaskLines` splits on /\r?\n/, which agrees with this
  // on every line count and every index.
  const baseRaw = base.split("\n");
  const theirRaw = theirs.split("\n");

  // Rule 1. The server's body has to be the client's expected body with
  // nothing but tokens flipped. A different line count is an insertion or a
  // deletion, and neither can be merged with a line index.
  if (baseRaw.length !== theirRaw.length) return { ok: false };

  // Every comparison below runs on the marker-normalised form, never on the
  // raw bytes. Every write below takes its bytes from `mineRaw`.
  const baseLines = markerNormalized(base, baseRaw);
  const theirLines = markerNormalized(theirs, theirRaw);

  const baseTasks = tasksByLine(base);
  const theirTasks = tasksByLine(theirs);
  /** The ticked line's index, and the one column its token sits in. */
  const ticked: { index: number; column: number }[] = [];
  for (const [index, line] of baseLines.entries()) {
    if (line === theirLines[index]) continue;
    const column = tokenFlipAt(
      line,
      theirLines[index],
      baseTasks.get(index),
      theirTasks.get(index),
    );
    if (column < 0) return { ok: false };
    ticked.push({ index, column });
  }
  // Every line equal means the server body is the expected body, so the
  // client's write has nothing to preserve and stands as it is.
  if (ticked.length === 0) return { ok: true, merged: mine };

  // Rule 2. A ticked line has to be one the client left untouched. Untouched
  // means it sits in the head or the tail that the client's body still shares
  // with the expected body, and those two runs are the only regions where a
  // line's new index is known rather than guessed. A line the client moved is
  // in neither, which is the answer the spec wants: a moved line is a line
  // the client touched, so its tick is a conflict and not a merge.
  const mineRaw = mine.split("\n");
  const mineLines = markerNormalized(mine, mineRaw);
  const head = sharedHead(baseLines, mineLines);
  const tail = sharedTail(baseLines, mineLines, head);
  const shift = mineRaw.length - baseRaw.length;

  const merged = [...mineRaw];
  for (const { index, column } of ticked) {
    const target =
      index < head ? index : index >= baseLines.length - tail ? index + shift : -1;
    if (target < 0) return { ok: false };
    // The two runs are shared by construction. Checking it anyway keeps the
    // refusal the default if the arithmetic above ever stops being true.
    if (mineLines[target] !== baseLines[index]) return { ok: false };
    // Rule 3. The server's token, written into the client's own line. Copying
    // the server's whole line would carry the server's bullet marker with it,
    // and a body half `-` and half `*` is a change nobody asked for.
    const line = merged[target];
    merged[target] =
      line.slice(0, column) + theirRaw[index][column] + line.slice(column + 1);
  }

  return { ok: true, merged: merged.join("\n") };
}

function tasksByLine(markdown: string): Map<number, TaskLine> {
  return new Map(parseTaskLines(markdown).map((line) => [line.index, line]));
}

/** Every task line's bullet written as `-`, for comparison only.
 *
 *  Milkdown serialises every bullet as `*`, so the first editor save of a note
 *  written by hand or through MCP rewrites the marker on every line. Read as
 *  bytes that is a touched line, and a concurrent tick on such a note would
 *  409 every time. A marker is not content: it says nothing about the words or
 *  the token, so it is levelled before anything is compared and never in what
 *  gets written back.
 *
 *  Which lines are task lines is `parseTaskLines`'s answer and nobody else's
 *  (AGENTS.md invariant 7). On a task line the marker is by construction the
 *  first non-blank character, and replacing one character keeps every column
 *  where it was, so an index into the normalised line indexes the raw one. */
function markerNormalized(markdown: string, lines: readonly string[]): string[] {
  const tasks = tasksByLine(markdown);
  return lines.map((line, index) => {
    if (!tasks.has(index)) return line;
    const at = line.search(/[^ \t]/);
    return at < 0 ? line : `${line.slice(0, at)}-${line.slice(at + 1)}`;
  });
}

/** The column the checkbox token sits in when two lines differ by that token
 *  and by nothing else, and `-1` when they differ by anything more.
 *
 *  `checked` disagreeing means the token character itself differs, and one
 *  differing character in the whole line means that character is the token.
 *  That is the test, and it needs no second regex. Both lines arrive
 *  marker-normalised, so a bullet rewrite is not one of the differences.
 *
 *  Every branch returns, and none of them throws. A merge is allowed to
 *  refuse and is never allowed to fail: a throw here would turn a 409 into a
 *  500 and a person would see an error instead of both versions. */
function tokenFlipAt(
  baseLine: string,
  theirLine: string,
  baseTask: TaskLine | undefined,
  theirTask: TaskLine | undefined,
): number {
  // Both sides have to be a task line, so a bracket pair in a code fence or
  // in a paragraph is not a tick. The two sides are refused separately,
  // because either one alone can be the side that is not a task line and
  // reading `checked` off the missing one is what would throw.
  if (!baseTask) return -1;
  if (!theirTask) return -1;
  // `checked` agreeing means the difference is somewhere in the words, and
  // copying the server's token would overwrite what the client wrote. `[x]`
  // against `[X]` lands here too, because both read as checked, so a server
  // that ever normalised token case would refuse that line rather than merge
  // it.
  if (baseTask.checked === theirTask.checked) return -1;
  if (baseLine.length !== theirLine.length) return -1;
  let column = -1;
  for (let i = 0; i < baseLine.length; i += 1) {
    if (baseLine[i] === theirLine[i]) continue;
    if (column >= 0) return -1;
    column = i;
  }
  return column;
}

function sharedHead(base: string[], mine: string[]): number {
  let count = 0;
  while (count < base.length && count < mine.length && base[count] === mine[count]) {
    count += 1;
  }
  return count;
}

/** Counted from the end and stopped at the head, so the two runs never claim
 *  one line twice and a ticked index can land in at most one of them. */
function sharedTail(base: string[], mine: string[], head: number): number {
  let count = 0;
  while (
    count < base.length - head &&
    count < mine.length - head &&
    base[base.length - 1 - count] === mine[mine.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}
