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
    if (cells.length !== 5) continue;
    if (cells[0] === "word" || /^:?-{3,}:?$/.test(cells[0])) continue;
    const seen = Number.parseInt(cells[3], 10);
    rows.push({
      word: cells[0],
      translation: cells[1],
      status: STATUSES.includes(cells[2]) ? cells[2] : "new",
      seen: Number.isFinite(seen) ? seen : 0,
      next: cells[4],
    });
  }
  return rows;
}
