/** THE THREE SHAPES A VOCABULARY PAGE COMES IN.
 *
 *  A person keeping Spanish words writes them one of three ways and never
 *  tells anybody which: a markdown table, a bare `word — translation` line,
 *  or the same line with a bullet in front of it. The trainer reads all
 *  three, and reads nothing out of prose, a heading or a fenced block, where
 *  a dash is punctuation rather than a separator. What it takes out of those
 *  three shapes is narrowed by one bargain, `isPair` below: the language being
 *  learned on the left, the owner's own on the right, told apart by the two
 *  scripts the owner names in the app's head.
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

/** WHAT SEPARATES `I am learning - slowly.` FROM `adios — goodbye.`
 *
 *  Not the full stop on its own: a person writing a list puts one after the
 *  last item, and refusing every punctuated line cost a legitimate pair. What
 *  separates them is length. A pair is a word or a short phrase either side;
 *  a sentence with a dash in it is longer than that, and the full stop is the
 *  signal to hold it to the shorter limit rather than to reject it outright.
 *
 *  The stop itself is then not part of the translation, so it comes off. */
const SENTENCE_END = /[.!?]+$/;
const MAX_PHRASE_WORDS = 4;
const MAX_SENTENCE_WORDS = 2;

/** A slash offers the same word twice rather than adding another one, so
 *  `ningún / ninguna` is two words and not three. Without this the owner's
 *  own habit of writing both genders on one line pushed the line past the
 *  phrase limit and the pair was dropped for being prose. */
function countWords(value) {
  return value.split(/[\s/]+/).filter((part) => part.length > 0).length;
}

/** EMPHASIS IS MARKUP, AND MARKUP IS NOT PART OF THE WORD.
 *
 *  The owner bolds the Spanish, so the deck filled with cards reading
 *  `**yo tengo**` and a `Words` page carrying the asterisks into its own
 *  table, where the next read saw a different word and added it again.
 *
 *  Only the four marks come off. A parenthesis is spelling on these pages —
 *  `Acostarse (me acuesto)` names the stem change and the card wants it — and
 *  `¿` and `¡` open a real Spanish sentence, so no punctuation is touched. */
function stripEmphasis(value) {
  return value.replace(/[*_`]/g, "").trim();
}

const RULE_CELL = /^:?-{3,}:?$/;
const ENGLISH_HEADER = /^(word|spanish|term|palabra)$/i;

function isRuleRow(line) {
  if (!line.startsWith("|") || !line.endsWith("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => RULE_CELL.test(cell));
}

/** THE TRAINER'S BARGAIN: ONE SCRIPT ON THE LEFT, ANOTHER ON THE RIGHT.
 *
 *  A conjugation table is shaped exactly like a vocabulary table, and the
 *  reader used to drill `tener` against `tengo` and `1-е` against `-ar`. What
 *  tells the two apart is not the shape, it is the writing: a pair the owner
 *  means to learn has the language they are learning on one side and their own
 *  on the other. Spanish on both sides is grammar; the owner's own language on
 *  both sides is a heading or a numbering column.
 *
 *  WHICH TWO SCRIPTS THOSE ARE IS THE OWNER'S TO SAY. It used to be written
 *  into this file, and a notebook kept in Spanish and English then got nothing
 *  out of the reader at all. The pair is an argument now, the head offers it as
 *  two selects and the app keeps it in `state`, and the default is the bargain
 *  Michael's own notebook was measured on, so those pages read the same as
 *  before. */
const SCRIPT_CLASSES = {
  Latin: "\\p{Script=Latin}",
  Cyrillic: "\\p{Script=Cyrillic}",
  Greek: "\\p{Script=Greek}",
  Arabic: "\\p{Script=Arabic}",
  Hebrew: "\\p{Script=Hebrew}",
  Han: "\\p{Script=Han}",
  // Japanese writes its kana in two, and a notebook uses both, so the one
  // choice the head offers covers both.
  Kana: "\\p{Script=Hiragana}\\p{Script=Katakana}",
  Hangul: "\\p{Script=Hangul}",
};

/** The scripts the head offers, in the order it offers them. */
export const SCRIPT_NAMES = Object.keys(SCRIPT_CLASSES);

export const DEFAULT_SCRIPTS = { wordScript: "Latin", translationScript: "not-Latin" };

/** A script name, or `not-<name>` for the side the head calls "any other than
 *  the word's": a letter of any script but that one. The tests are built once
 *  each and kept, because `extractVocabulary` asks for them on every line of
 *  every page and a notebook is thousands of lines.
 *
 *  A name nothing defines reads as the default for that side rather than
 *  refusing: the setting is JSON on the owner's own disk, and a hand edit that
 *  spells a script wrong should cost them the setting, not the deck. */
const scriptTests = new Map();

function classesFor(name) {
  return SCRIPT_CLASSES[name.indexOf("not-") === 0 ? name.slice(4) : name];
}

function scriptTest(name, fallback) {
  const asked = typeof name === "string" && name.length > 0 ? name : fallback;
  const chosen = classesFor(asked) === undefined ? fallback : asked;
  const kept = scriptTests.get(chosen);
  if (kept !== undefined) return kept;
  const built =
    chosen.indexOf("not-") === 0
      ? new RegExp("(?![" + classesFor(chosen) + "])\\p{L}", "u")
      : new RegExp("[" + classesFor(chosen) + "]", "u");
  scriptTests.set(chosen, built);
  return built;
}

export function isPair(word, translation, scripts) {
  const chosen = scripts || DEFAULT_SCRIPTS;
  return (
    scriptTest(chosen.wordScript, DEFAULT_SCRIPTS.wordScript).test(word) &&
    scriptTest(chosen.translationScript, DEFAULT_SCRIPTS.translationScript).test(translation)
  );
}

export function extractVocabulary(markdown, scripts) {
  const rows = [];
  const lines = String(markdown)
    .split("\n")
    .map((raw) => raw.trim());
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0 || line.startsWith("#")) continue;

    if (line.startsWith("|") && line.endsWith("|")) {
      if (isRuleRow(line)) continue;
      // A HEADER IS A POSITION, NOT A VOCABULARY.
      //
      // The row above the rule row is the header, and that is all a markdown
      // table ever says about it. Reading the cells instead worked only while
      // they said `word` or `Spanish`; on a page written in Russian it let
      // `Род и число` into the deck as a word to learn. The English list
      // stays for a table somebody wrote without a rule row.
      if (index + 1 < lines.length && isRuleRow(lines[index + 1])) continue;
      const cells = splitRow(line).map(stripEmphasis);
      if (cells.length < 2) continue;
      if (ENGLISH_HEADER.test(cells[0])) continue;
      if (cells[0].length === 0 || cells[1].length === 0) continue;
      if (!isPair(cells[0], cells[1], scripts)) continue;
      rows.push({ word: cells[0], translation: cells[1] });
      continue;
    }

    const bare = line.replace(/^[-*+]\s+/, "");
    // A bullet that was stripped is a list item; a line that was not must
    // still have exactly one separator, or it is a sentence with a dash in it.
    const parts = bare.split(SEPARATOR);
    if (parts.length !== 2) continue;
    const [word, rest] = parts.map(stripEmphasis);
    if (word.length === 0 || rest.length === 0) continue;
    // A sentence is longer than a word. Four words either side is generous
    // for a phrase and short of anything anybody would call prose; a line
    // that ends like a sentence is held to two, which a pair still passes.
    const limit = SENTENCE_END.test(rest) ? MAX_SENTENCE_WORDS : MAX_PHRASE_WORDS;
    if (countWords(word) > limit || countWords(rest) > limit) continue;
    const translation = rest.replace(SENTENCE_END, "").trim();
    if (translation.length === 0) continue;
    if (!isPair(word, translation, scripts)) continue;
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
 *  waiting are arguments, so this has a test that takes no time to run.
 *
 *  AND A PAGE NOBODY HAS WRITTEN IS NOT READ TWICE. The tree says when each
 *  page was last written, so `options.cache` — a Map the caller owns, keyed by
 *  id and holding the `updated` it was read at — answers a page the frame has
 *  already seen without spending a request on it. A node the host did not date
 *  is never kept: there would be nothing to compare it against, and a page
 *  read once and trusted after that is a page frozen for the life of the
 *  frame. Neither is a page that could not be read, so a refusal is retried on
 *  the next reload rather than remembered as an absence. */
const READS_PER_SECOND = 20;

export async function readVocabulary(nodes, readPage, options) {
  const settings = options || {};
  const perSecond = settings.perSecond || READS_PER_SECOND;
  const wait = settings.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = settings.now || (() => Date.now());
  const cache = settings.cache || null;

  const rows = [];
  let failed = 0;
  let windowStart = now();
  let used = 0;

  for (const node of nodes) {
    const datable = cache !== null && typeof node.updated === "string" && node.updated.length > 0;
    const kept = datable ? cache.get(node.id) : undefined;
    if (kept !== undefined && kept.updated === node.updated) {
      for (const row of kept.rows) rows.push(row);
      continue;
    }
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
        } catch {
          // Refused twice. The page is counted below rather than retried
          // again: a loop against a limiter is how an app never finishes.
          page = null;
        }
      }
    }
    if (page === null) {
      failed += 1;
      continue;
    }
    const found = extractVocabulary(page.markdown, settings.scripts);
    if (datable) cache.set(node.id, { updated: node.updated, rows: found });
    for (const row of found) rows.push(row);
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

/** THE DECK AFTER A MERGE, AND THE CARD THAT IS NO LONGER A WORD.
 *
 *  A merge answers new row objects and the deck was holding the old ones, so
 *  every card is looked up again by its word. A card whose word is not among
 *  the rows at all comes out of the deck, because an answer to it would be
 *  written into a row nothing reads.
 *
 *  `redraw` is whether the card at the FRONT moved, which is the only case the
 *  screen has to be told about: the owner is looking at that one. It compares
 *  words and not objects, because a merge hands back a new object for the same
 *  word every time and a redraw on every save would hide a translation the
 *  owner had just revealed. Matching is case-folded, the same as the merge's. */
export function relinkCards(deck, rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(row.word.toLowerCase(), row);
  const next = [];
  for (const card of deck) {
    const live = byKey.get(card.word.toLowerCase());
    if (live !== undefined) next.push(live);
  }
  const was = deck.length > 0 ? deck[0].word.toLowerCase() : "";
  const now = next.length > 0 ? next[0].word.toLowerCase() : "";
  return { deck: next, redraw: now !== was };
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
