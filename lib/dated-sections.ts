/** Reading a date out of a page title, so a section of dated pages reads in
 *  date order instead of alphabetical order.
 *
 *  This is deliberately NOT a general date parser. It recognises exactly five
 *  shapes, tried in this order, and the first one that matches anywhere in the
 *  title wins:
 *
 *    1. ISO            `2026-08-25`
 *    2. Dotted, day-first, four-digit year   `25.08.2026`
 *    3. Russian day + month `12 мая`, `9 марта 2026` — month in the genitive
 *       (мая, марта, августа…) or the nominative (май, март, август…)
 *    4. English day + month `9 March`, `9 Mar 2026`
 *    5. English month + day `March 9`, `Mar 9, 2026`
 *
 *  Anything else — a two-digit year, a time, a date range, a month with no
 *  day, a relative word like "вчера" — is not a date here, and a page whose
 *  title holds one keeps its position untouched.
 *
 *  Direction is NEWEST FIRST, matching every other dated list in Brain: the
 *  hub's activity feed sorts on `updated` descending, page history is returned
 *  newest first, and Trash lists the most recently deleted first.
 */

/** A date read out of a title. `year` is absent when the title carries only a
 *  day and a month, which is the ordinary case in a lesson log. */
export interface TitleDate {
  year?: number;
  month: number; // 1-12
  day: number; // 1-31
}

export interface DatedPage {
  id: string;
  title: string;
  /** ISO creation timestamp — the anchor that supplies a missing year. */
  created?: string;
}

const RU_MONTHS: Record<string, number> = {
  январь: 1,
  января: 1,
  февраль: 2,
  февраля: 2,
  март: 3,
  марта: 3,
  апрель: 4,
  апреля: 4,
  май: 5,
  мая: 5,
  июнь: 6,
  июня: 6,
  июль: 7,
  июля: 7,
  август: 8,
  августа: 8,
  сентябрь: 9,
  сентября: 9,
  октябрь: 10,
  октября: 10,
  ноябрь: 11,
  ноября: 11,
  декабрь: 12,
  декабря: 12,
};

const EN_MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/** Longest first so `марта` is tried before `март` even where the trailing
 *  letter guard would already have rejected the shorter one. */
function alternation(names: Record<string, number>): string {
  return Object.keys(names)
    .sort((a, b) => b.length - a.length)
    .join("|");
}

const RU_ALT = alternation(RU_MONTHS);
const EN_ALT = alternation(EN_MONTHS);

/** A day number must not be glued to a letter, another digit, or the
 *  punctuation that turns it into a range or a version — `9-16 марта` names no
 *  single day, so it is not a date. A range is drawn with a hyphen, an en dash
 *  or an em dash, and all three count: `12–20 августа` used to read as the
 *  20th and file a whole holiday under its last day. */
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}./\\-–—])";
const NOT_RANGE_AFTER = "(?![\\p{N}/\\-–—])";
const NOT_LETTER_AFTER = "(?![\\p{L}])";
const NOT_DIGIT_AFTER = "(?![\\p{N}])";
const OPTIONAL_YEAR = `(?:,?\\s+(\\d{4})${NOT_DIGIT_AFTER})?`;

/** `с 12 по 14 августа` is a span written in words. The month is read once,
 *  on its last day, so the span has to be refused where that day matches. A
 *  bare `по 14 августа` is a deadline, which is one day, and stays a date. */
const RU_SPAN_BEFORE = /(?<![\p{L}\p{N}])с\s+\d{1,2}\s+по\s+$/iu;

const ISO_RE = /(?<![\p{N}])(\d{4})-(\d{2})-(\d{2})(?![\p{N}])/u;
const DOTTED_RE = /(?<![\p{N}.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![\p{N}.])/u;
const RU_RE = new RegExp(
  `${NOT_WORD_BEFORE}(\\d{1,2})\\s+(${RU_ALT})${NOT_LETTER_AFTER}${OPTIONAL_YEAR}`,
  "iu",
);
const EN_DAY_MONTH_RE = new RegExp(
  `${NOT_WORD_BEFORE}(\\d{1,2})\\s+(${EN_ALT})${NOT_LETTER_AFTER}${OPTIONAL_YEAR}`,
  "iu",
);
const EN_MONTH_DAY_RE = new RegExp(
  `${NOT_WORD_BEFORE}(${EN_ALT})${NOT_LETTER_AFTER}\\s+(\\d{1,2})${NOT_RANGE_AFTER}${OPTIONAL_YEAR}`,
  "iu",
);

/** February gets 29 here: a day-and-month title is only checked against a real
 *  calendar once a year has been chosen for it. */
const LONGEST_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function build(
  month: number,
  day: number,
  year: number | undefined,
): TitleDate | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > LONGEST_MONTH[month - 1]) {
    return null;
  }
  if (year === undefined) return { month, day };
  return utcMs(year, month, day) === null ? null : { year, month, day };
}

/** Milliseconds for a real calendar date, or null when the date does not
 *  exist (31 February, 29 February of a common year). */
function utcMs(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

function optionalYear(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : Number(raw);
}

/** Read the first supported date shape out of a title. */
export function parseTitleDate(title: string): TitleDate | null {
  const iso = ISO_RE.exec(title);
  if (iso) return build(Number(iso[2]), Number(iso[3]), Number(iso[1]));

  const dotted = DOTTED_RE.exec(title);
  if (dotted) {
    return build(Number(dotted[2]), Number(dotted[1]), Number(dotted[3]));
  }

  const ru = RU_RE.exec(title);
  if (ru) {
    if (RU_SPAN_BEFORE.test(title.slice(0, ru.index))) return null;
    const month = RU_MONTHS[ru[2].toLowerCase()];
    return build(month, Number(ru[1]), optionalYear(ru[3]));
  }

  const enDayMonth = EN_DAY_MONTH_RE.exec(title);
  if (enDayMonth) {
    const month = EN_MONTHS[enDayMonth[2].toLowerCase()];
    return build(month, Number(enDayMonth[1]), optionalYear(enDayMonth[3]));
  }

  const enMonthDay = EN_MONTH_DAY_RE.exec(title);
  if (enMonthDay) {
    const month = EN_MONTHS[enMonthDay[1].toLowerCase()];
    return build(month, Number(enMonthDay[2]), optionalYear(enMonthDay[3]));
  }

  return null;
}

/** How far past its creation date a title may point before the year after
 *  is ruled out. A page written on 30 December for the lesson on 5 January is
 *  a plan, and a month of planning is ordinary. A title five months ahead of
 *  a July import is not a plan; it is last winter's lesson. */
const PLANNED_AHEAD_MS = 31 * 24 * 60 * 60 * 1_000;

/** Turn a parsed title date into a timestamp.
 *
 *  A title that names its year is taken at its word. A title with only a day
 *  and a month gets the year — the page's own creation year or the one before
 *  it — that lands the date closest to when the page was written. Twelve
 *  lessons named only by day and month can straddle New Year, and the page's
 *  creation date is the only evidence Brain actually holds about which side
 *  of it a lesson fell on. The year after is a candidate only within
 *  `PLANNED_AHEAD_MS` of the creation date: a note records something that has
 *  happened, and «Урок 5 января» imported on 8 July used to land on the
 *  January still to come — 181 days ahead against 188 days back — above
 *  every lesson of that summer. An exact tie keeps the earlier date for the
 *  same reason.
 *
 *  With no creation date, or none that parses, the title stays undated rather
 *  than being guessed into place. */
export function resolveTitleDate(
  parsed: TitleDate,
  created?: string,
): number | null {
  if (parsed.year !== undefined) {
    return utcMs(parsed.year, parsed.month, parsed.day);
  }
  const anchor = created ? Date.parse(created) : Number.NaN;
  if (!Number.isFinite(anchor)) return null;
  const anchorYear = new Date(anchor).getUTCFullYear();
  let best: number | null = null;
  for (const year of [anchorYear - 1, anchorYear, anchorYear + 1]) {
    const candidate = utcMs(year, parsed.month, parsed.day);
    if (candidate === null) continue;
    if (year > anchorYear && candidate - anchor > PLANNED_AHEAD_MS) continue;
    if (best === null || Math.abs(candidate - anchor) < Math.abs(best - anchor)) {
      best = candidate;
    }
  }
  return best;
}

/** The timestamp a page title carries, or null when it carries none. */
export function titleDateMs(title: string, created?: string): number | null {
  const parsed = parseTitleDate(title);
  return parsed === null ? null : resolveTitleDate(parsed, created);
}

/** Order one section's pages so the dated ones read newest first.
 *
 *  Undated pages are not moved. Each page whose title holds no date keeps the
 *  exact position it had, and the dated pages are dealt back into the
 *  positions they already occupied, newest first — so a hand-arranged section
 *  with a few dated pages in it is rearranged only where it was already dated.
 *  A section with fewer than two dated pages is returned untouched: there is
 *  nothing to order, and moving a lone dated page would only disturb a
 *  deliberate arrangement. Pages that share a date keep their prior order. */
export function orderPageIdsByTitleDate(
  pages: readonly DatedPage[],
): string[] {
  const ids = pages.map((p) => p.id);
  const dated: { index: number; at: number }[] = [];
  pages.forEach((page, index) => {
    const at = titleDateMs(page.title, page.created);
    if (at !== null) dated.push({ index, at });
  });
  if (dated.length < 2) return ids;

  const newestFirst = [...dated].sort(
    (a, b) => b.at - a.at || a.index - b.index,
  );
  const ordered = [...ids];
  dated.forEach((slot, position) => {
    ordered[slot.index] = ids[newestFirst[position].index];
  });
  return ordered;
}

/** The pages of one section, in the order Smart sort settled on.
 *
 *  `order` is advisory: a page missing from it still shows up (after the ranked
 *  ones), and a duplicate or unknown id in it cannot add or drop a page. The
 *  assignments map remains the only authority on which pages a section holds. */
export function sectionPageIds(
  grouping: { assignments: Record<string, string>; order?: string[] },
  label: string,
): string[] {
  const rank = new Map<string, number>();
  (grouping.order ?? []).forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  return Object.keys(grouping.assignments)
    .filter((id) => grouping.assignments[id] === label)
    .map((id, fallback) => ({
      id,
      rank: rank.get(id) ?? Number.MAX_SAFE_INTEGER,
      fallback,
    }))
    .sort((a, b) => a.rank - b.rank || a.fallback - b.fallback)
    .map((entry) => entry.id);
}
