/** THE THREE SHAPES A VOCABULARY PAGE COMES IN.
 *
 *  A person keeping Spanish words writes them one of three ways and never
 *  tells anybody which: a markdown table, a bare `word — translation` line,
 *  or the same line with a bullet in front of it. The trainer reads all
 *  three, and reads nothing out of prose, a heading or a fenced block, where
 *  a dash is punctuation rather than a separator.
 *
 *  It never writes the pages it reads. The only page it writes is its own
 *  `Words`, through the bridge, which is the one page its `owns` list names. */

const SEPARATOR = /\s+[—–-]\s+/;

/** A CELL MAY NOT CONTAIN THE THING THAT SEPARATES CELLS.
 *
 *  A word spelled `o|u` written raw into a pipe-delimited row makes a
 *  six-cell line, and the reader below wants five. The row is dropped on the
 *  next read, the word is found again on its source page as if it were new,
 *  drilled again, written again and dropped again, and meanwhile the owner's
 *  `Words` page is a broken table in their editor. Markdown's own answer is a
 *  backslash, and it is what a person hand-editing that page would write, so
 *  it is what is written and what is read.
 *
 *  The backslash is escaped first, or escaping the pipe afterwards would
 *  escape the escape. A newline cannot be escaped inside a table at all, so
 *  it becomes a space and the cell stays one cell. */
function escapeCell(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

/** The cells of one row, split on the pipes that are not escaped, and each
 *  one unescaped. `split("|")` has no idea what `\|` is, and a lookbehind
 *  still misreads `\\|`, which is a real backslash followed by a real
 *  separator. Walk it.
 *
 *  A row opens and closes with a separator, so the first and last pieces are
 *  whatever sits outside the table, which is nothing. */
function splitRow(line) {
  const cells = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && index + 1 < line.length) {
      current += line[index + 1];
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current);
  return cells.slice(1, -1).map((cell) => cell.trim());
}

/** A line that ends the way a sentence ends is a sentence. It is the one
 *  signal that separates `I am learning - slowly.` from `adios - goodbye`
 *  without guessing at length: both sides of the first are short enough to
 *  pass for a phrase, and only one of them is punctuated. */
const SENTENCE_END = /[.!?]$/;

export function extractVocabulary(markdown) {
  const rows = [];
  let inFence = false;
  for (const raw of String(markdown).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0 || line.startsWith("#")) continue;

    if (line.startsWith("|") && line.endsWith("|")) {
      const cells = splitRow(line);
      // A separator row, and a header row whose cells name the columns rather
      // than being a pair of words.
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      if (cells.length < 2) continue;
      if (/^(word|spanish|term|palabra)$/i.test(cells[0])) continue;
      if (cells[0].length > 0 && cells[1].length > 0) {
        rows.push({ word: cells[0], translation: cells[1] });
      }
      continue;
    }

    if (SENTENCE_END.test(line)) continue;
    const bare = line.replace(/^[-*+]\s+/, "");
    // A bullet that was stripped is a list item; a line that was not must
    // still have exactly one separator, or it is a sentence with a dash in it.
    const parts = bare.split(SEPARATOR);
    if (parts.length !== 2) continue;
    const [word, translation] = parts.map((part) => part.trim());
    if (word.length === 0 || translation.length === 0) continue;
    // A sentence is longer than a word. Four words either side is generous
    // for a phrase and short of anything anybody would call prose.
    if (word.split(/\s+/).length > 4 || translation.split(/\s+/).length > 4) continue;
    rows.push({ word, translation });
  }
  return rows;
}

const STATUSES = ["new", "learning", "known"];
const HEADER = "| word | translation | status | seen | next |";
const RULE = "| --- | --- | --- | --- | --- |";

export function renderWordsTable(rows) {
  const seen = new Set();
  const lines = [HEADER, RULE];
  for (const row of rows) {
    const key = row.word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(
      `| ${escapeCell(row.word)} | ${escapeCell(row.translation)} | ` +
        `${escapeCell(row.status)} | ${escapeCell(row.seen)} | ${escapeCell(row.next)} |`,
    );
  }
  return lines.join("\n");
}

/** A page the owner may have edited by hand. A row that does not parse is
 *  dropped rather than taking the file down with it, and an unfamiliar status
 *  reads as `new`: the worst that costs is one more sighting of a word the
 *  person already knows, and the alternative is losing the word. */
export function parseWordsTable(markdown) {
  const rows = [];
  for (const raw of String(markdown).split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = splitRow(line);
    // Exactly five. Six means somebody added a column, and `next` is then not
    // where this reader thinks it is: dropping the row costs one word's
    // schedule, reading it wrong writes a date into the owner's page that
    // means nothing.
    if (cells.length !== 5) continue;
    if (/^word$/i.test(cells[0]) || /^:?-{3,}:?$/.test(cells[0])) continue;
    const seen = Number.parseInt(cells[3], 10);
    // Case-folded, because `extractVocabulary` folds the header it skips and
    // the likeliest hand edit of this page is a capital letter. A `Learning`
    // that read as `new` would be the owner's own progress lost to their own
    // tidying.
    const status = cells[2].toLowerCase();
    rows.push({
      word: cells[0],
      translation: cells[1],
      status: STATUSES.includes(status) ? status : "new",
      seen: Number.isFinite(seen) ? seen : 0,
      next: cells[4],
    });
  }
  return rows;
}

/** `2 ** seen` days, with the exponent held at eight. A word answered well
 *  nine times is a word the owner knows, and an unbounded exponent becomes a
 *  date arithmetic cannot represent. */
const MAX_STEP = 8;
const DAY_MS = 86400000;

export function nextInterval(seen) {
  return Math.pow(2, Math.min(Number(seen) || 0, MAX_STEP));
}

/** A day count from a `YYYY-MM-DD`, in UTC so a timezone cannot move a card
 *  by one day depending on where the owner opened it. */
export function addDays(today, days) {
  const start = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(start)) return today;
  return new Date(start + days * DAY_MS).toISOString().slice(0, 10);
}

/** WHAT THE TRAINER DRAWS, AND WHAT IT HIDES.
 *
 *  A known word is never drawn again: that is the whole of Easy, and the one
 *  rule a reader of this file should not have to find in a browser. A word
 *  with no date has never been answered and is due now; one with a date is
 *  due on it. */
export function isDue(row, today) {
  if (row.status === "known") return false;
  if (!row.next) return true;
  return row.next <= today;
}

export function dueRows(rows, today) {
  return rows.filter((row) => isDue(row, today));
}

/** One answer, as a new row and a verdict on whether the word comes back in
 *  this session. A new row rather than a changed one, because the deck and
 *  the table hold the same objects and a mutation is then two things moving
 *  when one was asked to. */
export function applyAnswer(row, kind, today) {
  const seen = row.seen + 1;
  if (kind === "again") {
    // Back in the deck, and due now: an answer of "I did not know this" is
    // not a reason to put the word off until tomorrow.
    return { row: { ...row, status: "learning", seen, next: "" }, repeat: true };
  }
  if (kind === "good") {
    return {
      row: { ...row, status: "learning", seen, next: addDays(today, nextInterval(row.seen)) },
      repeat: false,
    };
  }
  return {
    row: { ...row, status: "known", seen, next: addDays(today, nextInterval(row.seen + 1)) },
    repeat: false,
  };
}

/** THIRTY REQUESTS A SECOND IS THE WHOLE BUDGET, AND A DECK CAN BE BIGGER.
 *
 *  The host's bridge refuses the thirty-first request in a second with
 *  `too_many` (`components/shell/app-bridge.ts`). A trainer reading every
 *  page under a parent will pass that on any real notebook, and a refusal
 *  swallowed in a bare catch is a page silently missing from the deck: the
 *  owner sees a smaller count and no reason for it.
 *
 *  So the reads are paced under the limit rather than up against it, a
 *  refusal is waited out once, and whatever still could not be read is
 *  COUNTED and handed back for the app to say out loud. The clock and the
 *  waiting are arguments, so this has a test that takes no time to run. */
const READS_PER_SECOND = 20;

export async function readVocabulary(nodes, readPage, options) {
  const settings = options || {};
  const perSecond = settings.perSecond || READS_PER_SECOND;
  const wait = settings.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = settings.now || (() => Date.now());

  const rows = [];
  let failed = 0;
  let windowStart = now();
  let used = 0;

  for (const node of nodes) {
    if (used >= perSecond) {
      const elapsed = now() - windowStart;
      if (elapsed < 1000) await wait(1000 - elapsed);
      windowStart = now();
      used = 0;
    }
    used += 1;
    let page = null;
    try {
      page = await readPage(node.id);
    } catch (error) {
      if (error && error.reason === "too_many") {
        // The budget is spent. A second is the window, so a second is the
        // wait, and the window starts again with this page in it.
        await wait(1000);
        windowStart = now();
        used = 1;
        try {
          page = await readPage(node.id);
        } catch (again) {
          page = null;
        }
      }
    }
    if (page === null) {
      failed += 1;
      continue;
    }
    for (const row of extractVocabulary(page.markdown)) rows.push(row);
  }
  return { rows, failed };
}

/** THE PAGE AND THE SESSION, WHEN BOTH MOVED.
 *
 *  A `rev_conflict` means somebody wrote the `Words` page between the app's
 *  read and its write, and the only somebody who can is the owner with it
 *  open in the editor beside the app. Writing the deck the app is holding
 *  would replace what they just saved, so the fresh page is parsed and the
 *  two are merged on one rule:
 *
 *  THE OWNER OWNS THE WORDS. A translation they corrected, a word they
 *  respelled, a status they set on a row the app has not touched this
 *  session — all theirs, because they meant it and the app did not.
 *
 *  THE APP OWNS THE SCHEDULE OF WHAT IT ANSWERED. A card answered a second
 *  ago is newer than the page, and `answered` is the list of those words.
 *
 *  A row only one side has is kept: the owner added it, or the app found it
 *  on a source page. Matching is case-folded, because the two sides can
 *  disagree about a capital and still mean one word. */
export function mergeWordRows(appRows, ownerRows, answered) {
  const mine = new Set(Array.from(answered || [], (value) => String(value).toLowerCase()));
  const byKey = new Map();
  for (const row of ownerRows) byKey.set(row.word.toLowerCase(), { ...row });
  for (const row of appRows) {
    const key = row.word.toLowerCase();
    const theirs = byKey.get(key);
    if (theirs === undefined) {
      byKey.set(key, { ...row });
      continue;
    }
    if (!mine.has(key)) continue;
    byKey.set(key, { ...theirs, status: row.status, seen: row.seen, next: row.next });
  }
  return Array.from(byKey.values());
}

/** Every page under one parent, however deep, with one subtree left out: the
 *  trainer's own, because its `Words` page is a list of answers rather than a
 *  list of words to learn and reading it as a source would teach the owner
 *  their own status column. */
export function descendantsOf(nodes, rootId, skipId) {
  const found = [];
  const walk = (parentId) => {
    for (const node of nodes) {
      if (node.parentId !== parentId) continue;
      if (node.id === skipId) continue;
      found.push(node);
      walk(node.id);
    }
  };
  if (rootId) walk(rootId);
  return found;
}
