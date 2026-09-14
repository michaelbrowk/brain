/** THE MONTH GRID'S ARITHMETIC, AND NOTHING ELSE.
 *
 *  A calendar day is a `YYYY-MM-DD` string here and never an instant, so no
 *  timezone can shift it and no reader travelling sees a grid a day out. The
 *  module reads no clock: the surface that knows what today is passes it in,
 *  and `lists.test.ts` holds this module under the same trap it holds the
 *  rest of `lib/tasks` under.
 *
 *  The Hinnant arithmetic below is a deliberate second copy of what
 *  `lists.ts` carries. `dayNumber` and `dayString` are private to that
 *  module's derivation, and widening them to serve a grid would make the list
 *  module the calendar module.
 */

export interface MonthCell {
  readonly day: string;
  readonly inMonth: boolean;
}

/** Six rows of seven, Monday first, so the grid's height never changes as a
 *  reader pages through the year: a five-row month next to a six-row one
 *  moves the two buttons under it, and a control that resizes under the
 *  pointer is a control that gets mis-pressed. */
export function monthGridOf(month: string, weekStart: 0 = 0): MonthCell[] {
  const first = `${month}-01`;
  const lead = (((weekdayIndex(first) - weekStart) % 7) + 7) % 7;
  const start = dayNumber(first) - lead;
  const cells: MonthCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const day = dayString(start + index);
    cells.push({ day, inMonth: day.slice(0, 7) === month });
  }
  return cells;
}

/** `"2026-09"` plus n months, across a year boundary in either direction. */
export function shiftMonth(month: string, by: number): string {
  const total = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + by;
  const year = Math.floor(total / 12);
  return `${pad(year, 4)}-${pad(total - year * 12 + 1, 2)}`;
}

/** A day plus n days. The picker's arrows move by 1 and by 7, and the whole
 *  reason this lives here rather than in the component is the trap: day
 *  arithmetic written beside a keyboard handler is day arithmetic nobody
 *  holds to a clock-free rule. */
export function shiftDay(day: string, by: number): string {
  return dayString(dayNumber(day) + by);
}

/** `"2026-09-13"` to `"2026-09"`. */
export function monthOfDay(day: string): string {
  return day.slice(0, 7);
}

/** The words a reader sees over the grid. The names are a table rather than
 *  `Intl.DateTimeFormat().format(new Date(...))`, because building a `Date`
 *  to read a month name is a clock read in a quiet place and the trap would
 *  bite on it. */
export function monthLabel(month: string): string {
  return `${monthName(month)} ${Number(month.slice(0, 4))}`;
}

/** The month alone, for a sentence that already carries the day. A grid cell
 *  says "Tuesday 15 September" to a screen reader, and splitting the year
 *  back off `monthLabel` at the call site is how a second name table gets
 *  written somewhere else. */
export function monthName(month: string): string {
  return MONTHS[Number(month.slice(5, 7)) - 1];
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Days since 1970-01-01 for a civil date, by Howard Hinnant's algorithm. */
function dayNumber(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const dayOfMonth = Number(day.slice(8, 10));
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + dayOfMonth - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The inverse of `dayNumber`, Hinnant's civil_from_days. */
function dayString(days: number): string {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** 0 is Monday. 1970-01-01 was a Thursday, which is the 3 below. */
function weekdayIndex(day: string): number {
  return (((dayNumber(day) + 3) % 7) + 7) % 7;
}
