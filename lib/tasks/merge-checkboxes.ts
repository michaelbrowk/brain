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
  const baseLines = base.split("\n");
  const theirLines = theirs.split("\n");

  // Rule 1. The server's body has to be the client's expected body with
  // nothing but tokens flipped. A different line count is an insertion or a
  // deletion, and neither can be merged with a line index.
  if (baseLines.length !== theirLines.length) return { ok: false };

  const baseTasks = tasksByLine(base);
  const theirTasks = tasksByLine(theirs);
  const ticked: number[] = [];
  for (const [index, line] of baseLines.entries()) {
    if (line === theirLines[index]) continue;
    if (!isTokenFlip(line, theirLines[index], baseTasks.get(index), theirTasks.get(index))) {
      return { ok: false };
    }
    ticked.push(index);
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
  const mineLines = mine.split("\n");
  const head = sharedHead(baseLines, mineLines);
  const tail = sharedTail(baseLines, mineLines, head);
  const shift = mineLines.length - baseLines.length;

  const merged = [...mineLines];
  for (const index of ticked) {
    const target =
      index < head ? index : index >= baseLines.length - tail ? index + shift : -1;
    if (target < 0) return { ok: false };
    // The two runs are shared by construction. Checking it anyway keeps the
    // refusal the default if the arithmetic above ever stops being true.
    if (mineLines[target] !== baseLines[index]) return { ok: false };
    // Rule 3. The server's own line, which is this line with its token
    // flipped, so the token is re-applied without rewriting it.
    merged[target] = theirLines[index];
  }

  return { ok: true, merged: merged.join("\n") };
}

function tasksByLine(markdown: string): Map<number, TaskLine> {
  return new Map(parseTaskLines(markdown).map((line) => [line.index, line]));
}

/** True when two lines differ by the checkbox token and by nothing else.
 *
 *  Both sides have to be task lines, so a bracket pair in a code fence or in
 *  a paragraph is not a tick. `checked` disagreeing means the token character
 *  itself differs, and one differing character in the whole line means that
 *  character is the token. That is the test, and it needs no second regex. */
function isTokenFlip(
  baseLine: string,
  theirLine: string,
  baseTask: TaskLine | undefined,
  theirTask: TaskLine | undefined,
): boolean {
  if (!baseTask || !theirTask) return false;
  if (baseTask.checked === theirTask.checked) return false;
  if (baseLine.length !== theirLine.length) return false;
  let differences = 0;
  for (let i = 0; i < baseLine.length; i += 1) {
    if (baseLine[i] !== theirLine[i]) differences += 1;
    if (differences > 1) return false;
  }
  return differences === 1;
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
